import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendCustomContract,
  createDefaultContractCatalog,
  mergeContractCatalog,
  type NewContractDefinition,
} from '../domain/catalog';
import { CONTRACTS } from '../domain/contracts';
import { BrowserPlatformService, CONTRACT_CATALOG_STORAGE_KEY } from './BrowserPlatformService';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function customDefinition(): NewContractDefinition {
  const definition: NewContractDefinition = structuredClone(CONTRACTS[0]!);
  delete definition.id;
  delete definition.order;
  definition.title = 'Persistida';
  return definition;
}

afterEach(() => vi.unstubAllGlobals());

describe('BrowserPlatformService', () => {
  it('salva e carrega o catálogo em uma chave separada', () => {
    const localStorage = fakeStorage();
    vi.stubGlobal('window', { localStorage });
    const service = new BrowserPlatformService();
    const catalog = appendCustomContract(createDefaultContractCatalog(), {
      ...customDefinition(),
      id: 'custom-storage',
    }).catalog;

    expect(service.saveContractCatalog(catalog).ok).toBe(true);
    expect(localStorage.getItem(CONTRACT_CATALOG_STORAGE_KEY)).not.toBeNull();
    const loaded = service.loadContractCatalog();
    expect(loaded.ok).toBe(true);
    expect(mergeContractCatalog(loaded.value).at(-1)?.id).toBe('custom-storage');
  });

  it('sinaliza catálogo corrompido e recupera os padrões', () => {
    vi.stubGlobal('window', {
      localStorage: fakeStorage({ [CONTRACT_CATALOG_STORAGE_KEY]: '{quebrado' }),
    });
    const loaded = new BrowserPlatformService().loadContractCatalog();

    expect(loaded.ok).toBe(false);
    expect(mergeContractCatalog(loaded.value)).toHaveLength(3);
  });

  it('retorna erro de escrita e mantém a última versão válida', () => {
    const previous = 'versão anterior';
    const localStorage = fakeStorage({ [CONTRACT_CATALOG_STORAGE_KEY]: previous });
    localStorage.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
    vi.stubGlobal('window', { localStorage });

    const saved = new BrowserPlatformService().saveContractCatalog(createDefaultContractCatalog());
    expect(saved.ok).toBe(false);
    expect(localStorage.getItem(CONTRACT_CATALOG_STORAGE_KEY)).toBe(previous);
  });
});
