import { describe, expect, it } from 'vitest';

import { CELL_SIZE } from '../domain/types';
import { MACHINE_DIMENSIONS, MACHINE_PHYSICS_DIMENSIONS } from './geometry';

describe('geometria das máquinas', () => {
  it('mantém entrada e saída no mesmo módulo de um e meio quadrados', () => {
    expect(MACHINE_DIMENSIONS.source).toEqual({
      width: CELL_SIZE * 1.5,
      height: CELL_SIZE * 1.5,
    });
    expect(MACHINE_DIMENSIONS.receiver).toEqual(MACHINE_DIMENSIONS.source);
  });

  it('ocupa exatamente dois por meio quadrados visuais', () => {
    expect(MACHINE_DIMENSIONS.conveyor).toEqual({
      width: CELL_SIZE * 2,
      height: CELL_SIZE / 2,
    });
    expect(MACHINE_DIMENSIONS['tracked-conveyor']).toEqual(MACHINE_DIMENSIONS.conveyor);
  });

  it('mantém o trampolim em um por meio quadrado', () => {
    expect(MACHINE_DIMENSIONS.spring).toEqual({
      width: CELL_SIZE,
      height: CELL_SIZE / 2,
    });
  });

  it('alinha os sensores de entrada e saída aos contornos visuais', () => {
    expect(MACHINE_PHYSICS_DIMENSIONS.source).toEqual(MACHINE_DIMENSIONS.source);
    expect(MACHINE_PHYSICS_DIMENSIONS.receiver).toEqual(MACHINE_DIMENSIONS.receiver);
  });

  it('mantém folga somente nas superfícies sólidas adjacentes', () => {
    expect(MACHINE_PHYSICS_DIMENSIONS.conveyor).toEqual({
      width: MACHINE_DIMENSIONS.conveyor.width - 4,
      height: MACHINE_DIMENSIONS.conveyor.height - 2,
    });
    expect(MACHINE_PHYSICS_DIMENSIONS['tracked-conveyor']).toEqual(
      MACHINE_PHYSICS_DIMENSIONS.conveyor,
    );
    expect(MACHINE_PHYSICS_DIMENSIONS.spring).toEqual(MACHINE_DIMENSIONS.spring);
  });
});
