import type { ContractDefinition, ContractGoal, RunMetrics, SimulationStatus } from './types';

export type RunResolution = Extract<SimulationStatus, 'success' | 'failure'> | undefined;

export interface RuleEvaluation {
  resolution: RunResolution;
  reason?: 'deliveries' | 'losses' | 'time';
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

export function calculateStars(
  contract: Pick<ContractDefinition, 'goal'>,
  metrics: RunMetrics,
): number {
  if (evaluateRun(metrics, contract.goal).resolution !== 'success') {
    return 0;
  }

  let stars = 1;
  if (metrics.lost === 0) {
    stars += 1;
  }

  const withinPiecePar = metrics.placedPieces <= contract.goal.parPieces;
  const withinTimePar =
    contract.goal.parTimeSeconds === undefined ||
    metrics.elapsedSeconds <= contract.goal.parTimeSeconds;

  if (withinPiecePar && withinTimePar) {
    stars += 1;
  }

  return stars;
}
