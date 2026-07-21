import { expect, test, type Page } from '@playwright/test';

const STORAGE_KEY = 'factory-flow.progress.v1';

interface MachineDebugState {
  id: string;
  type: 'source' | 'conveyor' | 'receiver' | 'spring';
  gridX: number;
  gridY: number;
  angle: number;
  reversed: boolean;
  fixed: boolean;
}

interface FactoryDebugState {
  mode: 'campaign' | 'sandbox';
  status: 'build' | 'running' | 'paused' | 'success' | 'failure';
  gridEnabled: boolean;
  simulationSpeed: number;
  metrics: { elapsedSeconds: number };
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
    getMachines(): MachineDebugState[];
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
    copySelected(): boolean;
    cutSelected(): boolean;
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
  await expect(page.locator('[data-menu-panel="play"]')).not.toHaveClass(/is-hidden/);
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
  await page.locator(`[data-tool="${tool}"]`).click();

  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Canvas has no bounding box');
  await page.mouse.click(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.42);

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
  await expect(page.locator('#game-ui')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#menu-screen')).not.toHaveAttribute('inert', '');

  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').first().click();
  await page.locator('[data-action="run"]').click();
  await expect.poll(async () => (await debugState(page)).status).toBe('running');
});

test('menu inicial navega entre jogar, opções e sair', async ({ page }) => {
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

  await expect(page.locator('#menu-title')).toHaveText('Factory.');
  await expect(homePanel).not.toHaveClass(/is-hidden/);
  await expect(playPanel).toHaveClass(/is-hidden/);
  await expect(optionsPanel).toHaveClass(/is-hidden/);
  await expect(page.locator('[data-action="menu-play"]')).toHaveText('Jogar');
  await expect(page.locator('[data-action="menu-options"]')).toHaveText('Opções');
  await expect(page.locator('[data-action="menu-exit"]')).toHaveText('Sair');

  await page.locator('[data-action="menu-exit"]').click();
  await expect(homePanel).not.toHaveClass(/is-hidden/);

  await page.locator('[data-action="menu-options"]').click();
  await expect(optionsPanel).not.toHaveClass(/is-hidden/);
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

  await optionsPanel.locator('[data-action="menu-home"]').click();
  await expect(homePanel).not.toHaveClass(/is-hidden/);

  await openPlayMenu(page);
  const contractCards = page.locator('#contract-list .contract-card');
  const contractDots = page.locator('[data-contract-dot]');
  await expect(contractCards).toHaveCount(3);
  await expect(contractDots).toHaveCount(3);
  await expect(contractCards.nth(0)).toBeEnabled();
  await expect(contractCards.nth(0)).not.toHaveClass(/is-locked/);
  await expect(contractCards.nth(1)).toBeDisabled();
  await expect(contractCards.nth(1)).toHaveClass(/is-locked/);
  await expect(contractCards.nth(2)).toBeDisabled();
  await expect(contractCards.nth(2)).toHaveClass(/is-locked/);
  await expect(contractCards.nth(0)).toBeFocused();
  await expect(contractDots.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(contractDots.nth(0)).not.toHaveAttribute('aria-disabled');
  await expect(contractDots.nth(1)).toHaveClass(/is-locked/);
  await expect(contractDots.nth(1)).not.toHaveAttribute('aria-disabled');
  await expect(contractDots.nth(2)).toHaveClass(/is-locked/);
  await expect(contractDots.nth(2)).not.toHaveAttribute('aria-disabled');

  await contractDots.nth(1).click();
  await expect(contractDots.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(contractCards.nth(1)).toHaveClass(/is-current/);
  await expect(page.locator('#menu-screen')).not.toHaveClass(/is-hidden/);
  await expect(playPanel).not.toHaveClass(/is-hidden/);

  await playPanel.locator('[data-action="menu-home"]').click();
  await expect(homePanel).not.toHaveClass(/is-hidden/);
  await expect(page.locator('[data-action="menu-play"]')).toBeFocused();
  await page.locator('[data-action="menu-play"]').click();
  await expect(playPanel).not.toHaveClass(/is-hidden/);
  await expect(contractDots.nth(1)).toBeFocused();

  await expect(page.locator('[data-start-sandbox]')).toBeEnabled();
  await expect(page.locator('#campaign-progress')).toContainText('0 de 3');

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('demonstração do menu usa física lenta e descarta caixas fora da tela', async ({ page }) => {
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
  expect(Number((await demo.getAttribute('data-last-offscreen-x')) ?? 0)).toBeGreaterThan(312);
  expect(Number((await demo.getAttribute('data-active-boxes')) ?? 0)).toBeLessThanOrEqual(1);

  await page.locator('[data-action="menu-play"]').click();
  await expect(demo).toHaveAttribute('data-active', 'false');
  await expect(demo).toHaveAttribute('data-active-boxes', '0');
  await expect(demo.locator('canvas')).toHaveCount(1);

  await page.locator('[data-menu-panel="play"] [data-action="menu-home"]').click();
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

  await expect(page.locator('[data-tool]')).toHaveCount(4);
  const conveyor = await placeAtCanvasCenter(page, 'conveyor');
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
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 24 * camera.zoom, startY + 12 * camera.zoom, { steps: 8 });
  await page.mouse.up();
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

test('copiar e recortar preservam a configuração da máquina selecionada', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const original = await page.evaluate(() => {
    const debug = (window as DebugWindow).__FACTORY_DEBUG__;
    if (!debug || !debug.placeMachine('conveyor', 8, 6, 35)) {
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
    if (!debug.placeMachine('conveyor', 8, 6, 35) || !debug.reverseSelected()) {
      throw new Error('Could not create the configured conveyor');
    }
    if (!debug.placeMachine('spring', 11, 8, 0)) throw new Error('Could not create spring');
    if (!debug.placeMachine('conveyor', 14, 6, 90)) {
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
    if (!debug.placeMachine('conveyor', 8, 6, 25)) throw new Error('Conveyor not placed');
    if (!debug.placeMachine('spring', 11, 8, 0)) throw new Error('Spring not placed');
    if (!debug.placeMachine('conveyor', 14, 6, 90)) throw new Error('Conveyor not placed');
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
    if (!debug.placeMachine('conveyor', 8, 6)) throw new Error('Conveyor not placed');
    if (!debug.placeMachine('conveyor', 12, 6)) throw new Error('Conveyor not placed');
    if (!debug.placeMachine('conveyor', 18, 6)) throw new Error('Target not placed');
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

  const conveyor = await placeAtCanvasCenter(page, 'conveyor');
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
    await expect(page.locator('[data-action="reverse"]')).toHaveCount(0);
  }
});

test('controle central oferece sete velocidades reais de simulação', async ({ page }) => {
  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').nth(0).click();

  const speed = page.locator('[data-speed]');
  await expect(speed).toHaveAttribute('aria-valuetext', '1×');

  await speed.evaluate((input) => {
    (input as HTMLInputElement).value = '6';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(speed).toHaveAttribute('aria-valuetext', '5×');
  await expect.poll(async () => (await debugState(page)).simulationSpeed).toBe(5);

  await page.locator('[data-action="run"]').click();
  await page.waitForTimeout(400);
  const fastElapsed = await page.evaluate(
    () => (window as DebugWindow).__FACTORY_DEBUG__?.getSnapshot().metrics.elapsedSeconds ?? 0,
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
    () => (window as DebugWindow).__FACTORY_DEBUG__?.getSnapshot().metrics.elapsedSeconds ?? 0,
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
    await expect(control).toHaveAttribute('aria-label', 'Reiniciar simulação');

    await heldClick();
    await expect.poll(async () => (await debugState(page)).status).toBe('build');
    await expect(control).toHaveAttribute('aria-label', 'Iniciar simulação');
  }
});

test('menu de pausa interrompe a linha e oferece salvar e configurações', async ({ page }) => {
  await openApp(page);
  await openPlayMenu(page);
  await page.locator('#contract-list .contract-card').first().click();

  const control = page.locator('[data-action="run"]');
  await control.click();
  await expect.poll(async () => (await debugState(page)).status).toBe('running');
  await expect(control).toHaveAttribute('aria-label', 'Reiniciar simulação');

  await page.locator('[data-action="pause-menu"]').click();
  await expect(page.locator('#pause-modal')).toBeVisible();
  await expect(page.locator('#pause-title')).toHaveText('Pausado');
  await expect.poll(async () => (await debugState(page)).status).toBe('paused');

  const sound = page.locator('#pause-modal [data-action="mute"]');
  await expect(page.locator('[data-action="fullscreen"]')).toBeVisible();
  await expect(sound).toHaveAttribute('aria-label', 'Silenciar');
  await sound.click();
  await expect(sound).toHaveAttribute('aria-label', 'Ativar som');
  await page.locator('[data-action="save-progress"]').click();
  const toast = page.locator('#toast');
  await expect(toast).toHaveText('Jogo salvo.');
  await expect(toast).toBeVisible();
  const layerOrder = await page.evaluate(() => ({
    toast: Number(getComputedStyle(document.querySelector('#toast')!).zIndex),
    modal: Number(getComputedStyle(document.querySelector('#pause-modal')!).zIndex),
  }));
  expect(layerOrder.toast).toBeGreaterThan(layerOrder.modal);
  await page.locator('[data-action="menu"]').click();
  await expect(page.locator('#pause-modal')).toBeHidden();
  await expect(page.locator('#menu-screen')).not.toHaveClass(/is-hidden/);
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
  await expect.poll(async () => (await debugState(page)).metrics.elapsedSeconds).toBeGreaterThan(0);
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

test('conclui os três contratos, libera a campanha e restaura o progresso', async ({ page }) => {
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
    await expect(page.locator('#result-stars .is-filled')).toHaveCount(3);

    if (contractIndex < 2) {
      await page.locator('[data-action="next"]').click();
      await expect(page.locator('#result-modal')).toHaveClass(/is-hidden/);
    }
  }

  await page.locator('[data-action="result-menu"]').click();
  await openPlayMenu(page);
  await expect(page.locator('#campaign-progress')).toContainText('3 de 3');
  await expect(page.locator('#contract-list .contract-card:enabled')).toHaveCount(3);

  const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(stored).not.toBeNull();

  await page.reload();
  await expect(page.locator('#menu-title')).toBeVisible();
  await openPlayMenu(page);
  await expect(page.locator('#campaign-progress')).toContainText('3 de 3');
  await expect(page.locator('#contract-list .contract-card:enabled')).toHaveCount(3);
  await expect(page.locator('#contract-list .mini-stars .is-filled')).toHaveCount(9);
});

test('restaura o layout persistido do sandbox', async ({ page }) => {
  const sandboxMachine = {
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
          version: 1,
          unlockedContracts: ['first-flow'],
          bestResults: {},
          settings: { muted: true, volume: 0.35 },
          sandbox: { machines: [machine], updatedAt: '2026-07-19T12:00:00.000Z' },
        }),
      );
    },
    { key: STORAGE_KEY, machine: sandboxMachine },
  );
  await page.reload();
  await expect(page.locator('#menu-title')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as DebugWindow).__FACTORY_DEBUG__));
  await startSandbox(page);

  await expect
    .poll(async () => (await debugState(page)).machines.find(({ id }) => id === sandboxMachine.id))
    .toMatchObject(sandboxMachine);
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
      outsideLeft: debug.placeMachine('conveyor', -121, 0),
      outsideRight: debug.placeMachine('conveyor', 150, 0),
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
