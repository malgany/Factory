import type { MachineType } from './types';

export interface MachineSizeInCells {
  width: number;
  height: number;
}

/** Canonical footprints used by both editor placement and catalog validation. */
export const MACHINE_PLACEMENT_SIZE_IN_CELLS: Readonly<
  Record<MachineType, MachineSizeInCells>
> = {
  source: { width: 1.5, height: 1.5 },
  conveyor: { width: 85 / 48, height: 21 / 48 },
  'slow-conveyor': { width: 85 / 48, height: 21 / 48 },
  'tracked-conveyor': { width: 85 / 48, height: 21 / 48 },
  'fast-conveyor': { width: 85 / 48, height: 21 / 48 },
  receiver: { width: 1.5, height: 1.5 },
  spring: { width: 1, height: 0.5 },
  'turbo-spring': { width: 1, height: 0.5 },
};
