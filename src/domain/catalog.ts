import { orderContracts } from './contracts';
import { DEFAULT_CONVEYOR_SPEED_COSTS } from './economy';
import {
  CELL_SIZE,
  COLLECTIBLE_STAR_RADIUS,
  GRID_COLUMNS,
  GRID_ROWS,
  PLAY_AREA_MAX_COLUMN,
  PLAY_AREA_MAX_ROW,
  PLAY_AREA_MIN_COLUMN,
  PLAY_AREA_MIN_ROW,
  type CollectibleDefinition,
  type ContractCatalogFile,
  type ContractDefinition,
  type ContractEconomy,
  type ContractMachineCosts,
  type ContractStage,
  type ConveyorSpeed,
  type MachineState,
  type MachineType,
  type ObstacleDefinition,
  type PersistenceResult,
} from './types';

export const CONTRACT_CATALOG_VERSION = 3 as const;
export const MIN_CONTRACT_CAMERA_ZOOM = 1;
export const MAX_CONTRACT_CAMERA_ZOOM = 2;
export const MIN_SPAWN_INTERVAL_SECONDS = 0.8;
export const MAX_SPAWN_INTERVAL_SECONDS = 10;
export const SPAWN_INTERVAL_STEP_SECONDS = 0.05;
export const DEFAULT_MACHINE_COSTS: Readonly<ContractMachineCosts> = {
  'tracked-conveyor': 2_500,
  spring: 5_000,
  'turbo-spring': 7_500,
};

const MACHINE_TYPES: readonly MachineType[] = [
  'source',
  'conveyor',
  'tracked-conveyor',
  'receiver',
  'spring',
  'turbo-spring',
];
const CONVEYOR_SPEEDS: readonly ConveyorSpeed[] = ['slow', 'normal', 'fast'];
const CUSTOM_ID_PREFIX = 'custom-';
const EMPTY_UPDATED_AT = new Date(0).toISOString();

export type ContractValidationCode =
  | 'required'
  | 'invalid-id'
  | 'invalid-number'
  | 'invalid-grid'
  | 'missing-source'
  | 'missing-receiver'
  | 'out-of-bounds'
  | 'overlap'
  | 'duplicate-id'
  | 'duplicate-slot'
  | 'invalid-machine'
  | 'invalid-obstacle'
  | 'invalid-collectible'
  | 'invalid-camera'
  | 'invalid-slot';

export interface ContractValidationIssue {
  code: ContractValidationCode;
  path: string;
  message: string;
  relatedPaths?: string[];
}

export interface ContractValidationResult {
  valid: boolean;
  issues: ContractValidationIssue[];
}

export type NewContractDefinition = Omit<ContractDefinition, 'id' | 'order'> & {
  id?: ContractDefinition['id'];
  order?: number;
};

export function createDefaultContractCatalog(): ContractCatalogFile {
  return {
    version: CONTRACT_CATALOG_VERSION,
    contracts: [],
    updatedAt: EMPTY_UPDATED_AT,
  };
}

export function readContractCatalogFile(input: unknown): PersistenceResult<ContractCatalogFile> {
  if (input === null || input === undefined || input === '') {
    return catalogFailure('O catálogo de fases está vazio.');
  }

  let candidate: unknown = input;
  if (typeof input === 'string') {
    try {
      candidate = JSON.parse(input) as unknown;
    } catch {
      return catalogFailure('O catálogo de fases salvo está corrompido.');
    }
  }

  if (!isRecord(candidate)) {
    return catalogFailure('O catálogo de fases salvo tem um formato inválido.');
  }

  if (
    candidate.version !== 1 &&
    candidate.version !== 2 &&
    candidate.version !== CONTRACT_CATALOG_VERSION
  ) {
    return catalogFailure('A versão do catálogo de fases não é compatível.');
  }

  if (!Array.isArray(candidate.contracts)) {
    return catalogFailure('O catálogo de fases salvo está incompleto.');
  }

  if (!isIsoTimestamp(candidate.updatedAt)) {
    return catalogFailure('A data de atualização do catálogo é inválida.');
  }

  const contracts: ContractDefinition[] = [];
  const ids = new Set<string>();
  const slots = new Set<string>();
  for (const value of candidate.contracts) {
    const contract = readContractDefinition(value, candidate.version);
    if (!contract || ids.has(contract.id)) {
      return catalogFailure('O catálogo contém uma fase inválida ou duplicada.');
    }
    const slot = contractSlotKey(contract);
    if (slots.has(slot)) {
      return catalogFailure('O catálogo contém duas fases no mesmo mundo e etapa.');
    }
    const validation = validateContractDefinition(contract);
    if (!validation.valid) {
      return catalogFailure(
        `A fase ${contract.id} não passou na validação: ${validation.issues[0]?.message ?? 'dados inválidos'}`,
      );
    }
    ids.add(contract.id);
    slots.add(slot);
    contracts.push(contract);
  }

  return {
    ok: true,
    value: normalizeContractCatalog({
      version: CONTRACT_CATALOG_VERSION,
      contracts,
      updatedAt: candidate.updatedAt,
    }),
  };
}

