import { describe, expect, it } from 'vitest';

import {
  applyContractResult,
  clearContractRecord,
  createDefaultProgress,
  parseProgress,
  reconcileProgress,
  removeContractProgress,
  serializeProgress,
  updateSandbox,
} from './progress';
import type { ContractResult, MachineState } from './types';
import { CONTRACTS } from './contracts';

const result = (
  contractId: ContractResult['contractId'],
  stars: number,
  elapsedSeconds = 20,
): ContractResult => ({
  contractId,
  stars,
  metrics: {
    delivered: 10,
    lost: 0,
    active: 0,
    elapsedSeconds,
    placedPieces: 6,
  },
});

describe('persistência de progresso', () => {
  it('começa com a primeira fase e sandbox disponíveis', () => {
    const progress = createDefaultProgress();
    expect(progress.version).toBe(2);
    expect(progress.unlockedContracts).toEqual(['first-flow']);
    expect(progress.sandbox.machines).toEqual([]);
  });

  it('recupera o default de dados ausentes ou corrompidos', () => {
    expect(parseProgress(null).unlockedContracts).toEqual(['first-flow']);
    expect(parseProgress('{quebrado').unlockedContracts).toEqual(['first-flow']);
  });

  it('normaliza saves antigos, limites e lacunas de desbloqueio', () => {
    const migrated = parseProgress({
      unlockedContracts: ['line-rhythm', 'inexistente'],
      settings: { muted: true, volume: 9 },
    });

    expect(migrated.version).toBe(2);
    expect(migrated.unlockedContracts).toEqual(['first-flow', 'controlled-jump', 'line-rhythm']);
    expect(migrated.settings).toEqual({ muted: true, volume: 1 });
  });

  it('desbloqueia somente a próxima fase após uma vitória', () => {
    const initial = createDefaultProgress();
    expect(applyContractResult(initial, result('first-flow', 0)).unlockedContracts).toEqual([
      'first-flow',
    ]);
    expect(applyContractResult(initial, result('first-flow', 2)).unlockedContracts).toEqual([
      'first-flow',
      'controlled-jump',
    ]);
    expect(initial.unlockedContracts).toEqual(['first-flow']);
  });

  it('preserva o melhor resultado', () => {
    let progress = applyContractResult(createDefaultProgress(), result('first-flow', 3, 20));
    progress = applyContractResult(progress, result('first-flow', 2, 10));
    expect(progress.bestResults['first-flow']?.stars).toBe(3);

    progress = applyContractResult(progress, result('first-flow', 3, 18));
    expect(progress.bestResults['first-flow']?.metrics.elapsedSeconds).toBe(18);
  });

  it('salva e restaura o layout do sandbox', () => {
    const machine: MachineState = {
      id: 'spring-1',
      type: 'spring',
      gridX: 4,
      gridY: 6,
      angle: 37,
      reversed: false,
      fixed: false,
    };
    const saved = updateSandbox(createDefaultProgress(), [machine], '2026-07-19T00:00:00.000Z');
    const restored = parseProgress(serializeProgress(saved));

    expect(restored.sandbox).toEqual({
      machines: [machine],
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
  });

  it('migra e preserva IDs dinâmicos quando o catálogo ativo é informado', () => {
    const custom = {
      ...structuredClone(CONTRACTS[0]!),
      id: 'custom-1234',
      order: 4,
      title: 'Minha fase',
    };
    const contracts = [...CONTRACTS, custom];
    const migrated = parseProgress(
      {
        version: 1,
        unlockedContracts: ['line-rhythm', custom.id],
        bestResults: {
          [custom.id]: result(custom.id, 2),
        },
        settings: { muted: false, volume: 0.4 },
      },
      contracts,
    );

    expect(migrated.version).toBe(2);
    expect(migrated.unlockedContracts).toEqual(contracts.map(({ id }) => id));
    expect(migrated.bestResults[custom.id]?.stars).toBe(2);
  });

  it('libera fase nova se a anterior já foi concluída', () => {
    const completed = applyContractResult(
      createDefaultProgress(),
      result('line-rhythm', 2),
      CONTRACTS,
    );
    const custom = {
      ...structuredClone(CONTRACTS[0]!),
      id: 'custom-next',
      order: 4,
    };
    const reconciled = reconcileProgress(completed, [...CONTRACTS, custom]);

    expect(reconciled.unlockedContracts).toContain(custom.id);
  });

  it('limpa um recorde sem relocar fases já desbloqueadas e remove fase excluída', () => {
    const contracts = CONTRACTS;
    let progress = applyContractResult(createDefaultProgress(), result('first-flow', 3), contracts);
    progress = clearContractRecord(progress, 'first-flow');
    expect(progress.bestResults['first-flow']).toBeUndefined();
    expect(progress.unlockedContracts).toContain('controlled-jump');

    progress = removeContractProgress(progress, 'controlled-jump', [contracts[0]!, contracts[2]!]);
    expect(progress.unlockedContracts).not.toContain('controlled-jump');
  });
});
