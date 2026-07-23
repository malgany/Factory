import { expect, test } from '@playwright/test';

test('a entrada recebe a caixa assim que os contornos visuais se encostam', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));

  const snapshot = await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');

    debug.startEditor({
      id: 'receiver-hitbox-test',
      world: 1,
      stage: 4,
      revision: 1,
      order: 4,
      title: 'Receiver hitbox test',
      subtitle: '',
      description: '',
      grid: { columns: 30, rows: 18 },
      availableMachines: ['tracked-conveyor'],
      fixedMachines: [
        {
          id: 'hitbox-source',
          type: 'source',
          gridX: 4.25,
          gridY: 4.25,
          angle: 0,
          reversed: false,
          fixed: true,
        },
        {
          id: 'hitbox-receiver',
          type: 'receiver',
          gridX: 4.25,
          gridY: 6,
          angle: 0,
          reversed: false,
          fixed: true,
        },
      ],
      obstacles: [],
      collectibles: [],
      goal: { deliveries: 1, maxLosses: 1 },
      economy: {
        budgetLimit: 10_000,
        machineCosts: { 'tracked-conveyor': 2_500, spring: 5_000 },
      },
      spawnIntervalSeconds: 0.8,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });
    debug.beginEditorPreview();
    return debug.advance(0.82);
  });

  expect(snapshot.metrics.delivered).toBe(1);
  expect(snapshot.metrics.active).toBe(0);
  expect(snapshot.status).toBe('success');
});

test('o trampolim espera a caixa alcançar a superfície antes de impulsioná-la', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__FACTORY_DEBUG__));

  const result = await page.evaluate(() => {
    const debug = window.__FACTORY_DEBUG__;
    if (!debug) throw new Error('Factory debug API was not installed');

    debug.startEditor({
      id: 'spring-hitbox-test',
      world: 1,
      stage: 4,
      revision: 1,
      order: 4,
      title: 'Spring hitbox test',
      subtitle: '',
      description: '',
      grid: { columns: 30, rows: 18 },
      availableMachines: ['spring'],
      fixedMachines: [
        {
          id: 'spring-source',
          type: 'source',
          gridX: 4.25,
          gridY: 4.25,
          angle: 0,
          reversed: false,
          fixed: true,
        },
        {
          id: 'spring-target',
          type: 'spring',
          gridX: 4.25,
          gridY: 6,
          angle: 0,
          reversed: false,
          fixed: true,
        },
      ],
      obstacles: [],
      collectibles: [],
      goal: { deliveries: 1, maxLosses: 1 },
      economy: {
        budgetLimit: 10_000,
        machineCosts: { 'tracked-conveyor': 2_500, spring: 5_000 },
      },
      spawnIntervalSeconds: 0.8,
      initialCamera: { centerX: 720, centerY: 432, zoom: 1 },
    });
    debug.beginEditorPreview();
    debug.advance(1 / 60);
    const beforeContact = debug.getBoxes()[0];
    debug.advance(0.25);
    const afterContact = debug.getBoxes()[0];

    return { beforeContact, afterContact };
  });

  expect(result.beforeContact?.velocityY).toBeGreaterThan(0);
  expect(result.afterContact?.velocityY).toBeLessThan(0);
});
