import { describe, expect, it } from 'vitest';

import {
  CONTRACTS,
  SANDBOX_DEFINITION,
  getContract,
  getContractBySlot,
  getNextContractId,
} from './contracts';

const WORLD_ONE_CONTRACTS = CONTRACTS.filter(({ world }) => world === 1);

describe('contratos', () => {
  it('define fases progressivas em uma área 30×18', () => {
    expect(WORLD_ONE_CONTRACTS).toHaveLength(10);
    expect(WORLD_ONE_CONTRACTS.map((contract) => contract.order)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(
      WORLD_ONE_CONTRACTS.map(({ world, stage, title }) => ({
        world,
        stage,
        title,
      })),
    ).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        world: 1,
        stage: index + 1,
        title: `${index + 1}-1`,
      })),
    );
    expect(
      WORLD_ONE_CONTRACTS.every(
        (contract) => Number.isInteger(contract.revision) && contract.revision >= 1,
      ),
    ).toBe(true);
    expect(WORLD_ONE_CONTRACTS.every((contract) => contract.grid.columns === 30)).toBe(true);
    expect(WORLD_ONE_CONTRACTS.every((contract) => contract.grid.rows === 18)).toBe(true);
    expect(
      WORLD_ONE_CONTRACTS.every((contract) =>
        contract.fixedMachines.every(
          (machine) => Number.isFinite(machine.gridX) && Number.isFinite(machine.gridY),
        ),
      ),
    ).toBe(true);
  });

  it('mantém as metas e restrições do plano', () => {
    expect(getContract('assembly-line').goal).toMatchObject({
      deliveries: 8,
      maxLosses: 0,
    });
    expect(getContract('assembly-line').economy).toEqual({
      budgetLimit: 8_000,
      machineCosts: {
        'tracked-conveyor': 2_500,
        spring: 5_000,
        'turbo-spring': 7_500,
      },
      conveyorSpeedCosts: {
        slow: 2_000,
        normal: 2_500,
        fast: 3_000,
      },
    });
    expect(getContract('assembly-line').availableMachines).toEqual(['tracked-conveyor']);

    expect(getContract('first-jump').goal).toMatchObject({
      deliveries: 10,
      maxLosses: 0,
    });
    expect(getContract('first-jump').economy.budgetLimit).toBe(5_000);
    expect(getContract('first-jump').obstacles).not.toHaveLength(0);
    expect(getContract('first-jump').availableMachines).toEqual(['spring']);

    expect(getContract('final-inspection').goal.deliveries).toBeGreaterThan(0);
    expect(getContract('final-inspection').goal.maxLosses).toBeGreaterThanOrEqual(0);
    expect(getContract('final-inspection').economy.budgetLimit).toBeGreaterThanOrEqual(0);
    expect(
      getContract('final-inspection').fixedMachines.filter(({ type }) => type === 'source'),
    ).toHaveLength(2);
  });

  it('libera a campanha na ordem e mantém o sandbox irrestrito', () => {
    expect(getNextContractId('assembly-line')).toBe('quality-curve');
    expect(getNextContractId('quality-curve')).toBe('first-jump');
    expect(getNextContractId('industrial-corridors')).toBe('final-inspection');
    expect(getNextContractId('final-inspection', WORLD_ONE_CONTRACTS)).toBeUndefined();
    const worldTwoFirst = {
      ...structuredClone(CONTRACTS[0]!),
      id: 'world-two-first',
      world: 2,
      stage: 1 as const,
      order: 11,
      title: '1-2',
    };
    expect(getNextContractId('final-inspection', [...WORLD_ONE_CONTRACTS, worldTwoFirst])).toBe(
      worldTwoFirst.id,
    );
    expect(getContractBySlot(1, 6)?.id).toBe('star-route');
    expect(SANDBOX_DEFINITION.availableMachines).toEqual([
      'source',
      'slow-conveyor',
      'tracked-conveyor',
      'fast-conveyor',
      'receiver',
      'spring',
      'turbo-spring',
    ]);
    expect(SANDBOX_DEFINITION.economy).toBeUndefined();
  });

  it('define o balanceamento de orçamento e as estrelas cadastradas', () => {
    expect(WORLD_ONE_CONTRACTS).toHaveLength(10);
    expect(
      WORLD_ONE_CONTRACTS.every(
        ({ economy }) =>
          (economy.budgetLimit === undefined ||
            (Number.isInteger(economy.budgetLimit) && economy.budgetLimit >= 0)) &&
          Number.isInteger(economy.machineCosts['tracked-conveyor']) &&
          economy.machineCosts['tracked-conveyor'] >= 0 &&
          Number.isInteger(economy.machineCosts.spring) &&
          economy.machineCosts.spring >= 0,
      ),
    ).toBe(true);
    expect(
      getContract('final-inspection').collectibles.find(
        ({ id }) => id === 'final-inspection-star-a',
      ),
    ).toMatchObject({ gridX: 6.25, gridY: 7.25 });
  });
});
