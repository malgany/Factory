import {
  createDefaultContractCatalog,
  readContractCatalogFile,
  serializeContractCatalogFile,
} from '../domain/catalog';
import { createDefaultProgress, parseProgress, serializeProgress } from '../domain/progress';
import type {
  ContractCatalogFile,
  ContractDefinition,
  PersistenceResult,
  PlatformService,
  ProgressSave,
} from '../domain/types';

// Keep the original key so existing installations can be migrated in place.
// The version inside the payload is migrated independently.
const PROGRESS_STORAGE_KEY = 'factory-flow.progress.v1';
const CONTRACT_CATALOG_URL = `${import.meta.env.BASE_URL}data/contracts.json`;
const CONTRACT_CATALOG_WRITE_URL = '/__factory-admin/contracts';

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

  async loadContractCatalog(): Promise<PersistenceResult<ContractCatalogFile>> {
    try {
      const response = await fetch(CONTRACT_CATALOG_URL, { cache: 'no-store' });
      if (!response.ok) {
        return {
          ok: false,
          value: createDefaultContractCatalog(),
          error: `Não foi possível carregar o catálogo de fases (${response.status}).`,
        };
      }
      return readContractCatalogFile(await response.text());
    } catch (error) {
      return {
        ok: false,
        value: createDefaultContractCatalog(),
        error: storageErrorMessage(error, 'Não foi possível carregar o catálogo de fases.'),
      };
    }
  }

  async saveContractCatalog(
    catalog: ContractCatalogFile,
  ): Promise<PersistenceResult<ContractCatalogFile>> {
    try {
      const validated = readContractCatalogFile(catalog);
      if (!validated.ok) {
        return validated;
      }
      if (!import.meta.env.DEV) {
        return {
          ok: false,
          value: validated.value,
          error: 'A gravação de fases só está disponível no servidor local de desenvolvimento.',
        };
      }

      const response = await fetch(CONTRACT_CATALOG_WRITE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: serializeContractCatalogFile(validated.value),
      });
      const payload = (await response.json().catch(() => undefined)) as unknown;
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const message = isRecord(payload) && typeof payload.error === 'string' ? payload.error : '';
        return {
          ok: false,
          value: validated.value,
          error: message || `Não foi possível salvar o catálogo de fases (${response.status}).`,
        };
      }
      const saved = readContractCatalogFile(payload.value);
      return saved.ok
        ? saved
        : {
            ok: false,
            value: validated.value,
            error: 'O servidor gravou o arquivo, mas devolveu um catálogo inválido.',
          };
    } catch (error) {
      return {
        ok: false,
        value: createDefaultContractCatalog(),
        error: storageErrorMessage(error, 'Não foi possível salvar o catálogo de fases.'),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storageErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback} ${error.message}` : fallback;
}

export { CONTRACT_CATALOG_URL, CONTRACT_CATALOG_WRITE_URL, PROGRESS_STORAGE_KEY };
