import { describe, expect, it } from 'vitest';

import {
  appendCustomContract,
  createCustomContractId,
  createDefaultContractCatalog,
  deleteContractFromCatalog,
  mergeContractCatalog,
  readContractCatalogFile,
  saveContractToCatalog,
  serializeContractCatalogFile,
  validateContractDefinition,
  type NewContractDefinition,
} from './catalog';
import { CONTRACTS } from './contracts';
import type { ContractCatalogFile } from './types';
import {
  GRID_COLUMNS,
  GRID_ROWS,
  PLAY_AREA_MAX_COLUMN,
  PLAY_AREA_MAX_ROW,
  PLAY_AREA_MIN_COLUMN,
  PLAY_AREA_MIN_ROW,
} from './types';

function seededCatalog(): ContractCatalogFile {
  return {
    version: 1,
    contracts: CONTRACTS.map((contract) => structuredClone(contract)),
    updatedAt: new Date(0).toISOString(),
  };
}

function customDefinition(): NewContractDefinition {
  const definition: NewContractDefinition = structuredClone(CONTRACTS[0]!);
  delete definition.id;
  delete definition.order;
  definition.title = 'Fase personalizada';
  return definition;
}

describe('catálogo JSON de contratos', () => {
  it('edita, cria e exclui qualquer fase em ordem sequencial', () => {
    let catalog = saveContractToCatalog(seededCatalog(), {
      ...structuredClone(CONTRACTS[0]!),
      title: 'Primeiro Fluxo editado',
    });
    catalog = appendCustomContract(catalog, {
      ...customDefinition(),
      id: 'custom-fixture',
    }).catalog;
    catalog = deleteContractFromCatalog(catalog, 'controlled-jump');

    const contracts = mergeContractCatalog(catalog);
    expect(contracts.map(({ order }) => order)).toEqual([1, 2, 3]);
    expect(contracts[0]).toMatchObject({ id: 'first-flow', title: 'Primeiro Fluxo editado' });
    expect(contracts.at(-1)?.id).toBe('custom-fixture');
  });

  it('gera IDs estáveis e permite excluir até a última fase', () => {
    expect(createCustomContractId(() => '00000000-0000-4000-8000-000000000000')).toBe(
      'custom-00000000-0000-4000-8000-000000000000',
    );
    const only = { ...seededCatalog(), contracts: [structuredClone(CONTRACTS[0]!)] };
    expect(deleteContractFromCatalog(only, 'first-flow').contracts).toEqual([]);
  });

  it('aceita um catálogo vazio e rejeita JSON corrompido sem dados parciais', () => {
    const empty = readContractCatalogFile(createDefaultContractCatalog());
    expect(empty).toEqual({ ok: true, value: createDefaultContractCatalog() });

    expect(readContractCatalogFile('').ok).toBe(false);
    expect(
      readContractCatalogFile({ version: 1, updatedAt: 'data-inválida', contracts: [] }).ok,
    ).toBe(false);
    expect(
      readContractCatalogFile({ version: 1, updatedAt: 'July 21, 2026', contracts: [] }).ok,
    ).toBe(false);

    const invalidJson = readContractCatalogFile('{quebrado');
    expect(invalidJson.ok).toBe(false);
    expect(invalidJson.value.contracts).toEqual([]);

    const malformed = readContractCatalogFile({
      version: 1,
      contracts: [{ id: 'custom-incompleta' }],
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.value.contracts).toEqual([]);
  });

  it('serializa formatado, normaliza câmera e restaura o catálogo completo', () => {
    const source = seededCatalog();
    source.contracts[0]!.initialCamera = {
      centerX: 720.12345,
      centerY: 431.98765,
      zoom: 1.234567,
    };
    source.contracts[0]!.spawnIntervalSeconds = 1.234567;
    source.contracts[0]!.fixedMachines[0]!.angle = 12.345678;
    const serialized = serializeContractCatalogFile(source);
    const restored = readContractCatalogFile(serialized);

    expect(serialized).toContain('\n  "version": 1');
    expect(serialized.endsWith('\n')).toBe(true);
    expect(restored.ok).toBe(true);
    expect(restored.value.contracts[0]?.initialCamera).toEqual({
      centerX: 720.12,
      centerY: 431.99,
      zoom: 1.2346,
    });
    expect(restored.value.contracts[0]?.spawnIntervalSeconds).toBe(1.2346);
    expect(restored.value.contracts[0]?.fixedMachines[0]?.angle).toBe(12.3457);
  });

  it('valida campos, câmera, entidades, limites, sobreposição e orçamento', () => {
    const valid = structuredClone(CONTRACTS[0]!);
    expect(validateContractDefinition(valid)).toEqual({ valid: true, issues: [] });

    const invalid = structuredClone(valid);
    invalid.id = 'id com espaços';
    invalid.title = '';
    invalid.goal.parPieces = invalid.goal.pieceBudget + 1;
    invalid.initialCamera.zoom = 3;
    invalid.fixedMachines[1] = {
      ...invalid.fixedMachines[0]!,
      id: 'overlapping-receiver',
      type: 'receiver',
    };
    const codes = validateContractDefinition(invalid).issues.map(({ code }) => code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'invalid-id',
        'required',
        'par-over-budget',
        'invalid-camera',
        'overlap',
      ]),
    );
  });

  it('aceita cenários além do quadro inicial dentro dos limites expandidos', () => {
    const expanded = structuredClone(CONTRACTS[0]!);
    expanded.fixedMachines[0] = {
      ...expanded.fixedMachines[0]!,
      gridX: PLAY_AREA_MIN_COLUMN + 1,
      gridY: PLAY_AREA_MIN_ROW + 1,
    };
    expanded.fixedMachines[1] = {
      ...expanded.fixedMachines[1]!,
      gridX: PLAY_AREA_MAX_COLUMN - 2,
      gridY: PLAY_AREA_MAX_ROW - 2,
    };
    expanded.obstacles = [
      {
        id: 'expanded-obstacle',
        gridX: GRID_COLUMNS + 12,
        gridY: GRID_ROWS + 8,
        columns: 2,
        rows: 2,
      },
    ];

    expect(validateContractDefinition(expanded)).toEqual({ valid: true, issues: [] });

    const outside = structuredClone(expanded);
    outside.fixedMachines[0] = { ...outside.fixedMachines[0]!, gridX: PLAY_AREA_MIN_COLUMN - 1 };
    outside.obstacles[0] = { ...outside.obstacles[0]!, gridX: PLAY_AREA_MAX_COLUMN };
    expect(validateContractDefinition(outside).issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['out-of-bounds']),
    );
  });
});
