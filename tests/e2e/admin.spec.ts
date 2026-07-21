import { expect, test, type Page } from '@playwright/test';

const PROGRESS_KEY = 'factory-flow.progress.v1';
const LEGACY_CATALOG_KEY = 'factory-flow.contracts.v1';

type AdminMachineType = 'source' | 'conveyor' | 'receiver' | 'spring';

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
}

interface AdminContract {
  id: string;
  order: number;
  title: string;
  subtitle: string;
  description: string;
  grid: { columns: number; rows: number };
  availableMachines: AdminMachineType[];
  fixedMachines: AdminMachine[];
  obstacles: AdminObstacle[];
  goal: {
    deliveries: number;
    maxLosses: number;
    pieceBudget: number;
    timeLimitSeconds?: number;
    parPieces: number;
    parTimeSeconds?: number;
  };
  spawnIntervalSeconds: number;
  initialCamera: AdminCamera;
}

interface AdminCatalog {
  version: 1;
  updatedAt: string;
  contracts: AdminContract[];
}

type AdminWindow = Window & {
  __FACTORY_DEBUG__?: {
    getSnapshot(): { mode: string; contractId?: string };
    getEditorDraft(): AdminContract;
    getMachines(): AdminMachine[];
    getObstacles(): AdminObstacle[];
    getCamera(): AdminCameraSnapshot;
    setCamera(centerX: number, centerY: number, zoom: number): void;
    placeMachine(type: AdminMachineType, gridX: number, gridY: number, angle?: number): boolean;
    selectMachine(id: string): boolean;
    rotateSelected(angle: number): boolean;
    placeObstacle(gridX: number, gridY: number, columns?: number, rows?: number): boolean;
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
  order: number,
  title: string,
  initialCamera: AdminCamera = { centerX: 720, centerY: 432, zoom: 1 },
): AdminContract {
  return {
    id,
    order,
    title,
    subtitle: `Subtítulo de ${title}`,
    description: `Descrição de ${title}`,
    grid: { columns: 30, rows: 18 },
    availableMachines: ['conveyor', 'spring'],
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
    goal: {
      deliveries: 10,
      maxLosses: 3,
      pieceBudget: 8,
      parPieces: 7,
      parTimeSeconds: 32,
    },
    spawnIntervalSeconds: 1.25,
    initialCamera: { ...initialCamera },
  };
}

function makeCatalog(...contracts: AdminContract[]): AdminCatalog {
  return normalizeHarnessCatalog({
    version: 1,
    updatedAt: new Date(0).toISOString(),
    contracts,
  });
}

function normalizeHarnessCatalog(catalog: AdminCatalog): AdminCatalog {
  const normalized = clone(catalog);
  normalized.contracts = [...normalized.contracts]
    .sort((left, right) => left.order - right.order)
    .map((contract, index) => ({ ...contract, order: index + 1 }));
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

async function seedProgress(page: Page, contractIds: string[]): Promise<void> {
  await page.addInitScript(
    ({ key, ids }) => {
      const makeResult = (contractId: string) => ({
        contractId,
        stars: 3,
        metrics: {
          delivered: 10,
          lost: 0,
          active: 0,
          elapsedSeconds: 20,
          placedPieces: 6,
        },
      });
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 2,
          unlockedContracts: ids,
          bestResults: Object.fromEntries(ids.map((id) => [id, makeResult(id)])),
          settings: { muted: false, volume: 0.65 },
          sandbox: { machines: [], updatedAt: new Date(0).toISOString() },
        }),
      );
    },
    { key: PROGRESS_KEY, ids: contractIds },
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
  const first = makeContract('first-flow', 1, 'Primeiro Fluxo');
  const second = makeContract('controlled-jump', 2, 'Salto Controlado');
  const harness = await installCatalogHarness(page, makeCatalog(first, second));
  await seedProgress(page, [first.id, second.id]);
  await openApp(page);

  const adminToggle = page.locator('#admin-toggle');
  await expect(adminToggle).toContainText('Ativar admin');
  await expect(page.locator('#create-contract-button')).toHaveClass(/is-hidden/);
  await enableAdmin(page);
  await expect(page.locator('.contract-entry')).toHaveCount(2);

  await page.getByRole('button', { name: 'Editar Primeiro Fluxo' }).click();
  await expect(page.locator('#editor-rail')).not.toHaveClass(/is-hidden/);
  await page.locator('[data-action="editor-configure"]').first().click();
  await page
    .locator('#editor-contract-form input[name="subtitle"]')
    .fill('Versão JSON do contrato');
  await page.locator('[data-action="editor-save"]').click();
  await expect(page.locator('#editor-feedback')).toContainText('Fase salva no JSON local');
  await expect.poll(() => harness.posts().length).toBe(1);
  expect(harness.current().contracts.find(({ id }) => id === first.id)?.subtitle).toBe(
    'Versão JSON do contrato',
  );

  const progressAfterEdit = await getProgress(page);
  expect((progressAfterEdit.bestResults as Record<string, unknown>)[first.id]).toBeUndefined();
  expect((progressAfterEdit.bestResults as Record<string, unknown>)[second.id]).toBeTruthy();
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
  await page.locator('#editor-contract-form input[name="title"]').fill('Fluxo de Teste Admin');

  const progressBeforePreview = await page.evaluate(
    (key) => localStorage.getItem(key),
    PROGRESS_KEY,
  );
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
  await expect(page.locator('#editor-feedback')).toContainText('Fase salva no JSON local');
  await expect.poll(() => harness.current().contracts.length).toBe(3);
  expect(harness.current().contracts.find(({ id }) => id === draftId)).toMatchObject({
    title: 'Fluxo de Teste Admin',
    fixedMachines: expect.arrayContaining([
      expect.objectContaining({ type: 'source', fixed: true }),
      expect.objectContaining({ type: 'receiver', fixed: true }),
    ]),
    obstacles: [expect.objectContaining({ gridX: 9, gridY: 6, columns: 3, rows: 2 })],
  });

  await page.locator('[data-action="editor-cancel"]').click();
  const originalEntry = page.locator('.contract-entry').filter({ hasText: 'Primeiro Fluxo' });
  await originalEntry.locator('.text-button.danger').click();
  await page.locator('[data-action="admin-confirm-accept"]').click();
  await expect
    .poll(() => harness.current().contracts.some(({ id }) => id === first.id))
    .toBe(false);
  await expect(page.locator('.contract-entry')).toHaveCount(2);
  expect(harness.current().contracts.map(({ id }) => id)).toEqual([second.id, draftId]);
  expect(harness.current().contracts.map(({ order }) => order)).toEqual([1, 2]);
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_CATALOG_KEY)).toBeNull();
});

