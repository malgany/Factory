import { expect, test } from '@playwright/test';

test('editor posiciona ferramentas somente ao arrastá-las da paleta', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');
  await page.locator('#admin-toggle').click();
  await page.getByRole('button', { name: 'Editar fase 6-1' }).click();
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('#hotbar')).not.toContainText(/Sem custo|Custo|\$/);
  await expect(page.locator('#editor-rail')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('#editor-rail')).toHaveCSS('box-shadow', 'none');
  const editorBack = page.locator('[data-action="editor-cancel"]');
  await expect(editorBack).toHaveAttribute('aria-label', 'Voltar para a seleção de fases');
  await expect(editorBack).not.toContainText('Cancelar');

  const before = await page.evaluate(() => ({
    machines: window.__FACTORY_DEBUG__!.getMachines().length,
    obstacles: window.__FACTORY_DEBUG__!.getObstacles().length,
    collectibles: window.__FACTORY_DEBUG__!.getEditorDraft().collectibles?.length ?? 0,
  }));

  const canvas = page.locator('#game-container canvas');
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error('Canvas sem dimensões');
  const expectContextOutsideSelection = async (): Promise<void> => {
    await page.waitForTimeout(220);
    const dockBounds = await page.locator('#selection-dock').boundingBox();
    const railBounds = await page.locator('.action-rail').boundingBox();
    const snapshot = await page.evaluate(() => window.__FACTORY_DEBUG__!.getSnapshot());
    const selectedBounds = snapshot.selectionClientBounds;
    if (!dockBounds || !railBounds || !selectedBounds) {
      throw new Error('Controles contextuais sem limites');
    }
    const overlaps = !(
      dockBounds.x + dockBounds.width <= selectedBounds.left ||
      dockBounds.x >= selectedBounds.right ||
      dockBounds.y + dockBounds.height <= selectedBounds.top ||
      dockBounds.y >= selectedBounds.bottom
    );
    expect(overlaps).toBe(false);
    expect(dockBounds.x + dockBounds.width).toBeLessThanOrEqual(railBounds.x - 12);
    const rotationHandle = snapshot.selectionRotationHandleClient;
    if (rotationHandle) {
      const closestX = Math.max(
        dockBounds.x,
        Math.min(rotationHandle.x, dockBounds.x + dockBounds.width),
      );
      const closestY = Math.max(
        dockBounds.y,
        Math.min(rotationHandle.y, dockBounds.y + dockBounds.height),
      );
      expect(Math.hypot(rotationHandle.x - closestX, rotationHandle.y - closestY)).toBeGreaterThanOrEqual(
        rotationHandle.radius + 7,
      );
    }
  };

  const machineTool = page.locator('[data-editor-tool="tracked-conveyor"]');
  await machineTool.click();
  await page.mouse.click(
    canvasBounds.x + canvasBounds.width * 0.32,
    canvasBounds.y + canvasBounds.height * 0.32,
  );
  await expect
    .poll(() => page.evaluate(() => window.__FACTORY_DEBUG__!.getMachines().length))
    .toBe(before.machines);
  await expect(machineTool).not.toHaveClass(/is-active/);

  const dragToolTo = async (selector: string, xRatio: number, yRatio: number): Promise<void> => {
    const toolBounds = await page.locator(selector).boundingBox();
    if (!toolBounds) throw new Error(`Ferramenta ${selector} sem dimensões`);
    await page.mouse.move(
      toolBounds.x + toolBounds.width / 2,
      toolBounds.y + toolBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      canvasBounds.x + canvasBounds.width * xRatio,
      canvasBounds.y + canvasBounds.height * yRatio,
      { steps: 12 },
    );
    await page.mouse.up();
    await expect(page.locator('.factory-app')).not.toHaveClass(/is-dragging-object/);
  };

  await dragToolTo('[data-editor-tool="tracked-conveyor"]', 0.3, 0.34);

  const editorConveyorId = await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__!;
    const conveyor = debug.getMachines().find(({ type }) => type === 'tracked-conveyor');
    if (!conveyor || !debug.selectMachine(conveyor.id)) {
      throw new Error('Editor conveyor could not be selected');
    }
    return { id: conveyor.id, reversed: conveyor.reversed };
  });
  await expect(page.locator('[data-action="reverse"]')).not.toHaveClass(/is-hidden/);
  await expectContextOutsideSelection();
  await page.locator('[data-action="reverse"]').click();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.__FACTORY_DEBUG__!.getMachines().find((machine) => machine.id === id)?.reversed,
        editorConveyorId.id,
      ),
    )
    .toBe(!editorConveyorId.reversed);

  await dragToolTo('[data-editor-tool="obstacle"]', 0.5, 0.44);
  await expectContextOutsideSelection();
  const obstacleBeforeKeys = await page.evaluate(() => {
    const obstacle = window.__FACTORY_DEBUG__!.getObstacles().at(-1);
    if (!obstacle) throw new Error('Editor obstacle was not found');
    return obstacle;
  });
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__FACTORY_DEBUG__!.getObstacles().find((item) => item.id === id),
        obstacleBeforeKeys.id,
      ),
    )
    .toMatchObject({
      gridY: obstacleBeforeKeys.gridY + 0.25,
    });

  await dragToolTo('[data-editor-tool="star"]', 0.68, 0.34);
  await expectContextOutsideSelection();
  const collectibleBeforeKeys = await page.evaluate(() => {
    const collectible = window.__FACTORY_DEBUG__!.getEditorDraft().collectibles?.at(-1);
    if (!collectible) throw new Error('Editor collectible was not found');
    return collectible;
  });
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.__FACTORY_DEBUG__!.getEditorDraft().collectibles?.find(
            (item) => item.id === id,
          ),
        collectibleBeforeKeys.id,
      ),
    )
    .toMatchObject({ gridX: collectibleBeforeKeys.gridX - 0.25 });

  await expect
    .poll(() => page.evaluate(() => window.__FACTORY_DEBUG__!.getMachines().length))
    .toBe(before.machines + 1);
  await expect
    .poll(() => page.evaluate(() => window.__FACTORY_DEBUG__!.getObstacles().length))
    .toBe(before.obstacles + 1);
  await expect
    .poll(() =>
      page.evaluate(() => window.__FACTORY_DEBUG__!.getEditorDraft().collectibles?.length ?? 0),
    )
    .toBe(before.collectibles + 1);
});

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
      availableMachines: ['tracked-conveyor'],
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
      },
      economy: {
        budgetLimit: 15_000,
        machineCosts: { 'tracked-conveyor': 2_500, spring: 5_000 },
      },
      spawnIntervalSeconds: 1,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });

    const placedMachine = debug.placeMachine('tracked-conveyor', 6.5, 6.5, 0);
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
    const placedPlayerMachine = debug.placeMachine('tracked-conveyor', 14.5, 10.5, 0);
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

