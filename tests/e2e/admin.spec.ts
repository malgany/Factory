import { expect, test, type Page } from '@playwright/test';

const PROGRESS_KEY = 'factory-flow.progress.v1';
const LEGACY_CATALOG_KEY = 'factory-flow.contracts.v1';

type AdminMachineType =
  | 'source'
  | 'conveyor'
  | 'slow-conveyor'
  | 'tracked-conveyor'
  | 'fast-conveyor'
  | 'receiver'
  | 'spring'
  | 'turbo-spring';

interface AdminCamera {
  centerX: number;
  centerY: number;
  zoom: number;
}

interface AdminCameraSnapshot extends AdminCamera {
  scrollX: number;
  scrollY: number;
}

interface AdminMachine {
  id: string;
  type: AdminMachineType;
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
  angle?: number;
}

interface AdminContract {
  id: string;
  world: number;
  stage: number;
  revision: number;
  order: number;
  title: string;
  subtitle: string;
  description: string;
  grid: { columns: number; rows: number };
  availableMachines: AdminMachineType[];
  fixedMachines: AdminMachine[];
  obstacles: AdminObstacle[];
  collectibles: Array<{
    type: 'star';
    id: string;
    gridX: number;
    gridY: number;
  }>;
  goal: {
    deliveries: number;
    maxLosses?: number;
  };
  economy: {
    budgetLimit?: number;
    machineCosts: {
      'tracked-conveyor': number;
      spring: number;
      'turbo-spring'?: number;
    };
    conveyorSpeedCosts?: {
      slow: number;
      normal: number;
      fast: number;
    };
  };
  spawnIntervalSeconds: number;
  initialCamera: AdminCamera;
}

interface AdminCatalog {
  version: 4;
  worlds: Array<{
    world: number;
    backgroundColor: string;
    gridColor: string;
  }>;
  updatedAt: string;
  contracts: AdminContract[];
}

type AdminWindow = Window & {
  __FACTORY_DEBUG__?: {
    getSnapshot(): { mode: string; contractId?: string };
    getBoardTheme(): { backgroundColor: string; gridColor: string };
    getEditorDraft(): AdminContract;
    startEditor(contract: AdminContract): void;
    getInvalidEntityFlash(): {
      machineIds: string[];
      obstacleIds: string[];
      collectibleIds: string[];
      remainingMs: number;
    };
    getEditorHitboxesVisible(): boolean;
    getMachines(): AdminMachine[];
    getObstacles(): AdminObstacle[];
    getCamera(): AdminCameraSnapshot;
    setCamera(centerX: number, centerY: number, zoom: number): void;
    placeMachine(type: AdminMachineType, gridX: number, gridY: number, angle?: number): boolean;
    selectMachine(id: string): boolean;
    rotateSelected(angle: number): boolean;
    placeObstacle(gridX: number, gridY: number, columns?: number, rows?: number): boolean;
    placeCollectible(gridX: number, gridY: number): boolean;
    selectObstacle(id: string): boolean;
    moveSelectedObstacle(gridX: number, gridY: number): boolean;
    resizeSelectedObstacle(columns: number, rows: number): boolean;
    undo(): void;
    redo(): void;
    completeContract(): void;
  };
};

interface CatalogHarness {
  current(): AdminCatalog;
  posts(): AdminCatalog[];
  holdNextPostUntilRelease(): () => void;
  failNextPostAfterRelease(message: string): () => void;
}

interface PendingPost {
  failureMessage?: string;
  wait: Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeContract(
  id: string,
  stage: number,
  initialCamera: AdminCamera = { centerX: 720, centerY: 432, zoom: 1 },
  world = 1,
): AdminContract {
  const title = `${stage}-${world}`;
  return {
    id,
    world,
    stage,
    revision: 1,
    order: (world - 1) * 10 + stage,
    title,
    subtitle: `Subtítulo de ${title}`,
    description: `Descrição de ${title}`,
    grid: { columns: 30, rows: 18 },
    availableMachines: ['tracked-conveyor', 'spring'],
    fixedMachines: [
      {
        id: `${id}-source`,
        type: 'source',
        gridX: 4.25,
        gridY: 4.25,
        angle: 0,
        reversed: false,
        fixed: true,
      },
      {
        id: `${id}-receiver`,
        type: 'receiver',
        gridX: 19.25,
        gridY: 12.25,
        angle: 0,
        reversed: false,
        fixed: true,
      },
    ],
    obstacles: [],
    collectibles: [],
    goal: {
      deliveries: 10,
      maxLosses: 3,
    },
    economy: {
      budgetLimit: 25_000,
      machineCosts: {
        'tracked-conveyor': 2_500,
        spring: 5_000,
      },
    },
    spawnIntervalSeconds: 1.25,
    initialCamera: { ...initialCamera },
  };
}

function makeCatalog(...contracts: AdminContract[]): AdminCatalog {
  const highestWorld = Math.max(1, ...contracts.map(({ world }) => world));
  return normalizeHarnessCatalog({
    version: 4,
    worlds: Array.from({ length: highestWorld }, (_, index) => ({
      world: index + 1,
      backgroundColor: '#377fbd',
      gridColor: '#ffffff',
    })),
    updatedAt: new Date(0).toISOString(),
    contracts,
  });
}

function normalizeHarnessCatalog(catalog: AdminCatalog): AdminCatalog {
  const normalized = clone(catalog);
  normalized.worlds = [...normalized.worlds].sort((left, right) => left.world - right.world);
  normalized.contracts = [...normalized.contracts]
    .sort(
      (left, right) =>
        left.world - right.world || left.stage - right.stage || left.id.localeCompare(right.id),
    )
    .map((contract) => ({
      ...contract,
      order: (contract.world - 1) * 10 + contract.stage,
    }));
  return normalized;
}

async function installCatalogHarness(
  page: Page,
  initialCatalog: AdminCatalog,
): Promise<CatalogHarness> {
  let catalog = normalizeHarnessCatalog(initialCatalog);
  const receivedPosts: AdminCatalog[] = [];
  let pendingPost: PendingPost | undefined;

  await page.route('**/data/contracts.json', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({
        status: 405,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'GET esperado pelo harness.' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(catalog),
    });
  });

