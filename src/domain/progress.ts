import { CONTRACTS, getNextContractId, orderContracts } from './contracts';
import { createContractResult, evaluateRun } from './rules';
import type {
  ContractDefinition,
  ContractId,
  ContractResult,
  MachineState,
  ProgressSave,
  RunMetrics,
  SandboxSave,
  ScoreBreakdown,
} from './types';

export const PROGRESS_VERSION = 3 as const;
export const MAX_RANKING_RESULTS = 10;

export function createDefaultProgress(
  contracts: readonly ContractDefinition[] = CONTRACTS,
): ProgressSave {
  const firstContract = contracts.find(({ world, stage }) => world === 1 && stage === 1)?.id;
  return {
    version: PROGRESS_VERSION,
    unlockedContracts: firstContract ? [firstContract] : [],
    rankings: {},
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
  const firstContract = ordered.find(({ world, stage }) => world === 1 && stage === 1);
  if (firstContract) unlocked.add(firstContract.id);

  const rankings: ProgressSave['rankings'] = {};
  for (const contract of ordered) {
    const entries = progress.rankings[contract.id] ?? [];
    const currentRevisionEntries = entries.filter(
      (entry) =>
        entry.contractId === contract.id &&
        entry.contractRevision === contract.revision &&
        evaluateRun(entry.metrics, contract.goal).resolution === 'success',
    );
    const normalized = sortContractResults(currentRevisionEntries).slice(0, MAX_RANKING_RESULTS);
    if (normalized.length > 0) rankings[contract.id] = structuredClone(normalized);
  }

  // A newly registered immediate successor becomes available if the preceding
  // slot has already been completed. Missing slots never get skipped.
  let changed = true;
  while (changed) {
    changed = false;
    for (const contract of ordered) {
      if ((rankings[contract.id]?.length ?? 0) === 0) continue;
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
    rankings,
  };
}

export function applyContractResult(
  progress: ProgressSave,
  result: ContractResult,
  contracts: readonly ContractDefinition[] = CONTRACTS,
): ProgressSave {
  const contract = contracts.find(({ id }) => id === result.contractId);
  if (
    !contract ||
    result.contractRevision !== contract.revision ||
    evaluateRun(result.metrics, contract.goal).resolution !== 'success'
  ) {
    return reconcileProgress(progress, contracts);
  }

  const next = structuredClone(progress);
  next.rankings[result.contractId] = sortContractResults([
    ...(next.rankings[result.contractId] ?? []),
    structuredClone(result),
  ]).slice(0, MAX_RANKING_RESULTS);

  const nextContract = getNextContractId(result.contractId, contracts);
  if (nextContract && !next.unlockedContracts.includes(nextContract)) {
    next.unlockedContracts.push(nextContract);
  }

  return reconcileProgress(next, contracts);
}

export function clearContractRecord(progress: ProgressSave, contractId: ContractId): ProgressSave {
  const next = structuredClone(progress);
  delete next.rankings[contractId];
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

export function compareContractResults(left: ContractResult, right: ContractResult): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.metrics.collectedStars !== right.metrics.collectedStars) {
    return right.metrics.collectedStars - left.metrics.collectedStars;
  }
  if (left.metrics.lost !== right.metrics.lost) return left.metrics.lost - right.metrics.lost;
  if (left.metrics.placedPieces !== right.metrics.placedPieces) {
    return left.metrics.placedPieces - right.metrics.placedPieces;
  }
  if (left.metrics.elapsedSeconds !== right.metrics.elapsedSeconds) {
    return left.metrics.elapsedSeconds - right.metrics.elapsedSeconds;
  }
  return left.completedAt.localeCompare(right.completedAt);
}

export function sortContractResults(results: readonly ContractResult[]): ContractResult[] {
  return [...results].sort(compareContractResults);
}

export function isBetterResult(candidate: ContractResult, current: ContractResult): boolean {
  return compareContractResults(candidate, current) < 0;
}

export function getContractRanking(
  progress: ProgressSave,
  contractId: ContractId,
): readonly ContractResult[] {
  return progress.rankings[contractId] ?? [];
}

export function getBestContractResult(
  progress: ProgressSave,
  contractId: ContractId,
): ContractResult | undefined {
  return getContractRanking(progress, contractId)[0];
}

export function getContractResultPosition(
  progress: ProgressSave,
  result: Pick<ContractResult, 'contractId' | 'completedAt'>,
): number | undefined {
  const index = getContractRanking(progress, result.contractId).findIndex(
    ({ completedAt }) => completedAt === result.completedAt,
  );
  return index >= 0 ? index + 1 : undefined;
}

function migrateProgress(
  candidate: Record<string, unknown>,
  contracts: readonly ContractDefinition[],
): ProgressSave {
  const defaults = createDefaultProgress(contracts);
  const settings = isRecord(candidate.settings) ? candidate.settings : {};
  const progress: ProgressSave = {
    version: PROGRESS_VERSION,
    unlockedContracts: readUnlocked(candidate.unlockedContracts),
    rankings:
      candidate.version === PROGRESS_VERSION
        ? readRankings(candidate.rankings, contracts)
        : migrateBestResults(candidate.bestResults, contracts),
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

function readRankings(
  value: unknown,
  contracts: readonly ContractDefinition[],
): ProgressSave['rankings'] {
  if (!isRecord(value)) return {};
  const contractById = new Map(contracts.map((contract) => [contract.id, contract]));
  const rankings: ProgressSave['rankings'] = {};
  for (const [contractId, entries] of Object.entries(value)) {
    const contract = contractById.get(contractId);
    if (!contract || !Array.isArray(entries)) continue;
    const validEntries = entries
      .map((entry) => readContractResult(entry, contract))
      .filter((entry): entry is ContractResult => entry !== undefined);
    if (validEntries.length > 0) {
      rankings[contractId] = sortContractResults(validEntries).slice(0, MAX_RANKING_RESULTS);
    }
  }
  return rankings;
}

function migrateBestResults(
  value: unknown,
  contracts: readonly ContractDefinition[],
): ProgressSave['rankings'] {
  if (!isRecord(value)) return {};
  const rankings: ProgressSave['rankings'] = {};
  for (const contract of contracts) {
    const candidate = value[contract.id];
    if (!isRecord(candidate) || !isRecord(candidate.metrics)) continue;
    const metrics = readLegacyMetrics(candidate.metrics);
    if (!metrics || evaluateRun(metrics, contract.goal).resolution !== 'success') continue;
    const completedAt = isIsoTimestamp(candidate.completedAt)
      ? candidate.completedAt
      : new Date(0).toISOString();
    rankings[contract.id] = [createContractResult(contract, metrics, completedAt)];
  }
  return rankings;
}

function readContractResult(
  value: unknown,
  contract: ContractDefinition,
): ContractResult | undefined {
  if (
    !isRecord(value) ||
    value.contractId !== contract.id ||
    value.contractRevision !== contract.revision ||
    !Number.isFinite(value.score) ||
    !isRecord(value.breakdown) ||
    !isRecord(value.metrics) ||
    !isIsoTimestamp(value.completedAt)
  ) {
    return undefined;
  }
  const metrics = readMetrics(value.metrics);
  const breakdown = readScoreBreakdown(value.breakdown);
  if (!metrics || !breakdown || evaluateRun(metrics, contract.goal).resolution !== 'success') {
    return undefined;
  }
  return {
    contractId: contract.id,
    contractRevision: contract.revision,
    score: Math.round(nonNegative(value.score)),
    breakdown,
    metrics,
    completedAt: value.completedAt,
  };
}

function readLegacyMetrics(value: Record<string, unknown>): RunMetrics | undefined {
  if (
    !hasFiniteNumber(value, 'delivered') ||
    !hasFiniteNumber(value, 'lost') ||
    !hasFiniteNumber(value, 'active') ||
    !hasFiniteNumber(value, 'elapsedSeconds') ||
    !hasFiniteNumber(value, 'placedPieces')
  ) {
    return undefined;
  }
  return {
    delivered: nonNegative(value.delivered),
    lost: nonNegative(value.lost),
    active: nonNegative(value.active),
    elapsedSeconds: nonNegative(value.elapsedSeconds),
    placedPieces: nonNegative(value.placedPieces),
    collectedStars: 0,
  };
}

function readMetrics(value: Record<string, unknown>): RunMetrics | undefined {
  const legacy = readLegacyMetrics(value);
  if (!legacy || !hasFiniteNumber(value, 'collectedStars')) return undefined;
  legacy.collectedStars = Math.round(nonNegative(value.collectedStars));
  return legacy;
}

function readScoreBreakdown(value: Record<string, unknown>): ScoreBreakdown | undefined {
  const keys = [
    'deliveryPoints',
    'timeBonus',
    'efficiencyBonus',
    'starBonus',
    'lossPenalty',
  ] as const;
  if (!keys.every((key) => hasFiniteNumber(value, key))) return undefined;
  return {
    deliveryPoints: Math.round(nonNegative(value.deliveryPoints)),
    timeBonus: Math.round(nonNegative(value.timeBonus)),
    efficiencyBonus: Math.round(nonNegative(value.efficiencyBonus)),
    starBonus: Math.round(nonNegative(value.starBonus)),
    lossPenalty: Math.round(nonNegative(value.lossPenalty)),
  };
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
    ['source', 'conveyor', 'tracked-conveyor', 'receiver', 'spring'].includes(
      String(value.type),
    ) &&
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

function hasFiniteNumber(
  value: Record<string, unknown>,
  key: string,
): value is Record<string, unknown> & Record<typeof key, number> {
  return typeof value[key] === 'number' && Number.isFinite(value[key]);
}

function nonNegative(value: unknown): number {
  return clampNumber(value, 0, Number.MAX_SAFE_INTEGER, 0);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
