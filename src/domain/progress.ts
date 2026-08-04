import { CONTRACTS, getNextContractId, orderContracts } from './contracts';
import {
  canonicalMachineType,
  conveyorSpeedForMachineType,
  isConveyorMachineType,
} from './economy';
import type {
  ContractDefinition,
  ContractId,
  CampaignLayoutSave,
  ConveyorSpeed,
  MachineState,
  ProgressSave,
  SandboxSave,
} from './types';

export const PROGRESS_VERSION = 5 as const;
const CONVEYOR_SPEEDS: readonly ConveyorSpeed[] = ['slow', 'normal', 'fast'];

export function createDefaultProgress(
  contracts: readonly ContractDefinition[] = CONTRACTS,
): ProgressSave {
  const firstContract = contracts.find(({ world, stage }) => world === 1 && stage === 1)?.id;
  return {
    version: PROGRESS_VERSION,
    unlockedContracts: firstContract ? [firstContract] : [],
    completedContracts: {},
    settings: {
      muted: false,
      volume: 0.65,
    },
    sandbox: {
      machines: [],
      updatedAt: new Date(0).toISOString(),
    },
    campaignLayouts: {},
  };
}

export function parseProgress(
  input: unknown,
  contracts: readonly ContractDefinition[] = CONTRACTS,
): ProgressSave {
  if (input === null || input === undefined || input === '') {
    return createDefaultProgress(contracts);
  }

  let candidate: unknown = input;
  if (typeof input === 'string') {
    try {
      candidate = JSON.parse(input) as unknown;
    } catch {
      return createDefaultProgress(contracts);
    }
  }

  if (!isRecord(candidate)) {
    return createDefaultProgress(contracts);
  }

  return migrateProgress(candidate, contracts);
}

export function serializeProgress(progress: ProgressSave): string {
  return JSON.stringify(progress);
}

export function reconcileProgress(
  progress: ProgressSave,
  contracts: readonly ContractDefinition[],
): ProgressSave {
  const ordered = orderContracts(contracts);
  const knownIds = new Set(ordered.map(({ id }) => id));
  const unlocked = new Set(progress.unlockedContracts.filter((id) => knownIds.has(id)));
  const firstContract = ordered.find(({ world, stage }) => world === 1 && stage === 1);
  if (firstContract) unlocked.add(firstContract.id);

  const completedContracts: ProgressSave['completedContracts'] = {};
  for (const contract of ordered) {
    if (progress.completedContracts[contract.id] === contract.revision) {
      completedContracts[contract.id] = contract.revision;
    }
  }

  // A newly registered immediate successor becomes available if the preceding
  // slot has already been completed. Missing slots never get skipped.
  let changed = true;
  while (changed) {
    changed = false;
    for (const contract of ordered) {
      if (completedContracts[contract.id] !== contract.revision) continue;
      const nextId = getNextContractId(contract.id, ordered);
      if (nextId && !unlocked.has(nextId)) {
        unlocked.add(nextId);
        changed = true;
      }
    }
  }

  return {
    ...structuredClone(progress),
    version: PROGRESS_VERSION,
    unlockedContracts: ordered.filter(({ id }) => unlocked.has(id)).map(({ id }) => id),
    completedContracts,
    campaignLayouts: reconcileCampaignLayouts(progress.campaignLayouts, ordered),
  };
}

export function completeContract(
  progress: ProgressSave,
  contractId: ContractId,
  contractRevision: number,
  contracts: readonly ContractDefinition[] = CONTRACTS,
): ProgressSave {
  const contract = contracts.find(({ id }) => id === contractId);
  if (!contract || contract.revision !== contractRevision) {
    return reconcileProgress(progress, contracts);
  }

  const next = structuredClone(progress);
  next.completedContracts[contractId] = contractRevision;

  const nextContract = getNextContractId(contractId, contracts);
  if (nextContract && !next.unlockedContracts.includes(nextContract)) {
    next.unlockedContracts.push(nextContract);
  }

  return reconcileProgress(next, contracts);
}

export function clearContractCompletion(
  progress: ProgressSave,
  contractId: ContractId,
): ProgressSave {
  const next = structuredClone(progress);
  delete next.completedContracts[contractId];
  return next;
}

export function isContractCompleted(
  progress: ProgressSave,
  contract: Pick<ContractDefinition, 'id' | 'revision'>,
): boolean {
  return progress.completedContracts[contract.id] === contract.revision;
}

export function removeContractProgress(
  progress: ProgressSave,
  contractId: ContractId,
  remainingContracts: readonly ContractDefinition[],
): ProgressSave {
  const next = clearContractCompletion(progress, contractId);
  next.unlockedContracts = next.unlockedContracts.filter((id) => id !== contractId);
  delete next.campaignLayouts[contractId];
  return reconcileProgress(next, remainingContracts);
}

