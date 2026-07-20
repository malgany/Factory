import { BUILTIN_CONTRACT_IDS, CONTRACTS, isBuiltinContractId, orderContracts } from './contracts';
import {
  GRID_COLUMNS,
  GRID_ROWS,
  PLAY_AREA_MAX_COLUMN,
  PLAY_AREA_MAX_ROW,
  PLAY_AREA_MIN_COLUMN,
  PLAY_AREA_MIN_ROW,
  type BuiltinContractId,
  type ContractCatalogSave,
  type ContractDefinition,
  type MachineState,
  type MachineType,
  type ObstacleDefinition,
  type PersistenceResult,
} from './types';

export const CONTRACT_CATALOG_VERSION = 1 as const;

const MACHINE_TYPES: readonly MachineType[] = ['source', 'conveyor', 'receiver', 'spring'];
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
  | 'invalid-machine'
  | 'invalid-obstacle'
  | 'par-over-budget';

export interface ContractValidationIssue {
  code: ContractValidationCode;
  path: string;
  message: string;
}

export interface ContractValidationResult {
  valid: boolean;
  issues: ContractValidationIssue[];
}

export interface ContractCatalogMetadata {
  builtIn: boolean;
  custom: boolean;
  overridden: boolean;
}

export type NewContractDefinition = Omit<ContractDefinition, 'id' | 'order'> & {
  id?: ContractDefinition['id'];
  order?: number;
};

export function createDefaultContractCatalog(): ContractCatalogSave {
  return {
    version: CONTRACT_CATALOG_VERSION,
    overrides: {},
    customContracts: [],
    updatedAt: EMPTY_UPDATED_AT,
  };
}

