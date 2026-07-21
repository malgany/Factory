import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

import { readContractCatalogFile, serializeContractCatalogFile } from '../src/domain/catalog';
import type { ContractCatalogFile } from '../src/domain/types';

export const CONTRACT_CATALOG_ROUTE = '/__factory-admin/contracts';
export const CONTRACT_CATALOG_RELATIVE_PATH = 'public/data/contracts.json';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Owns the development-only endpoint that persists the versioned contract
 * catalog, and prevents invalid catalog data from reaching a production build.
 */
export function contractCatalogPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig | undefined;
  let pendingWrite: Promise<void> = Promise.resolve();

  const getCatalogPath = (): string => {
    if (!resolvedConfig) {
      throw new Error('A configuração do Vite ainda não foi resolvida.');
    }
    return path.resolve(resolvedConfig.root, CONTRACT_CATALOG_RELATIVE_PATH);
  };

  return {
    name: 'factory-contract-catalog',

    configResolved(config) {
      resolvedConfig = config;
    },

    configureServer(server) {
      const catalogPath = getCatalogPath();
      server.watcher.unwatch(catalogPath);

      server.middlewares.use(async (request, response, next) => {
        if (getPathname(request) !== CONTRACT_CATALOG_ROUTE) {
          next();
          return;
        }

        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          sendJson(response, 405, { ok: false, error: 'Método não permitido.' });
          return;
        }

        if (!hasLocalOrigin(request)) {
          sendJson(response, 403, {
            ok: false,
            error: 'A gravação do catálogo só é permitida pelo editor local.',
          });
          return;
        }

        try {
          const body = await readRequestBody(request);
          const parsed = readContractCatalogFile(body);
          if (!parsed.ok) {
            sendJson(response, 400, { ok: false, error: parsed.error });
            return;
          }

          const serialized = serializeContractCatalogFile(parsed.value);
          const write = pendingWrite.then(async () => {
            await fs.mkdir(path.dirname(catalogPath), { recursive: true });
            await fs.writeFile(catalogPath, serialized, 'utf8');
          });
          pendingWrite = write.catch(() => undefined);
          await write;

          sendJson(response, 200, { ok: true, value: parsed.value });
        } catch (error) {
          const status = error instanceof RequestError ? error.status : 500;
          const prefix = status === 500 ? 'Não foi possível gravar o catálogo: ' : '';
          sendJson(response, status, {
            ok: false,
            error: `${prefix}${getErrorMessage(error)}`,
          });
        }
      });
    },

    async buildStart() {
      if (resolvedConfig?.command !== 'build') return;

      const catalogPath = getCatalogPath();
      let source: string;
      try {
        source = await fs.readFile(catalogPath, 'utf8');
      } catch (error) {
        this.error(
          `Não foi possível ler ${CONTRACT_CATALOG_RELATIVE_PATH}: ${getErrorMessage(error)}`,
        );
        return;
      }

      const parsed = readContractCatalogFile(source);
      if (!parsed.ok) {
        this.error(`Catálogo inválido em ${CONTRACT_CATALOG_RELATIVE_PATH}: ${parsed.error}`);
      }
    },
  };
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let tooLarge = false;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_REQUEST_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }

  if (tooLarge) {
    throw new RequestError('O catálogo excede o limite de 2 MB.', 413);
  }

  const source = Buffer.concat(chunks).toString('utf8');
  if (!source.trim()) {
    throw new RequestError('Envie o catálogo no corpo da requisição.', 400);
  }

  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new RequestError('O corpo da requisição não contém um JSON válido.', 400);
  }
}

function getPathname(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '';
  }
}

function hasLocalOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;

  try {
    const hostname = new URL(origin).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: { ok: true; value: ContractCatalogFile } | { ok: false; error: string },
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