export function updateSandbox(
  progress: ProgressSave,
  machines: readonly MachineState[],
  updatedAt = new Date().toISOString(),
): ProgressSave {
  return {
    ...progress,
    sandbox: {
      machines: structuredClone([...machines]),
      updatedAt,
    },
  };
}

export function updateCampaignLayout(
  progress: ProgressSave,
  contractId: ContractId,
  contractRevision: number,
  machines: readonly MachineState[],
  updatedAt = new Date().toISOString(),
): ProgressSave {
  return {
    ...progress,
    campaignLayouts: {
      ...progress.campaignLayouts,
      [contractId]: {
        revision: contractRevision,
        machines: structuredClone([...machines]),
        updatedAt,
      },
    },
  };
}

function migrateProgress(
  candidate: Record<string, unknown>,
  contracts: readonly ContractDefinition[],
): ProgressSave {
  const defaults = createDefaultProgress(contracts);
  const settings = isRecord(candidate.settings) ? candidate.settings : {};
  const preservesCampaignProgress =
    candidate.version === 4 || candidate.version === PROGRESS_VERSION;
  const progress: ProgressSave = {
    version: PROGRESS_VERSION,
    // Preserve progress from the two stable save formats. Contract revisions
    // continue to decide whether an existing completion is still valid.
    unlockedContracts: preservesCampaignProgress
      ? readUnlocked(candidate.unlockedContracts)
      : defaults.unlockedContracts,
    completedContracts: preservesCampaignProgress
      ? readCompletedContracts(candidate.completedContracts)
      : {},
    settings: {
      muted: typeof settings.muted === 'boolean' ? settings.muted : defaults.settings.muted,
      volume: clampNumber(settings.volume, 0, 1, defaults.settings.volume),
    },
    sandbox: readSandbox(candidate.sandbox, defaults.sandbox),
    campaignLayouts: readCampaignLayouts(candidate.campaignLayouts),
  };
  return reconcileProgress(progress, contracts);
}

function readUnlocked(value: unknown): ContractId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isStableContractId))];
}

function readCompletedContracts(value: unknown): ProgressSave['completedContracts'] {
  if (!isRecord(value)) return {};
  const completedContracts: ProgressSave['completedContracts'] = {};
  for (const [contractId, revision] of Object.entries(value)) {
    if (isStableContractId(contractId) && Number.isInteger(revision) && Number(revision) > 0) {
      completedContracts[contractId] = Number(revision);
    }
  }
  return completedContracts;
}

function readSandbox(value: unknown, fallback: SandboxSave): SandboxSave {
  if (!isRecord(value) || !Array.isArray(value.machines)) return fallback;

  const machines = readMachines(value.machines);
  return {
    machines: structuredClone(machines),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : fallback.updatedAt,
  };
}

function readCampaignLayouts(value: unknown): ProgressSave['campaignLayouts'] {
  if (!isRecord(value)) return {};
  const layouts: ProgressSave['campaignLayouts'] = {};
  for (const [contractId, layout] of Object.entries(value)) {
    if (!isStableContractId(contractId) || !isRecord(layout) || !Array.isArray(layout.machines)) {
      continue;
    }
    if (!Number.isInteger(layout.revision) || Number(layout.revision) <= 0) continue;
    layouts[contractId] = {
      revision: Number(layout.revision),
      machines: readMachines(layout.machines),
      updatedAt:
        typeof layout.updatedAt === 'string' ? layout.updatedAt : new Date(0).toISOString(),
    } satisfies CampaignLayoutSave;
  }
  return layouts;
}

function readMachines(value: readonly unknown[]): MachineState[] {
  return value.filter(isMachineState).map((machine) => {
    const type = canonicalMachineType(machine.type, machine.conveyorSpeed);
    return {
      ...machine,
      type,
      conveyorSpeed: isConveyorMachineType(type)
        ? conveyorSpeedForMachineType(type, normalizeConveyorSpeed(machine.conveyorSpeed))
        : undefined,
    };
  });
}

function reconcileCampaignLayouts(
  layouts: ProgressSave['campaignLayouts'],
  contracts: readonly ContractDefinition[],
): ProgressSave['campaignLayouts'] {
  const reconciled: ProgressSave['campaignLayouts'] = {};
  for (const contract of contracts) {
    const layout = layouts[contract.id];
    if (layout?.revision === contract.revision) {
      reconciled[contract.id] = {
        revision: layout.revision,
        machines: structuredClone(layout.machines),
        updatedAt: layout.updatedAt,
      };
    }
  }
  return reconciled;
}

function isMachineState(value: unknown): value is MachineState {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    [
      'source',
      'conveyor',
      'slow-conveyor',
      'tracked-conveyor',
      'fast-conveyor',
      'receiver',
      'spring',
      'turbo-spring',
    ].includes(String(value.type)) &&
    Number.isFinite(value.gridX) &&
    Number.isFinite(value.gridY) &&
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

function isStableContractId(value: unknown): value is ContractId {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
  );
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
