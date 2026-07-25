import { describe, expect, it } from 'vitest';

import { CONTRACTS, getContract } from './contracts';
import {
  clearContractCompletion,
  completeContract,
  createDefaultProgress,
  isContractCompleted,
  parseProgress,
  reconcileProgress,
  removeContractProgress,
  serializeProgress,
  updateCampaignLayout,
  updateSandbox,
} from './progress';
import type { ContractDefinition, MachineState } from './types';

describe('persistência de progresso', () => {
  it('começa na versão 4 somente com a fase 1-1 disponível', () => {
    const progress = createDefaultProgress();
    expect(progress.version).toBe(5);
    expect(progress.unlockedContracts).toEqual(['assembly-line']);
    expect(progress.completedContracts).toEqual({});
    expect(progress.sandbox.machines).toEqual([]);
  });

  it('recupera o default de dados ausentes ou corrompidos', () => {
    expect(parseProgress(null).unlockedContracts).toEqual(['assembly-line']);
    expect(parseProgress('{quebrado').unlockedContracts).toEqual(['assembly-line']);
  });

  it('reinicia a campanha antiga e preserva configurações e sandbox', () => {
    const machine: MachineState = {
      id: 'spring-legacy',
      type: 'spring',
      gridX: 4,
      gridY: 6,
      angle: 37,
      reversed: false,
      fixed: false,
    };
    const migrated = parseProgress({
      version: 3,
      unlockedContracts: CONTRACTS.map(({ id }) => id),
      rankings: { 'assembly-line': [{ score: 999_999 }] },
      settings: { muted: true, volume: 9 },
      sandbox: {
        machines: [machine],
        updatedAt: '2026-07-19T00:00:00.000Z',
      },
    });

    expect(migrated.version).toBe(5);
    expect(migrated.unlockedContracts).toEqual(['assembly-line']);
    expect(migrated.completedContracts).toEqual({});
    expect(migrated.settings).toEqual({ muted: true, volume: 1 });
    expect(migrated.sandbox).toEqual({
      machines: [machine],
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
  });

  it('descarta também conclusões e desbloqueios da versão 2', () => {
    const migrated = parseProgress({
      version: 2,
      unlockedContracts: ['first-jump'],
      bestResults: { 'assembly-line': { stars: 3 } },
    });

    expect(migrated.unlockedContracts).toEqual(['assembly-line']);
    expect(migrated.completedContracts).toEqual({});
  });

  it('migra esteiras antigas para velocidade normal e preserva o nível escolhido', () => {
    const legacyConveyor: MachineState = {
      id: 'legacy-conveyor',
      type: 'tracked-conveyor',
      gridX: 8,
      gridY: 6,
      angle: 0,
      reversed: false,
      fixed: false,
    };
    const migrated = parseProgress({
      version: 4,
      unlockedContracts: ['assembly-line'],
      completedContracts: {},
      settings: { muted: false, volume: 0.65 },
      sandbox: {
        machines: [legacyConveyor],
        updatedAt: '2026-07-19T00:00:00.000Z',
      },
    });
    expect(migrated.sandbox.machines[0]?.conveyorSpeed).toBe('normal');

    migrated.sandbox.machines[0]!.conveyorSpeed = 'fast';
    expect(parseProgress(serializeProgress(migrated)).sandbox.machines[0]?.conveyorSpeed).toBe(
      'fast',
    );
  });

  it('registra a revisão concluída e desbloqueia somente o próximo slot', () => {
    const first = getContract('assembly-line');
    const initial = createDefaultProgress();

    expect(completeContract(initial, first.id, first.revision + 1).unlockedContracts).toEqual([
      'assembly-line',
    ]);

    const completed = completeContract(initial, first.id, first.revision);
    expect(completed.unlockedContracts).toEqual(['assembly-line', 'quality-curve']);
    expect(completed.completedContracts).toEqual({ 'assembly-line': first.revision });
    expect(isContractCompleted(completed, first)).toBe(true);
    expect(initial.unlockedContracts).toEqual(['assembly-line']);
  });

  it('reconcilia somente IDs e revisões atuais sem preencher lacunas', () => {
    const first = getContract('assembly-line');
    const third = getContract('first-jump');
    const reconciled = parseProgress({
      version: 4,
      unlockedContracts: ['first-jump', 'inexistente'],
      completedContracts: {
        [first.id]: first.revision,
        [third.id]: third.revision + 1,
        inexistente: 1,
      },
      settings: { muted: false, volume: 0.5 },
    });

    expect(reconciled.unlockedContracts).toEqual(['assembly-line', 'quality-curve', 'first-jump']);
    expect(reconciled.completedContracts).toEqual({ [first.id]: first.revision });
  });

  it('libera fase cadastrada depois somente quando ela ocupa o próximo slot', () => {
    const third = getContract('first-jump');
    const firstThree = CONTRACTS.filter(({ world, stage }) => world === 1 && stage <= 3);
    const completedThird = completeContract(
      createDefaultProgress(firstThree),
      third.id,
      third.revision,
      firstThree,
    );
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
      reconcileProgress(completedThird, [...firstThree, fifth]).unlockedContracts,
    ).not.toContain(fifth.id);
    expect(
      reconcileProgress(completedThird, [...firstThree, fourth, fifth]).unlockedContracts,
    ).toContain(fourth.id);
  });

  it('limpa conclusão por revisão sem revogar fases já desbloqueadas', () => {
    const first = getContract('assembly-line');
    let progress = completeContract(createDefaultProgress(), first.id, first.revision);
    progress = clearContractCompletion(progress, first.id);
    expect(progress.completedContracts[first.id]).toBeUndefined();
    expect(progress.unlockedContracts).toContain('quality-curve');

    progress = completeContract(progress, first.id, first.revision);
    const edited = { ...structuredClone(first), revision: first.revision + 1 };
    progress = reconcileProgress(progress, [edited, ...CONTRACTS.slice(1)]);
    expect(progress.completedContracts[first.id]).toBeUndefined();
    expect(progress.unlockedContracts).toContain('quality-curve');
  });

  it('remove progresso da fase excluída e salva o layout do sandbox', () => {
    const first = getContract('assembly-line');
    let progress = completeContract(createDefaultProgress(), first.id, first.revision);
    progress = removeContractProgress(progress, 'quality-curve', [CONTRACTS[0]!, CONTRACTS[2]!]);
    expect(progress.unlockedContracts).not.toContain('quality-curve');

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

  it('persists the last campaign layout and discards stale revisions', () => {
    const contract = getContract('assembly-line');
    const machine: MachineState = {
      id: 'saved-spring',
      type: 'spring',
      gridX: 10,
      gridY: 7,
      angle: 25,
      reversed: false,
      fixed: false,
    };
    const saved = updateCampaignLayout(
      createDefaultProgress(),
      contract.id,
      contract.revision,
      [machine],
      '2026-07-24T00:00:00.000Z',
    );

    expect(parseProgress(serializeProgress(saved)).campaignLayouts[contract.id]).toEqual({
      revision: contract.revision,
      machines: [machine],
      updatedAt: '2026-07-24T00:00:00.000Z',
    });
    expect(
      reconcileProgress(saved, [{ ...contract, revision: contract.revision + 1 }]),
    ).toMatchObject({ campaignLayouts: {} });
  });
});
