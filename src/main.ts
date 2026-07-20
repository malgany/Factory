import './style.css';

import { appEvents } from './core/events';
import {
  createEmptyContractDraft,
  deleteCustomContract,
  getContractCatalogMetadataMap,
  mergeContractCatalog,
  restoreBuiltinContract,
  saveContractToCatalog,
  validateContractDefinition,
} from './domain/catalog';
import { isBuiltinContractId } from './domain/contracts';
import {
  applyContractResult,
  clearContractRecord,
  reconcileProgress,
  removeContractProgress,
} from './domain/progress';
import type {
  ContractCatalogSave,
  ContractDefinition,
  ContractId,
  ProgressSave,
} from './domain/types';
import { createFactoryGame } from './game/createGame';
import { BrowserPlatformService } from './platform/BrowserPlatformService';
import { isLocalAdminHost } from './platform/localAdmin';
import { AppUI, type AdminContractMetadata } from './ui/AppUI';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Não foi possível iniciar o Factory Flow: #app não encontrado.');
}

const platform = new BrowserPlatformService();
const catalogLoad = platform.loadContractCatalog();
let catalog: ContractCatalogSave = catalogLoad.value;
let contracts: ContractDefinition[] = mergeContractCatalog(catalog);
let progress: ProgressSave = reconcileProgress(platform.loadProgress(contracts), contracts);

const ui = new AppUI({
  root,
  contracts,
  contractMetadata: createUIMetadata(catalog),
  progress,
  adminAvailable: isLocalAdminHost(window.location.hostname),
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

const eventUnsubscribers = [
  appEvents.on('game:result', ({ contractId, stars, snapshot }) => {
    if (snapshot.status !== 'success' || snapshot.mode !== 'campaign') return;
    progress = applyContractResult(
      progress,
      { contractId, stars, metrics: { ...snapshot.metrics } },
      contracts,
    );
    const saved = platform.saveProgress(progress);
    ui.updateProgress(progress);
    if (!saved.ok) {
      appEvents.emit('game:toast', { message: saved.error, tone: 'danger' });
    }
    void platform.unlockAchievement(`contract:${contractId}`);
    if (stars === 3) void platform.unlockAchievement(`contract:${contractId}:perfect`);
  }),
  appEvents.on('ui:admin-create-contract', () => {
    openEditor(createEmptyContractDraft(catalog), true);
  }),
  appEvents.on('ui:admin-edit-contract', ({ contractId }) => {
    const contract = findContract(contractId);
    if (contract) openEditor(contract, false);
  }),
  appEvents.on('ui:editor-save', ({ contract }) => saveEditorContract(contract)),
  appEvents.on('ui:admin-restore-contract', ({ contractId }) => {
    if (!isBuiltinContractId(contractId)) {
      notify('Esta fase não é uma fase original.', 'danger');
      return;
    }
    const nextCatalog = restoreBuiltinContract(catalog, contractId);
    commitCatalogChange(
      nextCatalog,
      (activeContracts) =>
        reconcileProgress(clearContractRecord(progress, contractId), activeContracts),
      `“${findContract(contractId)?.title ?? 'Fase'}” foi restaurada.`,
    );
  }),
  appEvents.on('ui:admin-delete-contract', ({ contractId }) => {
    if (isBuiltinContractId(contractId)) {
      notify('Fases originais não podem ser excluídas.', 'danger');
      return;
    }
    const title = findContract(contractId)?.title ?? 'Fase personalizada';
    try {
      const nextCatalog = deleteCustomContract(catalog, contractId);
      commitCatalogChange(
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
  ui.openAdminEditor(draft, { isNew, dirty: isNew });
  appEvents.emit('ui:start-editor', { contract: draft, isNew });
}

function saveEditorContract(contract: ContractDefinition): void {
  const validation = validateContractDefinition(contract);
  if (!validation.valid) {
    ui.setEditorMessage({
      tone: 'danger',
      message: 'A fase ainda não pode ser salva.',
      errors: validation.issues.map((issue) => issue.message),
    });
    return;
  }

  let nextCatalog: ContractCatalogSave;
  try {
    nextCatalog = saveContractToCatalog(catalog, contract);
  } catch (error) {
    ui.setEditorMessage({
      tone: 'danger',
      message: errorMessage(error, 'Não foi possível preparar a fase para salvar.'),
    });
    return;
  }

  const catalogSaved = platform.saveContractCatalog(nextCatalog);
  if (!catalogSaved.ok) {
    ui.setEditorMessage({ tone: 'danger', message: catalogSaved.error });
    return;
  }

  catalog = nextCatalog;
  contracts = mergeContractCatalog(catalog);
  const savedContract = findContract(contract.id);
  if (!savedContract) {
    ui.setEditorMessage({
      tone: 'danger',
      message: 'A fase foi gravada, mas não pôde ser reaberta no catálogo.',
    });
    return;
  }

  progress = reconcileProgress(clearContractRecord(progress, contract.id), contracts);
  const progressSaved = platform.saveProgress(progress);
  refreshUI();
  ui.markEditorSaved(savedContract);
  appEvents.emit('ui:editor-mark-saved', { contract: structuredClone(savedContract) });

  if (!progressSaved.ok) {
    ui.setEditorMessage({
      tone: 'danger',
      message: `A fase foi salva, mas o recorde não pôde ser atualizado. ${progressSaved.error}`,
    });
  }
}

function commitCatalogChange(
  nextCatalog: ContractCatalogSave,
  updateProgress: (activeContracts: readonly ContractDefinition[]) => ProgressSave,
  successMessage: string,
): boolean {
  const catalogSaved = platform.saveContractCatalog(nextCatalog);
  if (!catalogSaved.ok) {
    notify(catalogSaved.error, 'danger');
    return false;
  }

  catalog = nextCatalog;
  contracts = mergeContractCatalog(catalog);
  progress = updateProgress(contracts);
  const progressSaved = platform.saveProgress(progress);
  refreshUI();

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
  ui.updateContracts(contracts, createUIMetadata(catalog));
  ui.updateProgress(progress);
}

function findContract(contractId: ContractId): ContractDefinition | undefined {
  return contracts.find((contract) => contract.id === contractId);
}

function createUIMetadata(
  activeCatalog: ContractCatalogSave,
): Record<string, AdminContractMetadata> {
  const metadata = getContractCatalogMetadataMap(activeCatalog);
  return Object.fromEntries(
    Object.entries(metadata).map(([contractId, item]) => [
      contractId,
      {
        kind: item.builtIn ? 'builtin' : 'custom',
        ...(item.overridden ? { overridden: true } : {}),
      },
    ]),
  );
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