  await page.route('**/__factory-admin/contracts', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({
        status: 405,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'POST esperado pelo harness.' }),
      });
      return;
    }

    const posted = route.request().postDataJSON() as AdminCatalog;
    receivedPosts.push(clone(posted));
    const pending = pendingPost;
    pendingPost = undefined;
    if (pending) await pending.wait;
    if (pending?.failureMessage) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: pending.failureMessage }),
      });
      return;
    }

    catalog = normalizeHarnessCatalog(posted);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, value: catalog }),
    });
  });

  return {
    current: () => clone(catalog),
    posts: () => clone(receivedPosts),
    holdNextPostUntilRelease(): () => void {
      if (pendingPost) throw new Error('Já existe um POST pendente.');
      let release = (): void => undefined;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      pendingPost = { wait };
      return release;
    },
    failNextPostAfterRelease(message: string): () => void {
      if (pendingPost) throw new Error('Já existe um POST pendente.');
      let release = (): void => undefined;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      pendingPost = { failureMessage: message, wait };
      return release;
    },
  };
}

async function seedProgress(page: Page, contracts: AdminContract[]): Promise<void> {
  await page.addInitScript(
    ({ key, seededContracts }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 4,
          unlockedContracts: seededContracts.map(({ id }) => id),
          completedContracts: Object.fromEntries(
            seededContracts.map(({ id, revision }) => [id, revision]),
          ),
          settings: { muted: false, volume: 0.65 },
          sandbox: { machines: [], updatedAt: new Date(0).toISOString() },
        }),
      );
    },
    {
      key: PROGRESS_KEY,
      seededContracts: contracts.map(({ id, revision }) => ({ id, revision })),
    },
  );
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#menu-title')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as AdminWindow).__FACTORY_DEBUG__));
  await expect(page.locator('.factory-app')).toHaveAttribute('aria-busy', 'false');
}

async function enableAdmin(page: Page): Promise<void> {
  const adminToggle = page.locator('#admin-toggle');
  await expect(adminToggle).toBeVisible();
  if ((await adminToggle.getAttribute('aria-pressed')) !== 'true') await adminToggle.click();
  await expect(adminToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#menu-admin-badge')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('#create-contract-button')).not.toHaveClass(/is-hidden/);
}

async function getProgress(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), PROGRESS_KEY);
}

async function authorRequiredEntities(page: Page): Promise<string> {
  return page.evaluate(() => {
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
}

async function setDebugCamera(page: Page, requested: AdminCamera): Promise<AdminCamera> {
  const expected = {
    centerX: Math.round(requested.centerX * 100) / 100,
    centerY: Math.round(requested.centerY * 100) / 100,
    zoom: Math.round(requested.zoom * 10_000) / 10_000,
  };
  await page.evaluate((camera) => {
    (window as AdminWindow).__FACTORY_DEBUG__!.setCamera(
      camera.centerX,
      camera.centerY,
      camera.zoom,
    );
  }, requested);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  // Reapplying after a rendered frame also makes the debug helper deterministic
  // when Phaser has not refreshed its world-view matrix during the first call.
  await page.evaluate((camera) => {
    (window as AdminWindow).__FACTORY_DEBUG__!.setCamera(
      camera.centerX,
      camera.centerY,
      camera.zoom,
    );
  }, requested);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const camera = (window as AdminWindow).__FACTORY_DEBUG__!.getCamera();
        return { centerX: camera.centerX, centerY: camera.centerY, zoom: camera.zoom };
      }),
    )
    .toEqual(expected);
  return expected;
}

