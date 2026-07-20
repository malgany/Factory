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

export function springVelocity(velocity: Point, angle: number, speed = 11.5): Point {
  const radians = degreesToRadians(angle);
  const up = { x: Math.sin(radians), y: -Math.cos(radians) };
  const tangent = { x: Math.cos(radians), y: Math.sin(radians) };
  const tangentialSpeed = velocity.x * tangent.x + velocity.y * tangent.y;
  return {
    x: up.x * speed + tangent.x * tangentialSpeed * 0.45,
    y: up.y * speed + tangent.y * tangentialSpeed * 0.45,
  };
}

export function pointInsideOrientedSensor(
  point: Point,
  center: Point,
  width: number,
  height: number,
  angle: number,
  inset = 0,
): boolean {
  const local = worldToLocal(center, angle, point);
  return Math.abs(local.x) <= width / 2 - inset && Math.abs(local.y) <= height / 2 - inset;
}
