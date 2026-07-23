import type { ContractEconomy, ConveyorSpeedCosts } from './types';

export const DEFAULT_CONVEYOR_SPEED_COSTS: Readonly<ConveyorSpeedCosts> = {
  slow: 2_000,
  normal: 2_500,
  fast: 3_000,
};

export function resolveConveyorSpeedCosts(
  economy: Pick<ContractEconomy, 'machineCosts' | 'conveyorSpeedCosts'>,
): ConveyorSpeedCosts {
  const configuredNormal = economy.conveyorSpeedCosts?.normal;
  const legacyNormal = economy.machineCosts['tracked-conveyor'];
  const normal = normalizedCost(
    configuredNormal,
    normalizedCost(legacyNormal, DEFAULT_CONVEYOR_SPEED_COSTS.normal),
  );
  return {
    slow: normalizedCost(economy.conveyorSpeedCosts?.slow, Math.max(0, normal - 500)),
    normal,
    fast: normalizedCost(economy.conveyorSpeedCosts?.fast, normal + 500),
  };
}

function normalizedCost(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
}
