import { CONTRACTS, getNextContractId, orderContracts } from './contracts';
import type {
  ContractDefinition,
  ContractId,
  ContractResult,
  MachineState,
  ProgressSave,
  SandboxSave,
} from './types';

export const PROGRESS_VERSION = 2 as const;

export function createDefaultProgress(
  contracts: readonly ContractDefinition[] = CONTRACTS,
): ProgressSave {
  const firstContract = orderContracts(contracts)[0]?.id;
  return {
    version: PROGRESS_VERSION,
    unlockedContracts: firstContract ? [firstContract] : [],
    bestResults: {},
    settings: {
      muted: false,
      volume: 0.65,
    },
    sandbox: {
      machines: [],
      updatedAt: new Date(0).toISOString(),
    },
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
  const first = ordered[0]?.id;
  if (first) unlocked.add(first);

  // Existing unlocks never regress. A gap from an older save implies that all
  // preceding phases had already been made available.
  let furthestUnlockedIndex = -1;
  for (const id of unlocked) {
    furthestUnlockedIndex = Math.max(
      furthestUnlockedIndex,
      ordered.findIndex((contract) => contract.id === id),
    );
  }
  for (let index = 0; index <= furthestUnlockedIndex; index += 1) {
    const id = ordered[index]?.id;
    if (id) unlocked.add(id);
  }

  // Newly appended phases become available when the preceding phase has a
  // winning result. This keeps custom phases in the same sequential campaign.
  for (let index = 1; index < ordered.length; index += 1) {
    const previousId = ordered[index - 1]?.id;
    const currentId = ordered[index]?.id;
    if (!previousId || !currentId || unlocked.has(currentId)) continue;
    if ((progress.bestResults[previousId]?.stars ?? 0) > 0) unlocked.add(currentId);
  }

  const furthestAfterEligibility = Math.max(
    -1,
    ...[...unlocked].map((id) => ordered.findIndex((contract) => contract.id === id)),
  );
  for (let index = 0; index <= furthestAfterEligibility; index += 1) {
    const id = ordered[index]?.id;
    if (id) unlocked.add(id);
  }

  const bestResults: ProgressSave['bestResults'] = {};
  for (const contract of ordered) {
    const result = progress.bestResults[contract.id];
    if (result) bestResults[contract.id] = structuredClone(result);
  }

  return {
    ...structuredClone(progress),
    version: PROGRESS_VERSION,
    unlockedContracts: ordered.filter(({ id }) => unlocked.has(id)).map(({ id }) => id),
    bestResults,
  };
}

export function applyContractResult(
  progress: ProgressSave,
  result: ContractResult,
  contracts: readonly ContractDefinition[] = CONTRACTS,
): ProgressSave {
  const next = structuredClone(progress);
  const previous = next.bestResults[result.contractId];

  if (!previous || isBetterResult(result, previous)) {
    next.bestResults[result.contractId] = structuredClone(result);
  }

  const nextContract = getNextContractId(result.contractId, contracts);
  if (result.stars > 0 && nextContract && !next.unlockedContracts.includes(nextContract)) {
    next.unlockedContracts.push(nextContract);
  }

  return reconcileProgress(next, contracts);
}

export function clearContractRecord(progress: ProgressSave, contractId: ContractId): ProgressSave {
  const next = structuredClone(progress);
  delete next.bestResults[contractId];
  return next;
}

export function removeContractProgress(
  progress: ProgressSave,
  contractId: ContractId,
  remainingContracts: readonly ContractDefinition[],
): ProgressSave {
  const next = clearContractRecord(progress, contractId);
  next.unlockedContracts = next.unlockedContracts.filter((id) => id !== contractId);
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

export function isBetterResult(candidate: ContractResult, current: ContractResult): boolean {
  if (candidate.stars !== current.stars) return candidate.stars > current.stars;
  if (candidate.metrics.lost !== current.metrics.lost) {
    return candidate.metrics.lost < current.metrics.lost;
  }
  if (candidate.metrics.placedPieces !== current.metrics.placedPieces) {
    return candidate.metrics.placedPieces < current.metrics.placedPieces;
  }
  if (candidate.metrics.elapsedSeconds !== current.metrics.elapsedSeconds) {
    return candidate.metrics.elapsedSeconds < current.metrics.elapsedSeconds;
  }
  return candidate.metrics.delivered > current.metrics.delivered;
}

function migrateProgress(
  candidate: Record<string, unknown>,
  contracts: readonly ContractDefinition[],
): ProgressSave {
  // Version 1 and the unversioned prototype format share the same fields. The
  // v2 migration widens IDs to strings and then reconciles them with the active
  // (built-in + local) catalog supplied by the caller.
  const defaults = createDefaultProgress(contracts);
  const settings = isRecord(candidate.settings) ? candidate.settings : {};
  const progress: ProgressSave = {
    version: PROGRESS_VERSION,
    unlockedContracts: readUnlocked(candidate.unlockedContracts),
    bestResults: readBestResults(candidate.bestResults),
    settings: {
      muted: typeof settings.muted === 'boolean' ? settings.muted : defaults.settings.muted,
      volume: clampNumber(settings.volume, 0, 1, defaults.settings.volume),
    },
    sandbox: readSandbox(candidate.sandbox, defaults.sandbox),
  };
  return reconcileProgress(progress, contracts);
}

function readUnlocked(value: unknown): ContractId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isStableContractId))];
}

function readBestResults(value: unknown): ProgressSave['bestResults'] {
  if (!isRecord(value)) return {};

  const result: ProgressSave['bestResults'] = {};
  for (const [contractId, candidate] of Object.entries(value)) {
    if (!isStableContractId(contractId) || !isRecord(candidate) || !isRecord(candidate.metrics)) {
      continue;
    }
    const metrics = candidate.metrics;
    result[contractId] = {
      contractId,
      stars: Math.round(clampNumber(candidate.stars, 0, 3, 0)),
      metrics: {
        delivered: nonNegative(metrics.delivered),
        lost: nonNegative(metrics.lost),
        active: nonNegative(metrics.active),
        elapsedSeconds: nonNegative(metrics.elapsedSeconds),
        placedPieces: nonNegative(metrics.placedPieces),
      },
    };
  }
  return result;
}

function readSandbox(value: unknown, fallback: SandboxSave): SandboxSave {
  if (!isRecord(value) || !Array.isArray(value.machines)) return fallback;

  const machines = value.machines.filter(isMachineState);
  return {
    machines: structuredClone(machines),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : fallback.updatedAt,
  };
}

function isMachineState(value: unknown): value is MachineState {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    ['source', 'conveyor', 'receiver', 'spring'].includes(String(value.type)) &&
    Number.isFinite(value.gridX) &&
    Number.isFinite(value.gridY) &&
    Number.isFinite(value.angle) &&
    typeof value.reversed === 'boolean' &&
    typeof value.fixed === 'boolean'
  );
}

function isStableContractId(value: unknown): value is ContractId {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
  );
}

function nonNegative(value: unknown): number {
  return clampNumber(value, 0, Number.MAX_SAFE_INTEGER, 0);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
