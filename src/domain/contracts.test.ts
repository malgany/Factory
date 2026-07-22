import { describe, expect, it } from 'vitest';

import {
  CONTRACTS,
  SANDBOX_DEFINITION,
  getContract,
  getContractBySlot,
  getNextContractId,
} from './contracts';

describe('contratos', () => {
  it('define fases progressivas em uma área 30×18', () => {
    expect(CONTRACTS).toHaveLength(10);
    expect(CONTRACTS.map((contract) => contract.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(
      CONTRACTS.map(({ world, stage, title }) => ({
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
      CONTRACTS.every(
        (contract) => Number.isInteger(contract.revision) && contract.revision >= 1,
      ),
    ).toBe(true);
    expect(CONTRACTS.every((contract) => contract.grid.columns === 30)).toBe(true);
    expect(CONTRACTS.every((contract) => contract.grid.rows === 18)).toBe(true);
    expect(
      CONTRACTS.every((contract) =>
        contract.fixedMachines.every(
          (machine) =>
            Number.isInteger(machine.gridX * 4) && Number.isInteger(machine.gridY * 4),
        ),
      ),
    ).toBe(true);
  });

  it('mantém as metas e restrições do plano', () => {
    expect(getContract('assembly-line').goal).toMatchObject({
      deliveries: 8,
      maxLosses: 3,
      pieceBudget: 4,
    });
    expect(getContract('assembly-line').availableMachines).toEqual(['tracked-conveyor']);

    expect(getContract('first-jump').goal).toMatchObject({
      deliveries: 10,
      maxLosses: 3,
      pieceBudget: 5,
    });
    expect(getContract('first-jump').obstacles).not.toHaveLength(0);
    expect(getContract('first-jump').availableMachines).toEqual([
      'tracked-conveyor',
      'spring',
    ]);

    expect(getContract('final-inspection').goal).toMatchObject({
      deliveries: 25,
      maxLosses: 1,
      pieceBudget: 12,
      timeLimitSeconds: 42,
    });
    expect(
      getContract('final-inspection').fixedMachines.filter(({ type }) => type === 'source'),
    ).toHaveLength(2);
  });

  it('libera a campanha na ordem e mantém o sandbox irrestrito', () => {
    expect(getNextContractId('assembly-line')).toBe('quality-curve');
    expect(getNextContractId('quality-curve')).toBe('first-jump');
    expect(getNextContractId('industrial-corridors')).toBe('final-inspection');
    expect(getNextContractId('final-inspection')).toBeUndefined();
    expect(getContractBySlot(1, 6)?.id).toBe('star-route');
    expect(SANDBOX_DEFINITION.availableMachines).toEqual([
      'source',
      'tracked-conveyor',
      'receiver',
      'spring',
    ]);
    expect(SANDBOX_DEFINITION.pieceBudget).toBeUndefined();
  });
});
