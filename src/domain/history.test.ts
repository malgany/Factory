import { describe, expect, it } from 'vitest';

import { CommandHistory, createSnapshotCommand } from './history';

describe('CommandHistory', () => {
  it('executa, desfaz e refaz comandos', () => {
    let value = 0;
    const history = new CommandHistory();

    history.execute({
      label: 'incrementar',
      execute: () => {
        value += 1;
      },
      undo: () => {
        value -= 1;
      },
    });

    expect(value).toBe(1);
    expect(history.canUndo).toBe(true);
    expect(history.undo()).toBe(true);
    expect(value).toBe(0);
    expect(history.canRedo).toBe(true);
    expect(history.redo()).toBe(true);
    expect(value).toBe(1);
  });

  it('invalida redo quando um novo comando é registrado', () => {
    let value = 0;
    const history = new CommandHistory();
    const command = (next: number) => ({
      label: `valor ${next}`,
      execute: () => {
        value = next;
      },
      undo: () => {
        value = 0;
      },
    });

    history.execute(command(1));
    history.undo();
    history.execute(command(2));

    expect(history.canRedo).toBe(false);
    expect(value).toBe(2);
  });

  it('restaura snapshots sem compartilhar referências mutáveis', () => {
    let state = { positions: [1] };
    const history = new CommandHistory();
    const before = structuredClone(state);
    state = { positions: [1, 2] };
    const after = structuredClone(state);

    history.record(
      createSnapshotCommand({
        label: 'posicionar',
        before,
        after,
        apply: (snapshot) => {
          state = snapshot;
        },
      }),
    );

    history.undo();
    expect(state.positions).toEqual([1]);
    state.positions.push(99);
    history.redo();
    expect(state.positions).toEqual([1, 2]);
  });

  it('respeita o limite do histórico', () => {
    let value = 0;
    const history = new CommandHistory(2);
    for (const next of [1, 2, 3]) {
      const previous = value;
      history.execute({
        label: String(next),
        execute: () => {
          value = next;
        },
        undo: () => {
          value = previous;
        },
      });
    }

    expect(history.undo()).toBe(true);
    expect(history.undo()).toBe(true);
    expect(history.undo()).toBe(false);
  });
});
