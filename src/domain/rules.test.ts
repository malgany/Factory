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
  it('vence somente com entregas, todas as estrelas e gasto dentro do orçamento', () => {
    const contract = getContract('assembly-line');
    const requiredStars = contract.collectibles.length;
    const budgetLimit = contract.economy.budgetLimit;

    expect(
      evaluateRun(
        metrics({
          delivered: contract.goal.deliveries,
          collectedStars: requiredStars,
          spent: budgetLimit,
        }),
        contract.goal,
        requiredStars,
        budgetLimit,
      ),
    ).toEqual({ resolution: 'success', reason: 'deliveries' });
  });

  it('não conclui enquanto faltar estrela ou o orçamento nominal estiver excedido', () => {
    const contract = getContract('quality-curve');
    const requiredStars = contract.collectibles.length;
    const budgetLimit = contract.economy.budgetLimit!;
    const completedDeliveries = metrics({
      delivered: contract.goal.deliveries,
      collectedStars: requiredStars,
      spent: budgetLimit,
    });

    expect(
      evaluateRun(
        { ...completedDeliveries, collectedStars: requiredStars - 1 },
        contract.goal,
        requiredStars,
        budgetLimit,
      ).resolution,
    ).toBeUndefined();
    expect(
      evaluateRun(
        { ...completedDeliveries, spent: budgetLimit + 1 },
        contract.goal,
        requiredStars,
        budgetLimit,
      ).resolution,
    ).toBeUndefined();
  });

  it('aceita qualquer gasto quando a fase não tem orçamento', () => {
    const contract = getContract('assembly-line');
    expect(
      evaluateRun(
        metrics({
          delivered: contract.goal.deliveries,
          collectedStars: contract.collectibles.length,
          spent: 999_999_999,
        }),
        contract.goal,
        contract.collectibles.length,
      ),
    ).toEqual({ resolution: 'success', reason: 'deliveries' });
  });

  it('falha apenas ao ultrapassar perdas configuradas e ignora perdas sem limite', () => {
    const contract = getContract('assembly-line');
    expect(
      evaluateRun(metrics({ lost: contract.goal.maxLosses }), contract.goal, 1).resolution,
    ).toBeUndefined();
    expect(evaluateRun(metrics({ lost: contract.goal.maxLosses! + 1 }), contract.goal, 1)).toEqual({
      resolution: 'failure',
      reason: 'losses',
    });

    expect(evaluateRun(metrics({ lost: 100 }), { deliveries: 8 }, 1).resolution).toBeUndefined();
  });

  it('prioriza uma conclusão completa sobre perdas no mesmo tick', () => {
    const contract = getContract('assembly-line');
    expect(
      evaluateRun(
        metrics({
          delivered: contract.goal.deliveries,
          collectedStars: contract.collectibles.length,
          spent: contract.economy.budgetLimit,
          lost: contract.goal.maxLosses! + 1,
        }),
        contract.goal,
        contract.collectibles.length,
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
