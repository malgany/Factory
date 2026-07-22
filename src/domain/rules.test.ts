import { describe, expect, it } from 'vitest';

import { getContract } from './contracts';
import { calculateScore, createContractResult, evaluateRun, isWithinPieceBudget } from './rules';
import type { RunMetrics } from './types';

const metrics = (overrides: Partial<RunMetrics> = {}): RunMetrics => ({
  delivered: 0,
  lost: 0,
  active: 0,
  elapsedSeconds: 0,
  placedPieces: 0,
  collectedStars: 0,
  ...overrides,
});

describe('regras de execução', () => {
  it('vence pela meta sem descontar perdas e prioriza a entrega no último tick', () => {
    const goal = getContract('first-flow').goal;
    expect(evaluateRun(metrics({ delivered: 10, lost: 4 }), goal)).toEqual({
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

  it('calcula entregas, tempo, eficiência, estrelas e perdas', () => {
    const contract = getContract('first-flow');
    const calculation = calculateScore(
      contract,
      metrics({
        delivered: 12,
        lost: 1,
        elapsedSeconds: 32,
        placedPieces: 6,
        collectedStars: 2,
      }),
    );

    expect(calculation).toEqual({
      score: 127_500,
      breakdown: {
        deliveryPoints: 100_000,
        timeBonus: 20_000,
        efficiencyBonus: 2_500,
        starBonus: 10_000,
        lossPenalty: 5_000,
      },
    });
  });

  it('usa o tempo ideal automático e zera eficiência quando o limite é zero', () => {
    const contract = structuredClone(getContract('first-flow'));
    delete contract.goal.idealTimeSeconds;
    contract.goal.pieceBudget = 0;
    contract.spawnIntervalSeconds = 1;

    expect(
      calculateScore(contract, metrics({ delivered: 10, elapsedSeconds: 20, placedPieces: 0 }))
        .breakdown,
    ).toMatchObject({ timeBonus: 20_000, efficiencyBonus: 0 });
  });

  it('não pontua derrotas e cria o resultado com revisão e data', () => {
    const contract = getContract('first-flow');
    expect(calculateScore(contract, metrics({ delivered: 9 })).score).toBe(0);

    const result = createContractResult(
      contract,
      metrics({ delivered: 10 }),
      '2026-07-22T10:00:00.000Z',
    );
    expect(result).toMatchObject({
      contractId: contract.id,
      contractRevision: contract.revision,
      completedAt: '2026-07-22T10:00:00.000Z',
    });
  });

  it('impede a próxima colocação ao atingir o limite de peças', () => {
    const goal = getContract('first-flow').goal;
    expect(isWithinPieceBudget(7, goal)).toBe(true);
    expect(isWithinPieceBudget(8, goal)).toBe(false);
  });
});
