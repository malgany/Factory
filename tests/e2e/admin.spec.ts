import { expect, test, type Page } from '@playwright/test';

const CATALOG_KEY = 'factory-flow.contracts.v1';
const PROGRESS_KEY = 'factory-flow.progress.v1';

interface AdminMachine {
  id: string;
  type: 'source' | 'conveyor' | 'receiver' | 'spring';
  gridX: number;
  gridY: number;
  angle: number;
  reversed: boolean;
  fixed: boolean;
}

interface AdminObstacle {
  id: string;
  gridX: number;
  gridY: number;
  columns: number;
  rows: number;
}

interface AdminContract {
  id: string;
  title: string;
  fixedMachines: AdminMachine[];
  obstacles: AdminObstacle[];
}

type AdminWindow = Window & {
  __FACTORY_DEBUG__?: {
    getSnapshot(): { mode: string; contractId?: string };
    getEditorDraft(): AdminContract;
    getMachines(): AdminMachine[];
    getObstacles(): AdminObstacle[];
    placeMachine(
      type: AdminMachine['type'],
      gridX: number,
      gridY: number,
      angle?: number,
    ): boolean;
    selectMachine(id: string): boolean;
    rotateSelected(angle: number): boolean;
    placeObstacle(gridX: number, gridY: number, columns?: number, rows?: number): boolean;
    selectObstacle(id: string): boolean;
    moveSelectedObstacle(gridX: number, gridY: number): boolean;
    resizeSelectedObstacle(columns: number, rows: number): boolean;
    undo(): void;
    redo(): void;
    beginEditorPreview(): void;
    returnToEditor(): void;
    completeContract(): void;
  };
};

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#menu-title')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as AdminWindow).__FACTORY_DEBUG__));
}

test('cria, testa, persiste e exclui uma fase local sem afetar o progresso', async ({ page }) => {
  await openApp(page);

  const adminToggle = page.locator('#admin-toggle');
  await expect(adminToggle).toBeVisible();
  await expect(adminToggle).toContainText('Ativar admin');
  await expect(page.locator('#create-contract-button')).toHaveClass(/is-hidden/);

  await adminToggle.click();
  await expect(page.locator('#menu-admin-badge')).not.toHaveClass(/is-hidden/);
  await page.locator('#create-contract-button').click();
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('#editor-dirty-state')).toContainText('não salva');

  const draftId = await page.evaluate(() => {
    const debug = (window as AdminWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Admin debug API unavailable');
    if (!debug.placeMachine('source', 3.5, 3.5, 25)) throw new Error('source rejected');
    if (!debug.placeMachine('receiver', 14.5, 10.5, 0)) throw new Error('receiver rejected');
    if (!debug.placeObstacle(8, 5, 2, 2)) throw new Error('obstacle rejected');

    const source = debug.getMachines().find((machine) => machine.type === 'source');
    const obstacle = debug.getObstacles()[0];
    if (!source || !obstacle) throw new Error('Authored entities missing');
    if (!debug.selectMachine(source.id) || !debug.rotateSelected(45)) {
      throw new Error('Source rotation rejected');
    }
    if (!debug.selectObstacle(obstacle.id)) throw new Error('Obstacle selection rejected');
    if (!debug.moveSelectedObstacle(9, 6)) throw new Error('Obstacle move rejected');
    if (!debug.resizeSelectedObstacle(3, 2)) throw new Error('Obstacle resize rejected');
    debug.undo();
    debug.redo();
    const resized = debug.getObstacles()[0];
    if (!resized || !debug.selectObstacle(resized.id)) {
      throw new Error('Obstacle reselection rejected');
    }
    return debug.getEditorDraft().id;
  });
  expect(draftId).toMatch(/^custom-/);

  await expect(page.locator('[data-action="delete"]')).toBeEnabled();
  await page.locator('[data-action="editor-configure"]').first().click();
  await page.locator('#editor-contract-form input[name="title"]').fill('Fluxo de Teste Admin');

  const progressBeforePreview = await page.evaluate((key) => localStorage.getItem(key), PROGRESS_KEY);
  await page.locator('[data-action="editor-test"]').click();
  await expect(page.locator('#editor-preview-bar')).not.toHaveClass(/is-hidden/);
  await page.evaluate(() => {
    const debug = (window as AdminWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Admin debug API unavailable');
    debug.completeContract();
  });
  await expect(page.locator('#result-modal')).toHaveClass(/is-hidden/);
  expect(await page.evaluate((key) => localStorage.getItem(key), PROGRESS_KEY)).toBe(
    progressBeforePreview,
  );
  await page.locator('[data-action="editor-return"]').click();
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);

  await page.locator('[data-action="editor-save"]').click();
  await expect(page.locator('#editor-feedback')).toContainText('Fase salva');
  await expect
    .poll(async () =>
      page.evaluate((key) => {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value).customContracts.length : 0;
      }, CATALOG_KEY),
    )
    .toBe(1);

  await page.locator('[data-action="editor-cancel"]').click();
  await expect(page.locator('#menu-screen')).not.toHaveClass(/is-hidden/);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as AdminWindow).__FACTORY_DEBUG__?.getSnapshot().contractId,
      ),
    )
    .toBeUndefined();
  const progressAfterCancel = await page.evaluate(
    (key) => localStorage.getItem(key),
    PROGRESS_KEY,
  );
  await page.keyboard.press('Space');
  await expect(page.locator('#result-modal')).toHaveClass(/is-hidden/);
  expect(await page.evaluate((key) => localStorage.getItem(key), PROGRESS_KEY)).toBe(
    progressAfterCancel,
  );
  await page.reload();
  await expect(page.locator('#menu-title')).toBeVisible();
  await expect(page.locator('#admin-toggle')).toContainText('Ativar admin');
  await expect(page.locator('#create-contract-button')).toHaveClass(/is-hidden/);
  await expect(page.locator('#contract-list .contract-card')).toHaveCount(4);

  await page.evaluate(
    ({ key, customId }) => {
      const progress = JSON.parse(localStorage.getItem(key) ?? '{}');
      progress.unlockedContracts = [
        'first-flow',
        'controlled-jump',
        'line-rhythm',
        customId,
      ];
      localStorage.setItem(key, JSON.stringify(progress));
    },
    { key: PROGRESS_KEY, customId: draftId },
  );
  await page.reload();
  const customPlayerCard = page.locator('#contract-list .contract-card').last();
  await expect(customPlayerCard).toBeEnabled();
  await customPlayerCard.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as AdminWindow).__FACTORY_DEBUG__?.getSnapshot().contractId,
      ),
    )
    .toBe(draftId);
  expect(
    await page.evaluate(() =>
      (window as AdminWindow).__FACTORY_DEBUG__?.getMachines().every((machine) => machine.fixed),
    ),
  ).toBe(true);
  await page.locator('[data-action="menu"]').click();
  await expect(page.locator('#menu-screen')).not.toHaveClass(/is-hidden/);

  await page.locator('#admin-toggle').click();
  const customEntry = page.locator('.contract-entry').filter({ hasText: 'Fluxo de Teste Admin' });
  await expect(customEntry).toContainText('Personalizada');
  await customEntry.locator('.text-button.danger').click();
  await page.locator('[data-action="admin-confirm-accept"]').click();
  await expect(page.locator('#contract-list .contract-card')).toHaveCount(3);
  expect(
    await page.evaluate((key) => {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value).customContracts.length : -1;
    }, CATALOG_KEY),
  ).toBe(0);
});