test('editor preserva posições livres ao abrir e testar uma fase', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');

  const positions = await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    debug.startEditor({
      id: 'free-position-test',
      order: 1,
      title: 'Free position test',
      subtitle: 'Draft',
      description: 'Checks that loading does not snap authored positions.',
      grid: { columns: 30, rows: 18 },
      availableMachines: ['tracked-conveyor'],
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
      obstacles: [
        {
          id: 'free-obstacle',
          gridX: 10.123,
          gridY: 8.456,
          columns: 1,
          rows: 1,
          angle: 0,
        },
      ],
      collectibles: [{ id: 'free-star', type: 'star', gridX: 13.123, gridY: 9.456 }],
      goal: { deliveries: 1, maxLosses: 1 },
      economy: {
        budgetLimit: 15_000,
        machineCosts: { 'tracked-conveyor': 2_500, spring: 5_000 },
      },
      spawnIntervalSeconds: 1,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });

    const opened = debug.getEditorDraft();
    debug.beginEditorPreview();
    const preview = {
      obstacle: debug.getObstacles()[0],
      collectible: debug.getCollectibles()[0],
    };
    debug.returnToEditor();
    const restored = debug.getEditorDraft();
    return {
      opened: { obstacle: opened.obstacles[0], collectible: opened.collectibles[0] },
      preview,
      restored: { obstacle: restored.obstacles[0], collectible: restored.collectibles[0] },
    };
  });

  for (const state of [positions.opened, positions.preview, positions.restored]) {
    expect(state.obstacle).toMatchObject({ gridX: 10.123, gridY: 8.456 });
    expect(state.collectible).toMatchObject({ gridX: 13.123, gridY: 9.456 });
  }
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
      availableMachines: ['tracked-conveyor'],
      fixedMachines: [],
      obstacles: [],
      goal: { deliveries: 1, maxLosses: 3 },
      economy: {
        budgetLimit: 15_000,
        machineCosts: { 'tracked-conveyor': 2_500, spring: 5_000 },
      },
      spawnIntervalSeconds: 1,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });
    document.querySelector('#menu-screen')?.classList.add('is-hidden');
    document.querySelector('#app')?.classList.remove('is-menu-open');
    const gameUi = document.querySelector<HTMLElement>('#game-ui');
    gameUi?.removeAttribute('inert');
    gameUi?.setAttribute('aria-hidden', 'false');
    const gameContainer = document.querySelector<HTMLElement>('#game-container');
    gameContainer?.removeAttribute('inert');
    gameContainer?.setAttribute('aria-hidden', 'false');
    if (!debug.placeMachine('tracked-conveyor', 6, 6, 25)) {
      throw new Error('Machine not placed');
    }
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
      availableMachines: ['tracked-conveyor'],
      fixedMachines: [],
      obstacles: [],
      goal: { deliveries: 1, maxLosses: 3 },
      economy: {
        budgetLimit: 15_000,
        machineCosts: { 'tracked-conveyor': 2_500, spring: 5_000 },
      },
      spawnIntervalSeconds: 1,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });
    document.querySelector('#menu-screen')?.classList.add('is-hidden');
    document.querySelector('#app')?.classList.remove('is-menu-open');
    const gameUi = document.querySelector<HTMLElement>('#game-ui');
    gameUi?.removeAttribute('inert');
    gameUi?.setAttribute('aria-hidden', 'false');
    const gameContainer = document.querySelector<HTMLElement>('#game-container');
    gameContainer?.removeAttribute('inert');
    gameContainer?.setAttribute('aria-hidden', 'false');
    if (!debug.placeMachine('tracked-conveyor', 6, 6, 25)) {
      throw new Error('Machine not placed');
    }
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

