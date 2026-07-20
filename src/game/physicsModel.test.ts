import { describe, expect, it } from 'vitest';

import { localToWorld } from './geometry';
import {
  conveyorVelocity,
  FIXED_PHYSICS_STEP_SECONDS,
  pointInsideOrientedSensor,
  springVelocity,
  stepGravity,
} from './physicsModel';

describe('modelo físico determinístico', () => {
  it('integra gravidade em passos fixos de 60 Hz de forma repetível', () => {
    const initial = { x: 10, y: 20, velocityX: 3, velocityY: 0 };
    const firstRun = stepGravity(initial, 900, 120);
    const secondRun = stepGravity(initial, 900, 120);

    expect(FIXED_PHYSICS_STEP_SECONDS).toBeCloseTo(1 / 60, 12);
    expect(firstRun).toEqual(secondRun);
    expect(firstRun.x).toBeCloseTo(16, 8);
    expect(firstRun.y).toBeGreaterThan(initial.y);
  });

  it('move a esteira em qualquer ângulo e inverte o vetor', () => {
    const forward = conveyorVelocity({ x: 0, y: 0 }, 37, false);
    const reversed = conveyorVelocity({ x: 0, y: 0 }, 37, true);

    expect(forward.x).toBeGreaterThan(0);
    expect(forward.y).toBeGreaterThan(0);
    expect(reversed.x).toBeCloseTo(-forward.x, 10);
    expect(reversed.y).toBeCloseTo(-forward.y, 10);
  });

  it('orienta o impulso do trampolim pelo ângulo central', () => {
    const impulse = springVelocity({ x: 0, y: 0 }, 45);

    expect(impulse.x).toBeGreaterThan(0);
    expect(impulse.y).toBeLessThan(0);
    expect(Math.abs(impulse.x)).toBeCloseTo(Math.abs(impulse.y), 8);
  });

  it('detecta o sensor de entrada após rotação', () => {
    const center = { x: 300, y: 240 };
    const inside = localToWorld(center, 63, 22, -10);
    const outside = localToWorld(center, 63, 44, 0);

    expect(pointInsideOrientedSensor(inside, center, 76, 76, 63, 5)).toBe(true);
    expect(pointInsideOrientedSensor(outside, center, 76, 76, 63, 5)).toBe(false);
  });
});
