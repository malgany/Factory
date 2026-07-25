import { expect, test, type Page } from '@playwright/test';

const STORAGE_KEY = 'factory-flow.progress.v1';

interface MachineDebugState {
  id: string;
  type: 'source' | 'conveyor' | 'tracked-conveyor' | 'receiver' | 'spring' | 'turbo-spring';
  gridX: number;
  gridY: number;
  angle: number;
  reversed: boolean;
  conveyorSpeed?: 'slow' | 'normal' | 'fast';
  fixed: boolean;
}

interface FactoryDebugState {
  mode: 'campaign' | 'sandbox';
  status: 'build' | 'running' | 'paused' | 'success' | 'failure';
  gridEnabled: boolean;
  simulationSpeed: number;
  metrics: {
    delivered: number;
    collectedStars: number;
    spent: number;
  };
  economy?: {
    spent: number;
    budgetLimit?: number;
    hardLimit?: number;
    machineCosts: {
      'tracked-conveyor': number;
      spring: number;
      'turbo-spring'?: number;
    };
  };
  selection: { machineIds: string[]; obstacleIds: string[]; count: number };
  machines: MachineDebugState[];
  selectedMachine?: MachineDebugState;
  camera: {
    zoom: number;
    scrollX: number;
    scrollY: number;
    centerX: number;
    centerY: number;
  };
  worldBounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  };
}

type DebugWindow = Window & {
  __FACTORY_DEBUG__?: {
    getSnapshot(): Omit<FactoryDebugState, 'machines' | 'camera' | 'worldBounds'>;
    getSimulationSeconds(): number;
    getMachines(): MachineDebugState[];
    getBoxes(): Array<{ x: number; y: number; velocityX: number; velocityY: number }>;
    getCamera(): FactoryDebugState['camera'];
    getWorldBounds(): FactoryDebugState['worldBounds'];
    placeMachine(
      type: MachineDebugState['type'],
      gridX: number,
      gridY: number,
      angle?: number,
    ): boolean;
    selectMachine(id: string): boolean;
    selectArea(minX: number, minY: number, maxX: number, maxY: number): number;
    reverseSelected(): boolean;
    deleteSelected(): boolean;
    copySelected(): boolean;
    cutSelected(): boolean;
    setMachines(machines: MachineDebugState[]): void;
    pause(): void;
    advance(seconds: number): FactoryDebugState;
    completeContract(): void;
  };
};

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#menu-title')).toBeVisible();
  await expect(page.locator('#game-container canvas')).toBeAttached();
  await expect(page.locator('#game-loading')).toBeHidden();
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');
  await page.waitForFunction(() => Boolean((window as DebugWindow).__FACTORY_DEBUG__));
}

async function debugState(page: Page): Promise<FactoryDebugState> {
  return page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('window.__FACTORY_DEBUG__ is not installed');
    return {
      ...debug.getSnapshot(),
      machines: debug.getMachines(),
      camera: debug.getCamera(),
      worldBounds: debug.getWorldBounds(),
    };
  });
}

async function openPlayMenu(page: Page): Promise<void> {
  await page.locator('[data-action="menu-play"]').click();
  await waitForMenuView(page, 'play');
  await page.evaluate(() => {
    const map = document.querySelector<HTMLElement>('.campaign-map-stage');
    const legacy = document.querySelector<HTMLElement>('.campaign-legacy-content');
    if (map) map.style.display = 'none';
    if (legacy) legacy.style.display = 'block';
  });
}

async function waitForMenuView(page: Page, view: 'home' | 'play' | 'options'): Promise<void> {
  const menu = page.locator('#menu-screen');
  await expect(menu).toHaveAttribute('data-menu-view', view);
  await expect(menu).not.toHaveAttribute('data-menu-transitioning', 'true');
  await expect(page.locator(`[data-menu-panel="${view}"]`)).toHaveAttribute('aria-hidden', 'false');
}

async function startSandbox(page: Page): Promise<void> {
  await openPlayMenu(page);
  await page.locator('[data-start-sandbox]').click();
  await expect(page.locator('#menu-screen')).toHaveClass(/is-hidden/);
  await expect.poll(async () => (await debugState(page)).mode).toBe('sandbox');
}

async function placeAtCanvasCenter(
  page: Page,
  tool: MachineDebugState['type'],
): Promise<MachineDebugState> {
  const before = await debugState(page);
  const toolButton = page.locator(`[data-tool="${tool}"]`);
  const toolBounds = await toolButton.boundingBox();
  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  if (!toolBounds || !bounds) throw new Error('Tool or canvas has no bounding box');
  await page.mouse.move(toolBounds.x + toolBounds.width / 2, toolBounds.y + toolBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.42, {
    steps: 12,
  });
  await page.mouse.up();

  await expect
    .poll(async () => (await debugState(page)).machines.length)
    .toBe(before.machines.length + 1);
  const after = await debugState(page);
  const machine = after.machines.find(
    (candidate) => !before.machines.some(({ id }) => id === candidate.id),
  );
  if (!machine) throw new Error(`No newly placed ${tool} was found`);
  return machine;
}

test('ferramentas da hotbar só posicionam por arraste', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const before = await debugState(page);
  await expect(page.locator('[data-tool="spring"] .machine-thumbnail-spring path')).toHaveAttribute(
    'stroke',
    '#25c442',
  );
  await expect(
    page.locator('[data-tool="turbo-spring"] .machine-thumbnail-turbo-spring path').first(),
  ).toHaveAttribute('stroke', '#ff2638');
  await page.locator('[data-tool="spring"]').click();
  const bounds = await page.locator('#game-container canvas').boundingBox();
  if (!bounds) throw new Error('Canvas has no bounding box');
  await page.mouse.click(bounds.x + bounds.width * 0.48, bounds.y + bounds.height * 0.4);

  await expect
    .poll(async () => (await debugState(page)).machines.length)
    .toBe(before.machines.length);
  await expect(page.locator('[data-tool="spring"]')).not.toHaveClass(/is-active/);

  const spring = await placeAtCanvasCenter(page, 'spring');
  expect(spring.type).toBe('spring');

  const turboSpring = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug?.placeMachine('turbo-spring', 16, 6)) {
      throw new Error('Could not place turbo spring');
    }
    return debug.getMachines().find(({ type }) => type === 'turbo-spring');
  });
  expect(turboSpring?.type).toBe('turbo-spring');
});

test('permite aproximar as pontas arredondadas de esteiras inclinadas', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const placement = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API is unavailable');
    return {
      first: debug.placeMachine('tracked-conveyor', 8, 8, 0),
      angled: debug.placeMachine('tracked-conveyor', 8 + 82 / 48, 8 - 10 / 48, -20),
    };
  });

  expect(placement).toEqual({ first: true, angled: true });
  expect((await debugState(page)).machines).toHaveLength(2);
});

test('inverte uma única esteira e oculta a ação para outros itens e grupos', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const conveyorId = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug || !debug.placeMachine('tracked-conveyor', 8, 6, 30)) {
      throw new Error('Could not place tracked conveyor');
    }
    const conveyor = debug.getMachines().find(({ type }) => type === 'tracked-conveyor');
    if (!conveyor || !debug.selectMachine(conveyor.id)) {
      throw new Error('Could not select tracked conveyor');
    }
    return conveyor.id;
  });

  const reverse = page.locator('[data-action="reverse"]');
  const conveyorSpeed = page.locator('#conveyor-speed-control');
  await expect(reverse).not.toHaveClass(/is-hidden/);
  await expect(conveyorSpeed).toBeVisible();
  await expect(page.locator('#selection-dock #conveyor-speed-control')).toHaveCount(0);
  await expect(conveyorSpeed).toHaveAttribute('data-placement', 'bottom');
  await expect(page.getByRole('radio', { name: 'Velocidade 2' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('[data-action="mirror-horizontal"]')).toHaveCount(0);
  await expect(page.locator('[data-action="mirror-vertical"]')).toHaveCount(0);

  for (const [label, expected] of [
    ['Velocidade 1', 'slow'],
    ['Velocidade 2', 'normal'],
    ['Velocidade 3', 'fast'],
  ] as const) {
    const option = page.getByRole('radio', { name: label });
    await option.click();
    await expect(option).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(async () =>
        page.evaluate(
          (id) =>
            (window as DebugWindow).__FACTORY_DEBUG__
              ?.getMachines()
              .find((candidate) => candidate.id === id)?.conveyorSpeed,
          conveyorId,
        ),
      )
      .toBe(expected);
    await expect(reverse).not.toHaveClass(/is-hidden/);
  }

  await reverse.click();
  await expect
    .poll(async () =>
      page.evaluate((id) => {
        const machine = (window as DebugWindow).__FACTORY_DEBUG__
          ?.getMachines()
          .find((candidate) => candidate.id === id);
        return machine && { angle: machine.angle, reversed: machine.reversed };
      }, conveyorId),
    )
    .toEqual({ angle: 30, reversed: true });

  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug?.placeMachine('tracked-conveyor', 8, 14, 0)) {
      throw new Error('Could not place conveyor above the action dock');
    }
  });
  await expect(conveyorSpeed).toHaveAttribute('data-placement', 'top');
  const speedBounds = await conveyorSpeed.boundingBox();
  const selectionDockBounds = await page.locator('#selection-dock').boundingBox();
  if (!speedBounds || !selectionDockBounds) throw new Error('Selection controls have no bounds');
  expect(speedBounds.y + speedBounds.height).toBeLessThanOrEqual(selectionDockBounds.y - 8);

  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug?.placeMachine('spring', 12, 6, 0)) throw new Error('Could not place spring');
  });
  await expect(reverse).toHaveClass(/is-hidden/);
  await expect(conveyorSpeed).not.toBeVisible();

  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    if (debug.selectArea(7 * 48, 5 * 48, 14 * 48, 8 * 48) !== 2) {
      throw new Error('Could not create conveyor group');
    }
  });
  await expect(reverse).toHaveClass(/is-hidden/);
});

test('novas esteiras herdam a última velocidade somente dentro da fase atual', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug?.placeMachine('tracked-conveyor', 6, 6, 0)) {
      throw new Error('Could not place the first conveyor');
    }
  });
  await expect(page.getByRole('radio', { name: 'Velocidade 2' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await page.getByRole('radio', { name: 'Velocidade 3' }).click();
  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug?.placeMachine('tracked-conveyor', 10, 6, 0)) {
      throw new Error('Could not place the fast conveyor');
    }
  });
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as DebugWindow).__FACTORY_DEBUG__?.getMachines().find(({ gridX }) => gridX === 10)
            ?.conveyorSpeed,
      ),
    )
    .toBe('fast');

  await page.getByRole('radio', { name: 'Velocidade 1' }).click();
  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug?.placeMachine('tracked-conveyor', 14, 6, 0)) {
      throw new Error('Could not place the slow conveyor');
    }
  });
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as DebugWindow).__FACTORY_DEBUG__?.getMachines().find(({ gridX }) => gridX === 14)
            ?.conveyorSpeed,
      ),
    )
    .toBe('slow');

  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API is unavailable');
    debug.startMode('sandbox');
    if (!debug.placeMachine('tracked-conveyor', 6, 6, 0)) {
      throw new Error('Could not place the conveyor in the new phase');
    }
  });
  await expect
    .poll(async () =>
      page.evaluate(
        () => (window as DebugWindow).__FACTORY_DEBUG__?.getMachines()[0]?.conveyorSpeed,
      ),
    )
    .toBe('normal');
});

