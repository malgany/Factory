import type { GameCommand } from './types';

export class CommandHistory {
  readonly #undoStack: GameCommand[] = [];
  readonly #redoStack: GameCommand[] = [];
  readonly #limit: number;

  constructor(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('O limite do histórico deve ser um inteiro positivo.');
    }
    this.#limit = limit;
  }

  get canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  get undoLabel(): string | undefined {
    return this.#undoStack.at(-1)?.label;
  }

  get redoLabel(): string | undefined {
    return this.#redoStack.at(-1)?.label;
  }

  execute(command: GameCommand): void {
    command.execute();
    this.record(command);
  }

  /** Records a command whose mutation was already applied by an interaction. */
  record(command: GameCommand): void {
    this.#undoStack.push(command);
    if (this.#undoStack.length > this.#limit) {
      this.#undoStack.shift();
    }
    this.#redoStack.length = 0;
  }

  undo(): boolean {
    const command = this.#undoStack.pop();
    if (!command) return false;

    command.undo();
    this.#redoStack.push(command);
    return true;
  }

  redo(): boolean {
    const command = this.#redoStack.pop();
    if (!command) return false;

    command.execute();
    this.#undoStack.push(command);
    return true;
  }

  clear(): void {
    this.#undoStack.length = 0;
    this.#redoStack.length = 0;
  }
}

export interface SnapshotCommandOptions<T> {
  label: string;
  before: T;
  after: T;
  apply(snapshot: T): void;
  clone?(snapshot: T): T;
}

export function createSnapshotCommand<T>(options: SnapshotCommandOptions<T>): GameCommand {
  const clone: (snapshot: T) => T =
    options.clone ?? ((snapshot: T) => structuredClone(snapshot) as T);
  const before = clone(options.before);
  const after = clone(options.after);

  return {
    label: options.label,
    execute: () => options.apply(clone(after)),
    undo: () => options.apply(clone(before)),
  };
}
