import { expect, test } from '@playwright/test';

test('editor keeps authored scenario fixed and restores it after a disposable preview', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));

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
    previewChangedProgress: false,
    restoredMode: 'editor',
    restoredMachineCount: 3,
    restoredObstacleColumns: 3,
  });
});
