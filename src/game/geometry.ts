import { CELL_SIZE, type GridPoint, type MachineState, type MachineType } from '../domain/types';

export interface Point {
  x: number;
  y: number;
}

export interface MachineDimensions {
  width: number;
  height: number;
}

export const MACHINE_DIMENSIONS: Record<MachineType, MachineDimensions> = {
  source: { width: 68, height: 68 },
  conveyor: { width: 92, height: 22 },
  receiver: { width: 76, height: 76 },
  spring: { width: CELL_SIZE * 2, height: CELL_SIZE },
};

export function gridToWorld(point: GridPoint): Point {
  return {
    x: (point.x + 0.5) * CELL_SIZE,
    y: (point.y + 0.5) * CELL_SIZE,
  };
}

export function worldToGrid(point: Point): GridPoint {
  return {
    x: Math.floor(point.x / CELL_SIZE),
    y: Math.floor(point.y / CELL_SIZE),
  };
}

export function machineCenter(machine: MachineState): Point {
  return gridToWorld({ x: machine.gridX, y: machine.gridY });
}

export function normalizeAngle(angle: number): number {
  return ((Math.round(angle) % 360) + 360) % 360;
}

export function degreesToRadians(angle: number): number {
  return (angle * Math.PI) / 180;
}

export function localToWorld(center: Point, angle: number, x: number, y: number): Point {
  const radians = degreesToRadians(angle);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  };
}

export function worldToLocal(center: Point, angle: number, point: Point): Point {
  const radians = degreesToRadians(angle);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: dx * cosine + dy * sine,
    y: -dx * sine + dy * cosine,
  };
}

export function rectangleCorners(center: Point, width: number, height: number, angle = 0): Point[] {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return [
    localToWorld(center, angle, -halfWidth, -halfHeight),
    localToWorld(center, angle, halfWidth, -halfHeight),
    localToWorld(center, angle, halfWidth, halfHeight),
    localToWorld(center, angle, -halfWidth, halfHeight),
  ];
}

export function machinePolygon(machine: MachineState): Point[] {
  const dimensions = MACHINE_DIMENSIONS[machine.type];
  return rectangleCorners(
    machineCenter(machine),
    dimensions.width,
    dimensions.height,
    machine.angle,
  );
}

function projectPolygon(points: readonly Point[], axis: Point): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const projection = point.x * axis.x + point.y * axis.y;
    min = Math.min(min, projection);
    max = Math.max(max, projection);
  }
  return { min, max };
}

function polygonAxes(points: readonly Point[]): Point[] {
  const axes: Point[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!current || !next) continue;
    const dx = next.x - current.x;
    const dy = next.y - current.y;
    const length = Math.hypot(dx, dy) || 1;
    axes.push({ x: -dy / length, y: dx / length });
  }
  return axes;
}

/** Strict SAT overlap: shapes that only touch at an edge remain valid neighbours. */
export function polygonsOverlap(a: readonly Point[], b: readonly Point[], gap = 2): boolean {
  for (const axis of [...polygonAxes(a), ...polygonAxes(b)]) {
    const projectionA = projectPolygon(a, axis);
    const projectionB = projectPolygon(b, axis);
    if (projectionA.max <= projectionB.min + gap || projectionB.max <= projectionA.min + gap) {
      return false;
    }
  }
  return true;
}

export function pointInsideMachine(point: Point, machine: MachineState, padding = 0): boolean {
  const local = worldToLocal(machineCenter(machine), machine.angle, point);
  const dimensions = MACHINE_DIMENSIONS[machine.type];
  return (
    Math.abs(local.x) <= dimensions.width / 2 + padding &&
    Math.abs(local.y) <= dimensions.height / 2 + padding
  );
}

export function rotationHandle(machine: MachineState): Point {
  const dimensions = MACHINE_DIMENSIONS[machine.type];
  return localToWorld(machineCenter(machine), machine.angle, 0, -dimensions.height / 2 - 34);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polygonWithinBounds(
  polygon: readonly Point[],
  width: number,
  height: number,
  margin = 3,
  origin: Point = { x: 0, y: 0 },
): boolean {
  return polygon.every(
    (point) =>
      point.x >= origin.x + margin &&
      point.y >= origin.y + margin &&
      point.x <= origin.x + width - margin &&
      point.y <= origin.y + height - margin,
  );
}
