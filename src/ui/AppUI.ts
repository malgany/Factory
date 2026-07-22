import { appEvents } from '../core/events';
import factoryBoxTextureUrl from '../assets/factory-box-game.png?url';
import factoryCampaignEnvironmentUrl from '../assets/factory-campaign-environment.webp?url';
import { createContractResult } from '../domain/rules';
import type {
  ContractDefinition,
  ContractId,
  ContractResult,
  GameSnapshot,
  MachineState,
  MachineType,
  ObstacleDefinition,
  ProgressSave,
} from '../domain/types';
import { createMenuDemo, type MenuDemoController } from '../game/MenuDemoScene';
import { isLocalAdminHost } from '../platform/localAdmin';
import { AudioService } from './AudioService';

export interface AppUIOptions {
  root: HTMLElement;
  contracts: readonly ContractDefinition[];
  progress: ProgressSave;
  adminAvailable?: boolean;
  onProgressChange?: (progress: ProgressSave) => void;
  onRequestFullscreen?: () => void | Promise<void>;
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
type MenuView = 'home' | 'play' | 'options';
type OptionsCategory = 'audio-video' | 'controls';
type IconName =
  | MachineType
  | 'play'
  | 'stop'
  | 'reset'
  | 'undo'
  | 'redo'
  | 'copy'
  | 'cut'
  | 'trash'
  | 'reverse'
  | 'menu'
  | 'sound'
  | 'muted'
  | 'fullscreen'
  | 'windowed'
  | 'back'
  | 'mouse'
  | 'keyboard'
  | 'grid'
  | 'clear'
  | 'lock'
  | 'star'
  | 'ranking'
  | 'edit'
  | 'settings'
  | 'close'
  | 'blocker'
  | 'save'
  | 'test'
  | 'plus';

type AdminTool = MachineType | 'obstacle' | 'star';
export type CatalogSavingContext = 'editor' | 'operation';

const MACHINE_COPY: Record<MachineType, { name: string; hint: string }> = {
  source: { name: 'Saída', hint: 'Gera caixas' },
  conveyor: { name: 'Esteira', hint: 'Conduz o fluxo' },
  'tracked-conveyor': { name: 'Esteira física', hint: 'Move por corrente e atrito' },
  receiver: { name: 'Entrada', hint: 'Recebe caixas' },
  spring: { name: 'Trampolim', hint: 'Projeta caixas' },
};

const SIMULATION_SPEEDS = [0.1, 0.2, 0.5, 1, 2, 3, 5] as const;
const DRAG_UI_RESTORE_DELAY_MS = 300;
const MINIMUM_LOADING_DURATION_MS = 360;
const MENU_CAMERA_DURATION_MS = 650;
const MENU_CAMERA_FALLBACK_MS = MENU_CAMERA_DURATION_MS + 100;
const CAMPAIGN_WORLD = 1;
const CAMPAIGN_WORLDS = [{ value: 1, label: 'Mundo 1' }] as const;
const CAMPAIGN_STAGE_POSITIONS = [
  { stage: 1, x: 132, y: 724 },
  { stage: 2, x: 336, y: 655 },
  { stage: 3, x: 500, y: 742 },
  { stage: 4, x: 604, y: 593 },
  { stage: 5, x: 792, y: 672 },
  { stage: 6, x: 968, y: 602 },
  { stage: 7, x: 1124, y: 694 },
  { stage: 8, x: 1240, y: 552 },
  { stage: 9, x: 1428, y: 574 },
  { stage: 10, x: 1580, y: 652 },
] as const;

function campaignRouteLinks(lockedStages: ReadonlySet<number>): string {
  const links = CAMPAIGN_STAGE_POSITIONS.slice(0, -1)
    .map((stage, index) => {
      const nextStage = CAMPAIGN_STAGE_POSITIONS[index + 1]!;
      return `
        <g class="campaign-route-link${lockedStages.has(nextStage.stage) ? ' is-locked' : ''}">
          <line class="campaign-route-link-shadow" x1="${stage.x}" y1="${stage.y}" x2="${nextStage.x}" y2="${nextStage.y}" pathLength="3"></line>
          <line class="campaign-route-link-dashes" x1="${stage.x}" y1="${stage.y}" x2="${nextStage.x}" y2="${nextStage.y}" pathLength="3"></line>
        </g>`;
    })
    .join('');

  return `
    <svg class="campaign-route-overlay" viewBox="0 0 1672 941" aria-hidden="true" focusable="false">
      ${links}
    </svg>`;
}

function contractLabel(contract: Pick<ContractDefinition, 'stage' | 'world'>): string {
  return `${contract.stage}-${contract.world}`;
}

export class AppUI {
  readonly gameContainerId = 'game-container';

  private readonly root: HTMLElement;
  private contracts: ContractDefinition[];
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
  private catalogSaving = false;
  private catalogSavingContext?: CatalogSavingContext;
  private resultContractId?: ContractId;
  private selectedCampaignContractId?: ContractId;
  private pendingAdminAction?: { contractId: ContractId };
  private gameReady = false;
  private readonly loadingStartedAt = performance.now();
  private readonly domEvents = new AbortController();
  private snapshot?: GameSnapshot;
  private readyTimer?: number;
  private unsubs: Unsubscribe[] = [];
  private toastTimer?: number;
  private dragUiRestoreTimer?: number;
  private menuDemo?: MenuDemoController;
  private menuTransitionCleanup?: () => void;

  constructor(options: AppUIOptions) {
    this.root = options.root;
    this.contracts = [...options.contracts].sort((a, b) => a.order - b.order);
    this.adminAvailable =
      options.adminAvailable ?? (import.meta.env.DEV && isLocalAdminHost(window.location.hostname));
    this.progress = options.progress;
    this.onProgressChange = options.onProgressChange;
    this.onRequestFullscreen = options.onRequestFullscreen;
    this.audio = new AudioService(options.progress.settings);

    this.renderShell();
    this.root.classList.add('is-menu-open');
    this.menuDemo = createMenuDemo(this.element('.menu-motion-demo'));
    this.menuDemo.setActive(true);
    this.setGameReady(false);
    this.bindDOM();
    this.bindEvents();
    this.renderMenuCards();
    this.updateSoundControls();
    this.updateFullscreenControls();
  }

  updateProgress(progress: ProgressSave): void {
    this.progress = progress;
    this.audio.setMuted(progress.settings.muted);
    this.audio.setVolume(progress.settings.volume);
    this.renderMenuCards();
    this.updateSoundControls();
  }

  updateContracts(contracts: readonly ContractDefinition[]): void {
    this.contracts = [...contracts].sort((a, b) => a.order - b.order);
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
    this.showMenu('play');
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

  setCatalogSaving(
    saving: boolean,
    context: CatalogSavingContext = this.editorContract ? 'editor' : 'operation',
  ): void {
    this.catalogSaving = saving;
    this.catalogSavingContext = saving ? context : undefined;
    if (context === 'editor') appEvents.emit('ui:editor-persistence', { saving });
    if (this.editorContract) this.renderEditorState();
    this.renderCatalogSavingState();
    if (saving && context === 'editor' && this.editorContract) {
      this.setEditorMessage({ tone: 'neutral', message: 'Salvando no JSON…' });
    }
  }

  markEditorSaved(contract: ContractDefinition): void {
    if (!this.editorContract || this.editorContract.id !== contract.id) return;
    this.catalogSaving = false;
    this.catalogSavingContext = undefined;
    this.editorContract = structuredClone(contract);
    this.editorIsNew = false;
    this.editorDirty = false;
    this.renderEditorState();
    this.renderCatalogSavingState();
    this.setEditorMessage({ tone: 'success', message: 'Fase salva no JSON local.' });
  }

  showMenu(view: MenuView = 'home'): void {
    const menu = this.element('#menu-screen');
    menu.classList.remove('is-hidden');
    menu.removeAttribute('inert');
    this.element('#result-modal').classList.add('is-hidden');
    this.element('#ranking-modal').classList.add('is-hidden');
    this.closePauseMenu();
    this.setMenuView(view);
    this.root.classList.add('is-menu-open');
    this.updateGameUiAvailability();
  }

  hideMenu(): void {
    this.cancelMenuTransition();
    this.menuDemo?.setActive(false);
    const menu = this.element('#menu-screen');
    menu.classList.add('is-hidden');
    delete menu.dataset.menuTransitioning;
    this.root.classList.remove('is-menu-open');
    this.updateGameUiAvailability();
  }

  private setMenuView(view: MenuView): void {
    const menu = this.element('#menu-screen');
    const previousView = (menu.dataset.menuView as MenuView | undefined) ?? 'home';
    if (view === 'options') this.setOptionsCategory('audio-video');
    const cameraMove =
      (previousView === 'home' && view === 'options') ||
      (previousView === 'options' && view === 'home') ||
      (previousView === 'home' && view === 'play') ||
      (previousView === 'play' && view === 'home');
    const shouldAnimate =
      cameraMove &&
      !menu.classList.contains('is-hidden') &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.cancelMenuTransition();
    if (view !== 'home' || cameraMove) this.menuDemo?.setActive(false);

    if (!shouldAnimate) {
      menu.dataset.menuView = view;
      this.completeMenuView(view, previousView);
      return;
    }

    const world = this.element('.menu-world');
    menu.dataset.menuTransitioning = 'true';
    this.updateMenuPanels(view, true);
    world.getBoundingClientRect();

    let finished = false;
    const cleanup = () => {
      world.removeEventListener('transitionend', handleTransitionEnd);
      window.clearTimeout(fallbackTimer);
      if (this.menuTransitionCleanup === cleanup) this.menuTransitionCleanup = undefined;
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      this.completeMenuView(view, previousView);
    };
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target === world && event.propertyName === 'transform') finish();
    };

    world.addEventListener('transitionend', handleTransitionEnd);
    const fallbackTimer = window.setTimeout(finish, MENU_CAMERA_FALLBACK_MS);
    this.menuTransitionCleanup = cleanup;
    menu.dataset.menuView = view;
  }

  private completeMenuView(view: MenuView, previousView: MenuView): void {
    const menu = this.element('#menu-screen');
    delete menu.dataset.menuTransitioning;
    this.updateMenuPanels(view, false);
    if (view === 'home' && !menu.classList.contains('is-hidden')) this.menuDemo?.setActive(true);

    window.requestAnimationFrame(() => this.focusMenuView(view, previousView));
  }

