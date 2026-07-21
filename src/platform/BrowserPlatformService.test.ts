import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONTRACTS } from '../domain/contracts';
import type { ContractCatalogFile } from '../domain/types';
import {
  BrowserPlatformService,
  CONTRACT_CATALOG_URL,
  CONTRACT_CATALOG_WRITE_URL,
  PROGRESS_STORAGE_KEY,
} from './BrowserPlatformService';

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
    setItem: (key, value) => values.set(key, value),
  };
}

function catalog(): ContractCatalogFile {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    contracts: CONTRACTS.map((contract) => structuredClone(contract)),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('BrowserPlatformService', () => {
  it('carrega o catálogo do JSON público sem consultar o localStorage', async () => {
    const localStorage = fakeStorage({ 'factory-flow.contracts.v1': '{legado}' });
    vi.stubGlobal('window', { localStorage });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(catalog()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const loaded = await new BrowserPlatformService().loadContractCatalog();

    expect(loaded.ok).toBe(true);
    expect(loaded.value.contracts).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledWith(CONTRACT_CATALOG_URL, { cache: 'no-store' });
    expect(localStorage.getItem('factory-flow.contracts.v1')).toBe('{legado}');
  });

  it('salva no endpoint local e devolve o catálogo confirmado pelo servidor', async () => {
    const localStorage = fakeStorage();
    vi.stubGlobal('window', { localStorage });
    const source = catalog();
    source.contracts[0]!.title = 'Persistida no JSON';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, value: source }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const saved = await new BrowserPlatformService().saveContractCatalog(source);

    expect(saved.ok).toBe(true);
    expect(saved.value.contracts[0]?.title).toBe('Persistida no JSON');
    expect(fetchMock).toHaveBeenCalledWith(
      CONTRACT_CATALOG_WRITE_URL,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(localStorage.length).toBe(0);
  });

  it('sinaliza catálogo remoto corrompido e recupera um catálogo vazio', async () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{quebrado', { status: 200 })));

    const loaded = await new BrowserPlatformService().loadContractCatalog();

    expect(loaded.ok).toBe(false);
    expect(loaded.value.contracts).toEqual([]);
  });

  it('mantém progresso no localStorage e reporta falha de escrita do catálogo', async () => {
    const localStorage = fakeStorage();
    vi.stubGlobal('window', { localStorage });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'Arquivo bloqueado.' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const service = new BrowserPlatformService();
    const progress = service.loadProgress(CONTRACTS);
    expect(service.saveProgress(progress).ok).toBe(true);

    const saved = await service.saveContractCatalog(catalog());

    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error).toContain('Arquivo bloqueado');
    expect(localStorage.getItem(PROGRESS_STORAGE_KEY)).not.toBeNull();
  });
});