test('editor collectible is non-solid, collected once and restored on restart', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');

  const result = await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    debug.startEditor({
      id: 'editor-star-test',
      world: 1,
      stage: 4,
      revision: 1,
      order: 4,
      title: '4-1',
      subtitle: '',
      description: '',
      grid: { columns: 30, rows: 18 },
      availableMachines: ['tracked-conveyor'],
      fixedMachines: [
        {
          id: 'star-source',
          type: 'source',
          gridX: 5.5,
          gridY: 5.5,
          angle: 0,
          reversed: false,
          fixed: true,
        },
      ],
      obstacles: [{ id: 'star-obstacle', gridX: 10, gridY: 10, columns: 2, rows: 2 }],
      collectibles: [],
      goal: { deliveries: 99, maxLosses: 99 },
      economy: {
        budgetLimit: 15_000,
        machineCosts: { 'tracked-conveyor': 2_500, spring: 5_000 },
      },
      spawnIntervalSeconds: 1,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });

    // Deliberately overlap an obstacle: collectibles are sensors, not solid bodies.
    const placed = debug.placeCollectible(10.62, 10.62);
    const snapped = debug.getCollectibles()[0];
    if (!snapped) throw new Error('Star was not placed');
    debug.selectCollectible(snapped.id);
    const deleted = debug.deleteSelected();
    const afterDelete = debug.getCollectibles().length;
    debug.undo();
    const afterUndo = debug.getCollectibles().length;
    debug.redo();
    const afterRedo = debug.getCollectibles().length;
    debug.undo();

    const restored = debug.getCollectibles()[0];
    if (!restored) throw new Error('Star was not restored');
    debug.selectCollectible(restored.id);
    const moved = debug.moveSelectedCollectible(5.5, 6.75);
    const draftCollectible = debug.getEditorDraft().collectibles[0];

    debug.beginEditorPreview();
    const firstPickup = debug.advance(0.15).metrics.collectedStars;
    const stillOnePickup = debug.advance(0.8).metrics.collectedStars;
    debug.reset();
    const afterReset = debug.getSnapshot().metrics.collectedStars;
    const pickupAfterReset = debug.advance(0.15).metrics.collectedStars;
    debug.returnToEditor();

    return {
      placed,
      snapped: { gridX: snapped.gridX, gridY: snapped.gridY },
      deleted,
      afterDelete,
      afterUndo,
      afterRedo,
      moved,
      draftCollectible,
      firstPickup,
      stillOnePickup,
      afterReset,
      pickupAfterReset,
      restoredAfterPreview: debug.getEditorDraft().collectibles[0],
    };
  });

  expect(result).toMatchObject({
    placed: true,
    snapped: { gridX: 10.5, gridY: 10.5 },
    deleted: true,
    afterDelete: 0,
    afterUndo: 1,
    afterRedo: 0,
    moved: true,
    draftCollectible: { type: 'star', gridX: 5.5, gridY: 6.75 },
    firstPickup: 1,
    stillOnePickup: 1,
    afterReset: 0,
    pickupAfterReset: 1,
    restoredAfterPreview: { type: 'star', gridX: 5.5, gridY: 6.75 },
  });
});