test('cria, testa, edita e exclui fases pelo catálogo HTTP sem usar localStorage', async ({
  page,
}) => {
  const first = makeContract('first-flow', 1);
  const second = makeContract('controlled-jump', 2);
  const harness = await installCatalogHarness(page, makeCatalog(first, second));
  await seedProgress(page, [first, second]);
  await openApp(page);

  const adminToggle = page.locator('#admin-toggle');
  await expect(adminToggle).toContainText('Ativar admin');
  await expect(page.locator('#create-contract-button')).toHaveClass(/is-hidden/);
  await enableAdmin(page);
  await expect(page.locator('.contract-entry')).toHaveCount(2);

  await page.getByRole('button', { name: 'Editar fase 1-1' }).click();
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);
  await page.evaluate(() => {
    const debug = (window as AdminWindow).__FACTORY_DEBUG__;
    if (!debug?.placeCollectible(8, 8)) throw new Error('Could not add an editor star');
  });
  await expect(page.locator('[data-metric="stars"]')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as AdminWindow).__FACTORY_DEBUG__?.getCollectibles().length ?? 0),
    )
    .toBe(1);
  await page.locator('[data-action="editor-configure"]').first().click();
  await expect(page.locator('#editor-contract-form select[name="world"]')).toHaveValue('1');
  await expect(page.locator('#editor-contract-form select[name="world"]')).toBeDisabled();
  await expect(page.locator('#editor-contract-form select[name="stage"]')).toHaveValue('1');
  await expect(page.locator('#editor-contract-form select[name="stage"]')).toBeEnabled();
  await page.locator('#editor-contract-form input[name="deliveries"]').fill('11');
  await page.locator('#editor-contract-form input[name="lossesEnabled"]').uncheck();
  await page.locator('#editor-contract-form input[name="budgetLimit"]').fill('30000');
  await page.locator('#editor-contract-form input[name="conveyorSlowCost"]').fill('2200');
  await page.locator('#editor-contract-form input[name="conveyorNormalCost"]').fill('3000');
  await page.locator('#editor-contract-form input[name="conveyorFastCost"]').fill('3600');
  await page.locator('#editor-contract-form input[name="springCost"]').fill('6000');
  await expect(page.locator('#editor-contract-form input[name="turboSpringCost"]')).toHaveValue(
    '7500',
  );
  await page.locator('#editor-contract-form input[name="availableSlowConveyor"]').check();
  await page.locator('#editor-contract-form input[name="availableFastConveyor"]').check();
  await page.locator('#editor-contract-form input[name="availableTurboSpring"]').check();
  await page.locator('[data-action="editor-save"]').click();
  await expect(page.locator('#editor-feedback')).toContainText('Fase salva no JSON local');
  await expect(page.locator('#editor-contract-form select[name="world"]')).toBeDisabled();
  await expect(page.locator('#editor-contract-form select[name="stage"]')).toBeEnabled();
  await expect.poll(() => harness.posts().length).toBe(1);
  expect(harness.current().contracts.find(({ id }) => id === first.id)).toMatchObject({
    world: 1,
    stage: 1,
    revision: 2,
    order: 1,
    title: '1-1',
    availableMachines: expect.arrayContaining([
      'slow-conveyor',
      'tracked-conveyor',
      'fast-conveyor',
      'turbo-spring',
    ]),
    goal: { deliveries: 11 },
    economy: {
      budgetLimit: 30_000,
      machineCosts: {
        'tracked-conveyor': 3_000,
        spring: 6_000,
        'turbo-spring': 7_500,
      },
      conveyorSpeedCosts: {
        slow: 2_200,
        normal: 3_000,
        fast: 3_600,
      },
    },
  });
  expect(harness.current().contracts.find(({ id }) => id === first.id)?.goal).toEqual({
    deliveries: 11,
  });

  const progressAfterEdit = await getProgress(page);
  const completionsAfterEdit = progressAfterEdit.completedContracts as Record<string, number>;
  expect(completionsAfterEdit[first.id]).toBeUndefined();
  expect(completionsAfterEdit[second.id]).toBe(second.revision);
  expect(progressAfterEdit.unlockedContracts).toEqual(
    expect.arrayContaining([first.id, second.id]),
  );

  await page.locator('[data-action="editor-cancel"]').click();
  await expect(page.locator('#menu-screen')).not.toHaveClass(/is-hidden/);
  await page.locator('#create-contract-button').click();
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('#editor-dirty-state')).toContainText('salva');
  const draftId = await authorRequiredEntities(page);
  expect(draftId).toMatch(/^custom-/);

  await expect(page.locator('[data-action="delete"]')).toBeEnabled();
  await page.locator('[data-action="editor-configure"]').first().click();
  await expect(page.locator('#editor-contract-form select[name="world"]')).toHaveValue('1');
  await expect(page.locator('#editor-contract-form select[name="stage"]')).toHaveValue('3');
  await expect(page.locator('#editor-contract-form [data-stage-label]')).toHaveText('3-1');
  await expect(page.locator('input[name="conveyorSlowCost"]')).toHaveValue('2000');
  await expect(page.locator('input[name="conveyorNormalCost"]')).toHaveValue('2500');
  await expect(page.locator('input[name="conveyorFastCost"]')).toHaveValue('3000');

  const completionsBeforePreview = (await getProgress(page)).completedContracts;
  await page.locator('[data-action="editor-test"]').click();
  await expect(page.locator('#editor-preview-bar')).not.toHaveClass(/is-hidden/);
  await expect.poll(() => harness.current().contracts.length).toBe(3);
  await page.evaluate(() => {
    const debug = (window as AdminWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Admin debug API unavailable');
    debug.completeContract();
  });
  await expect(page.locator('#result-modal')).toHaveClass(/is-hidden/);
  const progressAfterPreview = await getProgress(page);
  expect(progressAfterPreview.completedContracts).toEqual(completionsBeforePreview);
  expect(progressAfterPreview.unlockedContracts).toContain(draftId);
  await page.locator('[data-action="editor-return"]').click();
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);

  await expect(page.locator('#editor-feedback')).toContainText('Fase salva no JSON local');
  expect(harness.current().contracts.find(({ id }) => id === draftId)).toMatchObject({
    world: 1,
    stage: 3,
    revision: 1,
    order: 3,
    title: '3-1',
    collectibles: [],
    fixedMachines: expect.arrayContaining([
      expect.objectContaining({ type: 'source', fixed: true }),
      expect.objectContaining({ type: 'receiver', fixed: true }),
    ]),
    obstacles: [expect.objectContaining({ gridX: 9, gridY: 6, columns: 3, rows: 2 })],
  });

  await page.locator('[data-action="editor-cancel"]').click();
  const originalEntry = page.locator('.contract-entry').filter({ hasText: '1-1' });
  await originalEntry.locator('.text-button.danger').click();
  await page.locator('[data-action="admin-confirm-accept"]').click();
  await expect
    .poll(() => harness.current().contracts.some(({ id }) => id === first.id))
    .toBe(false);
  await expect(page.locator('.contract-entry')).toHaveCount(2);
  expect(harness.current().contracts.map(({ id }) => id)).toEqual([second.id, draftId]);
  expect(harness.current().contracts.map(({ order }) => order)).toEqual([2, 3]);
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_CATALOG_KEY)).toBeNull();
});

