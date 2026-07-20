import { describe, expect, it } from 'vitest';

import { getContract } from './contracts';
import { calculateStars, evaluateRun, isWithinPieceBudget } from './rules';
import type { RunMetrics } from './types';

const metrics = (overrides: Partial<RunMetrics> = {}): RunMetrics => ({
  delivered: 0,
  lost: 0,
  active: 0,
  elapsedSeconds: 0,
  placedPieces: 0,
  ...overrides,
});

describe('regras de execução', () => {
  it('vence ao atingir a quantidade entregue', () => {
    const goal = getContract('first-flow').goal;
    expect(evaluateRun(metrics({ delivered: 10 }), goal)).toEqual({
      resolution: 'success',
      reason: 'deliveries',
    });
  });

  it('falha apenas quando ultrapassa o máximo de perdas', () => {
    const goal = getContract('first-flow').goal;
    expect(evaluateRun(metrics({ lost: 3 }), goal).resolution).toBeUndefined();
    expect(evaluateRun(metrics({ lost: 4 }), goal)).toEqual({
      resolution: 'failure',
      reason: 'losses',
    });
  });

  it('falha quando o limite de tempo termina sem concluir', () => {
    const goal = getContract('line-rhythm').goal;
    expect(evaluateRun(metrics({ elapsedSeconds: 44.99 }), goal).resolution).toBeUndefined();
    expect(evaluateRun(metrics({ elapsedSeconds: 45 }), goal)).toEqual({
      resolution: 'failure',
      reason: 'time',
    });
  });

  it('calcula até três estrelas por conclusão, zero perdas e par', () => {
    const contract = getContract('first-flow');
    expect(
      calculateStars(
        contract,
        metrics({ delivered: 10, lost: 0, placedPieces: 7, elapsedSeconds: 31 }),
      ),
    ).toBe(3);
    expect(
      calculateStars(
        contract,
        metrics({ delivered: 10, lost: 1, placedPieces: 8, elapsedSeconds: 33 }),
      ),
    ).toBe(1);
    expect(calculateStars(contract, metrics({ delivered: 9 }))).toBe(0);
  });

  it('impede a próxima colocação ao atingir o orçamento', () => {
    const goal = getContract('first-flow').goal;
    expect(isWithinPieceBudget(7, goal)).toBe(true);
    expect(isWithinPieceBudget(8, goal)).toBe(false);
  });
});
