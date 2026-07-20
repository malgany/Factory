import { describe, expect, it } from 'vitest';

import { CONTRACTS, SANDBOX_DEFINITION, getContract, getNextContractId } from './contracts';

describe('contratos', () => {
  it('define três fases progressivas em uma área 30×18', () => {
    expect(CONTRACTS).toHaveLength(3);
    expect(CONTRACTS.map((contract) => contract.order)).toEqual([1, 2, 3]);
    expect(CONTRACTS.every((contract) => contract.grid.columns === 30)).toBe(true);
    expect(CONTRACTS.every((contract) => contract.grid.rows === 18)).toBe(true);
    expect(
      CONTRACTS.every((contract) =>
        contract.fixedMachines.every(
          (machine) => machine.gridX % 1 === 0.5 && machine.gridY % 1 === 0.5,
        ),
      ),
    ).toBe(true);
  });

  it('mantém as metas e restrições do plano', () => {
    expect(getContract('first-flow').goal).toMatchObject({
      deliveries: 10,
      maxLosses: 3,
      pieceBudget: 8,
    });
    expect(getContract('first-flow').availableMachines).toEqual(['conveyor']);

    expect(getContract('controlled-jump').goal).toMatchObject({
      deliveries: 12,
      maxLosses: 3,
      pieceBudget: 8,
    });
    expect(getContract('controlled-jump').obstacles).not.toHaveLength(0);
    expect(getContract('controlled-jump').availableMachines).toEqual(['conveyor', 'spring']);

    expect(getContract('line-rhythm').goal).toMatchObject({
      deliveries: 25,
      maxLosses: 2,
      pieceBudget: 12,
      timeLimitSeconds: 45,
    });
    expect(
      getContract('line-rhythm').fixedMachines.filter(({ type }) => type === 'source'),
    ).toHaveLength(2);
  });

  it('libera a campanha na ordem e mantém o sandbox irrestrito', () => {
    expect(getNextContractId('first-flow')).toBe('controlled-jump');
    expect(getNextContractId('controlled-jump')).toBe('line-rhythm');
    expect(getNextContractId('line-rhythm')).toBeUndefined();
    expect(SANDBOX_DEFINITION.availableMachines).toEqual([
      'source',
      'conveyor',
      'receiver',
      'spring',
    ]);
    expect(SANDBOX_DEFINITION.pieceBudget).toBeUndefined();
  });
});