test('confirma ou cancela a troca de posição entre duas fases existentes', async ({ page }) => {
  const fourth = makeContract('fourth-stage', 4);
  const fifth = makeContract('fifth-stage', 5);
  const harness = await installCatalogHarness(page, makeCatalog(fourth, fifth));
  await seedProgress(page, [fourth, fifth]);
  await openApp(page);
  await enableAdmin(page);

  await page.getByRole('button', { name: 'Editar fase 4-1' }).click();
  await page.locator('[data-action="editor-configure"]').first().click();
  await page.locator('#editor-contract-form select[name="stage"]').selectOption('5');
  await expect(page.locator('[data-stage-label]')).toHaveText('5-1');

  await page.locator('[data-action="editor-save"]').click();
  const confirmation = page.locator('#admin-confirm-modal');
  await expect(confirmation).toBeVisible();
  await expect(page.locator('#admin-confirm-kicker')).toHaveText('INVERTER FASES');
  await expect(page.locator('#admin-confirm-title')).toHaveText('Trocar 4-1 com 5-1?');
  await expect(page.locator('#admin-confirm-copy')).toContainText(
    'A fase 4-1 passará a ocupar 5-1, e a fase 5-1 passará a ocupar 4-1.',
  );
  await expect(page.locator('[data-action="admin-confirm-accept"]')).toHaveText('Trocar fases');

  await page.locator('[data-action="admin-confirm-cancel"]').click();
  await expect(confirmation).toBeHidden();
  expect(harness.posts()).toHaveLength(0);
  expect(harness.current().contracts.find(({ id }) => id === fourth.id)).toMatchObject({
    stage: 4,
    title: '4-1',
  });
  expect(harness.current().contracts.find(({ id }) => id === fifth.id)).toMatchObject({
    stage: 5,
    title: '5-1',
  });

  await page.locator('[data-action="editor-save"]').click();
  await expect(confirmation).toBeVisible();
  await page.locator('[data-action="admin-confirm-accept"]').click();
  await expect(page.locator('#editor-feedback')).toContainText(
    'Fases trocadas e salvas no JSON local.',
  );
  await expect.poll(() => harness.posts().length).toBe(1);
  expect(harness.current().contracts.find(({ id }) => id === fourth.id)).toMatchObject({
    stage: 5,
    order: 5,
    title: '5-1',
    revision: 2,
  });
  expect(harness.current().contracts.find(({ id }) => id === fifth.id)).toMatchObject({
    stage: 4,
    order: 4,
    title: '4-1',
    revision: 2,
  });
  await expect(page.locator('#editor-contract-title')).toHaveText('Fase 5-1');

  const savedProgress = await getProgress(page);
  expect(savedProgress.completedContracts).toEqual({});
});

