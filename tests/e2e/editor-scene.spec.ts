import { expect, test } from '@playwright/test';

test('editor keeps authored scenario fixed and restores it after a disposable preview', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');

  const result = await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');

    const progressBeforePreview = window.localStorage.getItem('factory-flow.progress.v1');
    debug.startEditor({
      id: 'editor-scene-test',
      order: 4,
      title: 'Editor scene test',
      subtitle: 'Draft',
      description: 'Checks authoring state isolation.',
      grid: { columns: 30, rows: 18 },
      availableMachines: ['conveyor'],
      fixedMachines: [
        {
          id: 'source-test',
          type: 'source',
          gridX: 2.5,
          gridY: 2.5,
          angle: 0,
          reversed: false,
          fixed: true,
        },
        {
          id: 'receiver-test',
          type: 'receiver',
          gridX: 24.5,
          gridY: 14.5,
          angle: 0,
          reversed: false,
          fixed: true,
        },
      ],
      obstacles: [],
      goal: {
        deliveries: 1,
        maxLosses: 1,
        pieceBudget: 3,
        parPieces: 1,
      },
      spawnIntervalSeconds: 1,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });

    const placedMachine = debug.placeMachine('conveyor', 6.5, 6.5, 0);
    const placedObstacle = debug.placeObstacle(10, 8, 2, 2);
    const obstacle = debug.getObstacles()[0];
    if (!obstacle) throw new Error('Obstacle was not created');
    debug.selectObstacle(obstacle.id);
    const resizedObstacle = debug.resizeSelectedObstacle(3, 2);
    debug.undo();
    const sizeAfterUndo = debug.getObstacles()[0]?.columns;
    debug.redo();
    const sizeAfterRedo = debug.getObstacles()[0]?.columns;

    debug.selectMachine('source-test');
    const rotatedEndpoint = debug.rotateSelected(45);
    const authoringDraft = debug.getEditorDraft();
    debug.beginEditorPreview();
    const previewMode = debug.getSnapshot().mode;
    debug.selectMachine('source-test');
    const deletedFixedEndpoint = debug.deleteSelected();
    const placedPlayerMachine = debug.placeMachine('conveyor', 14.5, 10.5, 0);
    const previewMachineCount = debug.getMachines().length;
    debug.run();
    debug.completeContract();
    const previewResolution = debug.getSnapshot().status;
    const runButton = document.querySelector<HTMLButtonElement>('[data-action="run"]');
    if (!runButton) throw new Error('Simulation control was not found');
    const terminalRunButtonDisabled = runButton.disabled;
    runButton.click();
    const restartedFromTerminalWithButton = debug.getSnapshot().status;
    const progressAfterPreview = window.localStorage.getItem('factory-flow.progress.v1');
    debug.returnToEditor();

    return {
      placedMachine,
      placedObstacle,
      resizedObstacle,
      sizeAfterUndo,
      sizeAfterRedo,
      rotatedEndpoint,
      authoringMode: authoringDraft.fixedMachines.every((machine) => machine.fixed),
      previewMode,
      deletedFixedEndpoint,
      placedPlayerMachine,
      previewMachineCount,
      previewResolution,
      terminalRunButtonDisabled,
      restartedFromTerminalWithButton,
      previewChangedProgress: progressAfterPreview !== progressBeforePreview,
      restoredMode: debug.getSnapshot().mode,
      restoredMachineCount: debug.getMachines().length,
      restoredObstacleColumns: debug.getObstacles()[0]?.columns,
    };
  });

  expect(result).toEqual({
    placedMachine: true,
    placedObstacle: true,
    resizedObstacle: true,
    sizeAfterUndo: 2,
    sizeAfterRedo: 3,
    rotatedEndpoint: true,
    authoringMode: true,
    previewMode: 'preview',
    deletedFixedEndpoint: false,
    placedPlayerMachine: true,
    previewMachineCount: 4,
    previewResolution: 'success',
    terminalRunButtonDisabled: false,
    restartedFromTerminalWithButton: 'running',
    previewChangedProgress: false,
    restoredMode: 'editor',
    restoredMachineCount: 3,
    restoredObstacleColumns: 3,
  });
});