export function readContractCatalog(input: unknown): PersistenceResult<ContractCatalogSave> {
  if (input === null || input === undefined || input === '') {
    return { ok: true, value: createDefaultContractCatalog() };
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

  if (candidate.version !== CONTRACT_CATALOG_VERSION) {
    return catalogFailure('A versão do catálogo de fases não é compatível.');
  }

  if (!isRecord(candidate.overrides) || !Array.isArray(candidate.customContracts)) {
    return catalogFailure('O catálogo de fases salvo está incompleto.');
  }

  const overrides: ContractCatalogSave['overrides'] = {};
  for (const [id, value] of Object.entries(candidate.overrides)) {
    if (!isBuiltinContractId(id)) {
      return catalogFailure(`O catálogo contém um override desconhecido: ${id}.`);
    }
    const contract = readContractDefinition(value);
    if (!contract || contract.id !== id) {
      return catalogFailure(`O override da fase ${id} é inválido.`);
    }
    const validation = validateContractDefinition(contract);
    if (!validation.valid) {
      return catalogFailure(`O override da fase ${id} não passou na validação.`);
    }
    overrides[id] = contract;
  }

  const customContracts: ContractDefinition[] = [];
  const ids = new Set<string>(BUILTIN_CONTRACT_IDS);
  for (const value of candidate.customContracts) {
    const contract = readContractDefinition(value);
    if (!contract || isBuiltinContractId(contract.id) || ids.has(contract.id)) {
      return catalogFailure('O catálogo contém uma fase personalizada inválida ou duplicada.');
    }
    const validation = validateContractDefinition(contract);
    if (!validation.valid) {
      return catalogFailure(`A fase personalizada ${contract.id} não passou na validação.`);
    }
    ids.add(contract.id);
    customContracts.push(contract);
  }

  return {
    ok: true,
    value: normalizeContractCatalog({
      version: CONTRACT_CATALOG_VERSION,
      overrides,
      customContracts,
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : EMPTY_UPDATED_AT,
    }),
  };
}

export function parseContractCatalog(input: unknown): ContractCatalogSave {
  return readContractCatalog(input).value;
}

export function serializeContractCatalog(catalog: ContractCatalogSave): string {
  return JSON.stringify(normalizeContractCatalog(catalog));
}

export function mergeContractCatalog(catalog: ContractCatalogSave): ContractDefinition[] {
  const builtins = CONTRACTS.map((original, index) => {
    const id = original.id as BuiltinContractId;
    const override = catalog.overrides[id];
    return cloneContract({ ...(override ?? original), id, order: index + 1 });
  });
  const custom = orderContracts(catalog.customContracts).map((contract, index) =>
    cloneContract({ ...contract, order: builtins.length + index + 1 }),
  );
  return [...builtins, ...custom];
}

export function normalizeContractCatalog(catalog: ContractCatalogSave): ContractCatalogSave {
  const merged = mergeContractCatalogRaw(catalog);
  const overrides: ContractCatalogSave['overrides'] = {};
  for (const id of BUILTIN_CONTRACT_IDS) {
    const override = catalog.overrides[id];
    if (override) {
      const original = CONTRACTS.find((contract) => contract.id === id);
      overrides[id] = cloneContract({
        ...override,
        id,
        order: original?.order ?? BUILTIN_CONTRACT_IDS.indexOf(id) + 1,
      });
    }
  }
  return {
    version: CONTRACT_CATALOG_VERSION,
    overrides,
    customContracts: merged.customContracts,
    updatedAt: catalog.updatedAt,
  };
}

export function saveContractToCatalog(
  catalog: ContractCatalogSave,
  contract: ContractDefinition,
  updatedAt = new Date().toISOString(),
): ContractCatalogSave {
  const validation = validateContractDefinition(contract);
  if (!validation.valid) {
    throw new Error(validation.issues[0]?.message ?? 'A fase é inválida.');
  }

  const next = normalizeContractCatalog(catalog);
  if (isBuiltinContractId(contract.id)) {
    const original = CONTRACTS.find((candidate) => candidate.id === contract.id);
    next.overrides[contract.id] = cloneContract({
      ...contract,
      order: original?.order ?? contract.order,
    });
  } else {
    const index = next.customContracts.findIndex((candidate) => candidate.id === contract.id);
    if (index >= 0) {
      next.customContracts[index] = cloneContract(contract);
    } else {
      next.customContracts.push(cloneContract(contract));
    }
  }
  next.updatedAt = updatedAt;
  return normalizeContractCatalog(next);
}

export function appendCustomContract(
  catalog: ContractCatalogSave,
  definition: NewContractDefinition,
  updatedAt = new Date().toISOString(),
): { catalog: ContractCatalogSave; contract: ContractDefinition } {
  const usedIds = new Set(mergeContractCatalog(catalog).map(({ id }) => id));
  let id = definition.id;
  while (!id || usedIds.has(id) || isBuiltinContractId(id)) {
    id = createCustomContractId();
  }
  const contract: ContractDefinition = {
    ...cloneContractFields(definition),
    id,
    order: CONTRACTS.length + catalog.customContracts.length + 1,
  };
  return {
    catalog: saveContractToCatalog(catalog, contract, updatedAt),
    contract,
  };
}

export function restoreBuiltinContract(
  catalog: ContractCatalogSave,
  contractId: BuiltinContractId,
  updatedAt = new Date().toISOString(),
): ContractCatalogSave {
  const next = normalizeContractCatalog(catalog);
  delete next.overrides[contractId];
  next.updatedAt = updatedAt;
  return normalizeContractCatalog(next);
}

export function deleteCustomContract(
  catalog: ContractCatalogSave,
  contractId: string,
  updatedAt = new Date().toISOString(),
): ContractCatalogSave {
  if (isBuiltinContractId(contractId)) {
    throw new Error('Fases originais não podem ser excluídas.');
  }
  const next = normalizeContractCatalog(catalog);
  next.customContracts = next.customContracts.filter((contract) => contract.id !== contractId);
  next.updatedAt = updatedAt;
  return normalizeContractCatalog(next);
}

export function hasBuiltinOverride(
  catalog: ContractCatalogSave,
  contractId: BuiltinContractId,
): boolean {
  return catalog.overrides[contractId] !== undefined;
}

export function getContractCatalogMetadata(
  catalog: ContractCatalogSave,
  contractId: string,
): ContractCatalogMetadata {
  const builtIn = isBuiltinContractId(contractId);
  return {
    builtIn,
    custom: !builtIn && catalog.customContracts.some((contract) => contract.id === contractId),
    overridden: builtIn && catalog.overrides[contractId] !== undefined,
  };
}

export function getContractCatalogMetadataMap(
  catalog: ContractCatalogSave,
): Record<string, ContractCatalogMetadata> {
  return Object.fromEntries(
    mergeContractCatalog(catalog).map((contract) => [
      contract.id,
      getContractCatalogMetadata(catalog, contract.id),
    ]),
  );
}

export function createCustomContractId(randomUuid: () => string = defaultRandomUuid): string {
  return `${CUSTOM_ID_PREFIX}${randomUuid()}`;
}

export function createEmptyContractDraft(
  catalog: ContractCatalogSave,
  id = createCustomContractId(),
): ContractDefinition {
  return {
    id,
    order: mergeContractCatalog(catalog).length + 1,
    title: 'Nova fase',
    subtitle: 'Crie um novo desafio.',
    description: 'Monte o cenário e configure as ferramentas disponíveis.',
    grid: { columns: GRID_COLUMNS, rows: GRID_ROWS },
    availableMachines: ['conveyor', 'spring'],
    fixedMachines: [],
    obstacles: [],
    goal: {
      deliveries: 10,
      maxLosses: 3,
      pieceBudget: 8,
      parPieces: 7,
    },
    spawnIntervalSeconds: 1.25,
  };
}

export function validateContractDefinition(contract: ContractDefinition): ContractValidationResult {
  const issues: ContractValidationIssue[] = [];
  const add = (code: ContractValidationCode, path: string, message: string): void => {
    issues.push({ code, path, message });
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
  validateInteger(
    contract.goal.maxLosses,
    0,
    'goal.maxLosses',
    'As perdas máximas não podem ser negativas.',
    add,
  );
  validateInteger(
    contract.goal.pieceBudget,
    0,
    'goal.pieceBudget',
    'O orçamento não pode ser negativo.',
    add,
  );
  validateInteger(
    contract.goal.parPieces,
    0,
    'goal.parPieces',
    'A referência de peças não pode ser negativa.',
    add,
  );
  if (contract.goal.parPieces > contract.goal.pieceBudget) {
    add('par-over-budget', 'goal.parPieces', 'A referência de peças não pode superar o orçamento.');
  }
  validateOptionalPositive(
    contract.goal.timeLimitSeconds,
    'goal.timeLimitSeconds',
    'O tempo limite deve ser positivo.',
    add,
  );
  validateOptionalPositive(
    contract.goal.parTimeSeconds,
    'goal.parTimeSeconds',
    'A referência de tempo deve ser positiva.',
    add,
  );
  if (!Number.isFinite(contract.spawnIntervalSeconds) || contract.spawnIntervalSeconds <= 0) {
    add('invalid-number', 'spawnIntervalSeconds', 'O intervalo de geração deve ser positivo.');
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
    if (!isHalfGrid(machine.gridX) || !isHalfGrid(machine.gridY)) {
      add('invalid-machine', path, 'Objetos do cenário devem respeitar a meia-grade.');
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
      !Number.isInteger(obstacle.gridX) ||
      !Number.isInteger(obstacle.gridY) ||
      !Number.isInteger(obstacle.columns) ||
      !Number.isInteger(obstacle.rows) ||
      obstacle.columns < 1 ||
      obstacle.rows < 1
    ) {
      add(
        'invalid-obstacle',
        path,
        'Bloqueadores devem ocupar células inteiras e medir pelo menos 1×1.',
      );
    }
    if (!obstacleWithinBoard(obstacle)) {
      add('out-of-bounds', path, 'Há um bloqueador fora do tabuleiro.');
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
    goal: { ...contract.goal },
  };
}

function mergeContractCatalogRaw(catalog: ContractCatalogSave): {
  customContracts: ContractDefinition[];
} {
  return {
    customContracts: orderContracts(catalog.customContracts).map((contract, index) =>
      cloneContract({ ...contract, order: CONTRACTS.length + index + 1 }),
    ),
  };
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
    goal: { ...definition.goal },
  };
}

function readContractDefinition(value: unknown): ContractDefinition | undefined {
  if (!isRecord(value) || !isRecord(value.grid) || !isRecord(value.goal)) return undefined;
  if (!Array.isArray(value.availableMachines) || !Array.isArray(value.fixedMachines)) {
    return undefined;
  }
  if (!Array.isArray(value.obstacles)) return undefined;
  if (
    typeof value.id !== 'string' ||
    typeof value.order !== 'number' ||
    typeof value.title !== 'string' ||
    typeof value.subtitle !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.grid.columns !== 'number' ||
    typeof value.grid.rows !== 'number' ||
    typeof value.spawnIntervalSeconds !== 'number'
  ) {
    return undefined;
  }
  if (!value.availableMachines.every(isMachineType)) return undefined;
  if (!value.fixedMachines.every(isMachineState)) return undefined;
  if (!value.obstacles.every(isObstacleDefinition)) return undefined;
  const goal = value.goal;
  if (
    typeof goal.deliveries !== 'number' ||
    typeof goal.maxLosses !== 'number' ||
    typeof goal.pieceBudget !== 'number' ||
    typeof goal.parPieces !== 'number' ||
    !isOptionalNumber(goal.timeLimitSeconds) ||
    !isOptionalNumber(goal.parTimeSeconds)
  ) {
    return undefined;
  }

  return cloneContract({
    id: value.id,
    order: value.order,
    title: value.title,
    subtitle: value.subtitle,
    description: value.description,
    grid: { columns: value.grid.columns, rows: value.grid.rows },
    availableMachines: value.availableMachines,
    fixedMachines: value.fixedMachines,
    obstacles: value.obstacles,
    goal: {
      deliveries: goal.deliveries,
      maxLosses: goal.maxLosses,
      pieceBudget: goal.pieceBudget,
      parPieces: goal.parPieces,
      ...(goal.timeLimitSeconds === undefined ? {} : { timeLimitSeconds: goal.timeLimitSeconds }),
      ...(goal.parTimeSeconds === undefined ? {} : { parTimeSeconds: goal.parTimeSeconds }),
    },
    spawnIntervalSeconds: value.spawnIntervalSeconds,
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
    typeof value.fixed === 'boolean'
  );
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
    Number.isFinite(value.rows)
  );
}

function isMachineType(value: unknown): value is MachineType {
  return MACHINE_TYPES.includes(value as MachineType);
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isStableContractId(value: string): boolean {
  return value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value);
}

function catalogFailure(error: string): PersistenceResult<ContractCatalogSave> {
  return { ok: false, value: createDefaultContractCatalog(), error };
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

function validateOptionalPositive(
  value: number | undefined,
  path: string,
  message: string,
  add: AddIssue,
): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    add('invalid-number', path, message);
  }
}

function isHalfGrid(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 2 - Math.round(value * 2)) < 0.000_001;
}

interface Point {
  x: number;
  y: number;
}

const MACHINE_SIZE_IN_CELLS: Record<MachineType, { width: number; height: number }> = {
  source: { width: 68 / 48, height: 68 / 48 },
  conveyor: { width: 92 / 48, height: 22 / 48 },
  receiver: { width: 76 / 48, height: 76 / 48 },
  spring: { width: 2, height: 1 },
};

function machinePolygon(machine: MachineState): Point[] {
  const size = MACHINE_SIZE_IN_CELLS[machine.type];
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
    0,
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
  return (
    obstacle.gridX >= PLAY_AREA_MIN_COLUMN &&
    obstacle.gridY >= PLAY_AREA_MIN_ROW &&
    obstacle.gridX + obstacle.columns <= PLAY_AREA_MAX_COLUMN &&
    obstacle.gridY + obstacle.rows <= PLAY_AREA_MAX_ROW
  );
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