test('cria mundos por abas, salva suas cores e inicia a primeira fase no mundo ativo', async ({
  page,
}) => {
  const first = makeContract('world-one-stage-one', 1);
  const harness = await installCatalogHarness(page, makeCatalog(first));
  await openApp(page);
  await enableAdmin(page);

  const tabs = page.locator('#admin-world-tabs');
  await expect(tabs.getByRole('tab', { name: 'Mundo 1' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await tabs.getByRole('button', { name: 'Criar novo mundo' }).click();

  const modal = page.locator('#world-create-modal');
  await expect(modal).toBeVisible();
  await expect(page.locator('#world-create-title')).toHaveText('Criar Mundo 2');
  const background = page.locator('#world-create-form input[name="backgroundColor"]');
  const grid = page.locator('#world-create-form input[name="gridColor"]');
  await expect(background).toHaveValue('#377fbd');
  await expect(grid).toHaveValue('#ffffff');
  await background.fill('#6b2032');
  await grid.fill('#f4d9e8');
  await expect
    .poll(() =>
      page.locator('.world-color-preview').evaluate((preview) => ({
        background: getComputedStyle(preview).getPropertyValue('--world-background').trim(),
        grid: getComputedStyle(preview).getPropertyValue('--world-grid').trim(),
      })),
    )
    .toEqual({ background: '#6b2032', grid: '#f4d9e8' });

  await page.locator('[data-action="world-create-confirm"]').click();
  await expect(modal).toBeHidden();
  await expect.poll(() => harness.posts().length).toBe(1);
  expect(harness.current().worlds).toEqual([
    { world: 1, backgroundColor: '#377fbd', gridColor: '#ffffff' },
    { world: 2, backgroundColor: '#6b2032', gridColor: '#f4d9e8' },
  ]);
  await expect(tabs.getByRole('tab', { name: 'Mundo 2' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.contract-empty-state')).toContainText(
    'Nenhuma fase no Mundo 2',
  );

  await page.locator('#create-contract-button').click();
  await expect(page.locator('#editor-rail')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const draft = (window as AdminWindow).__FACTORY_DEBUG__?.getEditorDraft();
        return draft && { world: draft.world, stage: draft.stage, title: draft.title };
      }),
    )
    .toEqual({ world: 2, stage: 1, title: '1-2' });
  await page.locator('[data-action="editor-configure"]').first().click();
  await expect(page.locator('#editor-contract-form select[name="world"]')).toHaveValue('2');
  await expect(page.locator('#editor-contract-form select[name="world"]')).toBeDisabled();
  await expect(page.locator('#editor-contract-form select[name="stage"]')).toBeEnabled();
  await expect(
    page.locator('#editor-contract-form select[name="world"] option'),
  ).toHaveCount(2);
});

test('reconfigura as cores e exclui um mundo vazio pela própria aba', async ({ page }) => {
  const first = makeContract('world-settings-stage', 1);
  const harness = await installCatalogHarness(page, makeCatalog(first));
  await openApp(page);
  await enableAdmin(page);

  const tabs = page.locator('#admin-world-tabs');
  await tabs.getByRole('button', { name: 'Criar novo mundo' }).click();
  await page.locator('#world-create-form input[name="backgroundColor"]').fill('#6b2032');
  await page.locator('#world-create-form input[name="gridColor"]').fill('#f4d9e8');
  await page.locator('[data-action="world-create-confirm"]').click();
  await expect.poll(() => harness.posts().length).toBe(1);
  await expect(tabs.getByRole('tab', { name: 'Mundo 2' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  const configure = page.locator('[data-action="admin-configure-world"]');
  const remove = page.locator('[data-action="admin-delete-world"]');
  await expect(configure).toHaveAttribute('aria-label', 'Configurar Mundo 2');
  await expect(configure).toBeEnabled();
  await expect(remove).toHaveAttribute('aria-label', 'Excluir Mundo 2');
  await expect(remove).toBeEnabled();

  await configure.click();
  await expect(page.locator('#world-create-modal')).toBeVisible();
  await expect(page.locator('#world-create-kicker')).toHaveText('CONFIGURAR MUNDO');
  await expect(page.locator('#world-create-title')).toHaveText('Configurar Mundo 2');
  const background = page.locator('#world-create-form input[name="backgroundColor"]');
  const grid = page.locator('#world-create-form input[name="gridColor"]');
  await expect(background).toHaveValue('#6b2032');
  await expect(grid).toHaveValue('#f4d9e8');
  await background.fill('#1a6b82');
  await grid.fill('#e8faff');
  await expect(page.locator('#world-create-submit')).toHaveText('Salvar alterações');
  await page.locator('#world-create-submit').click();
  await expect(page.locator('#world-create-modal')).toBeHidden();
  await expect.poll(() => harness.posts().length).toBe(2);
  expect(harness.current().worlds[1]).toEqual({
    world: 2,
    backgroundColor: '#1a6b82',
    gridColor: '#e8faff',
  });

  await remove.click();
  await expect(page.locator('#admin-confirm-modal')).toBeVisible();
  await expect(page.locator('#admin-confirm-kicker')).toHaveText('EXCLUIR MUNDO');
  await expect(page.locator('#admin-confirm-title')).toHaveText('Excluir Mundo 2?');
  await expect(page.locator('[data-action="admin-confirm-accept"]')).toHaveText(
    'Excluir mundo',
  );
  await page.locator('[data-action="admin-confirm-accept"]').click();
  await expect.poll(() => harness.posts().length).toBe(3);
  expect(harness.current().worlds).toEqual([
    { world: 1, backgroundColor: '#377fbd', gridColor: '#ffffff' },
  ]);
  await expect(tabs.getByRole('tab', { name: 'Mundo 2' })).toHaveCount(0);
  await expect(tabs.getByRole('tab', { name: 'Mundo 1' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(remove).toBeDisabled();
});

test('mantém a exclusão do mundo desabilitada enquanto ele possui fases', async ({ page }) => {
  const first = makeContract('world-one-settings', 1);
  const second = makeContract(
    'world-two-settings',
    1,
    { centerX: 720, centerY: 432, zoom: 1 },
    2,
  );
  const catalog = makeCatalog(first, second);
  catalog.worlds[1] = {
    world: 2,
    backgroundColor: '#6b2032',
    gridColor: '#f4d9e8',
  };
  await installCatalogHarness(page, catalog);
  await openApp(page);
  await enableAdmin(page);

  const worldTwo = page.locator('#admin-world-tabs').getByRole('tab', { name: 'Mundo 2' });
  await worldTwo.click();
  const remove = page.locator('[data-action="admin-delete-world"]');
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAttribute(
    'title',
    'Exclua todas as fases deste mundo antes de removê-lo.',
  );
  await expect(page.locator('[data-action="admin-configure-world"]')).toBeEnabled();

  await page.getByRole('button', { name: 'Editar fase 1-2' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as AdminWindow).__FACTORY_DEBUG__?.getBoardTheme()),
    )
    .toEqual({ backgroundColor: '#6b2032', gridColor: '#f4d9e8' });
});

test('navega lateralmente entre mapas e usa grade colorida nos mundos seguintes', async ({
  page,
}) => {
  const first = makeContract('world-one-map', 1);
  const second = makeContract(
    'world-two-map',
    1,
    { centerX: 720, centerY: 432, zoom: 1 },
    2,
  );
  const catalog = makeCatalog(first, second);
  catalog.worlds[1] = {
    world: 2,
    backgroundColor: '#6b2032',
    gridColor: '#f4d9e8',
  };
  await installCatalogHarness(page, catalog);
  await seedProgress(page, [first, second]);
  await openApp(page);
  await page.locator('[data-action="menu-play"]').click();

  const firstWorld = page.locator('[data-campaign-world="1"]');
  const secondWorld = page.locator('[data-campaign-world="2"]');
  await expect(page.locator('#campaign-world-label')).toHaveText('Mundo 1');
  await expect(firstWorld.locator('.campaign-map-image')).toBeVisible();
  await expect(secondWorld.locator('.campaign-map-image')).toHaveCount(0);
  await expect(firstWorld.locator('.campaign-stage-marker')).toHaveCount(10);
  await expect(secondWorld.locator('.campaign-stage-marker')).toHaveCount(10);

  await page.locator('[data-action="campaign-world-next"]').click();
  await expect(page.locator('#campaign-world-label')).toHaveText('Mundo 2');
  await expect(secondWorld).toHaveAttribute('aria-hidden', 'false');
  await expect(secondWorld).toHaveCSS('background-color', 'rgb(107, 32, 50)');
  await expect(secondWorld.getByRole('button', { name: 'Selecionar fase 1-2' })).toBeVisible();
  await expect
    .poll(async () => Math.round((await secondWorld.boundingBox())?.x ?? -999))
    .toBe(0);

  await page.locator('[data-action="campaign-world-previous"]').click();
  await expect(page.locator('#campaign-world-label')).toHaveText('Mundo 1');
  await expect
    .poll(async () => Math.round((await firstWorld.boundingBox())?.x ?? -999))
    .toBe(0);
});

test('concluir a fase 10 libera e inicia a fase 1 do mundo seguinte', async ({ page }) => {
  const lastWorldOne = makeContract('world-one-final', 10);
  const firstWorldTwo = makeContract(
    'world-two-first',
    1,
    { centerX: 720, centerY: 432, zoom: 1 },
    2,
  );
  const catalog = makeCatalog(lastWorldOne, firstWorldTwo);
  catalog.worlds[1] = {
    world: 2,
    backgroundColor: '#1a6b82',
    gridColor: '#e8faff',
  };
  await installCatalogHarness(page, catalog);
  await page.addInitScript(
    ({ key, firstId }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 5,
          unlockedContracts: [firstId],
          completedContracts: {},
          settings: { muted: false, volume: 0.65 },
          sandbox: { machines: [], updatedAt: new Date(0).toISOString() },
          campaignLayouts: {},
        }),
      );
    },
    { key: PROGRESS_KEY, firstId: lastWorldOne.id },
  );
  await openApp(page);
  await page.locator('[data-action="menu-play"]').click();
  await page.getByRole('button', { name: 'Selecionar fase 10-1' }).click();
  await page.locator('[data-action="campaign-play"]').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as AdminWindow).__FACTORY_DEBUG__?.getSnapshot().contractId),
    )
    .toBe(lastWorldOne.id);
  await expect
    .poll(() =>
      page.evaluate(() => (window as AdminWindow).__FACTORY_DEBUG__?.getBoardTheme()),
    )
    .toEqual({ backgroundColor: '#377fbd', gridColor: '#ffffff' });

  await page.evaluate(() => {
    const debug = (window as AdminWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Admin debug API unavailable');
    debug.completeContract();
  });
  await expect(page.locator('#result-modal')).toBeVisible();
  await expect(page.locator('[data-action="next"]')).toBeVisible();
  await expect
    .poll(async () => (await getProgress(page)).unlockedContracts)
    .toEqual(expect.arrayContaining([lastWorldOne.id, firstWorldTwo.id]));

  await page.locator('[data-action="next"]').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as AdminWindow).__FACTORY_DEBUG__?.getSnapshot().contractId),
    )
    .toBe(firstWorldTwo.id);
  await expect
    .poll(() =>
      page.evaluate(() => (window as AdminWindow).__FACTORY_DEBUG__?.getBoardTheme()),
    )
    .toEqual({ backgroundColor: '#1a6b82', gridColor: '#e8faff' });
});