test('editor copia e exclui seleção mista de máquina e bloqueador', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');

  await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    debug.startEditor({
      id: 'editor-group-selection-test',
      order: 5,
      title: 'Group selection test',
      subtitle: 'Draft',
      description: 'Checks mixed group operations.',
      grid: { columns: 30, rows: 18 },
      availableMachines: ['conveyor'],
      fixedMachines: [],
      obstacles: [],
      goal: { deliveries: 1, maxLosses: 3, pieceBudget: 6, parPieces: 2 },
      spawnIntervalSeconds: 1,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });
    document.querySelector('#menu-screen')?.classList.add('is-hidden');
    document.querySelector('#app')?.classList.remove('is-menu-open');
    const gameUi = document.querySelector<HTMLElement>('#game-ui');
    gameUi?.removeAttribute('inert');
    gameUi?.setAttribute('aria-hidden', 'false');
    if (!debug.placeMachine('conveyor', 6, 6, 25)) throw new Error('Machine not placed');
    if (!debug.placeObstacle(10, 6, 2, 2)) throw new Error('Obstacle not placed');
    if (debug.selectArea(200, 230, 600, 410) !== 2) {
      throw new Error('Mixed selection was not created');
    }
  });

  await expect(page.locator('[data-action="copy"]')).toHaveAttribute(
    'aria-label',
    'Copiar 2 itens',
  );
  await page.locator('[data-action="copy"]').click();

  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  const camera = await page.evaluate(() => window.__FACTORY_DEBUG__!.getCamera());
  if (!bounds) throw new Error('Canvas has no bounds');
  const target = {
    x: bounds.x + (bounds.width - 30 * 48 * camera.zoom) / 2 + 18.5 * 48 * camera.zoom,
    y: bounds.y + (bounds.height - 18 * 48 * camera.zoom) / 2 + 10.5 * 48 * camera.zoom,
  };
  await page.mouse.click(target.x, target.y);

  await expect
    .poll(async () =>
      page.evaluate(() => ({
        machines: window.__FACTORY_DEBUG__!.getMachines().length,
        obstacles: window.__FACTORY_DEBUG__!.getObstacles().length,
        selection: window.__FACTORY_DEBUG__!.getSnapshot().selection.count,
      })),
    )
    .toEqual({ machines: 2, obstacles: 2, selection: 2 });

  await page.locator('[data-action="delete"]').click();
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        machines: window.__FACTORY_DEBUG__!.getMachines().length,
        obstacles: window.__FACTORY_DEBUG__!.getObstacles().length,
      })),
    )
    .toEqual({ machines: 1, obstacles: 1 });

  await page.locator('[data-action="undo"]').click();
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        machines: window.__FACTORY_DEBUG__!.getMachines().length,
        obstacles: window.__FACTORY_DEBUG__!.getObstacles().length,
      })),
    )
    .toEqual({ machines: 2, obstacles: 2 });
});

test('editor arrasta máquina e bloqueador selecionados em uma única operação', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');

  await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    debug.startEditor({
      id: 'editor-group-drag-test',
      order: 6,
      title: 'Group drag test',
      subtitle: 'Draft',
      description: 'Checks mixed group dragging.',
      grid: { columns: 30, rows: 18 },
      availableMachines: ['conveyor'],
      fixedMachines: [],
      obstacles: [],
      goal: { deliveries: 1, maxLosses: 3, pieceBudget: 6, parPieces: 2 },
      spawnIntervalSeconds: 1,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });
    document.querySelector('#menu-screen')?.classList.add('is-hidden');
    document.querySelector('#app')?.classList.remove('is-menu-open');
    const gameUi = document.querySelector<HTMLElement>('#game-ui');
    gameUi?.removeAttribute('inert');
    gameUi?.setAttribute('aria-hidden', 'false');
    if (!debug.placeMachine('conveyor', 6, 6, 25)) throw new Error('Machine not placed');
    if (!debug.placeObstacle(10, 6, 2, 2)) throw new Error('Obstacle not placed');
    if (debug.selectArea(200, 230, 600, 410) !== 2) {
      throw new Error('Mixed selection was not created');
    }
  });

  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  const camera = await page.evaluate(() => window.__FACTORY_DEBUG__!.getCamera());
  if (!bounds) throw new Error('Canvas has no bounds');
  const pointFor = (gridX: number, gridY: number) => ({
    x: bounds.x + (bounds.width - 30 * 48 * camera.zoom) / 2 + gridX * 48 * camera.zoom,
    y: bounds.y + (bounds.height - 18 * 48 * camera.zoom) / 2 + gridY * 48 * camera.zoom,
  });

  const start = pointFor(6.5, 6.5);
  const end = pointFor(8.5, 8.5);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();

  const state = () =>
    page.evaluate(() => ({
      machine: window.__FACTORY_DEBUG__!.getMachines()[0],
      obstacle: window.__FACTORY_DEBUG__!.getObstacles()[0],
      selection: window.__FACTORY_DEBUG__!.getSnapshot().selection.count,
    }));
  await expect.poll(state).toMatchObject({
    machine: { gridX: 8, gridY: 8, angle: 25 },
    obstacle: { gridX: 12, gridY: 8, columns: 2, rows: 2 },
    selection: 2,
  });

  await page.locator('[data-action="undo"]').click();
  await expect.poll(state).toMatchObject({
    machine: { gridX: 6, gridY: 6, angle: 25 },
    obstacle: { gridX: 10, gridY: 6, columns: 2, rows: 2 },
    selection: 0,
  });
  await page.locator('[data-action="redo"]').click();
  await expect.poll(state).toMatchObject({
    machine: { gridX: 8, gridY: 8, angle: 25 },
    obstacle: { gridX: 12, gridY: 8, columns: 2, rows: 2 },
    selection: 0,
  });
});
