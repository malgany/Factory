import { describe, expect, it } from 'vitest';

import { localToWorld, MACHINE_PHYSICS_DIMENSIONS } from './geometry';
import {
  boxTouchesOrientedSurface,
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
    const downward = localToWorld({ x: 0, y: 0 }, 45, 0, 12);
    const impulse = springVelocity(downward, 45);

    expect(impulse.x).toBeGreaterThan(0);
    expect(impulse.y).toBeLessThan(0);
    expect(Math.abs(impulse.x)).toBeCloseTo(Math.abs(impulse.y), 8);
  });

  it('mantém o impulso padrão independentemente da força recebida', () => {
    const slowImpact = springVelocity({ x: 0, y: 1 }, 0);
    const fastImpact = springVelocity({ x: 0, y: 20 }, 0);

    expect(slowImpact.y).toBe(-11.5);
    expect(fastImpact.y).toBe(-11.5);
  });

  it('aplica o mesmo impulso para fora nas duas faces', () => {
    const topFace = springVelocity({ x: 0, y: 5 }, 0, 11.5, 1);
    const bottomFace = springVelocity({ x: 0, y: -5 }, 0, 11.5, -1);

    expect(topFace).toEqual({ x: 0, y: -11.5 });
    expect(bottomFace).toEqual({ x: 0, y: 11.5 });
  });

  it('só aciona o trampolim quando a caixa alcança a superfície', () => {
    const surfaceCenter = { x: 160, y: 98 };
    const surfaceAngle = 22;
    const boxAngle = 0;
    const boxSize = 28;
    const surfaceWidth = 64;
    const surfaceHeight = 32;
    const relativeAngle = ((boxAngle - surfaceAngle) * Math.PI) / 180;
    const projectedHalfSize =
      (boxSize / 2) * (Math.abs(Math.cos(relativeAngle)) + Math.abs(Math.sin(relativeAngle)));
    const touching = localToWorld(
      surfaceCenter,
      surfaceAngle,
      0,
      -surfaceHeight / 2 - projectedHalfSize,
    );
    const visiblySeparated = localToWorld(
      surfaceCenter,
      surfaceAngle,
      0,
      -surfaceHeight / 2 - boxSize,
    );
    const touchingBottom = localToWorld(
      surfaceCenter,
      surfaceAngle,
      0,
      surfaceHeight / 2 + projectedHalfSize,
    );

    expect(
      boxTouchesOrientedSurface(
        visiblySeparated,
        boxAngle,
        boxSize,
        surfaceCenter,
        surfaceAngle,
        surfaceWidth,
        surfaceHeight,
      ),
    ).toBe(false);
    expect(
      boxTouchesOrientedSurface(
        touching,
        boxAngle,
        boxSize,
        surfaceCenter,
        surfaceAngle,
        surfaceWidth,
        surfaceHeight,
      ),
    ).toBe(true);
    expect(
      boxTouchesOrientedSurface(
        touchingBottom,
        boxAngle,
        boxSize,
        surfaceCenter,
        surfaceAngle,
        surfaceWidth,
        surfaceHeight,
        1,
        'bottom',
      ),
    ).toBe(true);
  });

  it('detecta o contato da caixa com o sensor após rotação', () => {
    const center = { x: 300, y: 240 };
    const receiver = MACHINE_PHYSICS_DIMENSIONS.receiver;
    const boxHalfSize = 14;
    const contactDistance = receiver.width / 2 + boxHalfSize;
    const touching = localToWorld(center, 63, contactDistance, 0);
    const outside = localToWorld(center, 63, contactDistance + 0.01, 0);

    expect(
      pointInsideOrientedSensor(
        touching,
        center,
        receiver.width,
        receiver.height,
        63,
        boxHalfSize,
      ),
    ).toBe(true);
    expect(
      pointInsideOrientedSensor(
        outside,
        center,
        receiver.width,
        receiver.height,
        63,
        boxHalfSize,
      ),
    ).toBe(false);
  });
});
