import { describe, expect, it } from 'vitest';

import { getContract } from './contracts';
import { evaluateRun, isWithinBudget } from './rules';
import type { RunMetrics } from './types';

const metrics = (overrides: Partial<RunMetrics> = {}): RunMetrics => ({
  delivered: 0,
  lost: 0,
  active: 0,
  placedPieces: 0,
  collectedStars: 0,
  ...overrides,
  spent: overrides.spent ?? 0,
});

describe('regras de execução', () => {
  it('vence com as entregas e o gasto dentro do orçamento, sem exigir estrelas', () => {
    const contract = getContract('assembly-line');
    const budgetLimit = contract.economy.budgetLimit;

    expect(
      evaluateRun(
        metrics({
          delivered: contract.goal.deliveries,
          collectedStars: 0,
          spent: budgetLimit,
        }),
        contract.goal,
        budgetLimit,
      ),
    ).toEqual({ resolution: 'success', reason: 'deliveries' });
  });

  it('reprova automaticamente quando a meta é atingida acima do orçamento', () => {
    const contract = getContract('quality-curve');
    const budgetLimit = contract.economy.budgetLimit!;
    const completedDeliveries = metrics({
      delivered: contract.goal.deliveries,
      collectedStars: 0,
      spent: budgetLimit,
    });

    expect(
      evaluateRun({ ...completedDeliveries, spent: budgetLimit + 1 }, contract.goal, budgetLimit),
    ).toEqual({ resolution: 'failure', reason: 'budget' });
  });

  it('aceita qualquer gasto quando a fase não tem orçamento', () => {
    const contract = getContract('assembly-line');
    expect(
      evaluateRun(
        metrics({
          delivered: contract.goal.deliveries,
          spent: 999_999_999,
        }),
        contract.goal,
      ),
    ).toEqual({ resolution: 'success', reason: 'deliveries' });
  });

  it('falha apenas ao ultrapassar perdas configuradas e ignora perdas sem limite', () => {
    const contract = getContract('assembly-line');
    expect(
      evaluateRun(metrics({ lost: contract.goal.maxLosses }), contract.goal).resolution,
    ).toBeUndefined();
    expect(evaluateRun(metrics({ lost: contract.goal.maxLosses! + 1 }), contract.goal)).toEqual({
      resolution: 'failure',
      reason: 'losses',
    });

    expect(evaluateRun(metrics({ lost: 100 }), { deliveries: 8 }).resolution).toBeUndefined();
  });

  it('prioriza uma conclusão completa sobre perdas no mesmo tick', () => {
    const contract = getContract('assembly-line');
    expect(
      evaluateRun(
        metrics({
          delivered: contract.goal.deliveries,
          spent: contract.economy.budgetLimit,
          lost: contract.goal.maxLosses! + 1,
        }),
        contract.goal,
        contract.economy.budgetLimit,
      ),
    ).toEqual({ resolution: 'success', reason: 'deliveries' });
  });

  it('considera a igualdade dentro do orçamento e ausência de limite como ilimitada', () => {
    expect(isWithinBudget(10_000, 10_000)).toBe(true);
    expect(isWithinBudget(10_001, 10_000)).toBe(false);
    expect(isWithinBudget(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
