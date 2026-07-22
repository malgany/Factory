import { describe, expect, it } from 'vitest';

import { CONTRACTS, getContract } from './contracts';
import {
  applyContractResult,
  clearContractRecord,
  createDefaultProgress,
  getBestContractResult,
  getContractResultPosition,
  parseProgress,
  reconcileProgress,
  removeContractProgress,
  serializeProgress,
  updateSandbox,
} from './progress';
import { createContractResult } from './rules';
import type { ContractDefinition, ContractResult, MachineState, RunMetrics } from './types';

const metrics = (overrides: Partial<RunMetrics> = {}): RunMetrics => ({
  delivered: 10,
  lost: 0,
  active: 0,
  elapsedSeconds: 20,
  placedPieces: 6,
  collectedStars: 0,
  ...overrides,
});

const result = (
  contract: ContractDefinition,
  overrides: Partial<ContractResult> = {},
): ContractResult => ({
  ...createContractResult(
    contract,
    metrics({ delivered: contract.goal.deliveries }),
    '2026-07-22T10:00:00.000Z',
  ),
  ...overrides,
});

describe('persistência de progresso', () => {
  it('começa na versão 3 somente com a fase 1-1 disponível', () => {
    const progress = createDefaultProgress();
    expect(progress.version).toBe(3);
    expect(progress.unlockedContracts).toEqual(['first-flow']);
    expect(progress.rankings).toEqual({});
    expect(progress.sandbox.machines).toEqual([]);
  });

  it('recupera o default de dados ausentes ou corrompidos', () => {
    expect(parseProgress(null).unlockedContracts).toEqual(['first-flow']);
    expect(parseProgress('{quebrado').unlockedContracts).toEqual(['first-flow']);
  });

  it('preserva desbloqueios conhecidos sem preencher lacunas por ordem', () => {
    const migrated = parseProgress({
      version: 2,
      unlockedContracts: ['line-rhythm', 'inexistente'],
      settings: { muted: true, volume: 9 },
    });

    expect(migrated.version).toBe(3);
    expect(migrated.unlockedContracts).toEqual(['first-flow', 'line-rhythm']);
    expect(migrated.settings).toEqual({ muted: true, volume: 1 });
  });

  it('ignora derrotas e desbloqueia somente o slot imediatamente seguinte', () => {
    const first = getContract('first-flow');
    const initial = createDefaultProgress();
    const defeat = result(first, {
      metrics: metrics({ delivered: 9, lost: 4 }),
      score: 0,
    });
    expect(applyContractResult(initial, defeat).unlockedContracts).toEqual(['first-flow']);
    expect(applyContractResult(initial, defeat).rankings).toEqual({});

    const victory = result(first);
    const completed = applyContractResult(initial, victory);
    expect(completed.unlockedContracts).toEqual(['first-flow', 'controlled-jump']);
    expect(completed.rankings['first-flow']).toHaveLength(1);
    expect(initial.unlockedContracts).toEqual(['first-flow']);
  });

  it('ordena pelos desempates definidos e limita o ranking a dez tentativas', () => {
    const contract = getContract('first-flow');
    let progress = createDefaultProgress();
    const attempts = Array.from({ length: 12 }, (_, index) =>
      result(contract, {
        score: index < 2 ? 200_000 : 100_000 + index,
        completedAt: `2026-07-22T10:${String(index).padStart(2, '0')}:00.000Z`,
        metrics: metrics({
          collectedStars: index === 0 ? 1 : 2,
          lost: index === 1 ? 1 : 0,
          placedPieces: 6,
          elapsedSeconds: 20,
        }),
      }),
    );
    for (const attempt of attempts) progress = applyContractResult(progress, attempt);

    const ranking = progress.rankings[contract.id]!;
    expect(ranking).toHaveLength(10);
    expect(ranking[0]).toMatchObject({ score: 200_000, completedAt: attempts[1]!.completedAt });
    expect(getBestContractResult(progress, contract.id)).toEqual(ranking[0]);
    expect(getContractResultPosition(progress, ranking[0]!)).toBe(1);
    expect(getContractResultPosition(progress, attempts[0]!)).toBe(2);
  });

  it('aplica todos os desempates antes da data de conclusão', () => {
    const contract = getContract('first-flow');
    const base = result(contract, { score: 150_000 });
    const candidates = [
      { ...base, completedAt: '2026-07-22T10:05:00.000Z' },
      {
        ...base,
        metrics: metrics({ collectedStars: 1 }),
        completedAt: '2026-07-22T10:04:00.000Z',
      },
      {
        ...base,
        metrics: metrics({ collectedStars: 2, lost: 1 }),
        completedAt: '2026-07-22T10:03:00.000Z',
      },
      {
        ...base,
        metrics: metrics({ collectedStars: 2, lost: 0, placedPieces: 7 }),
        completedAt: '2026-07-22T10:02:00.000Z',
      },
      {
        ...base,
        metrics: metrics({ collectedStars: 2, lost: 0, placedPieces: 6, elapsedSeconds: 21 }),
        completedAt: '2026-07-22T10:01:00.000Z',
      },
      {
        ...base,
        metrics: metrics({ collectedStars: 2, lost: 0, placedPieces: 6, elapsedSeconds: 20 }),
        completedAt: '2026-07-22T10:06:00.000Z',
      },
      {
        ...base,
        metrics: metrics({ collectedStars: 2, lost: 0, placedPieces: 6, elapsedSeconds: 20 }),
        completedAt: '2026-07-22T10:00:00.000Z',
      },
    ];
    let progress = createDefaultProgress();
    for (const candidate of candidates) progress = applyContractResult(progress, candidate);
    expect(progress.rankings[contract.id]?.map(({ completedAt }) => completedAt)).toEqual([
      '2026-07-22T10:00:00.000Z',
      '2026-07-22T10:06:00.000Z',
      '2026-07-22T10:01:00.000Z',
      '2026-07-22T10:02:00.000Z',
      '2026-07-22T10:03:00.000Z',
      '2026-07-22T10:04:00.000Z',
      '2026-07-22T10:05:00.000Z',
    ]);
  });

  it('migra um melhor resultado v2 quando as métricas formam uma vitória', () => {
    const migrated = parseProgress({
      version: 2,
      unlockedContracts: ['first-flow'],
      bestResults: {
        'first-flow': {
          contractId: 'first-flow',
          stars: 3,
          metrics: metrics({ collectedStars: undefined }),
        },
      },
    });

    const migratedResult = migrated.rankings['first-flow']?.[0];
    expect(migratedResult).toMatchObject({
      contractId: 'first-flow',
      contractRevision: 1,
      completedAt: '1970-01-01T00:00:00.000Z',
      metrics: { collectedStars: 0 },
    });
    expect(migratedResult?.score).toBeGreaterThan(0);
  });

  it('libera fase cadastrada depois somente quando ela ocupa o próximo slot', () => {
    const third = getContract('line-rhythm');
    const completedThird = applyContractResult(createDefaultProgress(), result(third), CONTRACTS);
    const fourth: ContractDefinition = {
      ...structuredClone(CONTRACTS[0]!),
      id: 'custom-fourth',
      stage: 4,
      order: 4,
      title: '4-1',
    };
    const fifth: ContractDefinition = {
      ...structuredClone(fourth),
      id: 'custom-fifth',
      stage: 5,
      order: 5,
      title: '5-1',
    };

    expect(
      reconcileProgress(completedThird, [...CONTRACTS, fifth]).unlockedContracts,
    ).not.toContain(fifth.id);
    expect(
      reconcileProgress(completedThird, [...CONTRACTS, fourth, fifth]).unlockedContracts,
    ).toContain(fourth.id);
  });

  it('limpa ranking por revisão sem revogar fases já desbloqueadas', () => {
    const first = getContract('first-flow');
    let progress = applyContractResult(createDefaultProgress(), result(first));
    progress = clearContractRecord(progress, first.id);
    expect(progress.rankings[first.id]).toBeUndefined();
    expect(progress.unlockedContracts).toContain('controlled-jump');

    progress = applyContractResult(progress, result(first));
    const edited = { ...structuredClone(first), revision: first.revision + 1 };
    progress = reconcileProgress(progress, [edited, ...CONTRACTS.slice(1)]);
    expect(progress.rankings[first.id]).toBeUndefined();
    expect(progress.unlockedContracts).toContain('controlled-jump');
  });

  it('remove progresso da fase excluída e salva o layout do sandbox', () => {
    const first = getContract('first-flow');
    let progress = applyContractResult(createDefaultProgress(), result(first));
    progress = removeContractProgress(progress, 'controlled-jump', [CONTRACTS[0]!, CONTRACTS[2]!]);
    expect(progress.unlockedContracts).not.toContain('controlled-jump');

    const machine: MachineState = {
      id: 'spring-1',
      type: 'spring',
      gridX: 4,
      gridY: 6,
      angle: 37,
      reversed: false,
      fixed: false,
    };
    const saved = updateSandbox(progress, [machine], '2026-07-19T00:00:00.000Z');
    expect(parseProgress(serializeProgress(saved)).sandbox).toEqual({
      machines: [machine],
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
  });
});