test('bloqueia a interface até a cena do Phaser ficar pronta', async ({ page }) => {
  let releaseTexture = (): void => undefined;
  const textureGate = new Promise<void>((resolve) => {
    releaseTexture = resolve;
  });

  await page.route(/factory-box-game(?:-[^/]+)?\.png(?:\?.*)?$/, async (route) => {
    if (new URL(route.request().url()).searchParams.has('import')) {
      await route.continue();
      return;
    }
    await textureGate;
    await route.continue();
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const shell = page.locator('.factory-app');
  const loading = page.locator('#game-loading');
  await expect(loading).toBeVisible();
  await expect(shell).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#game-ui')).toHaveAttribute('inert', '');
  await expect(page.locator('#menu-screen')).toHaveAttribute('inert', '');

  releaseTexture();

  await expect(loading).toBeHidden();
  await expect(shell).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#game-ui')).toHaveAttribute('inert', '');
  await expect(page.locator('#game-ui')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#menu-screen')).not.toHaveAttribute('inert', '');

  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').first().click();
  await expect(page.locator('#game-ui')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#game-ui')).toHaveAttribute('aria-hidden', 'false');
  await page.locator('[data-action="run"]').click();
  await expect.poll(async () => (await debugState(page)).status).toBe('running');
});

test('menu inicial navega entre jogar, opções e sair', async ({ page }) => {
  test.setTimeout(45_000);
  const pageErrors: Error[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await openApp(page);

  const homePanel = page.locator('[data-menu-panel="home"]');
  const playPanel = page.locator('[data-menu-panel="play"]');
  const optionsPanel = page.locator('[data-menu-panel="options"]');
  const audioTab = optionsPanel.locator('[data-options-tab="audio-video"]');
  const controlsTab = optionsPanel.locator('[data-options-tab="controls"]');
  const audioPanel = optionsPanel.locator('[data-options-panel="audio-video"]');
  const controlsPanel = optionsPanel.locator('[data-options-panel="controls"]');
  const originStation = page.locator('.menu-origin-station');
  const gameUi = page.locator('#game-ui');

  await expect(page.locator('#menu-title')).toHaveText('Factory.');
  await expect(homePanel).not.toHaveClass(/is-hidden/);
  await expect(homePanel).not.toHaveAttribute('inert', '');
  await expect(homePanel).toHaveAttribute('aria-hidden', 'false');
  await expect(playPanel).toHaveClass(/is-hidden/);
  await expect(optionsPanel).not.toHaveClass(/is-hidden/);
  await expect(optionsPanel).toHaveAttribute('inert', '');
  const mainMenuPadding = await homePanel.evaluate((panel) =>
    [...panel.querySelectorAll<HTMLButtonElement>('.main-menu-action')].map((button) => {
      const text = button.firstChild;
      if (!text) throw new Error('Texto do botão principal não encontrado');
      const range = document.createRange();
      range.selectNodeContents(text);
      const buttonBounds = button.getBoundingClientRect();
      const textBounds = range.getBoundingClientRect();
      return {
        left: Math.round(textBounds.left - buttonBounds.left),
        right: Math.round(buttonBounds.right - textBounds.right),
      };
    }),
  );
  for (const padding of mainMenuPadding) {
    expect(Math.abs(padding.left - padding.right)).toBeLessThanOrEqual(2);
  }
  await expect(optionsPanel).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('[data-action="menu-play"]')).toHaveText('Jogar');
  await expect(page.locator('[data-action="menu-options"]')).toHaveText('Opções');
  await expect(page.locator('[data-action="menu-exit"]')).toHaveText('Sair');

  await page.locator('[data-action="menu-exit"]').click();
  await expect(homePanel).not.toHaveClass(/is-hidden/);

  const transitionStart = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-action="menu-options"]')?.click();
    const menu = document.querySelector<HTMLElement>('#menu-screen')!;
    const world = menu.querySelector<HTMLElement>('.menu-world')!;
    const home = menu.querySelector<HTMLElement>('[data-menu-panel="home"]')!;
    const options = menu.querySelector<HTMLElement>('[data-menu-panel="options"]')!;
    const style = getComputedStyle(world);
    return {
      transitioning: menu.dataset.menuTransitioning,
      homeInert: home.hasAttribute('inert'),
      optionsInert: options.hasAttribute('inert'),
      duration: style.transitionDuration,
      easing: style.transitionTimingFunction,
    };
  });
  expect(transitionStart).toEqual({
    transitioning: 'true',
    homeInert: true,
    optionsInert: true,
    duration: '0.65s',
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  });
  await waitForMenuView(page, 'options');
  await expect(optionsPanel).not.toHaveAttribute('inert', '');
  await expect(optionsPanel.locator('[data-action="menu-home"]')).toBeFocused();
  await expect(originStation).toHaveAttribute('inert', '');
  await expect(originStation).toHaveAttribute('aria-hidden', 'true');
  await expect(gameUi).toHaveAttribute('inert', '');
  await expect(gameUi).toHaveAttribute('aria-hidden', 'true');
  await expect(optionsPanel.getByText('CONFIGURAÇÕES', { exact: true })).toHaveCount(0);
  await expect(audioTab).toHaveText('Áudio e vídeo');
  await expect(audioTab).toHaveAttribute('aria-pressed', 'true');
  await expect(controlsTab).toHaveAttribute('aria-pressed', 'false');
  await expect(audioPanel).not.toHaveClass(/is-hidden/);
  await expect(audioPanel).not.toHaveAttribute('inert', '');
  await expect(controlsPanel).toHaveClass(/is-hidden/);
  await expect(controlsPanel).toHaveAttribute('inert', '');

  const initialOptionsPresentation = await optionsPanel.evaluate((panel) => {
    const audio = panel.querySelector<HTMLElement>('[data-options-tab="audio-video"]')!;
    const controls = panel.querySelector<HTMLElement>('[data-options-tab="controls"]')!;
    const rows = [...panel.querySelectorAll<HTMLElement>('.menu-option-row')];
    return {
      activeBackground: getComputedStyle(audio).backgroundColor,
      activeColor: getComputedStyle(audio).color,
      inactiveBackground: getComputedStyle(controls).backgroundColor,
      inactiveColor: getComputedStyle(controls).color,
      separators: rows.map((row) => getComputedStyle(row).borderBottomWidth),
      subtexts: panel.querySelectorAll('.menu-option-row > div > span').length,
    };
  });
  expect(initialOptionsPresentation).toEqual({
    activeBackground: 'rgb(255, 255, 255)',
    activeColor: 'rgb(36, 71, 103)',
    inactiveBackground: 'rgba(232, 243, 252, 0.68)',
    inactiveColor: 'rgb(36, 71, 103)',
    separators: ['0px', '0px', '0px'],
    subtexts: 0,
  });

  const categoryAlignment = await optionsPanel.evaluate((panel) =>
    [...panel.querySelectorAll<HTMLButtonElement>('[data-options-tab]')].map((button) => {
      const text = button.firstChild;
      if (!text) throw new Error('Texto da categoria não encontrado');
      const range = document.createRange();
      range.selectNodeContents(text);
      const buttonBounds = button.getBoundingClientRect();
      const textBounds = range.getBoundingClientRect();
      return {
        rightEdge: Math.round(buttonBounds.right),
        leftPadding: Math.round(textBounds.left - buttonBounds.left),
        rightPadding: Math.round(buttonBounds.right - textBounds.right),
      };
    }),
  );
  expect(new Set(categoryAlignment.map(({ rightEdge }) => rightEdge)).size).toBe(1);
  for (const { leftPadding, rightPadding } of categoryAlignment) {
    expect(Math.abs(leftPadding - rightPadding)).toBeLessThanOrEqual(2);
  }

  const optionTypeSizes = await optionsPanel.evaluate((panel) => ({
    category: Number.parseFloat(
      getComputedStyle(panel.querySelector<HTMLElement>('[data-options-tab="audio-video"]')!)
        .fontSize,
    ),
    setting: Number.parseFloat(
      getComputedStyle(panel.querySelector<HTMLElement>('.menu-option-row strong')!).fontSize,
    ),
  }));
  expect(optionTypeSizes.category).toBeGreaterThanOrEqual(31);
  expect(optionTypeSizes.setting).toBeGreaterThanOrEqual(18);

  const statusBeforeCategoryShortcut = (await debugState(page)).status;
  await controlsTab.focus();
  await page.keyboard.press('Space');
  await expect(optionsPanel).toHaveAttribute('data-options-category', 'controls');
  expect((await debugState(page)).status).toBe(statusBeforeCategoryShortcut);
  await expect(audioTab).toHaveAttribute('aria-pressed', 'false');
  await expect(controlsTab).toHaveAttribute('aria-pressed', 'true');
  await expect(controlsTab).toHaveCSS('color', 'rgb(36, 71, 103)');
  await expect(audioTab).toHaveCSS('background-color', 'rgba(232, 243, 252, 0.68)');
  await expect(audioTab).toHaveCSS('color', 'rgb(36, 71, 103)');
  await expect(audioPanel).toHaveClass(/is-hidden/);
  await expect(audioPanel).toHaveAttribute('inert', '');
  await expect(controlsPanel).not.toHaveClass(/is-hidden/);
  await expect(controlsPanel).not.toHaveAttribute('inert', '');
  await expect(controlsPanel.getByRole('heading', { name: 'Mouse' })).toBeVisible();
  await expect(controlsPanel.getByRole('heading', { name: 'Teclado' })).toBeVisible();
  await expect(controlsPanel).toContainText('Selecionar ou posicionar');
  await expect(controlsPanel).toContainText('Mover peça ou câmera');
  await expect(controlsPanel).toContainText('Iniciar ou pausar');
  await expect(controlsPanel).toContainText('Inverter');
  await expect(controlsPanel).not.toContainText('Inverter esteira');
  await expect(controlsPanel).toContainText('Ctrl+Z / Ctrl+Y');

  await audioTab.click();
  await expect(optionsPanel).toHaveAttribute('data-options-category', 'audio-video');

  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab');
    const focusState = await optionsPanel.evaluate((panel) => {
      const active = document.activeElement as HTMLElement;
      return {
        allowed: active === document.body || panel.contains(active),
        action: active.dataset.action ?? '',
        id: active.id,
      };
    });
    expect(focusState.allowed).toBe(true);
    expect(focusState.action).not.toBe('pause-menu');
    expect(focusState.id).not.toBe('admin-toggle');
  }

  const stationBounds = await optionsPanel.boundingBox();
  expect(stationBounds?.x).toBeCloseTo(0, 1);
  expect(stationBounds?.y).toBeCloseTo(0, 1);
  expect(stationBounds?.width).toBeCloseTo(page.viewportSize()?.width ?? 0, 1);
  expect(stationBounds?.height).toBeCloseTo(page.viewportSize()?.height ?? 0, 1);

  const sound = optionsPanel.locator('[data-action="mute"]');
  await expect(optionsPanel.locator('[data-sound-state]')).toHaveText('Ligado');
  await sound.click();
  await expect(optionsPanel.locator('[data-sound-state]')).toHaveText('Desligado');
  await expect(page.locator('#pause-modal [data-action="mute"]')).toHaveAttribute(
    'aria-label',
    'Ativar som',
  );
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const stored = localStorage.getItem(key);
        return stored ? JSON.parse(stored).settings.muted : undefined;
      }, STORAGE_KEY),
    )
    .toBe(true);
  await sound.click();
  await expect(optionsPanel.locator('[data-sound-state]')).toHaveText('Ligado');
  await expect(page.locator('#pause-modal [data-action="mute"]')).toHaveAttribute(
    'aria-label',
    'Silenciar',
  );

  const volume = page.locator('[data-volume]');
  await volume.evaluate((input) => {
    (input as HTMLInputElement).value = '42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('[data-volume-output]')).toHaveText('42%');
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const stored = localStorage.getItem(key);
        return stored ? JSON.parse(stored).settings.volume : undefined;
      }, STORAGE_KEY),
    )
    .toBe(0.42);

  await controlsTab.click();
  await expect(optionsPanel).toHaveAttribute('data-options-category', 'controls');

  const returnStart = await page.evaluate(() => {
    document
      .querySelector<HTMLButtonElement>('[data-menu-panel="options"] [data-action="menu-home"]')
      ?.click();
    const menu = document.querySelector<HTMLElement>('#menu-screen')!;
    return {
      transitioning: menu.dataset.menuTransitioning,
      homeInert: menu.querySelector<HTMLElement>('[data-menu-panel="home"]')!.hasAttribute('inert'),
      optionsInert: menu
        .querySelector<HTMLElement>('[data-menu-panel="options"]')!
        .hasAttribute('inert'),
    };
  });
  expect(returnStart).toEqual({ transitioning: 'true', homeInert: true, optionsInert: true });
  await waitForMenuView(page, 'home');
  await expect(homePanel).not.toHaveAttribute('inert', '');
  await expect(originStation).not.toHaveAttribute('inert', '');
  await expect(originStation).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('[data-action="menu-options"]')).toBeFocused();

  await page.locator('[data-action="menu-options"]').click();
  await waitForMenuView(page, 'options');
  await expect(optionsPanel).toHaveAttribute('data-options-category', 'audio-video');
  await expect(audioTab).toHaveAttribute('aria-pressed', 'true');
  await expect(audioPanel).not.toHaveAttribute('inert', '');
  await optionsPanel.locator('[data-action="menu-home"]').click();
  await waitForMenuView(page, 'home');

  const playTransitionStart = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-action="menu-play"]')?.click();
    const menu = document.querySelector<HTMLElement>('#menu-screen')!;
    const world = menu.querySelector<HTMLElement>('.menu-world')!;
    return {
      transitioning: menu.dataset.menuTransitioning,
      homeInert: menu.querySelector<HTMLElement>('[data-menu-panel="home"]')!.hasAttribute('inert'),
      playInert: menu.querySelector<HTMLElement>('[data-menu-panel="play"]')!.hasAttribute('inert'),
      duration: getComputedStyle(world).transitionDuration,
      easing: getComputedStyle(world).transitionTimingFunction,
    };
  });
  expect(playTransitionStart).toEqual({
    transitioning: 'true',
    homeInert: true,
    playInert: true,
    duration: '0.65s',
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  });
  await waitForMenuView(page, 'play');
  await expect(playPanel).not.toHaveClass(/is-hidden/);
  await expect(playPanel.locator('.campaign-map-image')).toBeVisible();
  const mapBrand = playPanel.locator('.campaign-map-brand');
  await expect(mapBrand).toBeVisible();
  const mapBrandBounds = await mapBrand.boundingBox();
  expect((mapBrandBounds?.x ?? 0) + (mapBrandBounds?.width ?? 0) / 2).toBeCloseTo(
    (page.viewportSize()?.width ?? 0) / 2,
    1,
  );
  const routeOverlay = playPanel.locator('.campaign-route-overlay');
  const stageMarkers = playPanel.locator('.campaign-stage-marker');
  await expect(routeOverlay).toBeVisible();
  await expect(stageMarkers).toHaveCount(10);
  await expect(playPanel.locator('.campaign-stage-marker.is-locked')).toHaveCount(9);
  await expect(playPanel.locator('.campaign-stage-marker.is-locked svg')).toHaveCount(9);
  await expect(routeOverlay.locator('.campaign-route-link.is-locked')).toHaveCount(9);
  await expect(stageMarkers.locator('strong')).toHaveText(['1-1']);
  await expect(playPanel.locator('.campaign-legacy-content')).toBeHidden();
  await expect(playPanel.locator('.campaign-map-back-button')).toBeFocused();
  await stageMarkers.first().click();
  const campaignPlay = playPanel.locator('[data-action="campaign-play"]');
  await expect(campaignPlay).toHaveText('Jogar');
  await expect(campaignPlay).toHaveClass(/main-menu-action/);
  await expect(campaignPlay.locator('svg')).toHaveCount(0);

  const playCamera = await page.locator('.menu-world').evaluate((world) => {
    const matrix = new DOMMatrix(getComputedStyle(world).transform);
    return { x: Math.round(matrix.m41), y: Math.round(matrix.m42) };
  });
  expect(playCamera).toEqual({
    x: -(page.viewportSize()?.width ?? 0),
    y: -(page.viewportSize()?.height ?? 0),
  });
  const playBounds = await playPanel.boundingBox();
  expect(playBounds?.x).toBeCloseTo(0, 1);
  expect(playBounds?.y).toBeCloseTo(0, 1);
  expect(playBounds?.width).toBeCloseTo(page.viewportSize()?.width ?? 0, 1);
  expect(playBounds?.height).toBeCloseTo(page.viewportSize()?.height ?? 0, 1);

  await page.setViewportSize({ width: 2034, height: 920 });
  const wideMapBounds = await playPanel.locator('.campaign-map-image').boundingBox();
  const wideRouteBounds = await routeOverlay.boundingBox();
  expect(wideMapBounds?.x).toBeCloseTo(0, 1);
  expect(wideMapBounds?.width).toBeCloseTo(2034, 1);
  expect((wideMapBounds?.y ?? 0) + (wideMapBounds?.height ?? 0)).toBeCloseTo(920, 1);
  expect(wideMapBounds?.y).toBeLessThan(0);
  expect(wideRouteBounds?.x).toBeCloseTo(wideMapBounds?.x ?? 0, 1);
  expect(wideRouteBounds?.y).toBeCloseTo(wideMapBounds?.y ?? 0, 1);
  expect(wideRouteBounds?.width).toBeCloseTo(wideMapBounds?.width ?? 0, 1);
  expect(wideRouteBounds?.height).toBeCloseTo(wideMapBounds?.height ?? 0, 1);

  await playPanel.locator('.campaign-map-back-button').click();
  await waitForMenuView(page, 'home');
  await expect(page.locator('[data-action="menu-play"]')).toBeFocused();

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('opções alternam tela cheia, modo janela e informam falhas', async ({ page }) => {
  await openApp(page);
  await page.locator('[data-action="menu-options"]').click();
  await waitForMenuView(page, 'options');

  const options = page.locator('[data-menu-panel="options"]');
  const fullscreenButton = options.locator('[data-action="fullscreen"]');
  const optionsTitle = options.locator('[data-fullscreen-title]');

  await expect(optionsTitle).toHaveText('Tela cheia');
  await expect(fullscreenButton).toHaveAttribute('aria-label', 'Entrar em tela cheia');
  await page.evaluate(() => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.documentElement,
    });
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await expect(optionsTitle).toHaveText('Modo janela');
  await expect(fullscreenButton).toHaveAttribute('aria-label', 'Sair da tela cheia');
  await expect(fullscreenButton).toHaveAttribute('aria-pressed', 'true');
  await expect(options.locator('[data-fullscreen-state]')).toHaveText('Restaurar');

  await page.evaluate(() => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: null,
    });
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await expect(optionsTitle).toHaveText('Tela cheia');
  await expect(fullscreenButton).toHaveAttribute('aria-pressed', 'false');

  await page.evaluate(() => {
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: () => Promise.reject(new Error('fullscreen unavailable')),
    });
  });
  await fullscreenButton.click();
  await expect(page.locator('#toast')).toHaveText('Não foi possível alternar a tela cheia.');
  await expect(page.locator('#toast')).toBeVisible();
  await expect(optionsTitle).toHaveText('Tela cheia');
});