test('permite catálogo vazio e desbloqueia a primeira fase recriada', async ({ page }) => {
  const onlyContract = makeContract('only-stage', 1);
  const harness = await installCatalogHarness(page, makeCatalog(onlyContract));
  await openApp(page);
  await enableAdmin(page);

  const onlyEntry = page.locator('.contract-entry').filter({ hasText: '1-1' });
  await onlyEntry.locator('.text-button.danger').click();
  await page.locator('[data-action="admin-confirm-accept"]').click();
  await expect.poll(() => harness.current().contracts.length).toBe(0);
  await expect(page.locator('.contract-empty-state')).toContainText('Nenhuma fase no Mundo 1');
  await expect(page.locator('.contract-empty-state')).toContainText('Crie a primeira fase');
  await expect(page.locator('[data-start-sandbox]')).toBeVisible();
  await expect(page.locator('#create-contract-button')).toBeVisible();

  await page.locator('#create-contract-button').click();
  const recreatedId = await authorRequiredEntities(page);
  await page.locator('[data-action="editor-configure"]').first().click();
  await expect(page.locator('#editor-contract-form select[name="world"]')).toHaveValue('1');
  await expect(page.locator('#editor-contract-form select[name="stage"]')).toHaveValue('1');
  await expect(page.locator('#editor-contract-form [data-stage-label]')).toHaveText('1-1');
  await page.locator('[data-action="editor-save"]').click();
  await expect(page.locator('#editor-feedback')).toContainText('Fase salva no JSON local');
  await expect.poll(() => harness.current().contracts.length).toBe(1);
  expect(harness.current().contracts[0]).toMatchObject({
    id: recreatedId,
    world: 1,
    stage: 1,
    revision: 1,
    order: 1,
    title: '1-1',
  });

  const progress = await getProgress(page);
  expect(progress.version).toBe(5);
  expect(progress.unlockedContracts).toEqual([recreatedId]);
  expect(progress.completedContracts).toEqual({});
  await page.locator('[data-action="editor-cancel"]').click();
  await page.locator('#admin-toggle').click();
  const playerCard = page.locator('#contract-list .stage-contract-card');
  await expect(playerCard).toHaveCount(1);
  await expect(playerCard).toBeEnabled();
});

