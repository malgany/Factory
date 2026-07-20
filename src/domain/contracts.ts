import {
  GRID_COLUMNS,
  GRID_ROWS,
  type BuiltinContractId,
  type ContractDefinition,
  type ContractId,
  type GridSize,
  type MachineState,
  type MachineType,
} from './types';

const DEFAULT_GRID: GridSize = {
  columns: GRID_COLUMNS,
  rows: GRID_ROWS,
};

const fixedMachine = (
  id: string,
  type: Extract<MachineType, 'source' | 'receiver'>,
  gridX: number,
  gridY: number,
  angle = 0,
): MachineState => ({
  id,
  type,
  gridX,
  gridY,
  angle,
  reversed: false,
  fixed: true,
});

export const CONTRACTS: readonly ContractDefinition[] = [
  {
    id: 'first-flow',
    order: 1,
    title: 'Primeiro Fluxo',
    subtitle: 'Faça a linha funcionar.',
    description:
      'Ligue a saída acima e à esquerda à entrada abaixo e à direita usando somente esteiras.',
    grid: DEFAULT_GRID,
    availableMachines: ['conveyor'],
    fixedMachines: [
      fixedMachine('first-flow-source', 'source', 4.5, 4.5),
      fixedMachine('first-flow-receiver', 'receiver', 15.5, 12.5),
    ],
    obstacles: [],
    goal: {
      deliveries: 10,
      maxLosses: 3,
      pieceBudget: 8,
      parPieces: 7,
      parTimeSeconds: 32,
    },
    spawnIntervalSeconds: 1.25,
  },
  {
    id: 'controlled-jump',
    order: 2,
    title: 'Salto Controlado',
    subtitle: 'Atravesse a barreira.',
    description:
      'Combine esteiras e trampolins para lançar as caixas por cima da barreira central.',
    grid: DEFAULT_GRID,
    availableMachines: ['conveyor', 'spring'],
    fixedMachines: [
      fixedMachine('controlled-jump-source', 'source', 4.5, 4.5),
      fixedMachine('controlled-jump-receiver', 'receiver', 19.5, 13.5),
    ],
    obstacles: [
      {
        id: 'controlled-jump-barrier',
        gridX: 11,
        gridY: 9,
        columns: 3,
        rows: 6,
      },
    ],
    goal: {
      deliveries: 12,
      maxLosses: 3,
      pieceBudget: 8,
      parPieces: 7,
      parTimeSeconds: 38,
    },
    spawnIntervalSeconds: 1.1,
  },
  {
    id: 'line-rhythm',
    order: 3,
    title: 'Linha de Ritmo',
    subtitle: 'Sincronize dois fluxos.',
    description:
      'Conduza duas saídas por entre os obstáculos e alimente uma única entrada antes do tempo acabar.',
    grid: DEFAULT_GRID,
    availableMachines: ['conveyor', 'spring'],
    fixedMachines: [
      fixedMachine('line-rhythm-source-a', 'source', 3.5, 3.5),
      fixedMachine('line-rhythm-source-b', 'source', 3.5, 11.5),
      fixedMachine('line-rhythm-receiver', 'receiver', 24.5, 14.5),
    ],
    obstacles: [
      {
        id: 'line-rhythm-obstacle-a',
        gridX: 10,
        gridY: 5,
        columns: 3,
        rows: 4,
      },
      {
        id: 'line-rhythm-obstacle-b',
        gridX: 17,
        gridY: 10,
        columns: 4,
        rows: 3,
      },
    ],
    goal: {
      deliveries: 25,
      maxLosses: 2,
      pieceBudget: 12,
      timeLimitSeconds: 45,
      parPieces: 10,
      parTimeSeconds: 40,
    },
    spawnIntervalSeconds: 0.72,
  },
] as const;

export const BUILTIN_CONTRACT_IDS: readonly BuiltinContractId[] = [
  'first-flow',
  'controlled-jump',
  'line-rhythm',
];

export interface SandboxDefinition {
  readonly title: string;
  readonly description: string;
  readonly grid: GridSize;
  readonly availableMachines: readonly MachineType[];
  readonly fixedMachines: readonly MachineState[];
  readonly pieceBudget?: never;
  readonly timeLimitSeconds?: never;
}

export const SANDBOX_DEFINITION: SandboxDefinition = {
  title: 'Modo Livre',
  description: 'Construa sem orçamento, cronômetro ou condição de vitória.',
  grid: DEFAULT_GRID,
  availableMachines: ['source', 'conveyor', 'receiver', 'spring'],
  fixedMachines: [],
};

export function getContract(
  contractId: ContractId,
  contracts: readonly ContractDefinition[] = CONTRACTS,
): ContractDefinition {
  const contract = contracts.find((candidate) => candidate.id === contractId);
  if (!contract) {
    throw new Error(`Contrato desconhecido: ${contractId}`);
  }
  return contract;
}

export function getNextContractId(
  contractId: ContractId,
  contracts: readonly ContractDefinition[] = CONTRACTS,
): ContractId | undefined {
  const ordered = orderContracts(contracts);
  const index = ordered.findIndex((contract) => contract.id === contractId);
  return index >= 0 ? ordered[index + 1]?.id : undefined;
}

export function isContractId(
  value: unknown,
  contracts: readonly ContractDefinition[] = CONTRACTS,
): value is ContractId {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    contracts.some((contract) => contract.id === value)
  );
}

export function isBuiltinContractId(value: unknown): value is BuiltinContractId {
  return typeof value === 'string' && BUILTIN_CONTRACT_IDS.includes(value as BuiltinContractId);
}

export function orderContracts(contracts: readonly ContractDefinition[]): ContractDefinition[] {
  return [...contracts].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}