test('opções respeitam movimento reduzido e mantêm a demonstração parada', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);

  const menu = page.locator('#menu-screen');
  const demo = page.locator('#menu-motion-demo');
  const options = page.locator('[data-menu-panel="options"]');
  await expect(demo).toHaveAttribute('data-active', 'false');

  await page.locator('[data-action="menu-options"]').click();
  await waitForMenuView(page, 'options');
  await expect(menu).not.toHaveAttribute('data-menu-transitioning', 'true');
  await expect(options.locator('[data-action="menu-home"]')).toBeFocused();

  await options.locator('[data-action="menu-home"]').click();
  await waitForMenuView(page, 'home');
  await expect(menu).not.toHaveAttribute('data-menu-transitioning', 'true');
  await expect(demo).toHaveAttribute('data-active', 'false');
  await expect(page.locator('[data-action="menu-options"]')).toBeFocused();
});

test('opções ocupam o viewport sem overflow nas resoluções suportadas', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await openApp(page);
  await page.locator('[data-action="menu-options"]').click();
  await waitForMenuView(page, 'options');

  const options = page.locator('[data-menu-panel="options"]');
  const audioTab = options.locator('[data-options-tab="audio-video"]');
  const controlsTab = options.locator('[data-options-tab="controls"]');
  const audioPanel = options.locator('[data-options-panel="audio-video"]');
  const controlsPanel = options.locator('[data-options-panel="controls"]');
  for (const viewport of [
    { width: 1024, height: 640 },
    { width: 1280, height: 720 },
    { width: 1310, height: 920 },
  ]) {
    await page.setViewportSize(viewport);
    const bounds = await options.boundingBox();
    expect(bounds?.x).toBeCloseTo(0, 1);
    expect(bounds?.y).toBeCloseTo(0, 1);
    expect(bounds?.width).toBeCloseTo(viewport.width, 1);
    expect(bounds?.height).toBeCloseTo(viewport.height, 1);
    await expect(options.locator('.options-back-button')).toBeInViewport();
    await expect(options.locator('.options-layout')).toBeInViewport();
    await audioTab.click();
    await expect(audioPanel).toBeInViewport();
    const categoriesClearContent = await options.evaluate((station) => {
      const content = station
        .querySelector<HTMLElement>('.options-content')!
        .getBoundingClientRect();
      return [...station.querySelectorAll<HTMLElement>('[data-options-tab]')].every((category) => {
        const categoryBounds = category.getBoundingClientRect();
        return categoryBounds.right < content.left;
      });
    });
    expect(categoriesClearContent).toBe(true);
    await controlsTab.click();
    await expect(controlsPanel).toBeInViewport();
    await expect(controlsPanel.locator('.control-device-card')).toHaveCount(2);
    const menuClipState = await page.locator('#menu-screen').evaluate((menu) => ({
      overflow: getComputedStyle(menu).overflow,
      scrollLeft: menu.scrollLeft,
      scrollTop: menu.scrollTop,
    }));
    expect(menuClipState).toEqual({ overflow: 'clip', scrollLeft: 0, scrollTop: 0 });
    const contentFits = await options.evaluate((station) => {
      const viewport = station.getBoundingClientRect();
      const layout = station.querySelector<HTMLElement>('.options-layout')!.getBoundingClientRect();
      const controls = station
        .querySelector<HTMLElement>('[data-options-panel="controls"]')!
        .getBoundingClientRect();
      return [layout, controls].every(
        (bounds) =>
          bounds.left >= viewport.left - 1 &&
          bounds.top >= viewport.top - 1 &&
          bounds.right <= viewport.right + 1 &&
          bounds.bottom <= viewport.bottom + 1,
      );
    });
    expect(contentFits).toBe(true);
    const overflows = await page.evaluate(
      () =>
        document.body.scrollWidth > document.documentElement.clientWidth ||
        document.body.scrollHeight > document.documentElement.clientHeight,
    );
    expect(overflows).toBe(false);
  }
});

