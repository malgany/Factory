import type {
  ContractEconomy,
  ConveyorSpeed,
  ConveyorSpeedCosts,
  MachineType,
} from './types';

export const DEFAULT_CONVEYOR_SPEED_COSTS: Readonly<ConveyorSpeedCosts> = {
  slow: 2_000,
  normal: 2_500,
  fast: 3_000,
};

export const CONVEYOR_MACHINE_TYPES: readonly MachineType[] = [
  'conveyor',
  'slow-conveyor',
  'tracked-conveyor',
  'fast-conveyor',
];

export function isConveyorMachineType(type: MachineType): boolean {
  return CONVEYOR_MACHINE_TYPES.includes(type);
}

export function conveyorSpeedForMachineType(
  type: MachineType,
  legacySpeed: ConveyorSpeed = 'normal',
): ConveyorSpeed {
  if (type === 'slow-conveyor') return 'slow';
  if (type === 'fast-conveyor') return 'fast';
  return isConveyorMachineType(type) ? legacySpeed : 'normal';
}

export function conveyorMachineTypeForSpeed(speed: ConveyorSpeed): MachineType {
  if (speed === 'slow') return 'slow-conveyor';
  if (speed === 'fast') return 'fast-conveyor';
  return 'tracked-conveyor';
}

export function canonicalMachineType(
  type: MachineType,
  legacySpeed?: ConveyorSpeed,
): MachineType {
  if (type === 'conveyor') {
    return conveyorMachineTypeForSpeed(legacySpeed ?? 'normal');
  }
  if (type === 'tracked-conveyor' && legacySpeed && legacySpeed !== 'normal') {
    return conveyorMachineTypeForSpeed(legacySpeed);
  }
  return type;
}

export function conveyorCostForMachineType(
  economy: Pick<ContractEconomy, 'machineCosts' | 'conveyorSpeedCosts'>,
  type: MachineType,
  legacySpeed?: ConveyorSpeed,
): number {
  return resolveConveyorSpeedCosts(economy)[conveyorSpeedForMachineType(type, legacySpeed)];
}

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