test('salva a câmera autorada, recarrega o editor e inicia a campanha no mesmo enquadramento', async ({
  page,
}) => {
  const contract = makeContract('camera-stage', 1);
  const harness = await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: 'Editar fase 1-1' }).click();

  const authoredCamera = await setDebugCamera(page, {
    centerX: 930.125,
    centerY: 350.555,
    zoom: 1.62555,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as AdminWindow).__FACTORY_DEBUG__!.getEditorDraft().initialCamera,
      ),
    )
    .toEqual(authoredCamera);
  await expect(page.locator('#editor-dirty-state')).toContainText('salvas');
  await page.locator('[data-action="editor-save"]').click();
  await expect(page.locator('#editor-feedback')).toContainText('Fase salva no JSON local');
  await expect.poll(() => harness.posts().length).toBe(1);
  expect(harness.current().contracts[0]?.initialCamera).toEqual(authoredCamera);

  await page.locator('[data-action="editor-cancel"]').click();
  await page.reload();
  await expect(page.locator('#menu-title')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as AdminWindow).__FACTORY_DEBUG__));
  await enableAdmin(page);
  await page.getByRole('button', { name: 'Editar fase 1-1' }).click();
  expect(
    await page.evaluate(() => {
      const camera = (window as AdminWindow).__FACTORY_DEBUG__!.getCamera();
      return { centerX: camera.centerX, centerY: camera.centerY, zoom: camera.zoom };
    }),
  ).toEqual(authoredCamera);

  await page.locator('[data-action="editor-cancel"]').click();
  await page.locator('#admin-toggle').click();
  const playerCard = page.locator('#contract-list .stage-contract-card');
  await expect(playerCard).toBeEnabled();
  await playerCard.evaluate((button: HTMLButtonElement) => button.click());
  const campaign = await page.evaluate(() => {
    const debug = (window as AdminWindow).__FACTORY_DEBUG__;
    if (!debug) throw new Error('Admin debug API unavailable');
    const camera = debug.getCamera();
    return {
      mode: debug.getSnapshot().mode,
      contractId: debug.getSnapshot().contractId,
      camera: { centerX: camera.centerX, centerY: camera.centerY, zoom: camera.zoom },
    };
  });
  expect(campaign).toEqual({ mode: 'campaign', contractId: contract.id, camera: authoredCamera });

  const canvasBounds = await page.locator('#game-container canvas').boundingBox();
  if (!canvasBounds) throw new Error('Canvas indisponível para testar a câmera do jogador.');
  // Keep the gesture in the canvas area that is not occupied by the expanded
  // construction palette on the right.
  const pointerX = canvasBounds.x + canvasBounds.width * 0.65;
  const pointerY = canvasBounds.y + canvasBounds.height * 0.18;
  await page.mouse.move(pointerX, pointerY);
  await page.mouse.down();
  await page.mouse.move(pointerX - 90, pointerY + 55, { steps: 6 });
  await page.mouse.up();
  await page.mouse.wheel(0, -450);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const camera = (window as AdminWindow).__FACTORY_DEBUG__!.getCamera();
        return (
          Math.abs(camera.zoom - 1.6256) +
          Math.abs(camera.centerX - 930.13) +
          Math.abs(camera.centerY - 350.56)
        );
      }),
    )
    .toBeGreaterThan(1);
  expect(harness.posts()).toHaveLength(1);
  expect(harness.current().contracts[0]?.initialCamera).toEqual(authoredCamera);
});

test('descarta pan e zoom feitos na prévia ao voltar ao editor', async ({ page }) => {
  const contract = makeContract('preview-camera-stage', 1);
  const harness = await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: 'Editar fase 1-1' }).click();

  const authoringCamera = await setDebugCamera(page, {
    centerX: 880,
    centerY: 310,
    zoom: 1.5,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as AdminWindow).__FACTORY_DEBUG__!.getEditorDraft().initialCamera,
      ),
    )
    .toEqual(authoringCamera);
  await page.locator('[data-action="editor-test"]').click();
  await expect(page.locator('#editor-preview-bar')).not.toHaveClass(/is-hidden/);
  expect(
    await page.evaluate(() => {
      const camera = (window as AdminWindow).__FACTORY_DEBUG__!.getCamera();
      return { centerX: camera.centerX, centerY: camera.centerY, zoom: camera.zoom };
    }),
  ).toEqual(authoringCamera);

  await setDebugCamera(page, { centerX: 1200, centerY: 640, zoom: 2 });
  await page.locator('[data-action="editor-return"]').click();
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);
  const restored = await page.evaluate(() => {
    const debug = (window as AdminWindow).__FACTORY_DEBUG__!;
    const camera = debug.getCamera();
    return {
      mode: debug.getSnapshot().mode,
      camera: { centerX: camera.centerX, centerY: camera.centerY, zoom: camera.zoom },
      draftCamera: debug.getEditorDraft().initialCamera,
    };
  });
  expect(restored).toEqual({
    mode: 'editor',
    camera: authoringCamera,
    draftCamera: authoringCamera,
  });
  expect(harness.posts()).toHaveLength(1);
});

test('bloqueia autoria e saída do editor enquanto o POST está pendente', async ({ page }) => {
  const contract = makeContract('pending-save-stage', 1);
  const harness = await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: 'Editar fase 1-1' }).click();
  await page.locator('[data-action="editor-configure"]').first().click();
  await page.locator('#editor-contract-form select[name="stage"]').selectOption('2');

  const cameraBefore = await page.evaluate(() => {
    const camera = (window as AdminWindow).__FACTORY_DEBUG__!.getCamera();
    return { centerX: camera.centerX, centerY: camera.centerY, zoom: camera.zoom };
  });
  const release = harness.holdNextPostUntilRelease();
  await page.locator('[data-action="editor-save"]').click();
  await expect.poll(() => harness.posts().length).toBe(1);

  await expect(page.locator('#game-ui')).toHaveAttribute('inert', '');
  await expect(page.locator('#game-container')).toHaveAttribute('inert', '');
  await expect(page.locator('#editor-contract-form select[name="stage"]')).toBeDisabled();
  await expect(page.locator('[data-action="editor-cancel"]')).toBeDisabled();
  const blocked = await page.evaluate(() => {
    const debug = (window as AdminWindow).__FACTORY_DEBUG__!;
    debug.setCamera(1200, 650, 2);
    return {
      placed: debug.placeMachine('tracked-conveyor', 8.25, 8.25),
      camera: (() => {
        const camera = debug.getCamera();
        return { centerX: camera.centerX, centerY: camera.centerY, zoom: camera.zoom };
      })(),
    };
  });
  expect(blocked).toEqual({ placed: false, camera: cameraBefore });

  release();
  await expect(page.locator('#editor-feedback')).toContainText('Fase salva no JSON local');
  await expect(page.locator('#game-ui')).not.toHaveAttribute('inert', '');
  await expect(page.locator('[data-action="editor-cancel"]')).toBeEnabled();
  expect(harness.current().contracts[0]).toMatchObject({
    world: 1,
    stage: 2,
    revision: 2,
    order: 2,
    title: '2-1',
  });
});