test('demonstração do menu usa física lenta e descarta caixas fora da tela', async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);

  const demo = page.locator('#menu-motion-demo');
  await expect(demo.locator('canvas')).toHaveCount(1);
  await expect(demo).toHaveAttribute('data-active', 'true');
  await expect(demo).toHaveAttribute('data-physics-speed', '0.5');
  await expect(demo).toHaveAttribute('data-conveyor-grid-width', '1.5');
  await expect(demo).toHaveAttribute('data-spring-grid-width', '0.75');
  await expect(demo).toHaveAttribute('data-box-grid-width', '0.4375');
  await expect(demo).toHaveAttribute('data-offscreen-cleanup-margin', '56');

  const renderDensity = await demo.locator('canvas').evaluate((canvas) => {
    const bounds = canvas.getBoundingClientRect();
    return canvas.width / bounds.width;
  });
  expect(renderDensity).toBeGreaterThanOrEqual(1.9);
  const viewport = page.viewportSize();
  const demoBounds = await demo.boundingBox();
  expect(demoBounds?.y).toBeCloseTo(0, 1);
  expect((demoBounds?.x ?? 0) + (demoBounds?.width ?? 0)).toBeCloseTo(viewport?.width ?? 0, 1);

  await expect
    .poll(async () => Number((await demo.getAttribute('data-simulation-steps')) ?? 0))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => Number((await demo.getAttribute('data-active-boxes')) ?? 0))
    .toBe(1);
  await expect
    .poll(async () => Number((await demo.getAttribute('data-offscreen-destroyed-boxes')) ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await expect(demo).toHaveAttribute('data-last-offscreen-side', 'right');
  const cleanupX = Number((await demo.getAttribute('data-last-offscreen-x')) ?? 0);
  const visibleRight = Number((await demo.getAttribute('data-visible-right')) ?? 0);
  expect(cleanupX).toBeGreaterThan(visibleRight + 56);
  expect(Number((await demo.getAttribute('data-active-boxes')) ?? 0)).toBeLessThanOrEqual(1);

  const pausedForOptions = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-action="menu-options"]')?.click();
    const menu = document.querySelector<HTMLElement>('#menu-screen')!;
    const demo = document.querySelector<HTMLElement>('#menu-motion-demo')!;
    return {
      transitioning: menu.dataset.menuTransitioning,
      active: demo.dataset.active,
      boxes: demo.dataset.activeBoxes,
      steps: Number(demo.dataset.simulationSteps ?? 0),
    };
  });
  expect(pausedForOptions).toMatchObject({ transitioning: 'true', active: 'false', boxes: '0' });
  const pausedSteps = pausedForOptions.steps;
  await page.waitForTimeout(180);
  expect(Number((await demo.getAttribute('data-simulation-steps')) ?? 0)).toBe(pausedSteps);
  await waitForMenuView(page, 'options');

  const pausedForReturn = await page.evaluate(() => {
    document
      .querySelector<HTMLButtonElement>('[data-menu-panel="options"] [data-action="menu-home"]')
      ?.click();
    return document.querySelector<HTMLElement>('#menu-motion-demo')?.dataset.active;
  });
  expect(pausedForReturn).toBe('false');
  await waitForMenuView(page, 'home');
  await expect(demo).toHaveAttribute('data-active', 'true');
  await expect
    .poll(async () => Number((await demo.getAttribute('data-active-boxes')) ?? 0))
    .toBe(1);

  await page.locator('[data-action="menu-play"]').click();
  await expect(demo).toHaveAttribute('data-active', 'false');
  await expect(demo).toHaveAttribute('data-active-boxes', '0');
  await expect(demo.locator('canvas')).toHaveCount(1);

  await page.locator('.campaign-map-back-button').click();
  await waitForMenuView(page, 'home');
  await expect(demo).toHaveAttribute('data-active', 'true');
  await expect(demo.locator('canvas')).toHaveCount(1);

  await page.setViewportSize({ width: 860, height: 720 });
  const compactBounds = await demo.boundingBox();
  expect(compactBounds?.y ?? -1).toBeCloseTo(0, 1);
  expect(compactBounds?.x ?? 0).toBeCloseTo(860 - (compactBounds?.width ?? 0), 1);
  expect((compactBounds?.y ?? 0) + (compactBounds?.height ?? 0)).toBeCloseTo(610, 1);
});

test('sandbox permite colocar, girar, inverter e desfazer/refazer', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  await expect(page.locator('[data-tool]')).toHaveCount(5);
  await expect(page.locator('[data-tool]').first().locator('.tool-glyph')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
  await expect(page.locator('[data-tool]').first().locator('.tool-glyph')).toHaveCSS(
    'border-top-width',
    '0px',
  );
  const conveyor = await placeAtCanvasCenter(page, 'tracked-conveyor');
  await expect(page.locator('#selection-panel')).toHaveCount(0);
  await expect(page.locator('[data-action="delete"]')).toBeEnabled();

  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Canvas has no bounding box');
  const camera = (await debugState(page)).camera;
  const startX =
    bounds.x +
    (bounds.width - 30 * 48 * camera.zoom) / 2 +
    (conveyor.gridX + 0.5) * 48 * camera.zoom;
  const startY =
    bounds.y +
    (bounds.height - 18 * 48 * camera.zoom) / 2 +
    (conveyor.gridY + 0.5) * 48 * camera.zoom;
  const shell = page.locator('.factory-app');
  const buildDock = page.locator('.build-dock');
  const selectionDock = page.locator('#selection-dock');
  await expect(selectionDock).not.toHaveClass(/is-hidden/);
  const grabX = startX + 30 * camera.zoom;
  const grabY = startY + 6 * camera.zoom;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 24 * camera.zoom, grabY + 12 * camera.zoom, { steps: 8 });
  await expect(shell).toHaveClass(/is-dragging-object/);
  await expect(buildDock).toHaveCSS('opacity', '0');
  await expect(selectionDock).toHaveCSS('opacity', '0');
  await page.mouse.up();
  await expect(shell).toHaveClass(/is-dragging-object/);
  await page.waitForTimeout(220);
  await expect(shell).not.toHaveClass(/is-dragging-object/);
  await expect
    .poll(async () => (await debugState(page)).machines.find(({ id }) => id === conveyor.id)?.gridX)
    .toBe(conveyor.gridX + 0.5);
  await expect
    .poll(async () => (await debugState(page)).machines.find(({ id }) => id === conveyor.id)?.gridY)
    .toBe(conveyor.gridY + 0.25);

  await page.keyboard.press('e');
  await expect
    .poll(async () => (await debugState(page)).machines.find(({ id }) => id === conveyor.id)?.angle)
    .toBe(5);

  await page.keyboard.press('r');
  await expect
    .poll(
      async () => (await debugState(page)).machines.find(({ id }) => id === conveyor.id)?.reversed,
    )
    .toBe(true);

  await page.locator('[data-action="undo"]').click();
  await expect
    .poll(
      async () => (await debugState(page)).machines.find(({ id }) => id === conveyor.id)?.reversed,
    )
    .toBe(false);

  await page.locator('[data-action="redo"]').click();
  await expect
    .poll(
      async () => (await debugState(page)).machines.find(({ id }) => id === conveyor.id)?.reversed,
    )
    .toBe(true);
});

test('esteira física transporta caixas com os colisores móveis', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const boxes = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    if (!debug.placeMachine('source', 10, 3)) throw new Error('Source not placed');
    if (!debug.placeMachine('tracked-conveyor', 10, 5)) {
      throw new Error('Tracked conveyor not placed');
    }
    debug.advance(3);
    return debug.getBoxes();
  });

  const conveyorCenterX = (10 + 0.5) * 48;
  expect(boxes.some(({ x }) => x > conveyorCenterX + 40)).toBe(true);
});

test('trampolim aplica o impulso fixo nas duas faces', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const result = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    const source: MachineDebugState = {
      id: 'two-sided-spring-source',
      type: 'source',
      gridX: 10,
      gridY: 9,
      angle: 0,
      reversed: false,
      fixed: false,
    };
    const upperSpring: MachineDebugState = {
      id: 'two-sided-spring-upper',
      type: 'spring',
      gridX: 10,
      gridY: 7,
      angle: 0,
      reversed: false,
      fixed: false,
    };
    const lowerSpring: MachineDebugState = {
      id: 'two-sided-spring-lower',
      type: 'spring',
      gridX: 10,
      gridY: 12,
      angle: 0,
      reversed: false,
      fixed: false,
    };
    debug.setMachines([source, upperSpring, lowerSpring]);
    debug.advance(1 / 60);
    if (debug.getBoxes().length !== 1) throw new Error('Initial box was not spawned');
    debug.setMachines([upperSpring, lowerSpring]);

    let previousVelocityY = debug.getBoxes()[0]!.velocityY;
    let upwardImpulse = 0;
    let bottomFaceImpulse = 0;
    for (let sample = 0; sample < 600; sample += 1) {
      debug.advance(1 / 60);
      const box = debug.getBoxes()[0];
      if (!box) break;
      if (box.velocityY < -10) upwardImpulse = Math.max(upwardImpulse, -box.velocityY);
      if (upwardImpulse > 0 && previousVelocityY < -1 && box.velocityY > 10) {
        bottomFaceImpulse = Math.max(bottomFaceImpulse, box.velocityY);
      }
      previousVelocityY = box.velocityY;
    }
    return { upwardImpulse, bottomFaceImpulse };
  });

  expect(result.upwardImpulse).toBeCloseTo(11.5, 1);
  expect(result.bottomFaceImpulse).toBeCloseTo(11.5, 1);
});

test('cena prepara e avança 40 esteiras físicas sem travar', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const benchmark = await page.evaluate(async () => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    const measureFrames = async (frameCount: number) => {
      const samples: number[] = [];
      let previousFrame = performance.now();
      for (let index = 0; index < frameCount; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const currentFrame = performance.now();
        samples.push(currentFrame - previousFrame);
        previousFrame = currentFrame;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        mean: samples.reduce((total, duration) => total + duration, 0) / samples.length,
        p95: sorted[Math.floor(sorted.length * 0.95)]!,
      };
    };
    const baselineFrames = await measureFrames(30);
    const machines: MachineDebugState[] = Array.from({ length: 40 }, (_, index) => ({
      id: `scale-track-${index}`,
      type: 'tracked-conveyor',
      gridX: 1 + (index % 10) * 3,
      gridY: 1 + Math.floor(index / 10) * 3,
      angle: 0,
      reversed: false,
      fixed: false,
    }));

    const buildStartedAt = performance.now();
    debug.setMachines(machines);
    const buildMilliseconds = performance.now() - buildStartedAt;
    const initializationStartedAt = performance.now();
    debug.advance(1 / 60);
    const initializationMilliseconds = performance.now() - initializationStartedAt;
    const simulationStartedAt = performance.now();
    debug.advance(0.25);
    const simulationMilliseconds = performance.now() - simulationStartedAt;
    const simulationSeconds = debug.getSimulationSeconds();
    const runningFrames = await measureFrames(90);
    return {
      baselineFrames,
      buildMilliseconds,
      initializationMilliseconds,
      simulationMilliseconds,
      machineCount: debug.getMachines().length,
      simulationSeconds,
      meanFrameMilliseconds: runningFrames.mean,
      p95FrameMilliseconds: runningFrames.p95,
    };
  });

  expect(benchmark.machineCount).toBe(40);
  expect(benchmark.simulationSeconds).toBeCloseTo(16 / 60, 4);
  expect(benchmark.buildMilliseconds).toBeLessThan(2_500);
  expect(benchmark.initializationMilliseconds).toBeLessThan(2_500);
  expect(benchmark.simulationMilliseconds).toBeLessThan(2_500);
  expect(benchmark.meanFrameMilliseconds).toBeLessThan(benchmark.baselineFrames.mean * 2);
  expect(benchmark.p95FrameMilliseconds).toBeLessThan(benchmark.baselineFrames.p95 * 2);
});

