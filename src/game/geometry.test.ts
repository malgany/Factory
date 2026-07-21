import { describe, expect, it } from 'vitest';

import { CELL_SIZE } from '../domain/types';
import { MACHINE_DIMENSIONS } from './geometry';

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
  });

  it('mantém o trampolim em um por meio quadrado', () => {
    expect(MACHINE_DIMENSIONS.spring).toEqual({
      width: CELL_SIZE,
      height: CELL_SIZE / 2,
    });
  });
});
