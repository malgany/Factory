import { degreesToRadians, worldToLocal, type Point } from './geometry';

export const FIXED_PHYSICS_STEP_SECONDS = 1 / 60;

export interface KinematicState extends Point {
  velocityX: number;
  velocityY: number;
}

export function stepGravity(state: KinematicState, gravity: number, steps = 1): KinematicState {
  let next = { ...state };
  for (let index = 0; index < steps; index += 1) {
    const velocityY = next.velocityY + gravity * FIXED_PHYSICS_STEP_SECONDS;
    next = {
      x: next.x + next.velocityX * FIXED_PHYSICS_STEP_SECONDS,
      y: next.y + velocityY * FIXED_PHYSICS_STEP_SECONDS,
      velocityX: next.velocityX,
      velocityY,
    };
  }
  return next;
}

export function conveyorVelocity(
  velocity: Point,
  angle: number,
  reversed: boolean,
  targetSpeed = 4.2,
  response = 0.075,
): Point {
  const radians = degreesToRadians(angle);
  const direction = reversed ? -1 : 1;
  const tangent = { x: Math.cos(radians) * direction, y: Math.sin(radians) * direction };
  const current = velocity.x * tangent.x + velocity.y * tangent.y;
  const acceleration = Math.max(-0.25, Math.min(0.25, (targetSpeed - current) * response));
  return {
    x: velocity.x + tangent.x * acceleration,
    y: velocity.y + tangent.y * acceleration,
  };
}

export function springVelocity(
  velocity: Point,
  angle: number,
  speed = 11.5,
  normalDirection: 1 | -1 = 1,
): Point {
  const radians = degreesToRadians(angle);
  const normal = {
    x: Math.sin(radians) * normalDirection,
    y: -Math.cos(radians) * normalDirection,
  };
  const tangent = { x: Math.cos(radians), y: Math.sin(radians) };
  const tangentialSpeed = velocity.x * tangent.x + velocity.y * tangent.y;
  return {
    x: normal.x * speed + tangent.x * tangentialSpeed * 0.45,
    y: normal.y * speed + tangent.y * tangentialSpeed * 0.45,
  };
}

/**
 * Checks whether a square box has reached the top face of a rotated rectangular surface.
 * The box projection accounts for its current rotation, avoiding early triggers caused by
 * treating its full size as the distance from its center to an edge.
 */
export function boxTouchesOrientedSurface(
  boxCenter: Point,
  boxAngle: number,
  boxSize: number,
  surfaceCenter: Point,
  surfaceAngle: number,
  surfaceWidth: number,
  surfaceHeight: number,
  tolerance = 1,
  face: 'top' | 'bottom' = 'top',
): boolean {
  const local = worldToLocal(surfaceCenter, surfaceAngle, boxCenter);
  const relativeAngle = degreesToRadians(boxAngle - surfaceAngle);
  const projectedHalfSize =
    (boxSize / 2) * (Math.abs(Math.cos(relativeAngle)) + Math.abs(Math.sin(relativeAngle)));
  const surfaceFace = (face === 'top' ? -1 : 1) * (surfaceHeight / 2);
  const onFaceSide = face === 'top' ? local.y <= 0 : local.y >= 0;

  return (
    onFaceSide &&
    Math.abs(local.x) <= surfaceWidth / 2 + projectedHalfSize + tolerance &&
    Math.abs(local.y - surfaceFace) <= projectedHalfSize + tolerance
  );
}

/** Tests a point against a rotated sensor, optionally expanding it by an object's half-size. */
export function pointInsideOrientedSensor(
  point: Point,
  center: Point,
  width: number,
  height: number,
  angle: number,
  padding = 0,
): boolean {
  const local = worldToLocal(center, angle, point);
  return (
    Math.abs(local.x) <= width / 2 + padding &&
    Math.abs(local.y) <= height / 2 + padding
  );
}