test('copiar e recortar preservam a configuração da máquina selecionada', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const original = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug || !debug.placeMachine('tracked-conveyor', 8, 6, 35)) {
      throw new Error('Could not create the source conveyor');
    }
    const machine = debug
      .getMachines()
      .find((candidate) => candidate.gridX === 8 && candidate.gridY === 6);
    if (!machine || !debug.selectMachine(machine.id) || !debug.reverseSelected()) {
      throw new Error('Could not configure the source conveyor');
    }
    return debug.getMachines().find(({ id }) => id === machine.id);
  });
  if (!original) throw new Error('Configured conveyor was not found');

  const selectionDock = page.locator('#selection-dock');
  await expect(selectionDock).not.toHaveClass(/is-hidden/);
  const selectionBounds = await selectionDock.boundingBox();
  const buildDockBounds = await page.locator('.build-dock').boundingBox();
  if (!selectionBounds || !buildDockBounds) throw new Error('Selection docks have no bounds');
  expect(selectionBounds.y + selectionBounds.height).toBeLessThanOrEqual(buildDockBounds.y - 8);
  await page.locator('[data-action="copy"]').click();
  await expect(selectionDock).toHaveClass(/is-hidden/);

  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  const camera = (await debugState(page)).camera;
  if (!bounds) throw new Error('Canvas has no bounds');
  const pointFor = (gridX: number, gridY: number) => ({
    x: bounds.x + (bounds.width - 30 * 48 * camera.zoom) / 2 + (gridX + 0.5) * 48 * camera.zoom,
    y: bounds.y + (bounds.height - 18 * 48 * camera.zoom) / 2 + (gridY + 0.5) * 48 * camera.zoom,
  });

  const copiedTarget = pointFor(14, 8);
  await page.mouse.click(copiedTarget.x, copiedTarget.y);
  await expect.poll(async () => (await debugState(page)).machines).toHaveLength(2);
  const copied = (await debugState(page)).machines.find(({ id }) => id !== original.id);
  expect(copied).toEqual(
    expect.objectContaining({
      type: original.type,
      angle: original.angle,
      reversed: original.reversed,
      fixed: original.fixed,
      gridX: 14,
      gridY: 8,
    }),
  );
  if (!copied) throw new Error('Copied conveyor was not found');

  await page.evaluate((id) => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug?.selectMachine(id)) throw new Error('Could not select copied conveyor');
  }, copied.id);
  await expect(selectionDock).not.toHaveClass(/is-hidden/);
  await page.locator('[data-action="cut"]').click();
  await expect.poll(async () => (await debugState(page)).machines).toHaveLength(1);

  const cutTarget = pointFor(18, 10);
  await page.mouse.click(cutTarget.x, cutTarget.y);
  await expect.poll(async () => (await debugState(page)).machines).toHaveLength(2);
  const pastedCut = (await debugState(page)).machines.find(({ id }) => id !== original.id);
  expect(pastedCut).toEqual(
    expect.objectContaining({
      type: original.type,
      angle: original.angle,
      reversed: original.reversed,
      fixed: original.fixed,
      gridX: 18,
      gridY: 10,
    }),
  );
});

test('seleção por área copia, recorta e exclui grupos como uma unidade', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const originals = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    if (!debug.placeMachine('tracked-conveyor', 8, 6, 35) || !debug.reverseSelected()) {
      throw new Error('Could not create the configured conveyor');
    }
    if (!debug.placeMachine('spring', 11, 8, 0)) throw new Error('Could not create spring');
    if (!debug.placeMachine('tracked-conveyor', 14, 6, 90)) {
      throw new Error('Could not create the second conveyor');
    }
    return debug.getMachines();
  });
  expect(originals).toHaveLength(3);

  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  const camera = (await debugState(page)).camera;
  if (!bounds) throw new Error('Canvas has no bounds');
  const pointFor = (gridX: number, gridY: number) => ({
    x: bounds.x + (bounds.width - 30 * 48 * camera.zoom) / 2 + (gridX + 0.5) * 48 * camera.zoom,
    y: bounds.y + (bounds.height - 18 * 48 * camera.zoom) / 2 + (gridY + 0.5) * 48 * camera.zoom,
  });

  const marqueeStart = pointFor(6, 4);
  const marqueeEnd = pointFor(16, 10);
  await page.mouse.move(marqueeStart.x, marqueeStart.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(marqueeEnd.x, marqueeEnd.y, { steps: 8 });
  await page.mouse.up({ button: 'right' });

  await expect.poll(async () => (await debugState(page)).selection.count).toBe(3);
  const selectionDock = page.locator('#selection-dock');
  await expect(selectionDock).not.toHaveClass(/is-hidden/);
  await expect(page.locator('[data-action="copy"]')).toHaveAttribute(
    'aria-label',
    'Copiar 3 itens',
  );

  await page.keyboard.press('e');
  await page.keyboard.press('r');
  expect((await debugState(page)).machines).toEqual(originals);

  await page.locator('[data-action="copy"]').click();
  const copyTarget = pointFor(21, 11);
  await page.mouse.click(copyTarget.x, copyTarget.y);
  await expect.poll(async () => (await debugState(page)).machines).toHaveLength(6);
  await expect.poll(async () => (await debugState(page)).selection.count).toBe(3);

  const afterCopy = (await debugState(page)).machines;
  const copied = afterCopy.slice(-3);
  const signature = (machines: MachineDebugState[]) =>
    machines.map((machine, index) => ({
      type: machine.type,
      angle: machine.angle,
      reversed: machine.reversed,
      deltaX: machine.gridX - machines[0]!.gridX,
      deltaY: machine.gridY - machines[0]!.gridY,
      index,
    }));
  expect(signature(copied)).toEqual(signature(originals));

  await page.locator('[data-action="delete"]').click();
  await expect.poll(async () => (await debugState(page)).machines).toHaveLength(3);
  await expect.poll(async () => (await debugState(page)).selection.count).toBe(0);

  await page.locator('[data-action="undo"]').click();
  await expect.poll(async () => (await debugState(page)).machines).toHaveLength(6);

  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug || debug.selectArea(300, 230, 710, 470) !== 3) {
      throw new Error('Could not reselect original group');
    }
  });
  await page.locator('[data-action="cut"]').click();
  await expect.poll(async () => (await debugState(page)).machines).toHaveLength(3);

  const cutTarget = pointFor(20, 4);
  await page.mouse.click(cutTarget.x, cutTarget.y);
  await expect.poll(async () => (await debugState(page)).machines).toHaveLength(6);
  await expect.poll(async () => (await debugState(page)).selection.count).toBe(3);
  expect(signature((await debugState(page)).machines.slice(-3))).toEqual(signature(originals));
});

test('arrasta todos os itens de uma seleção múltipla como um único grupo', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const originals = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    if (!debug.placeMachine('tracked-conveyor', 8, 6, 25)) {
      throw new Error('Conveyor not placed');
    }
    if (!debug.placeMachine('spring', 11, 8, 0)) throw new Error('Spring not placed');
    if (!debug.placeMachine('tracked-conveyor', 14, 6, 90)) {
      throw new Error('Conveyor not placed');
    }
    return debug.getMachines();
  });

  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  const camera = (await debugState(page)).camera;
  if (!bounds) throw new Error('Canvas has no bounds');
  const pointFor = (gridX: number, gridY: number) => ({
    x: bounds.x + (bounds.width - 30 * 48 * camera.zoom) / 2 + (gridX + 0.5) * 48 * camera.zoom,
    y: bounds.y + (bounds.height - 18 * 48 * camera.zoom) / 2 + (gridY + 0.5) * 48 * camera.zoom,
  });

  const marqueeStart = pointFor(6, 4);
  const marqueeEnd = pointFor(16, 10);
  await page.mouse.move(marqueeStart.x, marqueeStart.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(marqueeEnd.x, marqueeEnd.y, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await expect.poll(async () => (await debugState(page)).selection.count).toBe(3);

  const dragStart = pointFor(8, 6);
  const dragEnd = pointFor(10, 8);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 8 });
  await page.mouse.up();

  const moved = originals.map((machine) => ({
    ...machine,
    gridX: machine.gridX + 2,
    gridY: machine.gridY + 2,
  }));
  await expect.poll(async () => (await debugState(page)).machines).toEqual(moved);
  await expect.poll(async () => (await debugState(page)).selection.count).toBe(3);

  await page.locator('[data-action="undo"]').click();
  await expect.poll(async () => (await debugState(page)).machines).toEqual(originals);
  await page.locator('[data-action="redo"]').click();
  await expect.poll(async () => (await debugState(page)).machines).toEqual(moved);
});

test('descarta todo o movimento coletivo quando um item do grupo colide', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const originals = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    if (!debug.placeMachine('tracked-conveyor', 8, 6)) throw new Error('Conveyor not placed');
    if (!debug.placeMachine('tracked-conveyor', 12, 6)) throw new Error('Conveyor not placed');
    if (!debug.placeMachine('tracked-conveyor', 18, 6)) throw new Error('Target not placed');
    return debug.getMachines();
  });

  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  const camera = (await debugState(page)).camera;
  if (!bounds) throw new Error('Canvas has no bounds');
  const pointFor = (gridX: number, gridY: number) => ({
    x: bounds.x + (bounds.width - 30 * 48 * camera.zoom) / 2 + (gridX + 0.5) * 48 * camera.zoom,
    y: bounds.y + (bounds.height - 18 * 48 * camera.zoom) / 2 + (gridY + 0.5) * 48 * camera.zoom,
  });

  const marqueeStart = pointFor(6, 4);
  const marqueeEnd = pointFor(14, 8);
  await page.mouse.move(marqueeStart.x, marqueeStart.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(marqueeEnd.x, marqueeEnd.y, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await expect.poll(async () => (await debugState(page)).selection.count).toBe(2);

  const dragStart = pointFor(8, 6);
  const invalidEnd = pointFor(14, 6);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(invalidEnd.x, invalidEnd.y, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await debugState(page)).machines).toEqual(originals);
  await expect.poll(async () => (await debugState(page)).selection.count).toBe(2);
});

