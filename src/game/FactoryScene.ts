import Phaser from 'phaser';

import factoryBoxTextureUrl from '../assets/factory-box-game.png?url';
import { appEvents } from '../core/events';
import { getContract, SANDBOX_DEFINITION } from '../domain/contracts';
import { CommandHistory, createSnapshotCommand } from '../domain/history';
import { calculateStars, evaluateRun, isWithinPieceBudget } from '../domain/rules';
import {
  CELL_SIZE,
  GRID_COLUMNS,
  GRID_ROWS,
  PLAY_AREA_MAX_COLUMN,
  PLAY_AREA_MAX_ROW,
  PLAY_AREA_MIN_COLUMN,
  PLAY_AREA_MIN_ROW,
  type ContractDefinition,
  type ContractId,
  type GameMode,
  type GameSnapshot,
  type MachineState,
  type MachineType,
  type ObstacleDefinition,
  type RunMetrics,
  type SimulationStatus,
} from '../domain/types';
import {
  MACHINE_DIMENSIONS,
  degreesToRadians,
  distance,
  gridToWorld,
  localToWorld,
  machineCenter,
  machinePolygon,
  normalizeAngle,
  pointInsideMachine,
  polygonWithinBounds,
  polygonsOverlap,
  rectangleCorners,
  rotationHandle,
  worldToLocal,
  type Point,
} from './geometry';
import { DISPLAY_DENSITY, fromCameraZoom, toCameraZoom } from './display';
import {
  conveyorVelocity,
  FIXED_PHYSICS_STEP_SECONDS,
  pointInsideOrientedSensor,
  springVelocity,
} from './physicsModel';

const STAGE_WIDTH = GRID_COLUMNS * CELL_SIZE;
const STAGE_HEIGHT = GRID_ROWS * CELL_SIZE;
const PLAY_AREA_MIN_X = PLAY_AREA_MIN_COLUMN * CELL_SIZE;
const PLAY_AREA_MAX_X = PLAY_AREA_MAX_COLUMN * CELL_SIZE;
const PLAY_AREA_MIN_Y = PLAY_AREA_MIN_ROW * CELL_SIZE;
const PLAY_AREA_MAX_Y = PLAY_AREA_MAX_ROW * CELL_SIZE;
const PLAY_AREA_WIDTH = PLAY_AREA_MAX_X - PLAY_AREA_MIN_X;
const PLAY_AREA_HEIGHT = PLAY_AREA_MAX_Y - PLAY_AREA_MIN_Y;
const MIN_ZOOM = 1;
const MAX_ZOOM = 2;
const GRID_ROTATION_STEP = 5;
const GRID_POSITION_STEP = 0.5;
const MIN_SIMULATION_SPEED = 0.1;
const MAX_SIMULATION_SPEED = 5;
const BOX_SIZE = 28;
const BOX_TEXTURE_KEY = 'factory-box';
const BOX_TEXTURE_SCALE_X = 1.2;
const BOX_TEXTURE_SCALE_Y = 1.18;
const CONVEYOR_SPEED = 4.2;
const SPRING_SPEED = 11.5;
const FIXED_PHYSICS_STEP_MS = FIXED_PHYSICS_STEP_SECONDS * 1000;

const COLORS = {
  board: 0x3475b8,
  grid: 0x78a6d0,
  gridStrong: 0xe8f3fc,
  graphite: 0x293139,
  graphiteSoft: 0x5f6a72,
  blue: 0x527da5,
  blueLight: 0x82a5c5,
  orange: 0xff7629,
  white: 0xffffff,
  green: 0x35a26b,
  red: 0xd95050,
  obstacle: 0xb9c0c2,
} as const;

interface PhysicsMachine {
  machine: MachineState;
  body: MatterJS.BodyType;
}

interface BoxRuntime {
  id: number;
  body: MatterJS.BodyType;
  image: Phaser.GameObjects.Image;
  bornAtSimulationMs: number;
  springReadyAt: number;
}

interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

interface Particle {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  life: number;
  maxLife: number;
  color: number;
  size: number;
}

interface DragState {
  kind: 'move' | 'rotate' | 'obstacle-move' | 'obstacle-resize' | 'pan';
  machineId?: string;
  before?: MachineState[];
  preview?: MachineState;
  obstacleId?: string;
  beforeDocument?: EditorDocument;
  previewObstacle?: ObstacleDefinition;
  grabOffsetX?: number;
  grabOffsetY?: number;
  valid?: boolean;
  lastScreenX: number;
  lastScreenY: number;
}

interface EditorDocument {
  machines: MachineState[];
  obstacles: ObstacleDefinition[];
}

export type EditorTool = MachineType | 'obstacle';

interface EditorAuthoringState {
  contract: ContractDefinition;
  document: EditorDocument;
}

export interface FactoryDebugApi {
  getSnapshot(): GameSnapshot;
  getMachines(): MachineState[];
  getObstacles(): ObstacleDefinition[];
  getBoxes(): Array<{ x: number; y: number; velocityX: number; velocityY: number }>;
  getCamera(): { scrollX: number; scrollY: number; zoom: number };
  getWorldBounds(): WorldBounds;
  startMode(mode: GameMode, contractId?: ContractId): void;
  startEditor(contract: ContractDefinition): void;
  getEditorDraft(): ContractDefinition;
  selectEditorTool(type: EditorTool): void;
  selectTool(type: MachineType): void;
  placeMachine(type: MachineType, gridX: number, gridY: number, angle?: number): boolean;
  selectMachine(id: string): boolean;
  rotateSelected(angle: number): boolean;
  reverseSelected(): boolean;
  deleteSelected(): boolean;
  placeObstacle(gridX: number, gridY: number, columns?: number, rows?: number): boolean;
  selectObstacle(id: string): boolean;
  moveSelectedObstacle(gridX: number, gridY: number): boolean;
  resizeSelectedObstacle(columns: number, rows: number): boolean;
  beginEditorPreview(): void;
  returnToEditor(): void;
  run(): void;
  pause(): void;
  reset(): void;
  undo(): void;
  redo(): void;
  setMachines(machines: MachineState[]): void;
  setSimulationSpeed(speed: number): void;
  advance(seconds: number): GameSnapshot;
  completeContract(): void;
}

declare global {
  interface Window {
    __FACTORY_DEBUG__?: FactoryDebugApi;
  }
}

function cloneMachines(machines: readonly MachineState[]): MachineState[] {
  return machines.map((machine) => ({ ...machine }));
}

function cloneObstacles(obstacles: readonly ObstacleDefinition[]): ObstacleDefinition[] {
  return obstacles.map((obstacle) => ({ ...obstacle }));
}

function cloneEditorDocument(document: EditorDocument): EditorDocument {
  return {
    machines: cloneMachines(document.machines),
    obstacles: cloneObstacles(document.obstacles),
  };
}

function cloneContract(contract: ContractDefinition): ContractDefinition {
  return {
    ...contract,
    grid: { ...contract.grid },
    goal: { ...contract.goal },
    availableMachines: [...contract.availableMachines],
    fixedMachines: cloneMachines(contract.fixedMachines),
    obstacles: cloneObstacles(contract.obstacles),
  };
}

function sameMachineState(a: MachineState, b: MachineState): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.gridX === b.gridX &&
    a.gridY === b.gridY &&
    a.angle === b.angle &&
    a.reversed === b.reversed &&
    a.fixed === b.fixed
  );
}

function drawPolygon(graphics: Phaser.GameObjects.Graphics, points: readonly Point[]): void {
  graphics.fillPoints(
    points.map((point) => new Phaser.Math.Vector2(point.x, point.y)),
    true,
    true,
  );
}

function linePolygon(
  graphics: Phaser.GameObjects.Graphics,
  points: readonly Point[],
  close = true,
): void {
  graphics.strokePoints(
    points.map((point) => new Phaser.Math.Vector2(point.x, point.y)),
    close,
    close,
  );
}

export class FactoryScene extends Phaser.Scene {
  private readonly history = new CommandHistory(120);
  private readonly editorHistory = new CommandHistory(120);
  private readonly eventUnsubscribers: Array<() => void> = [];
  private readonly machineBodies = new Map<string, PhysicsMachine>();
  private readonly obstacleBodies: MatterJS.BodyType[] = [];
  private readonly boxes = new Map<number, BoxRuntime>();
  private readonly springCompression = new Map<string, number>();
  private readonly receiverPulse = new Map<string, number>();
  private readonly particles: Particle[] = [];

  private gridGraphics!: Phaser.GameObjects.Graphics;
  private worldGraphics!: Phaser.GameObjects.Graphics;
  private effectsGraphics!: Phaser.GameObjects.Graphics;
  private overlayGraphics!: Phaser.GameObjects.Graphics;

  private mode: GameMode = 'campaign';
  private contract?: ContractDefinition;
  private machines: MachineState[] = [];
  private obstacles: ObstacleDefinition[] = [];
  private availableMachines: MachineType[] = [];
  private status: SimulationStatus = 'build';
  private metrics: RunMetrics = {
    delivered: 0,
    lost: 0,
    active: 0,
    elapsedSeconds: 0,
    placedPieces: 0,
  };

  private selectedTool?: MachineType;
  private selectedEditorTool?: EditorTool;
  private selectedMachineId?: string;
  private selectedObstacleId?: string;
  private ghostMachine?: MachineState;
  private ghostObstacle?: ObstacleDefinition;
  private ghostValid = false;
  private drag?: DragState;
  private editorActive = false;
  private editorPreview = false;
  private editorContract?: ContractDefinition;
  private editorBaseline = '';
  private editorAuthoringState?: EditorAuthoringState;
  private obstacleSequence = 0;
  private muted = false;
  private gridEnabled = true;
  private simulationSpeed = 1;
  private spawnAccumulator = 0;
  private physicsAccumulator = 0;
  private simulationTimeMs = 0;
  private simulationVisualTimeMs = 0;
  private snapshotAccumulator = 0;
  private machineSequence = 0;
  private boxSequence = 0;
  private lastGridZoom = -1;
  private contextMenuHandler?: (event: MouseEvent) => void;

  constructor() {
    super({ key: 'FactoryScene' });
  }

  preload(): void {
    this.load.image(BOX_TEXTURE_KEY, factoryBoxTextureUrl);
  }

