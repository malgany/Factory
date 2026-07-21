import contractCatalogJson from '../../public/data/contracts.json';

import {
  GRID_COLUMNS,
  GRID_ROWS,
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

// This export is primarily a deterministic default for domain helpers and tests.
// Runtime startup validates and loads the same file through BrowserPlatformService.
export const CONTRACTS: readonly ContractDefinition[] = structuredClone(
  contractCatalogJson.contracts,
) as ContractDefinition[];

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
  if (!contract) throw new Error(`Contrato desconhecido: ${contractId}`);
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

export function orderContracts(contracts: readonly ContractDefinition[]): ContractDefinition[] {
  return [...contracts].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}