test('grade alterna encaixe de posição e rotação', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const conveyor = await placeAtCanvasCenter(page, 'tracked-conveyor');
  expect(conveyor.gridX * 4).toBeCloseTo(Math.round(conveyor.gridX * 4), 5);
  expect(conveyor.gridY * 4).toBeCloseTo(Math.round(conveyor.gridY * 4), 5);

  await page.keyboard.press('e');
  await expect
    .poll(async () => (await debugState(page)).machines.find(({ id }) => id === conveyor.id)?.angle)
    .toBe(5);

  const gridToggle = page.locator('[data-action="toggle-grid"]');
  await gridToggle.click();
  await expect(gridToggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await debugState(page)).gridEnabled).toBe(false);

  await page.keyboard.press('e');
  await expect
    .poll(async () => (await debugState(page)).machines.find(({ id }) => id === conveyor.id)?.angle)
    .toBe(6);

  const beforeDrag = (await debugState(page)).machines.find(({ id }) => id === conveyor.id);
  const canvasBounds = await page.locator('#game-container canvas').boundingBox();
  const camera = (await debugState(page)).camera;
  if (!beforeDrag || !canvasBounds) throw new Error('Selected machine or canvas not found');
  const centerX =
    canvasBounds.x +
    (canvasBounds.width - 30 * 48 * camera.zoom) / 2 +
    (beforeDrag.gridX + 0.5) * 48 * camera.zoom;
  const centerY =
    canvasBounds.y +
    (canvasBounds.height - 18 * 48 * camera.zoom) / 2 +
    (beforeDrag.gridY + 0.5) * 48 * camera.zoom;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 17, centerY + 11, { steps: 5 });
  await page.mouse.up();

  const afterDrag = (await debugState(page)).machines.find(({ id }) => id === conveyor.id);
  if (!afterDrag) throw new Error('Dragged machine not found');
  expect(Math.abs(afterDrag.gridX - beforeDrag.gridX)).toBeGreaterThan(0.1);
  expect(Math.abs(afterDrag.gridX % 0.5 || 0)).toBeGreaterThan(0.01);
});

test('seleção não abre painel informativo e protege máquinas fixas', async ({ page }) => {
  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').nth(0).click();
  await expect(page.locator('#menu-screen')).toHaveClass(/is-hidden/);

  for (const type of ['source', 'receiver'] as const) {
    const machine = (await debugState(page)).machines.find((candidate) => candidate.type === type);
    if (!machine) throw new Error(`No ${type} machine was found`);

    await page.evaluate((id) => {
      const debug = (window as DebugWindow).__FACTORY_DEBUG__;
      if (!debug?.selectMachine(id)) throw new Error(`Could not select ${id}`);
    }, machine.id);

    await expect(page.locator('#selection-panel')).toHaveCount(0);
    await expect(page.locator('#selection-dock')).toHaveClass(/is-hidden/);
    await expect(page.locator('[data-action="reverse"]')).toHaveClass(/is-hidden/);
  }
});

