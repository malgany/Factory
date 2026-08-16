import './style.css';

import { appEvents } from './core/events';
import {
  appendCampaignWorld,
  createEmptyContractDraft,
  deleteCampaignWorld,
  deleteContractFromCatalog,
  mergeContractCatalog,
  saveContractToCatalog,
  swapContractSlots,
  updateCampaignWorld,
  validateContractDefinition,
} from './domain/catalog';
import {
  clearContractCompletion,
  completeContract,
  reconcileProgress,
  removeContractProgress,
} from './domain/progress';
import { CONTRACT_CATALOG } from './domain/contracts';
import type {
  ContractCatalogFile,
  ContractDefinition,
  ContractId,
  ProgressSave,
} from './domain/types';
import { createFactoryGame } from './game/createGame';
import { BrowserPlatformService } from './platform/BrowserPlatformService';
import { isLocalAdminHost } from './platform/localAdmin';
import { AppUI } from './ui/AppUI';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Não foi possível iniciar o Factory Flow: #app não encontrado.');
}

const platform = new BrowserPlatformService();
const catalogLoad = await platform.loadContractCatalog();
let catalog: ContractCatalogFile = catalogLoad.ok
  ? catalogLoad.value
  : structuredClone(CONTRACT_CATALOG);
let contracts: ContractDefinition[] = mergeContractCatalog(catalog);
let progress: ProgressSave = reconcileProgress(platform.loadProgress(contracts), contracts);
const initialProgressSave = platform.saveProgress(progress);

const ui = new AppUI({
  root,
  worlds: catalog.worlds,
  contracts,
  progress,
  adminAvailable: import.meta.env.DEV && isLocalAdminHost(window.location.hostname),
  onProgressChange: (nextProgress) => {
    progress = reconcileProgress(nextProgress, contracts);
    const saved = platform.saveProgress(progress);
    if (!saved.ok) {
      appEvents.emit('game:toast', { message: saved.error, tone: 'danger' });
    }
  },
  onRequestFullscreen: () => platform.requestFullscreen(),
});

const game = createFactoryGame(ui.gameContainerId);

if (!catalogLoad.ok) {
  queueMicrotask(() => {
    appEvents.emit('game:toast', { message: catalogLoad.error, tone: 'danger' });
  });
}
if (!initialProgressSave.ok) {
  queueMicrotask(() => {
    appEvents.emit('game:toast', { message: initialProgressSave.error, tone: 'danger' });
  });
}

const eventUnsubscribers = [
  appEvents.on('game:result', ({ contractId, snapshot }) => {
    if (snapshot.status !== 'success' || snapshot.mode !== 'campaign') return;
    const contract = findContract(contractId);
    if (!contract) {
      notify('A fase concluída não foi encontrada no catálogo.', 'danger');
      return;
    }

    progress = completeContract(progress, contract.id, contract.revision, contracts);
    const saved = platform.saveProgress(progress);
    ui.updateProgress(progress);

    appEvents.emit('game:completion-recorded', {
      contractId: contract.id,
      snapshot,
    });

    if (!saved.ok) {
      appEvents.emit('game:toast', { message: saved.error, tone: 'danger' });
    }
    void platform.unlockAchievement(`contract:${contractId}`);
  }),
  appEvents.on('ui:admin-create-contract', ({ world }) => {
    try {
      openEditor(createEmptyContractDraft(catalog, world), true);
    } catch (error) {
      notify(errorMessage(error, 'Não há outro slot disponível neste mundo.'), 'danger');
    }
  }),
  appEvents.on('ui:admin-create-world', ({ backgroundColor, gridColor }) => {
    try {
      const created = appendCampaignWorld(catalog, { backgroundColor, gridColor });
      void commitCatalogChange(
        created.catalog,
        (activeContracts) => reconcileProgress(progress, activeContracts),
        `Mundo ${created.world.world} criado.`,
      ).then((saved) => {
        if (saved) ui.selectAdminWorld(created.world.world);
      });
    } catch (error) {
      notify(errorMessage(error, 'Não foi possível criar o mundo.'), 'danger');
    }
  }),
  appEvents.on('ui:admin-update-world', ({ world, backgroundColor, gridColor }) => {
    try {
      const nextCatalog = updateCampaignWorld(catalog, world, { backgroundColor, gridColor });
      void commitCatalogChange(
        nextCatalog,
        (activeContracts) => reconcileProgress(progress, activeContracts),
        `Cores do Mundo ${world} atualizadas.`,
      );
    } catch (error) {
      notify(errorMessage(error, 'Não foi possível atualizar o mundo.'), 'danger');
    }
  }),
  appEvents.on('ui:admin-delete-world', ({ world }) => {
    try {
      const nextCatalog = deleteCampaignWorld(catalog, world);
      const nextActiveWorld = Math.min(world, nextCatalog.worlds.length);
      void commitCatalogChange(
        nextCatalog,
        (activeContracts) => reconcileProgress(progress, activeContracts),
        `Mundo ${world} excluído.`,
      ).then((saved) => {
        if (saved) ui.selectAdminWorld(nextActiveWorld);
      });
    } catch (error) {
      notify(errorMessage(error, 'Não foi possível excluir o mundo.'), 'danger');
    }
  }),
  appEvents.on('ui:admin-edit-contract', ({ contractId }) => {
    const contract = findContract(contractId);
    if (contract) openEditor(contract, false);
  }),
  appEvents.on('ui:editor-save', ({ contract }) => {
    void saveEditorContract(contract);
  }),
  appEvents.on('ui:editor-test', ({ contract }) => {
    void saveEditorContract(contract, true);
  }),
  appEvents.on(
    'ui:editor-swap-contracts',
    ({ contract, conflictingContractId, beginPreviewAfterSave }) => {
      void saveEditorContract(contract, beginPreviewAfterSave, conflictingContractId);
    },
  ),
  appEvents.on('ui:admin-delete-contract', ({ contractId }) => {
    const title = findContract(contractId)?.title ?? 'Fase';
    try {
      const nextCatalog = deleteContractFromCatalog(catalog, contractId);
      void commitCatalogChange(
        nextCatalog,
        (activeContracts) => removeContractProgress(progress, contractId, activeContracts),
        `“${title}” foi excluída.`,
      );
    } catch (error) {
      notify(errorMessage(error, 'Não foi possível excluir a fase.'), 'danger');
    }
  }),
];