test('bloqueador gira e redimensiona pelos pontos laterais e de canto', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');
  await page.locator('#admin-toggle').click();
  await page.getByRole('button', { name: 'Editar fase 6-1' }).click();
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);

  const obstacleId = await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__!;
    const existingObstacleIds = new Set(debug.getObstacles().map(({ id }) => id));
    if (!debug.placeObstacle(10, 6, 2, 2)) throw new Error('Obstacle could not be placed');
    const obstacle = debug.getObstacles().find(({ id }) => !existingObstacleIds.has(id));
    if (!obstacle || !debug.selectObstacle(obstacle.id)) {
      throw new Error('Obstacle could not be selected');
    }
    return obstacle.id;
  });

  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  const camera = await page.evaluate(() => window.__FACTORY_DEBUG__!.getCamera());
  if (!bounds) throw new Error('Canvas has no bounds');
  const screenPoint = (worldX: number, worldY: number) => ({
    x: bounds.x + bounds.width / 2 + (worldX - camera.centerX) * camera.zoom,
    y: bounds.y + bounds.height / 2 + (worldY - camera.centerY) * camera.zoom,
  });
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
  };

  const initialCenter = { x: 11 * 48, y: 7 * 48 };
  await drag(
    screenPoint(initialCenter.x, initialCenter.y - 48 - 38),
    screenPoint(initialCenter.x + 86, initialCenter.y),
  );
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.__FACTORY_DEBUG__!.getObstacles().find((obstacle) => obstacle.id === id)?.angle,
        obstacleId,
      ),
    )
    .toBe(90);

  // At 90 degrees, the local right-side handle is visually below the obstacle.
  await drag(
    screenPoint(initialCenter.x, initialCenter.y + 48),
    screenPoint(initialCenter.x, initialCenter.y + 96),
  );
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__FACTORY_DEBUG__!.getObstacles().find((obstacle) => obstacle.id === id),
        obstacleId,
      ),
    )
    .toMatchObject({ gridX: 9.5, gridY: 6.5, columns: 3, rows: 2, angle: 90 });

  // The rotated bottom-right corner grows both axes while its opposite corner stays anchored.
  await drag(screenPoint(480, 432), screenPoint(432, 480));
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__FACTORY_DEBUG__!.getObstacles().find((obstacle) => obstacle.id === id),
        obstacleId,
      ),
    )
    .toMatchObject({ gridX: 8.5, gridY: 6.5, columns: 4, rows: 3, angle: 90 });

  const rejectedOverlap = await page.evaluate((selectedObstacleId) => {
    const debug = window.__FACTORY_DEBUG__!;
    const first = debug.getObstacles().find(({ id }) => id === selectedObstacleId);
    if (!first) throw new Error('First obstacle could not be found');
    if (!debug.placeObstacle(13, 6, 2, 2)) throw new Error('Second obstacle could not be placed');
    if (!debug.selectObstacle(first.id)) throw new Error('First obstacle could not be selected');
    return debug.resizeSelectedObstacle(8, 3);
  }, obstacleId);
  expect(rejectedOverlap).toBe(false);
});