test('controle central oferece sete velocidades reais de simulação', async ({ page }) => {
  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').nth(0).click();

  const speed = page.locator('[data-speed]');
  await expect(speed).toHaveAttribute('aria-valuetext', '1×');

  for (let index = 0; index < 7; index += 1) {
    await speed.evaluate((input, value) => {
      (input as HTMLInputElement).value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, index);

    const alignment = await page.locator('.speed-track-shell').evaluate((shell, value) => {
      const shellBounds = shell.getBoundingClientRect();
      const readoutBounds = shell
        .querySelector<HTMLElement>('[data-speed-label]')!
        .getBoundingClientRect();
      const thumbWidth = 44;
      const expectedCenter =
        shellBounds.left + thumbWidth / 2 + (shellBounds.width - thumbWidth) * (value / 6);
      return {
        actualCenter: readoutBounds.left + readoutBounds.width / 2,
        expectedCenter,
      };
    }, index);

    expect(Math.abs(alignment.actualCenter - alignment.expectedCenter)).toBeLessThanOrEqual(1);
  }

  await speed.evaluate((input) => {
    (input as HTMLInputElement).value = '6';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(speed).toHaveAttribute('aria-valuetext', '5×');
  await expect.poll(async () => (await debugState(page)).simulationSpeed).toBe(5);

  await page.locator('[data-action="run"]').click();
  await page.waitForTimeout(400);
  const fastElapsed = await page.evaluate(
    () => (window as DebugWindow).__FACTORY_DEBUG__?.getSimulationSeconds() ?? 0,
  );
  expect(fastElapsed).toBeGreaterThan(0.75);
  await page.locator('[data-action="run"]').click();
  await expect.poll(async () => (await debugState(page)).status).toBe('build');

  await speed.evaluate((input) => {
    (input as HTMLInputElement).value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(speed).toHaveAttribute('aria-valuetext', '0,1×');
  await expect.poll(async () => (await debugState(page)).simulationSpeed).toBe(0.1);

  await page.locator('[data-action="run"]').click();
  await page.waitForTimeout(400);
  const slowElapsed = await page.evaluate(
    () => (window as DebugWindow).__FACTORY_DEBUG__?.getSimulationSeconds() ?? 0,
  );
  expect(slowElapsed).toBeLessThan(0.2);
  await page.locator('[data-action="run"]').click();
  await expect.poll(async () => (await debugState(page)).status).toBe('build');
});

test('play e stop continuam confiáveis durante atualizações da interface', async ({ page }) => {
  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').first().click();

  const control = page.locator('[data-action="run"]');
  const bounds = await control.boundingBox();
  if (!bounds) throw new Error('Controle de simulação sem dimensões');
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;

  const heldClick = async () => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    // A captura atravessa o ciclo de snapshots de 100 ms que antes substituía
    // o SVG sob o ponteiro e fazia o navegador descartar o click.
    await page.waitForTimeout(140);
    await page.mouse.up();
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await heldClick();
    await expect.poll(async () => (await debugState(page)).status).toBe('running');
    await expect(control).toHaveAttribute('aria-label', 'Parar simulação');

    await heldClick();
    await expect.poll(async () => (await debugState(page)).status).toBe('build');
    await expect(control).toHaveAttribute('aria-label', 'Iniciar simulação');
  }
});

test('pause preserva a simulação e retoma sem substituir o stop', async ({ page }) => {
  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').first().click();

  const runControl = page.locator('[data-action="run"]');
  const pauseControl = page.locator('[data-action="pause-toggle"]');
  await expect(pauseControl).toBeHidden();
  const playColors = await runControl.evaluate((button) => {
    const style = getComputedStyle(button);
    return { background: style.backgroundColor, foreground: style.color };
  });
  expect(playColors.foreground).toBe('rgb(255, 255, 255)');

  await runControl.click();
  await expect.poll(async () => (await debugState(page)).status).toBe('running');
  await expect(runControl).toHaveAttribute('aria-label', 'Parar simulação');
  await expect(pauseControl).toBeVisible();
  await expect(pauseControl).toHaveAttribute('aria-label', 'Pausar simulação');

  await pauseControl.click();
  await expect.poll(async () => (await debugState(page)).status).toBe('paused');
  await expect(runControl).toHaveAttribute('aria-label', 'Parar simulação');
  await expect(pauseControl).toHaveAttribute('aria-label', 'Retomar simulação');
  await expect(pauseControl).toHaveClass(/is-resume/);
  await page.mouse.move(0, 0);
  const resumeColors = await pauseControl.evaluate((button) => {
    const style = getComputedStyle(button);
    return { background: style.backgroundColor, foreground: style.color };
  });
  expect(resumeColors).toEqual(playColors);
  await pauseControl.hover();
  await expect
    .poll(() => pauseControl.evaluate((button) => getComputedStyle(button).backgroundColor))
    .toBe('rgb(52, 123, 97)');
  await expect
    .poll(() => pauseControl.evaluate((button) => getComputedStyle(button).color))
    .toBe('rgb(255, 255, 255)');
  const pausedAt = await page.evaluate(
    () => (window as DebugWindow).__FACTORY_DEBUG__?.getSimulationSeconds() ?? 0,
  );
  await page.waitForTimeout(250);
  const stillPausedAt = await page.evaluate(
    () => (window as DebugWindow).__FACTORY_DEBUG__?.getSimulationSeconds() ?? 0,
  );
  expect(stillPausedAt - pausedAt).toBeLessThan(0.03);

  await pauseControl.click();
  await expect.poll(async () => (await debugState(page)).status).toBe('running');
  await expect(pauseControl).toHaveAttribute('aria-label', 'Pausar simulação');

  await runControl.click();
  await expect.poll(async () => (await debugState(page)).status).toBe('build');
  await expect(runControl).toHaveAttribute('aria-label', 'Iniciar simulação');
  await expect(pauseControl).toBeHidden();
});

test('menu de pausa oferece som, opções e salvamento automático ao sair', async ({ page }) => {
  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').first().click();

  const control = page.locator('[data-action="run"]');
  const pauseMenuButton = page.locator('[data-action="pause-menu"]');
  await expect(pauseMenuButton).toHaveCSS('width', '72px');
  await expect(pauseMenuButton).toHaveCSS('height', '72px');
  await expect(pauseMenuButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(pauseMenuButton.locator('svg')).toHaveCSS('width', '52px');
  await expect(pauseMenuButton.locator('svg path')).toHaveAttribute('d', 'M20 12H4m7-7-7 7 7 7');
  await control.click();
  await expect.poll(async () => (await debugState(page)).status).toBe('running');
  await expect(control).toHaveAttribute('aria-label', 'Parar simulação');

  await page.locator('[data-action="pause-menu"]').click();
  await expect(page.locator('#pause-modal')).toBeVisible();
  await expect.poll(async () => (await debugState(page)).status).toBe('paused');

  const pause = page.locator('#pause-modal');
  const sound = pause.locator('[data-action="mute"]');
  const actions = pause.locator('.pause-menu-actions button');
  await expect(pause).not.toContainText('MENU DA SIMULAÇÃO');
  await expect(pause).not.toContainText('Pausado');
  await expect(pause.locator('#pause-title')).toHaveCount(0);
  await expect(pause.locator('[data-action="save-progress"]')).toHaveCount(0);
  await expect(pause.locator('[data-action="fullscreen"]')).toHaveCount(1);
  await expect(actions).toHaveCount(4);
  await expect(actions.nth(0)).toHaveText('Continuar');
  await expect(actions.nth(1)).toHaveText('Opções');
  await expect(actions.nth(2)).toHaveText('Sair para a campanha');
  await expect(actions.nth(3)).toHaveText('Menu principal');
  await expect(actions.nth(0)).toBeFocused();
  await expect(actions.nth(0)).toHaveClass(/main-menu-action/);
  await expect(pause.locator('.pause-card')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(pause.locator('.pause-card')).toHaveCSS('border-top-width', '0px');

  await actions.nth(0).click();
  await expect(pause).toBeHidden();
  await expect.poll(async () => (await debugState(page)).status).toBe('running');
  await page.locator('[data-action="pause-menu"]').click();
  await expect(pause).toBeVisible();
  await expect.poll(async () => (await debugState(page)).status).toBe('paused');

  await expect(sound).toHaveAttribute('aria-label', 'Silenciar');
  await sound.click();
  await expect(sound).toHaveAttribute('aria-label', 'Ativar som');
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

  await actions.nth(1).click();
  await expect(pause).toBeHidden();
  await waitForMenuView(page, 'options');
  await expect(page.locator('#menu-screen')).toHaveClass(/is-pause-options-direct/);
  await expect(page.locator('#menu-screen')).not.toHaveAttribute('data-menu-transitioning', 'true');
  await expect.poll(async () => (await debugState(page)).status).toBe('paused');
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .not.toBeNull();

  await page.locator('[data-menu-panel="options"] [data-action="menu-home"]').click();
  await expect(page.locator('#menu-screen')).toHaveClass(/is-hidden/);
  await expect(pause).toBeVisible();
  await expect(page.locator('#menu-screen')).not.toHaveClass(/is-pause-options-direct/);
  await expect.poll(async () => (await debugState(page)).status).toBe('paused');
});

test('menu de pausa encerra a sessão antes de navegar para campanha ou menu principal', async ({
  page,
}) => {
  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').first().click();

  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API is unavailable');
    debug.run();
    debug.advance(0.5);
  });
  await expect.poll(async () => (await debugState(page)).status).toBe('running');

  await page.locator('[data-action="pause-menu"]').click();
  await page.locator('#pause-modal [data-action="pause-campaign"]').click();
  await waitForMenuView(page, 'play');
  await expect(page.locator('[data-menu-panel="play"]')).toHaveAttribute('aria-hidden', 'false');
  await expect
    .poll(async () => {
      const state = await debugState(page);
      return {
        mode: state.mode,
        status: state.status,
        machines: state.machines.length,
        spent: state.metrics.spent,
        simulationSeconds: await page.evaluate(() =>
          (window as DebugWindow).__FACTORY_DEBUG__!.getSimulationSeconds(),
        ),
      };
    })
    .toEqual({
      mode: 'sandbox',
      status: 'build',
      machines: 0,
      spent: 0,
      simulationSeconds: 0,
    });

  await page.locator('#contract-list .contract-card').first().click();
  const freshCampaign = await debugState(page);
  expect(freshCampaign).toMatchObject({
    mode: 'campaign',
    status: 'build',
    metrics: { delivered: 0, collectedStars: 0, spent: 0 },
  });
  expect(freshCampaign.machines.length).toBeGreaterThan(0);

  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API is unavailable');
    debug.run();
    debug.advance(0.5);
  });
  await page.locator('[data-action="pause-menu"]').click();
  await page.locator('#pause-modal [data-action="pause-home"]').click();
  await waitForMenuView(page, 'home');
  await expect(page.locator('[data-action="menu-play"]')).toBeFocused();
  await expect
    .poll(async () => {
      const state = await debugState(page);
      return {
        mode: state.mode,
        status: state.status,
        machines: state.machines.length,
        boxes: await page.evaluate(
          () => (window as DebugWindow).__FACTORY_DEBUG__!.getBoxes().length,
        ),
      };
    })
    .toEqual({ mode: 'sandbox', status: 'build', machines: 0, boxes: 0 });

  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').first().click();
  await expect
    .poll(async () => {
      const state = await debugState(page);
      return {
        mode: state.mode,
        status: state.status,
        delivered: state.metrics.delivered,
        boxes: await page.evaluate(
          () => (window as DebugWindow).__FACTORY_DEBUG__!.getBoxes().length,
        ),
      };
    })
    .toEqual({ mode: 'campaign', status: 'build', delivered: 0, boxes: 0 });
});

test('exibe o orçamento e só conclui a meta dentro do limite nominal', async ({ page }) => {
  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').first().click();

  const meter = page.locator('#budget-meter');
  const track = meter.locator('[data-budget-track]');
  await expect(meter).not.toHaveClass(/is-hidden/);
  await expect(meter.locator('[data-budget-spent]')).toHaveText('$0');
  await expect(meter.locator('[data-budget-limit]')).toHaveText('$10,000');
  await expect(track).toHaveAttribute('aria-valuenow', '0');
  await expect(track).toHaveAttribute('aria-valuemax', '20000');
  await expect(page.locator('[data-tool="tracked-conveyor"]')).toHaveAttribute(
    'aria-label',
    /Custo \$2,500/,
  );
  await expect(page.locator('[data-metric="time"], [data-result="time"]')).toHaveCount(0);

  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API is unavailable');
    const positions = [
      [18, 4],
      [21, 4],
      [24, 4],
      [27, 4],
    ] as const;
    for (const [gridX, gridY] of positions) {
      if (!debug.placeMachine('tracked-conveyor', gridX, gridY)) {
        throw new Error(`Could not place conveyor at ${gridX}, ${gridY}`);
      }
    }
  });

  await expect(meter.locator('[data-budget-spent]')).toHaveText('$10,000');
  await expect(meter).not.toHaveClass(/is-over-budget/);
  await expect(track).toHaveAttribute('aria-valuenow', '10000');
  await expect
    .poll(() =>
      meter
        .locator('[data-budget-fill]')
        .evaluate((fill) => (fill as HTMLElement).style.getPropertyValue('--budget-fill')),
    )
    .toBe('100%');
  await expect(meter.locator('[data-budget-fill]')).toHaveCSS(
    'background-color',
    'rgb(37, 196, 66)',
  );

  const lastMachineId = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug || !debug.placeMachine('tracked-conveyor', 18, 8)) {
      throw new Error('Could not place the over-budget conveyor');
    }
    const placed = debug.getMachines().filter(({ fixed }) => !fixed);
    return placed.at(-1)?.id;
  });
  expect(lastMachineId).toBeTruthy();

  await expect(meter.locator('[data-budget-spent]')).toHaveText('$12,500');
  await expect(meter).toHaveClass(/is-over-budget/);
  await expect(track).toHaveAttribute('aria-valuenow', '12500');
  await expect(track).toHaveAttribute('aria-valuetext', '$12,500 gastos de $10,000 de orçamento');

  await page.evaluate((machineId) => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug || !machineId || !debug.selectMachine(machineId)) {
      throw new Error('Could not select the conveyor to adjust its cost');
    }
  }, lastMachineId);
  for (const [label, expectedSpent] of [
    ['Velocidade 1', '$12,000'],
    ['Velocidade 3', '$13,000'],
    ['Velocidade 2', '$12,500'],
  ] as const) {
    await page.getByRole('radio', { name: label }).click();
    await expect(meter.locator('[data-budget-spent]')).toHaveText(expectedSpent);
  }

  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API is unavailable');
    debug.completeContract();
  });
  await expect.poll(async () => (await debugState(page)).status).toBe('running');
  await expect(page.locator('#result-modal')).toHaveClass(/is-hidden/);
  await expect(page.locator('#toast')).toContainText('o orçamento foi ultrapassado');

  await page.evaluate((machineId) => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug || !machineId) throw new Error('Factory debug API is unavailable');
    debug.pause();
    if (!debug.selectMachine(machineId) || !debug.deleteSelected()) {
      throw new Error('Could not refund the last conveyor');
    }
    debug.advance(1 / 60);
  }, lastMachineId);

  await expect(page.locator('#result-modal')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('.result-card')).toHaveClass(/is-success/);
  await expect(page.locator('#result-kicker')).toHaveText('FASE 1-1');
  await expect(page.locator('#result-title')).toHaveText('Contrato concluído');
  await expect(page.locator('.result-status-badge')).toHaveCount(0);
  await expect(page.locator('[data-result="delivered"] strong')).toHaveText('8 / 8');
  await expect(page.locator('[data-result="collected-stars"] strong')).toHaveText('1 / 1');
  await expect(page.locator('[data-result="budget"] strong')).toHaveText('$10,000 / $10,000');
  await expect(page.locator('[data-result-budget-percent]')).toHaveText('100%');
  await expect(page.locator('[data-result-budget-track]')).toHaveAttribute('aria-valuenow', '100');
  const resultMetricStyles = await page.evaluate(() => {
    const coin = document.querySelector<HTMLElement>('.result-metric-budget .result-metric-icon')!;
    const budgetFill = document.querySelector<HTMLElement>('[data-result-budget-fill]')!;
    const value = document.querySelector<HTMLElement>('[data-result="delivered"] strong')!;
    return {
      coin: getComputedStyle(coin).backgroundColor,
      budgetFill: getComputedStyle(budgetFill).backgroundColor,
      valueColor: getComputedStyle(value).color,
      valueWeight: Number(getComputedStyle(value).fontWeight),
    };
  });
  expect(resultMetricStyles.coin).toBe('rgb(37, 196, 66)');
  expect(resultMetricStyles.budgetFill).toBe('rgb(37, 196, 66)');
  expect(resultMetricStyles.valueColor).toBe('rgb(52, 77, 99)');
  expect(resultMetricStyles.valueWeight).toBeLessThanOrEqual(760);
  const resultActions = page.locator('.result-actions .main-menu-action');
  await expect(resultActions).toHaveCount(3);
  await expect(resultActions).toHaveText(['Menu', 'Repetir', 'Próximo contrato']);
  await expect(page.locator('#result-summary')).toContainText('dentro do orçamento');
  const resultLayout = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.result-card')!;
    const metricTops = [
      ...document.querySelectorAll<HTMLElement>('.result-metric:not(.is-hidden)'),
    ].map((metric) => metric.getBoundingClientRect().top);
    const actionTops = [...document.querySelectorAll<HTMLElement>('.result-actions button')].map(
      (action) => action.getBoundingClientRect().top,
    );
    return {
      cardBackground: getComputedStyle(card).backgroundColor,
      metricTopSpread: Math.max(...metricTops) - Math.min(...metricTops),
      actionTops,
    };
  });
  expect(resultLayout.cardBackground).toBe('rgba(0, 0, 0, 0)');
  expect(resultLayout.metricTopSpread).toBeLessThan(2);
  expect(resultLayout.actionTops[1]).toBeGreaterThan(resultLayout.actionTops[0]!);
  expect(resultLayout.actionTops[2]).toBeGreaterThan(resultLayout.actionTops[1]!);
});

test('trava novas máquinas no dobro do orçamento e libera verba ao excluir', async ({ page }) => {
  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').first().click();

  const placement = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API is unavailable');
    const positions = [
      [18, 4],
      [21, 4],
      [24, 4],
      [27, 4],
      [18, 8],
      [21, 8],
      [24, 8],
      [27, 8],
    ] as const;
    const accepted = positions.map(([gridX, gridY]) =>
      debug.placeMachine('tracked-conveyor', gridX, gridY),
    );
    const lastId = debug
      .getMachines()
      .filter(({ fixed }) => !fixed)
      .at(-1)?.id;
    const rejectedAtDouble = debug.placeMachine('tracked-conveyor', 30, 8);
    return { accepted, lastId, rejectedAtDouble, snapshot: debug.getSnapshot() };
  });

  expect(placement.accepted).toEqual(Array(8).fill(true));
  expect(placement.rejectedAtDouble).toBe(false);
  expect(placement.snapshot.metrics.spent).toBe(20_000);
  expect(placement.snapshot.economy).toMatchObject({
    spent: 20_000,
    budgetLimit: 10_000,
    hardLimit: 20_000,
  });
  await expect(page.locator('#budget-meter')).toHaveClass(/is-at-hard-limit/);
  await expect(page.locator('[data-budget-spent]')).toHaveText('$20,000');
  await expect(page.locator('[data-tool="tracked-conveyor"]')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.evaluate((machineId) => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug || !machineId || !debug.selectMachine(machineId)) {
      throw new Error('Could not select a conveyor at the hard limit');
    }
  }, placement.lastId);
  await page.getByRole('radio', { name: 'Velocidade 3' }).click();
  await expect.poll(async () => (await debugState(page)).metrics.spent).toBe(20_000);
  await expect(page.getByRole('radio', { name: 'Velocidade 2' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  const replacementAccepted = await page.evaluate((machineId) => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug || !machineId) throw new Error('Factory debug API is unavailable');
    if (!debug.selectMachine(machineId) || !debug.deleteSelected()) {
      throw new Error('Could not delete a conveyor at the hard limit');
    }
    return debug.placeMachine('tracked-conveyor', 30, 8);
  }, placement.lastId);

  expect(replacementAccepted).toBe(true);
  await expect.poll(async () => (await debugState(page)).metrics.spent).toBe(20_000);
});