export function parseContractCatalogFile(input: unknown): ContractCatalogFile {
  return readContractCatalogFile(input).value;
}

export function serializeContractCatalogFile(catalog: ContractCatalogFile): string {
  return `${JSON.stringify(normalizeContractCatalog(catalog), null, 2)}\n`;
}

export function mergeContractCatalog(catalog: ContractCatalogFile): ContractDefinition[] {
  return catalog.contracts.map(cloneContract);
}

export function normalizeContractCatalog(catalog: ContractCatalogFile): ContractCatalogFile {
  const contracts = orderContracts(catalog.contracts).map(normalizeContract);
  return {
    version: CONTRACT_CATALOG_VERSION,
    contracts,
    updatedAt: catalog.updatedAt,
  };
}

export function saveContractToCatalog(
  catalog: ContractCatalogFile,
  contract: ContractDefinition,
  updatedAt = new Date().toISOString(),
): ContractCatalogFile {
  const validation = validateContractDefinition(contract);
  if (!validation.valid) {
    throw new Error(validation.issues[0]?.message ?? 'A fase é inválida.');
  }

  const next = normalizeContractCatalog(catalog);
  const index = next.contracts.findIndex((candidate) => candidate.id === contract.id);
  const duplicateSlot = next.contracts.find(
    (candidate) =>
      candidate.id !== contract.id &&
      candidate.world === contract.world &&
      candidate.stage === contract.stage,
  );
  if (duplicateSlot) {
    throw new Error(`O slot ${contract.stage}-${contract.world} já está ocupado.`);
  }
  if (index >= 0) {
    const previous = next.contracts[index]!;
    next.contracts[index] = cloneContract({
      ...contract,
      revision: Math.max(contract.revision, previous.revision + 1),
    });
  } else {
    next.contracts.push(cloneContract({ ...contract, revision: Math.max(1, contract.revision) }));
  }
  next.updatedAt = updatedAt;
  return normalizeContractCatalog(next);
}

export function appendCustomContract(
  catalog: ContractCatalogFile,
  definition: NewContractDefinition,
  updatedAt = new Date().toISOString(),
): { catalog: ContractCatalogFile; contract: ContractDefinition } {
  const usedIds = new Set(mergeContractCatalog(catalog).map(({ id }) => id));
  let id = definition.id;
  while (!id || usedIds.has(id)) {
    id = createCustomContractId();
  }
  const contract: ContractDefinition = {
    ...cloneContractFields(definition),
    id,
    order: contractOrder(definition.world, definition.stage),
  };
  const nextCatalog = saveContractToCatalog(catalog, contract, updatedAt);
  return {
    catalog: nextCatalog,
    contract: cloneContract(nextCatalog.contracts.find((candidate) => candidate.id === id)!),
  };
}

export function deleteContractFromCatalog(
  catalog: ContractCatalogFile,
  contractId: string,
  updatedAt = new Date().toISOString(),
): ContractCatalogFile {
  const next = normalizeContractCatalog(catalog);
  next.contracts = next.contracts.filter((contract) => contract.id !== contractId);
  next.updatedAt = updatedAt;
  return normalizeContractCatalog(next);
}

export function getContractSlotLabel(
  contract: Pick<ContractDefinition, 'stage' | 'world'>,
): string {
  return `${contract.stage}-${contract.world}`;
}

export function contractOrder(world: number, stage: number): number {
  return (world - 1) * 10 + stage;
}

export function createCustomContractId(randomUuid: () => string = defaultRandomUuid): string {
  return `${CUSTOM_ID_PREFIX}${randomUuid()}`;
}