test('objeto selecionado tem prioridade sobre estrela apenas em seu corpo e controles', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');
  await page.locator('#admin-toggle').click();
  await page.getByRole('button', { name: 'Editar fase 6-1' }).click();
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);
  await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__!;
    const draft = debug.getEditorDraft();
    debug.startEditor({
      ...draft,
      id: 'selection-priority-test',
      availableMachines: ['spring'],
      fixedMachines: [],
      obstacles: [],
      collectibles: [],
    });
  });

  const ids = await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__!;
    const existingMachineIds = new Set(debug.getMachines().map(({ id }) => id));
    const existingStars = new Set(debug.getCollectibles().map(({ id }) => id));
    if (!debug.placeMachine('spring', 10, 10, 0)) throw new Error('Spring could not be placed');
    const spring = debug
      .getMachines()
      .find(({ id, type }) => type === 'spring' && !existingMachineIds.has(id));
    if (!spring) throw new Error('Spring was not found');

    // The first star overlaps the rotation handle (the handle is two pixels below its center).
    if (!debug.placeCollectible(10, 9)) throw new Error('Handle star could not be placed');
    const handleStar = debug.getCollectibles().find(({ id }) => !existingStars.has(id));
    if (!handleStar) throw new Error('Handle star was not found');

    if (!debug.placeCollectible(10, 10)) throw new Error('Center star could not be placed');
    const centerStar = debug
      .getCollectibles()
      .find(({ id }) => !existingStars.has(id) && id !== handleStar.id);
    if (!centerStar) throw new Error('Center star was not found');
    if (!debug.selectMachine(spring.id)) throw new Error('Spring could not be selected');
    return { spring: spring.id, handleStar: handleStar.id, centerStar: centerStar.id };
  });

  const canvas = page.locator('#game-container canvas');
  const bounds = await canvas.boundingBox();
  const camera = await page.evaluate(() => window.__FACTORY_DEBUG__!.getCamera());
  if (!bounds) throw new Error('Canvas has no bounds');
  const screenPoint = (worldX: number, worldY: number) => ({
    x: bounds.x + bounds.width / 2 + (worldX - camera.centerX) * camera.zoom,
    y: bounds.y + bounds.height / 2 + (worldY - camera.centerY) * camera.zoom,
  });
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  };

  // The selected spring's rotation handle wins over the star drawn behind it.
  await drag(screenPoint(504, 458), screenPoint(590, 504));
  await expect
    .poll(() =>
      page.evaluate((testIds) => {
        const debug = window.__FACTORY_DEBUG__!;
        return {
          angle: debug.getMachines().find(({ id }) => id === testIds.spring)?.angle,
          handleStar: debug.getCollectibles().find(({ id }) => id === testIds.handleStar),
        };
      }, ids),
    )
    .toMatchObject({ angle: 90, handleStar: { gridX: 10, gridY: 9 } });

  // The selected spring's body also wins over the star centered behind it.
  await drag(screenPoint(504, 504), screenPoint(552, 504));
  await expect
    .poll(() =>
      page.evaluate((testIds) => {
        const debug = window.__FACTORY_DEBUG__!;
        return {
          spring: debug.getMachines().find(({ id }) => id === testIds.spring),
          centerStar: debug.getCollectibles().find(({ id }) => id === testIds.centerStar),
        };
      }, ids),
    )
    .toMatchObject({
      spring: { gridX: 11, gridY: 10, angle: 90 },
      centerStar: { gridX: 10, gridY: 10 },
    });

  // Once the star is outside the selected object and its controls, it remains directly draggable.
  await drag(screenPoint(516, 504), screenPoint(516, 552));
  await expect
    .poll(() =>
      page.evaluate((testIds) => {
        const debug = window.__FACTORY_DEBUG__!;
        return {
          spring: debug.getMachines().find(({ id }) => id === testIds.spring),
          centerStar: debug.getCollectibles().find(({ id }) => id === testIds.centerStar),
        };
      }, ids),
    )
    .toMatchObject({
      spring: { gridX: 11, gridY: 10, angle: 90 },
      centerStar: { gridX: 10, gridY: 11 },
    });
});