  create(): void {
    this.cameras.main.setBackgroundColor(COLORS.board);
    this.cameras.main.setBounds(
      PLAY_AREA_MIN_X,
      PLAY_AREA_MIN_Y,
      PLAY_AREA_WIDTH,
      PLAY_AREA_HEIGHT,
    );
    this.matter.set60Hz();
    this.matter.world.autoUpdate = false;

    this.gridGraphics = this.add.graphics().setDepth(0);
    this.worldGraphics = this.add.graphics().setDepth(10);
    this.effectsGraphics = this.add.graphics().setDepth(12);
    this.overlayGraphics = this.add.graphics().setDepth(20);

    this.drawGrid(true);
    this.bindInput();
    this.bindApplicationEvents();
    this.installDebugApi();
    this.startMode('campaign', 'first-flow');
    this.fitCamera();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.destroyScene, this);
    appEvents.emit('game:ready', undefined);
  }

  update(_time: number, delta: number): void {
    const deltaSeconds = Math.min(delta, 50) / 1000;

    if (this.status === 'running') {
      const scaledDelta = Math.min(delta, 250) * this.simulationSpeed;
      this.physicsAccumulator += scaledDelta;
      this.simulationVisualTimeMs += scaledDelta;
      while (this.physicsAccumulator >= FIXED_PHYSICS_STEP_MS && this.status === 'running') {
        this.simulateFixedStep();
        this.physicsAccumulator -= FIXED_PHYSICS_STEP_MS;
      }
    }

    this.updateEffects(
      this.status === 'running' ? deltaSeconds * this.simulationSpeed : deltaSeconds,
    );
    this.metrics.active = this.boxes.size;
    this.renderWorld();

    if (Math.abs(this.cameras.main.zoom - this.lastGridZoom) > 0.001) {
      this.drawGrid();
    }

    this.snapshotAccumulator += deltaSeconds;
    if (this.snapshotAccumulator >= 0.1) {
      this.snapshotAccumulator = 0;
      this.emitSnapshot();
    }
  }

  public startMode(
    mode: GameMode,
    contractId?: ContractId,
    restoredMachines?: readonly MachineState[],
    contractDefinition?: ContractDefinition,
  ): void {
    this.editorActive = false;
    this.editorPreview = false;
    this.editorContract = undefined;
    this.editorAuthoringState = undefined;
    this.editorBaseline = '';
    this.mode = mode;
    this.contract =
      mode === 'campaign'
        ? cloneContract(contractDefinition ?? getContract(contractId ?? 'first-flow'))
        : undefined;
    this.availableMachines = [
      ...(this.contract?.availableMachines ?? SANDBOX_DEFINITION.availableMachines),
    ];
    this.obstacles = (this.contract?.obstacles ?? []).map((obstacle) => ({ ...obstacle }));
    const initialMachines =
      this.contract?.fixedMachines ?? restoredMachines ?? SANDBOX_DEFINITION.fixedMachines;
    this.machines = this.normalizeMachineIds(initialMachines, this.mode === 'campaign');
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.simulationSpeed = 1;
    this.history.clear();
    this.editorHistory.clear();
    this.resetSimulation('build');
    this.rebuildStaticBodies();
    this.fitCamera();
    this.emitSnapshot();
    this.emitSandboxChange();
    this.emitCamera();
  }

  /** Opens a contract as an editable, fixed scenario. No campaign result is emitted in this mode. */
  public startEditor(contract: ContractDefinition, isNew = false): void {
    const draft = cloneContract(contract);
    this.mode = 'editor';
    this.editorActive = true;
    this.editorPreview = false;
    this.editorAuthoringState = undefined;
    this.editorContract = draft;
    this.contract = draft;
    this.availableMachines = ['source', 'receiver', 'conveyor', 'spring'];
    this.obstacles = this.normalizeObstacles(draft.obstacles);
    this.machines = this.normalizeMachineIds(
      draft.fixedMachines.map((machine) => ({ ...machine, fixed: true })),
      true,
    );
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.drag = undefined;
    this.simulationSpeed = 1;
    this.history.clear();
    this.editorHistory.clear();
    this.resetSimulation('build');
    this.rebuildStaticBodies();
    this.fitCamera();
    this.editorBaseline = isNew
      ? '__new-contract-without-persisted-baseline__'
      : this.serializeEditorContract(this.getEditorDraft());
    this.emitEditorChanged();
    appEvents.emit('game:editor-preview', { active: false });
    this.emitSnapshot();
  }

  public updateEditorSettings(contract: ContractDefinition): void {
    if (!this.isAuthoring()) return;
    this.editorContract = {
      ...cloneContract(contract),
      fixedMachines: cloneMachines(this.machines).map((machine) => ({ ...machine, fixed: true })),
      obstacles: cloneObstacles(this.obstacles),
    };
    this.contract = this.editorContract;
    this.emitEditorChanged();
    this.emitSnapshot();
  }

  public selectEditorTool(type: EditorTool): void {
    if (!this.isAuthoring() || !this.canBuild()) return;
    this.selectedEditorTool = type;
    this.selectedTool = type === 'obstacle' ? undefined : type;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.emitSnapshot();
  }

  /** Runs the current draft with the player's configured palette and a disposable solution. */
  public beginEditorPreview(): void {
    if (!this.isAuthoring() || !this.editorContract) return;
    const draft = this.getEditorDraft();
    this.editorAuthoringState = {
      contract: cloneContract(draft),
      document: this.captureEditorDocument(),
    };
    this.editorPreview = true;
    this.mode = 'preview';
    this.contract = cloneContract(draft);
    this.availableMachines = [...draft.availableMachines];
    this.machines = cloneMachines(draft.fixedMachines).map((machine) => ({
      ...machine,
      fixed: true,
    }));
    this.obstacles = cloneObstacles(draft.obstacles);
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.history.clear();
    this.resetSimulation('build');
    this.rebuildStaticBodies();
    appEvents.emit('game:editor-preview', { active: true });
    this.emitSnapshot();
  }

  public returnToEditor(): void {
    if (!this.editorActive || !this.editorPreview || !this.editorAuthoringState) return;
    const state = this.editorAuthoringState;
    this.editorPreview = false;
    this.mode = 'editor';
    this.editorContract = cloneContract(state.contract);
    this.contract = this.editorContract;
    this.availableMachines = ['source', 'receiver', 'conveyor', 'spring'];
    this.applyEditorDocument(state.document, false);
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.history.clear();
    this.resetSimulation('build');
    this.rebuildStaticBodies();
    this.editorAuthoringState = undefined;
    appEvents.emit('game:editor-preview', { active: false });
    this.emitEditorChanged();
    this.emitSnapshot();
  }

  public markEditorSaved(contract?: ContractDefinition): void {
    if (!this.isAuthoring()) return;
    if (contract) this.updateEditorSettings(contract);
    this.editorBaseline = this.serializeEditorContract(this.getEditorDraft());
    this.emitEditorChanged();
  }

  public cancelEditor(): void {
    if (!this.editorActive) return;
    this.mode = 'campaign';
    this.editorActive = false;
    this.editorPreview = false;
    this.editorContract = undefined;
    this.editorAuthoringState = undefined;
    this.editorBaseline = '';
    // A discarded draft must not remain runnable behind the menu. In
    // particular, the global Space shortcut must never turn it into a
    // campaign result after authoring has ended.
    this.contract = undefined;
    this.machines = [];
    this.obstacles = [];
    this.availableMachines = [];
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.drag = undefined;
    this.editorHistory.clear();
    this.history.clear();
    this.resetSimulation('build');
    this.rebuildStaticBodies();
    appEvents.emit('game:editor-preview', { active: false });
    this.emitSnapshot();
  }

  public getEditorDraft(): ContractDefinition {
    const source = this.editorContract ?? this.contract;
    if (!source) throw new Error('Nenhuma fase está aberta no editor.');
    const base = cloneContract(source);
    return {
      ...base,
      fixedMachines: cloneMachines(this.machines).map((machine) => ({ ...machine, fixed: true })),
      obstacles: cloneObstacles(this.obstacles),
    };
  }

  public selectTool(type: MachineType): void {
    if (!this.canBuild()) {
      this.toast('Pause a simulação para construir.', 'neutral');
      return;
    }
    if (!this.isAuthoring() && !this.availableMachines.includes(type)) {
      this.toast('Essa máquina não está disponível neste contrato.', 'danger');
      this.audio('error');
      return;
    }
    this.selectedTool = type;
    this.selectedEditorTool = this.isAuthoring() ? type : undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.emitSnapshot();
  }

  public placeMachineAt(type: MachineType, gridX: number, gridY: number, angle = 0): boolean {
    if (!this.canBuild() || (!this.isAuthoring() && !this.availableMachines.includes(type))) {
      return false;
    }
    if (!this.isAuthoring() && !this.canPlaceAnotherPiece()) {
      this.toast('Orçamento de peças esgotado.', 'danger');
      this.audio('error');
      return false;
    }

    const snapToHalfCell = (value: number) =>
      Math.round(value / GRID_POSITION_STEP) * GRID_POSITION_STEP;
    const machine: MachineState = {
      id: this.createMachineId(),
      type,
      gridX: this.isAuthoring() ? snapToHalfCell(gridX) : gridX,
      gridY: this.isAuthoring() ? snapToHalfCell(gridY) : gridY,
      angle: normalizeAngle(angle),
      reversed: false,
      fixed: this.isAuthoring(),
    };
    if (!this.isMachinePlacementValid(machine)) {
      this.toast('Essa posição está ocupada.', 'danger');
      this.audio('error');
      return false;
    }

    const before = cloneMachines(this.machines);
    const after = [...before, machine];
    this.executeSnapshotCommand('Posicionar peça', before, after);
    this.selectedMachineId = machine.id;
    this.selectedObstacleId = undefined;
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.audio('place');
    this.emitSnapshot();
    this.emitEditorChanged();
    return true;
  }

  public selectMachine(id: string): boolean {
    const machine = this.machines.find((candidate) => candidate.id === id);
    if (!machine) return false;
    this.selectedMachineId = id;
    this.selectedObstacleId = undefined;
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.emitSnapshot();
    return true;
  }

  public rotateSelectedTo(angle: number): boolean {
    if (!this.canBuild()) return false;
    const selected = this.getSelectedMachine();
    if (!selected || !this.canEditMachine(selected) || !this.isRotatable(selected)) return false;
    const candidate = { ...selected, angle: this.snapRotationAngle(angle) };
    if (!this.isMachinePlacementValid(candidate, selected.id)) {
      this.toast('A rotação encosta em outra peça.', 'danger');
      this.audio('error');
      return false;
    }
    this.replaceMachineWithHistory(selected, candidate, 'Girar peça');
    this.emitEditorChanged();
    return true;
  }

  public reverseSelected(): boolean {
    if (!this.canBuild()) return false;
    const selected = this.getSelectedMachine();
    if (!selected || !this.canEditMachine(selected) || selected.type !== 'conveyor') {
      this.toast('Selecione uma esteira para inverter.', 'neutral');
      return false;
    }
    this.replaceMachineWithHistory(
      selected,
      { ...selected, reversed: !selected.reversed },
      'Inverter esteira',
    );
    this.audio('place');
    this.emitEditorChanged();
    return true;
  }

  public deleteSelected(): boolean {
    if (!this.canBuild()) return false;
    if (this.isAuthoring() && this.selectedObstacleId) {
      return this.deleteSelectedObstacle();
    }
    const selected = this.getSelectedMachine();
    if (!selected || !this.canEditMachine(selected)) {
      if (selected?.fixed) this.toast('Esta máquina faz parte do contrato.', 'neutral');
      return false;
    }
    const before = cloneMachines(this.machines);
    const after = before.filter((machine) => machine.id !== selected.id);
    this.executeSnapshotCommand('Remover peça', before, after);
    this.selectedMachineId = undefined;
    this.audio('place');
    this.emitSnapshot();
    this.emitEditorChanged();
    return true;
  }

  public placeObstacleAt(gridX: number, gridY: number, columns = 1, rows = 1): boolean {
    if (!this.isAuthoring() || !this.canBuild()) return false;
    const obstacle: ObstacleDefinition = {
      id: this.createObstacleId(),
      gridX: Math.round(gridX),
      gridY: Math.round(gridY),
      columns: Math.max(1, Math.round(columns)),
      rows: Math.max(1, Math.round(rows)),
    };
    if (!this.isObstaclePlacementValid(obstacle)) {
      this.toast('Essa área está ocupada ou fora do tabuleiro.', 'danger');
      this.audio('error');
      return false;
    }
    const before = this.captureEditorDocument();
    const after = cloneEditorDocument(before);
    after.obstacles.push(obstacle);
    this.executeEditorSnapshotCommand('Posicionar bloqueador', before, after);
    this.selectedObstacleId = obstacle.id;
    this.selectedMachineId = undefined;
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.ghostObstacle = undefined;
    this.audio('place');
    this.emitSnapshot();
    this.emitEditorChanged();
    return true;
  }

  public selectObstacle(id: string): boolean {
    if (!this.isAuthoring() || !this.obstacles.some((obstacle) => obstacle.id === id)) return false;
    this.selectedObstacleId = id;
    this.selectedMachineId = undefined;
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.emitSnapshot();
    return true;
  }

  public moveSelectedObstacle(gridX: number, gridY: number): boolean {
    if (!this.isAuthoring() || !this.canBuild()) return false;
    const selected = this.getSelectedObstacle();
    if (!selected) return false;
    const candidate = { ...selected, gridX: Math.round(gridX), gridY: Math.round(gridY) };
    if (!this.isObstaclePlacementValid(candidate, selected.id)) return false;
    this.replaceObstacleWithHistory(selected, candidate, 'Mover bloqueador');
    return true;
  }

  public resizeSelectedObstacle(columns: number, rows: number): boolean {
    if (!this.isAuthoring() || !this.canBuild()) return false;
    const selected = this.getSelectedObstacle();
    if (!selected) return false;
    const candidate = {
      ...selected,
      columns: Math.max(1, Math.round(columns)),
      rows: Math.max(1, Math.round(rows)),
    };
    if (!this.isObstaclePlacementValid(candidate, selected.id)) return false;
    this.replaceObstacleWithHistory(selected, candidate, 'Redimensionar bloqueador');
    return true;
  }

  public deleteSelectedObstacle(): boolean {
    if (!this.isAuthoring() || !this.canBuild()) return false;
    const selected = this.getSelectedObstacle();
    if (!selected) return false;
    const before = this.captureEditorDocument();
    const after = cloneEditorDocument(before);
    after.obstacles = after.obstacles.filter((obstacle) => obstacle.id !== selected.id);
    this.executeEditorSnapshotCommand('Remover bloqueador', before, after);
    this.selectedObstacleId = undefined;
    this.audio('place');
    this.emitSnapshot();
    this.emitEditorChanged();
    return true;
  }

  private toggleSimulation(): void {
    if (this.status === 'running') {
      this.pauseSimulation();
      return;
    }
    this.runSimulation();
  }

  private clearInteractionFocus(): void {
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.drag = undefined;
  }

  public runSimulation(): void {
    if (this.status === 'paused') {
      this.clearInteractionFocus();
      this.status = 'running';
      this.matter.world.resume();
      this.emitSnapshot();
      return;
    }

    if (this.status !== 'build' && this.status !== 'failure' && this.status !== 'success') return;
    this.clearBoxes();
    this.metrics = this.freshMetrics();
    this.spawnAccumulator = this.getSpawnInterval();
    this.status = 'running';
    this.clearInteractionFocus();
    this.matter.world.resume();
    this.emitSnapshot();
  }

  public pauseSimulation(): void {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this.matter.world.pause();
    this.emitSnapshot();
  }

  public resetRun(): void {
    this.resetSimulation('build');
    this.emitSnapshot();
  }

  public setSimulationSpeed(speed: number): void {
    if (!Number.isFinite(speed)) return;
    this.simulationSpeed = Phaser.Math.Clamp(speed, MIN_SIMULATION_SPEED, MAX_SIMULATION_SPEED);
    this.emitSnapshot();
  }

  public undo(): void {
    if (!this.canBuild()) return;
    if (this.activeHistory().undo()) {
      this.selectedMachineId = undefined;
      this.selectedObstacleId = undefined;
      this.audio('place');
      this.emitSnapshot();
      this.emitEditorChanged();
    }
  }

  public redo(): void {
    if (!this.canBuild()) return;
    if (this.activeHistory().redo()) {
      this.selectedMachineId = undefined;
      this.selectedObstacleId = undefined;
      this.audio('place');
      this.emitSnapshot();
      this.emitEditorChanged();
    }
  }

  public replaceMachines(machines: readonly MachineState[]): void {
    const fixed = this.contract?.fixedMachines ?? [];
    const prepared = this.normalizeMachineIds(
      machines.filter((machine) => this.mode === 'sandbox' || !machine.fixed),
      false,
      fixed.map((machine) => machine.id),
    );
    const sanitized: MachineState[] = [];
    for (const machine of prepared) {
      const candidate: MachineState = {
        ...machine,
        gridX: Math.max(PLAY_AREA_MIN_COLUMN, Math.min(PLAY_AREA_MAX_COLUMN - 1, machine.gridX)),
        gridY: Math.max(PLAY_AREA_MIN_ROW, Math.min(PLAY_AREA_MAX_ROW - 1, machine.gridY)),
        angle: normalizeAngle(machine.angle),
        fixed: this.isAuthoring(),
      };
      if (this.isMachinePlacementValid(candidate, undefined, [...fixed, ...sanitized])) {
        sanitized.push(candidate);
      }
    }
    this.machines = [...cloneMachines(fixed), ...sanitized];
    this.selectedMachineId = undefined;
    this.history.clear();
    this.rebuildStaticBodies();
    this.updatePlacedPieces();
    this.emitSnapshot();
    this.emitSandboxChange();
  }

  public completeContractForDebug(): void {
    if (!this.contract) return;
    if (this.status !== 'running') {
      this.status = 'running';
      this.matter.world.resume();
    }
    this.metrics.delivered = this.contract.goal.deliveries;
    this.evaluateContract();
  }

  public getSnapshot(): GameSnapshot {
    const selected = this.getSelectedMachine();
    const selectedObstacle = this.getSelectedObstacle();
    return {
      mode: this.mode,
      ...(this.contract ? { contractId: this.contract.id } : {}),
      contractTitle: this.contract?.title ?? SANDBOX_DEFINITION.title,
      contractDescription: this.contract?.description ?? SANDBOX_DEFINITION.description,
      status: this.status,
      metrics: { ...this.metrics },
      ...(this.contract ? { goal: { ...this.contract.goal } } : {}),
      ...(selected ? { selectedMachine: { ...selected } } : {}),
      ...(selectedObstacle ? { selectedObstacle: { ...selectedObstacle } } : {}),
      availableMachines: [...this.availableMachines],
      canUndo: this.activeHistory().canUndo,
      canRedo: this.activeHistory().canRedo,
      muted: this.muted,
      gridEnabled: this.gridEnabled,
      simulationSpeed: this.simulationSpeed,
    };
  }

  private bindApplicationEvents(): void {
    this.eventUnsubscribers.push(
      appEvents.on('ui:start-mode', ({ mode, contractId, contract, machines }) =>
        this.startMode(mode, contractId, machines, contract),
      ),
      appEvents.on('ui:start-editor', ({ contract, isNew }) => this.startEditor(contract, isNew)),
      appEvents.on('ui:editor-tool', ({ type }) => this.selectEditorTool(type)),
      appEvents.on('ui:editor-update-settings', ({ contract }) =>
        this.updateEditorSettings(contract),
      ),
      appEvents.on('ui:editor-test', () => this.beginEditorPreview()),
      appEvents.on('ui:editor-return', () => this.returnToEditor()),
      appEvents.on('ui:editor-mark-saved', ({ contract }) => this.markEditorSaved(contract)),
      appEvents.on('ui:editor-cancel', () => this.cancelEditor()),
      appEvents.on('ui:tool', ({ type }) => this.selectTool(type)),
      appEvents.on('ui:tool-drag', (payload) => this.handleToolDrag(payload)),
      appEvents.on('ui:toggle-simulation', () => this.toggleSimulation()),
      appEvents.on('ui:run', () => this.runSimulation()),
      appEvents.on('ui:pause', () => this.pauseSimulation()),
      appEvents.on('ui:reset', () => this.resetRun()),
      appEvents.on('ui:clear', () => this.clearPlacedMachines()),
      appEvents.on('ui:undo', () => this.undo()),
      appEvents.on('ui:redo', () => this.redo()),
      appEvents.on('ui:delete-selected', () => this.deleteSelected()),
      appEvents.on('ui:reverse-selected', () => this.reverseSelected()),
      appEvents.on('ui:toggle-grid', () => this.toggleGrid()),
      appEvents.on('ui:set-simulation-speed', ({ speed }) => {
        this.setSimulationSpeed(speed);
      }),
      appEvents.on('ui:set-muted', ({ muted }) => {
        this.muted = muted;
        this.emitSnapshot();
      }),
      appEvents.on('ui:replay', () => this.resetRun()),
      appEvents.on('ui:menu', () => {
        if (this.status === 'running') this.pauseSimulation();
      }),
      appEvents.on('debug:set-machines', (machines) => this.replaceMachines(machines)),
    );
  }

  private bindInput(): void {
    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.handlePointerDown, this);
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.handlePointerMove, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.handlePointerUp, this);
    this.input.on(Phaser.Input.Events.POINTER_WHEEL, this.handleWheel, this);

    this.input.keyboard?.on('keydown-SPACE', (event: KeyboardEvent) => {
      event.preventDefault();
      this.toggleSimulation();
    });
    this.input.keyboard?.on('keydown-DELETE', () => this.deleteSelected());
    this.input.keyboard?.on('keydown-BACKSPACE', (event: KeyboardEvent) => {
      event.preventDefault();
      this.deleteSelected();
    });
    this.input.keyboard?.on('keydown-Q', () => this.rotateSelectedBy(-this.rotationStep()));
    this.input.keyboard?.on('keydown-E', () => this.rotateSelectedBy(this.rotationStep()));
    this.input.keyboard?.on('keydown-R', () => this.reverseSelected());
    this.input.keyboard?.on('keydown-Z', (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
    });
    this.input.keyboard?.on('keydown-Y', (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this.redo();
    });

    this.contextMenuHandler = (event: MouseEvent) => event.preventDefault();
    this.game.canvas.addEventListener('contextmenu', this.contextMenuHandler);
  }

  private handleToolDrag(payload: {
    type: MachineType;
    phase: 'start' | 'move' | 'end' | 'cancel';
    clientX: number;
    clientY: number;
  }): void {
    if (payload.phase === 'cancel') {
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      this.ghostMachine = undefined;
      this.ghostObstacle = undefined;
      this.emitSnapshot();
      return;
    }

    if (payload.phase === 'start') {
      this.selectTool(payload.type);
      return;
    }

    const bounds = this.game.canvas.getBoundingClientRect();
    const canvasX = (payload.clientX - bounds.left) * (this.game.canvas.width / bounds.width);
    const canvasY = (payload.clientY - bounds.top) * (this.game.canvas.height / bounds.height);
    const world = this.cameras.main.getWorldPoint(canvasX, canvasY);

    if (payload.phase === 'move') {
      if (!this.isInsideWorld(world)) {
        this.ghostMachine = undefined;
        return;
      }
      const grid = this.machinePositionFromWorld(world);
      this.ghostMachine = {
        id: 'ghost',
        type: payload.type,
        gridX: grid.x,
        gridY: grid.y,
        angle: 0,
        reversed: false,
        fixed: false,
      };
      this.ghostValid =
        this.canPlaceAnotherPiece() && this.isMachinePlacementValid(this.ghostMachine);
      return;
    }

    if (this.isInsideWorld(world)) {
      const grid = this.machinePositionFromWorld(world);
      this.placeMachineAt(payload.type, grid.x, grid.y);
    } else {
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      this.ghostMachine = undefined;
      this.ghostObstacle = undefined;
      this.emitSnapshot();
    }
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (pointer.rightButtonDown()) {
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      this.selectedMachineId = undefined;
      this.selectedObstacleId = undefined;
      this.ghostMachine = undefined;
      this.ghostObstacle = undefined;
      this.emitSnapshot();
      return;
    }
    if (!pointer.leftButtonDown()) return;

    const world = this.pointerWorld(pointer);
    if (!this.isInsideWorld(world)) return;

    if (this.isAuthoring() && this.selectedEditorTool === 'obstacle') {
      this.placeObstacleAt(Math.floor(world.x / CELL_SIZE), Math.floor(world.y / CELL_SIZE));
      return;
    }

    if (this.selectedTool) {
      const grid = this.machinePositionFromWorld(world);
      this.placeMachineAt(this.selectedTool, grid.x, grid.y);
      return;
    }

    const selected = this.getSelectedMachine();
    if (
      selected &&
      this.canEditMachine(selected) &&
      this.isRotatable(selected) &&
      distance(world, rotationHandle(selected)) <= 18 / fromCameraZoom(this.cameras.main.zoom)
    ) {
      this.drag = {
        kind: 'rotate',
        machineId: selected.id,
        before: cloneMachines(this.machines),
        preview: { ...selected },
        valid: true,
        lastScreenX: pointer.x,
        lastScreenY: pointer.y,
      };
      this.emitAngle(pointer, selected.angle, true);
      return;
    }

    const selectedObstacle = this.getSelectedObstacle();
    if (
      selectedObstacle &&
      this.isAuthoring() &&
      distance(world, this.obstacleResizeHandle(selectedObstacle)) <=
        18 / fromCameraZoom(this.cameras.main.zoom)
    ) {
      this.drag = {
        kind: 'obstacle-resize',
        obstacleId: selectedObstacle.id,
        beforeDocument: this.captureEditorDocument(),
        previewObstacle: { ...selectedObstacle },
        valid: true,
        lastScreenX: pointer.x,
        lastScreenY: pointer.y,
      };
      return;
    }

    const hit = this.findMachineAt(world);
    if (hit) {
      this.selectedMachineId = hit.id;
      this.selectedObstacleId = undefined;
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      if (this.canEditMachine(hit) && this.canBuild()) {
        this.drag = {
          kind: 'move',
          machineId: hit.id,
          before: cloneMachines(this.machines),
          preview: { ...hit },
          valid: true,
          lastScreenX: pointer.x,
          lastScreenY: pointer.y,
        };
      }
      this.emitSnapshot();
      return;
    }

    const hitObstacle = this.isAuthoring() ? this.findObstacleAt(world) : undefined;
    if (hitObstacle) {
      this.selectedObstacleId = hitObstacle.id;
      this.selectedMachineId = undefined;
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      this.drag = {
        kind: 'obstacle-move',
        obstacleId: hitObstacle.id,
        beforeDocument: this.captureEditorDocument(),
        previewObstacle: { ...hitObstacle },
        grabOffsetX: world.x / CELL_SIZE - hitObstacle.gridX,
        grabOffsetY: world.y / CELL_SIZE - hitObstacle.gridY,
        valid: true,
        lastScreenX: pointer.x,
        lastScreenY: pointer.y,
      };
      this.emitSnapshot();
      return;
    }

    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.drag = {
      kind: 'pan',
      lastScreenX: pointer.x,
      lastScreenY: pointer.y,
    };
    this.emitSnapshot();
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer): void {
    const world = this.pointerWorld(pointer);

    if (this.drag?.kind === 'pan' && pointer.isDown) {
      const camera = this.cameras.main;
      camera.scrollX -= (pointer.x - this.drag.lastScreenX) / camera.zoom;
      camera.scrollY -= (pointer.y - this.drag.lastScreenY) / camera.zoom;
      this.drag.lastScreenX = pointer.x;
      this.drag.lastScreenY = pointer.y;
      this.emitCamera();
      return;
    }

    if (this.drag?.kind === 'move' && this.drag.preview && pointer.isDown) {
      const grid = this.machinePositionFromWorld(world);
      this.drag.preview = { ...this.drag.preview, gridX: grid.x, gridY: grid.y };
      this.drag.valid = this.isMachinePlacementValid(this.drag.preview, this.drag.machineId);
      return;
    }

    if (this.drag?.kind === 'rotate' && this.drag.preview && pointer.isDown) {
      const center = machineCenter(this.drag.preview);
      const angle = this.snapRotationAngle(
        Phaser.Math.RadToDeg(Math.atan2(world.y - center.y, world.x - center.x)) + 90,
      );
      this.drag.preview = { ...this.drag.preview, angle };
      this.drag.valid = this.isMachinePlacementValid(this.drag.preview, this.drag.machineId);
      this.emitAngle(pointer, angle, true);
      return;
    }

    if (this.drag?.kind === 'obstacle-move' && this.drag.previewObstacle && pointer.isDown) {
      const gridX = Math.round(world.x / CELL_SIZE - (this.drag.grabOffsetX ?? 0));
      const gridY = Math.round(world.y / CELL_SIZE - (this.drag.grabOffsetY ?? 0));
      this.drag.previewObstacle = { ...this.drag.previewObstacle, gridX, gridY };
      this.drag.valid = this.isObstaclePlacementValid(
        this.drag.previewObstacle,
        this.drag.obstacleId,
      );
      return;
    }

    if (this.drag?.kind === 'obstacle-resize' && this.drag.previewObstacle && pointer.isDown) {
      const columns = Math.max(
        1,
        Math.round(world.x / CELL_SIZE - this.drag.previewObstacle.gridX),
      );
      const rows = Math.max(1, Math.round(world.y / CELL_SIZE - this.drag.previewObstacle.gridY));
      this.drag.previewObstacle = { ...this.drag.previewObstacle, columns, rows };
      this.drag.valid = this.isObstaclePlacementValid(
        this.drag.previewObstacle,
        this.drag.obstacleId,
      );
      return;
    }

    if (this.isAuthoring() && this.selectedEditorTool === 'obstacle' && this.isInsideWorld(world)) {
      const gridX = Math.floor(world.x / CELL_SIZE);
      const gridY = Math.floor(world.y / CELL_SIZE);
      this.ghostObstacle = {
        id: 'ghost-obstacle',
        gridX,
        gridY,
        columns: 1,
        rows: 1,
      };
      this.ghostValid = this.isObstaclePlacementValid(this.ghostObstacle);
      this.ghostMachine = undefined;
      return;
    }

    if (this.selectedTool && this.isInsideWorld(world)) {
      const grid = this.machinePositionFromWorld(world);
      const current = this.ghostMachine;
      if (!current || current.gridX !== grid.x || current.gridY !== grid.y) {
        this.ghostMachine = {
          id: 'ghost',
          type: this.selectedTool,
          gridX: grid.x,
          gridY: grid.y,
          angle: 0,
          reversed: false,
          fixed: this.isAuthoring(),
        };
        this.ghostValid =
          (this.isAuthoring() || this.canPlaceAnotherPiece()) &&
          this.isMachinePlacementValid(this.ghostMachine);
      }
    } else {
      this.ghostMachine = undefined;
      this.ghostObstacle = undefined;
    }
  }

  private handlePointerUp(pointer: Phaser.Input.Pointer): void {
    const drag = this.drag;
    this.drag = undefined;
    if (!drag) return;

    if ((drag.kind === 'move' || drag.kind === 'rotate') && drag.preview && drag.before) {
      appEvents.emit('game:angle', {
        angle: drag.preview.angle,
        clientX: 0,
        clientY: 0,
        visible: false,
      });
      const original = drag.before.find((machine) => machine.id === drag.machineId);
      if (!drag.valid || !original) {
        this.toast('Solte a peça em uma área livre.', 'danger');
        this.audio('error');
        return;
      }
      if (sameMachineState(original, drag.preview)) return;

      const after = drag.before.map((machine) =>
        machine.id === drag.machineId ? { ...drag.preview! } : { ...machine },
      );
      this.applyMachines(after);
      this.activeHistory().record(
        createSnapshotCommand({
          label: drag.kind === 'rotate' ? 'Girar peça' : 'Mover peça',
          before: drag.before,
          after,
          apply: (snapshot) => this.applyMachines(snapshot),
          clone: cloneMachines,
        }),
      );
      this.audio('place');
      this.emitSnapshot();
      this.emitEditorChanged();
    }

    if (drag.kind === 'rotate') this.emitAngle(pointer, drag.preview?.angle ?? 0, false);

    if (
      (drag.kind === 'obstacle-move' || drag.kind === 'obstacle-resize') &&
      drag.previewObstacle &&
      drag.beforeDocument
    ) {
      const original = drag.beforeDocument.obstacles.find(
        (obstacle) => obstacle.id === drag.obstacleId,
      );
      if (!drag.valid || !original) {
        this.toast('Solte o bloqueador em uma área livre.', 'danger');
        this.audio('error');
        return;
      }
      if (this.sameObstacleState(original, drag.previewObstacle)) return;
      const after = cloneEditorDocument(drag.beforeDocument);
      after.obstacles = after.obstacles.map((obstacle) =>
        obstacle.id === drag.obstacleId ? { ...drag.previewObstacle! } : obstacle,
      );
      this.applyEditorDocument(after, false);
      this.activeHistory().record(
        createSnapshotCommand({
          label: drag.kind === 'obstacle-resize' ? 'Redimensionar bloqueador' : 'Mover bloqueador',
          before: drag.beforeDocument,
          after,
          apply: (snapshot) => this.applyEditorDocument(snapshot),
          clone: cloneEditorDocument,
        }),
      );
      this.audio('place');
      this.emitSnapshot();
      this.emitEditorChanged();
    }
  }

  private handleWheel(
    pointer: Phaser.Input.Pointer,
    _gameObjects: Phaser.GameObjects.GameObject[],
    _deltaX: number,
    deltaY: number,
  ): void {
    const camera = this.cameras.main;
    const before = camera.getWorldPoint(pointer.x, pointer.y);
    const nextZoom = Phaser.Math.Clamp(
      camera.zoom * Math.exp(-deltaY * 0.0012),
      toCameraZoom(MIN_ZOOM),
      toCameraZoom(MAX_ZOOM),
    );
    camera.setZoom(nextZoom);
    const after = camera.getWorldPoint(pointer.x, pointer.y);
    camera.scrollX += before.x - after.x;
    camera.scrollY += before.y - after.y;
    this.drawGrid();
    this.emitCamera();
  }

  private updateSources(): void {
    const interval = this.getSpawnInterval();
    if (this.spawnAccumulator < interval || this.boxes.size >= 32) return;
    this.spawnAccumulator %= interval;
    for (const source of this.machines.filter((machine) => machine.type === 'source')) {
      this.spawnBox(source);
    }
  }

  private simulateFixedStep(): void {
    this.simulationTimeMs += FIXED_PHYSICS_STEP_MS;
    this.metrics.elapsedSeconds += FIXED_PHYSICS_STEP_SECONDS;
    this.spawnAccumulator += FIXED_PHYSICS_STEP_SECONDS;
    this.updateSources();
    this.updateConveyors();
    this.matter.world.step(FIXED_PHYSICS_STEP_MS);
    this.updateSprings();
    this.updateReceivers();
    this.updateLostBoxes();
    this.evaluateContract();
  }

  private spawnBox(source: MachineState): void {
    const center = machineCenter(source);
    const output = localToWorld(center, source.angle, 0, MACHINE_DIMENSIONS.source.height / 2 + 22);
    const body = this.matter.add.rectangle(output.x, output.y, BOX_SIZE, BOX_SIZE, {
      label: 'factory-box',
      restitution: 0.08,
      friction: 0.24,
      frictionStatic: 0.45,
      frictionAir: 0.002,
      density: 0.002,
      chamfer: { radius: 3 },
    });
    const radians = degreesToRadians(source.angle + 90);
    this.matter.body.setVelocity(body, {
      x: Math.cos(radians) * 0.7,
      y: Math.sin(radians) * 0.7,
    });
    const id = ++this.boxSequence;
    body.plugin = { ...body.plugin, factoryBoxId: id };
    const image = this.add.image(output.x, output.y, BOX_TEXTURE_KEY).setOrigin(0.5).setDepth(11);
    this.boxes.set(id, {
      id,
      body,
      image,
      bornAtSimulationMs: this.simulationVisualTimeMs,
      springReadyAt: 0,
    });
    this.audio('spawn');
  }

  private updateConveyors(): void {
    const conveyors = this.machines.filter((machine) => machine.type === 'conveyor');
    for (const box of this.boxes.values()) {
      for (const conveyor of conveyors) {
        const center = machineCenter(conveyor);
        const local = worldToLocal(center, conveyor.angle, box.body.position);
        const dimensions = MACHINE_DIMENSIONS.conveyor;
        if (
          Math.abs(local.x) > dimensions.width / 2 + BOX_SIZE / 2 ||
          local.y < -BOX_SIZE - dimensions.height / 2 ||
          local.y > dimensions.height / 2 + 5
        ) {
          continue;
        }
        this.matter.body.setVelocity(
          box.body,
          conveyorVelocity(box.body.velocity, conveyor.angle, conveyor.reversed, CONVEYOR_SPEED),
        );
      }
    }
  }

  private updateSprings(): void {
    const springs = this.machines.filter((machine) => machine.type === 'spring');
    for (const box of this.boxes.values()) {
      if (this.simulationTimeMs < box.springReadyAt) continue;
      for (const spring of springs) {
        const center = machineCenter(spring);
        const local = worldToLocal(center, spring.angle, box.body.position);
        const dimensions = MACHINE_DIMENSIONS.spring;
        if (
          Math.abs(local.x) > dimensions.width / 2 + BOX_SIZE / 2 ||
          local.y < -BOX_SIZE - dimensions.height / 2 ||
          local.y > dimensions.height / 2 + 5
        ) {
          continue;
        }

        const radians = degreesToRadians(spring.angle);
        const up = { x: Math.sin(radians), y: -Math.cos(radians) };
        const approachSpeed = box.body.velocity.x * up.x + box.body.velocity.y * up.y;
        if (approachSpeed > 1.5) continue;
        this.matter.body.setVelocity(
          box.body,
          springVelocity(box.body.velocity, spring.angle, SPRING_SPEED),
        );
        box.springReadyAt = this.simulationTimeMs + 360;
        this.springCompression.set(spring.id, 1);
        this.spawnBurst(box.body.position.x, box.body.position.y, COLORS.blueLight, 5);
        this.audio('bounce');
        break;
      }
    }
  }

  private updateReceivers(): void {
    const receivers = this.machines.filter((machine) => machine.type === 'receiver');
    const delivered: BoxRuntime[] = [];
    for (const box of this.boxes.values()) {
      for (const receiver of receivers) {
        const dimensions = MACHINE_DIMENSIONS.receiver;
        if (
          pointInsideOrientedSensor(
            box.body.position,
            machineCenter(receiver),
            dimensions.width,
            dimensions.height,
            receiver.angle,
            5,
          )
        ) {
          delivered.push(box);
          this.receiverPulse.set(receiver.id, 1);
          this.spawnBurst(box.body.position.x, box.body.position.y, COLORS.orange, 10);
          this.audio('deliver');
          break;
        }
      }
    }
    for (const box of delivered) {
      this.removeBox(box);
      this.metrics.delivered += 1;
    }
  }

  private updateLostBoxes(): void {
    const lost: BoxRuntime[] = [];
    for (const box of this.boxes.values()) {
      const { x, y } = box.body.position;
      if (
        x < PLAY_AREA_MIN_X - 100 ||
        x > PLAY_AREA_MAX_X + 100 ||
        y < PLAY_AREA_MIN_Y - 160 ||
        y > PLAY_AREA_MAX_Y + 120
      ) {
        lost.push(box);
      }
    }
    for (const box of lost) {
      this.removeBox(box);
      this.metrics.lost += 1;
      this.audio('error');
    }
  }

  private evaluateContract(): void {
    if (!this.contract || this.status !== 'running') return;
    const evaluation = evaluateRun(this.metrics, this.contract.goal);
    if (!evaluation.resolution) return;

    this.status = evaluation.resolution;
    this.matter.world.pause();
    const stars = this.status === 'success' ? calculateStars(this.contract, this.metrics) : 0;
    if (this.status === 'success') {
      for (let index = 0; index < 42; index += 1) {
        this.particles.push({
          x: STAGE_WIDTH / 2 + Phaser.Math.Between(-180, 180),
          y: STAGE_HEIGHT / 2 + Phaser.Math.Between(-40, 40),
          velocityX: Phaser.Math.FloatBetween(-130, 130),
          velocityY: Phaser.Math.FloatBetween(-190, -60),
          life: Phaser.Math.FloatBetween(0.8, 1.5),
          maxLife: 1.5,
          color: index % 2 === 0 ? COLORS.orange : COLORS.blue,
          size: Phaser.Math.Between(4, 9),
        });
      }
      this.audio('success');
    } else {
      const reason =
        evaluation.reason === 'time' ? 'O tempo acabou.' : 'Muitas caixas foram perdidas.';
      this.toast(reason, 'danger');
      this.audio('error');
    }
    if (!this.editorActive) {
      appEvents.emit('game:result', {
        contractId: this.contract.id,
        stars,
        snapshot: this.getSnapshot(),
      });
    }
    this.emitSnapshot();
  }

  private updateEffects(deltaSeconds: number): void {
    for (const [id, compression] of this.springCompression) {
      const next = Math.max(0, compression - deltaSeconds * 4.8);
      if (next === 0) this.springCompression.delete(id);
      else this.springCompression.set(id, next);
    }
    for (const [id, pulse] of this.receiverPulse) {
      const next = Math.max(0, pulse - deltaSeconds * 2.4);
      if (next === 0) this.receiverPulse.delete(id);
      else this.receiverPulse.set(id, next);
    }
    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      const particle = this.particles[index];
      if (!particle) continue;
      particle.life -= deltaSeconds;
      particle.x += particle.velocityX * deltaSeconds;
      particle.y += particle.velocityY * deltaSeconds;
      particle.velocityY += 320 * deltaSeconds;
      if (particle.life <= 0) this.particles.splice(index, 1);
    }
  }

  private renderWorld(): void {
    const graphics = this.worldGraphics;
    graphics.clear();

    for (const obstacle of this.obstacles) {
      const preview = this.drag?.obstacleId === obstacle.id ? this.drag.previewObstacle : undefined;
      if (!preview) this.drawObstacle(graphics, obstacle);
    }
    for (const machine of this.machines) {
      const preview = this.drag?.machineId === machine.id ? this.drag.preview : undefined;
      this.drawMachine(
        graphics,
        preview ?? machine,
        1,
        preview ? this.drag?.valid !== false : true,
      );
    }
    for (const box of this.boxes.values()) this.drawBox(box);

    const effects = this.effectsGraphics;
    effects.clear();
    for (const particle of this.particles) {
      effects.fillStyle(particle.color, Phaser.Math.Clamp(particle.life / particle.maxLife, 0, 1));
      effects.fillRect(particle.x, particle.y, particle.size, particle.size);
    }

    const overlay = this.overlayGraphics;
    overlay.clear();
    if (this.ghostMachine) this.drawMachine(overlay, this.ghostMachine, 0.42, this.ghostValid);
    if (this.ghostObstacle) {
      this.drawObstacle(overlay, this.ghostObstacle, 0.42, this.ghostValid);
    }
    if (this.drag?.previewObstacle) {
      this.drawObstacle(overlay, this.drag.previewObstacle, 0.72, this.drag.valid !== false);
    }
    const selected = this.drag?.preview ?? this.getSelectedMachine();
    if (selected) this.drawSelection(overlay, selected, this.drag?.valid !== false);
    const selectedObstacle = this.drag?.previewObstacle ?? this.getSelectedObstacle();
    if (selectedObstacle) {
      this.drawObstacleSelection(overlay, selectedObstacle, this.drag?.valid !== false);
    }
  }

  private drawGrid(force = false): void {
    const zoom = fromCameraZoom(this.cameras.main.zoom);
    if (!force && Math.abs(zoom - this.lastGridZoom) < 0.001) return;
    this.lastGridZoom = zoom;
    const graphics = this.gridGraphics;
    graphics.clear();
    graphics.fillStyle(COLORS.board, 1);
    graphics.fillRect(PLAY_AREA_MIN_X, PLAY_AREA_MIN_Y, PLAY_AREA_WIDTH, PLAY_AREA_HEIGHT);

    if (this.gridEnabled) {
      for (let column = PLAY_AREA_MIN_COLUMN; column <= PLAY_AREA_MAX_COLUMN; column += 1) {
        const strong = column % 5 === 0;
        graphics.lineStyle(
          (strong ? 1.35 : 1) / zoom,
          strong ? COLORS.gridStrong : COLORS.grid,
          0.9,
        );
        graphics.lineBetween(
          column * CELL_SIZE,
          PLAY_AREA_MIN_Y,
          column * CELL_SIZE,
          PLAY_AREA_MAX_Y,
        );
      }
      for (let row = PLAY_AREA_MIN_ROW; row <= PLAY_AREA_MAX_ROW; row += 1) {
        const strong = row % 5 === 0;
        graphics.lineStyle(
          (strong ? 1.35 : 1) / zoom,
          strong ? COLORS.gridStrong : COLORS.grid,
          0.9,
        );
        graphics.lineBetween(PLAY_AREA_MIN_X, row * CELL_SIZE, PLAY_AREA_MAX_X, row * CELL_SIZE);
      }
    }
  }

  private drawObstacle(
    graphics: Phaser.GameObjects.Graphics,
    obstacle: ObstacleDefinition,
    alpha = 1,
    valid = true,
  ): void {
    const x = obstacle.gridX * CELL_SIZE;
    const y = obstacle.gridY * CELL_SIZE;
    const width = obstacle.columns * CELL_SIZE;
    const height = obstacle.rows * CELL_SIZE;
    graphics.fillStyle(valid ? COLORS.obstacle : COLORS.red, alpha);
    graphics.fillRect(x, y, width, height);
    graphics.fillStyle(COLORS.graphiteSoft, 0.12 * alpha);
    for (let offset = -height; offset < width; offset += 24) {
      const startX = Math.max(x, x + offset);
      const startY = Math.max(y, y - offset);
      const endX = Math.min(x + width, x + offset + height);
      const endY = Math.min(y + height, y + width - offset);
      graphics.lineStyle(3, COLORS.graphiteSoft, 0.13 * alpha);
      graphics.lineBetween(startX, startY, endX, endY);
    }
  }

  private drawMachine(
    graphics: Phaser.GameObjects.Graphics,
    machine: MachineState,
    alpha: number,
    valid: boolean,
  ): void {
    const color = valid ? COLORS.blue : COLORS.red;
    const center = machineCenter(machine);
    switch (machine.type) {
      case 'source':
        this.drawSource(graphics, machine, center, alpha, valid);
        break;
      case 'conveyor':
        this.drawConveyor(graphics, machine, center, alpha, color);
        break;
      case 'receiver':
        this.drawReceiver(graphics, machine, center, alpha, valid);
        break;
      case 'spring':
        this.drawSpring(graphics, machine, center, alpha, color);
        break;
    }
  }

  private drawSource(
    graphics: Phaser.GameObjects.Graphics,
    machine: MachineState,
    center: Point,
    alpha: number,
    valid: boolean,
  ): void {
    const dimensions = MACHINE_DIMENSIONS.source;
    graphics.fillStyle(valid ? COLORS.graphite : COLORS.red, alpha);
    drawPolygon(
      graphics,
      rectangleCorners(center, dimensions.width, dimensions.height, machine.angle),
    );
    graphics.fillStyle(COLORS.orange, alpha);
    drawPolygon(
      graphics,
      rectangleCorners(
        localToWorld(center, machine.angle, 0, dimensions.height / 2 - 8),
        30,
        16,
        machine.angle,
      ),
    );
    const arrowTop = localToWorld(center, machine.angle, 0, -16);
    const arrowBottom = localToWorld(center, machine.angle, 0, 13);
    const arrowLeft = localToWorld(center, machine.angle, -9, 3);
    const arrowRight = localToWorld(center, machine.angle, 9, 3);
    graphics.lineStyle(5, COLORS.white, alpha);
    graphics.lineBetween(arrowTop.x, arrowTop.y, arrowBottom.x, arrowBottom.y);
    graphics.lineBetween(arrowBottom.x, arrowBottom.y, arrowLeft.x, arrowLeft.y);
    graphics.lineBetween(arrowBottom.x, arrowBottom.y, arrowRight.x, arrowRight.y);
  }

  private drawReceiver(
    graphics: Phaser.GameObjects.Graphics,
    machine: MachineState,
    center: Point,
    alpha: number,
    valid: boolean,
  ): void {
    const dimensions = MACHINE_DIMENSIONS.receiver;
    const pulse = this.receiverPulse.get(machine.id) ?? 0;
    if (pulse > 0) {
      graphics.lineStyle(5, COLORS.orange, pulse * alpha);
      linePolygon(
        graphics,
        rectangleCorners(
          center,
          dimensions.width + pulse * 28,
          dimensions.height + pulse * 28,
          machine.angle,
        ),
      );
    }
    graphics.fillStyle(valid ? COLORS.blue : COLORS.red, alpha);
    drawPolygon(
      graphics,
      rectangleCorners(center, dimensions.width, dimensions.height, machine.angle),
    );
    graphics.fillStyle(COLORS.white, alpha * 0.96);
    drawPolygon(
      graphics,
      rectangleCorners(center, dimensions.width - 24, dimensions.height - 24, machine.angle),
    );
    graphics.fillStyle(COLORS.orange, alpha);
    const tip = localToWorld(center, machine.angle, 0, 13);
    const left = localToWorld(center, machine.angle, -11, -4);
    const right = localToWorld(center, machine.angle, 11, -4);
    drawPolygon(graphics, [tip, left, right]);
  }

  private drawConveyor(
    graphics: Phaser.GameObjects.Graphics,
    machine: MachineState,
    center: Point,
    alpha: number,
    color: number,
  ): void {
    const dimensions = MACHINE_DIMENSIONS.conveyor;
    graphics.fillStyle(color, alpha);
    drawPolygon(
      graphics,
      rectangleCorners(center, dimensions.width, dimensions.height, machine.angle),
    );
    graphics.lineStyle(2, COLORS.graphite, alpha * 0.5);
    linePolygon(
      graphics,
      rectangleCorners(center, dimensions.width, dimensions.height, machine.angle),
    );

    const direction = machine.reversed ? -1 : 1;
    const phase = (((this.simulationVisualTimeMs * 0.07 * direction) % 28) + 28) % 28;
    graphics.lineStyle(3, COLORS.white, alpha * 0.9);
    for (let offset = -42 + phase; offset <= 42; offset += 28) {
      const x = machine.reversed ? -offset : offset;
      const tip = localToWorld(center, machine.angle, x + 6 * direction, 0);
      const upper = localToWorld(center, machine.angle, x - 3 * direction, -6);
      const lower = localToWorld(center, machine.angle, x - 3 * direction, 6);
      graphics.lineBetween(upper.x, upper.y, tip.x, tip.y);
      graphics.lineBetween(tip.x, tip.y, lower.x, lower.y);
    }
  }

  private drawSpring(
    graphics: Phaser.GameObjects.Graphics,
    machine: MachineState,
    center: Point,
    alpha: number,
    color: number,
  ): void {
    const compression = this.springCompression.get(machine.id) ?? 0;
    const dimensions = MACHINE_DIMENSIONS.spring;
    const plateHeight = 8;
    const baseY = dimensions.height / 2 - plateHeight / 2;
    const topY = -dimensions.height / 2 + plateHeight / 2 + compression * 7;
    const lowerSpringY = dimensions.height / 2 - plateHeight;
    const upperSpringY = topY + plateHeight / 2;
    graphics.fillStyle(COLORS.graphite, alpha);
    drawPolygon(
      graphics,
      rectangleCorners(
        localToWorld(center, machine.angle, 0, baseY),
        dimensions.width,
        plateHeight,
        machine.angle,
      ),
    );
    graphics.lineStyle(4, color, alpha);
    const zigzag: Point[] = [];
    for (let index = 0; index <= 6; index += 1) {
      zigzag.push(
        localToWorld(
          center,
          machine.angle,
          -dimensions.width / 2 + 12 + index * ((dimensions.width - 24) / 6),
          index % 2 === 0 ? lowerSpringY : upperSpringY,
        ),
      );
    }
    linePolygon(graphics, zigzag, false);
    graphics.fillStyle(color, alpha);
    drawPolygon(
      graphics,
      rectangleCorners(
        localToWorld(center, machine.angle, 0, topY),
        dimensions.width,
        plateHeight,
        machine.angle,
      ),
    );
  }

  private drawBox(box: BoxRuntime): void {
    const age = Math.min(1, (this.simulationVisualTimeMs - box.bornAtSimulationMs) / 180);
    const speed = Math.hypot(box.body.velocity.x, box.body.velocity.y);
    const stretch = Phaser.Math.Clamp(speed / 28, 0, 0.12);
    const width = BOX_SIZE * (0.8 + age * 0.2 + stretch);
    const height = BOX_SIZE * (1.25 - age * 0.25 - stretch * 0.6);
    box.image
      .setPosition(box.body.position.x, box.body.position.y)
      .setRotation(box.body.angle)
      .setDisplaySize(width * BOX_TEXTURE_SCALE_X, height * BOX_TEXTURE_SCALE_Y);
  }

  private drawSelection(
    graphics: Phaser.GameObjects.Graphics,
    machine: MachineState,
    valid: boolean,
  ): void {
    const dimensions = MACHINE_DIMENSIONS[machine.type];
    const color = valid ? COLORS.orange : COLORS.red;
    const logicalZoom = fromCameraZoom(this.cameras.main.zoom);
    graphics.lineStyle(2 / logicalZoom, color, 0.95);
    linePolygon(
      graphics,
      rectangleCorners(
        centerOf(machine),
        dimensions.width + 14,
        dimensions.height + 14,
        machine.angle,
      ),
    );
    if (!this.canEditMachine(machine) || !this.isRotatable(machine)) return;
    const center = machineCenter(machine);
    const handle = rotationHandle(machine);
    const edge = localToWorld(center, machine.angle, 0, -dimensions.height / 2 - 7);
    graphics.lineStyle(2 / logicalZoom, color, 0.8);
    graphics.lineBetween(edge.x, edge.y, handle.x, handle.y);
    graphics.fillStyle(COLORS.white, 1);
    graphics.fillCircle(handle.x, handle.y, 11 / logicalZoom);
    graphics.lineStyle(3 / logicalZoom, color, 1);
    graphics.strokeCircle(handle.x, handle.y, 11 / logicalZoom);
    const arrowA = localToWorld(handle, machine.angle, -5 / logicalZoom, 1);
    const arrowB = localToWorld(handle, machine.angle, 0, -5 / logicalZoom);
    const arrowC = localToWorld(handle, machine.angle, 5 / logicalZoom, 1);
    graphics.lineBetween(arrowA.x, arrowA.y, arrowB.x, arrowB.y);
    graphics.lineBetween(arrowB.x, arrowB.y, arrowC.x, arrowC.y);
  }

  private drawObstacleSelection(
    graphics: Phaser.GameObjects.Graphics,
    obstacle: ObstacleDefinition,
    valid: boolean,
  ): void {
    if (!this.isAuthoring()) return;
    const logicalZoom = fromCameraZoom(this.cameras.main.zoom);
    const color = valid ? COLORS.orange : COLORS.red;
    const x = obstacle.gridX * CELL_SIZE;
    const y = obstacle.gridY * CELL_SIZE;
    const width = obstacle.columns * CELL_SIZE;
    const height = obstacle.rows * CELL_SIZE;
    graphics.lineStyle(3 / logicalZoom, color, 1);
    graphics.strokeRect(
      x - 4 / logicalZoom,
      y - 4 / logicalZoom,
      width + 8 / logicalZoom,
      height + 8 / logicalZoom,
    );
    const handle = this.obstacleResizeHandle(obstacle);
    const size = 13 / logicalZoom;
    graphics.fillStyle(COLORS.white, 1);
    graphics.fillRect(handle.x - size, handle.y - size, size * 2, size * 2);
    graphics.lineStyle(3 / logicalZoom, color, 1);
    graphics.strokeRect(handle.x - size, handle.y - size, size * 2, size * 2);
    graphics.lineBetween(
      handle.x - size * 0.5,
      handle.y + size * 0.5,
      handle.x + size * 0.5,
      handle.y - size * 0.5,
    );
  }

  private rebuildStaticBodies(): void {
    for (const runtime of this.machineBodies.values()) this.matter.world.remove(runtime.body, true);
    this.machineBodies.clear();
    for (const body of this.obstacleBodies) this.matter.world.remove(body, true);
    this.obstacleBodies.length = 0;

    for (const obstacle of this.obstacles) {
      const width = obstacle.columns * CELL_SIZE;
      const height = obstacle.rows * CELL_SIZE;
      const body = this.matter.add.rectangle(
        obstacle.gridX * CELL_SIZE + width / 2,
        obstacle.gridY * CELL_SIZE + height / 2,
        width,
        height,
        { isStatic: true, label: `obstacle:${obstacle.id}`, friction: 0.6 },
      );
      this.obstacleBodies.push(body);
    }

    for (const machine of this.machines) {
      const center = machineCenter(machine);
      const dimensions = MACHINE_DIMENSIONS[machine.type];
      const body = this.matter.add.rectangle(
        center.x,
        center.y,
        dimensions.width,
        dimensions.height,
        {
          isStatic: true,
          isSensor: machine.type === 'receiver' || machine.type === 'source',
          label: `machine:${machine.id}`,
          friction: machine.type === 'conveyor' ? 0.05 : 0.5,
          restitution: machine.type === 'spring' ? 0.05 : 0,
          chamfer: { radius: machine.type === 'conveyor' || machine.type === 'spring' ? 3 : 5 },
        },
      );
      this.matter.body.setAngle(body, degreesToRadians(machine.angle));
      body.plugin = { ...body.plugin, factoryMachineId: machine.id, factoryType: machine.type };
      this.machineBodies.set(machine.id, { machine, body });
    }

    if (this.status !== 'running') this.matter.world.pause();
  }

  private isMachinePlacementValid(
    candidate: MachineState,
    ignoredId?: string,
    machines = this.machines,
  ): boolean {
    const polygon = machinePolygon(candidate);
    if (
      !polygonWithinBounds(polygon, PLAY_AREA_WIDTH, PLAY_AREA_HEIGHT, 3, {
        x: PLAY_AREA_MIN_X,
        y: PLAY_AREA_MIN_Y,
      })
    ) {
      return false;
    }
    for (const machine of machines) {
      if (machine.id === ignoredId) continue;
      if (polygonsOverlap(polygon, machinePolygon(machine))) return false;
    }
    for (const obstacle of this.obstacles) {
      const width = obstacle.columns * CELL_SIZE;
      const height = obstacle.rows * CELL_SIZE;
      const obstaclePolygon = rectangleCorners(
        {
          x: obstacle.gridX * CELL_SIZE + width / 2,
          y: obstacle.gridY * CELL_SIZE + height / 2,
        },
        width,
        height,
      );
      if (polygonsOverlap(polygon, obstaclePolygon)) return false;
    }
    return true;
  }

  private isObstaclePlacementValid(candidate: ObstacleDefinition, ignoredId?: string): boolean {
    if (
      !Number.isInteger(candidate.gridX) ||
      !Number.isInteger(candidate.gridY) ||
      !Number.isInteger(candidate.columns) ||
      !Number.isInteger(candidate.rows) ||
      candidate.columns < 1 ||
      candidate.rows < 1 ||
      candidate.gridX < PLAY_AREA_MIN_COLUMN ||
      candidate.gridY < PLAY_AREA_MIN_ROW ||
      candidate.gridX + candidate.columns > PLAY_AREA_MAX_COLUMN ||
      candidate.gridY + candidate.rows > PLAY_AREA_MAX_ROW
    ) {
      return false;
    }

    const polygon = this.obstaclePolygon(candidate);
    for (const obstacle of this.obstacles) {
      if (obstacle.id === ignoredId) continue;
      if (polygonsOverlap(polygon, this.obstaclePolygon(obstacle))) return false;
    }
    for (const machine of this.machines) {
      if (polygonsOverlap(polygon, machinePolygon(machine))) return false;
    }
    return true;
  }

  private obstaclePolygon(obstacle: ObstacleDefinition): Point[] {
    const width = obstacle.columns * CELL_SIZE;
    const height = obstacle.rows * CELL_SIZE;
    return rectangleCorners(
      {
        x: obstacle.gridX * CELL_SIZE + width / 2,
        y: obstacle.gridY * CELL_SIZE + height / 2,
      },
      width,
      height,
    );
  }

  private executeSnapshotCommand(
    label: string,
    before: MachineState[],
    after: MachineState[],
  ): void {
    this.activeHistory().execute(
      createSnapshotCommand({
        label,
        before,
        after,
        apply: (snapshot) => this.applyMachines(snapshot),
        clone: cloneMachines,
      }),
    );
  }

  private replaceMachineWithHistory(
    previous: MachineState,
    next: MachineState,
    label: string,
  ): void {
    const before = cloneMachines(this.machines);
    const after = before.map((machine) => (machine.id === previous.id ? { ...next } : machine));
    this.executeSnapshotCommand(label, before, after);
    this.emitSnapshot();
  }

  private applyMachines(snapshot: readonly MachineState[]): void {
    this.machines = cloneMachines(snapshot);
    this.updatePlacedPieces();
    this.rebuildStaticBodies();
    this.emitSandboxChange();
    this.emitEditorChanged();
  }

  private executeEditorSnapshotCommand(
    label: string,
    before: EditorDocument,
    after: EditorDocument,
  ): void {
    this.activeHistory().execute(
      createSnapshotCommand({
        label,
        before,
        after,
        apply: (snapshot) => this.applyEditorDocument(snapshot),
        clone: cloneEditorDocument,
      }),
    );
  }

  private captureEditorDocument(): EditorDocument {
    return {
      machines: cloneMachines(this.machines),
      obstacles: cloneObstacles(this.obstacles),
    };
  }

  private applyEditorDocument(document: EditorDocument, notify = true): void {
    this.machines = cloneMachines(document.machines).map((machine) => ({
      ...machine,
      fixed: this.isAuthoring() ? true : machine.fixed,
    }));
    this.obstacles = cloneObstacles(document.obstacles);
    this.updatePlacedPieces();
    this.rebuildStaticBodies();
    if (notify) this.emitEditorChanged();
  }

  private replaceObstacleWithHistory(
    previous: ObstacleDefinition,
    next: ObstacleDefinition,
    label: string,
  ): void {
    const before = this.captureEditorDocument();
    const after = cloneEditorDocument(before);
    after.obstacles = after.obstacles.map((obstacle) =>
      obstacle.id === previous.id ? { ...next } : obstacle,
    );
    this.executeEditorSnapshotCommand(label, before, after);
    this.emitSnapshot();
    this.emitEditorChanged();
  }

  private clearPlacedMachines(): void {
    if (!this.canBuild()) return;
    const before = cloneMachines(this.machines);
    const after = before.filter((machine) => machine.fixed);
    if (before.length === after.length) return;
    this.executeSnapshotCommand('Limpar construção', before, after);
    this.selectedMachineId = undefined;
    this.emitSnapshot();
  }

  private resetSimulation(nextStatus: SimulationStatus): void {
    this.clearBoxes();
    this.metrics = this.freshMetrics();
    this.spawnAccumulator = 0;
    this.physicsAccumulator = 0;
    this.simulationTimeMs = 0;
    this.simulationVisualTimeMs = 0;
    this.status = nextStatus;
    this.matter.world.pause();
  }

  private freshMetrics(): RunMetrics {
    return {
      delivered: 0,
      lost: 0,
      active: 0,
      elapsedSeconds: 0,
      placedPieces: this.machines.filter((machine) => !machine.fixed).length,
    };
  }

  private clearBoxes(): void {
    for (const box of this.boxes.values()) {
      box.image.destroy();
      this.matter.world.remove(box.body, true);
    }
    this.boxes.clear();
    this.metrics.active = 0;
  }

  private removeBox(box: BoxRuntime): void {
    box.image.destroy();
    this.matter.world.remove(box.body, true);
    this.boxes.delete(box.id);
  }

  private getSelectedMachine(): MachineState | undefined {
    return this.machines.find((machine) => machine.id === this.selectedMachineId);
  }

  private getSelectedObstacle(): ObstacleDefinition | undefined {
    return this.obstacles.find((obstacle) => obstacle.id === this.selectedObstacleId);
  }

  private findMachineAt(point: Point): MachineState | undefined {
    return [...this.machines].reverse().find((machine) => pointInsideMachine(point, machine, 7));
  }

  private findObstacleAt(point: Point): ObstacleDefinition | undefined {
    return [...this.obstacles].reverse().find((obstacle) => {
      const x = obstacle.gridX * CELL_SIZE;
      const y = obstacle.gridY * CELL_SIZE;
      return (
        point.x >= x &&
        point.x <= x + obstacle.columns * CELL_SIZE &&
        point.y >= y &&
        point.y <= y + obstacle.rows * CELL_SIZE
      );
    });
  }

  private obstacleResizeHandle(obstacle: ObstacleDefinition): Point {
    return {
      x: (obstacle.gridX + obstacle.columns) * CELL_SIZE,
      y: (obstacle.gridY + obstacle.rows) * CELL_SIZE,
    };
  }

  private sameObstacleState(a: ObstacleDefinition, b: ObstacleDefinition): boolean {
    return (
      a.id === b.id &&
      a.gridX === b.gridX &&
      a.gridY === b.gridY &&
      a.columns === b.columns &&
      a.rows === b.rows
    );
  }

  private rotateSelectedBy(delta: number): void {
    const selected = this.getSelectedMachine();
    if (selected) this.rotateSelectedTo(selected.angle + delta);
  }

  private toggleGrid(): void {
    if (!this.canBuild()) {
      this.toast('Pause a simulação para alterar a grade.', 'neutral');
      return;
    }
    this.gridEnabled = !this.gridEnabled;
    this.ghostMachine = undefined;
    this.drawGrid(true);
    this.emitSnapshot();
  }

  private rotationStep(): number {
    return this.gridEnabled ? GRID_ROTATION_STEP : 1;
  }

  private snapRotationAngle(angle: number): number {
    const step = this.rotationStep();
    return normalizeAngle(Math.round(angle / step) * step);
  }

  private machinePositionFromWorld(point: Point): { x: number; y: number } {
    if (this.gridEnabled) {
      const snap = (coordinate: number) =>
        Math.round((coordinate / CELL_SIZE - 0.5) / GRID_POSITION_STEP) * GRID_POSITION_STEP;
      return {
        x: snap(point.x),
        y: snap(point.y),
      };
    }
    return {
      x: Math.round((point.x / CELL_SIZE - 0.5) * 1000) / 1000,
      y: Math.round((point.y / CELL_SIZE - 0.5) * 1000) / 1000,
    };
  }

  private isRotatable(machine: MachineState): boolean {
    return (
      machine.type === 'conveyor' ||
      machine.type === 'spring' ||
      (this.isAuthoring() && (machine.type === 'source' || machine.type === 'receiver'))
    );
  }

  private canEditMachine(machine: MachineState): boolean {
    return this.isAuthoring() || !machine.fixed;
  }

  private isAuthoring(): boolean {
    return this.editorActive && !this.editorPreview;
  }

  private activeHistory(): CommandHistory {
    return this.isAuthoring() ? this.editorHistory : this.history;
  }

  private canBuild(): boolean {
    return this.status === 'build' || this.status === 'paused';
  }

  private canPlaceAnotherPiece(): boolean {
    if (!this.contract) return true;
    return isWithinPieceBudget(this.metrics.placedPieces, this.contract.goal);
  }

  private updatePlacedPieces(): void {
    this.metrics.placedPieces = this.machines.filter((machine) => !machine.fixed).length;
  }

  private getSpawnInterval(): number {
    return this.contract?.spawnIntervalSeconds ?? 1.25;
  }

  private createMachineId(reserved: ReadonlySet<string> = new Set()): string {
    let id: string;
    do {
      id = `machine-${++this.machineSequence}`;
    } while (reserved.has(id) || this.machines.some((machine) => machine.id === id));
    return id;
  }

  private createObstacleId(reserved: ReadonlySet<string> = new Set()): string {
    let id: string;
    do {
      id = `obstacle-${++this.obstacleSequence}`;
    } while (reserved.has(id) || this.obstacles.some((obstacle) => obstacle.id === id));
    return id;
  }

  private normalizeObstacles(obstacles: readonly ObstacleDefinition[]): ObstacleDefinition[] {
    this.obstacleSequence = 0;
    const used = new Set<string>();
    for (const id of obstacles.map((obstacle) => obstacle.id)) {
      const match = /^obstacle-(\d+)$/.exec(id);
      if (match?.[1]) this.obstacleSequence = Math.max(this.obstacleSequence, Number(match[1]));
    }
    return obstacles.map((obstacle) => {
      let id = obstacle.id.trim();
      if (!id || used.has(id)) id = this.createObstacleId(used);
      used.add(id);
      return {
        ...obstacle,
        id,
        gridX: Math.round(obstacle.gridX),
        gridY: Math.round(obstacle.gridY),
        columns: Math.max(1, Math.round(obstacle.columns)),
        rows: Math.max(1, Math.round(obstacle.rows)),
      };
    });
  }

  private normalizeMachineIds(
    machines: readonly MachineState[],
    preserveFixed: boolean,
    reservedIds: readonly string[] = [],
  ): MachineState[] {
    this.machineSequence = 0;
    const used = new Set(reservedIds);
    for (const id of [...reservedIds, ...machines.map((machine) => machine.id)]) {
      const match = /^machine-(\d+)$/.exec(id);
      if (match?.[1]) this.machineSequence = Math.max(this.machineSequence, Number(match[1]));
    }

    return machines.map((machine) => {
      let id = machine.id.trim();
      if (!id || used.has(id)) id = this.createMachineId(used);
      used.add(id);
      return {
        ...machine,
        id,
        angle: normalizeAngle(machine.angle),
        fixed: preserveFixed ? machine.fixed : false,
      };
    });
  }

  private emitSnapshot(): void {
    appEvents.emit('game:snapshot', this.getSnapshot());
  }

  private serializeEditorContract(contract: ContractDefinition): string {
    return JSON.stringify({
      ...contract,
      fixedMachines: [...contract.fixedMachines]
        .map((machine) => ({ ...machine, fixed: true }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      obstacles: [...contract.obstacles].sort((a, b) => a.id.localeCompare(b.id)),
      availableMachines: [...contract.availableMachines].sort(),
    });
  }

  private emitEditorChanged(): void {
    if (!this.isAuthoring() || !this.editorContract) return;
    const contract = this.getEditorDraft();
    appEvents.emit('game:editor-changed', {
      contract,
      dirty: this.serializeEditorContract(contract) !== this.editorBaseline,
    });
  }

  private emitCamera(): void {
    const camera = this.cameras.main;
    appEvents.emit('game:camera', {
      zoom: fromCameraZoom(camera.zoom),
      scrollX: camera.scrollX,
      scrollY: camera.scrollY,
    });
  }

  private emitSandboxChange(): void {
    if (this.mode !== 'sandbox') return;
    appEvents.emit('game:sandbox-changed', cloneMachines(this.machines));
  }

  private emitAngle(pointer: Phaser.Input.Pointer, angle: number, visible: boolean): void {
    const rect = this.game.canvas.getBoundingClientRect();
    const scaleX = rect.width / this.game.canvas.width;
    const scaleY = rect.height / this.game.canvas.height;
    appEvents.emit('game:angle', {
      angle: normalizeAngle(angle),
      clientX: rect.left + pointer.x * scaleX,
      clientY: rect.top + pointer.y * scaleY,
      visible,
    });
  }

  private toast(message: string, tone: 'neutral' | 'success' | 'danger'): void {
    appEvents.emit('game:toast', { message, tone });
  }

  private audio(kind: 'spawn' | 'place' | 'bounce' | 'deliver' | 'error' | 'success'): void {
    if (!this.muted) appEvents.emit('game:audio', { kind });
  }

  private spawnBurst(x: number, y: number, color: number, count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.particles.push({
        x,
        y,
        velocityX: Phaser.Math.FloatBetween(-85, 85),
        velocityY: Phaser.Math.FloatBetween(-105, -25),
        life: Phaser.Math.FloatBetween(0.3, 0.7),
        maxLife: 0.7,
        color,
        size: Phaser.Math.Between(3, 7),
      });
    }
  }

  private pointerWorld(pointer: Phaser.Input.Pointer): Point {
    return this.cameras.main.getWorldPoint(pointer.x, pointer.y);
  }

  private isInsideWorld(point: Point): boolean {
    return (
      point.x >= PLAY_AREA_MIN_X &&
      point.x <= PLAY_AREA_MAX_X &&
      point.y >= PLAY_AREA_MIN_Y &&
      point.y <= PLAY_AREA_MAX_Y
    );
  }

  private fitCamera(): void {
    const camera = this.cameras.main;
    const fit =
      Math.min(
        camera.width / DISPLAY_DENSITY / STAGE_WIDTH,
        camera.height / DISPLAY_DENSITY / STAGE_HEIGHT,
      ) * 0.92;
    camera.setZoom(toCameraZoom(Phaser.Math.Clamp(fit, MIN_ZOOM, 1.12)));
    camera.centerOn(STAGE_WIDTH / 2, STAGE_HEIGHT / 2);
    this.drawGrid(true);
    this.emitCamera();
  }

  private handleResize(): void {
    this.fitCamera();
  }

  private installDebugApi(): void {
    window.__FACTORY_DEBUG__ = {
      getSnapshot: () => this.getSnapshot(),
      getMachines: () => cloneMachines(this.machines),
      getObstacles: () => cloneObstacles(this.obstacles),
      getBoxes: () =>
        [...this.boxes.values()].map(({ body }) => ({
          x: body.position.x,
          y: body.position.y,
          velocityX: body.velocity.x,
          velocityY: body.velocity.y,
        })),
      getCamera: () => ({
        scrollX: this.cameras.main.scrollX,
        scrollY: this.cameras.main.scrollY,
        zoom: fromCameraZoom(this.cameras.main.zoom),
      }),
      getWorldBounds: () => ({
        minX: PLAY_AREA_MIN_X,
        minY: PLAY_AREA_MIN_Y,
        maxX: PLAY_AREA_MAX_X,
        maxY: PLAY_AREA_MAX_Y,
        width: PLAY_AREA_WIDTH,
        height: PLAY_AREA_HEIGHT,
      }),
      startMode: (mode, contractId) => this.startMode(mode, contractId),
      startEditor: (contract) => this.startEditor(contract),
      getEditorDraft: () => this.getEditorDraft(),
      selectEditorTool: (type) => this.selectEditorTool(type),
      selectTool: (type) => this.selectTool(type),
      placeMachine: (type, gridX, gridY, angle) => this.placeMachineAt(type, gridX, gridY, angle),
      selectMachine: (id) => this.selectMachine(id),
      rotateSelected: (angle) => this.rotateSelectedTo(angle),
      reverseSelected: () => this.reverseSelected(),
      deleteSelected: () => this.deleteSelected(),
      placeObstacle: (gridX, gridY, columns, rows) =>
        this.placeObstacleAt(gridX, gridY, columns, rows),
      selectObstacle: (id) => this.selectObstacle(id),
      moveSelectedObstacle: (gridX, gridY) => this.moveSelectedObstacle(gridX, gridY),
      resizeSelectedObstacle: (columns, rows) => this.resizeSelectedObstacle(columns, rows),
      beginEditorPreview: () => this.beginEditorPreview(),
      returnToEditor: () => this.returnToEditor(),
      run: () => this.runSimulation(),
      pause: () => this.pauseSimulation(),
      reset: () => this.resetRun(),
      undo: () => this.undo(),
      redo: () => this.redo(),
      setMachines: (machines) => this.replaceMachines(machines),
      setSimulationSpeed: (speed) => this.setSimulationSpeed(speed),
      advance: (seconds) => {
        if (this.status !== 'running') this.runSimulation();
        const steps = Math.max(0, Math.min(60 * 120, Math.round(seconds * 60)));
        for (let index = 0; index < steps && this.status === 'running'; index += 1) {
          this.simulateFixedStep();
        }
        this.metrics.active = this.boxes.size;
        this.renderWorld();
        this.emitSnapshot();
        return this.getSnapshot();
      },
      completeContract: () => this.completeContractForDebug(),
    };
  }

  private destroyScene(): void {
    for (const unsubscribe of this.eventUnsubscribers) unsubscribe();
    this.eventUnsubscribers.length = 0;
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    if (this.contextMenuHandler) {
      this.game.canvas.removeEventListener('contextmenu', this.contextMenuHandler);
    }
    if (window.__FACTORY_DEBUG__) delete window.__FACTORY_DEBUG__;
  }
}

function centerOf(machine: MachineState): Point {
  return gridToWorld({ x: machine.gridX, y: machine.gridY });
}
