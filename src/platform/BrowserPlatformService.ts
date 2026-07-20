import {
  createDefaultContractCatalog,
  readContractCatalog,
  serializeContractCatalog,
} from '../domain/catalog';
import { createDefaultProgress, parseProgress, serializeProgress } from '../domain/progress';
import type {
  ContractCatalogSave,
  ContractDefinition,
  PersistenceResult,
  PlatformService,
  ProgressSave,
} from '../domain/types';

// Keep the original key so existing installations can be migrated in place.
// The version inside the payload is now v2.
const PROGRESS_STORAGE_KEY = 'factory-flow.progress.v1';
const CONTRACT_CATALOG_STORAGE_KEY = 'factory-flow.contracts.v1';

export class BrowserPlatformService implements PlatformService {
  loadProgress(contracts?: readonly ContractDefinition[]): ProgressSave {
    try {
      return parseProgress(window.localStorage.getItem(PROGRESS_STORAGE_KEY), contracts);
    } catch {
      return createDefaultProgress(contracts);
    }
  }

  saveProgress(progress: ProgressSave): PersistenceResult {
    try {
      window.localStorage.setItem(PROGRESS_STORAGE_KEY, serializeProgress(progress));
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        value: undefined,
        error: storageErrorMessage(error, 'Não foi possível salvar o progresso.'),
      };
    }
  }

  loadContractCatalog(): PersistenceResult<ContractCatalogSave> {
    try {
      return readContractCatalog(window.localStorage.getItem(CONTRACT_CATALOG_STORAGE_KEY));
    } catch (error) {
      return {
        ok: false,
        value: createDefaultContractCatalog(),
        error: storageErrorMessage(error, 'Não foi possível carregar as fases locais.'),
      };
    }
  }

  saveContractCatalog(catalog: ContractCatalogSave): PersistenceResult {
    try {
      const validated = readContractCatalog(catalog);
      if (!validated.ok) {
        return { ok: false, value: undefined, error: validated.error };
      }
      window.localStorage.setItem(
        CONTRACT_CATALOG_STORAGE_KEY,
        serializeContractCatalog(validated.value),
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        value: undefined,
        error: storageErrorMessage(error, 'Não foi possível salvar as fases locais.'),
      };
    }
  }

  async requestFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    await document.documentElement.requestFullscreen();
  }

  async unlockAchievement(id: string): Promise<void> {
    window.dispatchEvent(new CustomEvent('factory:achievement', { detail: { id } }));
  }
}

function storageErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback} ${error.message}` : fallback;
}

export { CONTRACT_CATALOG_STORAGE_KEY, PROGRESS_STORAGE_KEY };
