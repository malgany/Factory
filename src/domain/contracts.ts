import contractCatalogJson from '../../public/data/contracts.json';

import {
  GRID_COLUMNS,
  GRID_ROWS,
  type ContractCatalogFile,
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
export const CONTRACT_CATALOG: ContractCatalogFile = structuredClone(
  contractCatalogJson,
) as ContractCatalogFile;

export const CONTRACTS: readonly ContractDefinition[] = structuredClone(
  CONTRACT_CATALOG.contracts,
);

export interface SandboxDefinition {
  readonly title: string;
  readonly description: string;
  readonly grid: GridSize;
  readonly availableMachines: readonly MachineType[];
  readonly fixedMachines: readonly MachineState[];
  readonly economy?: never;
}

export const SANDBOX_DEFINITION: SandboxDefinition = {
  title: 'Modo Livre',
  description: 'Construa sem limite de orçamento ou condição de vitória.',
  grid: DEFAULT_GRID,
  availableMachines: [
    'source',
    'slow-conveyor',
    'tracked-conveyor',
    'fast-conveyor',
    'receiver',
    'spring',
    'turbo-spring',
  ],
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
  const current = contracts.find((contract) => contract.id === contractId);
  if (!current) return undefined;
  const nextWorld = current.stage === 10 ? current.world + 1 : current.world;
  const nextStage = current.stage === 10 ? 1 : current.stage + 1;
  return contracts.find((contract) => contract.world === nextWorld && contract.stage === nextStage)
    ?.id;
}

export function getContractBySlot(
  world: number,
  stage: number,
  contracts: readonly ContractDefinition[] = CONTRACTS,
): ContractDefinition | undefined {
  return contracts.find((contract) => contract.world === world && contract.stage === stage);
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
    (left, right) =>
      left.world - right.world || left.stage - right.stage || left.id.localeCompare(right.id),
  );
}
