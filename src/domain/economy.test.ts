import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONVEYOR_SPEED_COSTS,
  resolveConveyorSpeedCosts,
} from './economy';

describe('economia da esteira', () => {
  it('usa os preços padrão 2000, 2500 e 3000', () => {
    expect(
      resolveConveyorSpeedCosts({
        machineCosts: { 'tracked-conveyor': 2_500, spring: 5_000 },
      }),
    ).toEqual(DEFAULT_CONVEYOR_SPEED_COSTS);
  });

  it('deriva os níveis antigos a partir do preço normal', () => {
    expect(
      resolveConveyorSpeedCosts({
        machineCosts: { 'tracked-conveyor': 3_200, spring: 5_000 },
      }),
    ).toEqual({ slow: 2_700, normal: 3_200, fast: 3_700 });
  });

  it('respeita os três preços configurados no admin', () => {
    expect(
      resolveConveyorSpeedCosts({
        machineCosts: { 'tracked-conveyor': 2_900, spring: 5_000 },
        conveyorSpeedCosts: { slow: 1_800, normal: 2_900, fast: 4_100 },
      }),
    ).toEqual({ slow: 1_800, normal: 2_900, fast: 4_100 });
  });
});
