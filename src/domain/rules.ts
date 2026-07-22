import type {
  ContractDefinition,
  ContractGoal,
  ContractResult,
  RunMetrics,
  ScoreBreakdown,
  SimulationStatus,
} from './types';

export type RunResolution = Extract<SimulationStatus, 'success' | 'failure'> | undefined;

export interface RuleEvaluation {
  resolution: RunResolution;
  reason?: 'deliveries' | 'losses' | 'time';
}

export interface ScoreCalculation {
  score: number;
  breakdown: ScoreBreakdown;
}

/**
 * Evaluates terminal rules in deterministic priority order. A delivery made on
 * the final tick wins before loss/time conditions are considered.
 */
export function evaluateRun(metrics: RunMetrics, goal: ContractGoal): RuleEvaluation {
  if (metrics.delivered >= goal.deliveries) {
    return { resolution: 'success', reason: 'deliveries' };
  }

  if (metrics.lost > goal.maxLosses) {
    return { resolution: 'failure', reason: 'losses' };
  }

  if (goal.timeLimitSeconds !== undefined && metrics.elapsedSeconds >= goal.timeLimitSeconds) {
    return { resolution: 'failure', reason: 'time' };
  }

  return { resolution: undefined };
}

export function isWithinPieceBudget(placedPieces: number, goal: ContractGoal): boolean {
  return placedPieces < goal.pieceBudget;
}

export function calculateScore(
  contract: Pick<ContractDefinition, 'goal' | 'spawnIntervalSeconds'>,
  metrics: RunMetrics,
): ScoreCalculation {
  if (evaluateRun(metrics, contract.goal).resolution !== 'success') {
    return {
      score: 0,
      breakdown: emptyScoreBreakdown(),
    };
  }

  const deliveryPoints = Math.round(
    Math.min(nonNegative(metrics.delivered), contract.goal.deliveries) * 10_000,
  );
  const idealTimeSeconds =
    contract.goal.idealTimeSeconds ?? contract.goal.deliveries * contract.spawnIntervalSeconds * 2;
  const timeBonus = Math.round(
    40_000 * 2 ** (-nonNegative(metrics.elapsedSeconds) / idealTimeSeconds),
  );
  const efficiencyBonus =
    contract.goal.pieceBudget === 0
      ? 0
      : Math.round(
          10_000 *
            clamp(
              (contract.goal.pieceBudget - nonNegative(metrics.placedPieces)) /
                contract.goal.pieceBudget,
              0,
              1,
            ),
        );
  const starBonus = Math.round(nonNegative(metrics.collectedStars)) * 5_000;
  const lossPenalty = Math.round(nonNegative(metrics.lost)) * 5_000;
  const breakdown: ScoreBreakdown = {
    deliveryPoints,
    timeBonus,
    efficiencyBonus,
    starBonus,
    lossPenalty,
  };

  return {
    score: Math.max(
      0,
      Math.round(deliveryPoints + timeBonus + efficiencyBonus + starBonus - lossPenalty),
    ),
    breakdown,
  };
}

export function createContractResult(
  contract: Pick<ContractDefinition, 'id' | 'revision' | 'goal' | 'spawnIntervalSeconds'>,
  metrics: RunMetrics,
  completedAt = new Date().toISOString(),
): ContractResult {
  const calculation = calculateScore(contract, metrics);
  return {
    contractId: contract.id,
    contractRevision: contract.revision,
    score: calculation.score,
    breakdown: calculation.breakdown,
    metrics: structuredClone(metrics),
    completedAt,
  };
}

function emptyScoreBreakdown(): ScoreBreakdown {
  return {
    deliveryPoints: 0,
    timeBonus: 0,
    efficiencyBonus: 0,
    starBonus: 0,
    lossPenalty: 0,
  };
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