test('editar e restaurar uma fase original limpa apenas seu recorde', async ({ page }) => {
  await page.addInitScript(
    ({ key }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 2,
          unlockedContracts: ['first-flow', 'controlled-jump'],
          bestResults: {
            'first-flow': {
              contractId: 'first-flow',
              stars: 3,
              metrics: {
                delivered: 10,
                lost: 0,
                active: 0,
                elapsedSeconds: 20,
                placedPieces: 6,
              },
            },
          },
          settings: { muted: false, volume: 0.65 },
          sandbox: { machines: [], updatedAt: new Date(0).toISOString() },
        }),
      );
    },
    { key: PROGRESS_KEY },
  );
  await openApp(page);
  await page.locator('#admin-toggle').click();
  await page.locator('#contract-list .contract-card').first().click();
  await page.locator('[data-action="editor-configure"]').first().click();
  await page
    .locator('#editor-contract-form input[name="subtitle"]')
    .fill('Versão local do contrato');
  await page.locator('[data-action="editor-save"]').click();
  await expect(page.locator('#editor-feedback')).toContainText('Fase salva');
  await page.locator('[data-action="editor-cancel"]').click();

  const afterEdit = await page.evaluate(
    ({ catalogKey, progressKey }) => ({
      catalog: JSON.parse(localStorage.getItem(catalogKey) ?? '{}'),
      progress: JSON.parse(localStorage.getItem(progressKey) ?? '{}'),
    }),
    { catalogKey: CATALOG_KEY, progressKey: PROGRESS_KEY },
  );
  expect(afterEdit.catalog.overrides['first-flow']).toBeTruthy();
  expect(afterEdit.progress.bestResults['first-flow']).toBeUndefined();
  expect(afterEdit.progress.unlockedContracts).toContain('controlled-jump');

  const originalEntry = page.locator('.contract-entry').filter({ hasText: 'Primeiro Fluxo' });
  await expect(originalEntry).toContainText('Alterada');
  await originalEntry.locator('.text-button').click();
  await page.locator('[data-action="admin-confirm-accept"]').click();

  await expect(originalEntry).toContainText('Original');
  expect(
    await page.evaluate((key) => {
      const catalog = JSON.parse(localStorage.getItem(key) ?? '{}');
      return catalog.overrides?.['first-flow'];
    }, CATALOG_KEY),
  ).toBeUndefined();
});
