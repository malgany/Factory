import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

import { serializeContractCatalogFile } from '../src/domain/catalog';
import { CONTRACTS } from '../src/domain/contracts';
import type { ContractCatalogFile } from '../src/domain/types';
import { CONTRACT_CATALOG_ROUTE, contractCatalogPlugin } from './contractCatalogPlugin';

const temporaryRoots: string[] = [];
const servers: ViteDevServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function catalog(deliveries = CONTRACTS[0]!.goal.deliveries): ContractCatalogFile {
  const contract = structuredClone(CONTRACTS[0]!);
  contract.goal.deliveries = deliveries;
  return {
    version: 3,
    updatedAt: '2026-07-21T00:00:00.000Z',
    contracts: [contract],
  };
}

async function startTestServer(): Promise<{ root: string; url: string }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'factory-contract-catalog-'));
  temporaryRoots.push(root);
  const catalogPath = path.join(root, 'public', 'data', 'contracts.json');
  await fs.mkdir(path.dirname(catalogPath), { recursive: true });
  await fs.writeFile(catalogPath, serializeContractCatalogFile(catalog()), 'utf8');

  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [contractCatalogPlugin()],
    server: { host: '127.0.0.1', port: 0 },
  });
  servers.push(server);
  await server.listen();
  const address = server.httpServer?.address() as AddressInfo | null;
  if (!address) throw new Error('O servidor de teste não abriu uma porta.');
  return { root, url: `http://127.0.0.1:${address.port}` };
}

describe('contractCatalogPlugin', () => {
  it('grava catálogo válido em formato canônico', async () => {
    const { root, url } = await startTestServer();
    const next = catalog(17);

    const response = await fetch(`${url}${CONTRACT_CATALOG_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify(next),
    });
    const payload = (await response.json()) as { ok: boolean; value?: ContractCatalogFile };
    const written = await fs.readFile(path.join(root, 'public', 'data', 'contracts.json'), 'utf8');

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      value: { contracts: [{ title: '1-1', goal: { deliveries: 17 } }] },
    });
    expect(written).toBe(serializeContractCatalogFile(next));
  });

  it('rejeita catálogo inválido sem alterar a última versão', async () => {
    const { root, url } = await startTestServer();
    const catalogPath = path.join(root, 'public', 'data', 'contracts.json');
    const before = await fs.readFile(catalogPath, 'utf8');

    const response = await fetch(`${url}${CONTRACT_CATALOG_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({ version: 3, contracts: [{ id: 'incompleta' }] }),
    });
    const after = await fs.readFile(catalogPath, 'utf8');

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(after).toBe(before);
  });
});