test('oculta orçamento sem limite e omite estrelas e perdas do HUD', async ({ page }) => {
  await page.route('**/data/contracts.json', async (route) => {
    const response = await route.fetch();
    const catalog = (await response.json()) as {
      contracts: Array<{
        id: string;
        goal: { maxLosses?: number };
        economy: { budgetLimit?: number };
      }>;
    };
    const contract = catalog.contracts.find(({ id }) => id === 'assembly-line');
    if (!contract) throw new Error('Assembly line contract was not found');
    delete contract.goal.maxLosses;
    delete contract.economy.budgetLimit;
    await route.fulfill({ response, json: catalog });
  });

  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').first().click();

  await expect(page.locator('#budget-meter')).toHaveClass(/is-hidden/);
  await expect(page.locator('[data-metric="stars"]')).toHaveCount(0);
  await expect(page.locator('[data-metric="losses"]')).toHaveCount(0);

  const placement = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API is unavailable');
    const positions = [
      [18, 4],
      [21, 4],
      [24, 4],
      [27, 4],
      [18, 8],
      [21, 8],
      [24, 8],
      [27, 8],
      [18, 12],
      [21, 12],
      [24, 12],
      [27, 12],
    ] as const;
    const accepted = positions.map(([gridX, gridY]) =>
      debug.placeMachine('tracked-conveyor', gridX, gridY),
    );
    return { accepted, snapshot: debug.getSnapshot() };
  });

  expect(placement.accepted).toEqual(Array(12).fill(true));
  expect(placement.snapshot.metrics.spent).toBe(30_000);
  expect(placement.snapshot.economy).toEqual({
    spent: 30_000,
    machineCosts: {
      'tracked-conveyor': 2_500,
      spring: 5_000,
    },
  });
  await expect(page.locator('[data-tool="tracked-conveyor"]')).toHaveAttribute(
    'aria-disabled',
    'false',
  );
});

test('play limpa a seleção após arrastar uma máquina da hotbar', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const before = await debugState(page);
  const springButton = page.locator('[data-tool="spring"]');
  const springBounds = await springButton.boundingBox();
  const canvasBounds = await page.locator('#game-container canvas').boundingBox();
  if (!springBounds || !canvasBounds) throw new Error('Hotbar ou canvas sem dimensões');

  await page.mouse.move(
    springBounds.x + springBounds.width / 2,
    springBounds.y + springBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvasBounds.x + canvasBounds.width * 0.36,
    canvasBounds.y + canvasBounds.height * 0.38,
    {
      steps: 12,
    },
  );
  await page.mouse.up();

  await expect
    .poll(async () => (await debugState(page)).machines.length)
    .toBe(before.machines.length + 1);
  const placed = (await debugState(page)).machines.find(
    (machine) => !before.machines.some(({ id }) => id === machine.id),
  );
  if (!placed) throw new Error('Máquina arrastada não foi encontrada');
  expect(placed.type).toBe('spring');
  await expect.poll(async () => (await debugState(page)).selectedMachine?.id).toBe(placed.id);

  await page.locator('[data-action="run"]').click();

  await expect.poll(async () => (await debugState(page)).status).toBe('running');
  await expect.poll(async () => (await debugState(page)).selectedMachine).toBeUndefined();
  await expect
    .poll(async () =>
      page.evaluate(() => (window as DebugWindow).__FACTORY_DEBUG__?.getSimulationSeconds() ?? 0),
    )
    .toBeGreaterThan(0);
});

test('câmera faz pan e limita o zoom entre 100% e 200%', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const before = (await debugState(page)).camera;
  expect(before.zoom).toBeCloseTo(1, 2);
  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Canvas has no bounding box');

  const startX = bounds.x + bounds.width * 0.22;
  const startY = bounds.y + bounds.height * 0.48;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 130, startY + 80, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const camera = (await debugState(page)).camera;
      return Math.hypot(camera.scrollX - before.scrollX, camera.scrollY - before.scrollY);
    })
    .toBeGreaterThan(10);

  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  for (let index = 0; index < 20; index += 1) await page.mouse.wheel(0, 900);
  await expect.poll(async () => (await debugState(page)).camera.zoom).toBeCloseTo(1, 2);

  for (let index = 0; index < 30; index += 1) await page.mouse.wheel(0, -900);
  await expect.poll(async () => (await debugState(page)).camera.zoom).toBeCloseTo(2, 2);

  for (let index = 0; index < 30; index += 1) await page.mouse.wheel(0, 900);
  await expect.poll(async () => (await debugState(page)).camera.zoom).toBeCloseTo(1, 2);

  const beforeResize = (await debugState(page)).camera;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect
    .poll(async () => (await debugState(page)).camera.zoom)
    .toBeCloseTo(beforeResize.zoom, 2);
  await expect
    .poll(async () => {
      const camera = (await debugState(page)).camera;
      return Math.hypot(
        camera.centerX - beforeResize.centerX,
        camera.centerY - beforeResize.centerY,
      );
    })
    .toBeLessThan(0.05);
  await page.mouse.move(960, 540);
  for (let index = 0; index < 20; index += 1) await page.mouse.wheel(0, 900);
  await expect.poll(async () => (await debugState(page)).camera.zoom).toBeCloseTo(1, 2);
});

test('repetir retorna à construção sem iniciar outra simulação', async ({ page }) => {
  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').nth(0).click();

  await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug?.completeContract) throw new Error('Factory debug API is unavailable');
    debug.completeContract();
  });
  await expect(page.locator('#result-modal')).not.toHaveClass(/is-hidden/);

  await page.locator('[data-action="replay"]').click();

  await expect(page.locator('#result-modal')).toHaveClass(/is-hidden/);
  await expect.poll(async () => (await debugState(page)).status).toBe('build');
  await expect(page.locator('[data-action="run"]')).toHaveAttribute(
    'aria-label',
    'Iniciar simulação',
  );
});

test('conclui os três primeiros contratos e restaura o progresso v4', async ({ page }) => {
  test.setTimeout(45_000);
  await openApp(page);
  await openPlayMenu(page);

  for (const contractIndex of [0, 1, 2]) {
    if (contractIndex === 0) {
      await page.locator('#contract-list .contract-card').nth(contractIndex).click();
    }

    await expect.poll(async () => (await debugState(page)).mode).toBe('campaign');
    await page.evaluate(() => {
      const debug = (window as DebugWindow).__FACTORY_DEBUG__;
      if (!debug?.completeContract) {
        throw new Error(
          'window.__FACTORY_DEBUG__.completeContract is required by campaign E2E tests',
        );
      }
      debug.completeContract();
    });
    await expect(page.locator('#result-modal')).not.toHaveClass(/is-hidden/);
    await expect(page.locator('[data-result="budget"] strong')).toHaveText(
      `$0 / $${[10_000, 15_000, 20_000][contractIndex]!.toLocaleString('en-US')}`,
    );

    if (contractIndex < 2) {
      await page.locator('[data-action="next"]').click();
      await expect(page.locator('#result-modal')).toHaveClass(/is-hidden/);
    }
  }

  await page.locator('[data-action="result-menu"]').click();
  await openPlayMenu(page);
  await expect(page.locator('#campaign-progress')).toContainText('3 de 10');
  await expect(page.locator('#contract-list .contract-card:enabled')).toHaveCount(4);

  const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(stored).not.toBeNull();
  const storedProgress = JSON.parse(stored!) as {
    version: number;
    unlockedContracts: string[];
    completedContracts: Record<string, number>;
  };
  expect(storedProgress.version).toBe(5);
  expect(storedProgress.unlockedContracts).toHaveLength(4);
  expect(storedProgress.unlockedContracts).toEqual(
    expect.arrayContaining(['assembly-line', 'quality-curve', 'first-jump']),
  );
  expect(storedProgress.completedContracts).toEqual({
    'assembly-line': 3,
    'quality-curve': 4,
    'first-jump': 5,
  });

  await page.reload();
  await expect(page.locator('#menu-title')).toBeVisible();
  await openPlayMenu(page);
  await expect(page.locator('#campaign-progress')).toContainText('3 de 10');
  await expect(page.locator('#contract-list .contract-card:enabled')).toHaveCount(4);
  await expect(page.locator('#contract-list .contract-card.is-complete')).toHaveCount(3);
  await expect(page.locator('.campaign-stage-marker.is-complete')).toHaveCount(3);
});

test('restaura o layout persistido do sandbox e migra a esteira antiga', async ({ page }) => {
  const legacySandboxMachine = {
    id: 'saved-conveyor',
    type: 'conveyor' as const,
    gridX: 12,
    gridY: 8,
    angle: 17,
    reversed: true,
    fixed: false,
  };
  await openApp(page);
  await page.evaluate(
    ({ key, machine }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 4,
          unlockedContracts: ['assembly-line'],
          completedContracts: {},
          settings: { muted: true, volume: 0.35 },
          sandbox: { machines: [machine], updatedAt: '2026-07-19T12:00:00.000Z' },
        }),
      );
    },
    { key: STORAGE_KEY, machine: legacySandboxMachine },
  );
  await page.reload();
  await expect(page.locator('#menu-title')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as DebugWindow).__FACTORY_DEBUG__));
  await startSandbox(page);

  await expect
    .poll(async () =>
      (await debugState(page)).machines.find(({ id }) => id === legacySandboxMachine.id),
    )
    .toMatchObject({ ...legacySandboxMachine, type: 'tracked-conveyor' });
  await expect(page.locator('#pause-modal [data-action="mute"]')).toHaveAttribute(
    'aria-label',
    'Ativar som',
  );
});

test('mundo expandido aceita e persiste construcoes fora do quadro inicial', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const initial = await debugState(page);
  expect(initial.worldBounds).toEqual({
    minX: -120 * 48,
    minY: -72 * 48,
    maxX: 150 * 48,
    maxY: 90 * 48,
    width: 270 * 48,
    height: 162 * 48,
  });

  const placements = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API is unavailable');
    return {
      negative: debug.placeMachine('source', -10, 8),
      beyondOriginal: debug.placeMachine('receiver', 40, 8),
      outsideLeft: debug.placeMachine('tracked-conveyor', -121, 0),
      outsideRight: debug.placeMachine('tracked-conveyor', 150, 0),
    };
  });

  expect(placements).toEqual({
    negative: true,
    beyondOriginal: true,
    outsideLeft: false,
    outsideRight: false,
  });
  await expect
    .poll(async () => (await debugState(page)).machines)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'source', gridX: -10, gridY: 8 }),
        expect.objectContaining({ type: 'receiver', gridX: 40, gridY: 8 }),
      ]),
    );

  await page.reload();
  await expect(page.locator('#menu-title')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as DebugWindow).__FACTORY_DEBUG__));
  await startSandbox(page);

  await expect
    .poll(async () => (await debugState(page)).machines)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'source', gridX: -10, gridY: 8 }),
        expect.objectContaining({ type: 'receiver', gridX: 40, gridY: 8 }),
      ]),
    );
});
