import type { ContractGoal, RunMetrics, SimulationStatus } from './types';

export type RunResolution = Extract<SimulationStatus, 'success' | 'failure'> | undefined;

export interface RuleEvaluation {
  resolution: RunResolution;
  reason?: 'deliveries' | 'losses' | 'budget';
}

/**
 * Evaluates terminal rules in deterministic priority order. Reaching the
 * delivery goal resolves immediately: within budget wins, over budget fails.
 * Stars remain collectible bonuses and do not participate in completion.
 */
export function evaluateRun(
  metrics: RunMetrics,
  goal: ContractGoal,
  budgetLimit?: number,
): RuleEvaluation {
  const completedDeliveries = metrics.delivered >= goal.deliveries;
  const respectedBudget = isWithinBudget(metrics.spent, budgetLimit);

  if (completedDeliveries) {
    return respectedBudget
      ? { resolution: 'success', reason: 'deliveries' }
      : { resolution: 'failure', reason: 'budget' };
  }

  if (goal.maxLosses !== undefined && metrics.lost > goal.maxLosses) {
    return { resolution: 'failure', reason: 'losses' };
  }

  return { resolution: undefined };
}

export function isWithinBudget(spent: number, budgetLimit?: number): boolean {
  return budgetLimit === undefined || spent <= budgetLimit;
}
