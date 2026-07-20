import { appEvents } from '../core/events';
import type {
  ContractDefinition,
  ContractId,
  GameSnapshot,
  MachineState,
  MachineType,
  ObstacleDefinition,
  ProgressSave,
} from '../domain/types';
import { isLocalAdminHost } from '../platform/localAdmin';
import { AudioService } from './AudioService';

export interface AppUIOptions {
  root: HTMLElement;
  contracts: readonly ContractDefinition[];
  progress: ProgressSave;
  contractMetadata?: Readonly<Record<string, AdminContractMetadata>>;
  adminAvailable?: boolean;
  onProgressChange?: (progress: ProgressSave) => void;
  onRequestFullscreen?: () => void | Promise<void>;
}

export interface AdminContractMetadata {
  kind: 'builtin' | 'custom';
  overridden?: boolean;
}

export interface AdminEditorOpenOptions {
  isNew?: boolean;
  dirty?: boolean;
}

export interface AdminEditorMessage {
  tone: 'neutral' | 'success' | 'danger';
  message: string;
  errors?: readonly string[];
}

type Unsubscribe = () => void;
type IconName =
  | MachineType
  | 'play'
  | 'pause'
  | 'reset'
  | 'undo'
  | 'redo'
  | 'trash'
  | 'reverse'
  | 'menu'
  | 'sound'
  | 'muted'
  | 'fullscreen'
  | 'grid'
  | 'clear'
  | 'lock'
  | 'star'
  | 'edit'
  | 'restore'
  | 'settings'
  | 'close'
  | 'blocker'
  | 'save'
  | 'test'
  | 'plus';

type AdminTool = MachineType | 'obstacle';

const MACHINE_COPY: Record<MachineType, { name: string; hint: string }> = {
  source: { name: 'Saída', hint: 'Gera caixas' },
  conveyor: { name: 'Esteira', hint: 'Conduz o fluxo' },
  receiver: { name: 'Entrada', hint: 'Recebe caixas' },
  spring: { name: 'Trampolim', hint: 'Projeta caixas' },
};

const STATUS_COPY: Record<GameSnapshot['status'], string> = {
  build: 'Construção',
  running: 'Simulando',
  paused: 'Pausado',
  success: 'Concluído',
  failure: 'Encerrado',
};

const SIMULATION_SPEEDS = [0.1, 0.2, 0.5, 1, 2, 3, 5] as const;
const MINIMUM_LOADING_DURATION_MS = 360;

export class AppUI {
  readonly gameContainerId = 'game-container';

  private readonly root: HTMLElement;
  private contracts: ContractDefinition[];
  private contractMetadata: Readonly<Record<string, AdminContractMetadata>>;
  private readonly adminAvailable: boolean;
  private readonly onProgressChange?: (progress: ProgressSave) => void;
  private readonly onRequestFullscreen?: () => void | Promise<void>;
  private readonly audio: AudioService;
  private progress: ProgressSave;
  private adminEnabled = false;
  private editorContract?: ContractDefinition;
  private editorIsNew = false;
  private editorDirty = false;
  private editorPreviewActive = false;
  private resultContractId?: ContractId;
  private pendingAdminAction?: { kind: 'restore' | 'delete'; contractId: ContractId };
  private gameReady = false;
  private readonly loadingStartedAt = performance.now();
  private readonly domEvents = new AbortController();
  private snapshot?: GameSnapshot;
  private readyTimer?: number;
  private unsubs: Unsubscribe[] = [];
  private toastTimer?: number;

  constructor(options: AppUIOptions) {
    this.root = options.root;
    this.contracts = [...options.contracts].sort((a, b) => a.order - b.order);
    this.contractMetadata = options.contractMetadata ?? {};
    this.adminAvailable = options.adminAvailable ?? isLocalAdminHost(window.location.hostname);
    this.progress = options.progress;
    this.onProgressChange = options.onProgressChange;
    this.onRequestFullscreen = options.onRequestFullscreen;
    this.audio = new AudioService(options.progress.settings);

    this.renderShell();
    this.setGameReady(false);
    this.bindDOM();
    this.bindEvents();
    this.renderMenuCards();
    this.updateSoundControls();
  }

  updateProgress(progress: ProgressSave): void {
    this.progress = progress;
    this.audio.setMuted(progress.settings.muted);
    this.audio.setVolume(progress.settings.volume);
    this.renderMenuCards();
    this.updateSoundControls();
  }

  updateContracts(
    contracts: readonly ContractDefinition[],
    metadata: Readonly<Record<string, AdminContractMetadata>> = this.contractMetadata,
  ): void {
    this.contracts = [...contracts].sort((a, b) => a.order - b.order);
    this.contractMetadata = metadata;
    this.renderMenuCards();
  }

  openAdminEditor(contract: ContractDefinition, options: AdminEditorOpenOptions = {}): void {
    if (!this.adminAvailable || !this.adminEnabled) return;
    this.editorContract = structuredClone(contract);
    this.editorIsNew = options.isNew ?? false;
    this.editorDirty = options.dirty ?? false;
    this.editorPreviewActive = false;
    this.hideMenu();
    this.root.classList.add('is-admin-editor');
    this.root.classList.remove('is-admin-preview');
    this.renderEditorState();
    this.renderEditorPalette();
  }

  closeAdminEditor(): void {
    this.editorContract = undefined;
    this.editorIsNew = false;
    this.editorDirty = false;
    this.editorPreviewActive = false;
    this.root.classList.remove('is-admin-editor', 'is-admin-preview');
    this.element('#editor-config-panel').classList.add('is-hidden');
    this.element('#editor-confirm-modal').classList.add('is-hidden');
    this.clearEditorMessage();
    this.showMenu();
  }

  setEditorMessage(state?: AdminEditorMessage): void {
    const container = this.element('#editor-feedback');
    if (!state) {
      this.clearEditorMessage();
      return;
    }
    container.dataset.tone = state.tone;
    container.innerHTML = `
      <strong>${escapeHTML(state.message)}</strong>
      ${state.errors?.length ? `<ul>${state.errors.map((error) => `<li>${escapeHTML(error)}</li>`).join('')}</ul>` : ''}`;
    container.classList.remove('is-hidden');
  }

  markEditorSaved(contract: ContractDefinition): void {
    if (!this.editorContract || this.editorContract.id !== contract.id) return;
    this.editorContract = structuredClone(contract);
    this.editorIsNew = false;
    this.editorDirty = false;
    this.renderEditorState();
    this.setEditorMessage({ tone: 'success', message: 'Fase salva neste navegador.' });
  }

  showMenu(): void {
    this.element('#menu-screen').classList.remove('is-hidden');
    this.element('#result-modal').classList.add('is-hidden');
    this.root.classList.add('is-menu-open');
  }

  hideMenu(): void {
    this.element('#menu-screen').classList.add('is-hidden');
    this.root.classList.remove('is-menu-open');
  }