export function createEmptyContractDraft(
  catalog: ContractCatalogFile,
  id = createCustomContractId(),
): ContractDefinition {
  const usedStages = new Set(
    catalog.contracts.filter(({ world }) => world === 1).map(({ stage }) => stage),
  );
  const stage = ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as ContractStage[]).find(
    (candidate) => !usedStages.has(candidate),
  );
  if (!stage) {
    throw new Error('O Mundo 1 já possui as dez fases cadastradas.');
  }
  return {
    id,
    world: 1,
    stage,
    revision: 1,
    order: contractOrder(1, stage),
    title: `${stage}-1`,
    subtitle: 'Crie um novo desafio.',
    description: 'Monte o cenário e configure as ferramentas disponíveis.',
    grid: { columns: GRID_COLUMNS, rows: GRID_ROWS },
    availableMachines: ['tracked-conveyor', 'spring'],
    fixedMachines: [],
    obstacles: [],
    collectibles: [],
    goal: {
      deliveries: 10,
      maxLosses: 3,
    },
    economy: {
      budgetLimit: 25_000,
      machineCosts: { ...DEFAULT_MACHINE_COSTS },
      conveyorSpeedCosts: { ...DEFAULT_CONVEYOR_SPEED_COSTS },
    },
    spawnIntervalSeconds: 1.25,
    initialCamera: {
      centerX: (GRID_COLUMNS * CELL_SIZE) / 2,
      centerY: (GRID_ROWS * CELL_SIZE) / 2,
      zoom: MIN_CONTRACT_CAMERA_ZOOM,
    },
  };
}