test('permite catálogo vazio e desbloqueia a primeira fase recriada', async ({ page }) => {
  const onlyContract = makeContract('only-stage', 1, 'Fase Única');
  const harness = await installCatalogHarness(page, makeCatalog(onlyContract));
  await openApp(page);
  await enableAdmin(page);

  const onlyEntry = page.locator('.contract-entry').filter({ hasText: onlyContract.title });
  await onlyEntry.locator('.text-button.danger').click();
  await page.locator('[data-action="admin-confirm-accept"]').click();
  await expect.poll(() => harness.current().contracts.length).toBe(0);
  await expect(page.locator('.contract-empty-state')).toContainText('Nenhuma fase publicada');
  await expect(page.locator('.contract-empty-state')).toContainText('Crie a primeira fase');
  await expect(page.locator('[data-start-sandbox]')).toBeVisible();
  await expect(page.locator('#create-contract-button')).toBeVisible();

  await page.locator('#create-contract-button').click();
  const recreatedId = await authorRequiredEntities(page);
  await page.locator('[data-action="editor-configure"]').first().click();
  await page.locator('#editor-contract-form input[name="title"]').fill('Primeira Recriada');
  await page.locator('[data-action="editor-save"]').click();
  await expect(page.locator('#editor-feedback')).toContainText('Fase salva no JSON local');
  await expect.poll(() => harness.current().contracts.length).toBe(1);
  expect(harness.current().contracts[0]).toMatchObject({
    id: recreatedId,
    order: 1,
    title: 'Primeira Recriada',
  });

  const progress = await getProgress(page);
  expect(progress.unlockedContracts).toEqual([recreatedId]);
  await page.locator('[data-action="editor-cancel"]').click();
  await page.locator('#admin-toggle').click();
  const playerCard = page.locator('#contract-list .stage-contract-card');
  await expect(playerCard).toHaveCount(1);
  await expect(playerCard).toBeEnabled();
});