test('só abre a prévia depois que o teste salva a fase', async ({ page }) => {
  const contract = makeContract('test-waits-for-save-stage', 1);
  const harness = await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: 'Editar fase 1-1' }).click();

  const release = harness.holdNextPostUntilRelease();
  await page.locator('[data-action="editor-test"]').click();
  await expect.poll(() => harness.posts().length).toBe(1);
  await expect(page.locator('#editor-preview-bar')).toHaveClass(/is-hidden/);
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('[data-action="editor-test"]')).toBeDisabled();

  release();
  await expect(page.locator('#editor-preview-bar')).not.toHaveClass(/is-hidden/);
  expect(harness.current().contracts[0]?.revision).toBe(2);
});

test('não abre a prévia quando o salvamento do teste falha', async ({ page }) => {
  const contract = makeContract('test-save-failure-stage', 1);
  const harness = await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: 'Editar fase 1-1' }).click();

  const releaseFailure = harness.failNextPostAfterRelease(
    'Falha simulada ao validar a fase para teste.',
  );
  await page.locator('[data-action="editor-test"]').click();
  await expect.poll(() => harness.posts().length).toBe(1);
  releaseFailure();

  await expect(page.locator('#editor-feedback')).toContainText(
    'Falha simulada ao validar a fase para teste.',
  );
  await expect(page.locator('#editor-preview-bar')).toHaveClass(/is-hidden/);
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('[data-action="editor-test"]')).toBeEnabled();
  expect(harness.current().contracts[0]?.revision).toBe(1);
});

test('pisca em vermelho todos os objetos inválidos a cada tentativa de salvar', async ({
  page,
}) => {
  const contract = makeContract('invalid-object-flash', 1);
  const harness = await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: 'Editar fase 1-1' }).click();

  const invalidMachineId = await page.evaluate(() => {
    const debug = (window as AdminWindow).__FACTORY_DEBUG__!;
    const draft = debug.getEditorDraft();
    const invalidMachine = draft.fixedMachines[0]!;
    const overlappingMachine = draft.fixedMachines[1]!;
    invalidMachine.gridX = overlappingMachine.gridX;
    invalidMachine.gridY = overlappingMachine.gridY;
    debug.startEditor(draft);
    return invalidMachine.id;
  });
  await page.locator('[data-action="editor-configure"]').first().click();
  await page.locator('#editor-contract-form input[name="deliveries"]').fill('9');
  await page.locator('[data-action="editor-save"]').click();

  await expect(page.locator('#editor-feedback')).toContainText('Há objetos sobrepostos');
  const firstFlash = await page.evaluate(() =>
    (window as AdminWindow).__FACTORY_DEBUG__!.getInvalidEntityFlash(),
  );
  expect(firstFlash.machineIds).toContain(invalidMachineId);
  expect(firstFlash.remainingMs).toBeGreaterThan(1_500);
  expect(harness.posts()).toHaveLength(0);

  await page.waitForTimeout(500);
  const beforeRetry = await page.evaluate(
    () => (window as AdminWindow).__FACTORY_DEBUG__!.getInvalidEntityFlash().remainingMs,
  );
  await page.locator('[data-action="editor-test"]').click();
  const afterRetry = await page.evaluate(
    () => (window as AdminWindow).__FACTORY_DEBUG__!.getInvalidEntityFlash().remainingMs,
  );
  expect(afterRetry).toBeGreaterThan(beforeRetry);
  expect(afterRetry).toBeGreaterThan(1_500);
  await expect(page.locator('#editor-preview-bar')).toHaveClass(/is-hidden/);
  expect(harness.posts()).toHaveLength(0);

  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as AdminWindow).__FACTORY_DEBUG__!.getInvalidEntityFlash().remainingMs,
        ),
      { timeout: 3_000 },
    )
    .toBe(0);
});

test('liga e desliga a visualização de hitboxes somente no editor', async ({ page }) => {
  const contract = makeContract('hitbox-toggle-stage', 1);
  await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: 'Editar fase 1-1' }).click();

  const toggle = page.getByRole('button', { name: 'Hitboxes' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveClass(/is-active/);
  await expect
    .poll(() =>
      page.evaluate(() => (window as AdminWindow).__FACTORY_DEBUG__!.getEditorHitboxesVisible()),
    )
    .toBe(true);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(() =>
      page.evaluate(() => (window as AdminWindow).__FACTORY_DEBUG__!.getEditorHitboxesVisible()),
    )
    .toBe(false);
});

test('mantém o rascunho sujo e mostra o erro quando o POST falha', async ({ page }) => {
  const contract = makeContract('post-failure-stage', 1);
  const harness = await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: 'Editar fase 1-1' }).click();
  await page.locator('[data-action="editor-configure"]').first().click();
  await page.locator('#editor-contract-form select[name="stage"]').selectOption('2');

  const releaseFailure = harness.failNextPostAfterRelease('Falha simulada ao gravar o JSON.');
  await page.locator('[data-action="editor-save"]').click();
  await expect.poll(() => harness.posts().length).toBe(1);
  await expect(page.locator('#editor-dirty-state')).toContainText('Salvando no JSON');
  await expect(page.locator('#editor-feedback')).toContainText('Salvando no JSON');
  await expect(page.locator('[data-action="editor-save"]')).toBeDisabled();

  releaseFailure();
  await expect(page.locator('#editor-feedback')).toContainText('Falha simulada ao gravar o JSON');
  await expect(page.locator('#editor-dirty-state')).toContainText('salvas');
  await expect(page.locator('[data-action="editor-save"]')).toBeEnabled();
  expect(harness.current().contracts[0]).toMatchObject({
    world: 1,
    stage: 1,
    revision: 1,
    order: 1,
    title: '1-1',
  });
  expect(
    await page.evaluate(() => {
      const draft = (window as AdminWindow).__FACTORY_DEBUG__?.getEditorDraft();
      return draft
        ? {
            world: draft.world,
            stage: draft.stage,
            order: draft.order,
            title: draft.title,
          }
        : undefined;
    }),
  ).toEqual({ world: 1, stage: 2, order: 2, title: '2-1' });
  expect(harness.posts()).toHaveLength(1);
});
