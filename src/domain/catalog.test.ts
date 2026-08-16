import { describe, expect, it } from 'vitest';

import {
  appendCampaignWorld,
  appendCustomContract,
  createEmptyContractDraft,
  createCustomContractId,
  createDefaultContractCatalog,
  deleteCampaignWorld,
  deleteContractFromCatalog,
  mergeContractCatalog,
  readContractCatalogFile,
  saveContractToCatalog,
  serializeContractCatalogFile,
  swapContractSlots,
  updateCampaignWorld,
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
    version: 4,
    worlds: [{ world: 1, backgroundColor: '#377fbd', gridColor: '#ffffff' }],
    contracts: CONTRACTS.filter(({ world }) => world === 1).map((contract) =>
      structuredClone(contract),
    ),
    updatedAt: new Date(0).toISOString(),
  };
}

function customDefinition(stage = 5): NewContractDefinition {
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
  it('mantém válidas todas as dez fases cadastradas', () => {
    const worldOneContracts = CONTRACTS.filter(({ world }) => world === 1);
    expect(worldOneContracts).toHaveLength(10);
    for (const contract of worldOneContracts) {
      expect(validateContractDefinition(contract), contract.id).toEqual({
        valid: true,
        issues: [],
      });
    }
  });

  it('mantém slots estáveis ao editar, criar e excluir uma fase', () => {
    const initial = seededCatalog();
    initial.contracts = initial.contracts.slice(0, 4);
    let catalog = saveContractToCatalog(initial, {
      ...structuredClone(CONTRACTS[0]!),
      description: 'Descrição editada',
    });
    catalog = appendCustomContract(catalog, {
      ...customDefinition(),
      id: 'custom-fixture',
    }).catalog;
    catalog = deleteContractFromCatalog(catalog, 'quality-curve');

    const contracts = mergeContractCatalog(catalog);
    expect(contracts.map(({ order }) => order)).toEqual([1, 3, 4, 5]);
    expect(contracts[0]).toMatchObject({
      id: 'assembly-line',
      title: '1-1',
      revision: CONTRACTS[0]!.revision + 1,
      description: 'Descrição editada',
    });
    expect(contracts.at(-1)).toMatchObject({ id: 'custom-fixture', title: '5-1' });
  });

  it('gera IDs estáveis e permite excluir até a última fase', () => {
    expect(createCustomContractId(() => '00000000-0000-4000-8000-000000000000')).toBe(
      'custom-00000000-0000-4000-8000-000000000000',
    );
    const only = { ...seededCatalog(), contracts: [structuredClone(CONTRACTS[0]!)] };
    expect(deleteContractFromCatalog(only, 'assembly-line').contracts).toEqual([]);
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

  it('migra catálogos v1 e v2 para orçamento com custos padrão', () => {
    for (const version of [1, 2] as const) {
      const legacy = structuredClone(seededCatalog()) as unknown as Record<string, unknown>;
      legacy.version = version;
      const contracts = legacy.contracts as Array<Record<string, unknown>>;
      for (const contract of contracts) {
        const economy = contract.economy as Record<string, unknown>;
        const goal = contract.goal as Record<string, unknown>;
        goal.pieceBudget = Number(economy.budgetLimit) / 2_500;
        goal.idealTimeSeconds = 30;
        delete contract.economy;
        if (version === 1) {
          delete contract.world;
          delete contract.stage;
          delete contract.revision;
          delete contract.collectibles;
          goal.parTimeSeconds = goal.idealTimeSeconds;
          delete goal.idealTimeSeconds;
        }
      }

      const migrated = readContractCatalogFile(legacy);
      expect(migrated.ok).toBe(true);
      expect(migrated.value.version).toBe(4);
      expect(migrated.value.worlds).toEqual([
        { world: 1, backgroundColor: '#377fbd', gridColor: '#ffffff' },
      ]);
      expect(migrated.value.contracts[1]).toMatchObject({
        id: 'quality-curve',
        world: 1,
        stage: 2,
        revision: version === 1 ? 1 : CONTRACTS[1]!.revision,
        order: 2,
        title: '2-1',
        economy: {
          budgetLimit: 10_000,
          machineCosts: {
            'tracked-conveyor': 2_500,
            spring: 5_000,
          },
        },
      });
      expect(migrated.value.contracts[1]?.collectibles).toHaveLength(version === 1 ? 0 : 2);
    }
  });

  it('preserva a capacidade de fases legadas com trampolim e orçamento zero', () => {
    const migrateLegacyBudget = (pieceBudget: number) => {
      const contract = structuredClone(CONTRACTS[2]!) as unknown as Record<string, unknown>;
      const goal = contract.goal as Record<string, unknown>;
      goal.pieceBudget = pieceBudget;
      goal.idealTimeSeconds = 30;
      delete contract.economy;
      return readContractCatalogFile({
        version: 2,
        updatedAt: new Date(0).toISOString(),
        contracts: [contract],
      });
    };

    expect(migrateLegacyBudget(3).value.contracts[0]?.economy.budgetLimit).toBe(15_000);
    expect(migrateLegacyBudget(0).value.contracts[0]?.economy.budgetLimit).toBe(0);
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
    source.contracts[0]!.fixedMachines.push({
      id: 'speed-test',
      type: 'tracked-conveyor',
      gridX: 12,
      gridY: 12,
      angle: 0,
      reversed: false,
      conveyorSpeed: 'fast',
      fixed: true,
    });
    const serialized = serializeContractCatalogFile(source);
    const restored = readContractCatalogFile(serialized);

    expect(serialized).toContain('\n  "version": 4');
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
    expect(
      restored.value.contracts[0]?.fixedMachines.find(({ id }) => id === 'speed-test'),
    ).toMatchObject({ conveyorSpeed: 'fast' });
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

  it('cadastra um mundo vazio com cores próprias antes de criar suas fases', () => {
    const created = appendCampaignWorld(
      seededCatalog(),
      { backgroundColor: '#7A245C', gridColor: '#F4D9E8' },
      '2026-08-02T13:00:00.000Z',
    );

    expect(created.world).toEqual({
      world: 2,
      backgroundColor: '#7a245c',
      gridColor: '#f4d9e8',
    });
    expect(created.catalog.worlds).toHaveLength(2);
    expect(created.catalog.contracts.every(({ world }) => world === 1)).toBe(true);
    expect(createEmptyContractDraft(created.catalog, 2)).toMatchObject({
      world: 2,
      stage: 1,
      order: 11,
      title: '1-2',
    });

    const legacyV3 = structuredClone(created.catalog) as unknown as Record<string, unknown>;
    legacyV3.version = 3;
    delete legacyV3.worlds;
    expect(readContractCatalogFile(legacyV3).value.worlds).toEqual([
      { world: 1, backgroundColor: '#377fbd', gridColor: '#ffffff' },
    ]);
  });

  it('atualiza as cores de um mundo já cadastrado', () => {
    const withSecondWorld = appendCampaignWorld(seededCatalog(), {
      backgroundColor: '#6b2032',
      gridColor: '#f4d9e8',
    }).catalog;

    const updated = updateCampaignWorld(
      withSecondWorld,
      2,
      { backgroundColor: '#1A6B82', gridColor: '#E8FAFF' },
      '2026-08-02T14:00:00.000Z',
    );

    expect(updated.worlds[1]).toEqual({
      world: 2,
      backgroundColor: '#1a6b82',
      gridColor: '#e8faff',
    });
    expect(updated.updatedAt).toBe('2026-08-02T14:00:00.000Z');
  });

  it('exclui um mundo vazio e renumera os mundos e fases posteriores', () => {
    const withSecondWorld = appendCampaignWorld(seededCatalog(), {
      backgroundColor: '#6b2032',
      gridColor: '#f4d9e8',
    }).catalog;
    const withThirdWorld = appendCampaignWorld(withSecondWorld, {
      backgroundColor: '#1a6b82',
      gridColor: '#e8faff',
    }).catalog;
    const thirdWorldContract = {
      ...structuredClone(withThirdWorld.contracts[0]!),
      id: 'custom-third-world',
      world: 3,
      stage: 1 as const,
      revision: 1,
      order: 21,
      title: '1-3',
    };
    const populated = saveContractToCatalog(withThirdWorld, thirdWorldContract);

    const deleted = deleteCampaignWorld(
      populated,
      2,
      '2026-08-02T15:00:00.000Z',
    );

    expect(deleted.worlds).toEqual([
      { world: 1, backgroundColor: '#377fbd', gridColor: '#ffffff' },
      { world: 2, backgroundColor: '#1a6b82', gridColor: '#e8faff' },
    ]);
    expect(deleted.contracts.find(({ id }) => id === thirdWorldContract.id)).toMatchObject({
      world: 2,
      stage: 1,
      order: 11,
      title: '1-2',
    });
    expect(deleted.updatedAt).toBe('2026-08-02T15:00:00.000Z');
  });

  it('só exclui mundos vazios e mantém pelo menos um mundo', () => {
    expect(() => deleteCampaignWorld(seededCatalog(), 1)).toThrow(/pelo menos um mundo/i);

    const secondWorld = appendCampaignWorld(seededCatalog(), {
      backgroundColor: '#6b2032',
      gridColor: '#f4d9e8',
    }).catalog;
    const populatedSecondWorld = saveContractToCatalog(secondWorld, {
      ...structuredClone(secondWorld.contracts[0]!),
      id: 'custom-populated-world',
      world: 2,
      stage: 1,
      revision: 1,
      order: 11,
      title: '1-2',
    });
    expect(() => deleteCampaignWorld(populatedSecondWorld, 2)).toThrow(/possui fases/i);
  });

  it('troca atomicamente as posições de duas fases sem perder seus conteúdos', () => {
    const initial = seededCatalog();
    const first = initial.contracts[0]!;
    const second = initial.contracts[1]!;
    const editedFirst = {
      ...structuredClone(first),
      world: second.world,
      stage: second.stage,
      description: 'Conteúdo editado antes da troca',
    };

    const swapped = swapContractSlots(
      initial,
      editedFirst,
      second.id,
      '2026-08-02T12:00:00.000Z',
    );
    const movedFirst = swapped.contracts.find(({ id }) => id === first.id);
    const movedSecond = swapped.contracts.find(({ id }) => id === second.id);

    expect(movedFirst).toMatchObject({
      stage: second.stage,
      world: second.world,
      order: second.order,
      title: second.title,
      revision: first.revision + 1,
      description: 'Conteúdo editado antes da troca',
    });
    expect(movedSecond).toMatchObject({
      stage: first.stage,
      world: first.world,
      order: first.order,
      title: first.title,
      revision: second.revision + 1,
      description: second.description,
    });
    expect(swapped.updatedAt).toBe('2026-08-02T12:00:00.000Z');
    expect(initial.contracts[0]).toEqual(first);
    expect(initial.contracts[1]).toEqual(second);
  });

  it('não cria uma fase quando os dez slots do mundo já estão ocupados', () => {
    const catalog = seededCatalog();
    for (let stage = 1; stage <= 10; stage += 1) {
      if (catalog.contracts.some((contract) => contract.world === 1 && contract.stage === stage)) {
        continue;
      }
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
    invalid.goal.maxLosses = -1;
    invalid.economy.budgetLimit = 1.5;
    invalid.economy.machineCosts.spring = -1;
    invalid.spawnIntervalSeconds = 10.01;
    invalid.initialCamera.zoom = 3;
    invalid.fixedMachines[1] = {
      ...invalid.fixedMachines[0]!,
      id: 'overlapping-receiver',
      type: 'receiver',
    };
    const issues = validateContractDefinition(invalid).issues;
    const codes = issues.map(({ code }) => code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'invalid-id',
        'invalid-number',
        'invalid-slot',
        'invalid-camera',
        'overlap',
      ]),
    );
    expect(issues.find(({ code }) => code === 'overlap')?.relatedPaths).toEqual([
      'fixedMachines.0',
      'fixedMachines.1',
    ]);
  });

  it('aceita posicionamento livre quando as hitboxes são válidas', () => {
    const contract = structuredClone(CONTRACTS[0]!);
    contract.fixedMachines[0]!.gridX += 0.137;
    contract.fixedMachines[0]!.gridY += 0.083;
    contract.collectibles = [
      { id: 'free-star', type: 'star', gridX: 10.123, gridY: 8.456 },
    ];

    expect(validateContractDefinition(contract)).toEqual({ valid: true, issues: [] });
    const saved = saveContractToCatalog(seededCatalog(), contract);
    expect(saved.contracts[0]?.fixedMachines[0]).toMatchObject({
      gridX: 4.637,
      gridY: 3.833,
    });
    expect(saved.contracts[0]?.collectibles[0]).toMatchObject({
      gridX: 10.123,
      gridY: 8.456,
    });
  });

  it('valida trampolins com a mesma área de posicionamento do editor', () => {
    const contract = structuredClone(CONTRACTS[0]!);
    contract.fixedMachines = [
      {
        id: 'source-proof',
        type: 'source',
        gridX: 2.5,
        gridY: 2.5,
        angle: 0,
        reversed: false,
        fixed: true,
      },
      {
        id: 'receiver-proof',
        type: 'receiver',
        gridX: 22.5,
        gridY: 12.5,
        angle: 0,
        reversed: false,
        fixed: true,
      },
      {
        id: 'spring-proof',
        type: 'spring',
        gridX: 3.75,
        gridY: 5,
        angle: 0,
        reversed: false,
        fixed: true,
      },
    ];
    contract.obstacles = [
      { id: 'obstacle-proof', gridX: 5, gridY: 5, columns: 1, rows: 1, angle: 0 },
    ];
    contract.collectibles = [];

    expect(validateContractDefinition(contract)).toEqual({ valid: true, issues: [] });
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
        angle: 45,
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