function openEditor(contract: ContractDefinition, isNew: boolean): void {
  const draft = structuredClone(contract);
  const worldTheme = catalog.worlds.find(({ world }) => world === draft.world);
  ui.openAdminEditor(draft, { isNew, dirty: isNew });
  appEvents.emit('ui:start-editor', {
    contract: draft,
    isNew,
    ...(worldTheme ? { worldTheme: structuredClone(worldTheme) } : {}),
  });
}

async function saveEditorContract(
  contract: ContractDefinition,
  beginPreviewAfterSave = false,
  conflictingContractId?: ContractId,
): Promise<void> {
  const validation = validateContractDefinition(contract);
  if (!validation.valid) {
    ui.setEditorMessage({
      tone: 'danger',
      message: 'A fase ainda não pode ser salva.',
      errors: validation.issues.map((issue) => issue.message),
    });
    appEvents.emit('ui:editor-highlight-invalid', {
      paths: [
        ...new Set(
          validation.issues.flatMap((issue) => issue.relatedPaths ?? [issue.path]),
        ),
      ],
    });
    return;
  }

  let nextCatalog: ContractCatalogFile;
  try {
    nextCatalog = conflictingContractId
      ? swapContractSlots(catalog, contract, conflictingContractId)
      : saveContractToCatalog(catalog, contract);
  } catch (error) {
    ui.setEditorMessage({
      tone: 'danger',
      message: errorMessage(error, 'Não foi possível preparar a fase para salvar.'),
    });
    return;
  }

  ui.setCatalogSaving(true, 'editor');
  const catalogSaved = await platform.saveContractCatalog(nextCatalog);
  if (!catalogSaved.ok) {
    ui.setCatalogSaving(false, 'editor');
    ui.setEditorMessage({ tone: 'danger', message: catalogSaved.error });
    return;
  }

  catalog = catalogSaved.value;
  contracts = mergeContractCatalog(catalog);
  const savedContract = findContract(contract.id);
  if (!savedContract) {
    ui.setEditorMessage({
      tone: 'danger',
      message: 'A fase foi gravada, mas não pôde ser reaberta no catálogo.',
    });
    ui.setCatalogSaving(false, 'editor');
    return;
  }

  let nextProgress = clearContractCompletion(progress, contract.id);
  if (conflictingContractId) {
    nextProgress = clearContractCompletion(nextProgress, conflictingContractId);
  }
  progress = reconcileProgress(nextProgress, contracts);
  const progressSaved = platform.saveProgress(progress);
  ui.setCatalogSaving(false, 'editor');
  refreshUI();
  ui.markEditorSaved(
    savedContract,
    conflictingContractId
      ? 'Fases trocadas e salvas no JSON local.'
      : 'Fase salva no JSON local.',
  );
  appEvents.emit('ui:editor-mark-saved', { contract: structuredClone(savedContract) });

  if (!progressSaved.ok) {
    ui.setEditorMessage({
      tone: 'danger',
      message: `A fase foi salva, mas o progresso não pôde ser atualizado. ${progressSaved.error}`,
    });
  }
  if (beginPreviewAfterSave) {
    appEvents.emit('ui:editor-begin-preview', undefined);
  }
}

async function commitCatalogChange(
  nextCatalog: ContractCatalogFile,
  updateProgress: (activeContracts: readonly ContractDefinition[]) => ProgressSave,
  successMessage: string,
): Promise<boolean> {
  ui.setCatalogSaving(true, 'operation');
  const catalogSaved = await platform.saveContractCatalog(nextCatalog);
  if (!catalogSaved.ok) {
    ui.setCatalogSaving(false, 'operation');
    notify(catalogSaved.error, 'danger');
    return false;
  }

  catalog = catalogSaved.value;
  contracts = mergeContractCatalog(catalog);
  progress = updateProgress(contracts);
  const progressSaved = platform.saveProgress(progress);
  refreshUI();
  ui.setCatalogSaving(false, 'operation');

  if (!progressSaved.ok) {
    notify(
      `${successMessage} O progresso não pôde ser atualizado: ${progressSaved.error}`,
      'danger',
    );
  } else {
    notify(successMessage, 'success');
  }
  return true;
}

function refreshUI(): void {
  ui.updateWorlds(catalog.worlds);
  ui.updateContracts(contracts);
  ui.updateProgress(progress);
}

function findContract(contractId: ContractId): ContractDefinition | undefined {
  return contracts.find((contract) => contract.id === contractId);
}

function notify(message: string, tone: 'neutral' | 'success' | 'danger'): void {
  appEvents.emit('game:toast', { message, tone });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const unsubscribe of eventUnsubscribers) unsubscribe();
    ui.destroy();
    game.destroy(true);
    appEvents.clear();
  });
}
