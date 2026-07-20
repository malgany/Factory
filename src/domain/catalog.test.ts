import { describe, expect, it } from 'vitest';

import {
  appendCustomContract,
  createCustomContractId,
  createDefaultContractCatalog,
  deleteCustomContract,
  getContractCatalogMetadata,
  mergeContractCatalog,
  readContractCatalog,
  restoreBuiltinContract,
  saveContractToCatalog,
  serializeContractCatalog,
  validateContractDefinition,
  type NewContractDefinition,
} from './catalog';
import { CONTRACTS } from './contracts';
import {
  GRID_COLUMNS,
  GRID_ROWS,
  PLAY_AREA_MAX_COLUMN,
  PLAY_AREA_MAX_ROW,
  PLAY_AREA_MIN_COLUMN,
  PLAY_AREA_MIN_ROW,
} from './types';

function customDefinition(): NewContractDefinition {
  const definition: NewContractDefinition = structuredClone(CONTRACTS[0]!);
  delete definition.id;
  delete definition.order;
  definition.title = 'Fase personalizada';
  return definition;
}

describe('catálogo local de contratos', () => {
  it('combina padrões, overrides e fases personalizadas em ordem sequencial', () => {
    let catalog = createDefaultContractCatalog();
    catalog = saveContractToCatalog(catalog, {
      ...structuredClone(CONTRACTS[0]!),
      title: 'Primeiro Fluxo editado',
    });
    const appended = appendCustomContract(catalog, {
      ...customDefinition(),
      id: 'custom-fixture',
    });
    catalog = appended.catalog;

    const contracts = mergeContractCatalog(catalog);
    expect(contracts).toHaveLength(4);
    expect(contracts.map(({ order }) => order)).toEqual([1, 2, 3, 4]);
    expect(contracts[0]?.title).toBe('Primeiro Fluxo editado');
    expect(contracts[3]?.id).toBe('custom-fixture');
    expect(getContractCatalogMetadata(catalog, 'first-flow')).toEqual({
      builtIn: true,
      custom: false,
      overridden: true,
    });
  });

  it('gera IDs UUID estáveis e não permite excluir uma fase nativa', () => {
    expect(createCustomContractId(() => '00000000-0000-4000-8000-000000000000')).toBe(
      'custom-00000000-0000-4000-8000-000000000000',
    );
    expect(() => deleteCustomContract(createDefaultContractCatalog(), 'first-flow')).toThrow(
      'originais',
    );
  });

  it('restaura override nativo, exclui fase personalizada e reorganiza ordens', () => {
    let catalog = saveContractToCatalog(createDefaultContractCatalog(), {
      ...structuredClone(CONTRACTS[0]!),
      title: 'Editada',
    });
    catalog = appendCustomContract(catalog, {
      ...customDefinition(),
      id: 'custom-a',
    }).catalog;
    catalog = appendCustomContract(catalog, {
      ...customDefinition(),
      id: 'custom-b',
    }).catalog;
    catalog = restoreBuiltinContract(catalog, 'first-flow');
    catalog = deleteCustomContract(catalog, 'custom-a');

    const contracts = mergeContractCatalog(catalog);
    expect(contracts[0]?.title).toBe(CONTRACTS[0]?.title);
    expect(contracts.at(-1)).toMatchObject({ id: 'custom-b', order: 4 });
  });

  it('recupera catálogo corrompido sem aproveitar dados parciais', () => {
    const invalidJson = readContractCatalog('{quebrado');
    expect(invalidJson.ok).toBe(false);
    expect(mergeContractCatalog(invalidJson.value)).toHaveLength(3);

    const malformed = readContractCatalog({
      version: 1,
      overrides: {},
      customContracts: [{ id: 'custom-incompleta' }],
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.value.customContracts).toEqual([]);
  });

  it('serializa e restaura um catálogo válido', () => {
    const catalog = appendCustomContract(createDefaultContractCatalog(), {
      ...customDefinition(),
      id: 'custom-persistida',
    }).catalog;
    const restored = readContractCatalog(serializeContractCatalog(catalog));

    expect(restored.ok).toBe(true);
    expect(mergeContractCatalog(restored.value).at(-1)?.id).toBe('custom-persistida');
  });

  it('valida campos, entidades, limites, sobreposição e orçamento de referência', () => {
    const valid = structuredClone(CONTRACTS[0]!);
    expect(validateContractDefinition(valid)).toEqual({ valid: true, issues: [] });

    const invalid = structuredClone(valid);
    invalid.id = 'id com espaços';
    invalid.title = '';
    invalid.goal.parPieces = invalid.goal.pieceBudget + 1;
    invalid.fixedMachines[1] = {
      ...invalid.fixedMachines[0]!,
      id: 'overlapping-receiver',
      type: 'receiver',
    };
    const validation = validateContractDefinition(invalid);
    expect(validation.valid).toBe(false);
    expect(validation.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['invalid-id', 'required', 'par-over-budget', 'overlap']),
    );
  });

  it('accepts scenarios beyond the initial frame within the expanded bounds', () => {
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
    outside.fixedMachines[0] = {
      ...outside.fixedMachines[0]!,
      gridX: PLAY_AREA_MIN_COLUMN - 1,
    };
    outside.obstacles[0] = {
      ...outside.obstacles[0]!,
      gridX: PLAY_AREA_MAX_COLUMN,
    };
    expect(validateContractDefinition(outside).issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['out-of-bounds']),
    );
  });
});