  private updateMenuPanels(view: MenuView, transitioning: boolean): void {
    const menu = this.element('#menu-screen');
    const originStation = menu.querySelector<HTMLElement>('.menu-origin-station');
    const originUnavailable = transitioning || view === 'options';
    originStation?.toggleAttribute('inert', originUnavailable);
    originStation?.setAttribute('aria-hidden', String(originUnavailable));

    menu.querySelectorAll<HTMLElement>('[data-menu-panel]').forEach((panel) => {
      const panelView = panel.dataset.menuPanel as MenuView;
      const visuallyHidden =
        panelView === 'play'
          ? view !== 'play' && !transitioning
          : panelView === 'home' && view === 'play' && !transitioning;
      const unavailable = transitioning || panelView !== view;
      panel.classList.toggle('is-hidden', visuallyHidden);
      panel.toggleAttribute('inert', unavailable);
      panel.setAttribute('aria-hidden', String(unavailable));
    });
  }

  private setOptionsCategory(category: OptionsCategory): void {
    const options = this.element<HTMLElement>('[data-menu-panel="options"]');
    options.dataset.optionsCategory = category;
    options.querySelectorAll<HTMLButtonElement>('[data-options-tab]').forEach((button) => {
      const active = button.dataset.optionsTab === category;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    options.querySelectorAll<HTMLElement>('[data-options-panel]').forEach((panel) => {
      const active = panel.dataset.optionsPanel === category;
      panel.classList.toggle('is-hidden', !active);
      panel.toggleAttribute('inert', !active);
      panel.setAttribute('aria-hidden', String(!active));
    });
  }

  private focusMenuView(view: MenuView, previousView: MenuView): void {
    if (view === 'play' && !this.adminEnabled) {
      this.root
        .querySelector<HTMLButtonElement>('.campaign-map-back-button')
        ?.focus({ preventScroll: true });
      return;
    }

    if (view === 'play' && this.adminEnabled) {
      const dots = [...this.root.querySelectorAll<HTMLButtonElement>('[data-contract-dot]')];
      const selectedIndex = Math.max(
        0,
        dots.findIndex((dot) => dot.getAttribute('aria-current') === 'true'),
      );
      this.selectMenuContract(selectedIndex, true, 'auto');
      const currentCard = this.root.querySelector<HTMLButtonElement>(
        '#contract-list .stage-contract-card.is-current',
      );
      const focusTarget =
        currentCard && !currentCard.disabled
          ? currentCard
          : (dots[selectedIndex] ??
            this.root.querySelector<HTMLButtonElement>('.campaign-back-button'));
      focusTarget?.focus({ preventScroll: true });
      return;
    }

    const focusSelector =
      view === 'home'
        ? previousView === 'options'
          ? '[data-action="menu-options"]'
          : '[data-action="menu-play"]'
        : `[data-menu-panel="${view}"] [data-action="menu-home"]`;
    this.root.querySelector<HTMLButtonElement>(focusSelector)?.focus({ preventScroll: true });
  }

  private cancelMenuTransition(): void {
    this.menuTransitionCleanup?.();
    this.menuTransitionCleanup = undefined;
  }

  destroy(): void {
    this.cancelMenuTransition();
    this.menuDemo?.destroy();
    this.menuDemo = undefined;
    this.domEvents.abort();
    for (const unsubscribe of this.unsubs) unsubscribe();
    this.unsubs = [];
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    if (this.readyTimer !== undefined) window.clearTimeout(this.readyTimer);
    if (this.dragUiRestoreTimer !== undefined) window.clearTimeout(this.dragUiRestoreTimer);
    this.audio.destroy();
    this.root.replaceChildren();
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <main class="factory-app" aria-label="Factory">
        <div id="${this.gameContainerId}" class="game-container" aria-label="Área de construção"></div>

        <section id="game-ui" class="game-ui" aria-label="Interface do contrato">
        <header class="top-rail">
            <div class="top-left-controls">
              <button class="icon-button menu-button" data-action="pause-menu" aria-label="Abrir menu de pausa" title="Menu de pausa">
                ${icon('menu')}
              </button>
            </div>

            <div class="top-right-controls">
              <div class="metric-strip" role="status" aria-live="polite">
                ${metric('Tempo', '00:00', 'time', 'time')}
                ${metric('Perdas', '0 / 0', 'losses', 'losses')}
              </div>
              <div class="simulation-controls" aria-label="Controles da simulação">
                <label class="speed-control" title="Velocidade da simulação">
                  <span class="speed-readout" data-speed-label>1×</span>
                  <input data-speed type="range" min="0" max="6" step="1" value="3" aria-label="Velocidade da simulação" aria-valuetext="1×" />
                </label>
                <button class="simulation-play" data-action="run" type="button" aria-label="Iniciar simulação" title="Iniciar · Espaço">
                  <span data-run-icon data-icon="play">${icon('play')}</span>
                </button>
              </div>
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
            <span class="rail-divider" aria-hidden="true"></span>
            <button class="rail-button" data-action="undo" aria-label="Desfazer" title="Desfazer · Ctrl+Z">${icon('undo')}</button>
            <button class="rail-button" data-action="redo" aria-label="Refazer" title="Refazer · Ctrl+Y">${icon('redo')}</button>
            <button class="rail-button rail-danger is-hidden" data-action="clear" aria-label="Limpar todas as máquinas" title="Limpar tudo">
              ${icon('clear')}
            </button>
          </nav>

          <section class="build-dock glass-panel" aria-label="Ferramentas de construção">
            <div id="hotbar" class="hotbar" role="toolbar" aria-label="Máquinas"></div>
          </section>
          <section id="selection-dock" class="selection-dock glass-panel is-hidden" aria-label="Ações da seleção">
            <button class="selection-action" data-action="copy" type="button" aria-label="Copiar item" title="Copiar · Ctrl+C">
              ${icon('copy')}
            </button>
            <button class="selection-action" data-action="cut" type="button" aria-label="Recortar item" title="Recortar · Ctrl+X">
              ${icon('cut')}
            </button>
            <button class="selection-action is-hidden" data-action="reverse" type="button" aria-label="Inverter sentido da esteira" title="Inverter sentido · R">
              ${icon('reverse')}
            </button>
            <button class="selection-action selection-action-danger" data-action="delete" type="button" aria-label="Excluir item" title="Excluir · Delete">
              ${icon('trash')}
            </button>
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
              <fieldset class="field-group phase-identity-fields">
                <legend>Identificação</legend>
                <label class="field"><span>Mundo *</span><select name="world" required>${CAMPAIGN_WORLDS.map(({ value, label }) => `<option value="${value}">${label}</option>`).join('')}</select></label>
                <label class="field"><span>Fase *</span><select name="stage" required>${Array.from({ length: 10 }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join('')}</select></label>
                <output class="phase-identity-preview field-wide" data-stage-label>1-1</output>
              </fieldset>
              <fieldset class="field-group">
                <legend>Objetivo</legend>
                <label class="field"><span>Meta de entregas *</span><input name="deliveries" type="number" min="1" step="1" inputmode="numeric" required /></label>
                <label class="field"><span>Perdas máximas *</span><input name="maxLosses" type="number" min="0" step="1" required /></label>
                <label class="field"><span>Limite de peças *</span><input name="pieceBudget" type="number" min="0" step="1" inputmode="numeric" required /></label>
                <label class="field"><span>Tempo limite (s)</span><input name="timeLimitSeconds" type="number" min="1" step="1" inputmode="numeric" placeholder="Sem limite" /></label>
              </fieldset>
              <fieldset class="field-group">
                <legend>Ritmo e pontuação</legend>
                <label class="field field-wide"><span>Tempo ideal (s)</span><input name="idealTimeSeconds" type="number" min="0.1" step="0.1" inputmode="decimal" placeholder="Automático" /></label>
                <label class="field field-wide spawn-interval-field">
                  <span>Intervalo de geração <output data-spawn-interval-output>1,25 s</output></span>
                  <input name="spawnIntervalSeconds" type="range" min="0.8" max="10" step="0.05" value="1.25" required />
                </label>
              </fieldset>
              <fieldset class="field-group tool-availability">
                <legend>Ferramentas do jogador</legend>
                <label class="check-field"><input name="availableTrackedConveyor" type="checkbox" /><span>${icon('conveyor')} Esteira física</span></label>
                <label class="check-field"><input name="availableSpring" type="checkbox" /><span>${icon('spring')} Trampolim</span></label>
              </fieldset>
            </form>
            <div id="editor-feedback" class="editor-feedback is-hidden" role="status" aria-live="polite"></div>
          </aside>
        </section>

        <section id="menu-screen" class="menu-screen" data-menu-view="home" aria-labelledby="menu-title">
          <div class="menu-world">
            <div class="menu-backdrop"></div>
            <div class="menu-station menu-origin-station" aria-hidden="false">
              <div class="menu-content">
                <header class="menu-intro">
                  <h1 id="menu-title">Factory<span aria-hidden="true">.</span></h1>
                </header>

                <section class="menu-view menu-home-view" data-menu-panel="home" aria-label="Menu principal" aria-hidden="false">
                  <nav class="main-menu-nav" aria-label="Opções principais">
                    <button class="main-menu-action" data-action="menu-play" type="button">Jogar</button>
                    <button class="main-menu-action" data-action="menu-options" type="button">Opções</button>
                    <button class="main-menu-action" data-action="menu-exit" type="button">Sair</button>
                  </nav>
                </section>

                <section class="menu-view menu-play-view is-hidden" data-menu-panel="play" aria-label="Jogar" aria-hidden="true" inert>
                  <div class="campaign-map-stage">
                    <div class="campaign-map-art" id="campaign-map-art">
                      <img class="campaign-map-image" src="${factoryCampaignEnvironmentUrl}" alt="Cenário industrial da campanha" draggable="false" />
                      <div id="campaign-route-root" class="campaign-route-root"></div>
                      <div id="campaign-stage-nodes" class="campaign-stage-nodes" role="group" aria-label="Fases do Mundo 1"></div>
                    </div>
                    <div class="campaign-map-brand" role="img" aria-label="Factory">Factory<span aria-hidden="true">.</span></div>
                    <button class="options-back-button campaign-map-back-button" data-action="menu-home" type="button" aria-label="Voltar ao menu principal">
                      ${icon('back')}
                    </button>
                    <section id="campaign-stage-actions" class="campaign-stage-actions is-hidden" aria-live="polite">
                      <button class="primary-action" data-action="campaign-play" type="button">${icon('play')} Jogar</button>
                    </section>
                  </div>

                  <div class="campaign-legacy-content">
                    <button class="menu-back-button campaign-back-button" data-action="menu-home" type="button" aria-label="Voltar ao menu principal"><span aria-hidden="true">←</span><span>Voltar</span></button>
                    <header class="campaign-heading">
                      <span class="eyebrow">JOGAR</span>
                      <h2 id="play-menu-title">Escolha uma fase</h2>
                      <span class="progress-copy" id="campaign-progress">0 de 3 concluídos</span>
                    </header>
                    <div class="contract-browser campaign-browser">
                      <span id="menu-admin-badge" class="admin-badge menu-admin-badge is-hidden" role="status" aria-live="polite">ADMIN LOCAL</span>
                      <div id="contract-list" class="contract-list" aria-label="Fases da campanha"></div>
                      <nav id="contract-pagination" class="contract-pagination" aria-label="Selecionar fase"></nav>
                      <div class="campaign-actions">
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
                  </div>
                </section>

                <div id="menu-motion-demo" class="menu-motion-demo" aria-hidden="true"></div>
              </div>
              <footer class="menu-footer">
                <button id="admin-toggle" class="admin-toggle${this.adminAvailable ? '' : ' is-hidden'}" data-action="toggle-admin" type="button" aria-pressed="false">
                  ${icon('settings')} <span>Ativar admin</span>
                </button>
              </footer>
            </div>

            <section class="menu-view menu-options-view menu-station" data-menu-panel="options" data-options-category="audio-video" aria-label="Opções" aria-hidden="true" inert>
              <button class="options-back-button" data-action="menu-home" type="button" aria-label="Voltar ao menu principal">
                ${icon('back')}
              </button>
              <div class="options-layout">
                <nav class="options-category-menu" aria-label="Categorias de opções">
                  <button id="options-audio-video-tab" class="options-category-button is-active" data-action="options-audio-video" data-options-tab="audio-video" type="button" aria-controls="options-audio-video-panel" aria-pressed="true">
                    Áudio e vídeo
                  </button>
                  <button id="options-controls-tab" class="options-category-button" data-action="options-controls" data-options-tab="controls" type="button" aria-controls="options-controls-panel" aria-pressed="false">
                    Controles
                  </button>
                </nav>

                <div class="options-content">
                  <section id="options-audio-video-panel" class="options-panel menu-options-list" data-options-panel="audio-video" aria-labelledby="options-audio-video-tab" aria-hidden="false">
                    <div class="menu-option-row">
                      <div><strong>Som</strong></div>
                      <button class="menu-sound-toggle" data-action="mute" type="button" aria-label="Silenciar" aria-pressed="false">
                        <span class="menu-option-state" data-sound-state>Ligado</span>
                        <span data-sound-icon>${icon(this.progress.settings.muted ? 'muted' : 'sound')}</span>
                      </button>
                    </div>
                    <label class="menu-option-row menu-volume-option">
                      <div><strong>Volume</strong></div>
                      <span class="menu-volume-control">
                        <input data-volume type="range" min="0" max="100" value="${Math.round(this.progress.settings.volume * 100)}" aria-label="Volume dos efeitos" />
                        <output data-volume-output>${Math.round(this.progress.settings.volume * 100)}%</output>
                      </span>
                    </label>
                    <div class="menu-option-row">
                      <div><strong data-fullscreen-title>Tela cheia</strong></div>
                      <button class="menu-fullscreen-toggle" data-action="fullscreen" type="button" aria-label="Entrar em tela cheia" aria-pressed="false">
                        <span class="menu-option-state" data-fullscreen-state>Ativar</span>
                        <span data-fullscreen-icon>${icon('fullscreen')}</span>
                      </button>
                    </div>
                  </section>

                  <section id="options-controls-panel" class="options-panel controls-reference is-hidden" data-options-panel="controls" aria-labelledby="options-controls-tab" aria-hidden="true" inert>
                    <div class="control-device-grid">
                      <section class="control-device-card" aria-labelledby="mouse-controls-title">
                        <header class="control-device-heading">
                          <span class="control-device-icon">${icon('mouse')}</span>
                          <h3 id="mouse-controls-title">Mouse</h3>
                        </header>
                        <ul class="control-help-list">
                          <li><kbd>Esquerdo</kbd><span>Selecionar ou posicionar</span></li>
                          <li><kbd>Arrastar</kbd><span>Mover peça ou câmera</span></li>
                          <li><kbd>Alça circular</kbd><span>Girar peça</span></li>
                          <li><kbd>Direito + arrastar</kbd><span>Selecionar uma área</span></li>
                          <li><kbd>Roda</kbd><span>Aproximar ou afastar</span></li>
                        </ul>
                      </section>

                      <section class="control-device-card" aria-labelledby="keyboard-controls-title">
                        <header class="control-device-heading">
                          <span class="control-device-icon control-keyboard-icon">${icon('keyboard')}</span>
                          <h3 id="keyboard-controls-title">Teclado</h3>
                        </header>
                        <ul class="control-help-list">
                          <li><kbd>Espaço</kbd><span>Iniciar ou pausar</span></li>
                          <li><kbd>Q / E</kbd><span>Girar seleção</span></li>
                          <li><kbd>R</kbd><span>Inverter</span></li>
                          <li><kbd>Delete</kbd><span>Excluir seleção</span></li>
                          <li><kbd>Ctrl+C / Ctrl+X</kbd><span>Copiar ou recortar</span></li>
                          <li><kbd>Ctrl+Z / Ctrl+Y</kbd><span>Desfazer ou refazer</span></li>
                        </ul>
                      </section>
                    </div>
                  </section>
                </div>
              </div>
            </section>
          </div>
        </section>

        <div id="angle-indicator" class="angle-indicator is-hidden" aria-hidden="true">
          <strong>0°</strong>
        </div>
        <div id="toast" class="toast" role="status" aria-live="polite"></div>

        <section id="pause-modal" class="modal-layer is-hidden" role="dialog" aria-modal="true" aria-labelledby="pause-title">
          <div class="modal-scrim"></div>
          <div class="pause-card">
            <header class="pause-card-heading">
              <div><span class="eyebrow accent">MENU DA SIMULAÇÃO</span><h2 id="pause-title">Pausado</h2></div>
              <button class="icon-button" data-action="close-pause-menu" type="button" aria-label="Fechar menu de pausa" title="Fechar">
                ${icon('close')}
              </button>
            </header>
            <button class="primary-action pause-save" data-action="save-progress" type="button">
              ${icon('save')} <span>Salvar</span>
            </button>
            <div class="pause-setting">
              <div><strong>Som</strong><span>Ativar efeitos sonoros</span></div>
              <button class="icon-button sound-button" data-action="mute" type="button" aria-label="Silenciar" title="Som" aria-pressed="false">
                <span data-sound-icon>${icon(this.progress.settings.muted ? 'muted' : 'sound')}</span>
              </button>
            </div>
            <div class="pause-setting">
              <div><strong data-fullscreen-title>Tela cheia</strong><span data-fullscreen-description>Expandir visualização</span></div>
              <button class="icon-button" data-action="fullscreen" type="button" aria-label="Entrar em tela cheia" title="Tela cheia" aria-pressed="false">
                <span data-fullscreen-icon>${icon('fullscreen')}</span>
              </button>
            </div>
            <button class="soft-button pause-main-menu" data-action="menu" type="button">Menu principal</button>
          </div>
        </section>

        <section id="result-modal" class="modal-layer is-hidden" role="dialog" aria-modal="true" aria-labelledby="result-title">
          <div class="modal-scrim"></div>
          <div class="result-card">
            <span class="eyebrow accent" id="result-kicker">CONTRATO CONCLUÍDO</span>
            <h2 id="result-title">Fluxo estabelecido</h2>
            <div class="result-score" aria-live="polite">
              <span>PONTUAÇÃO</span>
              <strong data-result-score>0</strong>
              <small data-result-ranking>Fora do ranking</small>
            </div>
            <p id="result-summary">A linha encontrou seu ritmo.</p>
            <div class="result-metrics">
              ${resultMetric('Entregues', '0', 'delivered')}
              ${resultMetric('Perdidas', '0', 'lost')}
              ${resultMetric('Tempo', '00:00', 'elapsed')}
              ${resultMetric('Peças', '0', 'pieces')}
              ${resultMetric('Estrelas', '0', 'collected-stars')}
            </div>
            <dl class="score-breakdown is-hidden" id="score-breakdown">
              <div><dt>Entregas</dt><dd data-score-part="deliveries">+0</dd></div>
              <div><dt>Velocidade</dt><dd data-score-part="time">+0</dd></div>
              <div><dt>Eficiência</dt><dd data-score-part="efficiency">+0</dd></div>
              <div><dt>Estrelas</dt><dd data-score-part="stars">+0</dd></div>
              <div class="is-penalty"><dt>Perdas</dt><dd data-score-part="losses">−0</dd></div>
            </dl>
            <div class="result-actions">
              <button class="soft-button" data-action="result-menu">Menu</button>
              <button class="soft-button" data-action="replay">Repetir</button>
              <button class="primary-action" data-action="next">Próximo contrato <span>→</span></button>
            </div>
          </div>
        </section>

        <section id="ranking-modal" class="modal-layer is-hidden" role="dialog" aria-modal="true" aria-labelledby="ranking-title">
          <div class="modal-scrim" data-action="campaign-ranking-close"></div>
          <div class="ranking-card">
            <header>
              <div><span class="eyebrow accent">TOP 10 LOCAL</span><h2 id="ranking-title">Ranking da fase 1-1</h2></div>
              <button class="icon-button" data-action="campaign-ranking-close" type="button" aria-label="Fechar ranking">${icon('close')}</button>
            </header>
            <div id="ranking-list" class="ranking-list"></div>
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
    document.addEventListener('fullscreenchange', () => this.updateFullscreenControls(), {
      signal: this.domEvents.signal,
    });

    this.root.addEventListener(
      'keydown',
      (event) => {
        const rankingModal = this.element('#ranking-modal');
        const resultModal = this.element('#result-modal');
        const activeModal = !rankingModal.classList.contains('is-hidden')
          ? rankingModal
          : !resultModal.classList.contains('is-hidden')
            ? resultModal
            : undefined;
        if (!activeModal) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          if (activeModal === rankingModal) this.closeCampaignRanking();
          else this.handleAction('result-menu');
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [
          ...activeModal.querySelectorAll<HTMLElement>('button:not(:disabled):not(.is-hidden)'),
        ].filter((control) => !control.closest('.is-hidden'));
        if (focusable.length === 0) return;
        const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
        const nextIndex = event.shiftKey
          ? currentIndex <= 0
            ? focusable.length - 1
            : currentIndex - 1
          : currentIndex < 0 || currentIndex === focusable.length - 1
            ? 0
            : currentIndex + 1;
        event.preventDefault();
        focusable[nextIndex]?.focus({ preventScroll: true });
      },
      { signal: this.domEvents.signal },
    );

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
        const muted = volume === 0 ? true : this.audio.isMuted;
        if (muted !== this.audio.isMuted) this.audio.setMuted(muted);
        this.commitSettings({ volume, muted });
        appEvents.emit('ui:set-volume', { volume });
        if (volume === 0) appEvents.emit('ui:set-muted', { muted: true });
        this.updateSoundControls();
      },
      { signal: this.domEvents.signal },
    );
  }

  private bindEvents(): void {
    this.unsubs.push(
      appEvents.on('game:ready', () => this.finishGameLoading()),
      appEvents.on('game:snapshot', (snapshot) => this.renderSnapshot(snapshot)),
      appEvents.on('game:angle', (payload) => this.renderAngle(payload)),
      appEvents.on('game:dragging', ({ active }) => this.setDragUiOccluded(active)),
      appEvents.on('game:toast', ({ message, tone }) => this.showToast(message, tone)),
      appEvents.on('game:audio', ({ kind }) => this.audio.play(kind)),
      appEvents.on('game:result', ({ contractId, snapshot }) => {
        if (snapshot.status === 'success' && snapshot.mode === 'campaign') return;
        const contract = this.contracts.find(({ id }) => id === contractId) ?? this.editorContract;
        const result =
          snapshot.status === 'success' && contract
            ? createContractResult(contract, snapshot.metrics)
            : undefined;
        this.renderResult({ contractId, snapshot, result });
      }),
      appEvents.on('game:result-recorded', ({ result, snapshot, rankingPosition, isNewRecord }) => {
        const contract = this.contracts.find(({ id }) => id === result.contractId);
        const next = contract
          ? this.contracts.find(
              (candidate) =>
                candidate.world === contract.world && candidate.stage === contract.stage + 1,
            )
          : undefined;
        if (next && this.progress.unlockedContracts.includes(next.id)) {
          this.selectedCampaignContractId = next.id;
          this.renderCampaignMap();
        }
        this.renderResult({
          contractId: result.contractId,
          snapshot,
          result,
          rankingPosition,
          isNewRecord,
        });
      }),
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
    this.updateGameUiAvailability();
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
    if (this.catalogSaving && this.catalogSavingContext === 'editor') return;
    if (
      this.element('#menu-screen').dataset.menuTransitioning === 'true' &&
      (action === 'menu-home' || action === 'menu-options' || action === 'menu-play')
    )
      return;

    switch (action) {
      case 'menu-play':
        this.setMenuView('play');
        break;
      case 'menu-options':
        this.setMenuView('options');
        break;
      case 'menu-home':
        this.setMenuView('home');
        break;
      case 'campaign-play':
        this.startSelectedCampaign();
        break;
      case 'campaign-ranking':
        this.openCampaignRanking();
        break;
      case 'campaign-ranking-close':
        this.closeCampaignRanking();
        break;
      case 'options-audio-video':
        this.setOptionsCategory('audio-video');
        break;
      case 'options-controls':
        this.setOptionsCategory('controls');
        break;
      case 'menu-exit':
        break;
      case 'pause-menu':
        this.openPauseMenu();
        break;
      case 'close-pause-menu':
        this.closePauseMenu();
        break;
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
        if (this.snapshot?.status === 'running') appEvents.emit('ui:reset', undefined);
        else appEvents.emit('ui:run', undefined);
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
      case 'copy':
        appEvents.emit('ui:copy-selected', undefined);
        break;
      case 'cut':
        appEvents.emit('ui:cut-selected', undefined);
        break;
      case 'reverse':
        appEvents.emit('ui:reverse-selected', undefined);
        break;
      case 'toggle-grid':
        appEvents.emit('ui:toggle-grid', undefined);
        break;
      case 'replay':
        this.element('#result-modal').classList.add('is-hidden');
        this.updateGameUiAvailability();
        appEvents.emit('ui:replay', undefined);
        break;
      case 'next':
        this.element('#result-modal').classList.add('is-hidden');
        this.updateGameUiAvailability();
        this.startNextContract();
        break;
      case 'toggle-admin':
        if (this.catalogSaving) break;
        this.setAdminEnabled(!this.adminEnabled);
        break;
      case 'admin-create':
        if (this.catalogSaving) break;
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
        if (this.catalogSaving) break;
        if (this.editorContract && this.validateEditorSettings()) {
          this.setEditorMessage({ tone: 'neutral', message: 'Salvando no JSON…' });
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
        if (this.catalogSaving) break;
        this.confirmAdminAction();
        break;
      case 'save-progress':
        this.onProgressChange?.(this.progress);
        this.showToast('Jogo salvo.', 'success');
        break;
      case 'mute': {
        const muted = this.audio.toggleMuted();
        this.commitSettings({ muted });
        appEvents.emit('ui:set-muted', { muted });
        this.updateSoundControls();
        break;
      }
      case 'fullscreen':
        void this.toggleFullscreen();
        break;
    }
  }

  private async toggleFullscreen(): Promise<void> {
    appEvents.emit('ui:fullscreen', undefined);
    if (!this.onRequestFullscreen) return;
    try {
      await this.onRequestFullscreen();
    } catch {
      this.updateFullscreenControls();
      this.showToast('Não foi possível alternar a tela cheia.', 'danger');
    }
  }

  private openPauseMenu(): void {
    if (this.snapshot?.status === 'running') appEvents.emit('ui:pause', undefined);
    this.element('#pause-modal').classList.remove('is-hidden');
  }

  private closePauseMenu(): void {
    this.element('#pause-modal').classList.add('is-hidden');
  }

  private renderMenuCards(): void {
    this.renderCampaignMap();
    const list = this.element('#contract-list');
    const pagination = this.element('#contract-pagination');
    list.innerHTML = '';
    pagination.innerHTML = '';
    pagination.classList.remove('is-hidden');
    if (this.contracts.length === 0) {
      this.element('#campaign-progress').textContent = 'Nenhuma fase publicada';
      list.innerHTML = `
        <div class="contract-empty-state" role="status">
          <strong>Nenhuma fase publicada</strong>
          <span>${
            this.adminEnabled
              ? 'Crie a primeira fase para iniciar o catálogo.'
              : 'O catálogo ainda não tem fases. O Modo livre continua disponível.'
          }</span>
        </div>`;
      pagination.classList.add('is-hidden');
      this.renderCatalogSavingState();
      return;
    }
    if (this.adminEnabled) {
      this.renderAdminMenuCards(list);
      this.renderCatalogSavingState();
      return;
    }
    const completed = this.contracts.filter(
      (contract) => (this.progress.rankings[contract.id]?.length ?? 0) > 0,
    ).length;
    this.element('#campaign-progress').textContent =
      `${completed} de ${this.contracts.length} concluídos`;

    const furthestUnlockedIndex = Math.max(
      0,
      ...this.contracts.map((contract, index) =>
        this.progress.unlockedContracts.includes(contract.id) ? index : -1,
      ),
    );

    this.contracts.forEach((contract, index) => {
      const unlocked = this.progress.unlockedContracts.includes(contract.id);
      const best = this.progress.rankings[contract.id]?.[0];
      const label = contractLabel(contract);
      const button = document.createElement('button');
      button.className = `contract-card stage-contract-card${unlocked ? '' : ' is-locked'}${best ? ' is-complete' : ''}`;
      button.disabled = !unlocked;
      button.dataset.contractIndex = String(index);
      button.setAttribute(
        'aria-label',
        unlocked ? `Abrir fase ${label}` : `Fase ${label}, bloqueada`,
      );
      button.innerHTML = `
        <span class="stage-card-preview" aria-hidden="true">
          ${contractStagePreview(contract)}
          ${unlocked ? '' : `<span class="stage-card-lock">${icon('lock')}</span>`}
        </span>
        <span class="stage-card-details">
          <span class="stage-card-kicker">MUNDO ${contract.world}</span>
          <span class="contract-title-row"><strong>${label}</strong>${best ? `<i>${formatScore(best.score)} pts</i>` : ''}</span>
          <span class="contract-tags">
            <i>${contract.goal.deliveries} caixas</i>
            <i>${contract.goal.pieceBudget} peças</i>
            ${contract.goal.timeLimitSeconds ? `<i>${formatTime(contract.goal.timeLimitSeconds)}</i>` : ''}
          </span>
          <span class="stage-card-cta">${unlocked ? `Jogar ${icon('play')}` : `Bloqueada ${icon('lock')}`}</span>
        </span>
      `;
      button.addEventListener('focus', () => this.selectMenuContract(index, false));
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

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `contract-dot${unlocked ? '' : ' is-locked'}${best ? ' is-complete' : ''}`;
      dot.dataset.contractDot = contract.id;
      dot.setAttribute(
        'aria-label',
        unlocked ? `Ver fase ${label}` : `Ver fase ${label}, bloqueada`,
      );
      dot.innerHTML = unlocked
        ? `<span>${String(contract.order).padStart(2, '0')}</span>`
        : icon('lock');
      dot.addEventListener('click', () => this.selectMenuContract(index, true));
      pagination.append(dot);
    });

    this.selectMenuContract(furthestUnlockedIndex, false);
    const menu = this.element('#menu-screen');
    if (menu.dataset.menuView === 'play' && !menu.classList.contains('is-hidden')) {
      window.requestAnimationFrame(() =>
        this.selectMenuContract(furthestUnlockedIndex, true, 'auto'),
      );
    }
    this.renderCatalogSavingState();
  }

  private renderCampaignMap(): void {
    const contractsByStage = new Map(
      this.contracts
        .filter((contract) => contract.world === CAMPAIGN_WORLD)
        .map((contract) => [contract.stage, contract] as const),
    );
    const unlockedContracts = this.contracts.filter(
      (contract) =>
        contract.world === CAMPAIGN_WORLD && this.progress.unlockedContracts.includes(contract.id),
    );
    const currentSelection = unlockedContracts.find(
      (contract) => contract.id === this.selectedCampaignContractId,
    );
    if (!currentSelection) {
      const firstIncomplete = unlockedContracts.find(
        (contract) => (this.progress.rankings[contract.id]?.length ?? 0) === 0,
      );
      this.selectedCampaignContractId =
        firstIncomplete?.id ?? unlockedContracts.at(-1)?.id ?? unlockedContracts[0]?.id;
    }

    const lockedStages = new Set<number>();
    for (const position of CAMPAIGN_STAGE_POSITIONS) {
      const contract = contractsByStage.get(position.stage);
      if (!contract || !this.progress.unlockedContracts.includes(contract.id)) {
        lockedStages.add(position.stage);
      }
    }
    this.element('#campaign-route-root').innerHTML = campaignRouteLinks(lockedStages);

    const nodes = this.element('#campaign-stage-nodes');
    nodes.innerHTML = CAMPAIGN_STAGE_POSITIONS.map((position) => {
      const contract = contractsByStage.get(position.stage);
      const unlocked = Boolean(contract && this.progress.unlockedContracts.includes(contract.id));
      const selected = unlocked && contract?.id === this.selectedCampaignContractId;
      const completed = Boolean(contract && this.progress.rankings[contract.id]?.length);
      const label = `${position.stage}-${CAMPAIGN_WORLD}`;
      const ariaLabel = !contract
        ? `Fase ${label}, não cadastrada`
        : unlocked
          ? `Selecionar fase ${label}`
          : `Fase ${label}, bloqueada`;
      return `<button
        class="campaign-stage-marker${selected ? ' is-current' : ''}${unlocked ? '' : ' is-locked'}${completed ? ' is-complete' : ''}"
        type="button"
        data-campaign-stage="${position.stage}"
        ${contract ? `data-campaign-contract="${escapeHTML(contract.id)}"` : ''}
        style="--stage-x:${((position.x / 1672) * 100).toFixed(4)}%;--stage-y:${((position.y / 941) * 100).toFixed(4)}%"
        aria-label="${ariaLabel}"
        aria-pressed="${selected}"
        ${unlocked ? '' : 'disabled'}>
          <span class="campaign-stage-shadow" aria-hidden="true"></span>
          <span class="campaign-stage-base" aria-hidden="true"></span>
          <span class="campaign-stage-rim" aria-hidden="true"><span class="campaign-stage-disc">
            ${unlocked ? `<strong>${label}</strong>` : icon('lock')}
          </span></span>
        </button>`;
    }).join('');

    nodes.querySelectorAll<HTMLButtonElement>('[data-campaign-contract]').forEach((button) => {
      button.addEventListener('click', () => {
        const contractId = button.dataset.campaignContract;
        if (contractId) this.selectCampaignContract(contractId, true);
      });
    });
    this.renderCampaignStageActions();
  }

  private selectCampaignContract(contractId: ContractId, focus = false): void {
    const contract = this.contracts.find(({ id }) => id === contractId);
    if (!contract || !this.progress.unlockedContracts.includes(contract.id)) return;
    this.selectedCampaignContractId = contract.id;
    this.renderCampaignMap();
    if (focus) {
      this.root
        .querySelector<HTMLButtonElement>(`[data-campaign-contract="${CSS.escape(contract.id)}"]`)
        ?.focus({ preventScroll: true });
    }
  }

  private renderCampaignStageActions(): void {
    const panel = this.element('#campaign-stage-actions');
    const contract = this.contracts.find(({ id }) => id === this.selectedCampaignContractId);
    const available = Boolean(contract && this.progress.unlockedContracts.includes(contract.id));
    panel.classList.toggle('is-hidden', !available);
  }

  private startSelectedCampaign(): void {
    const contract = this.contracts.find(({ id }) => id === this.selectedCampaignContractId);
    if (!contract || !this.progress.unlockedContracts.includes(contract.id)) return;
    this.hideMenu();
    appEvents.emit('ui:start-mode', {
      mode: 'campaign',
      contractId: contract.id,
      contract: structuredClone(contract),
    });
  }

  private openCampaignRanking(): void {
    const contract = this.contracts.find(({ id }) => id === this.selectedCampaignContractId);
    if (!contract) return;
    this.element('#ranking-title').textContent = `Ranking da fase ${contractLabel(contract)}`;
    const ranking = this.progress.rankings[contract.id] ?? [];
    const list = this.element('#ranking-list');
    list.innerHTML = ranking.length
      ? ranking
          .map(
            (result, index) => `<article class="ranking-entry">
              <strong class="ranking-position">${index + 1}º</strong>
              <div><b>${formatScore(result.score)} pts</b><span>${formatRankingDate(result.completedAt)}</span></div>
              <dl>
                <div><dt>Tempo</dt><dd>${formatTime(result.metrics.elapsedSeconds)}</dd></div>
                <div><dt>Perdas</dt><dd>${result.metrics.lost}</dd></div>
                <div><dt>Peças</dt><dd>${result.metrics.placedPieces}</dd></div>
                <div><dt>Estrelas</dt><dd>${result.metrics.collectedStars}</dd></div>
              </dl>
            </article>`,
          )
          .join('')
      : '<div class="ranking-empty"><strong>Ainda não há pontuações</strong><span>Conclua a fase para entrar no Top 10 local.</span></div>';
    this.element('#ranking-modal').classList.remove('is-hidden');
    this.element('#menu-screen').toggleAttribute('inert', true);
    window.requestAnimationFrame(() =>
      this.root
        .querySelector<HTMLButtonElement>('#ranking-modal [data-action="campaign-ranking-close"]')
        ?.focus(),
    );
  }

  private closeCampaignRanking(): void {
    this.element('#ranking-modal').classList.add('is-hidden');
    this.element('#menu-screen').removeAttribute('inert');
    this.root
      .querySelector<HTMLButtonElement>('[data-action="campaign-ranking"]')
      ?.focus({ preventScroll: true });
  }

  private selectMenuContract(
    index: number,
    scroll: boolean,
    behavior: ScrollBehavior = 'smooth',
  ): void {
    const cards = [
      ...this.root.querySelectorAll<HTMLButtonElement>('#contract-list .stage-contract-card'),
    ];
    const dots = [...this.root.querySelectorAll<HTMLButtonElement>('[data-contract-dot]')];
    const safeIndex = Math.min(Math.max(index, 0), Math.max(cards.length - 1, 0));
    cards.forEach((card, cardIndex) =>
      card.classList.toggle('is-current', cardIndex === safeIndex),
    );
    dots.forEach((dot, dotIndex) => {
      if (dotIndex === safeIndex) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
    if (scroll) cards[safeIndex]?.scrollIntoView({ behavior, block: 'nearest', inline: 'center' });
  }

  private renderAdminMenuCards(list: HTMLElement): void {
    const completed = this.contracts.filter(
      (contract) => (this.progress.rankings[contract.id]?.length ?? 0) > 0,
    ).length;
    this.element('#campaign-progress').textContent =
      `${completed} de ${this.contracts.length} concluídos`;

    for (const contract of this.contracts) {
      const unlocked = this.progress.unlockedContracts.includes(contract.id);
      const best = this.progress.rankings[contract.id]?.[0];
      const label = contractLabel(contract);
      const entry = document.createElement('article');
      entry.className = 'contract-entry';
      const button = document.createElement('button');
      button.className = `contract-card is-admin-card${unlocked ? '' : ' is-locked'}${best ? ' is-complete' : ''}`;
      button.setAttribute('aria-label', `Editar fase ${label}`);
      button.innerHTML = `
        <span class="contract-index">${label}</span>
        <span class="contract-copy">
          <span class="contract-title-row">
            <strong>Fase ${label}</strong>
          </span>
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

      const actions = document.createElement('div');
      actions.className = 'contract-admin-actions';
      const remove = document.createElement('button');
      remove.className = 'text-button danger';
      remove.type = 'button';
      remove.innerHTML = `${icon('trash')} Excluir`;
      remove.addEventListener('click', () => this.openAdminConfirmation(contract.id, label));
      actions.append(remove);
      entry.append(actions);
      list.append(entry);
    }
  }

  private renderSnapshot(snapshot: GameSnapshot): void {
    this.snapshot = snapshot;
    this.element('[data-metric="time"] strong').textContent = formatTime(
      snapshot.metrics.elapsedSeconds,
    );
    this.element('[data-metric="losses"] strong').textContent = snapshot.goal
      ? `${snapshot.metrics.lost} / ${snapshot.goal.maxLosses}`
      : `${snapshot.metrics.lost}`;
    const runIcon = this.element('[data-run-icon]');
    const runButton = this.element<HTMLButtonElement>('[data-action="run"]');
    const running = snapshot.status === 'running';
    const runIconName = running ? 'stop' : 'play';
    if (runIcon.dataset.icon !== runIconName) {
      runIcon.innerHTML = icon(runIconName);
      runIcon.dataset.icon = runIconName;
    }
    runButton.classList.toggle('is-stop', running);
    const runAction = running
      ? 'Reiniciar simulação'
      : snapshot.status === 'paused'
        ? 'Continuar simulação'
        : 'Iniciar simulação';
    runButton.setAttribute('aria-label', runAction);
    runButton.title = `${runAction} · Espaço`;
    // Terminal states are restartable through runSimulation, just like the Space shortcut.
    runButton.disabled = false;
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
    if (snapshot.selection.count > 0) {
      this.element('#hotbar')
        .querySelectorAll('.tool-button')
        .forEach((node) => node.classList.remove('is-active'));
    }
    this.renderSelection(
      snapshot.selectedMachine,
      snapshot.selectedObstacle,
      snapshot.selection.count,
    );
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
      button.title = `${copy.name} · Arraste para posicionar`;
      button.innerHTML = `
        <span class="tool-glyph tool-${machine}">${machineThumbnail(machine)}</span>`;
      this.bindPaletteDrag(button, hotbar, machine);
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
      {
        type: 'tracked-conveyor',
        label: 'Esteira física',
        hint: 'Corrente motorizada',
        icon: 'conveyor',
      },
      { type: 'spring', label: 'Trampolim', hint: 'Cenário fixo', icon: 'spring' },
      {
        type: 'obstacle',
        label: 'Bloqueador',
        hint: 'Arraste para redimensionar',
        icon: 'blocker',
      },
      { type: 'star', label: 'Estrela', hint: 'Bônus coletável', icon: 'star' },
    ];
    for (const tool of tools) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tool-button editor-tool-button';
      button.dataset.editorTool = tool.type;
      button.title = `${tool.label} · Arraste para posicionar`;
      button.setAttribute('aria-label', `${tool.label}: ${tool.hint}`);
      button.innerHTML = `<span class="tool-glyph tool-${tool.type}">${
        tool.type === 'obstacle' || tool.type === 'star'
          ? icon(tool.icon)
          : machineThumbnail(tool.type)
      }</span>`;
      this.bindPaletteDrag(button, hotbar, tool.type);
      hotbar.append(button);
    }
  }

  private bindPaletteDrag(
    button: HTMLButtonElement,
    hotbar: HTMLElement,
    type: AdminTool,
  ): void {
    let origin: { x: number; y: number } | undefined;
    let dragging = false;

    const finish = (event: PointerEvent, phase: 'end' | 'cancel'): void => {
      if (!origin) return;
      const wasDragging = dragging;
      origin = undefined;
      dragging = false;
      button.classList.remove('is-active');
      if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      if (!wasDragging) return;
      this.setDragUiOccluded(false);
      appEvents.emit('ui:tool-drag', {
        type,
        phase,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };

    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      origin = { x: event.clientX, y: event.clientY };
      dragging = false;
      button.setPointerCapture(event.pointerId);
      hotbar
        .querySelectorAll('.tool-button')
        .forEach((node) => node.classList.remove('is-active'));
      button.classList.add('is-active');
    });
    button.addEventListener('pointermove', (event) => {
      if (!origin) return;
      if (!dragging && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= 6) {
        dragging = true;
        this.setDragUiOccluded(true);
        appEvents.emit('ui:tool-drag', {
          type,
          phase: 'start',
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }
      if (!dragging) return;
      appEvents.emit('ui:tool-drag', {
        type,
        phase: 'move',
        clientX: event.clientX,
        clientY: event.clientY,
      });
    });
    button.addEventListener('pointerup', (event) => finish(event, 'end'));
    button.addEventListener('pointercancel', (event) => finish(event, 'cancel'));
    button.addEventListener('click', () => button.classList.remove('is-active'));
  }

  private renderSelection(
    machine?: MachineState,
    obstacle?: ObstacleDefinition,
    selectionCount = 0,
  ): void {
    const editing = Boolean(this.editorContract && !this.editorPreviewActive);
    const canManipulate = Boolean(
      selectionCount > 1 ||
      (machine && (editing || !machine.fixed)) ||
      (editing && obstacle) ||
      (editing && selectionCount === 1 && !machine && !obstacle),
    );
    const remove = this.element<HTMLButtonElement>('[data-action="delete"]');
    const copy = this.element<HTMLButtonElement>('[data-action="copy"]');
    const cut = this.element<HTMLButtonElement>('[data-action="cut"]');
    const reverse = this.element<HTMLButtonElement>('[data-action="reverse"]');
    remove.disabled = !canManipulate;
    copy.disabled = !canManipulate;
    cut.disabled = !canManipulate;
    const multiple = selectionCount > 1;
    const canReverse = Boolean(
      !multiple &&
        machine &&
        (machine.type === 'conveyor' || machine.type === 'tracked-conveyor') &&
        (editing || !machine.fixed),
    );
    reverse.classList.toggle('is-hidden', !canReverse);
    reverse.disabled = !canReverse;
    remove.setAttribute(
      'aria-label',
      multiple ? `Excluir ${selectionCount} itens` : 'Excluir item',
    );
    copy.setAttribute('aria-label', multiple ? `Copiar ${selectionCount} itens` : 'Copiar item');
    cut.setAttribute('aria-label', multiple ? `Recortar ${selectionCount} itens` : 'Recortar item');
    remove.title = canManipulate
      ? multiple
        ? `Excluir ${selectionCount} itens · Delete`
        : 'Excluir seleção · Delete'
      : machine?.fixed
        ? 'Esta máquina faz parte do contrato'
        : 'Selecione uma máquina';
    if (multiple) {
      copy.title = `Copiar ${selectionCount} itens · Ctrl+C`;
      cut.title = `Recortar ${selectionCount} itens · Ctrl+X`;
    } else if (obstacle && editing) {
      remove.title = 'Excluir bloqueador · Delete';
      copy.title = 'Copiar bloqueador · Ctrl+C';
      cut.title = 'Recortar bloqueador · Ctrl+X';
    } else {
      copy.title = 'Copiar item · Ctrl+C';
      cut.title = 'Recortar item · Ctrl+X';
    }
    this.element('#selection-dock').classList.toggle('is-hidden', !canManipulate);
    this.root.classList.toggle('has-selection-actions', canManipulate);
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

  private setDragUiOccluded(occluded: boolean): void {
    if (this.dragUiRestoreTimer !== undefined) {
      window.clearTimeout(this.dragUiRestoreTimer);
      this.dragUiRestoreTimer = undefined;
    }

    const shell = this.element('.factory-app');
    if (occluded) {
      shell.classList.add('is-dragging-object');
      return;
    }

    this.dragUiRestoreTimer = window.setTimeout(() => {
      this.dragUiRestoreTimer = undefined;
      shell.classList.remove('is-dragging-object');
    }, DRAG_UI_RESTORE_DELAY_MS);
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
    indicator.querySelector('strong')!.textContent = `${normalizeAngle(payload.angle)}°`;
  }

  private renderResult(payload: {
    contractId: ContractId;
    snapshot: GameSnapshot;
    result?: ContractResult;
    rankingPosition?: number | null;
    isNewRecord?: boolean;
  }): void {
    const { snapshot, result } = payload;
    const success = snapshot.status === 'success';
    const contract =
      this.contracts.find((item) => item.id === payload.contractId) ?? this.editorContract;

    this.resultContractId = payload.contractId;
    this.element('#result-kicker').textContent = success
      ? 'CONTRATO CONCLUÍDO'
      : 'TENTATIVA ENCERRADA';
    this.element('#result-title').textContent = success
      ? contract
        ? `Fase ${contractLabel(contract)}`
        : 'Fluxo estabelecido'
      : 'A linha parou';
    this.element('#result-summary').textContent = success
      ? payload.isNewRecord
        ? 'Novo recorde local. O fluxo encontrou um ritmo excepcional.'
        : 'A meta foi concluída. Tente novamente para subir no ranking.'
      : snapshot.goal && snapshot.metrics.lost > snapshot.goal.maxLosses
        ? 'Muitas caixas foram perdidas. Ajuste os ângulos e tente de novo.'
        : 'O tempo terminou. Encurte o percurso e mantenha o ritmo.';

    this.element('[data-result-score]').textContent = formatScore(result?.score ?? 0);
    this.element('[data-result-ranking]').textContent = success
      ? payload.rankingPosition
        ? `${payload.rankingPosition}º lugar no Top 10 local`
        : snapshot.mode === 'campaign'
          ? 'Resultado fora do Top 10 local'
          : 'Prévia do editor · não salva'
      : 'Tentativa não classificada';
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
    this.element('[data-result="collected-stars"] strong').textContent = String(
      snapshot.metrics.collectedStars,
    );

    const breakdown = this.element('#score-breakdown');
    breakdown.classList.toggle('is-hidden', !success || !result);
    if (result) {
      this.element('[data-score-part="deliveries"]').textContent =
        `+${formatScore(result.breakdown.deliveryPoints)}`;
      this.element('[data-score-part="time"]').textContent =
        `+${formatScore(result.breakdown.timeBonus)}`;
      this.element('[data-score-part="efficiency"]').textContent =
        `+${formatScore(result.breakdown.efficiencyBonus)}`;
      this.element('[data-score-part="stars"]').textContent =
        `+${formatScore(result.breakdown.starBonus)}`;
      this.element('[data-score-part="losses"]').textContent =
        `−${formatScore(result.breakdown.lossPenalty)}`;
    }

    const next = this.element<HTMLButtonElement>('[data-action="next"]');
    const nextContract = contract
      ? this.contracts.find(
          (candidate) =>
            candidate.world === contract.world && candidate.stage === contract.stage + 1,
        )
      : undefined;
    next.classList.toggle(
      'is-hidden',
      !success ||
        snapshot.mode !== 'campaign' ||
        !nextContract ||
        !this.progress.unlockedContracts.includes(nextContract.id),
    );
    this.closePauseMenu();
    this.element('#result-modal').classList.remove('is-hidden');
    this.updateGameUiAvailability();
    window.requestAnimationFrame(() =>
      this.root
        .querySelector<HTMLButtonElement>('#result-modal [data-action="replay"]')
        ?.focus({ preventScroll: true }),
    );
    if (success) this.audio.play('win');
  }

  private setAdminEnabled(enabled: boolean): void {
    if (!this.adminAvailable) return;
    this.adminEnabled = enabled;
    if (enabled) this.setMenuView('play');
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
    this.element('#editor-contract-title').textContent = `Fase ${contractLabel(contract)}`;
    const dirtyState = this.element('#editor-dirty-state');
    const savingEditor = this.catalogSaving && this.catalogSavingContext === 'editor';
    dirtyState.textContent = savingEditor
      ? 'Salvando no JSON…'
      : this.editorDirty
        ? this.editorIsNew
          ? 'Nova fase · não salva'
          : 'Alterações não salvas'
        : 'Salva no JSON local';
    dirtyState.classList.toggle('is-dirty', this.editorDirty);
    dirtyState.classList.toggle('is-saving', savingEditor);
    const saveButton = this.element<HTMLButtonElement>('[data-action="editor-save"]');
    saveButton.disabled = this.catalogSaving || !this.editorDirty;
    saveButton.querySelector('span')!.textContent = savingEditor ? 'Salvando…' : 'Salvar';

    const form = this.element<HTMLFormElement>('#editor-contract-form');
    if (!form.contains(document.activeElement)) this.populateEditorForm(contract);
  }

  private populateEditorForm(contract: ContractDefinition): void {
    const form = this.element<HTMLFormElement>('#editor-contract-form');
    setFormControlValue(form, 'world', contract.world);
    setFormControlValue(form, 'stage', contract.stage);
    setFormControlValue(form, 'deliveries', contract.goal.deliveries);
    setFormControlValue(form, 'maxLosses', contract.goal.maxLosses);
    setFormControlValue(form, 'pieceBudget', contract.goal.pieceBudget);
    setFormControlValue(form, 'timeLimitSeconds', contract.goal.timeLimitSeconds ?? '');
    setFormControlValue(form, 'idealTimeSeconds', contract.goal.idealTimeSeconds ?? '');
    setFormControlValue(form, 'spawnIntervalSeconds', contract.spawnIntervalSeconds);
    this.updateEditorFormOutputs(contract);
    setFormControlChecked(
      form,
      'availableTrackedConveyor',
      contract.availableMachines.includes('tracked-conveyor') ||
        contract.availableMachines.includes('conveyor'),
    );
    setFormControlChecked(form, 'availableSpring', contract.availableMachines.includes('spring'));
  }

  private handleEditorFormInput(): void {
    if (!this.editorContract || this.catalogSaving) return;
    const form = this.element<HTMLFormElement>('#editor-contract-form');
    const availableMachines: MachineType[] = [];
    if (formCheckbox(form, 'availableTrackedConveyor').checked) {
      availableMachines.push('tracked-conveyor');
    }
    if (formCheckbox(form, 'availableSpring').checked) availableMachines.push('spring');
    const world = Math.round(numberFormValue(form, 'world'));
    const stage = Math.round(numberFormValue(form, 'stage'));
    const label = `${stage}-${world}`;
    const contract: ContractDefinition = {
      ...this.editorContract,
      world,
      stage: stage as ContractDefinition['stage'],
      order: (world - 1) * 10 + stage,
      title: label,
      availableMachines,
      goal: {
        ...this.editorContract.goal,
        deliveries: numberFormValue(form, 'deliveries'),
        maxLosses: numberFormValue(form, 'maxLosses'),
        pieceBudget: numberFormValue(form, 'pieceBudget'),
        timeLimitSeconds: optionalNumberFormValue(form, 'timeLimitSeconds'),
        idealTimeSeconds: optionalNumberFormValue(form, 'idealTimeSeconds'),
      },
      spawnIntervalSeconds: numberFormValue(form, 'spawnIntervalSeconds'),
    };
    this.editorContract = contract;
    this.editorDirty = true;
    this.clearEditorMessage();
    this.element('#editor-contract-title').textContent = contractLabel(contract);
    this.updateEditorFormOutputs(contract);
    const dirty = this.element('#editor-dirty-state');
    dirty.textContent = this.editorIsNew ? 'Nova fase · não salva' : 'Alterações não salvas';
    dirty.classList.add('is-dirty');
    dirty.classList.remove('is-saving');
    this.element<HTMLButtonElement>('[data-action="editor-save"]').disabled = this.catalogSaving;
    appEvents.emit('ui:editor-update-settings', { contract: structuredClone(contract) });
  }

  private validateEditorSettings(): boolean {
    const contract = this.editorContract;
    if (!contract) return false;
    const form = this.element<HTMLFormElement>('#editor-contract-form');
    const errors: string[] = [];
    if (!CAMPAIGN_WORLDS.some(({ value }) => value === contract.world))
      errors.push('Selecione um mundo válido.');
    if (!Number.isInteger(contract.stage) || contract.stage < 1 || contract.stage > 10)
      errors.push('Selecione uma fase entre 1 e 10.');
    if (
      this.contracts.some(
        (candidate) =>
          candidate.id !== contract.id &&
          candidate.world === contract.world &&
          candidate.stage === contract.stage,
      )
    )
      errors.push(`A fase ${contractLabel(contract)} já está cadastrada.`);
    if (contract.goal.deliveries < 1) errors.push('Entregas deve ser pelo menos 1.');
    if (contract.goal.maxLosses < 0) errors.push('Perdas máximas não pode ser negativa.');
    if (contract.goal.pieceBudget < 0) errors.push('O orçamento não pode ser negativo.');
    if (contract.spawnIntervalSeconds < 0.8 || contract.spawnIntervalSeconds > 10)
      errors.push('O intervalo de geração deve ficar entre 0,80 e 10 segundos.');
    if (contract.goal.timeLimitSeconds !== undefined && contract.goal.timeLimitSeconds <= 0)
      errors.push('O tempo limite deve ser positivo.');
    if (
      contract.goal.timeLimitSeconds !== undefined &&
      !Number.isInteger(contract.goal.timeLimitSeconds)
    )
      errors.push('O tempo limite deve usar segundos inteiros.');
    if (contract.goal.idealTimeSeconds !== undefined && contract.goal.idealTimeSeconds <= 0)
      errors.push('O tempo ideal deve ser positivo.');
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

  private updateEditorFormOutputs(contract: ContractDefinition): void {
    this.element<HTMLOutputElement>('[data-stage-label]').value = contractLabel(contract);
    this.element<HTMLOutputElement>('[data-spawn-interval-output]').value =
      `${contract.spawnIntervalSeconds.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`;
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
    const current = this.contracts.find((contract) => contract.id === this.resultContractId);
    const next = current
      ? this.contracts.find(
          (contract) => contract.world === current.world && contract.stage === current.stage + 1,
        )
      : undefined;
    if (!next || !this.progress.unlockedContracts.includes(next.id)) {
      appEvents.emit('ui:menu', undefined);
      this.showMenu('play');
      return;
    }
    appEvents.emit('ui:start-mode', {
      mode: 'campaign',
      contractId: next.id,
      contract: structuredClone(next),
    });
  }

  private openAdminConfirmation(contractId: ContractId, title: string): void {
    if (this.catalogSaving) return;
    this.pendingAdminAction = { contractId };
    this.element('#admin-confirm-kicker').textContent = 'EXCLUIR FASE';
    this.element('#admin-confirm-title').textContent = `Excluir “${title}”?`;
    this.element('#admin-confirm-copy').textContent =
      'A fase e seu resultado salvo serão removidos do catálogo JSON local. Você poderá recuperá-la pelo histórico do Git.';
    this.element<HTMLButtonElement>('[data-action="admin-confirm-accept"]').textContent = 'Excluir';
    this.element('#admin-confirm-modal').classList.remove('is-hidden');
  }

  private confirmAdminAction(): void {
    const pending = this.pendingAdminAction;
    if (!pending || this.catalogSaving) return;
    this.pendingAdminAction = undefined;
    this.element('#admin-confirm-modal').classList.add('is-hidden');
    appEvents.emit('ui:admin-delete-contract', { contractId: pending.contractId });
  }

  private renderCatalogSavingState(): void {
    const saving = this.catalogSaving;
    const editorSaving = saving && this.catalogSavingContext === 'editor';
    const badge = this.element('#menu-admin-badge');
    badge.textContent = saving ? 'SALVANDO NO JSON…' : 'ADMIN LOCAL';
    badge.classList.toggle('is-saving', saving);

    this.root.classList.toggle('is-catalog-saving', editorSaving);
    this.updateGameUiAvailability();
    this.element('#editor-contract-form')
      .querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
      >('input, textarea, select, button')
      .forEach((control) => {
        control.disabled = editorSaving;
      });
    this.root
      .querySelectorAll<HTMLButtonElement>(
        '[data-action="editor-cancel"], [data-action="editor-configure"], [data-action="editor-test"]',
      )
      .forEach((button) => {
        button.disabled = editorSaving;
      });

    this.element<HTMLButtonElement>('#admin-toggle').disabled = saving;
    const createButton = this.element<HTMLButtonElement>('#create-contract-button');
    const worldIsFull = this.contracts.filter(({ world }) => world === CAMPAIGN_WORLD).length >= 10;
    createButton.disabled = saving || worldIsFull;
    createButton.title = worldIsFull ? 'O Mundo 1 já possui as dez fases cadastradas.' : '';
    this.root
      .querySelectorAll<HTMLButtonElement>('.contract-admin-actions button')
      .forEach((button) => {
        button.disabled = saving;
      });
    this.element<HTMLButtonElement>('[data-action="admin-confirm-accept"]').disabled = saving;
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
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="mute"]').forEach((button) => {
      button.setAttribute('aria-label', muted ? 'Ativar som' : 'Silenciar');
      button.setAttribute('aria-pressed', String(!muted));
      button.querySelector<HTMLElement>('[data-sound-icon]')!.innerHTML = icon(
        muted ? 'muted' : 'sound',
      );
      button.classList.toggle('is-muted', muted);
    });
    this.root.querySelectorAll<HTMLElement>('[data-sound-state]').forEach((state) => {
      state.textContent = muted ? 'Desligado' : 'Ligado';
    });
    this.root.querySelectorAll<HTMLElement>('[data-sound-description]').forEach((description) => {
      description.textContent = muted ? 'Efeitos sonoros desligados' : 'Efeitos sonoros ligados';
    });
    const volumeValue = Math.round(this.audio.currentVolume * 100);
    this.root.querySelectorAll<HTMLInputElement>('[data-volume]').forEach((volume) => {
      volume.value = String(volumeValue);
    });
    this.root.querySelectorAll<HTMLOutputElement>('[data-volume-output]').forEach((output) => {
      output.value = `${volumeValue}%`;
    });
  }

  private updateGameUiAvailability(): void {
    const gameUi = this.element('#game-ui');
    const menuOpen = !this.element('#menu-screen').classList.contains('is-hidden');
    const editorSaving = this.catalogSaving && this.catalogSavingContext === 'editor';
    const resultOpen = !this.element('#result-modal').classList.contains('is-hidden');
    const blocked = !this.gameReady || editorSaving || menuOpen || resultOpen;
    gameUi.toggleAttribute('inert', blocked);
    this.element(`#${this.gameContainerId}`).toggleAttribute('inert', blocked);
    gameUi.setAttribute('aria-hidden', String(menuOpen));
    gameUi.setAttribute('aria-busy', String(!this.gameReady || editorSaving));
  }

  private updateFullscreenControls(): void {
    const fullscreen = Boolean(document.fullscreenElement);
    const title = fullscreen ? 'Modo janela' : 'Tela cheia';
    const description = fullscreen ? 'Restaurar visualização' : 'Expandir visualização';
    const action = fullscreen ? 'Sair da tela cheia' : 'Entrar em tela cheia';
    const state = fullscreen ? 'Restaurar' : 'Ativar';

    this.root
      .querySelectorAll<HTMLButtonElement>('[data-action="fullscreen"]')
      .forEach((button) => {
        button.setAttribute('aria-label', action);
        button.setAttribute('aria-pressed', String(fullscreen));
        button.title = title;
        button.classList.toggle('is-active', fullscreen);
        const iconNode = button.querySelector<HTMLElement>('[data-fullscreen-icon]');
        if (iconNode) iconNode.innerHTML = icon(fullscreen ? 'windowed' : 'fullscreen');
      });
    this.root.querySelectorAll<HTMLElement>('[data-fullscreen-title]').forEach((node) => {
      node.textContent = title;
    });
    this.root.querySelectorAll<HTMLElement>('[data-fullscreen-description]').forEach((node) => {
      node.textContent = description;
    });
    this.root.querySelectorAll<HTMLElement>('[data-fullscreen-state]').forEach((node) => {
      node.textContent = state;
    });
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

function formatScore(score: number): string {
  return Math.max(0, Math.round(score)).toLocaleString('pt-BR');
}

function formatRankingDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Data indisponível';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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

function formControl(
  form: HTMLFormElement,
  name: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const control = form.elements.namedItem(name);
  if (
    !(control instanceof HTMLInputElement) &&
    !(control instanceof HTMLTextAreaElement) &&
    !(control instanceof HTMLSelectElement)
  )
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

function contractStagePreview(contract: ContractDefinition): string {
  const sourceCount = contract.fixedMachines.filter(({ type }) => type === 'source').length;
  const hasSpring = contract.availableMachines.includes('spring');
  const layout = Math.min(Math.max(contract.order, 1), 3);
  return `<span class="stage-preview-layout stage-preview-layout-${layout}">
    <span class="stage-preview-machine stage-preview-source">${machineThumbnail('source')}</span>
    ${sourceCount > 1 ? `<span class="stage-preview-machine stage-preview-source-secondary">${machineThumbnail('source')}</span>` : ''}
    <span class="stage-preview-machine stage-preview-conveyor stage-preview-conveyor-a">${machineThumbnail('tracked-conveyor')}</span>
    <span class="stage-preview-machine stage-preview-conveyor stage-preview-conveyor-b">${machineThumbnail('tracked-conveyor')}</span>
    ${hasSpring ? `<span class="stage-preview-machine stage-preview-spring">${machineThumbnail('spring')}</span>` : ''}
    ${contract.obstacles.length > 0 ? '<span class="stage-preview-obstacle"></span>' : ''}
    <span class="stage-preview-machine stage-preview-receiver">${machineThumbnail('receiver')}</span>
    <span class="stage-preview-box"><img src="${factoryBoxTextureUrl}" alt="" draggable="false" /></span>
  </span>`;
}

function machineThumbnail(type: MachineType): string {
  switch (type) {
    case 'source':
      return `<svg class="machine-thumbnail machine-thumbnail-source" viewBox="0 0 72 72" aria-hidden="true">
        <rect x="2" y="2" width="68" height="68" rx="5" fill="#202a33" stroke="#5f6a72" stroke-width="2" />
        <path d="M32.5 12h7v18l5.5-5.5 5 5L36 44 22 29.5l5-5 5.5 5.5z" fill="#fff" />
        <rect x="21" y="55" width="30" height="11" rx="3" fill="#ff7629" />
      </svg>`;
    case 'conveyor':
      return `<svg class="machine-thumbnail machine-thumbnail-conveyor" viewBox="0 0 96 24" aria-hidden="true">
        <rect x="1" y="1" width="94" height="22" fill="#40566b" stroke="#293139" stroke-width="2" />
        <path d="M17 5l10 7-10 7zM39 5l10 7-10 7zM61 5l10 7-10 7zM83 5l10 7-10 7z" fill="#fff" />
      </svg>`;
    case 'tracked-conveyor':
      return `<svg class="machine-thumbnail machine-thumbnail-tracked-conveyor" viewBox="0 0 112 36" aria-hidden="true">
        <g fill="#40566b" stroke="#82a5c5" stroke-width="1.5">
          <circle cx="18" cy="18" r="9"/><circle cx="56" cy="18" r="9"/><circle cx="94" cy="18" r="9"/>
        </g>
        <g stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".8">
          <path d="M18 11v14M11 18h14M56 11v14M49 18h14M94 11v14M87 18h14" />
        </g>
        <g fill="#ff7629"><circle cx="18" cy="18" r="2.4"/><circle cx="56" cy="18" r="2.4"/><circle cx="94" cy="18" r="2.4"/></g>
        <path d="M18 4h76a14 14 0 0 1 0 28H18a14 14 0 0 1 0-28Z" fill="none" stroke="#293139" stroke-width="9" stroke-linejoin="round" />
        <path d="M18 4h76a14 14 0 0 1 0 28H18a14 14 0 0 1 0-28Z" fill="none" stroke="#40566b" stroke-width="6.5" stroke-linejoin="round" />
        <path d="M18 4h76a14 14 0 0 1 0 28H18a14 14 0 0 1 0-28Z" fill="none" stroke="#fff" stroke-width="6.5" stroke-dasharray="8 7" stroke-linejoin="round" />
      </svg>`;
    case 'receiver':
      return `<svg class="machine-thumbnail machine-thumbnail-receiver" viewBox="0 0 72 72" aria-hidden="true">
        <rect x="2" y="2" width="68" height="68" rx="6" fill="#fff" stroke="#258bc4" stroke-width="2" />
        <path d="M8 8h13L8 21zM64 8H51l13 13zM8 64h13L8 51zM64 64H51l13-13z" fill="#ff7629" />
        <rect x="7" y="20" width="58" height="32" rx="6" fill="#e4e7e9" />
        <rect x="10" y="23" width="52" height="26" rx="4" fill="#202a33" stroke="#5f6a72" />
        <text x="36" y="43" text-anchor="middle" fill="#d95050" font-family="monospace" font-size="20">0</text>
      </svg>`;
    case 'spring':
      return `<svg class="machine-thumbnail machine-thumbnail-spring" viewBox="0 0 48 24" aria-hidden="true">
        <rect x="1" y="2" width="46" height="7" fill="#b47a48" />
        <path d="M8 17l5-8 5 8 5-8 5 8 5-8 7 8" fill="none" stroke="#43a96b" stroke-width="4" stroke-linejoin="round" />
        <rect x="1" y="16" width="46" height="7" fill="#b47a48" />
      </svg>`;
  }
}

function icon(name: IconName): string {
  const paths: Record<IconName, string> = {
    source: '<path d="M4 5h16v14H4z"/><path d="M8 9h8M12 2v7m-3-3 3 3 3-3"/>',
    conveyor:
      '<rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="7" cy="12" r="1.5"/><circle cx="17" cy="12" r="1.5"/><path d="m10 9 3 3-3 3"/>',
    'tracked-conveyor':
      '<rect x="2" y="6" width="20" height="12" rx="6"/><circle cx="6" cy="12" r="3"/><circle cx="12" cy="12" r="3"/><circle cx="18" cy="12" r="3"/>',
    receiver: '<path d="M4 5h16v14H4z"/><path d="M8 15h8M12 2v8m-3-3 3 3 3-3"/>',
    spring: '<path d="M3 7h18M5 5v4m14-4v4M6 18l3-7 3 7 3-7 3 7"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    reset: '<path d="M4.8 8A8 8 0 1 1 4 14"/><path d="M4 4v5h5"/>',
    undo: '<path d="m9 7-5 5 5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/>',
    redo: '<path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/>',
    copy: '<rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M5 16V5a1 1 0 0 1 1-1h10"/>',
    cut: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="m8 8 12 12M8 16 20 4M14.5 14.5 20 20"/>',
    trash: '<path d="M4 7h16M9 3h6l1 4H8zM7 7l1 14h8l1-14M10 11v6m4-6v6"/>',
    reverse: '<path d="M7 7h11l-3-3m3 3-3 3M17 17H6l3 3m-3-3 3-3"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    sound: '<path d="M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10"/>',
    muted: '<path d="M4 10v4h4l5 4V6L8 10zM17 10l4 4m0-4-4 4"/>',
    fullscreen: '<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/>',
    windowed: '<path d="M9 4v5H4m11-5v5h5M9 20v-5H4m11 5v-5h5"/>',
    back: '<path d="M20 12H4m7-7-7 7 7 7"/>',
    mouse: '<rect x="7" y="2.5" width="10" height="19" rx="5"/><path d="M12 2.5v7M7 9.5h10"/>',
    keyboard:
      '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M5 8h1m2 0h1m2 0h1m2 0h1m2 0h2M5 11h1m2 0h1m2 0h1m2 0h1m2 0h2M5 14h3m2 0h8"/>',
    grid: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M9.33 4v16M14.67 4v16M4 9.33h16M4 14.67h16"/>',
    clear: '<path d="m4 15 8-8 6 6-8 8H4z"/><path d="m13.5 8.5 2-2 3 3-2 2M4 21h16"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    star: '<path d="m12 2 3 6 7 .9-5 4.8 1.3 6.8L12 17.3l-6.3 3.2L7 13.7 2 8.9 9 8z"/>',
    ranking:
      '<path d="M8 21V10h8v11M5 21h14M9 4h6l-1 4h-4z"/><path d="M8 5H5a3 3 0 0 0 3 4m8-4h3a3 3 0 0 1-3 4"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4M4 20h16"/>',
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
