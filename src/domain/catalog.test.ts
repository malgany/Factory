import { describe, expect, it } from 'vitest';

import {
  appendCustomContract,
  createEmptyContractDraft,
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
import type { ContractCatalogFile, ContractDefinition } from './types';
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
    version: 2,
    contracts: CONTRACTS.map((contract) => structuredClone(contract)),
    updatedAt: new Date(0).toISOString(),
  };
}

function customDefinition(stage = 4): NewContractDefinition {
  const definition: NewContractDefinition = {
    ...structuredClone(CONTRACTS[0]!),
    world: 1,
    stage: stage as NewContractDefinition['stage'],
    revision: 1,
    title: 'Valor interno substituído pela normalização',
  };
  delete definition.id;
  delete definition.order;
  return definition;
}

describe('catálogo JSON de contratos', () => {
  it('mantém slots estáveis ao editar, criar e excluir uma fase', () => {
    let catalog = saveContractToCatalog(seededCatalog(), {
      ...structuredClone(CONTRACTS[0]!),
      description: 'Descrição editada',
    });
    catalog = appendCustomContract(catalog, {
      ...customDefinition(),
      id: 'custom-fixture',
    }).catalog;
    catalog = deleteContractFromCatalog(catalog, 'controlled-jump');

    const contracts = mergeContractCatalog(catalog);
    expect(contracts.map(({ order }) => order)).toEqual([1, 3, 4]);
    expect(contracts[0]).toMatchObject({
      id: 'first-flow',
      title: '1-1',
      revision: 2,
      description: 'Descrição editada',
    });
    expect(contracts.at(-1)).toMatchObject({ id: 'custom-fixture', title: '4-1' });
  });

  it('gera IDs estáveis e permite excluir até a última fase', () => {
    expect(createCustomContractId(() => '00000000-0000-4000-8000-000000000000')).toBe(
      'custom-00000000-0000-4000-8000-000000000000',
    );
    const only = { ...seededCatalog(), contracts: [structuredClone(CONTRACTS[0]!)] };
    expect(deleteContractFromCatalog(only, 'first-flow').contracts).toEqual([]);
  });

  it('aceita catálogo vazio e rejeita JSON corrompido sem dados parciais', () => {
    const empty = readContractCatalogFile(createDefaultContractCatalog());
    expect(empty).toEqual({ ok: true, value: createDefaultContractCatalog() });

    expect(readContractCatalogFile('').ok).toBe(false);
    expect(
      readContractCatalogFile({ version: 2, updatedAt: 'data-inválida', contracts: [] }).ok,
    ).toBe(false);
    expect(
      readContractCatalogFile({ version: 2, updatedAt: 'July 21, 2026', contracts: [] }).ok,
    ).toBe(false);

    expect(readContractCatalogFile('{quebrado').ok).toBe(false);
    expect(
      readContractCatalogFile({
        version: 2,
        updatedAt: new Date(0).toISOString(),
        contracts: [{ id: 'custom-incompleta' }],
      }).value.contracts,
    ).toEqual([]);
  });

  it('migra catálogo v1 para mundo 1 preservando IDs e tempo ideal', () => {
    const legacy = structuredClone(seededCatalog()) as unknown as Record<string, unknown>;
    legacy.version = 1;
    const contracts = legacy.contracts as Array<Record<string, unknown>>;
    for (const contract of contracts) {
      delete contract.world;
      delete contract.stage;
      delete contract.revision;
      delete contract.collectibles;
      const goal = contract.goal as Record<string, unknown>;
      goal.parPieces = 7;
      goal.parTimeSeconds = goal.idealTimeSeconds;
      delete goal.idealTimeSeconds;
    }

    const migrated = readContractCatalogFile(legacy);
    expect(migrated.ok).toBe(true);
    expect(migrated.value.version).toBe(2);
    expect(migrated.value.contracts[1]).toMatchObject({
      id: 'controlled-jump',
      world: 1,
      stage: 2,
      revision: 1,
      order: 2,
      title: '2-1',
      collectibles: [],
      goal: { idealTimeSeconds: 38 },
    });
  });

  it('serializa formatado e normaliza dados derivados, câmera e estrela', () => {
    const source = seededCatalog();
    source.contracts[0]!.title = 'Ignorado';
    source.contracts[0]!.order = 99;
    source.contracts[0]!.initialCamera = {
      centerX: 720.12345,
      centerY: 431.98765,
      zoom: 1.234567,
    };
    source.contracts[0]!.collectibles = [
      { id: 'star-1', type: 'star', gridX: 8.25001, gridY: 9.49999 },
    ];
    const serialized = serializeContractCatalogFile(source);
    const restored = readContractCatalogFile(serialized);

    expect(serialized).toContain('\n  "version": 2');
    expect(serialized.endsWith('\n')).toBe(true);
    expect(restored.ok).toBe(true);
    expect(restored.value.contracts[0]).toMatchObject({ title: '1-1', order: 1 });
    expect(restored.value.contracts[0]?.initialCamera).toEqual({
      centerX: 720.12,
      centerY: 431.99,
      zoom: 1.2346,
    });
    expect(restored.value.contracts[0]?.collectibles[0]).toMatchObject({
      gridX: 8.25,
      gridY: 9.5,
    });
  });

  it('rejeita slots duplicados ao ler ou salvar', () => {
    const duplicate = structuredClone(CONTRACTS[1]!);
    duplicate.id = 'duplicate-slot';
    duplicate.stage = 1;
    duplicate.order = 1;
    const catalog = seededCatalog();
    catalog.contracts.push(duplicate);

    expect(readContractCatalogFile(catalog).ok).toBe(false);
    expect(() => saveContractToCatalog(seededCatalog(), duplicate)).toThrow(/slot 1-1/i);
  });

  it('não cria uma fase quando os dez slots do mundo já estão ocupados', () => {
    const catalog = seededCatalog();
    for (let stage = 4; stage <= 10; stage += 1) {
      catalog.contracts.push({
        ...structuredClone(CONTRACTS[0]!),
        id: `full-world-${stage}`,
        stage: stage as ContractDefinition['stage'],
        order: stage,
        title: `${stage}-1`,
      });
    }

    expect(() => createEmptyContractDraft(catalog)).toThrow(/dez fases cadastradas/i);
  });

  it('valida campos, câmera, entidades, limites e sobreposição', () => {
    const valid = structuredClone(CONTRACTS[0]!);
    expect(validateContractDefinition(valid)).toEqual({ valid: true, issues: [] });

    const invalid = structuredClone(valid);
    invalid.id = 'id com espaços';
    invalid.world = 0;
    invalid.stage = 11 as typeof invalid.stage;
    invalid.revision = 0;
    invalid.goal.idealTimeSeconds = 0;
    invalid.goal.timeLimitSeconds = 1.5;
    invalid.spawnIntervalSeconds = 10.01;
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
        'invalid-number',
        'invalid-slot',
        'invalid-camera',
        'overlap',
      ]),
    );
  });

  it('valida estrelas nos limites sem tratá-las como colisão', () => {
    const contract = structuredClone(CONTRACTS[0]!);
    const source = contract.fixedMachines[0]!;
    contract.collectibles = [
      { id: 'star-over-source', type: 'star', gridX: source.gridX, gridY: source.gridY },
    ];
    expect(validateContractDefinition(contract)).toEqual({ valid: true, issues: [] });

    contract.collectibles[0]!.gridX = PLAY_AREA_MAX_COLUMN;
    expect(validateContractDefinition(contract).issues.map(({ code }) => code)).toContain(
      'out-of-bounds',
    );

    contract.collectibles[0]!.gridX = PLAY_AREA_MIN_COLUMN - 0.5;
    expect(validateContractDefinition(contract).issues.map(({ code }) => code)).toContain(
      'out-of-bounds',
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

    expanded.fixedMachines[0] = {
      ...expanded.fixedMachines[0]!,
      gridX: PLAY_AREA_MIN_COLUMN - 1,
    };
    expect(validateContractDefinition(expanded).issues.map(({ code }) => code)).toContain(
      'out-of-bounds',
    );
  });
});