test('prévia do admin mantém o orçamento exato preenchido em verde', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');

  const placement = await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');

    debug.startEditor({
      id: 'budget-preview-test',
      order: 3,
      title: 'Budget preview test',
      subtitle: 'Draft',
      description: 'Checks the budget meter at the exact limit.',
      grid: { columns: 30, rows: 18 },
      availableMachines: ['spring'],
      fixedMachines: [
        {
          id: 'source-budget-test',
          type: 'source',
          gridX: 2.5,
          gridY: 2.5,
          angle: 0,
          reversed: false,
          fixed: true,
        },
        {
          id: 'receiver-budget-test',
          type: 'receiver',
          gridX: 24.5,
          gridY: 14.5,
          angle: 0,
          reversed: false,
          fixed: true,
        },
      ],
      obstacles: [],
      goal: { deliveries: 1, maxLosses: 1 },
      economy: {
        budgetLimit: 5_000,
        machineCosts: { 'tracked-conveyor': 2_500, spring: 5_000 },
      },
      spawnIntervalSeconds: 1,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });
    debug.beginEditorPreview();
    return {
      placed: debug.placeMachine('spring', 12.5, 8.5, 0),
      spent: debug.getSnapshot().metrics.spent,
    };
  });

  expect(placement).toEqual({ placed: true, spent: 5_000 });
  const meter = page.locator('#budget-meter');
  await expect(meter).not.toHaveClass(/is-over-budget/);
  await expect(meter.locator('[data-budget-fill]')).toHaveCSS(
    'background-color',
    'rgb(37, 196, 66)',
  );
  await expect
    .poll(() =>
      meter
        .locator('[data-budget-fill]')
        .evaluate((fill) => (fill as HTMLElement).style.getPropertyValue('--budget-fill')),
    )
    .toBe('100%');
});

test('seleção por área inclui paredes e várias estrelas no editor', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');

  await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');
    debug.startEditor({
      id: 'editor-star-group-test',
      order: 4,
      title: 'Star group selection test',
      subtitle: 'Draft',
      description: 'Checks marquee selection for every editor item.',
      grid: { columns: 30, rows: 18 },
      availableMachines: ['tracked-conveyor'],
      fixedMachines: [],
      obstacles: [],
      collectibles: [],
      goal: { deliveries: 1, maxLosses: 1 },
      economy: {
        budgetLimit: 15_000,
        machineCosts: { 'tracked-conveyor': 2_500, spring: 5_000 },
      },
      spawnIntervalSeconds: 1,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });
    document.querySelector('#menu-screen')?.classList.add('is-hidden');
    document.querySelector('#app')?.classList.remove('is-menu-open');
    document.querySelector<HTMLElement>('#game-ui')?.removeAttribute('inert');
    document.querySelector<HTMLElement>('#game-container')?.removeAttribute('inert');
    if (!debug.placeObstacle(8, 6, 2, 2)) throw new Error('Obstacle not placed');
    if (!debug.placeCollectible(11, 7) || !debug.placeCollectible(13, 9)) {
      throw new Error('Collectibles not placed');
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

  const marqueeStart = pointFor(6, 4);
  const marqueeEnd = pointFor(15, 11);
  await page.mouse.move(marqueeStart.x, marqueeStart.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(marqueeEnd.x, marqueeEnd.y, { steps: 8 });
  await page.mouse.up({ button: 'right' });

  await expect
    .poll(() => page.evaluate(() => window.__FACTORY_DEBUG__!.getSnapshot().selection))
    .toEqual({
      machineIds: [],
      obstacleIds: [expect.any(String)],
      collectibleIds: [expect.any(String), expect.any(String)],
      count: 3,
    });

  const dragStart = pointFor(11.5, 7.5);
  const dragEnd = pointFor(13.5, 10.5);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate(() => ({
        obstacle: window.__FACTORY_DEBUG__!.getObstacles()[0],
        collectibles: window.__FACTORY_DEBUG__!.getCollectibles(),
      })),
    )
    .toMatchObject({
      obstacle: { gridX: 10, gridY: 9 },
      collectibles: [
        { gridX: 13, gridY: 10 },
        { gridX: 15, gridY: 12 },
      ],
    });

  await page.locator('[data-action="copy"]').click();
  const pasteTarget = pointFor(22, 5);
  await page.mouse.click(pasteTarget.x, pasteTarget.y);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        obstacles: window.__FACTORY_DEBUG__!.getObstacles().length,
        collectibles: window.__FACTORY_DEBUG__!.getCollectibles().length,
        selection: window.__FACTORY_DEBUG__!.getSnapshot().selection.count,
      })),
    )
    .toEqual({ obstacles: 2, collectibles: 4, selection: 3 });

  await page.locator('[data-action="delete"]').click();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        obstacles: window.__FACTORY_DEBUG__!.getObstacles().length,
        collectibles: window.__FACTORY_DEBUG__!.getCollectibles().length,
      })),
    )
    .toEqual({ obstacles: 1, collectibles: 2 });
});
