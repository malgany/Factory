import type { ContractGoal, RunMetrics, SimulationStatus } from './types';

export type RunResolution = Extract<SimulationStatus, 'success' | 'failure'> | undefined;

export interface RuleEvaluation {
  resolution: RunResolution;
  reason?: 'deliveries' | 'losses';
}

/**
 * Evaluates terminal rules in deterministic priority order. A run that meets
 * every objective on the final tick wins before the optional loss limit is
 * considered.
 */
export function evaluateRun(
  metrics: RunMetrics,
  goal: ContractGoal,
  requiredStars: number,
  budgetLimit?: number,
): RuleEvaluation {
  const completedDeliveries = metrics.delivered >= goal.deliveries;
  const collectedEveryStar = metrics.collectedStars >= requiredStars;
  const respectedBudget = isWithinBudget(metrics.spent, budgetLimit);

  if (completedDeliveries && collectedEveryStar && respectedBudget) {
    return { resolution: 'success', reason: 'deliveries' };
  }

  if (goal.maxLosses !== undefined && metrics.lost > goal.maxLosses) {
    return { resolution: 'failure', reason: 'losses' };
  }

  return { resolution: undefined };
}

export function isWithinBudget(spent: number, budgetLimit?: number): boolean {
  return budgetLimit === undefined || spent <= budgetLimit;
}
