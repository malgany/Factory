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
  machines: MachineDebugState[];
  selectedMachine?: MachineDebugState;
  camera: {
    zoom: number;
    scrollX: number;
    scrollY: number;
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
    completeContract(): void;
  };
};

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#menu-title')).toBeVisible();
  await expect(page.locator('canvas')).toBeAttached();
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

async function startSandbox(page: Page): Promise<void> {
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

  const canvas = page.locator('canvas');
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

test('menu inicial apresenta campanha progressiva e sandbox', async ({ page }) => {
  const pageErrors: Error[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await openApp(page);

  await expect(page.locator('#menu-title')).toHaveText('Factory');
  await expect(page.locator('#contract-list .contract-card')).toHaveCount(3);
  await expect(page.locator('#contract-list .contract-card').nth(0)).toBeEnabled();
  await expect(page.locator('#contract-list .contract-card').nth(1)).toBeDisabled();
  await expect(page.locator('#contract-list .contract-card').nth(2)).toBeDisabled();
  await expect(page.locator('[data-start-sandbox]')).toBeEnabled();
  await expect(page.locator('#campaign-progress')).toContainText('0 de 3');

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('sandbox permite colocar, girar, inverter e desfazer/refazer', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  await expect(page.locator('[data-tool]')).toHaveCount(4);
  const conveyor = await placeAtCanvasCenter(page, 'conveyor');
  await expect(page.locator('#selection-panel')).toHaveCount(0);
  await expect(page.locator('[data-action="delete"]')).toBeEnabled();

  const canvas = page.locator('canvas');
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
  await page.mouse.move(startX + 24 * camera.zoom, startY + 24 * camera.zoom, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await debugState(page)).machines.find(({ id }) => id === conveyor.id)?.gridX)
    .toBe(conveyor.gridX + 0.5);
  await expect
    .poll(async () => (await debugState(page)).machines.find(({ id }) => id === conveyor.id)?.gridY)
    .toBe(conveyor.gridY + 0.5);

  await page.keyboard.press('e');
  await expect
    .poll(async () => (await debugState(page)).machines.find(({ id }) => id === conveyor.id)?.angle)
    .toBe(5);

  await page.locator('[data-action="reverse"]').click();
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

test('grade alterna encaixe de posição e rotação', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const conveyor = await placeAtCanvasCenter(page, 'conveyor');
  expect(conveyor.gridX * 2).toBeCloseTo(Math.round(conveyor.gridX * 2), 5);
  expect(conveyor.gridY * 2).toBeCloseTo(Math.round(conveyor.gridY * 2), 5);

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
  const canvasBounds = await page.locator('canvas').boundingBox();
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
    await expect(page.locator('[data-action="delete"]')).toBeDisabled();
    await expect(page.locator('[data-action="reverse"]')).toBeDisabled();
  }
});

test('controle central oferece sete velocidades reais de simulação', async ({ page }) => {
  await openApp(page);
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
  await page.locator('[data-action="run"]').click();
  const fastElapsed = await page.evaluate(
    () => (window as DebugWindow).__FACTORY_DEBUG__?.getSnapshot().metrics.elapsedSeconds ?? 0,
  );
  expect(fastElapsed).toBeGreaterThan(0.75);

  await page.locator('[data-action="reset"]').click();
  await speed.evaluate((input) => {
    (input as HTMLInputElement).value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(speed).toHaveAttribute('aria-valuetext', '0,1×');
  await expect.poll(async () => (await debugState(page)).simulationSpeed).toBe(0.1);

  await page.locator('[data-action="run"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-action="run"]').click();
  const slowElapsed = await page.evaluate(
    () => (window as DebugWindow).__FACTORY_DEBUG__?.getSnapshot().metrics.elapsedSeconds ?? 0,
  );
  expect(slowElapsed).toBeLessThan(0.2);
});

test('um clique sempre alterna entre simular e pausar', async ({ page }) => {
  await openApp(page);
  await page.locator('#contract-list .contract-card').first().click();

  const control = page.locator('[data-action="run"]');
  for (let index = 0; index < 12; index += 1) {
    await control.click();
    const expectedStatus = index % 2 === 0 ? 'running' : 'paused';
    await expect.poll(async () => (await debugState(page)).status).toBe(expectedStatus);
    await expect(control).toHaveAttribute(
      'aria-label',
      expectedStatus === 'running' ? 'Pausar simulação' : 'Continuar simulação',
    );
  }
});

test('play limpa a seleção após arrastar uma máquina da hotbar', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const before = await debugState(page);
  const springButton = page.locator('[data-tool="spring"]');
  const springBounds = await springButton.boundingBox();
  const canvasBounds = await page.locator('canvas').boundingBox();
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

  await expect(page.locator('#status-label')).toHaveText('Simulando');
  await expect.poll(async () => (await debugState(page)).status).toBe('running');
  await expect.poll(async () => (await debugState(page)).selectedMachine).toBeUndefined();
  await expect.poll(async () => (await debugState(page)).metrics.elapsedSeconds).toBeGreaterThan(0);
});

test('câmera faz pan e limita o zoom entre 100% e 200%', async ({ page }) => {
  await openApp(page);
  await startSandbox(page);

  const before = (await debugState(page)).camera;
  expect(before.zoom).toBeCloseTo(1, 2);
  const canvas = page.locator('canvas');
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

  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(async () => (await debugState(page)).camera.zoom).toBeCloseTo(1.12, 2);
  await page.mouse.move(960, 540);
  for (let index = 0; index < 20; index += 1) await page.mouse.wheel(0, 900);
  await expect.poll(async () => (await debugState(page)).camera.zoom).toBeCloseTo(1, 2);
});

test('repetir retorna à construção sem iniciar outra simulação', async ({ page }) => {
  await openApp(page);
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
  await expect(page.locator('#campaign-progress')).toContainText('3 de 3');
  await expect(page.locator('#contract-list .contract-card:enabled')).toHaveCount(3);

  const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(stored).not.toBeNull();

  await page.reload();
  await expect(page.locator('#menu-title')).toBeVisible();
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
  await expect(page.locator('[data-action="mute"]')).toHaveAttribute('aria-label', 'Ativar som');
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