export function validateContractDefinition(contract: ContractDefinition): ContractValidationResult {
  const issues: ContractValidationIssue[] = [];
  const add = (
    code: ContractValidationCode,
    path: string,
    message: string,
    relatedPaths?: string[],
  ): void => {
    issues.push({ code, path, message, ...(relatedPaths ? { relatedPaths } : {}) });
  };

  if (!contract.id.trim()) add('required', 'id', 'A fase precisa de um identificador.');
  else if (!isStableContractId(contract.id)) {
    add(
      'invalid-id',
      'id',
      'O identificador deve usar apenas letras, números, ponto, hífen, sublinhado ou dois-pontos.',
    );
  }
  if (!contract.title.trim()) add('required', 'title', 'Informe o título da fase.');
  validateInteger(contract.world, 1, 'world', 'O mundo deve ser um inteiro positivo.', add);
  if (!Number.isInteger(contract.stage) || contract.stage < 1 || contract.stage > 10) {
    add('invalid-slot', 'stage', 'A fase deve estar entre 1 e 10.');
  }
  validateInteger(contract.revision, 1, 'revision', 'A revisão deve ser um inteiro positivo.', add);
  if (contract.grid.columns !== GRID_COLUMNS || contract.grid.rows !== GRID_ROWS) {
    add('invalid-grid', 'grid', `O tabuleiro deve ter ${GRID_COLUMNS}×${GRID_ROWS} células.`);
  }
  validateInteger(contract.order, 1, 'order', 'A ordem da fase deve ser positiva.', add);
  validateInteger(
    contract.goal.deliveries,
    1,
    'goal.deliveries',
    'As entregas devem ser pelo menos 1.',
    add,
  );
  validateOptionalNonNegativeInteger(
    contract.goal.maxLosses,
    'goal.maxLosses',
    'As perdas máximas não podem ser negativas.',
    add,
  );
  validateOptionalNonNegativeInteger(
    contract.economy.budgetLimit,
    'economy.budgetLimit',
    'O orçamento deve ser um inteiro não negativo.',
    add,
  );
  validateInteger(
    contract.economy.machineCosts['tracked-conveyor'],
    0,
    'economy.machineCosts.tracked-conveyor',
    'O custo da esteira deve ser um inteiro não negativo.',
    add,
  );
  validateInteger(
    contract.economy.machineCosts.spring,
    0,
    'economy.machineCosts.spring',
    'O custo do trampolim deve ser um inteiro não negativo.',
    add,
  );
  validateInteger(
    contract.economy.machineCosts['turbo-spring'] ?? DEFAULT_MACHINE_COSTS['turbo-spring']!,
    0,
    'economy.machineCosts.turbo-spring',
    'O custo do trampolim turbo deve ser um inteiro não negativo.',
    add,
  );
  if (contract.economy.conveyorSpeedCosts) {
    for (const speed of CONVEYOR_SPEEDS) {
      validateInteger(
        contract.economy.conveyorSpeedCosts[speed],
        0,
        `economy.conveyorSpeedCosts.${speed}`,
        `O custo da velocidade ${CONVEYOR_SPEEDS.indexOf(speed) + 1} deve ser um inteiro não negativo.`,
        add,
      );
    }
  }
  if (
    !Number.isFinite(contract.spawnIntervalSeconds) ||
    contract.spawnIntervalSeconds < MIN_SPAWN_INTERVAL_SECONDS ||
    contract.spawnIntervalSeconds > MAX_SPAWN_INTERVAL_SECONDS
  ) {
    add(
      'invalid-number',
      'spawnIntervalSeconds',
      `O intervalo de geração deve ficar entre ${MIN_SPAWN_INTERVAL_SECONDS} e ${MAX_SPAWN_INTERVAL_SECONDS} segundos.`,
    );
  }
  const camera = contract.initialCamera;
  if (
    !camera ||
    !Number.isFinite(camera.centerX) ||
    !Number.isFinite(camera.centerY) ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom < MIN_CONTRACT_CAMERA_ZOOM ||
    camera.zoom > MAX_CONTRACT_CAMERA_ZOOM ||
    camera.centerX < PLAY_AREA_MIN_COLUMN * CELL_SIZE ||
    camera.centerX > PLAY_AREA_MAX_COLUMN * CELL_SIZE ||
    camera.centerY < PLAY_AREA_MIN_ROW * CELL_SIZE ||
    camera.centerY > PLAY_AREA_MAX_ROW * CELL_SIZE
  ) {
    add(
      'invalid-camera',
      'initialCamera',
      `A câmera inicial deve estar dentro do mundo e usar zoom entre ${MIN_CONTRACT_CAMERA_ZOOM} e ${MAX_CONTRACT_CAMERA_ZOOM}.`,
    );
  }

  if (!contract.fixedMachines.some(({ type }) => type === 'source')) {
    add('missing-source', 'fixedMachines', 'Adicione ao menos uma saída.');
  }
  if (!contract.fixedMachines.some(({ type }) => type === 'receiver')) {
    add('missing-receiver', 'fixedMachines', 'Adicione ao menos uma entrada.');
  }

  const entityIds = new Set<string>();
  for (const [index, machine] of contract.fixedMachines.entries()) {
    const path = `fixedMachines.${index}`;
    if (!machine.id.trim() || entityIds.has(machine.id)) {
      add('duplicate-id', `${path}.id`, 'Cada objeto precisa de um identificador único.');
    }
    entityIds.add(machine.id);
    if (!machine.fixed) {
      add('invalid-machine', `${path}.fixed`, 'Objetos do cenário precisam ser fixos.');
    }
    if (!Number.isFinite(machine.gridX) || !Number.isFinite(machine.gridY)) {
      add('invalid-machine', path, 'Objetos do cenário precisam ter uma posição válida.');
    }
    if (!polygonWithinBoard(machinePolygon(machine))) {
      add('out-of-bounds', path, 'Há um objeto fora do tabuleiro.');
    }
  }

  for (const [index, obstacle] of contract.obstacles.entries()) {
    const path = `obstacles.${index}`;
    if (!obstacle.id.trim() || entityIds.has(obstacle.id)) {
      add('duplicate-id', `${path}.id`, 'Cada objeto precisa de um identificador único.');
    }
    entityIds.add(obstacle.id);
    if (
      !Number.isFinite(obstacle.gridX) ||
      !Number.isFinite(obstacle.gridY) ||
      !Number.isInteger(obstacle.columns) ||
      !Number.isInteger(obstacle.rows) ||
      obstacle.columns < 1 ||
      obstacle.rows < 1 ||
      (obstacle.angle !== undefined && !Number.isFinite(obstacle.angle))
    ) {
      add('invalid-obstacle', path, 'Bloqueadores precisam medir pelo menos 1×1.');
    }
    if (!obstacleWithinBoard(obstacle)) {
      add('out-of-bounds', path, 'Há um bloqueador fora do tabuleiro.');
    }
  }

  for (const [index, collectible] of contract.collectibles.entries()) {
    const path = `collectibles.${index}`;
    if (!collectible.id.trim() || entityIds.has(collectible.id)) {
      add('duplicate-id', `${path}.id`, 'Cada objeto precisa de um identificador único.');
    }
    entityIds.add(collectible.id);
    if (
      collectible.type !== 'star' ||
      !Number.isFinite(collectible.gridX) ||
      !Number.isFinite(collectible.gridY)
    ) {
      add('invalid-collectible', path, 'Estrelas precisam ter uma posição válida.');
    }
    const starRadiusInCells = COLLECTIBLE_STAR_RADIUS / CELL_SIZE;
    if (!pointWithinBoard(collectible.gridX + 0.5, collectible.gridY + 0.5, starRadiusInCells)) {
      add('out-of-bounds', path, 'Há uma estrela fora do tabuleiro.');
    }
  }

  const shapes: Array<{ path: string; polygon: Point[] }> = [
    ...contract.fixedMachines.map((machine, index) => ({
      path: `fixedMachines.${index}`,
      polygon: machinePolygon(machine),
    })),
    ...contract.obstacles.map((obstacle, index) => ({
      path: `obstacles.${index}`,
      polygon: obstaclePolygon(obstacle),
    })),
  ];
  for (let left = 0; left < shapes.length; left += 1) {
    for (let right = left + 1; right < shapes.length; right += 1) {
      const leftShape = shapes[left];
      const rightShape = shapes[right];
      if (leftShape && rightShape && polygonsOverlap(leftShape.polygon, rightShape.polygon)) {
        add(
          'overlap',
          rightShape.path,
          `Há objetos sobrepostos (${leftShape.path} e ${rightShape.path}).`,
          [leftShape.path, rightShape.path],
        );
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function cloneContract(contract: ContractDefinition): ContractDefinition {
  return {
    ...contract,
    grid: { ...contract.grid },
    availableMachines: [...contract.availableMachines],
    fixedMachines: contract.fixedMachines.map((machine) => ({ ...machine })),
    obstacles: contract.obstacles.map((obstacle) => ({ ...obstacle })),
    collectibles: contract.collectibles.map((collectible) => ({ ...collectible })),
    goal: { ...contract.goal },
    economy: {
      ...contract.economy,
      machineCosts: { ...contract.economy.machineCosts },
      ...(contract.economy.conveyorSpeedCosts
        ? { conveyorSpeedCosts: { ...contract.economy.conveyorSpeedCosts } }
        : {}),
    },
    initialCamera: { ...contract.initialCamera },
  };
}

function normalizeContract(contract: ContractDefinition): ContractDefinition {
  const normalized = cloneContract(contract);
  normalized.order = contractOrder(normalized.world, normalized.stage);
  normalized.title = getContractSlotLabel(normalized);
  normalized.fixedMachines = normalized.fixedMachines.map((machine) => ({
    ...machine,
    gridX: roundForCatalog(machine.gridX, 4),
    gridY: roundForCatalog(machine.gridY, 4),
    angle: roundForCatalog(machine.angle, 4),
    conveyorSpeed:
      machine.type === 'conveyor' || machine.type === 'tracked-conveyor'
        ? normalizeConveyorSpeed(machine.conveyorSpeed)
        : undefined,
  }));
  normalized.obstacles = normalized.obstacles.map((obstacle) => ({
    ...obstacle,
    gridX: roundForCatalog(obstacle.gridX, 4),
    gridY: roundForCatalog(obstacle.gridY, 4),
    columns: roundForCatalog(obstacle.columns, 4),
    rows: roundForCatalog(obstacle.rows, 4),
    angle: normalizeDegrees(obstacle.angle ?? 0),
  }));
  normalized.collectibles = normalized.collectibles.map((collectible) => ({
    ...collectible,
    gridX: roundForCatalog(collectible.gridX, 4),
    gridY: roundForCatalog(collectible.gridY, 4),
  }));
  normalized.goal = {
    deliveries: roundForCatalog(normalized.goal.deliveries, 4),
    ...(normalized.goal.maxLosses === undefined
      ? {}
      : { maxLosses: roundForCatalog(normalized.goal.maxLosses, 4) }),
  };
  normalized.economy = {
    ...(normalized.economy.budgetLimit === undefined
      ? {}
      : { budgetLimit: roundForCatalog(normalized.economy.budgetLimit, 4) }),
    machineCosts: {
      'tracked-conveyor': roundForCatalog(normalized.economy.machineCosts['tracked-conveyor'], 4),
      spring: roundForCatalog(normalized.economy.machineCosts.spring, 4),
      'turbo-spring': roundForCatalog(
        normalized.economy.machineCosts['turbo-spring'] ??
          DEFAULT_MACHINE_COSTS['turbo-spring']!,
        4,
      ),
    },
    ...(normalized.economy.conveyorSpeedCosts
      ? {
          conveyorSpeedCosts: Object.fromEntries(
            CONVEYOR_SPEEDS.map((speed) => [
              speed,
              roundForCatalog(normalized.economy.conveyorSpeedCosts![speed], 4),
            ]),
          ) as Record<ConveyorSpeed, number>,
        }
      : {}),
  };
  normalized.spawnIntervalSeconds = roundForCatalog(normalized.spawnIntervalSeconds, 4);
  normalized.initialCamera = {
    centerX: roundForCatalog(normalized.initialCamera.centerX, 2),
    centerY: roundForCatalog(normalized.initialCamera.centerY, 2),
    zoom: roundForCatalog(normalized.initialCamera.zoom, 4),
  };
  return normalized;
}

function cloneContractFields(
  definition: Omit<ContractDefinition, 'id' | 'order'>,
): Omit<ContractDefinition, 'id' | 'order'> {
  return {
    ...definition,
    grid: { ...definition.grid },
    availableMachines: [...definition.availableMachines],
    fixedMachines: definition.fixedMachines.map((machine) => ({ ...machine })),
    obstacles: definition.obstacles.map((obstacle) => ({ ...obstacle })),
    collectibles: definition.collectibles.map((collectible) => ({ ...collectible })),
    goal: { ...definition.goal },
    economy: {
      ...definition.economy,
      machineCosts: { ...definition.economy.machineCosts },
      ...(definition.economy.conveyorSpeedCosts
        ? { conveyorSpeedCosts: { ...definition.economy.conveyorSpeedCosts } }
        : {}),
    },
    initialCamera: { ...definition.initialCamera },
  };
}

function readContractDefinition(
  value: unknown,
  catalogVersion: 1 | 2 | 3,
): ContractDefinition | undefined {
  const legacyVersionOne = catalogVersion === 1;
  const legacyEconomy = catalogVersion < CONTRACT_CATALOG_VERSION;
  if (
    !isRecord(value) ||
    !isRecord(value.grid) ||
    !isRecord(value.goal) ||
    !isRecord(value.initialCamera)
  ) {
    return undefined;
  }
  if (!Array.isArray(value.availableMachines) || !Array.isArray(value.fixedMachines)) {
    return undefined;
  }
  if (!Array.isArray(value.obstacles)) return undefined;
  const world = legacyVersionOne ? 1 : value.world;
  const stage = legacyVersionOne ? value.order : value.stage;
  const revision = legacyVersionOne ? 1 : value.revision;
  const collectibles = legacyVersionOne ? [] : value.collectibles;
  if (
    typeof value.id !== 'string' ||
    typeof value.order !== 'number' ||
    typeof world !== 'number' ||
    !isContractStage(stage) ||
    typeof revision !== 'number' ||
    typeof value.title !== 'string' ||
    typeof value.subtitle !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.grid.columns !== 'number' ||
    typeof value.grid.rows !== 'number' ||
    typeof value.spawnIntervalSeconds !== 'number' ||
    typeof value.initialCamera.centerX !== 'number' ||
    typeof value.initialCamera.centerY !== 'number' ||
    typeof value.initialCamera.zoom !== 'number'
  ) {
    return undefined;
  }
  if (!value.availableMachines.every(isMachineType)) return undefined;
  if (!value.fixedMachines.every(isMachineState)) return undefined;
  if (!value.obstacles.every(isObstacleDefinition)) return undefined;
  if (!Array.isArray(collectibles) || !collectibles.every(isCollectibleDefinition)) {
    return undefined;
  }
  const goal = value.goal;
  const idealTimeSeconds = legacyVersionOne ? goal.parTimeSeconds : goal.idealTimeSeconds;
  if (typeof goal.deliveries !== 'number' || !isOptionalNumber(goal.maxLosses)) {
    return undefined;
  }
  if (
    legacyEconomy &&
    (typeof goal.pieceBudget !== 'number' ||
      !isOptionalNumber(goal.timeLimitSeconds) ||
      !isOptionalNumber(idealTimeSeconds))
  ) {
    return undefined;
  }

  const economy = value.economy;
  if (
    !legacyEconomy &&
    (!isRecord(economy) ||
      !isRecord(economy.machineCosts) ||
      !isOptionalNumber(economy.budgetLimit) ||
      typeof economy.machineCosts['tracked-conveyor'] !== 'number' ||
      typeof economy.machineCosts.spring !== 'number' ||
      !isOptionalNumber(economy.machineCosts['turbo-spring']) ||
      (economy.conveyorSpeedCosts !== undefined &&
        (!isRecord(economy.conveyorSpeedCosts) ||
          typeof economy.conveyorSpeedCosts.slow !== 'number' ||
          typeof economy.conveyorSpeedCosts.normal !== 'number' ||
          typeof economy.conveyorSpeedCosts.fast !== 'number')))
  ) {
    return undefined;
  }
  const machineCosts =
    isRecord(economy) && isRecord(economy.machineCosts) ? economy.machineCosts : undefined;
  const conveyorSpeedCosts =
    isRecord(economy) && isRecord(economy.conveyorSpeedCosts)
      ? {
          slow: economy.conveyorSpeedCosts.slow as number,
          normal: economy.conveyorSpeedCosts.normal as number,
          fast: economy.conveyorSpeedCosts.fast as number,
        }
      : undefined;
  const legacyUnitCost = value.availableMachines.reduce((highestCost, type) => {
    if (type === 'spring') return Math.max(highestCost, DEFAULT_MACHINE_COSTS.spring);
    if (type === 'turbo-spring') {
      return Math.max(highestCost, DEFAULT_MACHINE_COSTS['turbo-spring']!);
    }
    if (type === 'tracked-conveyor' || type === 'conveyor') {
      return Math.max(highestCost, DEFAULT_MACHINE_COSTS['tracked-conveyor']);
    }
    return highestCost;
  }, DEFAULT_MACHINE_COSTS['tracked-conveyor']);
  const parsedEconomy: ContractEconomy = legacyEconomy
    ? {
        budgetLimit: (goal.pieceBudget as number) * legacyUnitCost,
        machineCosts: { ...DEFAULT_MACHINE_COSTS },
      }
    : {
        ...((economy as Record<string, unknown>).budgetLimit === undefined
          ? {}
          : { budgetLimit: (economy as Record<string, unknown>).budgetLimit as number }),
        machineCosts: {
          'tracked-conveyor': machineCosts!['tracked-conveyor'] as number,
          spring: machineCosts!.spring as number,
          'turbo-spring':
            (machineCosts!['turbo-spring'] as number | undefined) ??
            DEFAULT_MACHINE_COSTS['turbo-spring'],
        },
        ...(conveyorSpeedCosts ? { conveyorSpeedCosts } : {}),
      };

  return normalizeContract({
    id: value.id,
    world,
    stage,
    revision,
    order: contractOrder(world, stage),
    title: value.title,
    subtitle: value.subtitle,
    description: value.description,
    grid: { columns: value.grid.columns, rows: value.grid.rows },
    availableMachines: value.availableMachines,
    fixedMachines: value.fixedMachines,
    obstacles: value.obstacles,
    collectibles,
    goal: {
      deliveries: goal.deliveries,
      ...(goal.maxLosses === undefined ? {} : { maxLosses: goal.maxLosses }),
    },
    economy: parsedEconomy,
    spawnIntervalSeconds: value.spawnIntervalSeconds,
    initialCamera: {
      centerX: value.initialCamera.centerX,
      centerY: value.initialCamera.centerY,
      zoom: value.initialCamera.zoom,
    },
  });
}

function isMachineState(value: unknown): value is MachineState {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isMachineType(value.type) &&
    typeof value.gridX === 'number' &&
    Number.isFinite(value.gridX) &&
    typeof value.gridY === 'number' &&
    Number.isFinite(value.gridY) &&
    typeof value.angle === 'number' &&
    Number.isFinite(value.angle) &&
    typeof value.reversed === 'boolean' &&
    (value.conveyorSpeed === undefined ||
      CONVEYOR_SPEEDS.includes(value.conveyorSpeed as ConveyorSpeed)) &&
    typeof value.fixed === 'boolean'
  );
}

function normalizeConveyorSpeed(value: ConveyorSpeed | undefined): ConveyorSpeed {
  return value && CONVEYOR_SPEEDS.includes(value) ? value : 'normal';
}

function isObstacleDefinition(value: unknown): value is ObstacleDefinition {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.gridX === 'number' &&
    Number.isFinite(value.gridX) &&
    typeof value.gridY === 'number' &&
    Number.isFinite(value.gridY) &&
    typeof value.columns === 'number' &&
    Number.isFinite(value.columns) &&
    typeof value.rows === 'number' &&
    Number.isFinite(value.rows) &&
    (value.angle === undefined || (typeof value.angle === 'number' && Number.isFinite(value.angle)))
  );
}

function isCollectibleDefinition(value: unknown): value is CollectibleDefinition {
  return (
    isRecord(value) &&
    value.type === 'star' &&
    typeof value.id === 'string' &&
    typeof value.gridX === 'number' &&
    Number.isFinite(value.gridX) &&
    typeof value.gridY === 'number' &&
    Number.isFinite(value.gridY)
  );
}

function isContractStage(value: unknown): value is ContractStage {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10;
}

function isMachineType(value: unknown): value is MachineType {
  return MACHINE_TYPES.includes(value as MachineType);
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isStableContractId(value: string): boolean {
  return value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value);
}

function catalogFailure(error: string): PersistenceResult<ContractCatalogFile> {
  return { ok: false, value: createDefaultContractCatalog(), error };
}

function roundForCatalog(value: number, precision: number): number {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function defaultRandomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type AddIssue = (code: ContractValidationCode, path: string, message: string) => void;

function validateInteger(
  value: number,
  minimum: number,
  path: string,
  message: string,
  add: AddIssue,
): void {
  if (!Number.isInteger(value) || value < minimum) {
    add('invalid-number', path, message);
  }
}

function validateOptionalNonNegativeInteger(
  value: number | undefined,
  path: string,
  message: string,
  add: AddIssue,
): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    add('invalid-number', path, message);
  }
}

function normalizeDegrees(value: number): number {
  return ((Math.round(value) % 360) + 360) % 360;
}

interface Point {
  x: number;
  y: number;
}

const MACHINE_SIZE_IN_CELLS: Record<MachineType, { width: number; height: number }> = {
  source: { width: 68 / 48, height: 68 / 48 },
  conveyor: { width: 85 / 48, height: 21 / 48 },
  'tracked-conveyor': { width: 85 / 48, height: 21 / 48 },
  receiver: { width: 76 / 48, height: 76 / 48 },
  spring: { width: 2, height: 1 },
  'turbo-spring': { width: 2, height: 1 },
};

function machinePolygon(machine: MachineState): Point[] {
  const size = MACHINE_SIZE_IN_CELLS[machine.type];
  if (machine.type === 'conveyor' || machine.type === 'tracked-conveyor') {
    return capsulePolygon(
      { x: machine.gridX + 0.5, y: machine.gridY + 0.5 },
      size.width,
      size.height,
      machine.angle,
    );
  }
  return rectangleCorners(
    { x: machine.gridX + 0.5, y: machine.gridY + 0.5 },
    size.width,
    size.height,
    machine.angle,
  );
}

function obstaclePolygon(obstacle: ObstacleDefinition): Point[] {
  return rectangleCorners(
    {
      x: obstacle.gridX + obstacle.columns / 2,
      y: obstacle.gridY + obstacle.rows / 2,
    },
    obstacle.columns,
    obstacle.rows,
    obstacle.angle ?? 0,
  );
}

function rectangleCorners(center: Point, width: number, height: number, angle: number): Point[] {
  const radians = (angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotate = (x: number, y: number): Point => ({
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  });
  return [
    rotate(-width / 2, -height / 2),
    rotate(width / 2, -height / 2),
    rotate(width / 2, height / 2),
    rotate(-width / 2, height / 2),
  ];
}

function capsulePolygon(
  center: Point,
  width: number,
  height: number,
  angle: number,
  capSegments = 4,
): Point[] {
  const radius = Math.min(width, height) / 2;
  const straightHalfWidth = Math.max(0, width / 2 - radius);
  const radians = (angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotate = (x: number, y: number): Point => ({
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  });
  const points: Point[] = [];
  for (let index = 0; index <= capSegments; index += 1) {
    const capAngle = -Math.PI / 2 + (Math.PI * index) / capSegments;
    points.push(
      rotate(
        straightHalfWidth + Math.cos(capAngle) * radius,
        Math.sin(capAngle) * radius,
      ),
    );
  }
  for (let index = 0; index <= capSegments; index += 1) {
    const capAngle = Math.PI / 2 + (Math.PI * index) / capSegments;
    points.push(
      rotate(
        -straightHalfWidth + Math.cos(capAngle) * radius,
        Math.sin(capAngle) * radius,
      ),
    );
  }
  return points;
}

function polygonWithinBoard(polygon: readonly Point[]): boolean {
  return polygon.every(
    ({ x, y }) =>
      x >= PLAY_AREA_MIN_COLUMN &&
      y >= PLAY_AREA_MIN_ROW &&
      x <= PLAY_AREA_MAX_COLUMN &&
      y <= PLAY_AREA_MAX_ROW,
  );
}

function obstacleWithinBoard(obstacle: ObstacleDefinition): boolean {
  return polygonWithinBoard(obstaclePolygon(obstacle));
}

function pointWithinBoard(x: number, y: number, margin = 0): boolean {
  return (
    x >= PLAY_AREA_MIN_COLUMN + margin &&
    y >= PLAY_AREA_MIN_ROW + margin &&
    x <= PLAY_AREA_MAX_COLUMN - margin &&
    y <= PLAY_AREA_MAX_ROW - margin
  );
}

function contractSlotKey(contract: Pick<ContractDefinition, 'world' | 'stage'>): string {
  return `${contract.world}:${contract.stage}`;
}

function polygonsOverlap(left: readonly Point[], right: readonly Point[]): boolean {
  for (const axis of [...polygonAxes(left), ...polygonAxes(right)]) {
    const leftProjection = projectPolygon(left, axis);
    const rightProjection = projectPolygon(right, axis);
    if (
      leftProjection.max <= rightProjection.min + 0.001 ||
      rightProjection.max <= leftProjection.min + 0.001
    ) {
      return false;
    }
  }
  return true;
}

function polygonAxes(points: readonly Point[]): Point[] {
  return points.map((point, index) => {
    const next = points[(index + 1) % points.length] ?? point;
    const dx = next.x - point.x;
    const dy = next.y - point.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: -dy / length, y: dx / length };
  });
}

function projectPolygon(points: readonly Point[], axis: Point): { min: number; max: number } {
  const values = points.map(({ x, y }) => x * axis.x + y * axis.y);
  return { min: Math.min(...values), max: Math.max(...values) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