test('salva a câmera autorada, recarrega o editor e inicia a campanha no mesmo enquadramento', async ({
  page,
}) => {
  const contract = makeContract('camera-stage', 1, 'Câmera Precisa');
  const harness = await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: `Editar ${contract.title}` }).click();

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
  await page.getByRole('button', { name: `Editar ${contract.title}` }).click();
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
  await playerCard.click();
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
  const pointerX = canvasBounds.x + canvasBounds.width * 0.82;
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
  const contract = makeContract('preview-camera-stage', 1, 'Câmera da Prévia');
  const harness = await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: `Editar ${contract.title}` }).click();

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
  expect(harness.posts()).toHaveLength(0);
});

test('bloqueia autoria e saída do editor enquanto o POST está pendente', async ({ page }) => {
  const contract = makeContract('pending-save-stage', 1, 'Gravação Pendente');
  const harness = await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: `Editar ${contract.title}` }).click();
  await page.locator('[data-action="editor-configure"]').first().click();
  await page.locator('#editor-contract-form input[name="title"]').fill('Versão Confirmada');

  const cameraBefore = await page.evaluate(() => {
    const camera = (window as AdminWindow).__FACTORY_DEBUG__!.getCamera();
    return { centerX: camera.centerX, centerY: camera.centerY, zoom: camera.zoom };
  });
  const release = harness.holdNextPostUntilRelease();
  await page.locator('[data-action="editor-save"]').click();
  await expect.poll(() => harness.posts().length).toBe(1);

  await expect(page.locator('#game-ui')).toHaveAttribute('inert', '');
  await expect(page.locator('#game-container')).toHaveAttribute('inert', '');
  await expect(page.locator('#editor-contract-form input[name="title"]')).toBeDisabled();
  await expect(page.locator('[data-action="editor-cancel"]')).toBeDisabled();
  const blocked = await page.evaluate(() => {
    const debug = (window as AdminWindow).__FACTORY_DEBUG__!;
    debug.setCamera(1200, 650, 2);
    return {
      placed: debug.placeMachine('conveyor', 8.25, 8.25),
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
  expect(harness.current().contracts[0]?.title).toBe('Versão Confirmada');
});

test('mantém o rascunho sujo e mostra o erro quando o POST falha', async ({ page }) => {
  const contract = makeContract('post-failure-stage', 1, 'Falha de Persistência');
  const harness = await installCatalogHarness(page, makeCatalog(contract));
  await openApp(page);
  await enableAdmin(page);
  await page.getByRole('button', { name: `Editar ${contract.title}` }).click();
  await page.locator('[data-action="editor-configure"]').first().click();
  await page.locator('#editor-contract-form input[name="title"]').fill('Rascunho Retido');

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
  expect(harness.current().contracts[0]?.title).toBe(contract.title);
  expect(
    await page.evaluate(() => (window as AdminWindow).__FACTORY_DEBUG__?.getEditorDraft().title),
  ).toBe('Rascunho Retido');
  expect(harness.posts()).toHaveLength(1);
});
