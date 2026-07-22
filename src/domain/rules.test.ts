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
    const goal = getContract('assembly-line').goal;
    expect(evaluateRun(metrics({ delivered: 8, lost: 4 }), goal)).toEqual({
      resolution: 'success',
      reason: 'deliveries',
    });
  });

  it('falha apenas quando ultrapassa o máximo de perdas', () => {
    const goal = getContract('assembly-line').goal;
    expect(evaluateRun(metrics({ lost: 3 }), goal).resolution).toBeUndefined();
    expect(evaluateRun(metrics({ lost: 4 }), goal)).toEqual({
      resolution: 'failure',
      reason: 'losses',
    });
  });

  it('falha quando o limite de tempo termina sem concluir', () => {
    const goal = getContract('final-inspection').goal;
    expect(evaluateRun(metrics({ elapsedSeconds: 41.99 }), goal).resolution).toBeUndefined();
    expect(evaluateRun(metrics({ elapsedSeconds: 42 }), goal)).toEqual({
      resolution: 'failure',
      reason: 'time',
    });
  });

  it('calcula entregas, tempo, eficiência, estrelas e perdas', () => {
    const contract = structuredClone(getContract('assembly-line'));
    contract.goal.idealTimeSeconds = 18;
    const calculation = calculateScore(
      contract,
      metrics({
        delivered: 12,
        lost: 1,
        elapsedSeconds: 18,
        placedPieces: 3,
        collectedStars: 2,
      }),
    );

    expect(calculation).toEqual({
      score: 107_500,
      breakdown: {
        deliveryPoints: 80_000,
        timeBonus: 20_000,
        efficiencyBonus: 2_500,
        starBonus: 10_000,
        lossPenalty: 5_000,
      },
    });
  });

  it('usa o tempo ideal automático e zera eficiência quando o limite é zero', () => {
    const contract = structuredClone(getContract('assembly-line'));
    delete contract.goal.idealTimeSeconds;
    contract.goal.pieceBudget = 0;
    contract.spawnIntervalSeconds = 1;

    expect(
      calculateScore(contract, metrics({ delivered: 8, elapsedSeconds: 16, placedPieces: 0 }))
        .breakdown,
    ).toMatchObject({ timeBonus: 20_000, efficiencyBonus: 0 });
  });

  it('não pontua derrotas e cria o resultado com revisão e data', () => {
    const contract = getContract('assembly-line');
    expect(calculateScore(contract, metrics({ delivered: 7 })).score).toBe(0);

    const result = createContractResult(
      contract,
      metrics({ delivered: 8 }),
      '2026-07-22T10:00:00.000Z',
    );
    expect(result).toMatchObject({
      contractId: contract.id,
      contractRevision: contract.revision,
      completedAt: '2026-07-22T10:00:00.000Z',
    });
  });

  it('impede a próxima colocação ao atingir o limite de peças', () => {
    const goal = getContract('assembly-line').goal;
    expect(isWithinPieceBudget(3, goal)).toBe(true);
    expect(isWithinPieceBudget(4, goal)).toBe(false);
  });
});
