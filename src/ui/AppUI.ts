import { appEvents } from '../core/events';
import { updateCampaignLayout } from '../domain/progress';
import factoryBoxTextureUrl from '../assets/factory-box-game.png?url';
import factoryCampaignEnvironmentUrl from '../assets/factory-campaign-environment.webp?url';
import { DEFAULT_MACHINE_COSTS } from '../domain/catalog';
import { resolveConveyorSpeedCosts } from '../domain/economy';
import type {
  ContractDefinition,
  ContractId,
  ConveyorSpeed,
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
  | 'pause'
  | 'stop'
  | 'check'
  | 'warning'
  | 'home'
  | 'map'
  | 'replay'
  | 'arrow-right'
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
  | 'hitbox'
  | 'clear'
  | 'lock'
  | 'star'
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
  'turbo-spring': { name: 'Trampolim turbo', hint: 'Projeta caixas com força dupla' },
};

const SIMULATION_SPEEDS = [0.1, 0.2, 0.5, 1, 2, 3, 5] as const;
const CONVEYOR_SPEEDS: readonly ConveyorSpeed[] = ['slow', 'normal', 'fast'];
const CONVEYOR_SPEED_LABELS: Record<ConveyorSpeed, string> = {
  slow: 'Devagar',
  normal: 'Normal',
  fast: 'Rápido',
};
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
  private editorHitboxesVisible = false;
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
  private optionsOpenedFromPause = false;

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
    this.editorHitboxesVisible = false;
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
    this.editorHitboxesVisible = false;
    appEvents.emit('ui:editor-hitboxes', { enabled: false });
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
                ${icon('back')}
              </button>
            </div>

            <div id="budget-meter" class="budget-meter is-hidden" role="status" aria-live="polite">
              <strong data-budget-spent>$0</strong>
              <div
                class="budget-track"
                data-budget-track
                role="progressbar"
                aria-label="Orçamento utilizado"
                aria-valuemin="0"
                aria-valuenow="0"
              >
                <span class="budget-fill" data-budget-fill></span>
              </div>
              <span data-budget-limit>$0</span>
            </div>

            <div class="top-right-controls">
              <div class="simulation-controls" aria-label="Controles da simulação">
                <button class="simulation-pause is-hidden" data-action="pause-toggle" type="button" aria-label="Pausar simulação" title="Pausar · Espaço">
                  <span data-pause-icon data-icon="pause">${icon('pause')}</span>
                </button>
                <label class="speed-control" title="Velocidade da simulação">
                  <span class="speed-track-shell">
                    <span class="speed-track-visual" aria-hidden="true"></span>
                    <input data-speed type="range" min="0" max="6" step="1" value="3" aria-label="Velocidade da simulação" aria-valuetext="1×" />
                    <output class="speed-readout" data-speed-label>1×</output>
                  </span>
                </label>
                <button class="simulation-play" data-action="run" type="button" aria-label="Iniciar simulação" title="Iniciar · Espaço">
                  <span data-run-icon data-icon="play">${icon('play')}</span>
                </button>
              </div>
            </div>
          </header>

          <header id="editor-rail" class="editor-rail is-hidden" aria-label="Editor de fase">
            <div class="editor-heading">
              <button class="icon-button editor-back-button" data-action="editor-cancel" type="button" aria-label="Voltar para a seleção de fases" title="Voltar para a seleção de fases">
                ${icon('back')}
              </button>
              <span class="admin-badge">ADMIN LOCAL</span>
              <div class="editor-title-block">
                <strong id="editor-contract-title">Nova fase</strong>
                <span id="editor-dirty-state" class="editor-dirty-state">Sem alterações</span>
              </div>
            </div>
            <div class="editor-actions">
              <button class="soft-button" data-action="editor-hitboxes" type="button" aria-pressed="false" title="Visualizar colisões e áreas de coleta">
                ${icon('hitbox')} <span>Hitboxes</span>
              </button>
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
          <aside id="conveyor-speed-control" class="conveyor-speed-popover glass-panel is-hidden" aria-label="Velocidade da esteira selecionada">
            <span>VELOCIDADE</span>
            <div class="conveyor-speed-toggle" role="radiogroup" aria-label="Velocidade da esteira">
              <button class="conveyor-speed-option" data-action="conveyor-speed-slow" data-conveyor-speed-option="slow" type="button" role="radio" aria-label="Velocidade 1" aria-checked="false">1</button>
              <button class="conveyor-speed-option" data-action="conveyor-speed-normal" data-conveyor-speed-option="normal" type="button" role="radio" aria-label="Velocidade 2" aria-checked="true">2</button>
              <button class="conveyor-speed-option" data-action="conveyor-speed-fast" data-conveyor-speed-option="fast" type="button" role="radio" aria-label="Velocidade 3" aria-checked="false">3</button>
            </div>
          </aside>
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
                <label class="check-field objective-losses-toggle"><input name="lossesEnabled" type="checkbox" /><span>Limitar perdas</span></label>
                <label class="field field-wide optional-setting-field" data-losses-setting><span>Perdas máximas</span><input name="maxLosses" type="number" min="0" step="1" inputmode="numeric" /></label>
                <p class="field-note field-wide">Todas as estrelas posicionadas no mapa fazem parte da meta.</p>
              </fieldset>
              <fieldset class="field-group economy-fields">
                <legend>Orçamento</legend>
                <label class="check-field field-wide"><input name="budgetEnabled" type="checkbox" /><span>Limitar orçamento da fase</span></label>
                <label class="field field-wide optional-setting-field" data-budget-setting><span>Orçamento máximo (US$)</span><input name="budgetLimit" type="number" min="0" step="1" inputmode="numeric" placeholder="Sem limite" /></label>
                <label class="field"><span>Esteira · velocidade 1 (US$) *</span><input name="conveyorSlowCost" type="number" min="0" step="1" inputmode="numeric" required /></label>
                <label class="field"><span>Esteira · velocidade 2 (US$) *</span><input name="conveyorNormalCost" type="number" min="0" step="1" inputmode="numeric" required /></label>
                <label class="field"><span>Esteira · velocidade 3 (US$) *</span><input name="conveyorFastCost" type="number" min="0" step="1" inputmode="numeric" required /></label>
                <label class="field"><span>Custo do trampolim (US$) *</span><input name="springCost" type="number" min="0" step="1" inputmode="numeric" required /></label>
                <label class="field"><span>Custo do trampolim turbo (US$) *</span><input name="turboSpringCost" type="number" min="0" step="1" inputmode="numeric" required /></label>
                <p class="field-note field-wide">Sem orçamento máximo, o jogador pode gastar sem limite e o medidor fica oculto.</p>
              </fieldset>
              <fieldset class="field-group">
                <legend>Ritmo</legend>
                <label class="field field-wide spawn-interval-field">
                  <span>Intervalo de geração <output data-spawn-interval-output>1,25 s</output></span>
                  <input name="spawnIntervalSeconds" type="range" min="0.8" max="10" step="0.05" value="1.25" required />
                </label>
              </fieldset>
              <fieldset class="field-group tool-availability">
                <legend>Ferramentas do jogador</legend>
                <label class="check-field"><input name="availableTrackedConveyor" type="checkbox" /><span>${icon('conveyor')} Esteira física</span></label>
                <label class="check-field"><input name="availableSpring" type="checkbox" /><span>${icon('spring')} Trampolim</span></label>
                <label class="check-field"><input name="availableTurboSpring" type="checkbox" /><span>${icon('turbo-spring')} Trampolim turbo</span></label>
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
                      <button class="main-menu-action campaign-stage-play" data-action="campaign-play" type="button">Jogar</button>
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
                          <span><strong>Modo livre</strong><small>Todos os módulos, sem limite de orçamento.</small></span>
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

        <section id="pause-modal" class="modal-layer pause-layer is-hidden" role="dialog" aria-modal="true" aria-label="Menu de pausa">
          <div class="modal-scrim"></div>
          <div class="pause-card">
            <nav class="pause-menu-actions" aria-label="Navegação da pausa">
              <button class="main-menu-action pause-menu-action pause-continue-action" data-action="close-pause-menu" type="button">
                Continuar
              </button>
              <button class="main-menu-action pause-menu-action" data-action="pause-options" type="button">
                Opções
              </button>
              <button class="main-menu-action pause-menu-action" data-action="pause-campaign" type="button">
                Sair para a campanha
              </button>
              <button class="main-menu-action pause-menu-action" data-action="pause-home" type="button">
                Menu principal
              </button>
            </nav>
            <div class="pause-quick-actions" aria-label="Atalhos da pausa">
              <button class="pause-quick-action sound-button" data-action="mute" type="button" aria-label="Silenciar" aria-pressed="false">
                <span class="pause-quick-icon" data-sound-icon>${icon(this.progress.settings.muted ? 'muted' : 'sound')}</span>
                <span class="pause-quick-copy">
                  <strong>Áudio</strong>
                  <small data-sound-state>Ligado</small>
                </span>
              </button>
              <button class="pause-quick-action" data-action="fullscreen" type="button" aria-label="Entrar em tela cheia" aria-pressed="false">
                <span class="pause-quick-icon" data-fullscreen-icon>${icon('fullscreen')}</span>
                <span class="pause-quick-copy">
                  <strong data-fullscreen-title>Tela cheia</strong>
                  <small data-fullscreen-state>Ativar</small>
                </span>
              </button>
            </div>
          </div>
        </section>

        <section id="result-modal" class="modal-layer result-layer is-hidden" role="dialog" aria-modal="true" aria-labelledby="result-title">
          <div class="modal-scrim"></div>
          <div class="result-card">
            <header class="result-heading">
              <span id="result-kicker">FASE</span>
              <h2 id="result-title">Contrato concluído</h2>
              <p id="result-summary">As metas de entregas e os serviços foram concluídos.</p>
            </header>
            <div class="result-metrics">
              ${resultMetric('Entregas', '0 / 0', 'delivered', 'deliveries')}
              ${resultMetric('Estrelas', '0 / 0', 'collected-stars', 'stars')}
              ${resultMetric('Orçamento', '$0 / Sem limite', 'budget', 'budget')}
              ${resultMetric('Perdas', '0', 'lost', 'losses', true)}
            </div>
            <nav class="result-actions" aria-label="Ações do contrato">
              <button class="main-menu-action result-menu-action" data-action="result-menu" type="button">
                <span>Menu</span>
              </button>
              <button class="main-menu-action result-menu-action" data-action="replay" type="button">
                <span>Repetir</span>
              </button>
              <button class="main-menu-action result-menu-action result-menu-action-primary" data-action="next" type="button">
                <span>Próximo contrato</span>
              </button>
            </nav>
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
    this.element('#conveyor-speed-control').addEventListener(
      'pointerdown',
      (event) => event.stopPropagation(),
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
    window.addEventListener('pagehide', () => this.persistProgress(), {
      signal: this.domEvents.signal,
    });
    document.addEventListener('fullscreenchange', () => this.updateFullscreenControls(), {
      signal: this.domEvents.signal,
    });

    this.root.addEventListener(
      'keydown',
      (event) => {
        const resultModal = this.element('#result-modal');
        const activeModal = !resultModal.classList.contains('is-hidden') ? resultModal : undefined;
        if (!activeModal) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          this.handleAction('result-menu');
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
        this.renderResult({ contractId, snapshot });
      }),
      appEvents.on('game:completion-recorded', ({ contractId, snapshot }) => {
        const contract = this.contracts.find(({ id }) => id === contractId);
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
          contractId,
          snapshot,
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
      appEvents.on('game:campaign-changed', ({ contractId, contractRevision, machines }) => {
        this.progress = updateCampaignLayout(this.progress, contractId, contractRevision, machines);
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
        if (this.optionsOpenedFromPause) this.returnToPauseMenuFromOptions();
        else this.setMenuView('home');
        break;
      case 'campaign-play':
        this.startSelectedCampaign();
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
      case 'pause-options':
        this.openPauseOptions();
        break;
      case 'pause-campaign':
        this.leaveSimulationToMenu('play');
        break;
      case 'pause-home':
        this.leaveSimulationToMenu('home');
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
        if (this.snapshot?.status === 'running' || this.snapshot?.status === 'paused') {
          appEvents.emit('ui:reset', undefined);
        } else appEvents.emit('ui:run', undefined);
        break;
      case 'pause-toggle':
        if (this.snapshot?.status === 'running') appEvents.emit('ui:pause', undefined);
        else if (this.snapshot?.status === 'paused') appEvents.emit('ui:run', undefined);
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
      case 'conveyor-speed-slow':
      case 'conveyor-speed-normal':
      case 'conveyor-speed-fast': {
        const speed = action.replace('conveyor-speed-', '') as ConveyorSpeed;
        this.renderConveyorSpeed(speed);
        appEvents.emit('ui:set-conveyor-speed', { speed });
        break;
      }
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
      case 'editor-hitboxes':
        this.toggleEditorHitboxes();
        break;
      case 'editor-test':
        if (this.catalogSaving) break;
        if (this.editorContract && this.validateEditorSettings()) {
          this.setEditorMessage({ tone: 'neutral', message: 'Validando e salvando no JSON…' });
          appEvents.emit('ui:editor-test', {
            contract: structuredClone(this.editorContract),
          });
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
    window.requestAnimationFrame(() =>
      this.root
        .querySelector<HTMLButtonElement>('#pause-modal [data-action="close-pause-menu"]')
        ?.focus({ preventScroll: true }),
    );
  }

  private closePauseMenu(): void {
    this.element('#pause-modal').classList.add('is-hidden');
    if (this.snapshot?.status === 'paused') appEvents.emit('ui:run', undefined);
  }

  private openPauseOptions(): void {
    if (this.optionsOpenedFromPause) return;
    this.persistProgress();
    if (this.snapshot?.status === 'running') appEvents.emit('ui:pause', undefined);
    this.element('#pause-modal').classList.add('is-hidden');
    const menu = this.element('#menu-screen');
    const previousView = (menu.dataset.menuView as MenuView | undefined) ?? 'home';

    this.cancelMenuTransition();
    this.menuDemo?.setActive(false);
    this.optionsOpenedFromPause = true;
    menu.classList.add('is-pause-options-direct');
    menu.classList.remove('is-hidden');
    menu.removeAttribute('inert');
    menu.dataset.menuView = 'options';
    delete menu.dataset.menuTransitioning;
    this.root.classList.add('is-menu-open');
    this.setOptionsCategory('audio-video');
    this.updateMenuPanels('options', false);
    this.updateGameUiAvailability();
    window.requestAnimationFrame(() => this.focusMenuView('options', previousView));
  }

  private returnToPauseMenuFromOptions(): void {
    if (!this.optionsOpenedFromPause) return;
    const menu = this.element('#menu-screen');
    this.optionsOpenedFromPause = false;
    this.hideMenu();
    menu.dataset.menuView = 'home';
    this.updateMenuPanels('home', false);
    this.openPauseMenu();
    window.requestAnimationFrame(() => menu.classList.remove('is-pause-options-direct'));
  }

  private leaveSimulationToMenu(view: MenuView): void {
    this.persistProgress();
    appEvents.emit('ui:menu', undefined);
    this.showMenu(view);
  }

  private persistProgress(): void {
    this.onProgressChange?.(this.progress);
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
    const completed = this.contracts.filter((contract) =>
      isContractCompleted(this.progress, contract),
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
      const isCompleted = isContractCompleted(this.progress, contract);
      const label = contractLabel(contract);
      const button = document.createElement('button');
      button.className = `contract-card stage-contract-card${unlocked ? '' : ' is-locked'}${isCompleted ? ' is-complete' : ''}`;
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
            <span class="contract-title-row"><strong>${label}</strong></span>
            <span class="contract-tags">
              <i>${contract.goal.deliveries} caixas</i>
              <i>${contract.collectibles.length} estrelas</i>
              <i>${formatBudgetLabel(contract.economy.budgetLimit)}</i>
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
            machines: structuredClone(this.progress.campaignLayouts[contract.id]?.machines ?? []),
          });
        });
      }
      list.append(button);

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `contract-dot${unlocked ? '' : ' is-locked'}${isCompleted ? ' is-complete' : ''}`;
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
        (contract) => !isContractCompleted(this.progress, contract),
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
      const completed = Boolean(contract && isContractCompleted(this.progress, contract));
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
      machines: structuredClone(this.progress.campaignLayouts[contract.id]?.machines ?? []),
    });
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
    const completed = this.contracts.filter((contract) =>
      isContractCompleted(this.progress, contract),
    ).length;
    this.element('#campaign-progress').textContent =
      `${completed} de ${this.contracts.length} concluídos`;

    for (const contract of this.contracts) {
      const unlocked = this.progress.unlockedContracts.includes(contract.id);
      const completedContract = isContractCompleted(this.progress, contract);
      const label = contractLabel(contract);
      const entry = document.createElement('article');
      entry.className = 'contract-entry';
      const button = document.createElement('button');
      button.className = `contract-card is-admin-card${unlocked ? '' : ' is-locked'}${completedContract ? ' is-complete' : ''}`;
      button.setAttribute('aria-label', `Editar fase ${label}`);
      button.innerHTML = `
        <span class="contract-index">${label}</span>
        <span class="contract-copy">
          <span class="contract-title-row">
            <strong>Fase ${label}</strong>
          </span>
          <span class="contract-tags">
            <i>${contract.goal.deliveries} caixas</i>
            <i>${contract.collectibles.length} estrelas</i>
            <i>${formatBudgetLabel(contract.economy.budgetLimit)}</i>
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
    this.renderBudgetMeter(snapshot.economy);
    const runIcon = this.element('[data-run-icon]');
    const runButton = this.element<HTMLButtonElement>('[data-action="run"]');
    const running = snapshot.status === 'running';
    const paused = snapshot.status === 'paused';
    const active = running || paused;
    const runIconName = active ? 'stop' : 'play';
    if (runIcon.dataset.icon !== runIconName) {
      runIcon.innerHTML = icon(runIconName);
      runIcon.dataset.icon = runIconName;
    }
    runButton.classList.toggle('is-stop', active);
    const runAction = active ? 'Parar simulação' : 'Iniciar simulação';
    runButton.setAttribute('aria-label', runAction);
    runButton.title = active ? runAction : `${runAction} · Espaço`;
    // Terminal states are restartable through runSimulation, just like the Space shortcut.
    runButton.disabled = false;

    const pauseButton = this.element<HTMLButtonElement>('[data-action="pause-toggle"]');
    const pauseIcon = this.element('[data-pause-icon]');
    const pauseIconName = paused ? 'play' : 'pause';
    if (pauseIcon.dataset.icon !== pauseIconName) {
      pauseIcon.innerHTML = icon(pauseIconName);
      pauseIcon.dataset.icon = pauseIconName;
    }
    pauseButton.classList.toggle('is-hidden', !active);
    pauseButton.classList.toggle('is-resume', paused);
    const pauseAction = paused ? 'Retomar simulação' : 'Pausar simulação';
    pauseButton.setAttribute('aria-label', pauseAction);
    pauseButton.title = `${pauseAction} · Espaço`;
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
    else this.renderHotbar(snapshot.availableMachines, snapshot.economy);
    if (snapshot.selection.count > 0) {
      this.element('#hotbar')
        .querySelectorAll('.tool-button')
        .forEach((node) => node.classList.remove('is-active'));
    }
    this.renderSelection(
      snapshot.selectedMachine,
      snapshot.selectedObstacle,
      snapshot.selection.count,
      snapshot.selectedMachineClientBounds,
    );
  }

  private renderBudgetMeter(economy: GameSnapshot['economy']): void {
    const meter = this.element('#budget-meter');
    const limit = economy?.budgetLimit;
    const visible = limit !== undefined;
    meter.classList.toggle('is-hidden', !visible);
    if (!visible || !economy) return;

    const spent = Math.max(0, economy.spent);
    const hardLimit = economy.hardLimit ?? limit * 2;
    const overBudget = limit > 0 && spent > limit;
    const fillRatio = limit > 0 ? (overBudget ? (spent - limit) / limit : spent / limit) : 0;
    const fill = this.element<HTMLElement>('[data-budget-fill]');
    fill.style.setProperty('--budget-fill', `${Math.min(1, Math.max(0, fillRatio)) * 100}%`);
    meter.classList.toggle('is-over-budget', overBudget);
    meter.classList.toggle('is-at-hard-limit', spent >= hardLimit);
    this.element('[data-budget-spent]').textContent = formatCurrency(spent);
    this.element('[data-budget-limit]').textContent = formatCurrency(limit);

    const track = this.element('[data-budget-track]');
    track.setAttribute('aria-valuenow', String(Math.round(spent)));
    track.setAttribute('aria-valuemax', String(Math.round(hardLimit)));
    track.setAttribute(
      'aria-valuetext',
      `${formatCurrency(spent)} gastos de ${formatCurrency(limit)} de orçamento`,
    );
  }

  private renderHotbar(machines: MachineType[], economy: GameSnapshot['economy']): void {
    const hotbar = this.element('#hotbar');
    const wasEditor = hotbar.dataset.mode === 'editor';
    hotbar.dataset.mode = 'player';
    const currentTypes = [...hotbar.querySelectorAll<HTMLElement>('[data-tool]')].map(
      (node) => node.dataset.tool,
    );
    const costSignature = machines.map((machine) => machineCost(economy, machine)).join('|');
    const needsRebuild =
      wasEditor ||
      currentTypes.join('|') !== machines.join('|') ||
      hotbar.dataset.costSignature !== costSignature;

    if (needsRebuild) {
      hotbar.innerHTML = '';
      hotbar.dataset.costSignature = costSignature;
      for (const machine of machines) {
        const copy = MACHINE_COPY[machine];
        const cost = machineCost(economy, machine);
        const tooltipId = `tool-tooltip-${machine}`;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tool-button';
        button.dataset.tool = machine;
        button.setAttribute(
          'aria-label',
          `${copy.name}: ${copy.hint}. Custo ${formatCurrency(cost)}`,
        );
        button.setAttribute('aria-describedby', tooltipId);
        button.innerHTML = `
          <span class="tool-glyph tool-${machine}">${machineThumbnail(machine)}</span>
          ${toolTooltip(tooltipId, copy.name, copy.hint, formatCurrency(cost))}`;
        this.bindPaletteDrag(button, hotbar, machine);
        hotbar.append(button);
      }
    }

    const spent = economy?.spent ?? 0;
    const hardLimit = economy?.hardLimit;
    hotbar.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => {
      const machine = button.dataset.tool as MachineType;
      const cost = machineCost(economy, machine);
      const unavailable = hardLimit !== undefined && spent + cost > hardLimit;
      button.classList.toggle('is-unaffordable', unavailable);
      button.setAttribute('aria-disabled', String(unavailable));
      const tooltip = button.querySelector<HTMLElement>('.tool-tooltip');
      tooltip?.classList.toggle('is-unaffordable', unavailable);
      const status = tooltip?.querySelector<HTMLElement>('[data-tool-status]');
      if (status) {
        status.textContent = unavailable
          ? 'Limite máximo atingido'
          : economy?.budgetLimit === undefined
            ? 'Sem limite'
            : '';
      }
    });
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
        type: 'turbo-spring',
        label: 'Trampolim turbo',
        hint: 'Cenário fixo com força dupla',
        icon: 'turbo-spring',
      },
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
      button.setAttribute('aria-label', `${tool.label}: ${tool.hint}`);
      const tooltipId = `editor-tool-tooltip-${tool.type}`;
      button.setAttribute('aria-describedby', tooltipId);
      button.innerHTML = `<span class="tool-glyph tool-${tool.type}">${
        tool.type === 'obstacle' || tool.type === 'star'
          ? icon(tool.icon)
          : machineThumbnail(tool.type)
      }</span>${toolTooltip(tooltipId, tool.label, tool.hint)}`;
      this.bindPaletteDrag(button, hotbar, tool.type);
      hotbar.append(button);
    }
  }

  private bindPaletteDrag(button: HTMLButtonElement, hotbar: HTMLElement, type: AdminTool): void {
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
      if (event.button !== 0 || button.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault();
      origin = { x: event.clientX, y: event.clientY };
      dragging = false;
      button.setPointerCapture(event.pointerId);
      hotbar.querySelectorAll('.tool-button').forEach((node) => node.classList.remove('is-active'));
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
    machineClientBounds?: GameSnapshot['selectedMachineClientBounds'],
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
    const speedControl = this.element('#conveyor-speed-control');
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
    const showSpeed = Boolean(canReverse && machine && machineClientBounds);
    speedControl.classList.toggle('is-hidden', !showSpeed);
    if (showSpeed && machine && machineClientBounds) {
      this.renderConveyorSpeed(machine.conveyorSpeed ?? 'normal');
      this.positionConveyorSpeed(speedControl, machineClientBounds);
    }
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

  private positionConveyorSpeed(
    control: HTMLElement,
    bounds: NonNullable<GameSnapshot['selectedMachineClientBounds']>,
  ): void {
    const containerBounds = this.element('#game-ui').getBoundingClientRect();
    const safeEdge = 16;
    const verticalGap = 14;
    const rotationClearance = 54;
    const width = control.offsetWidth || 176;
    const height = control.offsetHeight || 72;
    const centeredLeft = (bounds.left + bounds.right) / 2 - containerBounds.left - width / 2;
    const maximumLeft = Math.max(safeEdge, containerBounds.width - width - safeEdge);
    const left = Math.min(Math.max(centeredLeft, safeEdge), maximumLeft);
    const belowTop = bounds.bottom - containerBounds.top + verticalGap;
    const selectionDockBounds = this.element('#selection-dock').getBoundingClientRect();
    const selectionDockTop = selectionDockBounds.top - containerBounds.top;
    const bottomLimit = Math.min(containerBounds.height - 104, selectionDockTop - verticalGap);
    const fitsBelow = belowTop + height <= bottomLimit;
    const aboveTop = bounds.top - containerBounds.top - height - rotationClearance;
    const top = fitsBelow ? belowTop : Math.max(96, Math.min(aboveTop, bottomLimit - height));

    control.dataset.placement = fitsBelow ? 'bottom' : 'top';
    control.style.left = `${Math.round(left)}px`;
    control.style.top = `${Math.round(top)}px`;
  }

  private renderConveyorSpeed(speed: ConveyorSpeed): void {
    const normalized = CONVEYOR_SPEEDS.includes(speed) ? speed : 'normal';
    const control = this.element('#conveyor-speed-control');
    control.dataset.level = normalized;
    control
      .querySelectorAll<HTMLButtonElement>('[data-conveyor-speed-option]')
      .forEach((button) => {
        const active = button.dataset.conveyorSpeedOption === normalized;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', String(active));
        button.title = active
          ? `${CONVEYOR_SPEED_LABELS[normalized]} selecionado`
          : `Usar velocidade ${button.textContent?.trim().toLocaleLowerCase('pt-BR') ?? ''}`;
      });
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
    const progress = nearestIndex / (SIMULATION_SPEEDS.length - 1);
    const thumbHalfWidth = 22;
    const control = this.element<HTMLElement>('.speed-control');
    control.style.setProperty('--speed-position', `${progress * 100}%`);
    control.style.setProperty('--speed-offset', `${thumbHalfWidth * (1 - 2 * progress)}px`);
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

  private renderResult(payload: { contractId: ContractId; snapshot: GameSnapshot }): void {
    const { snapshot } = payload;
    const success = snapshot.status === 'success';
    const contract =
      this.editorContract && (snapshot.mode === 'editor' || snapshot.mode === 'preview')
        ? this.editorContract
        : this.contracts.find((item) => item.id === payload.contractId);
    const totalStars = contract?.collectibles.length ?? 0;
    const goalDeliveries = snapshot.goal?.deliveries ?? contract?.goal.deliveries ?? 0;
    const spent = snapshot.economy?.spent ?? snapshot.metrics.spent;
    const budgetLimit = snapshot.economy?.budgetLimit ?? contract?.economy.budgetLimit;
    const tracksLosses = snapshot.goal?.maxLosses !== undefined;

    this.resultContractId = payload.contractId;
    const resultCard = this.element('.result-card');
    resultCard.classList.toggle('is-success', success);
    resultCard.classList.toggle('is-failure', !success);
    this.element('#result-kicker').textContent = contract
      ? `FASE ${contractLabel(contract)}`
      : 'CONTRATO';
    this.element('#result-title').textContent = success
      ? 'Contrato concluído'
      : 'Contrato não concluído';
    this.element('#result-summary').textContent = success
      ? budgetLimit === undefined
        ? 'As metas de entregas e os serviços foram concluídos.'
        : 'As metas de entregas e os serviços foram concluídos dentro do orçamento.'
      : tracksLosses && snapshot.metrics.lost > snapshot.goal!.maxLosses!
        ? 'Muitas caixas foram perdidas. Ajuste os ângulos e tente de novo.'
        : budgetLimit !== undefined && spent > budgetLimit
          ? 'O orçamento nominal foi ultrapassado. Reduza os itens para concluir a fase.'
          : 'A meta não foi concluída. Ajuste a linha e tente de novo.';

    this.element('[data-result="delivered"] strong').textContent = String(
      `${snapshot.metrics.delivered} / ${goalDeliveries}`,
    );
    this.element('[data-result="collected-stars"] strong').textContent = String(
      `${snapshot.metrics.collectedStars} / ${totalStars}`,
    );
    this.element('[data-result="budget"] strong').textContent =
      budgetLimit === undefined
        ? `${formatCurrency(spent)} / Sem limite`
        : `${formatCurrency(spent)} / ${formatCurrency(budgetLimit)}`;
    const budgetPercent =
      budgetLimit === undefined || budgetLimit <= 0 ? 0 : Math.round((spent / budgetLimit) * 100);
    const budgetTrack = this.element('[data-result-budget-track]');
    budgetTrack.setAttribute('aria-valuenow', String(Math.min(budgetPercent, 100)));
    budgetTrack.setAttribute('aria-valuemax', '100');
    this.element<HTMLElement>('[data-result-budget-fill]').style.width =
      `${Math.min(budgetPercent, 100)}%`;
    this.element('[data-result-budget-percent]').textContent =
      budgetLimit === undefined ? 'Sem limite' : `${budgetPercent}%`;
    const budgetMetric = this.element('[data-result="budget"]');
    budgetMetric.classList.toggle(
      'is-over-budget',
      budgetLimit !== undefined && spent > budgetLimit,
    );
    const lostMetric = this.element('[data-result="lost"]');
    lostMetric.classList.toggle('is-hidden', !tracksLosses);
    this.element('.result-metrics').classList.toggle('without-losses', !tracksLosses);
    if (tracksLosses) {
      lostMetric.querySelector('strong')!.textContent =
        `${snapshot.metrics.lost} / ${snapshot.goal!.maxLosses}`;
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
    const hitboxButton = this.element<HTMLButtonElement>('[data-action="editor-hitboxes"]');
    hitboxButton.classList.toggle('is-active', this.editorHitboxesVisible);
    hitboxButton.setAttribute('aria-pressed', String(this.editorHitboxesVisible));
    hitboxButton.title = this.editorHitboxesVisible
      ? 'Ocultar colisões e áreas de coleta'
      : 'Visualizar colisões e áreas de coleta';

    const form = this.element<HTMLFormElement>('#editor-contract-form');
    if (!form.contains(document.activeElement)) this.populateEditorForm(contract);
  }

  private populateEditorForm(contract: ContractDefinition): void {
    const form = this.element<HTMLFormElement>('#editor-contract-form');
    setFormControlValue(form, 'world', contract.world);
    setFormControlValue(form, 'stage', contract.stage);
    setFormControlValue(form, 'deliveries', contract.goal.deliveries);
    setFormControlChecked(form, 'lossesEnabled', contract.goal.maxLosses !== undefined);
    setFormControlValue(form, 'maxLosses', contract.goal.maxLosses ?? '');
    setFormControlChecked(form, 'budgetEnabled', contract.economy.budgetLimit !== undefined);
    setFormControlValue(form, 'budgetLimit', contract.economy.budgetLimit ?? '');
    const conveyorCosts = resolveConveyorSpeedCosts(contract.economy);
    setFormControlValue(form, 'conveyorSlowCost', conveyorCosts.slow);
    setFormControlValue(form, 'conveyorNormalCost', conveyorCosts.normal);
    setFormControlValue(form, 'conveyorFastCost', conveyorCosts.fast);
    setFormControlValue(form, 'springCost', contract.economy.machineCosts.spring);
    setFormControlValue(
      form,
      'turboSpringCost',
      contract.economy.machineCosts['turbo-spring'] ?? DEFAULT_MACHINE_COSTS['turbo-spring']!,
    );
    setFormControlValue(form, 'spawnIntervalSeconds', contract.spawnIntervalSeconds);
    this.syncEditorOptionalFields(form);
    this.updateEditorFormOutputs(contract);
    setFormControlChecked(
      form,
      'availableTrackedConveyor',
      contract.availableMachines.includes('tracked-conveyor') ||
        contract.availableMachines.includes('conveyor'),
    );
    setFormControlChecked(form, 'availableSpring', contract.availableMachines.includes('spring'));
    setFormControlChecked(
      form,
      'availableTurboSpring',
      contract.availableMachines.includes('turbo-spring'),
    );
  }

  private handleEditorFormInput(): void {
    if (!this.editorContract || this.catalogSaving) return;
    const form = this.element<HTMLFormElement>('#editor-contract-form');
    const lossesEnabled = formCheckbox(form, 'lossesEnabled').checked;
    const budgetEnabled = formCheckbox(form, 'budgetEnabled').checked;
    if (lossesEnabled && formValue(form, 'maxLosses').trim() === '') {
      setFormControlValue(form, 'maxLosses', 3);
    }
    if (budgetEnabled && formValue(form, 'budgetLimit').trim() === '') {
      setFormControlValue(form, 'budgetLimit', 25_000);
    }
    this.syncEditorOptionalFields(form);
    const availableMachines: MachineType[] = [];
    if (formCheckbox(form, 'availableTrackedConveyor').checked) {
      availableMachines.push('tracked-conveyor');
    }
    if (formCheckbox(form, 'availableSpring').checked) availableMachines.push('spring');
    if (formCheckbox(form, 'availableTurboSpring').checked) {
      availableMachines.push('turbo-spring');
    }
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
        maxLosses: lossesEnabled ? numberFormValue(form, 'maxLosses') : undefined,
      },
      economy: {
        budgetLimit: budgetEnabled ? numberFormValue(form, 'budgetLimit') : undefined,
        machineCosts: {
          'tracked-conveyor': numberFormValue(form, 'conveyorNormalCost'),
          spring: numberFormValue(form, 'springCost'),
          'turbo-spring': numberFormValue(form, 'turboSpringCost'),
        },
        conveyorSpeedCosts: {
          slow: numberFormValue(form, 'conveyorSlowCost'),
          normal: numberFormValue(form, 'conveyorNormalCost'),
          fast: numberFormValue(form, 'conveyorFastCost'),
        },
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
    if (!Number.isInteger(contract.goal.deliveries))
      errors.push('Entregas deve usar um número inteiro.');
    if (contract.goal.maxLosses !== undefined && contract.goal.maxLosses < 0)
      errors.push('Perdas máximas não pode ser negativa.');
    if (contract.goal.maxLosses !== undefined && !Number.isInteger(contract.goal.maxLosses))
      errors.push('Perdas máximas deve usar um número inteiro.');
    if (contract.economy.budgetLimit !== undefined && contract.economy.budgetLimit < 0)
      errors.push('O orçamento máximo não pode ser negativo.');
    if (
      contract.economy.budgetLimit !== undefined &&
      !Number.isInteger(contract.economy.budgetLimit)
    )
      errors.push('O orçamento máximo deve usar dólares inteiros.');
    if (contract.economy.conveyorSpeedCosts) {
      for (const [index, speed] of CONVEYOR_SPEEDS.entries()) {
        const cost = contract.economy.conveyorSpeedCosts[speed];
        if (cost < 0 || !Number.isInteger(cost)) {
          errors.push(`O custo da velocidade ${index + 1} deve ser um inteiro não negativo.`);
        }
      }
    }
    if (
      contract.economy.machineCosts.spring < 0 ||
      !Number.isInteger(contract.economy.machineCosts.spring)
    )
      errors.push('O custo do trampolim deve ser um inteiro não negativo.');
    const turboSpringCost =
      contract.economy.machineCosts['turbo-spring'] ?? DEFAULT_MACHINE_COSTS['turbo-spring']!;
    if (turboSpringCost < 0 || !Number.isInteger(turboSpringCost)) {
      errors.push('O custo do trampolim turbo deve ser um inteiro não negativo.');
    }
    if (contract.spawnIntervalSeconds < 0.8 || contract.spawnIntervalSeconds > 10)
      errors.push('O intervalo de geração deve ficar entre 0,80 e 10 segundos.');
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

  private syncEditorOptionalFields(form: HTMLFormElement): void {
    const lossesEnabled = formCheckbox(form, 'lossesEnabled').checked;
    const budgetEnabled = formCheckbox(form, 'budgetEnabled').checked;
    const maxLosses = formControl(form, 'maxLosses');
    const budgetLimit = formControl(form, 'budgetLimit');
    maxLosses.toggleAttribute('disabled', !lossesEnabled);
    maxLosses.toggleAttribute('required', lossesEnabled);
    budgetLimit.toggleAttribute('disabled', !budgetEnabled);
    budgetLimit.toggleAttribute('required', budgetEnabled);
    this.element('[data-losses-setting]').classList.toggle('is-disabled', !lossesEnabled);
    this.element('[data-budget-setting]').classList.toggle('is-disabled', !budgetEnabled);
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

  private toggleEditorHitboxes(): void {
    if (!this.editorContract || this.editorPreviewActive || this.catalogSaving) return;
    this.editorHitboxesVisible = !this.editorHitboxesVisible;
    this.renderEditorState();
    appEvents.emit('ui:editor-hitboxes', { enabled: this.editorHitboxesVisible });
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
      machines: structuredClone(this.progress.campaignLayouts[next.id]?.machines ?? []),
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
        '[data-action="editor-cancel"], [data-action="editor-configure"], [data-action="editor-hitboxes"], [data-action="editor-test"]',
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

type ResultMetricKind = 'deliveries' | 'stars' | 'budget' | 'losses';

function resultMetric(
  label: string,
  value: string,
  id: string,
  kind: ResultMetricKind,
  hidden = false,
): string {
  const graphic =
    kind === 'deliveries'
      ? `<img src="${factoryBoxTextureUrl}" alt="" draggable="false" />`
      : kind === 'stars'
        ? icon('star')
        : kind === 'budget'
          ? '<span aria-hidden="true">$</span>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 22 20H2L12 3Z"/><path d="M12 8v6m0 3v.1"/></svg>';
  const budgetDetails =
    kind === 'budget'
      ? `<div class="result-budget-progress">
          <span class="result-budget-track" data-result-budget-track role="progressbar" aria-label="Percentual do orçamento utilizado" aria-valuemin="0" aria-valuenow="0" aria-valuemax="100">
            <span data-result-budget-fill></span>
          </span>
          <small data-result-budget-percent>Sem limite</small>
        </div>`
      : '';
  const classes = `result-metric result-metric-${kind}${hidden ? ' is-hidden' : ''}`;
  return `<div class="${classes}" data-result="${id}">
    <span class="result-metric-icon" aria-hidden="true">${graphic}</span>
    <span class="result-metric-label">${label}</span>
    <strong>${value}</strong>
    ${budgetDetails}
  </div>`;
}

function formatCurrency(value: number): string {
  return `$${Math.max(0, Math.round(value)).toLocaleString('en-US')}`;
}

function formatBudgetLabel(limit?: number): string {
  return limit === undefined ? 'Sem limite' : formatCurrency(limit);
}

function isContractCompleted(progress: ProgressSave, contract: ContractDefinition): boolean {
  return progress.completedContracts[contract.id] === contract.revision;
}

function machineCost(economy: GameSnapshot['economy'], machine: MachineType): number {
  if (!economy) return 0;
  if (machine === 'spring') return economy.machineCosts.spring;
  if (machine === 'turbo-spring') {
    return economy.machineCosts['turbo-spring'] ?? DEFAULT_MACHINE_COSTS['turbo-spring']!;
  }
  if (machine === 'tracked-conveyor' || machine === 'conveyor') {
    return resolveConveyorSpeedCosts(economy).normal;
  }
  return 0;
}

function toolTooltip(id: string, name: string, description: string, price?: string): string {
  return `<span class="tool-tooltip" id="${escapeHTML(id)}" role="tooltip">
    <strong>${escapeHTML(name)}</strong>
    <span>${escapeHTML(description)}</span>
    ${price ? `<b>${escapeHTML(price)}</b>` : ''}
    <em data-tool-status></em>
  </span>`;
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
    case 'tracked-conveyor':
      return `<svg class="machine-thumbnail machine-thumbnail-tracked-conveyor" viewBox="0 0 112 36" aria-hidden="true">
        <rect x="4" y="4" width="104" height="28" rx="14" fill="#202a33" />
        <g fill="#40566b" stroke="#82a5c5" stroke-width="1.5">
          <circle cx="18" cy="18" r="9"/><circle cx="56" cy="18" r="9"/><circle cx="94" cy="18" r="9"/>
        </g>
        <path d="M18 4h76a14 14 0 0 1 0 28H18a14 14 0 0 1 0-28Z" fill="none" stroke="#293139" stroke-width="9" stroke-linejoin="round" />
        <path d="M18 4h76a14 14 0 0 1 0 28H18a14 14 0 0 1 0-28Z" fill="none" stroke="#40566b" stroke-width="6.5" stroke-linejoin="round" />
        <path d="M18 4h76a14 14 0 0 1 0 28H18a14 14 0 0 1 0-28Z" fill="none" stroke="#fff" stroke-width="6.5" stroke-dasharray="8 7" stroke-linejoin="round" />
        <g fill="#fff">
          <path d="M14.5 12.5 22 18l-7.5 5.5z"/>
          <path d="M52.5 12.5 60 18l-7.5 5.5z"/>
          <path d="M90.5 12.5 98 18l-7.5 5.5z"/>
        </g>
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
        <path d="M8 17l5-8 5 8 5-8 5 8 5-8 7 8" fill="none" stroke="#25c442" stroke-width="4" stroke-linejoin="round" />
        <rect x="1" y="16" width="46" height="7" fill="#b47a48" />
      </svg>`;
    case 'turbo-spring':
      return `<svg class="machine-thumbnail machine-thumbnail-turbo-spring" viewBox="0 0 48 24" aria-hidden="true">
        <defs>
          <linearGradient id="turbo-spring-steel" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="#edf2f5" />
            <stop offset=".35" stop-color="#9ba8b2" />
            <stop offset=".7" stop-color="#d7dfe4" />
            <stop offset="1" stop-color="#77858f" />
          </linearGradient>
        </defs>
        <rect x="1" y="2" width="46" height="7" rx="1" fill="url(#turbo-spring-steel)" stroke="#66737c" />
        <path d="M8 17l5-8 5 8 5-8 5 8 5-8 7 8" fill="none" stroke="#ff2638" stroke-width="4" stroke-linejoin="round" />
        <rect x="1" y="16" width="46" height="7" rx="1" fill="url(#turbo-spring-steel)" stroke="#66737c" />
        <path d="M5 4h38M5 18h38" stroke="#fff" stroke-opacity=".65" />
      </svg>`;
  }
}

function icon(name: IconName): string {
  const paths: Record<IconName, string> = {
    source: '<path d="M4 5h16v14H4z"/><path d="M8 9h8M12 2v7m-3-3 3 3 3-3"/>',
    conveyor:
      '<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="6" cy="12" r="3"/><circle cx="12" cy="12" r="3"/><circle cx="18" cy="12" r="3"/><path d="m4.8 9.7 3.2 2.3-3.2 2.3zm6 0L14 12l-3.2 2.3zm6 0L20 12l-3.2 2.3z" fill="currentColor" stroke="none"/>',
    'tracked-conveyor':
      '<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="6" cy="12" r="3"/><circle cx="12" cy="12" r="3"/><circle cx="18" cy="12" r="3"/><path d="m4.8 9.7 3.2 2.3-3.2 2.3zm6 0L14 12l-3.2 2.3zm6 0L20 12l-3.2 2.3z" fill="currentColor" stroke="none"/>',
    receiver: '<path d="M4 5h16v14H4z"/><path d="M8 15h8M12 2v8m-3-3 3 3 3-3"/>',
    spring: '<path d="M3 7h18M5 5v4m14-4v4M6 18l3-7 3 7 3-7 3 7"/>',
    'turbo-spring':
      '<path d="M3 7h18M5 5v4m14-4v4M6 18l3-7 3 7 3-7 3 7"/><path d="m17 2-4 6h3l-2 5 6-7h-3l2-4z"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    warning: '<path d="M12 3 22 20H2L12 3Z"/><path d="M12 8v6m0 3v.1"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/>',
    map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15m6-12v15"/>',
    replay: '<path d="M4.8 8A8 8 0 1 1 4 14"/><path d="M4 4v5h5"/>',
    'arrow-right': '<path d="M4 12h16m-6-6 6 6-6 6"/>',
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
    hitbox:
      '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="7" y="7" width="10" height="10" rx="2"/>',
    clear: '<path d="m4 15 8-8 6 6-8 8H4z"/><path d="m13.5 8.5 2-2 3 3-2 2M4 21h16"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    star: '<path d="m12 2 3 6 7 .9-5 4.8 1.3 6.8L12 17.3l-6.3 3.2L7 13.7 2 8.9 9 8z"/>',
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