  destroy(): void {
    this.domEvents.abort();
    for (const unsubscribe of this.unsubs) unsubscribe();
    this.unsubs = [];
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    if (this.readyTimer !== undefined) window.clearTimeout(this.readyTimer);
    this.audio.destroy();
    this.root.replaceChildren();
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <main class="factory-app" aria-label="Factory">
        <div id="${this.gameContainerId}" class="game-container" aria-label="Área de construção"></div>

        <section id="game-ui" class="game-ui" aria-label="Interface do contrato">
          <header class="top-rail glass-panel">
            <div class="top-left-controls">
              <button class="icon-button menu-button" data-action="menu" aria-label="Voltar ao menu" title="Menu">
                ${icon('menu')}
              </button>
              <span id="zoom-readout" class="zoom-readout" title="Zoom da área · use o scroll">100%</span>
            </div>

            <div class="simulation-controls" aria-label="Controles da simulação">
              <button class="simulation-play" data-action="run" aria-label="Iniciar simulação" title="Iniciar · Espaço">
                <span data-run-icon>${icon('play')}</span>
              </button>
              <label class="speed-control" title="Velocidade da simulação">
                <span class="speed-readout" data-speed-label>1×</span>
                <input data-speed type="range" min="0" max="6" step="1" value="3" aria-label="Velocidade da simulação" aria-valuetext="1×" />
              </label>
            </div>

            <div class="top-right-controls">
              <div class="metric-strip" role="status" aria-live="polite">
                ${metric('Progresso', '0 / 0', 'progress', 'progress')}
                ${metric('Tempo', '00:00', 'time', 'time')}
                ${metric('Perdas', '0 / 0', 'losses', 'losses')}
                ${metric('Ativas', '0', 'active', 'active')}
              </div>
              <div class="status-pill" data-status="build">
                <span class="status-dot"></span><span id="status-label">Construção</span>
              </div>
              <button class="icon-button" data-action="fullscreen" aria-label="Tela cheia" title="Tela cheia">
                ${icon('fullscreen')}
              </button>
              <button class="icon-button sound-button" data-action="mute" aria-label="Silenciar" title="Som">
                <span data-sound-icon>${icon(this.progress.settings.muted ? 'muted' : 'sound')}</span>
              </button>
            </div>
          </header>

          <header id="editor-rail" class="editor-rail glass-panel is-hidden" aria-label="Editor de fase">
            <div class="editor-heading">
              <button class="soft-button" data-action="editor-cancel" type="button">
                ${icon('close')} <span>Cancelar</span>
              </button>
              <span class="admin-badge">ADMIN LOCAL</span>
              <div class="editor-title-block">
                <strong id="editor-contract-title">Nova fase</strong>
                <span id="editor-dirty-state" class="editor-dirty-state">Sem alterações</span>
              </div>
            </div>
            <div class="editor-actions">
              <button class="soft-button" data-action="editor-configure" type="button" aria-expanded="false">
                ${icon('settings')} <span>Configurações</span>
              </button>
              <button class="soft-button" data-action="editor-test" type="button">
                ${icon('test')} <span>Testar</span>
              </button>
              <button class="primary-action" data-action="editor-save" type="button">
                ${icon('save')} <span>Salvar</span>
              </button>
            </div>
          </header>

          <nav class="action-rail" aria-label="Ferramentas da grade">
            <button class="rail-button is-active" data-action="toggle-grid" type="button" aria-pressed="true" aria-label="Desligar grade" title="Grade ligada">
              ${icon('grid')}
            </button>
            <button class="rail-button" data-action="reverse" aria-label="Inverter esteira" title="Inverter esteira · R" disabled>
              ${icon('reverse')}
            </button>
            <span class="rail-divider" aria-hidden="true"></span>
            <button class="rail-button" data-action="undo" aria-label="Desfazer" title="Desfazer · Ctrl+Z">${icon('undo')}</button>
            <button class="rail-button" data-action="redo" aria-label="Refazer" title="Refazer · Ctrl+Y">${icon('redo')}</button>
            <button class="rail-button" data-action="reset" aria-label="Reiniciar simulação" title="Reiniciar simulação">
              ${icon('reset')}
            </button>
            <span class="rail-divider" aria-hidden="true"></span>
            <button class="rail-button rail-danger" data-action="delete" aria-label="Excluir seleção" title="Excluir seleção · Delete" disabled>
              ${icon('trash')}
            </button>
            <button class="rail-button rail-danger is-hidden" data-action="clear" aria-label="Limpar todas as máquinas" title="Limpar tudo">
              ${icon('clear')}
            </button>
          </nav>

          <section class="build-dock glass-panel" aria-label="Ferramentas de construção">
            <div id="hotbar" class="hotbar" role="toolbar" aria-label="Máquinas"></div>
          </section>
          <div id="editor-preview-bar" class="editor-preview-bar glass-panel is-hidden" role="status">
            <span><strong>PRÉVIA DO JOGADOR</strong> · alterações temporárias não serão salvas</span>
            <button class="primary-action" data-action="editor-return" type="button">Voltar ao editor</button>
          </div>

          <aside id="editor-config-panel" class="editor-config-panel glass-panel is-hidden" aria-label="Configurações da fase">
            <div class="editor-config-heading">
              <div><span class="eyebrow">CONFIGURAÇÕES</span><h2>Dados da fase</h2></div>
              <button class="icon-button" data-action="editor-configure" type="button" aria-label="Fechar configurações">${icon('close')}</button>
            </div>
            <form id="editor-contract-form" autocomplete="off">
              <label class="field field-wide"><span>Título *</span><input name="title" maxlength="64" required /></label>
              <label class="field field-wide"><span>Subtítulo</span><input name="subtitle" maxlength="96" /></label>
              <label class="field field-wide"><span>Descrição</span><textarea name="description" rows="3" maxlength="240"></textarea></label>
              <fieldset class="field-group">
                <legend>Objetivo</legend>
                <label class="field"><span>Entregas *</span><input name="deliveries" type="number" min="1" step="1" required /></label>
                <label class="field"><span>Perdas máximas *</span><input name="maxLosses" type="number" min="0" step="1" required /></label>
                <label class="field"><span>Orçamento *</span><input name="pieceBudget" type="number" min="0" step="1" required /></label>
                <label class="field"><span>Tempo limite (s)</span><input name="timeLimitSeconds" type="number" min="0.1" step="any" placeholder="Sem limite" /></label>
              </fieldset>
              <fieldset class="field-group">
                <legend>Referência de estrelas</legend>
                <label class="field"><span>Peças de referência *</span><input name="parPieces" type="number" min="0" step="1" required /></label>
                <label class="field"><span>Tempo de referência (s)</span><input name="parTimeSeconds" type="number" min="0.1" step="any" placeholder="Sem referência" /></label>
                <label class="field field-wide"><span>Intervalo de geração (s) *</span><input name="spawnIntervalSeconds" type="number" min="0.1" step="any" required /></label>
              </fieldset>
              <fieldset class="field-group tool-availability">
                <legend>Ferramentas do jogador</legend>
                <label class="check-field"><input name="availableConveyor" type="checkbox" /><span>${icon('conveyor')} Esteira</span></label>
                <label class="check-field"><input name="availableSpring" type="checkbox" /><span>${icon('spring')} Trampolim</span></label>
              </fieldset>
            </form>
            <div id="editor-feedback" class="editor-feedback is-hidden" role="status" aria-live="polite"></div>
          </aside>
        </section>

        <section id="menu-screen" class="menu-screen" aria-labelledby="menu-title">
          <div class="menu-backdrop"></div>
          <div class="menu-content">
            <div class="menu-intro">
              <span class="eyebrow accent">SISTEMAS EM MOVIMENTO</span>
              <h1 id="menu-title">Factory</h1>
              <p>Transforme gravidade em fluxo. Construa linhas compactas, observe a física e refine cada movimento.</p>
              <div class="menu-tip"><span>${icon('reverse')}</span><span>Gire livremente. Inverta o fluxo. Encontre uma solução elegante.</span></div>
            </div>
            <div class="contract-browser">
              <div class="section-heading">
                <div><span class="eyebrow">CAMPANHA</span><h2>Contratos</h2></div>
                <span class="progress-copy" id="campaign-progress">0 de 3 concluídos</span>
              </div>
              <span id="menu-admin-badge" class="admin-badge menu-admin-badge is-hidden">ADMIN LOCAL</span>
              <div id="contract-list" class="contract-list"></div>
              <button id="create-contract-button" class="create-contract-card is-hidden" data-action="admin-create" type="button">
                <span class="create-contract-mark">${icon('plus')}</span>
                <span><strong>Criar nova fase</strong><small>Adicione o próximo contrato da campanha.</small></span>
                <span class="card-arrow" aria-hidden="true">→</span>
              </button>
              <button class="sandbox-card" data-start-sandbox>
                <span class="sandbox-mark">∞</span>
                <span><strong>Modo livre</strong><small>Todos os módulos, sem limite ou cronômetro.</small></span>
                <span class="card-arrow" aria-hidden="true">→</span>
              </button>
            </div>
          </div>
          <footer class="menu-footer">
            <span>Desktop prototype</span><span>•</span><span>Vite + Phaser + Matter</span>
            <label class="volume-control">
              <span>Volume</span>
              <input data-volume type="range" min="0" max="100" value="${Math.round(this.progress.settings.volume * 100)}" aria-label="Volume dos efeitos" />
            </label>
            <button id="admin-toggle" class="admin-toggle${this.adminAvailable ? '' : ' is-hidden'}" data-action="toggle-admin" type="button" aria-pressed="false">
              ${icon('settings')} <span>Ativar admin</span>
            </button>
          </footer>
        </section>

        <div id="angle-indicator" class="angle-indicator is-hidden" aria-hidden="true">
          <span class="angle-ring"></span><strong>0°</strong>
        </div>
        <div id="toast" class="toast" role="status" aria-live="polite"></div>

        <section id="result-modal" class="modal-layer is-hidden" role="dialog" aria-modal="true" aria-labelledby="result-title">
          <div class="modal-scrim"></div>
          <div class="result-card">
            <span class="eyebrow accent" id="result-kicker">CONTRATO CONCLUÍDO</span>
            <h2 id="result-title">Fluxo estabelecido</h2>
            <div id="result-stars" class="result-stars" aria-label="0 estrelas"></div>
            <p id="result-summary">A linha encontrou seu ritmo.</p>
            <div class="result-metrics">
              ${resultMetric('Entregues', '0', 'delivered')}
              ${resultMetric('Perdidas', '0', 'lost')}
              ${resultMetric('Tempo', '00:00', 'elapsed')}
              ${resultMetric('Peças', '0', 'pieces')}
            </div>
            <div class="result-actions">
              <button class="soft-button" data-action="result-menu">Menu</button>
              <button class="soft-button" data-action="replay">Repetir</button>
              <button class="primary-action" data-action="next">Próximo contrato <span>→</span></button>
            </div>
          </div>
        </section>
        <section id="editor-confirm-modal" class="modal-layer is-hidden" role="dialog" aria-modal="true" aria-labelledby="editor-confirm-title">
          <div class="modal-scrim"></div>
          <div class="confirm-card">
            <span class="eyebrow accent">ALTERAÇÕES PENDENTES</span>
            <h2 id="editor-confirm-title">Descartar alterações?</h2>
            <p>Esta versão da fase ainda não foi salva.</p>
            <div class="result-actions">
              <button class="soft-button" data-action="editor-keep-editing" type="button">Continuar editando</button>
              <button class="soft-button danger" data-action="editor-confirm-discard" type="button">Descartar</button>
            </div>
          </div>
        </section>

        <section id="admin-confirm-modal" class="modal-layer is-hidden" role="dialog" aria-modal="true" aria-labelledby="admin-confirm-title">
          <div class="modal-scrim"></div>
          <div class="confirm-card">
            <span class="eyebrow accent" id="admin-confirm-kicker">CONFIRMAR AÇÃO</span>
            <h2 id="admin-confirm-title">Confirmar?</h2>
            <p id="admin-confirm-copy"></p>
            <div class="result-actions">
              <button class="soft-button" data-action="admin-confirm-cancel" type="button">Cancelar</button>
              <button class="soft-button danger" data-action="admin-confirm-accept" type="button">Confirmar</button>
            </div>
          </div>
        </section>

        <div id="game-loading" class="game-loading" role="status" aria-live="polite">
          <div class="loading-card">
            <span class="loading-spinner" aria-hidden="true"></span>
            <strong>Preparando a fábrica</strong>
            <span>Carregando física e cenário...</span>
          </div>
        </div>
      </main>`;
  }

  private bindDOM(): void {
    this.root.addEventListener(
      'click',
      (event) => {
        if (this.gameReady) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true, signal: this.domEvents.signal },
    );
    this.root.addEventListener('pointerdown', () => void this.audio.resume(), {
      once: true,
      signal: this.domEvents.signal,
    });
    this.element('[data-action="toggle-grid"]').addEventListener(
      'pointerdown',
      (event) => {
        event.stopPropagation();
        void this.audio.resume();
      },
      { signal: this.domEvents.signal },
    );
    this.root.addEventListener(
      'pointerover',
      (event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
        if (!button || button.disabled) return;
        const previousTarget = event.relatedTarget;
        if (previousTarget instanceof Node && button.contains(previousTarget)) return;
        this.audio.play('hover');
      },
      { signal: this.domEvents.signal },
    );
    this.root.addEventListener(
      'click',
      (event) => {
        const source = event.target as HTMLElement;
        const button = source.closest<HTMLButtonElement>('button');
        if (button && !button.disabled) this.audio.play('click');
        const target = source.closest<HTMLElement>('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        if (action) this.handleAction(action);
      },
      { signal: this.domEvents.signal },
    );

    this.element('[data-start-sandbox]').addEventListener(
      'click',
      () => {
        this.hideMenu();
        appEvents.emit('ui:start-mode', {
          mode: 'sandbox',
          machines: structuredClone(this.progress.sandbox.machines),
        });
      },
      { signal: this.domEvents.signal },
    );

    const preventDirtyUnload = (event: BeforeUnloadEvent) => {
      if (!this.editorContract || !this.editorDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventDirtyUnload);
    this.unsubs.push(() => window.removeEventListener('beforeunload', preventDirtyUnload));

    this.root.addEventListener(
      'input',
      (event) => {
        const input = event.target as HTMLInputElement;
        if (input.closest('#editor-contract-form')) {
          this.handleEditorFormInput();
          return;
        }
        if (input.dataset.speed !== undefined) {
          const index = Math.max(0, Math.min(SIMULATION_SPEEDS.length - 1, Number(input.value)));
          const speed = SIMULATION_SPEEDS[index] ?? 1;
          this.renderSimulationSpeed(speed);
          appEvents.emit('ui:set-simulation-speed', { speed });
          return;
        }
        if (input.dataset.volume === undefined) return;
        const volume = Number(input.value) / 100;
        this.audio.setVolume(volume);
        this.commitSettings({ volume, muted: volume === 0 ? true : this.audio.isMuted });
        appEvents.emit('ui:set-volume', { volume });
      },
      { signal: this.domEvents.signal },
    );
  }

  private bindEvents(): void {
    this.unsubs.push(
      appEvents.on('game:ready', () => this.finishGameLoading()),
      appEvents.on('game:snapshot', (snapshot) => this.renderSnapshot(snapshot)),
      appEvents.on('game:angle', (payload) => this.renderAngle(payload)),
      appEvents.on('game:camera', ({ zoom }) => {
        this.element('#zoom-readout').textContent = `${Math.round(zoom * 100)}%`;
      }),
      appEvents.on('game:toast', ({ message, tone }) => this.showToast(message, tone)),
      appEvents.on('game:audio', ({ kind }) => this.audio.play(kind)),
      appEvents.on('game:result', (result) => this.renderResult(result)),
      appEvents.on('game:editor-changed', ({ contract, dirty }) => {
        if (!this.editorContract) return;
        this.editorContract = structuredClone(contract);
        this.editorDirty = dirty;
        this.renderEditorState();
      }),
      appEvents.on('game:editor-preview', ({ active }) => {
        if (!this.editorContract) return;
        this.editorPreviewActive = active;
        this.root.classList.toggle('is-admin-preview', active);
        this.element('#editor-preview-bar').classList.toggle('is-hidden', !active);
        this.element('#editor-config-panel').classList.add('is-hidden');
        this.element('#editor-rail').classList.toggle('is-hidden', active);
        if (!active) this.renderEditorPalette();
      }),
      appEvents.on('game:sandbox-changed', (machines) => {
        this.progress = {
          ...this.progress,
          sandbox: {
            machines: machines.map((machine) => ({ ...machine })),
            updatedAt: new Date().toISOString(),
          },
        };
        this.onProgressChange?.(this.progress);
      }),
    );
  }

  private setGameReady(ready: boolean): void {
    this.gameReady = ready;
    const shell = this.element('.factory-app');
    const loading = this.element('#game-loading');
    shell.setAttribute('aria-busy', String(!ready));
    this.element('#game-ui').toggleAttribute('inert', !ready);
    this.element('#menu-screen').toggleAttribute('inert', !ready);
    loading.classList.toggle('is-hidden', ready);
    loading.setAttribute('aria-hidden', String(ready));
  }

  private finishGameLoading(): void {
    if (this.gameReady || this.readyTimer !== undefined) return;
    const elapsed = performance.now() - this.loadingStartedAt;
    const remaining = Math.max(0, MINIMUM_LOADING_DURATION_MS - elapsed);
    if (remaining === 0) {
      this.setGameReady(true);
      return;
    }
    this.readyTimer = window.setTimeout(() => {
      this.readyTimer = undefined;
      this.setGameReady(true);
    }, remaining);
  }

  private handleAction(action: string): void {
    switch (action) {
      case 'menu':
      case 'result-menu':
        if (this.editorContract) {
          this.requestEditorCancel();
          break;
        }
        appEvents.emit('ui:menu', undefined);
        this.showMenu();
        break;
      case 'run':
        if (this.snapshot?.status === 'running') appEvents.emit('ui:pause', undefined);
        else appEvents.emit('ui:run', undefined);
        break;
      case 'reset':
        appEvents.emit('ui:reset', undefined);
        break;
      case 'clear':
        appEvents.emit('ui:clear', undefined);
        break;
      case 'undo':
        appEvents.emit('ui:undo', undefined);
        break;
      case 'redo':
        appEvents.emit('ui:redo', undefined);
        break;
      case 'delete':
        appEvents.emit('ui:delete-selected', undefined);
        break;
      case 'reverse':
        appEvents.emit('ui:reverse-selected', undefined);
        break;
      case 'toggle-grid':
        appEvents.emit('ui:toggle-grid', undefined);
        break;
      case 'replay':
        this.element('#result-modal').classList.add('is-hidden');
        appEvents.emit('ui:replay', undefined);
        break;
      case 'next':
        this.element('#result-modal').classList.add('is-hidden');
        this.startNextContract();
        break;
      case 'toggle-admin':
        this.setAdminEnabled(!this.adminEnabled);
        break;
      case 'admin-create':
        appEvents.emit('ui:admin-create-contract', undefined);
        break;
      case 'editor-configure':
        this.toggleEditorConfiguration();
        break;
      case 'editor-test':
        if (this.editorContract && this.validateEditorSettings()) {
          appEvents.emit('ui:editor-test', undefined);
        }
        break;
      case 'editor-return':
        appEvents.emit('ui:editor-return', undefined);
        break;
      case 'editor-save':
        if (this.editorContract && this.validateEditorSettings()) {
          this.setEditorMessage({ tone: 'neutral', message: 'Salvando fase…' });
          appEvents.emit('ui:editor-save', { contract: structuredClone(this.editorContract) });
        }
        break;
      case 'editor-cancel':
        this.requestEditorCancel();
        break;
      case 'editor-keep-editing':
        this.element('#editor-confirm-modal').classList.add('is-hidden');
        break;
      case 'editor-confirm-discard':
        this.element('#editor-confirm-modal').classList.add('is-hidden');
        appEvents.emit('ui:editor-cancel', undefined);
        this.closeAdminEditor();
        break;
      case 'admin-confirm-cancel':
        this.pendingAdminAction = undefined;
        this.element('#admin-confirm-modal').classList.add('is-hidden');
        break;
      case 'admin-confirm-accept':
        this.confirmAdminAction();
        break;
      case 'mute': {
        const muted = this.audio.toggleMuted();
        this.commitSettings({ muted });
        appEvents.emit('ui:set-muted', { muted });
        this.updateSoundControls();
        break;
      }
      case 'fullscreen':
        appEvents.emit('ui:fullscreen', undefined);
        void this.onRequestFullscreen?.();
        break;
    }
  }

  private renderMenuCards(): void {
    const list = this.element('#contract-list');
    list.innerHTML = '';
    if (this.adminEnabled) {
      this.renderAdminMenuCards(list);
      return;
    }
    const completed = this.contracts.filter(
      (contract) => this.progress.bestResults[contract.id],
    ).length;
    this.element('#campaign-progress').textContent =
      `${completed} de ${this.contracts.length} concluídos`;

    for (const contract of this.contracts) {
      const unlocked = this.progress.unlockedContracts.includes(contract.id);
      const best = this.progress.bestResults[contract.id];
      const button = document.createElement('button');
      button.className = `contract-card${unlocked ? '' : ' is-locked'}${best ? ' is-complete' : ''}`;
      button.disabled = !unlocked;
      button.setAttribute(
        'aria-label',
        unlocked ? `Abrir ${contract.title}` : `${contract.title}, bloqueado`,
      );
      button.innerHTML = `
        <span class="contract-index">${String(contract.order).padStart(2, '0')}</span>
        <span class="contract-copy">
          <span class="contract-title-row"><strong>${escapeHTML(contract.title)}</strong>${best ? stars(best.stars, true) : ''}</span>
          <small>${escapeHTML(contract.subtitle)}</small>
          <span class="contract-tags">
            <i>${contract.goal.deliveries} caixas</i>
            <i>${contract.goal.pieceBudget} peças</i>
            ${contract.goal.timeLimitSeconds ? `<i>${formatTime(contract.goal.timeLimitSeconds)}</i>` : ''}
          </span>
        </span>
        <span class="card-arrow" aria-hidden="true">${unlocked ? '→' : icon('lock')}</span>`;
      if (unlocked) {
        button.addEventListener('click', () => {
          this.hideMenu();
          appEvents.emit('ui:start-mode', {
            mode: 'campaign',
            contractId: contract.id,
            contract: structuredClone(contract),
          });
        });
      }
      list.append(button);
    }
  }

  private renderAdminMenuCards(list: HTMLElement): void {
    const completed = this.contracts.filter(
      (contract) => this.progress.bestResults[contract.id],
    ).length;
    this.element('#campaign-progress').textContent =
      `${completed} de ${this.contracts.length} concluídos`;

    for (const contract of this.contracts) {
      const unlocked = this.progress.unlockedContracts.includes(contract.id);
      const best = this.progress.bestResults[contract.id];
      const metadata = this.contractMetadata[contract.id] ?? { kind: 'builtin' as const };
      const entry = document.createElement('article');
      entry.className = 'contract-entry';
      const button = document.createElement('button');
      button.className = `contract-card is-admin-card${unlocked ? '' : ' is-locked'}${best ? ' is-complete' : ''}`;
      button.setAttribute('aria-label', `Editar ${contract.title}`);
      button.innerHTML = `
        <span class="contract-index">${String(contract.order).padStart(2, '0')}</span>
        <span class="contract-copy">
          <span class="contract-title-row">
            <strong>${escapeHTML(contract.title)}</strong>
            <em class="contract-origin">${metadata.kind === 'custom' ? 'Personalizada' : metadata.overridden ? 'Alterada' : 'Original'}</em>
          </span>
          <small>${escapeHTML(contract.subtitle)}</small>
          <span class="contract-tags">
            <i>${contract.goal.deliveries} caixas</i>
            <i>${contract.goal.pieceBudget} peças</i>
            ${contract.goal.timeLimitSeconds ? `<i>${formatTime(contract.goal.timeLimitSeconds)}</i>` : ''}
          </span>
        </span>
        <span class="card-arrow" aria-hidden="true">${icon('edit')}</span>`;
      button.addEventListener('click', () => {
        this.openAdminEditor(contract);
        appEvents.emit('ui:start-editor', { contract: structuredClone(contract) });
      });
      entry.append(button);

      if (metadata.kind === 'custom' || metadata.overridden) {
        const actions = document.createElement('div');
        actions.className = 'contract-admin-actions';
        if (metadata.kind === 'builtin' && metadata.overridden) {
          const restore = document.createElement('button');
          restore.className = 'text-button';
          restore.type = 'button';
          restore.innerHTML = `${icon('restore')} Restaurar original`;
          restore.addEventListener('click', () =>
            this.openAdminConfirmation('restore', contract.id, contract.title),
          );
          actions.append(restore);
        }
        if (metadata.kind === 'custom') {
          const remove = document.createElement('button');
          remove.className = 'text-button danger';
          remove.type = 'button';
          remove.innerHTML = `${icon('trash')} Excluir`;
          remove.addEventListener('click', () =>
            this.openAdminConfirmation('delete', contract.id, contract.title),
          );
          actions.append(remove);
        }
        entry.append(actions);
      }
      list.append(entry);
    }
  }

  private renderSnapshot(snapshot: GameSnapshot): void {
    this.snapshot = snapshot;
    this.element('[data-metric="progress"] strong').textContent = snapshot.goal
      ? `${snapshot.metrics.delivered} / ${snapshot.goal.deliveries}`
      : `${snapshot.metrics.delivered}`;
    this.element('[data-metric="time"] strong').textContent = formatTime(
      snapshot.metrics.elapsedSeconds,
    );
    this.element('[data-metric="losses"] strong').textContent = snapshot.goal
      ? `${snapshot.metrics.lost} / ${snapshot.goal.maxLosses}`
      : `${snapshot.metrics.lost}`;
    this.element('[data-metric="active"] strong').textContent = String(snapshot.metrics.active);

    const status = this.element('.status-pill');
    status.dataset.status = snapshot.status;
    this.element('#status-label').textContent = STATUS_COPY[snapshot.status];

    const runIcon = this.element('[data-run-icon]');
    const runButton = this.element<HTMLButtonElement>('[data-action="run"]');
    const running = snapshot.status === 'running';
    runIcon.innerHTML = icon(running ? 'pause' : 'play');
    const runAction = running
      ? 'Pausar simulação'
      : snapshot.status === 'paused'
        ? 'Continuar simulação'
        : 'Iniciar simulação';
    runButton.setAttribute('aria-label', runAction);
    runButton.title = `${runAction} · Espaço`;
    runButton.disabled = snapshot.status === 'success' || snapshot.status === 'failure';
    this.renderSimulationSpeed(snapshot.simulationSpeed);

    this.element<HTMLButtonElement>('[data-action="undo"]').disabled = !snapshot.canUndo;
    this.element<HTMLButtonElement>('[data-action="redo"]').disabled = !snapshot.canRedo;
    const gridToggle = this.element<HTMLButtonElement>('[data-action="toggle-grid"]');
    gridToggle.setAttribute('aria-pressed', String(snapshot.gridEnabled));
    gridToggle.classList.toggle('is-active', snapshot.gridEnabled);
    gridToggle.classList.toggle('is-off', !snapshot.gridEnabled);
    gridToggle.disabled = snapshot.status !== 'build' && snapshot.status !== 'paused';
    gridToggle.setAttribute('aria-label', snapshot.gridEnabled ? 'Desligar grade' : 'Ligar grade');
    gridToggle.title = snapshot.gridEnabled ? 'Grade ligada' : 'Grade desligada';
    this.element('[data-action="clear"]').classList.toggle(
      'is-hidden',
      snapshot.mode !== 'sandbox',
    );
    if (this.editorContract && !this.editorPreviewActive) this.renderEditorPalette();
    else this.renderHotbar(snapshot.availableMachines);
    if (snapshot.selectedMachine) {
      this.element('#hotbar')
        .querySelectorAll('.tool-button')
        .forEach((node) => node.classList.remove('is-active'));
    }
    this.renderSelection(snapshot.selectedMachine, snapshot.selectedObstacle);
  }

  private renderHotbar(machines: MachineType[]): void {
    const hotbar = this.element('#hotbar');
    const wasEditor = hotbar.dataset.mode === 'editor';
    hotbar.dataset.mode = 'player';
    const currentTypes = [...hotbar.querySelectorAll<HTMLElement>('[data-tool]')].map(
      (node) => node.dataset.tool,
    );
    if (!wasEditor && currentTypes.join('|') === machines.join('|')) return;

    hotbar.innerHTML = '';
    for (const machine of machines) {
      const copy = MACHINE_COPY[machine];
      const button = document.createElement('button');
      button.className = 'tool-button';
      button.dataset.tool = machine;
      button.setAttribute('aria-label', `${copy.name}: ${copy.hint}`);
      button.title = copy.name;
      button.innerHTML = `
        <span class="tool-glyph tool-${machine}">${icon(machine)}</span>`;
      let dragOrigin: { x: number; y: number } | undefined;
      let dragging = false;
      let suppressClick = false;
      button.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        dragOrigin = { x: event.clientX, y: event.clientY };
        dragging = false;
        suppressClick = false;
        button.setPointerCapture(event.pointerId);
        hotbar
          .querySelectorAll('.tool-button')
          .forEach((node) => node.classList.remove('is-active'));
        button.classList.add('is-active');
        appEvents.emit('ui:tool-drag', {
          type: machine,
          phase: 'start',
          clientX: event.clientX,
          clientY: event.clientY,
        });
      });
      button.addEventListener('pointermove', (event) => {
        if (!dragOrigin) return;
        if (Math.hypot(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y) >= 6) {
          dragging = true;
        }
        if (!dragging) return;
        appEvents.emit('ui:tool-drag', {
          type: machine,
          phase: 'move',
          clientX: event.clientX,
          clientY: event.clientY,
        });
      });
      button.addEventListener('pointerup', (event) => {
        if (!dragOrigin) return;
        if (dragging) {
          suppressClick = true;
          appEvents.emit('ui:tool-drag', {
            type: machine,
            phase: 'end',
            clientX: event.clientX,
            clientY: event.clientY,
          });
        }
        dragOrigin = undefined;
        dragging = false;
        if (button.hasPointerCapture(event.pointerId))
          button.releasePointerCapture(event.pointerId);
      });
      button.addEventListener('pointercancel', (event) => {
        if (!dragOrigin) return;
        dragOrigin = undefined;
        dragging = false;
        appEvents.emit('ui:tool-drag', {
          type: machine,
          phase: 'cancel',
          clientX: event.clientX,
          clientY: event.clientY,
        });
      });
      button.addEventListener('click', () => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        hotbar
          .querySelectorAll('.tool-button')
          .forEach((node) => node.classList.remove('is-active'));
        button.classList.add('is-active');
        appEvents.emit('ui:tool', { type: machine });
      });
      hotbar.append(button);
    }
  }

  private renderEditorPalette(): void {
    if (!this.editorContract || this.editorPreviewActive) return;
    const hotbar = this.element('#hotbar');
    if (hotbar.dataset.mode === 'editor') return;
    hotbar.dataset.mode = 'editor';
    hotbar.innerHTML = '';
    const tools: Array<{ type: AdminTool; label: string; hint: string; icon: IconName }> = [
      { type: 'source', label: 'Saída', hint: 'Gera caixas', icon: 'source' },
      { type: 'receiver', label: 'Entrada', hint: 'Recebe caixas', icon: 'receiver' },
      { type: 'conveyor', label: 'Esteira', hint: 'Cenário fixo', icon: 'conveyor' },
      { type: 'spring', label: 'Trampolim', hint: 'Cenário fixo', icon: 'spring' },
      {
        type: 'obstacle',
        label: 'Bloqueador',
        hint: 'Arraste para redimensionar',
        icon: 'blocker',
      },
    ];
    for (const tool of tools) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tool-button editor-tool-button';
      button.dataset.editorTool = tool.type;
      button.title = `${tool.label} · ${tool.hint}`;
      button.setAttribute('aria-label', `${tool.label}: ${tool.hint}`);
      button.innerHTML = `<span class="tool-glyph tool-${tool.type}">${icon(tool.icon)}</span>`;
      button.addEventListener('click', () => {
        hotbar
          .querySelectorAll('.editor-tool-button')
          .forEach((node) => node.classList.remove('is-active'));
        button.classList.add('is-active');
        appEvents.emit('ui:editor-tool', { type: tool.type });
      });
      hotbar.append(button);
    }
  }

  private renderSelection(machine?: MachineState, obstacle?: ObstacleDefinition): void {
    const reverse = this.element<HTMLButtonElement>('[data-action="reverse"]');
    const editing = Boolean(this.editorContract && !this.editorPreviewActive);
    const canReverse = machine?.type === 'conveyor' && (editing || !machine.fixed);
    reverse.disabled = !canReverse;
    reverse.title = canReverse ? 'Inverter esteira · R' : 'Selecione uma esteira';
    const remove = this.element<HTMLButtonElement>('[data-action="delete"]');
    const canDelete = Boolean((machine && (editing || !machine.fixed)) || (editing && obstacle));
    remove.disabled = !canDelete;
    remove.title = canDelete
      ? 'Excluir seleção · Delete'
      : machine?.fixed
        ? 'Esta máquina faz parte do contrato'
        : 'Selecione uma máquina';
    if (obstacle && editing) remove.title = 'Excluir bloqueador · Delete';
  }

  private renderSimulationSpeed(speed: number): void {
    const nearestIndex = SIMULATION_SPEEDS.reduce(
      (bestIndex, candidate, index) =>
        Math.abs(candidate - speed) < Math.abs(SIMULATION_SPEEDS[bestIndex]! - speed)
          ? index
          : bestIndex,
      0,
    );
    const normalized = SIMULATION_SPEEDS[nearestIndex]!;
    const label = `${String(normalized).replace('.', ',')}×`;
    const input = this.element<HTMLInputElement>('[data-speed]');
    input.value = String(nearestIndex);
    input.setAttribute('aria-valuetext', label);
    this.element('[data-speed-label]').textContent = label;
  }

  private renderAngle(payload: {
    angle: number;
    clientX: number;
    clientY: number;
    visible: boolean;
  }): void {
    const indicator = this.element('#angle-indicator');
    indicator.classList.toggle('is-hidden', !payload.visible);
    if (!payload.visible) return;
    indicator.style.transform = `translate3d(${Math.round(payload.clientX + 22)}px, ${Math.round(payload.clientY - 62)}px, 0)`;
    indicator.style.setProperty('--angle', `${payload.angle}deg`);
    indicator.querySelector('strong')!.textContent = `${normalizeAngle(payload.angle)}°`;
  }

  private renderResult(result: {
    contractId: ContractId;
    stars: number;
    snapshot: GameSnapshot;
  }): void {
    const { snapshot } = result;
    const success = snapshot.status === 'success';
    const contract = this.contracts.find((item) => item.id === result.contractId);

    this.resultContractId = result.contractId;
    this.element('#result-kicker').textContent = success
      ? 'CONTRATO CONCLUÍDO'
      : 'TENTATIVA ENCERRADA';
    this.element('#result-title').textContent = success
      ? (contract?.title ?? 'Fluxo estabelecido')
      : 'A linha parou';
    this.element('#result-summary').textContent = success
      ? result.stars === 3
        ? 'Um fluxo preciso, limpo e eficiente.'
        : 'A entrega foi concluída. Ainda há espaço para refinar.'
      : snapshot.goal && snapshot.metrics.lost > snapshot.goal.maxLosses
        ? 'Muitas caixas foram perdidas. Ajuste os ângulos e tente de novo.'
        : 'O tempo terminou. Encurte o percurso e mantenha o ritmo.';

    const starsNode = this.element('#result-stars');
    starsNode.innerHTML = stars(success ? result.stars : 0, false);
    starsNode.setAttribute('aria-label', `${success ? result.stars : 0} estrelas`);
    this.element('[data-result="delivered"] strong').textContent = String(
      snapshot.metrics.delivered,
    );
    this.element('[data-result="lost"] strong').textContent = String(snapshot.metrics.lost);
    this.element('[data-result="elapsed"] strong').textContent = formatTime(
      snapshot.metrics.elapsedSeconds,
    );
    this.element('[data-result="pieces"] strong').textContent = String(
      snapshot.metrics.placedPieces,
    );

    const next = this.element<HTMLButtonElement>('[data-action="next"]');
    const currentIndex = this.contracts.findIndex((item) => item.id === result.contractId);
    next.classList.toggle('is-hidden', !success || currentIndex >= this.contracts.length - 1);
    this.element('#result-modal').classList.remove('is-hidden');
    if (success) this.audio.play('win');
  }

  private setAdminEnabled(enabled: boolean): void {
    if (!this.adminAvailable) return;
    this.adminEnabled = enabled;
    this.root.classList.toggle('is-admin-enabled', enabled);
    const toggle = this.element<HTMLButtonElement>('#admin-toggle');
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.classList.toggle('is-active', enabled);
    toggle.querySelector('span')!.textContent = enabled ? 'Desativar admin' : 'Ativar admin';
    this.element('#menu-admin-badge').classList.toggle('is-hidden', !enabled);
    this.element('#create-contract-button').classList.toggle('is-hidden', !enabled);
    this.renderMenuCards();
    appEvents.emit('ui:admin-mode', { enabled });
  }

  private renderEditorState(): void {
    const contract = this.editorContract;
    if (!contract) return;
    this.element('#editor-rail').classList.toggle('is-hidden', this.editorPreviewActive);
    this.element('#editor-contract-title').textContent = contract.title.trim() || 'Fase sem título';
    const dirtyState = this.element('#editor-dirty-state');
    dirtyState.textContent = this.editorDirty
      ? this.editorIsNew
        ? 'Nova fase · não salva'
        : 'Alterações não salvas'
      : 'Salva neste navegador';
    dirtyState.classList.toggle('is-dirty', this.editorDirty);
    this.element<HTMLButtonElement>('[data-action="editor-save"]').disabled = !this.editorDirty;

    const form = this.element<HTMLFormElement>('#editor-contract-form');
    if (!form.contains(document.activeElement)) this.populateEditorForm(contract);
  }

  private populateEditorForm(contract: ContractDefinition): void {
    const form = this.element<HTMLFormElement>('#editor-contract-form');
    setFormControlValue(form, 'title', contract.title);
    setFormControlValue(form, 'subtitle', contract.subtitle);
    setFormControlValue(form, 'description', contract.description);
    setFormControlValue(form, 'deliveries', contract.goal.deliveries);
    setFormControlValue(form, 'maxLosses', contract.goal.maxLosses);
    setFormControlValue(form, 'pieceBudget', contract.goal.pieceBudget);
    setFormControlValue(form, 'timeLimitSeconds', contract.goal.timeLimitSeconds ?? '');
    setFormControlValue(form, 'parPieces', contract.goal.parPieces);
    setFormControlValue(form, 'parTimeSeconds', contract.goal.parTimeSeconds ?? '');
    setFormControlValue(form, 'spawnIntervalSeconds', contract.spawnIntervalSeconds);
    setFormControlChecked(
      form,
      'availableConveyor',
      contract.availableMachines.includes('conveyor'),
    );
    setFormControlChecked(form, 'availableSpring', contract.availableMachines.includes('spring'));
  }

  private handleEditorFormInput(): void {
    if (!this.editorContract) return;
    const form = this.element<HTMLFormElement>('#editor-contract-form');
    const availableMachines: MachineType[] = [];
    if (formCheckbox(form, 'availableConveyor').checked) availableMachines.push('conveyor');
    if (formCheckbox(form, 'availableSpring').checked) availableMachines.push('spring');
    const contract: ContractDefinition = {
      ...this.editorContract,
      title: formValue(form, 'title'),
      subtitle: formValue(form, 'subtitle'),
      description: formValue(form, 'description'),
      availableMachines,
      goal: {
        ...this.editorContract.goal,
        deliveries: numberFormValue(form, 'deliveries'),
        maxLosses: numberFormValue(form, 'maxLosses'),
        pieceBudget: numberFormValue(form, 'pieceBudget'),
        timeLimitSeconds: optionalNumberFormValue(form, 'timeLimitSeconds'),
        parPieces: numberFormValue(form, 'parPieces'),
        parTimeSeconds: optionalNumberFormValue(form, 'parTimeSeconds'),
      },
      spawnIntervalSeconds: numberFormValue(form, 'spawnIntervalSeconds'),
    };
    this.editorContract = contract;
    this.editorDirty = true;
    this.clearEditorMessage();
    this.element('#editor-contract-title').textContent = contract.title.trim() || 'Fase sem título';
    const dirty = this.element('#editor-dirty-state');
    dirty.textContent = this.editorIsNew ? 'Nova fase · não salva' : 'Alterações não salvas';
    dirty.classList.add('is-dirty');
    this.element<HTMLButtonElement>('[data-action="editor-save"]').disabled = false;
    appEvents.emit('ui:editor-update-settings', { contract: structuredClone(contract) });
  }

  private validateEditorSettings(): boolean {
    const contract = this.editorContract;
    if (!contract) return false;
    const form = this.element<HTMLFormElement>('#editor-contract-form');
    const errors: string[] = [];
    if (!contract.title.trim()) errors.push('Informe o título da fase.');
    if (contract.goal.deliveries < 1) errors.push('Entregas deve ser pelo menos 1.');
    if (contract.goal.maxLosses < 0) errors.push('Perdas máximas não pode ser negativa.');
    if (contract.goal.pieceBudget < 0) errors.push('O orçamento não pode ser negativo.');
    if (contract.goal.parPieces > contract.goal.pieceBudget)
      errors.push('A referência de peças não pode superar o orçamento.');
    if (contract.spawnIntervalSeconds <= 0)
      errors.push('O intervalo de geração deve ser positivo.');
    if (contract.goal.timeLimitSeconds !== undefined && contract.goal.timeLimitSeconds <= 0)
      errors.push('O tempo limite deve ser positivo.');
    if (contract.goal.parTimeSeconds !== undefined && contract.goal.parTimeSeconds <= 0)
      errors.push('O tempo de referência deve ser positivo.');
    if (!contract.fixedMachines.some((machine) => machine.type === 'source'))
      errors.push('Adicione pelo menos uma saída.');
    if (!contract.fixedMachines.some((machine) => machine.type === 'receiver'))
      errors.push('Adicione pelo menos uma entrada.');

    if (!form.checkValidity()) form.reportValidity();
    if (errors.length === 0 && form.checkValidity()) return true;
    if (errors.length === 0) errors.push('Revise os campos obrigatórios destacados.');
    this.setEditorMessage({
      tone: 'danger',
      message: 'A fase ainda não pode ser salva.',
      errors,
    });
    this.element('#editor-config-panel').classList.remove('is-hidden');
    this.element<HTMLButtonElement>('[data-action="editor-configure"]').setAttribute(
      'aria-expanded',
      'true',
    );
    return false;
  }

  private toggleEditorConfiguration(): void {
    if (!this.editorContract || this.editorPreviewActive) return;
    const panel = this.element('#editor-config-panel');
    const open = panel.classList.contains('is-hidden');
    panel.classList.toggle('is-hidden', !open);
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-action="editor-configure"]')
      .forEach((button) => button.setAttribute('aria-expanded', String(open)));
    appEvents.emit('ui:editor-configure', { open });
  }

  private requestEditorCancel(): void {
    if (!this.editorContract) return;
    if (this.editorDirty) {
      this.element('#editor-confirm-modal').classList.remove('is-hidden');
      return;
    }
    appEvents.emit('ui:editor-cancel', undefined);
    this.closeAdminEditor();
  }

  private startNextContract(): void {
    if (!this.resultContractId) return;
    const currentIndex = this.contracts.findIndex(
      (contract) => contract.id === this.resultContractId,
    );
    const next = this.contracts[currentIndex + 1];
    if (!next) {
      appEvents.emit('ui:menu', undefined);
      this.showMenu();
      return;
    }
    appEvents.emit('ui:start-mode', {
      mode: 'campaign',
      contractId: next.id,
      contract: structuredClone(next),
    });
  }

  private openAdminConfirmation(
    kind: 'restore' | 'delete',
    contractId: ContractId,
    title: string,
  ): void {
    this.pendingAdminAction = { kind, contractId };
    this.element('#admin-confirm-kicker').textContent =
      kind === 'restore' ? 'RESTAURAR ORIGINAL' : 'EXCLUIR FASE';
    this.element('#admin-confirm-title').textContent =
      kind === 'restore' ? `Restaurar “${title}”?` : `Excluir “${title}”?`;
    this.element('#admin-confirm-copy').textContent =
      kind === 'restore'
        ? 'As alterações locais e o recorde desta fase serão removidos.'
        : 'A fase personalizada e seu resultado salvo serão removidos deste navegador.';
    this.element<HTMLButtonElement>('[data-action="admin-confirm-accept"]').textContent =
      kind === 'restore' ? 'Restaurar' : 'Excluir';
    this.element('#admin-confirm-modal').classList.remove('is-hidden');
  }

  private confirmAdminAction(): void {
    const pending = this.pendingAdminAction;
    if (!pending) return;
    this.pendingAdminAction = undefined;
    this.element('#admin-confirm-modal').classList.add('is-hidden');
    if (pending.kind === 'restore')
      appEvents.emit('ui:admin-restore-contract', { contractId: pending.contractId });
    else appEvents.emit('ui:admin-delete-contract', { contractId: pending.contractId });
  }

  private clearEditorMessage(): void {
    const container = this.element('#editor-feedback');
    container.classList.add('is-hidden');
    container.removeAttribute('data-tone');
    container.replaceChildren();
  }

  private showToast(message: string, tone: 'neutral' | 'success' | 'danger'): void {
    const toast = this.element('#toast');
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.classList.add('is-visible');
    this.toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2300);
  }

  private commitSettings(patch: Partial<ProgressSave['settings']>): void {
    this.progress = {
      ...this.progress,
      settings: { ...this.progress.settings, ...patch },
    };
    this.onProgressChange?.(this.progress);
  }

  private updateSoundControls(): void {
    const muted = this.audio.isMuted;
    const button = this.element<HTMLButtonElement>('[data-action="mute"]');
    button.setAttribute('aria-label', muted ? 'Ativar som' : 'Silenciar');
    this.element('[data-sound-icon]').innerHTML = icon(muted ? 'muted' : 'sound');
    button.classList.toggle('is-muted', muted);
    const volume = this.root.querySelector<HTMLInputElement>('[data-volume]');
    if (volume) volume.value = String(Math.round(this.audio.currentVolume * 100));
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`UI element not found: ${selector}`);
    return element;
  }
}

function metric(label: string, value: string, className: string, id: string): string {
  return `<div class="metric metric-${className}" data-metric="${id}"><span>${label}</span><strong>${value}</strong></div>`;
}

function resultMetric(label: string, value: string, id: string): string {
  return `<div data-result="${id}"><span>${label}</span><strong>${value}</strong></div>`;
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function normalizeAngle(angle: number): number {
  const normalized = Math.round(angle) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function escapeHTML(value: string): string {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function formControl(form: HTMLFormElement, name: string): HTMLInputElement | HTMLTextAreaElement {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement))
    throw new Error(`Editor form control not found: ${name}`);
  return control;
}

function formCheckbox(form: HTMLFormElement, name: string): HTMLInputElement {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLInputElement)) throw new Error(`Editor checkbox not found: ${name}`);
  return control;
}

function setFormControlValue(form: HTMLFormElement, name: string, value: string | number): void {
  formControl(form, name).value = String(value);
}

function setFormControlChecked(form: HTMLFormElement, name: string, checked: boolean): void {
  formCheckbox(form, name).checked = checked;
}

function formValue(form: HTMLFormElement, name: string): string {
  return formControl(form, name).value;
}

function numberFormValue(form: HTMLFormElement, name: string): number {
  const value = Number(formValue(form, name));
  return Number.isFinite(value) ? value : 0;
}

function optionalNumberFormValue(form: HTMLFormElement, name: string): number | undefined {
  const raw = formValue(form, name).trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function stars(count: number, compact: boolean): string {
  return `<span class="${compact ? 'mini-stars' : 'star-row'}">${[1, 2, 3]
    .map((star) => `<i class="${star <= count ? 'is-filled' : ''}">${icon('star')}</i>`)
    .join('')}</span>`;
}

function icon(name: IconName): string {
  const paths: Record<IconName, string> = {
    source: '<path d="M4 5h16v14H4z"/><path d="M8 9h8M12 2v7m-3-3 3 3 3-3"/>',
    conveyor:
      '<rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="7" cy="12" r="1.5"/><circle cx="17" cy="12" r="1.5"/><path d="m10 9 3 3-3 3"/>',
    receiver: '<path d="M4 5h16v14H4z"/><path d="M8 15h8M12 2v8m-3-3 3 3 3-3"/>',
    spring: '<path d="M3 7h18M5 5v4m14-4v4M6 18l3-7 3 7 3-7 3 7"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    pause: '<path d="M7 5h4v14H7zm6 0h4v14h-4z"/>',
    reset: '<path d="M4.8 8A8 8 0 1 1 4 14"/><path d="M4 4v5h5"/>',
    undo: '<path d="m9 7-5 5 5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/>',
    redo: '<path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/>',
    trash: '<path d="M4 7h16M9 3h6l1 4H8zM7 7l1 14h8l1-14M10 11v6m4-6v6"/>',
    reverse: '<path d="M7 7h11l-3-3m3 3-3 3M17 17H6l3 3m-3-3 3-3"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    sound: '<path d="M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10"/>',
    muted: '<path d="M4 10v4h4l5 4V6L8 10zM17 10l4 4m0-4-4 4"/>',
    fullscreen: '<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/>',
    grid: '<rect x="3" y="3" width="5" height="5"/><rect x="9.5" y="3" width="5" height="5"/><rect x="16" y="3" width="5" height="5"/><rect x="3" y="9.5" width="5" height="5"/><rect x="9.5" y="9.5" width="5" height="5"/><rect x="16" y="9.5" width="5" height="5"/><rect x="3" y="16" width="5" height="5"/><rect x="9.5" y="16" width="5" height="5"/><rect x="16" y="16" width="5" height="5"/>',
    clear: '<path d="m4 15 8-8 6 6-8 8H4z"/><path d="m13.5 8.5 2-2 3 3-2 2M4 21h16"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    star: '<path d="m12 2 3 6 7 .9-5 4.8 1.3 6.8L12 17.3l-6.3 3.2L7 13.7 2 8.9 9 8z"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4M4 20h16"/>',
    restore: '<path d="M4 8V3m0 0h5M4 3l4 4a8 8 0 1 1-2 8"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.5 1a8 8 0 0 0-1.7-1L14.3 3h-4.6l-.4 3a8 8 0 0 0-1.7 1L5 6 3 9.5 5.1 11a7 7 0 0 0 0 2L3 14.5 5 18l2.6-1a8 8 0 0 0 1.7 1l.4 3h4.6l.4-3a8 8 0 0 0 1.7-1l2.6 1 2-3.5-2.1-1.5a7 7 0 0 0 .1-1z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    blocker:
      '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="m5 17 12-12m-8 15L21 8M3 12l8-8"/>',
    save: '<path d="M4 3h13l3 3v15H4z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
    test: '<path d="m8 5 11 7-11 7z"/><path d="M3 3v18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}
