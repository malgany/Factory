import Phaser from 'phaser';

import factoryBoxTextureUrl from '../assets/factory-box-game.png?url';
import { appEvents } from '../core/events';
import { getContract, SANDBOX_DEFINITION } from '../domain/contracts';
import { resolveConveyorSpeedCosts } from '../domain/economy';
import { CommandHistory, createSnapshotCommand } from '../domain/history';
import { evaluateRun } from '../domain/rules';
import {
  CELL_SIZE,
  COLLECTIBLE_STAR_RADIUS,
  GRID_COLUMNS,
  GRID_ROWS,
  PLAY_AREA_MAX_COLUMN,
  PLAY_AREA_MAX_ROW,
  PLAY_AREA_MIN_COLUMN,
  PLAY_AREA_MIN_ROW,
  type ContractCamera,
  type ContractDefinition,
  type ContractId,
  type ConveyorSpeed,
  type CollectibleDefinition,
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
  MACHINE_PHYSICS_DIMENSIONS,
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
  boxTouchesOrientedSurface,
  conveyorSpeedFactor,
  conveyorVelocity,
  FIXED_PHYSICS_STEP_SECONDS,
  pointInsideOrientedSensor,
  SPRING_LAUNCH_SPEED,
  springVelocity,
  TURBO_SPRING_LAUNCH_SPEED,
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
const GRID_POSITION_STEP = 0.25;
const MIN_SIMULATION_SPEED = 0.1;
const MAX_SIMULATION_SPEED = 5;
const BOX_SIZE = 28;
const BOX_TEXTURE_KEY = 'factory-box';
const BOX_TEXTURE_SCALE_X = 1.2;
const BOX_TEXTURE_SCALE_Y = 1.18;
const STAR_PICKUP_RADIUS = 30;
const STAR_RENDER_RADIUS = COLLECTIBLE_STAR_RADIUS;
const CONVEYOR_SPEED = 4.2;
const TRACKED_CONVEYOR_WHEEL_RADIUS = 6.5;
const TRACKED_CONVEYOR_TRACK_RADIUS = 8.5;
const TRACKED_CONVEYOR_LINK_WIDTH = 7.5;
const TRACKED_CONVEYOR_LINK_HEIGHT = 4;
const TRACKED_CONVEYOR_LINK_COUNT = 24;
const TRACKED_CONVEYOR_SPEED = 2.38;
const TRACKED_CONVEYOR_STRAIGHT_LENGTH = 64;
const TRACKED_CONVEYOR_ARC_LENGTH = Math.PI * TRACKED_CONVEYOR_TRACK_RADIUS;
const TRACKED_CONVEYOR_TRACK_LENGTH =
  TRACKED_CONVEYOR_STRAIGHT_LENGTH * 2 + TRACKED_CONVEYOR_ARC_LENGTH * 2;
const FIXED_PHYSICS_STEP_MS = FIXED_PHYSICS_STEP_SECONDS * 1000;
const INVALID_ENTITY_FLASH_DURATION_MS = 2_000;
const INVALID_ENTITY_FLASH_INTERVAL_MS = 180;

const COLORS = {
  board: 0x3475b8,
  grid: 0x78a6d0,
  gridStrong: 0xe8f3fc,
  graphite: 0x293139,
  graphiteSoft: 0x5f6a72,
  blue: 0x527da5,
  blueLight: 0x82a5c5,
  machinePanel: 0x202a33,
  machineRecess: 0x354553,
  receiverBorder: 0x258bc4,
  receiverBezel: 0xe4e7e9,
  conveyor: 0x40566b,
  fixedPanel: 0x3f4b55,
  fixedConveyor: 0x596d7e,
  fixedHighlight: 0xd8dde1,
  fixedOutline: 0x4d5963,
  fixedSpring: 0x4ca865,
  fixedWood: 0x9d7d61,
  springGreen: 0x25c442,
  wood: 0xb47a48,
  turboSpringRed: 0xff2638,
  turboSteel: 0xaeb9c1,
  turboSteelLight: 0xe7edf1,
  fixedTurboSpring: 0xc75a62,
  fixedTurboSteel: 0x929da5,
  orange: 0xff7629,
  white: 0xffffff,
  green: 0x35a26b,
  red: 0xd95050,
  hitbox: 0xff3158,
  obstacle: 0xb9c0c2,
  star: 0xffc247,
  starLight: 0xfff2a6,
  starDark: 0xc97819,
} as const;

interface PhysicsMachine {
  machine: MachineState;
  body: MatterJS.BodyType;
}

interface TrackedConveyorRuntime {
  machine: MachineState;
  composite: MatterJS.CompositeType;
  wheels: MatterJS.BodyType[];
  links: MatterJS.BodyType[];
  phase: number;
}

interface TrackedConveyorLinkLayout {
  center: Point;
  angle: number;
}

interface BoxRuntime {
  id: number;
  body: MatterJS.BodyType;
  image: Phaser.GameObjects.Image;
  bornAtSimulationMs: number;
  springReadyAt: number;
  velocityBeforePhysics: Point;
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
  kind:
    | 'move'
    | 'group-move'
    | 'rotate'
    | 'obstacle-move'
    | 'obstacle-resize'
    | 'obstacle-rotate'
    | 'collectible-move'
    | 'pan'
    | 'marquee';
  machineId?: string;
  before?: MachineState[];
  preview?: MachineState;
  previewMachines?: MachineState[];
  obstacleId?: string;
  beforeDocument?: EditorDocument;
  previewObstacle?: ObstacleDefinition;
  previewObstacles?: ObstacleDefinition[];
  previewCollectibles?: CollectibleDefinition[];
  obstacleResizeHandle?: ObstacleResizeHandle;
  obstacleResizeAnchor?: Point;
  collectibleId?: string;
  previewCollectible?: CollectibleDefinition;
  grabOffsetX?: number;
  grabOffsetY?: number;
  startWorld?: Point;
  currentWorld?: Point;
  valid?: boolean;
  lastScreenX: number;
  lastScreenY: number;
}

type MachineClipboard = Pick<
  MachineState,
  'type' | 'angle' | 'reversed' | 'conveyorSpeed' | 'fixed'
>;
type ObstacleClipboard = Pick<ObstacleDefinition, 'columns' | 'rows' | 'angle'>;
type CollectibleClipboard = Pick<CollectibleDefinition, 'type'>;

interface GroupClipboard {
  machines: MachineState[];
  obstacles: ObstacleDefinition[];
  collectibles: CollectibleDefinition[];
  origin: Point;
}

interface EditorDocument {
  machines: MachineState[];
  obstacles: ObstacleDefinition[];
  collectibles: CollectibleDefinition[];
}

type ResizeDirection = -1 | 0 | 1;

interface ObstacleResizeHandle {
  x: ResizeDirection;
  y: ResizeDirection;
}

const OBSTACLE_RESIZE_HANDLES: readonly ObstacleResizeHandle[] = [
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
];

export type EditorTool = MachineType | 'obstacle' | 'star';

interface EditorAuthoringState {
  contract: ContractDefinition;
  document: EditorDocument;
}

interface InvalidEntityFlash {
  machineIds: Set<string>;
  obstacleIds: Set<string>;
  collectibleIds: Set<string>;
  startedAt: number;
  endsAt: number;
}

export interface FactoryDebugApi {
  getSnapshot(): GameSnapshot;
  getSimulationSeconds(): number;
  getMachines(): MachineState[];
  getObstacles(): ObstacleDefinition[];
  getCollectibles(): CollectibleDefinition[];
  getBoxes(): Array<{ x: number; y: number; velocityX: number; velocityY: number }>;
  getCamera(): {
    scrollX: number;
    scrollY: number;
    centerX: number;
    centerY: number;
    zoom: number;
  };
  setCamera(centerX: number, centerY: number, zoom: number): void;
  getWorldBounds(): WorldBounds;
  startMode(mode: GameMode, contractId?: ContractId): void;
  startEditor(contract: ContractDefinition): void;
  getEditorDraft(): ContractDefinition;
  getInvalidEntityFlash(): {
    machineIds: string[];
    obstacleIds: string[];
    collectibleIds: string[];
    remainingMs: number;
  };
  getEditorHitboxesVisible(): boolean;
  selectEditorTool(type: EditorTool): void;
  selectTool(type: MachineType): void;
  placeMachine(type: MachineType, gridX: number, gridY: number, angle?: number): boolean;
  selectMachine(id: string): boolean;
  selectArea(minX: number, minY: number, maxX: number, maxY: number): number;
  rotateSelected(angle: number): boolean;
  reverseSelected(): boolean;
  deleteSelected(): boolean;
  copySelected(): boolean;
  cutSelected(): boolean;
  placeObstacle(gridX: number, gridY: number, columns?: number, rows?: number): boolean;
  selectObstacle(id: string): boolean;
  moveSelectedObstacle(gridX: number, gridY: number): boolean;
  resizeSelectedObstacle(columns: number, rows: number): boolean;
  rotateSelectedObstacle(angle: number): boolean;
  placeCollectible(gridX: number, gridY: number): boolean;
  selectCollectible(id: string): boolean;
  moveSelectedCollectible(gridX: number, gridY: number): boolean;
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

function cloneCollectibles(
  collectibles: readonly CollectibleDefinition[],
): CollectibleDefinition[] {
  return collectibles.map((collectible) => ({ ...collectible }));
}

function cloneEditorDocument(document: EditorDocument): EditorDocument {
  return {
    machines: cloneMachines(document.machines),
    obstacles: cloneObstacles(document.obstacles),
    collectibles: cloneCollectibles(document.collectibles),
  };
}

function activeMachineType(type: MachineType): MachineType {
  return type === 'conveyor' ? 'tracked-conveyor' : type;
}

function isConveyorType(type: MachineType): boolean {
  return type === 'conveyor' || type === 'tracked-conveyor';
}

function isSpringType(type: MachineType): boolean {
  return type === 'spring' || type === 'turbo-spring';
}

function entityIndexFromValidationPath(
  path: string,
  collection: 'fixedMachines' | 'obstacles' | 'collectibles',
): number | undefined {
  const match = new RegExp(`^${collection}\\.(\\d+)(?:\\.|$)`).exec(path);
  if (!match?.[1]) return undefined;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : undefined;
}

function conveyorSpeed(machine: Pick<MachineState, 'type' | 'conveyorSpeed'>): ConveyorSpeed {
  return isConveyorType(machine.type) ? (machine.conveyorSpeed ?? 'normal') : 'normal';
}

function conveyorSpeedMultiplier(
  machine: Pick<MachineState, 'type' | 'conveyorSpeed'>,
): number {
  return conveyorSpeedFactor(conveyorSpeed(machine));
}

function normalizeAvailableMachineTypes(types: readonly MachineType[]): MachineType[] {
  return [...new Set(types.map(activeMachineType))];
}

function cloneContract(contract: ContractDefinition): ContractDefinition {
  return {
    ...contract,
    grid: { ...contract.grid },
    goal: { ...contract.goal },
    economy: {
      ...contract.economy,
      machineCosts: { ...contract.economy.machineCosts },
      ...(contract.economy.conveyorSpeedCosts
        ? { conveyorSpeedCosts: { ...contract.economy.conveyorSpeedCosts } }
        : {}),
    },
    initialCamera: { ...contract.initialCamera },
    availableMachines: normalizeAvailableMachineTypes(contract.availableMachines),
    fixedMachines: cloneMachines(contract.fixedMachines).map((machine) => ({
      ...machine,
      type: activeMachineType(machine.type),
    })),
    obstacles: cloneObstacles(contract.obstacles),
    collectibles: cloneCollectibles(contract.collectibles ?? []),
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
    conveyorSpeed(a) === conveyorSpeed(b) &&
    a.fixed === b.fixed
  );
}

function drawPolygon(graphics: Phaser.GameObjects.Graphics, points: readonly Point[]): void {
  const first = points[0];
  if (!first || points.length < 3) return;
  graphics.beginPath();
  graphics.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point) graphics.lineTo(point.x, point.y);
  }
  graphics.closePath();
  graphics.fillPath();
}

function drawPolygons(
  graphics: Phaser.GameObjects.Graphics,
  polygons: readonly (readonly Point[])[],
  parity?: 0 | 1,
): void {
  let hasPath = false;
  graphics.beginPath();
  for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex += 1) {
    if (parity !== undefined && polygonIndex % 2 !== parity) continue;
    const points = polygons[polygonIndex]!;
    const first = points[0];
    if (!first || points.length < 3) continue;
    graphics.moveTo(first.x, first.y);
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      if (point) graphics.lineTo(point.x, point.y);
    }
    graphics.closePath();
    hasPath = true;
  }
  if (hasPath) graphics.fillPath();
}

function linePolygon(
  graphics: Phaser.GameObjects.Graphics,
  points: readonly Point[],
  close = true,
): void {
  const first = points[0];
  if (!first || points.length < 2) return;
  graphics.beginPath();
  graphics.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point) graphics.lineTo(point.x, point.y);
  }
  if (close) graphics.closePath();
  graphics.strokePath();
}

function roundedRectanglePoints(
  center: Point,
  width: number,
  height: number,
  radius: number,
  angle = 0,
  cornerSegments = 4,
): Point[] {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const roundedRadius = Math.max(0, Math.min(radius, halfWidth, halfHeight));
  const corners = [
    { x: -halfWidth + roundedRadius, y: -halfHeight + roundedRadius, start: Math.PI },
    {
      x: halfWidth - roundedRadius,
      y: -halfHeight + roundedRadius,
      start: Math.PI * 1.5,
    },
    { x: halfWidth - roundedRadius, y: halfHeight - roundedRadius, start: 0 },
    {
      x: -halfWidth + roundedRadius,
      y: halfHeight - roundedRadius,
      start: Math.PI * 0.5,
    },
  ];
  const points: Point[] = [];

  for (const corner of corners) {
    for (let step = 0; step <= cornerSegments; step += 1) {
      const arcAngle = corner.start + (Math.PI * 0.5 * step) / cornerSegments;
      points.push(
        localToWorld(
          center,
          angle,
          corner.x + Math.cos(arcAngle) * roundedRadius,
          corner.y + Math.sin(arcAngle) * roundedRadius,
        ),
      );
    }
  }

  return points;
}

function drawDashedLine(
  graphics: Phaser.GameObjects.Graphics,
  start: Point,
  end: Point,
  dashLength: number,
  gapLength: number,
): void {
  const distanceX = end.x - start.x;
  const distanceY = end.y - start.y;
  const length = Math.hypot(distanceX, distanceY);
  if (length <= 0) return;
  const directionX = distanceX / length;
  const directionY = distanceY / length;
  for (let offset = 0; offset < length; offset += dashLength + gapLength) {
    const segmentEnd = Math.min(length, offset + dashLength);
    graphics.lineBetween(
      start.x + directionX * offset,
      start.y + directionY * offset,
      start.x + directionX * segmentEnd,
      start.y + directionY * segmentEnd,
    );
  }
}

function trackedConveyorWheelCenters(center: Point, angle: number): Point[] {
  return [-32, 0, 32].map((offsetX) => localToWorld(center, angle, offsetX, 0));
}

function trackedConveyorLinkLayout(center: Point, machineAngle: number): TrackedConveyorLinkLayout[] {
  return Array.from({ length: TRACKED_CONVEYOR_LINK_COUNT }, (_, index) =>
    trackedConveyorPoseAt(
      center,
      machineAngle,
      (index * TRACKED_CONVEYOR_TRACK_LENGTH) / TRACKED_CONVEYOR_LINK_COUNT,
    ),
  );
}

function trackedConveyorPoseAt(
  center: Point,
  machineAngle: number,
  rawDistance: number,
): TrackedConveyorLinkLayout {
  let distance =
    ((rawDistance % TRACKED_CONVEYOR_TRACK_LENGTH) + TRACKED_CONVEYOR_TRACK_LENGTH) %
    TRACKED_CONVEYOR_TRACK_LENGTH;
  let x: number;
  let y: number;
  let tangent: number;

  if (distance < TRACKED_CONVEYOR_STRAIGHT_LENGTH) {
    x = -32 + distance;
    y = -TRACKED_CONVEYOR_TRACK_RADIUS;
    tangent = 0;
  } else if (
    (distance -= TRACKED_CONVEYOR_STRAIGHT_LENGTH) < TRACKED_CONVEYOR_ARC_LENGTH
  ) {
    const polar = -Math.PI / 2 + distance / TRACKED_CONVEYOR_TRACK_RADIUS;
    x = 32 + Math.cos(polar) * TRACKED_CONVEYOR_TRACK_RADIUS;
    y = Math.sin(polar) * TRACKED_CONVEYOR_TRACK_RADIUS;
    tangent = polar + Math.PI / 2;
  } else if ((distance -= TRACKED_CONVEYOR_ARC_LENGTH) < TRACKED_CONVEYOR_STRAIGHT_LENGTH) {
    x = 32 - distance;
    y = TRACKED_CONVEYOR_TRACK_RADIUS;
    tangent = Math.PI;
  } else {
    distance -= TRACKED_CONVEYOR_STRAIGHT_LENGTH;
    const polar = Math.PI / 2 + distance / TRACKED_CONVEYOR_TRACK_RADIUS;
    x = -32 + Math.cos(polar) * TRACKED_CONVEYOR_TRACK_RADIUS;
    y = Math.sin(polar) * TRACKED_CONVEYOR_TRACK_RADIUS;
    tangent = polar + Math.PI / 2;
  }

  return {
    center: localToWorld(center, machineAngle, x, y),
    angle: degreesToRadians(machineAngle) + tangent,
  };
}

export class FactoryScene extends Phaser.Scene {
  private readonly history = new CommandHistory(120);
  private readonly editorHistory = new CommandHistory(120);
  private readonly eventUnsubscribers: Array<() => void> = [];
  private readonly machineBodies = new Map<string, PhysicsMachine>();
  private readonly trackedConveyors = new Map<string, TrackedConveyorRuntime>();
  private readonly obstacleBodies: MatterJS.BodyType[] = [];
  private readonly boxes = new Map<number, BoxRuntime>();
  private readonly springCompression = new Map<string, number>();
  private readonly receiverPulse = new Map<string, number>();
  private readonly particles: Particle[] = [];
  private sourceMachines: MachineState[] = [];
  private conveyorMachines: MachineState[] = [];
  private springMachines: MachineState[] = [];
  private receiverMachines: MachineState[] = [];

  private gridGraphics!: Phaser.GameObjects.Graphics;
  private worldGraphics!: Phaser.GameObjects.Graphics;
  private effectsGraphics!: Phaser.GameObjects.Graphics;
  private overlayGraphics!: Phaser.GameObjects.Graphics;

  private mode: GameMode = 'sandbox';
  private contract?: ContractDefinition;
  private machines: MachineState[] = [];
  private obstacles: ObstacleDefinition[] = [];
  private collectibles: CollectibleDefinition[] = [];
  private readonly collectedCollectibleIds = new Set<string>();
  private readonly collectibleDisappear = new Map<string, number>();
  private availableMachines: MachineType[] = [];
  private status: SimulationStatus = 'build';
  private metrics: RunMetrics = {
    delivered: 0,
    lost: 0,
    active: 0,
    placedPieces: 0,
    collectedStars: 0,
    spent: 0,
  };

  private selectedTool?: MachineType;
  private selectedEditorTool?: EditorTool;
  private readonly selectedMachineIds = new Set<string>();
  private readonly selectedObstacleIds = new Set<string>();
  private readonly selectedCollectibleIds = new Set<string>();
  private ghostMachine?: MachineState;
  private ghostObstacle?: ObstacleDefinition;
  private ghostCollectible?: CollectibleDefinition;
  private ghostGroupMachines: MachineState[] = [];
  private ghostGroupObstacles: ObstacleDefinition[] = [];
  private ghostGroupCollectibles: CollectibleDefinition[] = [];
  private groupGhostAnchor?: Point;
  private machineClipboard?: MachineClipboard;
  private obstacleClipboard?: ObstacleClipboard;
  private collectibleClipboard?: CollectibleClipboard;
  private groupClipboard?: GroupClipboard;
  private ghostValid = false;
  private drag?: DragState;
  private editorActive = false;
  private editorPreview = false;
  private editorContract?: ContractDefinition;
  private editorBaseline = '';
  private editorAuthoringState?: EditorAuthoringState;
  private editorPersistenceLocked = false;
  private editorHitboxesVisible = false;
  private invalidEntityFlash?: InvalidEntityFlash;
  private obstacleSequence = 0;
  private collectibleSequence = 0;
  private muted = false;
  private gridEnabled = true;
  private simulationSpeed = 1;
  private preferredConveyorSpeed: ConveyorSpeed = 'normal';
  private spawnAccumulator = 0;
  private physicsAccumulator = 0;
  private simulationTimeMs = 0;
  private simulationVisualTimeMs = 0;
  private snapshotAccumulator = 0;
  private lastIdleRenderSignature = '';
  private machineSequence = 0;
  private boxSequence = 0;
  private budgetCompletionWarningShown = false;
  private lastGridZoom = -1;
  private currentCamera?: ContractCamera;
  private contextMenuHandler?: (event: MouseEvent) => void;

  private get selectedMachineId(): string | undefined {
    return this.selectedMachineIds.values().next().value;
  }

  private set selectedMachineId(id: string | undefined) {
    this.selectedMachineIds.clear();
    if (id) {
      this.selectedMachineIds.add(id);
      this.selectedCollectibleId = undefined;
    }
  }

  private get selectedObstacleId(): string | undefined {
    return this.selectedObstacleIds.values().next().value;
  }

  private set selectedObstacleId(id: string | undefined) {
    this.selectedObstacleIds.clear();
    if (id) {
      this.selectedObstacleIds.add(id);
      this.selectedCollectibleId = undefined;
    }
  }

  private get selectedCollectibleId(): string | undefined {
    return this.selectedCollectibleIds.values().next().value;
  }

  private set selectedCollectibleId(id: string | undefined) {
    this.selectedCollectibleIds.clear();
    if (id) this.selectedCollectibleIds.add(id);
  }

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
    this.initializeIdleState();

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
    this.updateBoxVisuals();
    if (this.worldNeedsContinuousRender()) {
      this.renderWorld();
      this.lastIdleRenderSignature = '';
    } else {
      const signature = this.idleWorldRenderSignature();
      if (signature !== this.lastIdleRenderSignature) {
        this.renderWorld();
        this.lastIdleRenderSignature = signature;
      }
    }

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
    this.editorPersistenceLocked = false;
    this.mode = mode;
    if (mode === 'campaign' && !contractDefinition && !contractId) {
      throw new Error('Uma fase deve ser informada para iniciar o modo campanha.');
    }
    this.contract =
      mode === 'campaign'
        ? cloneContract(contractDefinition ?? getContract(contractId!))
        : undefined;
    this.availableMachines = normalizeAvailableMachineTypes(
      this.contract?.availableMachines ?? SANDBOX_DEFINITION.availableMachines,
    );
    this.obstacles = (this.contract?.obstacles ?? []).map((obstacle) => ({ ...obstacle }));
    this.collectibles = this.normalizeCollectibles(this.contract?.collectibles ?? []);
    const initialMachines =
      this.contract?.fixedMachines ?? restoredMachines ?? SANDBOX_DEFINITION.fixedMachines;
    this.machines = this.normalizeMachineIds(initialMachines, this.mode === 'campaign');
    this.clearClipboard();
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.selectedCollectibleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.ghostCollectible = undefined;
    this.simulationSpeed = 1;
    this.preferredConveyorSpeed = 'normal';
    this.history.clear();
    this.editorHistory.clear();
    this.resetSimulation('build');
    this.rebuildStaticBodies();
    if (this.contract) this.applyContractCamera(this.contract.initialCamera);
    else this.fitCamera();
    this.emitSnapshot();
    this.emitSandboxChange();
    this.emitCamera();
  }

  /** Opens a contract as an editable, fixed scenario. No campaign result is emitted in this mode. */
  public startEditor(contract: ContractDefinition, isNew = false): void {
    const draft = cloneContract(contract);
    this.invalidEntityFlash = undefined;
    this.editorHitboxesVisible = false;
    this.mode = 'editor';
    this.editorActive = true;
    this.editorPreview = false;
    this.editorAuthoringState = undefined;
    this.editorContract = draft;
    this.editorPersistenceLocked = false;
    this.contract = draft;
    this.availableMachines = [
      'source',
      'receiver',
      'tracked-conveyor',
      'spring',
      'turbo-spring',
    ];
    this.obstacles = this.normalizeObstacles(draft.obstacles);
    this.collectibles = this.normalizeCollectibles(draft.collectibles ?? []);
    this.machines = this.normalizeMachineIds(
      draft.fixedMachines.map((machine) => ({ ...machine, fixed: true })),
      true,
    );
    this.clearClipboard();
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.selectedCollectibleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.ghostCollectible = undefined;
    this.setDragState(undefined);
    this.simulationSpeed = 1;
    this.preferredConveyorSpeed = 'normal';
    this.history.clear();
    this.editorHistory.clear();
    this.resetSimulation('build');
    this.rebuildStaticBodies();
    this.applyContractCamera(draft.initialCamera);
    this.editorBaseline = isNew
      ? '__new-contract-without-persisted-baseline__'
      : this.serializeEditorContract(this.getEditorDraft());
    this.emitEditorChanged();
    appEvents.emit('game:editor-preview', { active: false });
    this.emitSnapshot();
  }

  public updateEditorSettings(contract: ContractDefinition): void {
    if (!this.isAuthoring() || this.editorPersistenceLocked) return;
    this.editorContract = {
      ...cloneContract(contract),
      initialCamera: this.captureCamera(),
      fixedMachines: cloneMachines(this.machines).map((machine) => ({ ...machine, fixed: true })),
      obstacles: cloneObstacles(this.obstacles),
      collectibles: cloneCollectibles(this.collectibles),
    };
    this.contract = this.editorContract;
    this.updateMachineMetrics();
    this.emitEditorChanged();
    this.emitSnapshot();
  }

  public selectEditorTool(type: EditorTool): void {
    if (!this.isAuthoring() || !this.canBuild()) return;
    this.selectedEditorTool = type;
    this.selectedTool = type === 'obstacle' || type === 'star' ? undefined : type;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.selectedCollectibleId = undefined;
    this.clearClipboard();
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.ghostCollectible = undefined;
    this.emitSnapshot();
  }

  /** Runs the current draft with the player's configured palette and a disposable solution. */
  public beginEditorPreview(): void {
    if (!this.isAuthoring() || this.editorPersistenceLocked || !this.editorContract) return;
    const draft = this.getEditorDraft();
    this.editorAuthoringState = {
      contract: cloneContract(draft),
      document: this.captureEditorDocument(),
    };
    this.editorPreview = true;
    this.mode = 'preview';
    this.contract = cloneContract(draft);
    this.availableMachines = normalizeAvailableMachineTypes(draft.availableMachines);
    this.machines = cloneMachines(draft.fixedMachines).map((machine) => ({
      ...machine,
      fixed: true,
    }));
    this.obstacles = cloneObstacles(draft.obstacles);
    this.collectibles = this.normalizeCollectibles(draft.collectibles ?? []);
    this.clearClipboard();
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.selectedCollectibleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.ghostCollectible = undefined;
    this.history.clear();
    this.resetSimulation('build');
    this.rebuildStaticBodies();
    this.applyContractCamera(draft.initialCamera);
    appEvents.emit('game:editor-preview', { active: true });
    this.emitSnapshot();
  }

  public returnToEditor(): void {
    if (
      this.editorPersistenceLocked ||
      !this.editorActive ||
      !this.editorPreview ||
      !this.editorAuthoringState
    ) {
      return;
    }
    const state = this.editorAuthoringState;
    this.editorPreview = false;
    this.mode = 'editor';
    this.editorContract = cloneContract(state.contract);
    this.contract = this.editorContract;
    this.availableMachines = [
      'source',
      'receiver',
      'tracked-conveyor',
      'spring',
      'turbo-spring',
    ];
    this.applyEditorDocument(state.document, false);
    this.clearClipboard();
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.selectedCollectibleId = undefined;
    this.history.clear();
    this.resetSimulation('build');
    this.rebuildStaticBodies();
    this.applyContractCamera(state.contract.initialCamera);
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
    this.invalidEntityFlash = undefined;
    this.editorHitboxesVisible = false;
    if (!this.editorActive || this.editorPersistenceLocked) return;
    this.mode = 'campaign';
    this.editorActive = false;
    this.editorPreview = false;
    this.editorContract = undefined;
    this.editorAuthoringState = undefined;
    this.editorBaseline = '';
    this.editorPersistenceLocked = false;
    // A discarded draft must not remain runnable behind the menu. In
    // particular, the global Space shortcut must never turn it into a
    // campaign result after authoring has ended.
    this.contract = undefined;
    this.machines = [];
    this.obstacles = [];
    this.collectibles = [];
    this.availableMachines = [];
    this.clearClipboard();
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.selectedCollectibleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.ghostCollectible = undefined;
    this.setDragState(undefined);
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
      initialCamera: this.isAuthoring() ? this.captureCamera() : { ...base.initialCamera },
      fixedMachines: cloneMachines(this.machines).map((machine) => ({ ...machine, fixed: true })),
      obstacles: cloneObstacles(this.obstacles),
      collectibles: cloneCollectibles(this.collectibles),
    };
  }

  public flashInvalidEditorEntities(paths: readonly string[]): void {
    if (!this.isAuthoring()) return;
    const machineIds = new Set<string>();
    const obstacleIds = new Set<string>();
    const collectibleIds = new Set<string>();
    for (const path of paths) {
      const machineIndex = entityIndexFromValidationPath(path, 'fixedMachines');
      const obstacleIndex = entityIndexFromValidationPath(path, 'obstacles');
      const collectibleIndex = entityIndexFromValidationPath(path, 'collectibles');
      const machine = machineIndex === undefined ? undefined : this.machines[machineIndex];
      const obstacle = obstacleIndex === undefined ? undefined : this.obstacles[obstacleIndex];
      const collectible =
        collectibleIndex === undefined ? undefined : this.collectibles[collectibleIndex];
      if (machine) machineIds.add(machine.id);
      if (obstacle) obstacleIds.add(obstacle.id);
      if (collectible) collectibleIds.add(collectible.id);
    }
    if (machineIds.size + obstacleIds.size + collectibleIds.size === 0) return;
    const startedAt = performance.now();
    this.invalidEntityFlash = {
      machineIds,
      obstacleIds,
      collectibleIds,
      startedAt,
      endsAt: startedAt + INVALID_ENTITY_FLASH_DURATION_MS,
    };
    this.lastIdleRenderSignature = '';
    this.renderWorld();
  }

  public setEditorHitboxesVisible(enabled: boolean): void {
    this.editorHitboxesVisible = enabled && this.isAuthoring();
    this.lastIdleRenderSignature = '';
    this.renderWorld();
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
    this.selectedCollectibleId = undefined;
    this.clearClipboard();
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.ghostCollectible = undefined;
    this.emitSnapshot();
  }

  public placeMachineAt(type: MachineType, gridX: number, gridY: number, angle = 0): boolean {
    if (!this.canBuild() || (!this.isAuthoring() && !this.availableMachines.includes(type))) {
      return false;
    }

    const snapToGrid = (value: number, step: number) => Math.round(value / step) * step;
    const machine: MachineState = {
      id: this.createMachineId(),
      type,
      gridX: this.isAuthoring() ? snapToGrid(gridX, GRID_POSITION_STEP) : gridX,
      gridY: this.isAuthoring() ? snapToGrid(gridY, GRID_POSITION_STEP) : gridY,
      angle: normalizeAngle(angle),
      reversed: false,
      conveyorSpeed: isConveyorType(type) ? this.preferredConveyorSpeed : undefined,
      fixed: this.isAuthoring(),
    };
    if (!this.canAffordMachines([machine])) {
      this.toast('Limite de orçamento atingido. Remova um item para liberar verba.', 'danger');
      this.audio('error');
      return false;
    }
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
    if (!this.canBuild() || this.selectionCount() !== 1) return false;
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
    if (!this.canBuild() || this.selectionCount() !== 1) return false;
    const selected = this.getSelectedMachine();
    if (
      !selected ||
      !this.canEditMachine(selected) ||
      (selected.type !== 'conveyor' && selected.type !== 'tracked-conveyor')
    ) {
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

  public setSelectedConveyorSpeed(speed: ConveyorSpeed): boolean {
    if (!this.canBuild() || this.selectionCount() !== 1) return false;
    const selected = this.getSelectedMachine();
    if (!selected || !this.canEditMachine(selected) || !isConveyorType(selected.type)) {
      return false;
    }
    if (conveyorSpeed(selected) === speed) {
      this.preferredConveyorSpeed = speed;
      return true;
    }
    const candidate = { ...selected, conveyorSpeed: speed };
    const nextMachines = this.machines.map((machine) =>
      machine.id === selected.id ? candidate : machine,
    );
    const budgetLimit = this.getBudgetLimit();
    if (
      !this.isAuthoring() &&
      budgetLimit !== undefined &&
      this.calculateSpentBudget(nextMachines) > budgetLimit * 2
    ) {
      this.toast('Esse nível de velocidade ultrapassa o limite máximo do orçamento.', 'danger');
      this.audio('error');
      return false;
    }
    this.replaceMachineWithHistory(
      selected,
      candidate,
      'Ajustar velocidade da esteira',
    );
    this.preferredConveyorSpeed = speed;
    this.audio('place');
    this.emitEditorChanged();
    return true;
  }

  public deleteSelected(): boolean {
    if (!this.canBuild()) return false;
    if (this.selectionCount() > 1) return this.deleteSelectedGroup();
    if (this.isAuthoring() && this.selectedCollectibleId) {
      return this.deleteSelectedCollectible();
    }
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

  public copySelected(): boolean {
    if (!this.canBuild()) return false;
    if (this.selectionCount() > 1) {
      this.beginGroupPaste(
        this.getSelectedMachines(),
        this.getSelectedObstacles(),
        this.getSelectedCollectibles(),
      );
      return true;
    }
    const machine = this.getSelectedMachine();
    if (machine && this.canEditMachine(machine)) {
      this.beginMachinePaste(machine);
      return true;
    }

    const obstacle = this.getSelectedObstacle();
    if (obstacle && this.isAuthoring()) {
      this.beginObstaclePaste(obstacle);
      return true;
    }

    const collectible = this.getSelectedCollectible();
    if (collectible && this.isAuthoring()) {
      this.beginCollectiblePaste(collectible);
      return true;
    }
    return false;
  }

  public cutSelected(): boolean {
    if (!this.canBuild()) return false;
    if (this.selectionCount() > 1) return this.cutSelectedGroup();
    const machine = this.getSelectedMachine();
    if (machine && this.canEditMachine(machine)) {
      const before = cloneMachines(this.machines);
      const after = before.filter((candidate) => candidate.id !== machine.id);
      this.executeSnapshotCommand('Recortar peça', before, after);
      this.beginMachinePaste(machine);
      this.audio('place');
      this.emitEditorChanged();
      return true;
    }

    const obstacle = this.getSelectedObstacle();
    if (obstacle && this.isAuthoring()) {
      const before = this.captureEditorDocument();
      const after = cloneEditorDocument(before);
      after.obstacles = after.obstacles.filter((candidate) => candidate.id !== obstacle.id);
      this.executeEditorSnapshotCommand('Recortar bloqueador', before, after);
      this.beginObstaclePaste(obstacle);
      this.audio('place');
      this.emitEditorChanged();
      return true;
    }

    const collectible = this.getSelectedCollectible();
    if (collectible && this.isAuthoring()) {
      const before = this.captureEditorDocument();
      const after = cloneEditorDocument(before);
      after.collectibles = after.collectibles.filter(
        (candidate) => candidate.id !== collectible.id,
      );
      this.executeEditorSnapshotCommand('Recortar estrela', before, after);
      this.beginCollectiblePaste(collectible);
      this.audio('place');
      this.emitEditorChanged();
      return true;
    }
    return false;
  }

  private deleteSelectedGroup(): boolean {
    const selectedMachines = this.getSelectedMachines().filter((machine) =>
      this.canEditMachine(machine),
    );
    const selectedObstacles = this.isAuthoring() ? this.getSelectedObstacles() : [];
    const selectedCollectibles = this.isAuthoring() ? this.getSelectedCollectibles() : [];
    if (
      selectedMachines.length + selectedObstacles.length + selectedCollectibles.length <
      2
    ) {
      return false;
    }
    const machineIds = new Set(selectedMachines.map((machine) => machine.id));
    const obstacleIds = new Set(selectedObstacles.map((obstacle) => obstacle.id));
    const collectibleIds = new Set(
      selectedCollectibles.map((collectible) => collectible.id),
    );

    if (this.isAuthoring()) {
      const before = this.captureEditorDocument();
      const after = cloneEditorDocument(before);
      after.machines = after.machines.filter((machine) => !machineIds.has(machine.id));
      after.obstacles = after.obstacles.filter((obstacle) => !obstacleIds.has(obstacle.id));
      after.collectibles = after.collectibles.filter(
        (collectible) => !collectibleIds.has(collectible.id),
      );
      this.executeEditorSnapshotCommand('Remover seleção', before, after);
    } else {
      const before = cloneMachines(this.machines);
      const after = before.filter((machine) => !machineIds.has(machine.id));
      this.executeSnapshotCommand('Remover seleção', before, after);
    }

    this.clearSelection();
    this.audio('place');
    this.emitSnapshot();
    this.emitEditorChanged();
    return true;
  }

  private cutSelectedGroup(): boolean {
    const selectedMachines = this.getSelectedMachines().filter((machine) =>
      this.canEditMachine(machine),
    );
    const selectedObstacles = this.isAuthoring() ? this.getSelectedObstacles() : [];
    const selectedCollectibles = this.isAuthoring() ? this.getSelectedCollectibles() : [];
    if (
      selectedMachines.length + selectedObstacles.length + selectedCollectibles.length <
      2
    ) {
      return false;
    }
    const machineIds = new Set(selectedMachines.map((machine) => machine.id));
    const obstacleIds = new Set(selectedObstacles.map((obstacle) => obstacle.id));
    const collectibleIds = new Set(
      selectedCollectibles.map((collectible) => collectible.id),
    );

    if (this.isAuthoring()) {
      const before = this.captureEditorDocument();
      const after = cloneEditorDocument(before);
      after.machines = after.machines.filter((machine) => !machineIds.has(machine.id));
      after.obstacles = after.obstacles.filter((obstacle) => !obstacleIds.has(obstacle.id));
      after.collectibles = after.collectibles.filter(
        (collectible) => !collectibleIds.has(collectible.id),
      );
      this.executeEditorSnapshotCommand('Recortar seleção', before, after);
    } else {
      const before = cloneMachines(this.machines);
      const after = before.filter((machine) => !machineIds.has(machine.id));
      this.executeSnapshotCommand('Recortar seleção', before, after);
    }

    this.beginGroupPaste(selectedMachines, selectedObstacles, selectedCollectibles);
    this.audio('place');
    this.emitEditorChanged();
    return true;
  }

  private beginMachinePaste(machine: MachineState): void {
    const clipboard: MachineClipboard = {
      type: machine.type,
      angle: machine.angle,
      reversed: machine.reversed,
      fixed: machine.fixed,
    };
    this.machineClipboard = clipboard;
    this.obstacleClipboard = undefined;
    this.collectibleClipboard = undefined;
    this.groupClipboard = undefined;
    this.ghostGroupMachines = [];
    this.ghostGroupObstacles = [];
    this.ghostGroupCollectibles = [];
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.ghostObstacle = undefined;
    this.ghostMachine = {
      id: 'ghost',
      ...clipboard,
      gridX: machine.gridX,
      gridY: machine.gridY,
    };
    this.ghostValid =
      this.canAffordMachines([this.ghostMachine]) &&
      this.isMachinePlacementValid(this.ghostMachine);
    this.emitSnapshot();
  }

  private beginObstaclePaste(obstacle: ObstacleDefinition): void {
    const clipboard: ObstacleClipboard = {
      columns: obstacle.columns,
      rows: obstacle.rows,
      angle: obstacle.angle ?? 0,
    };
    this.obstacleClipboard = clipboard;
    this.machineClipboard = undefined;
    this.collectibleClipboard = undefined;
    this.groupClipboard = undefined;
    this.ghostGroupMachines = [];
    this.ghostGroupObstacles = [];
    this.ghostGroupCollectibles = [];
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = {
      id: 'ghost-obstacle',
      ...clipboard,
      gridX: obstacle.gridX,
      gridY: obstacle.gridY,
    };
    this.ghostValid = this.isObstaclePlacementValid(this.ghostObstacle);
    this.emitSnapshot();
  }

  private beginCollectiblePaste(collectible: CollectibleDefinition): void {
    this.collectibleClipboard = { type: collectible.type };
    this.machineClipboard = undefined;
    this.obstacleClipboard = undefined;
    this.groupClipboard = undefined;
    this.ghostGroupMachines = [];
    this.ghostGroupObstacles = [];
    this.ghostGroupCollectibles = [];
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.selectedCollectibleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.ghostCollectible = {
      id: 'ghost-collectible',
      type: collectible.type,
      gridX: collectible.gridX,
      gridY: collectible.gridY,
    };
    this.ghostValid = this.isCollectiblePlacementValid(this.ghostCollectible);
    this.emitSnapshot();
  }

  private beginGroupPaste(
    machines: readonly MachineState[],
    obstacles: readonly ObstacleDefinition[],
    collectibles: readonly CollectibleDefinition[],
  ): void {
    if (machines.length + obstacles.length + collectibles.length === 0) return;
    const points = [
      ...machines.flatMap((machine) => machinePolygon(machine)),
      ...obstacles.flatMap((obstacle) => this.obstaclePolygon(obstacle)),
      ...collectibles.map((collectible) => this.collectibleCenter(collectible)),
    ];
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const origin = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

    this.machineClipboard = undefined;
    this.obstacleClipboard = undefined;
    this.collectibleClipboard = undefined;
    this.groupClipboard = {
      machines: cloneMachines(machines),
      obstacles: cloneObstacles(obstacles),
      collectibles: cloneCollectibles(collectibles),
      origin,
    };
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.clearSelection();
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.updateGroupGhostAt(origin);
    this.emitSnapshot();
  }

  private updateGroupGhostAt(anchor: Point): void {
    const clipboard = this.groupClipboard;
    if (!clipboard) return;
    this.groupGhostAnchor = { ...anchor };
    const rawDeltaX = (anchor.x - clipboard.origin.x) / CELL_SIZE;
    const rawDeltaY = (anchor.y - clipboard.origin.y) / CELL_SIZE;
    const step = clipboard.obstacles.length > 0 ? 1 : this.gridEnabled ? GRID_POSITION_STEP : 0.001;
    const deltaX = Math.round(rawDeltaX / step) * step;
    const deltaY = Math.round(rawDeltaY / step) * step;

    this.ghostGroupMachines = clipboard.machines.map((machine, index) => ({
      ...machine,
      id: `ghost-group-machine-${index}`,
      gridX: machine.gridX + deltaX,
      gridY: machine.gridY + deltaY,
    }));
    this.ghostGroupObstacles = clipboard.obstacles.map((obstacle, index) => ({
      ...obstacle,
      id: `ghost-group-obstacle-${index}`,
      gridX: obstacle.gridX + deltaX,
      gridY: obstacle.gridY + deltaY,
    }));
    this.ghostGroupCollectibles = clipboard.collectibles.map((collectible, index) => ({
      ...collectible,
      id: `ghost-group-collectible-${index}`,
      gridX: collectible.gridX + deltaX,
      gridY: collectible.gridY + deltaY,
    }));
    this.ghostValid =
      this.canAffordMachines(this.ghostGroupMachines) &&
      this.isGroupPlacementValid(
        this.ghostGroupMachines,
        this.ghostGroupObstacles,
        this.ghostGroupCollectibles,
      );
  }

  private placeGroupFromClipboardAt(world: Point): boolean {
    if (!this.canBuild() || !this.groupClipboard) return false;
    this.updateGroupGhostAt(world);
    if (!this.canAffordMachines(this.ghostGroupMachines)) {
      this.toast('Limite de orçamento atingido. Remova itens para liberar verba.', 'danger');
      this.audio('error');
      return false;
    }
    if (!this.ghostValid) {
      this.toast('Posicione todo o grupo em uma área livre.', 'danger');
      this.audio('error');
      return false;
    }

    const machines = this.ghostGroupMachines.map((machine) => ({
      ...machine,
      id: this.createMachineId(),
    }));
    const obstacles = this.ghostGroupObstacles.map((obstacle) => ({
      ...obstacle,
      id: this.createObstacleId(),
    }));
    const collectibles = this.ghostGroupCollectibles.map((collectible) => ({
      ...collectible,
      id: this.createCollectibleId(),
    }));

    if (this.isAuthoring()) {
      const before = this.captureEditorDocument();
      const after = cloneEditorDocument(before);
      after.machines.push(...machines);
      after.obstacles.push(...obstacles);
      after.collectibles.push(...collectibles);
      this.executeEditorSnapshotCommand('Colar seleção', before, after);
    } else {
      if (obstacles.length > 0 || collectibles.length > 0) return false;
      const before = cloneMachines(this.machines);
      this.executeSnapshotCommand('Colar seleção', before, [...before, ...machines]);
    }

    this.clearClipboard();
    this.clearSelection();
    for (const machine of machines) this.selectedMachineIds.add(machine.id);
    for (const obstacle of obstacles) this.selectedObstacleIds.add(obstacle.id);
    for (const collectible of collectibles) this.selectedCollectibleIds.add(collectible.id);
    this.audio('place');
    this.emitSnapshot();
    this.emitEditorChanged();
    return true;
  }

  private dragOccludesUi(drag: DragState | undefined): boolean {
    return Boolean(drag && drag.kind !== 'pan' && drag.kind !== 'marquee');
  }

  private setDragState(next: DragState | undefined): void {
    const wasOccluding = this.dragOccludesUi(this.drag);
    const isOccluding = this.dragOccludesUi(next);
    this.drag = next;
    if (wasOccluding !== isOccluding) {
      appEvents.emit('game:dragging', { active: isOccluding });
    }
  }

  private beginGroupMove(world: Point): boolean {
    const machines = this.getSelectedMachines();
    const obstacles = this.getSelectedObstacles();
    const collectibles = this.getSelectedCollectibles();
    if (machines.length + obstacles.length + collectibles.length < 2) return false;
    this.setDragState({
      kind: 'group-move',
      ...(this.isAuthoring()
        ? { beforeDocument: this.captureEditorDocument() }
        : { before: cloneMachines(this.machines) }),
      previewMachines: cloneMachines(machines),
      previewObstacles: cloneObstacles(obstacles),
      previewCollectibles: cloneCollectibles(collectibles),
      startWorld: { ...world },
      currentWorld: { ...world },
      valid: true,
      lastScreenX: 0,
      lastScreenY: 0,
    });
    return true;
  }

  private updateGroupMovePreview(drag: DragState, world: Point): void {
    if (drag.kind !== 'group-move' || !drag.startWorld) return;
    const sourceMachines = (drag.beforeDocument?.machines ?? drag.before ?? []).filter((machine) =>
      this.selectedMachineIds.has(machine.id),
    );
    const sourceObstacles = (drag.beforeDocument?.obstacles ?? []).filter((obstacle) =>
      this.selectedObstacleIds.has(obstacle.id),
    );
    const sourceCollectibles = (drag.beforeDocument?.collectibles ?? []).filter((collectible) =>
      this.selectedCollectibleIds.has(collectible.id),
    );
    const rawDeltaX = (world.x - drag.startWorld.x) / CELL_SIZE;
    const rawDeltaY = (world.y - drag.startWorld.y) / CELL_SIZE;
    const step = sourceObstacles.length > 0 ? 1 : this.gridEnabled ? GRID_POSITION_STEP : 0.001;
    const deltaX = Math.round(rawDeltaX / step) * step;
    const deltaY = Math.round(rawDeltaY / step) * step;

    drag.currentWorld = { ...world };
    drag.previewMachines = sourceMachines.map((machine) => ({
      ...machine,
      gridX: machine.gridX + deltaX,
      gridY: machine.gridY + deltaY,
    }));
    drag.previewObstacles = sourceObstacles.map((obstacle) => ({
      ...obstacle,
      gridX: obstacle.gridX + deltaX,
      gridY: obstacle.gridY + deltaY,
    }));
    drag.previewCollectibles = sourceCollectibles.map((collectible) => ({
      ...collectible,
      gridX: collectible.gridX + deltaX,
      gridY: collectible.gridY + deltaY,
    }));
    drag.valid = this.isGroupPlacementValid(
      drag.previewMachines,
      drag.previewObstacles,
      drag.previewCollectibles,
      this.selectedMachineIds,
      this.selectedObstacleIds,
    );
  }

  private commitGroupMove(drag: DragState): void {
    const previewMachines = drag.previewMachines ?? [];
    const previewObstacles = drag.previewObstacles ?? [];
    const previewCollectibles = drag.previewCollectibles ?? [];
    if (!drag.valid) {
      this.toast('Solte o grupo em uma área livre.', 'danger');
      this.audio('error');
      return;
    }

    const machineById = new Map(previewMachines.map((machine) => [machine.id, machine]));
    const obstacleById = new Map(previewObstacles.map((obstacle) => [obstacle.id, obstacle]));
    const collectibleById = new Map(
      previewCollectibles.map((collectible) => [collectible.id, collectible]),
    );
    if (this.isAuthoring()) {
      const before = drag.beforeDocument;
      if (!before) return;
      const changed =
        previewMachines.some((machine) => {
          const original = before.machines.find((candidate) => candidate.id === machine.id);
          return !original || !sameMachineState(original, machine);
        }) ||
        previewObstacles.some((obstacle) => {
          const original = before.obstacles.find((candidate) => candidate.id === obstacle.id);
          return !original || !this.sameObstacleState(original, obstacle);
        }) ||
        previewCollectibles.some((collectible) => {
          const original = before.collectibles.find(
            (candidate) => candidate.id === collectible.id,
          );
          return !original || !this.sameCollectibleState(original, collectible);
        });
      if (!changed) return;
      const after = cloneEditorDocument(before);
      after.machines = after.machines.map((machine) => ({
        ...(machineById.get(machine.id) ?? machine),
      }));
      after.obstacles = after.obstacles.map((obstacle) => ({
        ...(obstacleById.get(obstacle.id) ?? obstacle),
      }));
      after.collectibles = after.collectibles.map((collectible) => ({
        ...(collectibleById.get(collectible.id) ?? collectible),
      }));
      this.executeEditorSnapshotCommand('Mover seleção', before, after);
    } else {
      const before = drag.before;
      if (!before) return;
      const changed = previewMachines.some((machine) => {
        const original = before.find((candidate) => candidate.id === machine.id);
        return !original || !sameMachineState(original, machine);
      });
      if (!changed) return;
      const after = before.map((machine) => ({
        ...(machineById.get(machine.id) ?? machine),
      }));
      this.executeSnapshotCommand('Mover seleção', before, after);
    }

    this.audio('place');
    this.emitSnapshot();
    this.emitEditorChanged();
  }

  private placeMachineFromClipboardAt(gridX: number, gridY: number): boolean {
    if (!this.canBuild() || !this.machineClipboard) return false;

    const machine: MachineState = {
      id: this.createMachineId(),
      ...this.machineClipboard,
      gridX,
      gridY,
    };
    if (!this.canAffordMachines([machine])) {
      this.toast('Limite de orçamento atingido. Remova um item para liberar verba.', 'danger');
      this.audio('error');
      return false;
    }
    if (!this.isMachinePlacementValid(machine)) {
      this.toast('Essa posição está ocupada.', 'danger');
      this.audio('error');
      return false;
    }

    const before = cloneMachines(this.machines);
    this.executeSnapshotCommand('Colar peça', before, [...before, machine]);
    this.clearClipboard();
    this.ghostMachine = undefined;
    this.selectedMachineId = machine.id;
    this.selectedObstacleId = undefined;
    this.audio('place');
    this.emitSnapshot();
    this.emitEditorChanged();
    return true;
  }

  private placeObstacleFromClipboardAt(gridX: number, gridY: number): boolean {
    if (!this.isAuthoring() || !this.canBuild() || !this.obstacleClipboard) return false;
    const obstacle: ObstacleDefinition = {
      id: this.createObstacleId(),
      ...this.obstacleClipboard,
      gridX,
      gridY,
    };
    if (!this.isObstaclePlacementValid(obstacle)) {
      this.toast('Essa área está ocupada ou fora do tabuleiro.', 'danger');
      this.audio('error');
      return false;
    }

    const before = this.captureEditorDocument();
    const after = cloneEditorDocument(before);
    after.obstacles.push(obstacle);
    this.executeEditorSnapshotCommand('Colar bloqueador', before, after);
    this.clearClipboard();
    this.ghostObstacle = undefined;
    this.selectedObstacleId = obstacle.id;
    this.selectedMachineId = undefined;
    this.audio('place');
    this.emitSnapshot();
    this.emitEditorChanged();
    return true;
  }

  private placeCollectibleFromClipboardAt(gridX: number, gridY: number): boolean {
    if (!this.isAuthoring() || !this.canBuild() || !this.collectibleClipboard) return false;
    const collectible: CollectibleDefinition = {
      id: this.createCollectibleId(),
      ...this.collectibleClipboard,
      gridX: this.snapEditorPosition(gridX),
      gridY: this.snapEditorPosition(gridY),
    };
    if (!this.isCollectiblePlacementValid(collectible)) return false;

    const before = this.captureEditorDocument();
    const after = cloneEditorDocument(before);
    after.collectibles.push(collectible);
    this.executeEditorSnapshotCommand('Colar estrela', before, after);
    this.clearClipboard();
    this.selectedCollectibleId = collectible.id;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
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
      angle: 0,
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
    const candidate = {
      ...selected,
      gridX: this.snapEditorPosition(gridX),
      gridY: this.snapEditorPosition(gridY),
    };
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

  public rotateSelectedObstacle(angle: number): boolean {
    if (!this.isAuthoring() || !this.canBuild()) return false;
    const selected = this.getSelectedObstacle();
    if (!selected) return false;
    const candidate = { ...selected, angle: this.snapRotationAngle(angle) };
    if (!this.isObstaclePlacementValid(candidate, selected.id)) return false;
    this.replaceObstacleWithHistory(selected, candidate, 'Girar bloqueador');
    this.audio('place');
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

  public placeCollectibleAt(gridX: number, gridY: number): boolean {
    if (!this.isAuthoring() || !this.canBuild()) return false;
    const collectible: CollectibleDefinition = {
      id: this.createCollectibleId(),
      type: 'star',
      gridX: this.snapEditorPosition(gridX),
      gridY: this.snapEditorPosition(gridY),
    };
    if (!this.isCollectiblePlacementValid(collectible)) {
      this.toast('Posicione a estrela dentro do tabuleiro.', 'danger');
      this.audio('error');
      return false;
    }
    const before = this.captureEditorDocument();
    const after = cloneEditorDocument(before);
    after.collectibles.push(collectible);
    this.executeEditorSnapshotCommand('Posicionar estrela', before, after);
    this.selectedCollectibleId = collectible.id;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.ghostCollectible = undefined;
    this.audio('place');
    this.emitSnapshot();
    this.emitEditorChanged();
    return true;
  }

  public selectCollectible(id: string): boolean {
    if (!this.isAuthoring() || !this.collectibles.some((candidate) => candidate.id === id)) {
      return false;
    }
    this.selectedCollectibleId = id;
    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.emitSnapshot();
    return true;
  }

  public moveSelectedCollectible(gridX: number, gridY: number): boolean {
    if (!this.isAuthoring() || !this.canBuild()) return false;
    const selected = this.getSelectedCollectible();
    if (!selected) return false;
    const candidate = {
      ...selected,
      gridX: this.snapEditorPosition(gridX),
      gridY: this.snapEditorPosition(gridY),
    };
    if (!this.isCollectiblePlacementValid(candidate)) return false;
    this.replaceCollectibleWithHistory(selected, candidate, 'Mover estrela');
    return true;
  }

  private deleteSelectedCollectible(): boolean {
    if (!this.isAuthoring() || !this.canBuild()) return false;
    const selected = this.getSelectedCollectible();
    if (!selected) return false;
    const before = this.captureEditorDocument();
    const after = cloneEditorDocument(before);
    after.collectibles = after.collectibles.filter(
      (collectible) => collectible.id !== selected.id,
    );
    this.executeEditorSnapshotCommand('Remover estrela', before, after);
    this.selectedCollectibleId = undefined;
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
    this.selectedCollectibleId = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.ghostCollectible = undefined;
    this.clearClipboard();
    this.setDragState(undefined);
  }

  private clearClipboard(): void {
    this.machineClipboard = undefined;
    this.obstacleClipboard = undefined;
    this.collectibleClipboard = undefined;
    this.groupClipboard = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.ghostCollectible = undefined;
    this.ghostGroupMachines = [];
    this.ghostGroupObstacles = [];
    this.ghostGroupCollectibles = [];
    this.groupGhostAnchor = undefined;
  }

  public runSimulation(): void {
    if (this.editorPersistenceLocked && this.isAuthoring()) return;

    if (this.status === 'paused') {
      this.clearInteractionFocus();
      this.status = 'running';
      this.matter.world.resume();
      this.emitSnapshot();
      return;
    }

    if (this.status !== 'build' && this.status !== 'failure' && this.status !== 'success') return;
    this.clearBoxes();
    this.collectedCollectibleIds.clear();
    this.collectibleDisappear.clear();
    this.metrics = this.freshMetrics();
    this.spawnAccumulator = this.getSpawnInterval();
    this.status = 'running';
    this.rebuildStaticBodies();
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
    this.rebuildStaticBodies();
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
      this.selectedCollectibleId = undefined;
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
      this.selectedCollectibleId = undefined;
      this.audio('place');
      this.emitSnapshot();
      this.emitEditorChanged();
    }
  }

  public replaceMachines(machines: readonly MachineState[]): void {
    if (this.editorPersistenceLocked && this.isAuthoring()) return;

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
    this.updateMachineMetrics();
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
    this.metrics.collectedStars = this.collectibles.length;
    this.evaluateContract();
  }

  public getSnapshot(): GameSnapshot {
    const selectedMachines = this.getSelectedMachines();
    const selectedObstacles = this.getSelectedObstacles();
    const selected = selectedMachines[0];
    const selectedObstacle = selectedObstacles[0];
    const economy = this.contract?.economy;
    const budgetLimit = this.getBudgetLimit();
    return {
      mode: this.mode,
      ...(this.contract ? { contractId: this.contract.id } : {}),
      contractTitle: this.contract?.title ?? SANDBOX_DEFINITION.title,
      contractDescription: this.contract?.description ?? SANDBOX_DEFINITION.description,
      status: this.status,
      metrics: { ...this.metrics },
      ...(this.contract ? { goal: { ...this.contract.goal } } : {}),
      ...(economy
        ? {
            economy: {
              spent: this.metrics.spent,
              ...(budgetLimit !== undefined
                ? { budgetLimit, hardLimit: budgetLimit * 2 }
                : {}),
              machineCosts: { ...economy.machineCosts },
              ...(economy.conveyorSpeedCosts
                ? { conveyorSpeedCosts: { ...economy.conveyorSpeedCosts } }
                : {}),
            },
          }
        : {}),
      ...(selected ? { selectedMachine: { ...selected } } : {}),
      ...(selected
        ? { selectedMachineClientBounds: this.machineClientBounds(selected) }
        : {}),
      ...(selectedObstacle ? { selectedObstacle: { ...selectedObstacle } } : {}),
      selection: {
        machineIds: selectedMachines.map((machine) => machine.id),
        obstacleIds: selectedObstacles.map((obstacle) => obstacle.id),
        collectibleIds: this.getSelectedCollectibles().map((collectible) => collectible.id),
        count: this.selectionCount(),
      },
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
      appEvents.on('ui:editor-begin-preview', () => this.beginEditorPreview()),
      appEvents.on('ui:editor-return', () => this.returnToEditor()),
      appEvents.on('ui:editor-highlight-invalid', ({ paths }) =>
        this.flashInvalidEditorEntities(paths),
      ),
      appEvents.on('ui:editor-hitboxes', ({ enabled }) =>
        this.setEditorHitboxesVisible(enabled),
      ),
      appEvents.on('ui:editor-persistence', ({ saving }) =>
        this.setEditorPersistenceLocked(saving),
      ),
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
      appEvents.on('ui:copy-selected', () => this.copySelected()),
      appEvents.on('ui:cut-selected', () => this.cutSelected()),
      appEvents.on('ui:reverse-selected', () => this.reverseSelected()),
      appEvents.on('ui:set-conveyor-speed', ({ speed }) =>
        this.setSelectedConveyorSpeed(speed),
      ),
      appEvents.on('ui:toggle-grid', () => this.toggleGrid()),
      appEvents.on('ui:set-simulation-speed', ({ speed }) => {
        this.setSimulationSpeed(speed);
      }),
      appEvents.on('ui:set-muted', ({ muted }) => {
        this.muted = muted;
        this.emitSnapshot();
      }),
      appEvents.on('ui:replay', () => this.resetRun()),
      appEvents.on('ui:menu', () => this.leaveToMenu()),
      appEvents.on('debug:set-machines', (machines) => this.replaceMachines(machines)),
    );
  }

  private bindInput(): void {
    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.handlePointerDown, this);
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.handlePointerMove, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.handlePointerUp, this);
    this.input.on(Phaser.Input.Events.POINTER_WHEEL, this.handleWheel, this);

    this.input.keyboard?.on('keydown-SPACE', (event: KeyboardEvent) => {
      if (this.shouldIgnoreGameplayShortcut(event)) return;
      event.preventDefault();
      this.toggleSimulation();
    });
    this.input.keyboard?.on('keydown-DELETE', (event: KeyboardEvent) => {
      if (this.shouldIgnoreGameplayShortcut(event)) return;
      this.deleteSelected();
    });
    this.input.keyboard?.on('keydown-BACKSPACE', (event: KeyboardEvent) => {
      if (this.shouldIgnoreGameplayShortcut(event)) return;
      event.preventDefault();
      this.deleteSelected();
    });
    this.input.keyboard?.on('keydown-Q', (event: KeyboardEvent) => {
      if (this.shouldIgnoreGameplayShortcut(event)) return;
      this.rotateSelectedBy(-this.rotationStep());
    });
    this.input.keyboard?.on('keydown-E', (event: KeyboardEvent) => {
      if (this.shouldIgnoreGameplayShortcut(event)) return;
      this.rotateSelectedBy(this.rotationStep());
    });
    this.input.keyboard?.on('keydown-R', (event: KeyboardEvent) => {
      if (this.shouldIgnoreGameplayShortcut(event)) return;
      this.reverseSelected();
    });
    this.input.keyboard?.on('keydown-C', (event: KeyboardEvent) => {
      if (this.shouldIgnoreGameplayShortcut(event)) return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this.copySelected();
    });
    this.input.keyboard?.on('keydown-X', (event: KeyboardEvent) => {
      if (this.shouldIgnoreGameplayShortcut(event)) return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this.cutSelected();
    });
    this.input.keyboard?.on('keydown-Z', (event: KeyboardEvent) => {
      if (this.shouldIgnoreGameplayShortcut(event)) return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
    });
    this.input.keyboard?.on('keydown-Y', (event: KeyboardEvent) => {
      if (this.shouldIgnoreGameplayShortcut(event)) return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this.redo();
    });

    this.contextMenuHandler = (event: MouseEvent) => event.preventDefault();
    this.game.canvas.addEventListener('contextmenu', this.contextMenuHandler);
  }

  private shouldIgnoreGameplayShortcut(event: KeyboardEvent): boolean {
    if (document.querySelector('#menu-screen:not(.is-hidden), .modal-layer:not(.is-hidden)')) {
      return true;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;
    if (
      target.isContentEditable ||
      target.matches('input, textarea, select, [role="textbox"], [role="slider"]')
    ) {
      return true;
    }

    return (
      event.code === 'Space' && Boolean(target.closest('button, summary, a[href], [role="button"]'))
    );
  }

  private handleToolDrag(payload: {
    type: EditorTool;
    phase: 'start' | 'move' | 'end' | 'cancel';
    clientX: number;
    clientY: number;
  }): void {
    if (payload.phase === 'cancel') {
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      this.ghostMachine = undefined;
      this.ghostObstacle = undefined;
      this.ghostCollectible = undefined;
      this.emitSnapshot();
      return;
    }

    if (payload.phase === 'start') {
      if (this.isAuthoring()) this.selectEditorTool(payload.type);
      else if (payload.type !== 'obstacle' && payload.type !== 'star') this.selectTool(payload.type);
      return;
    }

    const editorOnlyTool = payload.type === 'obstacle' || payload.type === 'star';
    const dragActive = this.isAuthoring()
      ? this.selectedEditorTool === payload.type
      : !editorOnlyTool && this.selectedTool === payload.type;
    if (!dragActive || !this.canBuild()) return;

    const bounds = this.game.canvas.getBoundingClientRect();
    const canvasX = (payload.clientX - bounds.left) * (this.game.canvas.width / bounds.width);
    const canvasY = (payload.clientY - bounds.top) * (this.game.canvas.height / bounds.height);
    const world = this.cameras.main.getWorldPoint(canvasX, canvasY);

    if (payload.phase === 'move') {
      if (!this.isInsideWorld(world)) {
        this.ghostMachine = undefined;
        this.ghostObstacle = undefined;
        this.ghostCollectible = undefined;
        return;
      }

      if (payload.type === 'obstacle') {
        this.ghostObstacle = {
          id: 'ghost-obstacle',
          gridX: Math.floor(world.x / CELL_SIZE),
          gridY: Math.floor(world.y / CELL_SIZE),
          columns: 1,
          rows: 1,
        };
        this.ghostValid = this.isObstaclePlacementValid(this.ghostObstacle);
        this.ghostMachine = undefined;
        this.ghostCollectible = undefined;
        return;
      }

      if (payload.type === 'star') {
        const grid = this.collectiblePositionFromWorld(world);
        this.ghostCollectible = {
          id: 'ghost-collectible',
          type: 'star',
          gridX: grid.x,
          gridY: grid.y,
        };
        this.ghostValid = this.isCollectiblePlacementValid(this.ghostCollectible);
        this.ghostMachine = undefined;
        this.ghostObstacle = undefined;
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
        conveyorSpeed: isConveyorType(payload.type)
          ? this.preferredConveyorSpeed
          : undefined,
        fixed: this.isAuthoring(),
      };
      this.ghostValid =
        this.canAffordMachines([this.ghostMachine]) &&
        this.isMachinePlacementValid(this.ghostMachine);
      this.ghostObstacle = undefined;
      this.ghostCollectible = undefined;
      return;
    }

    if (this.isInsideWorld(world)) {
      if (payload.type === 'obstacle') {
        this.placeObstacleAt(Math.floor(world.x / CELL_SIZE), Math.floor(world.y / CELL_SIZE));
      } else if (payload.type === 'star') {
        const grid = this.collectiblePositionFromWorld(world);
        this.placeCollectibleAt(grid.x, grid.y);
      } else {
        const grid = this.machinePositionFromWorld(world);
        this.placeMachineAt(payload.type, grid.x, grid.y);
      }
    }

    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.ghostCollectible = undefined;
    this.emitSnapshot();
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (this.editorPersistenceLocked && this.isAuthoring()) return;

    if (pointer.rightButtonDown()) {
      if (!this.canBuild()) return;
      const world = this.pointerWorld(pointer);
      if (!this.isInsideWorld(world)) return;
      this.clearClipboard();
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      this.clearSelection();
      this.ghostMachine = undefined;
      this.ghostObstacle = undefined;
      this.setDragState({
        kind: 'marquee',
        startWorld: { ...world },
        currentWorld: { ...world },
        lastScreenX: pointer.x,
        lastScreenY: pointer.y,
      });
      this.emitSnapshot();
      return;
    }
    if (!pointer.leftButtonDown()) return;

    const world = this.pointerWorld(pointer);
    if (!this.isInsideWorld(world)) return;

    if (this.groupClipboard) {
      this.placeGroupFromClipboardAt(world);
      return;
    }

    if (this.isAuthoring() && this.selectedEditorTool === 'obstacle') {
      this.placeObstacleAt(Math.floor(world.x / CELL_SIZE), Math.floor(world.y / CELL_SIZE));
      return;
    }

    if (this.isAuthoring() && this.selectedEditorTool === 'star') {
      const grid = this.collectiblePositionFromWorld(world);
      this.placeCollectibleAt(grid.x, grid.y);
      return;
    }

    if (this.obstacleClipboard && this.isAuthoring()) {
      this.placeObstacleFromClipboardAt(
        Math.floor(world.x / CELL_SIZE),
        Math.floor(world.y / CELL_SIZE),
      );
      return;
    }


    if (this.collectibleClipboard && this.isAuthoring()) {
      const grid = this.collectiblePositionFromWorld(world);
      this.placeCollectibleFromClipboardAt(grid.x, grid.y);
      return;
    }

    if (this.machineClipboard) {
      const grid = this.machinePositionFromWorld(world);
      this.placeMachineFromClipboardAt(grid.x, grid.y);
      return;
    }

    if (this.selectedTool) {
      const grid = this.machinePositionFromWorld(world);
      this.placeMachineAt(this.selectedTool, grid.x, grid.y);
      return;
    }

    const selectedHit = [...this.getSelectedMachines()]
      .reverse()
      .find((machine) => pointInsideMachine(world, machine, 7));
    const selectedObstacleHit = this.isAuthoring()
      ? [...this.getSelectedObstacles()]
          .reverse()
          .find((obstacle) => this.pointInsideObstacle(world, obstacle))
      : undefined;
    const selectedCollectibleHit = this.isAuthoring()
      ? [...this.getSelectedCollectibles()]
          .reverse()
          .find(
            (collectible) =>
              distance(world, this.collectibleCenter(collectible)) <=
              (STAR_RENDER_RADIUS + 8) / fromCameraZoom(this.cameras.main.zoom),
          )
      : undefined;
    if (
      this.selectionCount() > 1 &&
      (selectedHit || selectedObstacleHit || selectedCollectibleHit) &&
      this.beginGroupMove(world)
    ) {
      return;
    }

    const hit = this.findMachineAt(world);
    const hitObstacle = this.isAuthoring() ? this.findObstacleAt(world) : undefined;

    const selected = this.getSelectedMachine();
    if (
      this.selectionCount() === 1 &&
      selected &&
      this.canEditMachine(selected) &&
      this.isRotatable(selected) &&
      distance(world, rotationHandle(selected)) <= 18 / fromCameraZoom(this.cameras.main.zoom)
    ) {
      this.setDragState({
        kind: 'rotate',
        machineId: selected.id,
        before: cloneMachines(this.machines),
        preview: { ...selected },
        valid: true,
        lastScreenX: pointer.x,
        lastScreenY: pointer.y,
      });
      this.emitAngle(pointer, selected.angle, true);
      return;
    }

    const selectedObstacle = this.getSelectedObstacle();
    if (
      this.selectionCount() === 1 &&
      selectedObstacle &&
      this.isAuthoring() &&
      distance(world, this.obstacleRotationHandle(selectedObstacle)) <=
        18 / fromCameraZoom(this.cameras.main.zoom)
    ) {
      this.setDragState({
        kind: 'obstacle-rotate',
        obstacleId: selectedObstacle.id,
        beforeDocument: this.captureEditorDocument(),
        previewObstacle: { ...selectedObstacle },
        valid: true,
        lastScreenX: pointer.x,
        lastScreenY: pointer.y,
      });
      this.emitAngle(pointer, selectedObstacle.angle ?? 0, true);
      return;
    }

    const obstacleResizeHandle =
      this.selectionCount() === 1 && selectedObstacle && this.isAuthoring()
        ? this.findObstacleResizeHandle(selectedObstacle, world)
        : undefined;
    if (selectedObstacle && obstacleResizeHandle) {
      this.setDragState({
        kind: 'obstacle-resize',
        obstacleId: selectedObstacle.id,
        beforeDocument: this.captureEditorDocument(),
        previewObstacle: { ...selectedObstacle },
        obstacleResizeHandle,
        obstacleResizeAnchor: this.obstacleResizeHandlePoint(selectedObstacle, {
          x: -obstacleResizeHandle.x as ResizeDirection,
          y: -obstacleResizeHandle.y as ResizeDirection,
        }),
        valid: true,
        lastScreenX: pointer.x,
        lastScreenY: pointer.y,
      });
      return;
    }

    // Selection affordances are drawn above collectibles, so their hit areas must follow the
    // same visual stacking order. A collectible remains clickable wherever it extends beyond
    // the selected item's body and controls.
    if (this.selectionCount() === 1 && selectedHit) {
      if (!this.canEditMachine(selectedHit)) {
        this.selectedMachineId = undefined;
        this.selectedObstacleId = undefined;
        this.emitSnapshot();
        return;
      }
      this.selectedMachineId = selectedHit.id;
      this.selectedObstacleId = undefined;
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      if (this.canBuild()) {
        const center = machineCenter(selectedHit);
        this.setDragState({
          kind: 'move',
          machineId: selectedHit.id,
          before: cloneMachines(this.machines),
          preview: { ...selectedHit },
          grabOffsetX: world.x - center.x,
          grabOffsetY: world.y - center.y,
          valid: true,
          lastScreenX: pointer.x,
          lastScreenY: pointer.y,
        });
      }
      this.emitSnapshot();
      return;
    }

    if (this.selectionCount() === 1 && selectedObstacleHit) {
      this.selectedObstacleId = selectedObstacleHit.id;
      this.selectedMachineId = undefined;
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      this.setDragState({
        kind: 'obstacle-move',
        obstacleId: selectedObstacleHit.id,
        beforeDocument: this.captureEditorDocument(),
        previewObstacle: { ...selectedObstacleHit },
        grabOffsetX: world.x / CELL_SIZE - selectedObstacleHit.gridX,
        grabOffsetY: world.y / CELL_SIZE - selectedObstacleHit.gridY,
        valid: true,
        lastScreenX: pointer.x,
        lastScreenY: pointer.y,
      });
      this.emitSnapshot();
      return;
    }

    const selectedCollectible = this.getSelectedCollectible();
    const prioritizedCollectible =
      this.selectionCount() === 1 &&
      selectedCollectible &&
      distance(world, this.collectibleCenter(selectedCollectible)) <=
        (STAR_RENDER_RADIUS + 8) / fromCameraZoom(this.cameras.main.zoom)
        ? selectedCollectible
        : undefined;
    const hitCollectible = this.isAuthoring()
      ? prioritizedCollectible ?? this.findCollectibleAt(world)
      : undefined;
    if (hitCollectible) {
      const center = this.collectibleCenter(hitCollectible);
      this.selectedCollectibleId = hitCollectible.id;
      this.selectedMachineId = undefined;
      this.selectedObstacleId = undefined;
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      this.setDragState({
        kind: 'collectible-move',
        collectibleId: hitCollectible.id,
        beforeDocument: this.captureEditorDocument(),
        previewCollectible: { ...hitCollectible },
        grabOffsetX: world.x - center.x,
        grabOffsetY: world.y - center.y,
        valid: true,
        lastScreenX: pointer.x,
        lastScreenY: pointer.y,
      });
      this.emitSnapshot();
      return;
    }

    if (hit) {
      if (!this.canEditMachine(hit)) {
        this.selectedMachineId = undefined;
        this.selectedObstacleId = undefined;
        this.emitSnapshot();
        return;
      }
      this.selectedMachineId = hit.id;
      this.selectedObstacleId = undefined;
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      if (this.canEditMachine(hit) && this.canBuild()) {
        const center = machineCenter(hit);
        this.setDragState({
          kind: 'move',
          machineId: hit.id,
          before: cloneMachines(this.machines),
          preview: { ...hit },
          grabOffsetX: world.x - center.x,
          grabOffsetY: world.y - center.y,
          valid: true,
          lastScreenX: pointer.x,
          lastScreenY: pointer.y,
        });
      }
      this.emitSnapshot();
      return;
    }

    if (hitObstacle) {
      this.selectedObstacleId = hitObstacle.id;
      this.selectedMachineId = undefined;
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      this.setDragState({
        kind: 'obstacle-move',
        obstacleId: hitObstacle.id,
        beforeDocument: this.captureEditorDocument(),
        previewObstacle: { ...hitObstacle },
        grabOffsetX: world.x / CELL_SIZE - hitObstacle.gridX,
        grabOffsetY: world.y / CELL_SIZE - hitObstacle.gridY,
        valid: true,
        lastScreenX: pointer.x,
        lastScreenY: pointer.y,
      });
      this.emitSnapshot();
      return;
    }

    this.selectedMachineId = undefined;
    this.selectedObstacleId = undefined;
    this.selectedCollectibleId = undefined;
    this.setDragState({
      kind: 'pan',
      lastScreenX: pointer.x,
      lastScreenY: pointer.y,
    });
    this.emitSnapshot();
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.editorPersistenceLocked && this.isAuthoring()) return;

    const world = this.pointerWorld(pointer);

    if (this.drag?.kind === 'marquee' && pointer.isDown) {
      this.drag.currentWorld = { ...world };
      return;
    }

    if (this.drag?.kind === 'pan' && pointer.isDown) {
      const camera = this.cameras.main;
      camera.scrollX -= (pointer.x - this.drag.lastScreenX) / camera.zoom;
      camera.scrollY -= (pointer.y - this.drag.lastScreenY) / camera.zoom;
      this.drag.lastScreenX = pointer.x;
      this.drag.lastScreenY = pointer.y;
      this.emitCamera();
      this.syncEditorCamera();
      return;
    }

    if (this.drag?.kind === 'group-move' && pointer.isDown) {
      this.updateGroupMovePreview(this.drag, world);
      return;
    }

    if (this.drag?.kind === 'move' && this.drag.preview && pointer.isDown) {
      const grid = this.machinePositionFromWorld({
        x: world.x - (this.drag.grabOffsetX ?? 0),
        y: world.y - (this.drag.grabOffsetY ?? 0),
      });
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
      const gridX = this.snapEditorPosition(
        world.x / CELL_SIZE - (this.drag.grabOffsetX ?? 0),
      );
      const gridY = this.snapEditorPosition(
        world.y / CELL_SIZE - (this.drag.grabOffsetY ?? 0),
      );
      this.drag.previewObstacle = { ...this.drag.previewObstacle, gridX, gridY };
      this.drag.valid = this.isObstaclePlacementValid(
        this.drag.previewObstacle,
        this.drag.obstacleId,
      );
      return;
    }

    if (this.drag?.kind === 'obstacle-rotate' && this.drag.previewObstacle && pointer.isDown) {
      const center = this.obstacleCenter(this.drag.previewObstacle);
      const angle = this.snapRotationAngle(
        Phaser.Math.RadToDeg(Math.atan2(world.y - center.y, world.x - center.x)) + 90,
      );
      this.drag.previewObstacle = { ...this.drag.previewObstacle, angle };
      this.drag.valid = this.isObstaclePlacementValid(
        this.drag.previewObstacle,
        this.drag.obstacleId,
      );
      this.emitAngle(pointer, angle, true);
      return;
    }

    if (
      this.drag?.kind === 'obstacle-resize' &&
      this.drag.previewObstacle &&
      this.drag.obstacleResizeHandle &&
      this.drag.obstacleResizeAnchor &&
      pointer.isDown
    ) {
      const handle = this.drag.obstacleResizeHandle;
      const anchor = this.drag.obstacleResizeAnchor;
      const angle = this.drag.previewObstacle.angle ?? 0;
      const localPointer = worldToLocal(anchor, angle, world);
      const columns =
        handle.x === 0
          ? this.drag.previewObstacle.columns
          : Math.max(1, Math.round((localPointer.x * handle.x) / CELL_SIZE));
      const rows =
        handle.y === 0
          ? this.drag.previewObstacle.rows
          : Math.max(1, Math.round((localPointer.y * handle.y) / CELL_SIZE));
      const center = localToWorld(
        anchor,
        angle,
        (handle.x * columns * CELL_SIZE) / 2,
        (handle.y * rows * CELL_SIZE) / 2,
      );
      this.drag.previewObstacle = {
        ...this.drag.previewObstacle,
        gridX: this.snapEditorPosition(center.x / CELL_SIZE - columns / 2),
        gridY: this.snapEditorPosition(center.y / CELL_SIZE - rows / 2),
        columns,
        rows,
      };
      this.drag.valid = this.isObstaclePlacementValid(
        this.drag.previewObstacle,
        this.drag.obstacleId,
      );
      return;
    }

    if (
      this.drag?.kind === 'collectible-move' &&
      this.drag.previewCollectible &&
      pointer.isDown
    ) {
      const grid = this.collectiblePositionFromWorld({
        x: world.x - (this.drag.grabOffsetX ?? 0),
        y: world.y - (this.drag.grabOffsetY ?? 0),
      });
      this.drag.previewCollectible = {
        ...this.drag.previewCollectible,
        gridX: grid.x,
        gridY: grid.y,
      };
      this.drag.valid = this.isCollectiblePlacementValid(this.drag.previewCollectible);
      return;
    }

    if (this.groupClipboard) {
      if (this.isInsideWorld(world)) this.updateGroupGhostAt(world);
      else {
        this.ghostGroupMachines = [];
        this.ghostGroupObstacles = [];
        this.ghostGroupCollectibles = [];
        this.groupGhostAnchor = undefined;
      }
      this.ghostMachine = undefined;
      this.ghostObstacle = undefined;
      return;
    }

    if (this.obstacleClipboard && this.isAuthoring() && this.isInsideWorld(world)) {
      this.ghostObstacle = {
        id: 'ghost-obstacle',
        ...this.obstacleClipboard,
        gridX: Math.floor(world.x / CELL_SIZE),
        gridY: Math.floor(world.y / CELL_SIZE),
      };
      this.ghostValid = this.isObstaclePlacementValid(this.ghostObstacle);
      this.ghostMachine = undefined;
      return;
    }

    if (this.collectibleClipboard && this.isAuthoring() && this.isInsideWorld(world)) {
      const grid = this.collectiblePositionFromWorld(world);
      this.ghostCollectible = {
        id: 'ghost-collectible',
        type: this.collectibleClipboard.type,
        gridX: grid.x,
        gridY: grid.y,
      };
      this.ghostValid = this.isCollectiblePlacementValid(this.ghostCollectible);
      this.ghostMachine = undefined;
      this.ghostObstacle = undefined;
      return;
    }

    if (this.machineClipboard && this.isInsideWorld(world)) {
      const grid = this.machinePositionFromWorld(world);
      this.ghostMachine = {
        id: 'ghost',
        ...this.machineClipboard,
        gridX: grid.x,
        gridY: grid.y,
      };
      this.ghostValid =
        this.canAffordMachines([this.ghostMachine]) &&
        this.isMachinePlacementValid(this.ghostMachine);
      this.ghostObstacle = undefined;
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


    if (this.isAuthoring() && this.selectedEditorTool === 'star' && this.isInsideWorld(world)) {
      const grid = this.collectiblePositionFromWorld(world);
      this.ghostCollectible = {
        id: 'ghost-collectible',
        type: 'star',
        gridX: grid.x,
        gridY: grid.y,
      };
      this.ghostValid = this.isCollectiblePlacementValid(this.ghostCollectible);
      this.ghostMachine = undefined;
      this.ghostObstacle = undefined;
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
          conveyorSpeed: isConveyorType(this.selectedTool)
            ? this.preferredConveyorSpeed
            : undefined,
          fixed: this.isAuthoring(),
        };
        this.ghostValid =
          this.canAffordMachines([this.ghostMachine]) &&
          this.isMachinePlacementValid(this.ghostMachine);
      }
    } else {
      this.ghostMachine = undefined;
      this.ghostObstacle = undefined;
      this.ghostCollectible = undefined;
    }
  }

  private handlePointerUp(pointer: Phaser.Input.Pointer): void {
    if (this.editorPersistenceLocked && this.isAuthoring()) {
      this.setDragState(undefined);
      return;
    }

    const drag = this.drag;
    this.setDragState(undefined);
    if (!drag) return;

    if (drag.kind === 'marquee' && drag.startWorld && drag.currentWorld) {
      const moved = Math.hypot(pointer.x - drag.lastScreenX, pointer.y - drag.lastScreenY);
      if (moved >= 5) this.selectItemsInsideMarquee(drag.startWorld, drag.currentWorld);
      else this.clearSelection();
      this.emitSnapshot();
      return;
    }

    if (drag.kind === 'group-move') {
      this.commitGroupMove(drag);
      return;
    }

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
    if (drag.kind === 'obstacle-rotate') {
      this.emitAngle(pointer, drag.previewObstacle?.angle ?? 0, false);
    }

    if (
      (drag.kind === 'obstacle-move' ||
        drag.kind === 'obstacle-resize' ||
        drag.kind === 'obstacle-rotate') &&
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
          label:
            drag.kind === 'obstacle-resize'
              ? 'Redimensionar bloqueador'
              : drag.kind === 'obstacle-rotate'
                ? 'Girar bloqueador'
                : 'Mover bloqueador',
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

    if (
      drag.kind === 'collectible-move' &&
      drag.previewCollectible &&
      drag.beforeDocument
    ) {
      const original = drag.beforeDocument.collectibles.find(
        (collectible) => collectible.id === drag.collectibleId,
      );
      if (!drag.valid || !original) {
        this.toast('Solte a estrela dentro do tabuleiro.', 'danger');
        this.audio('error');
        return;
      }
      if (this.sameCollectibleState(original, drag.previewCollectible)) return;
      const after = cloneEditorDocument(drag.beforeDocument);
      after.collectibles = after.collectibles.map((collectible) =>
        collectible.id === drag.collectibleId ? { ...drag.previewCollectible! } : collectible,
      );
      this.applyEditorDocument(after, false);
      this.activeHistory().record(
        createSnapshotCommand({
          label: 'Mover estrela',
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
    if (this.editorPersistenceLocked && this.isAuthoring()) return;

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
    this.syncEditorCamera();
  }

  private updateSources(): void {
    const interval = this.getSpawnInterval();
    if (this.spawnAccumulator < interval || this.boxes.size >= 32) return;
    this.spawnAccumulator %= interval;
    for (const source of this.sourceMachines) {
      this.spawnBox(source);
    }
  }

  private simulateFixedStep(): void {
    this.simulationTimeMs += FIXED_PHYSICS_STEP_MS;
    this.spawnAccumulator += FIXED_PHYSICS_STEP_SECONDS;
    this.updateSources();
    this.updateConveyors();
    this.updateTrackedConveyors();
    for (const box of this.boxes.values()) {
      box.velocityBeforePhysics = { ...box.body.velocity };
    }
    this.matter.world.step(FIXED_PHYSICS_STEP_MS);
    this.updateCollectibles();
    this.updateSprings();
    this.updateReceivers();
    this.updateLostBoxes();
    this.evaluateContract();
  }

  private spawnBox(source: MachineState): void {
    const center = machineCenter(source);
    const output = localToWorld(
      center,
      source.angle,
      0,
      MACHINE_DIMENSIONS.source.height / 2 + BOX_SIZE / 2 - 6,
    );
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
      velocityBeforePhysics: { ...body.velocity },
    });
    this.audio('spawn');
  }

  private updateConveyors(): void {
    for (const box of this.boxes.values()) {
      for (const conveyor of this.conveyorMachines) {
        const center = machineCenter(conveyor);
        const local = worldToLocal(center, conveyor.angle, box.body.position);
        const dimensions = MACHINE_PHYSICS_DIMENSIONS.conveyor;
        if (
          Math.abs(local.x) > dimensions.width / 2 + BOX_SIZE / 2 ||
          local.y < -BOX_SIZE - dimensions.height / 2 ||
          local.y > dimensions.height / 2 + 5
        ) {
          continue;
        }
        this.matter.body.setVelocity(
          box.body,
          conveyorVelocity(
            box.body.velocity,
            conveyor.angle,
            conveyor.reversed,
            CONVEYOR_SPEED * conveyorSpeedMultiplier(conveyor),
          ),
        );
      }
    }
  }

  private updateTrackedConveyors(): void {
    for (const runtime of this.trackedConveyors.values()) {
      const direction = runtime.machine.reversed ? -1 : 1;
      const speedMultiplier = conveyorSpeedMultiplier(runtime.machine);
      runtime.phase =
        (runtime.phase +
          TRACKED_CONVEYOR_SPEED * speedMultiplier * direction +
          TRACKED_CONVEYOR_TRACK_LENGTH) %
        TRACKED_CONVEYOR_TRACK_LENGTH;
      const center = machineCenter(runtime.machine);
      for (let index = 0; index < runtime.links.length; index += 1) {
        const link = runtime.links[index]!;
        const pose = trackedConveyorPoseAt(
          center,
          runtime.machine.angle,
          (index * TRACKED_CONVEYOR_TRACK_LENGTH) / TRACKED_CONVEYOR_LINK_COUNT + runtime.phase,
        );
        let targetAngle = pose.angle;
        while (targetAngle - link.angle > Math.PI) targetAngle -= Math.PI * 2;
        while (targetAngle - link.angle < -Math.PI) targetAngle += Math.PI * 2;
        // Guided static bodies act as a stable kinematic chain. Passing updateVelocity=true
        // gives Matter the surface velocity it needs to resolve friction against boxes.
        this.matter.body.setPosition(link, pose.center, true);
        this.matter.body.setAngle(link, targetAngle, true);
      }
    }
  }

  private updateSprings(): void {
    for (const box of this.boxes.values()) {
      if (this.simulationTimeMs < box.springReadyAt) continue;
      for (const spring of this.springMachines) {
        const center = machineCenter(spring);
        const dimensions = MACHINE_DIMENSIONS[spring.type];
        const localBox = worldToLocal(center, spring.angle, box.body.position);
        const face = localBox.y <= 0 ? 'top' : 'bottom';
        if (!boxTouchesOrientedSurface(
          box.body.position,
          Phaser.Math.RadToDeg(box.body.angle),
          BOX_SIZE,
          center,
          spring.angle,
          dimensions.width,
          dimensions.height,
          1,
          face,
        )) {
          continue;
        }

        const radians = degreesToRadians(spring.angle);
        const up = { x: Math.sin(radians), y: -Math.cos(radians) };
        const normalDirection = face === 'top' ? 1 : -1;
        const normal = {
          x: up.x * normalDirection,
          y: up.y * normalDirection,
        };
        const incomingVelocity = box.velocityBeforePhysics;
        const approachSpeed =
          incomingVelocity.x * normal.x + incomingVelocity.y * normal.y;
        if (approachSpeed > 1.5) continue;
        this.matter.body.setVelocity(
          box.body,
          springVelocity(
            incomingVelocity,
            spring.angle,
            spring.type === 'turbo-spring'
              ? TURBO_SPRING_LAUNCH_SPEED
              : SPRING_LAUNCH_SPEED,
            normalDirection,
          ),
        );
        box.springReadyAt = this.simulationTimeMs + 360;
        this.springCompression.set(spring.id, normalDirection);
        this.spawnBurst(box.body.position.x, box.body.position.y, COLORS.blueLight, 5);
        this.audio('bounce');
        break;
      }
    }
  }

  private updateCollectibles(): void {
    if (this.collectibles.length === 0 || this.boxes.size === 0) return;
    for (const collectible of this.collectibles) {
      if (this.collectedCollectibleIds.has(collectible.id)) continue;
      const center = this.collectibleCenter(collectible);
      const touched = [...this.boxes.values()].some(
        (box) => distance(center, box.body.position) <= STAR_PICKUP_RADIUS,
      );
      if (!touched) continue;

      this.collectedCollectibleIds.add(collectible.id);
      this.collectibleDisappear.set(collectible.id, 0.28);
      this.metrics.collectedStars += 1;
      this.spawnBurst(center.x, center.y, COLORS.star, 14);
      this.spawnBurst(center.x, center.y, COLORS.starLight, 7);
      this.audio('deliver');
    }
  }

  private updateReceivers(): void {
    const delivered: BoxRuntime[] = [];
    for (const box of this.boxes.values()) {
      for (const receiver of this.receiverMachines) {
        const dimensions = MACHINE_PHYSICS_DIMENSIONS.receiver;
        if (
          pointInsideOrientedSensor(
            box.body.position,
            machineCenter(receiver),
            dimensions.width,
            dimensions.height,
            receiver.angle,
            BOX_SIZE / 2,
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
    const budgetLimit = this.getBudgetLimit();
    const evaluation = evaluateRun(
      this.metrics,
      this.contract.goal,
      this.collectibles.length,
      budgetLimit,
    );
    if (
      !evaluation.resolution &&
      !this.budgetCompletionWarningShown &&
      budgetLimit !== undefined &&
      this.metrics.spent > budgetLimit &&
      this.metrics.delivered >= this.contract.goal.deliveries &&
      this.metrics.collectedStars >= this.collectibles.length
    ) {
      this.budgetCompletionWarningShown = true;
      this.toast(
        'Meta atingida, mas o orçamento foi ultrapassado. Pause e remova itens para concluir.',
        'danger',
      );
      this.audio('error');
    }
    if (!evaluation.resolution) return;

    this.status = evaluation.resolution;
    this.matter.world.pause();
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
      this.toast('Muitas caixas foram perdidas.', 'danger');
      this.audio('error');
    }
    if (!this.editorActive) {
      appEvents.emit('game:result', {
        contractId: this.contract.id,
        snapshot: this.getSnapshot(),
      });
    }
    this.emitSnapshot();
  }

  private updateEffects(deltaSeconds: number): void {
    for (const [id, remaining] of this.collectibleDisappear) {
      const next = remaining - deltaSeconds;
      if (next <= 0) this.collectibleDisappear.delete(id);
      else this.collectibleDisappear.set(id, next);
    }
    for (const [id, compression] of this.springCompression) {
      const nextMagnitude = Math.max(0, Math.abs(compression) - deltaSeconds * 4.8);
      if (nextMagnitude === 0) this.springCompression.delete(id);
      else this.springCompression.set(id, Math.sign(compression) * nextMagnitude);
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

  private worldNeedsContinuousRender(): boolean {
    return Boolean(
      this.status === 'running' ||
      this.drag ||
      this.ghostMachine ||
      this.ghostObstacle ||
      this.ghostCollectible ||
      this.ghostGroupMachines.length > 0 ||
      this.ghostGroupObstacles.length > 0 ||
      this.ghostGroupCollectibles.length > 0 ||
      this.springCompression.size > 0 ||
      this.receiverPulse.size > 0 ||
      this.collectibleDisappear.size > 0 ||
      this.particles.length > 0 ||
      Boolean(
        this.invalidEntityFlash &&
          performance.now() < this.invalidEntityFlash.endsAt,
      )
    );
  }

  private visibleInvalidEntityFlash(now = performance.now()): InvalidEntityFlash | undefined {
    const flash = this.invalidEntityFlash;
    if (!flash || now >= flash.endsAt) return undefined;
    const interval = Math.floor((now - flash.startedAt) / INVALID_ENTITY_FLASH_INTERVAL_MS);
    return interval % 2 === 0 ? flash : undefined;
  }

  private idleWorldRenderSignature(): string {
    const camera = this.cameras.main;
    const machines = this.machines
      .map(
        ({ id, type, gridX, gridY, angle, reversed, conveyorSpeed: speed, fixed }) =>
          `${id}:${type}:${gridX}:${gridY}:${angle}:${Number(reversed)}:${speed ?? 'normal'}:${Number(fixed)}`,
      )
      .join(';');
    const obstacles = this.obstacles
      .map(({ id, gridX, gridY, columns, rows }) => `${id}:${gridX}:${gridY}:${columns}:${rows}`)
      .join(';');
    const collectibles = this.collectibles
      .map(({ id, type, gridX, gridY }) => `${id}:${type}:${gridX}:${gridY}`)
      .join(';');
    const boxes = [...this.boxes.values()]
      .map(({ id, body }) => `${id}:${body.position.x}:${body.position.y}:${body.angle}`)
      .join(';');

    return [
      this.status,
      camera.zoom,
      this.metrics.delivered,
      machines,
      obstacles,
      collectibles,
      boxes,
      [...this.selectedMachineIds].join(','),
      [...this.selectedObstacleIds].join(','),
      [...this.selectedCollectibleIds].join(','),
    ].join('|');
  }

  private renderWorld(): void {
    const graphics = this.worldGraphics;
    graphics.clear();
    const invalidFlash = this.visibleInvalidEntityFlash();
    const groupDrag = this.drag?.kind === 'group-move' ? this.drag : undefined;
    const groupMachineIds = new Set(groupDrag?.previewMachines?.map((machine) => machine.id) ?? []);
    const groupObstacleIds = new Set(
      groupDrag?.previewObstacles?.map((obstacle) => obstacle.id) ?? [],
    );
    const groupCollectibleIds = new Set(
      groupDrag?.previewCollectibles?.map((collectible) => collectible.id) ?? [],
    );
    const drawCollectibles = (): void => {
      for (const collectible of this.collectibles) {
        if (groupCollectibleIds.has(collectible.id)) continue;
        const disappearing = this.collectibleDisappear.get(collectible.id);
        if (this.collectedCollectibleIds.has(collectible.id) && disappearing === undefined) {
          continue;
        }
        const preview =
          this.drag?.collectibleId === collectible.id
            ? this.drag.previewCollectible
            : undefined;
        if (!preview) {
          const progress = disappearing === undefined ? 0 : 1 - disappearing / 0.28;
          this.drawCollectible(
            graphics,
            collectible,
            1 - progress,
            1 - progress * 0.75,
            !invalidFlash?.collectibleIds.has(collectible.id),
          );
        }
      }
      if (this.drag?.previewCollectible) {
        this.drawCollectible(
          graphics,
          this.drag.previewCollectible,
          1,
          this.drag.valid === false ? 0.45 : 1,
        );
      }
      for (const collectible of groupDrag?.previewCollectibles ?? []) {
        this.drawCollectible(
          graphics,
          collectible,
          1,
          groupDrag?.valid === false ? 0.45 : 1,
        );
      }
    };

    if (!this.isAuthoring()) drawCollectibles();
    for (const obstacle of this.obstacles) {
      if (groupObstacleIds.has(obstacle.id)) continue;
      const preview = this.drag?.obstacleId === obstacle.id ? this.drag.previewObstacle : undefined;
      if (!preview) {
        this.drawObstacle(graphics, obstacle, 1, !invalidFlash?.obstacleIds.has(obstacle.id));
      }
    }
    for (const obstacle of groupDrag?.previewObstacles ?? []) {
      this.drawObstacle(graphics, obstacle, 1, groupDrag?.valid !== false);
    }
    for (const machine of this.machines) {
      if (groupMachineIds.has(machine.id)) continue;
      const preview = this.drag?.machineId === machine.id ? this.drag.preview : undefined;
      this.drawMachine(
        graphics,
        preview ?? machine,
        1,
        preview
          ? this.drag?.valid !== false
          : !invalidFlash?.machineIds.has(machine.id),
      );
    }
    for (const machine of groupDrag?.previewMachines ?? []) {
      this.drawMachine(graphics, machine, 1, groupDrag?.valid !== false);
    }
    if (this.isAuthoring()) drawCollectibles();
    const effects = this.effectsGraphics;
    effects.clear();
    for (const particle of this.particles) {
      effects.fillStyle(particle.color, Phaser.Math.Clamp(particle.life / particle.maxLife, 0, 1));
      effects.fillRect(particle.x, particle.y, particle.size, particle.size);
    }

    const overlay = this.overlayGraphics;
    overlay.clear();
    if (this.ghostMachine) this.drawMachine(overlay, this.ghostMachine, 0.42, this.ghostValid);
    for (const ghost of this.ghostGroupMachines) {
      this.drawMachine(overlay, ghost, 0.42, this.ghostValid);
    }
    if (this.ghostObstacle) {
      this.drawObstacle(overlay, this.ghostObstacle, 0.42, this.ghostValid);
    }
    if (this.ghostCollectible) {
      this.drawCollectible(overlay, this.ghostCollectible, 0.82, this.ghostValid ? 0.72 : 0.4);
    }
    for (const ghost of this.ghostGroupObstacles) {
      this.drawObstacle(overlay, ghost, 0.42, this.ghostValid);
    }
    for (const ghost of this.ghostGroupCollectibles) {
      this.drawCollectible(overlay, ghost, 0.82, this.ghostValid ? 0.72 : 0.4);
    }
    if (this.drag?.previewObstacle) {
      this.drawObstacle(overlay, this.drag.previewObstacle, 0.72, this.drag.valid !== false);
    }
    const selectedMachines = this.getSelectedMachines();
    const selectedObstacles = this.getSelectedObstacles();
    const selectedCollectibles = this.getSelectedCollectibles();
    const selectionCount =
      selectedMachines.length + selectedObstacles.length + selectedCollectibles.length;
    if (groupDrag) {
      for (const preview of groupDrag.previewMachines ?? []) {
        this.drawSelection(overlay, preview, groupDrag.valid !== false, false);
      }
    } else if (this.drag?.preview) {
      this.drawSelection(overlay, this.drag.preview, this.drag.valid !== false, true);
    } else {
      for (const selected of selectedMachines) {
        this.drawSelection(overlay, selected, true, selectionCount === 1);
      }
    }
    if (groupDrag) {
      for (const preview of groupDrag.previewObstacles ?? []) {
        this.drawObstacleSelection(overlay, preview, groupDrag.valid !== false, false);
      }
    } else if (this.drag?.previewObstacle) {
      this.drawObstacleSelection(
        overlay,
        this.drag.previewObstacle,
        this.drag.valid !== false,
        true,
      );
    } else {
      for (const selectedObstacle of selectedObstacles) {
        this.drawObstacleSelection(overlay, selectedObstacle, true, selectionCount === 1);
      }
    }
    if (groupDrag) {
      for (const preview of groupDrag.previewCollectibles ?? []) {
        this.drawCollectibleSelection(overlay, preview);
      }
    } else if (!this.drag?.previewCollectible) {
      for (const selectedCollectible of selectedCollectibles) {
        this.drawCollectibleSelection(overlay, selectedCollectible);
      }
    }
    if (this.editorHitboxesVisible && this.isAuthoring()) {
      this.drawEditorHitboxes(overlay);
    }
    if (this.drag?.kind === 'marquee' && this.drag.startWorld && this.drag.currentWorld) {
      this.drawMarquee(overlay, this.drag.startWorld, this.drag.currentWorld);
    }
  }

  private drawEditorHitboxes(graphics: Phaser.GameObjects.Graphics): void {
    const zoom = fromCameraZoom(this.cameras.main.zoom);
    const groupMachinePreviews = new Map(
      (this.drag?.previewMachines ?? []).map((machine) => [machine.id, machine]),
    );
    const groupObstaclePreviews = new Map(
      (this.drag?.previewObstacles ?? []).map((obstacle) => [obstacle.id, obstacle]),
    );
    const groupCollectiblePreviews = new Map(
      (this.drag?.previewCollectibles ?? []).map((collectible) => [collectible.id, collectible]),
    );
    const machinePolygons = this.machines.map((machine) =>
      machinePolygon(
        groupMachinePreviews.get(machine.id) ??
          (this.drag?.machineId === machine.id ? this.drag.preview : undefined) ??
          machine,
      ),
    );
    const obstaclePolygons = this.obstacles.map((obstacle) =>
      this.obstaclePolygon(
        groupObstaclePreviews.get(obstacle.id) ??
          (this.drag?.obstacleId === obstacle.id ? this.drag.previewObstacle : undefined) ??
          obstacle,
      ),
    );

    graphics.fillStyle(COLORS.hitbox, 0.055);
    for (const polygon of [...machinePolygons, ...obstaclePolygons]) {
      drawPolygon(graphics, polygon);
    }
    graphics.lineStyle(2 / zoom, COLORS.hitbox, 0.98);
    for (const polygon of [...machinePolygons, ...obstaclePolygons]) {
      linePolygon(graphics, polygon);
    }
    for (const collectible of this.collectibles) {
      const visible =
        groupCollectiblePreviews.get(collectible.id) ??
        (this.drag?.collectibleId === collectible.id
          ? this.drag.previewCollectible
          : undefined) ??
        collectible;
      const center = this.collectibleCenter(visible);
      graphics.fillStyle(COLORS.hitbox, 0.055);
      graphics.fillCircle(center.x, center.y, STAR_PICKUP_RADIUS);
      graphics.lineStyle(2 / zoom, COLORS.hitbox, 0.98);
      graphics.strokeCircle(center.x, center.y, STAR_PICKUP_RADIUS);
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

  private drawCollectible(
    graphics: Phaser.GameObjects.Graphics,
    collectible: CollectibleDefinition,
    scale = 1,
    alpha = 1,
    valid = true,
  ): void {
    const center = this.collectibleCenter(collectible);
    // The visual clock only advances while the simulation is running. This keeps
    // stars facing forward during construction and freezes their current frame
    // when paused instead of letting pointer-driven redraws animate them.
    const facing = Math.cos(this.simulationVisualTimeMs * 0.0042);
    const widthScale = 0.2 + Math.abs(facing) * 0.8;
    const radius = STAR_RENDER_RADIUS * Math.max(0, scale);
    if (radius <= 0.1 || alpha <= 0.01) return;

    const points: Point[] = [];
    for (let index = 0; index < 10; index += 1) {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / 10;
      const pointRadius = index % 2 === 0 ? radius : radius * 0.47;
      points.push({
        x: center.x + Math.cos(angle) * pointRadius * widthScale,
        y: center.y + Math.sin(angle) * pointRadius,
      });
    }

    graphics.fillStyle(valid ? COLORS.starDark : COLORS.red, alpha);
    drawPolygon(
      graphics,
      points.map((point) => ({ x: point.x + Math.max(1.5, radius * 0.1), y: point.y + 2 })),
    );
    graphics.fillStyle(valid ? COLORS.star : COLORS.red, alpha);
    drawPolygon(graphics, points);
    graphics.lineStyle(
      Math.max(1, radius * 0.08),
      valid ? COLORS.starLight : COLORS.white,
      alpha * 0.82,
    );
    linePolygon(graphics, points);

    const highlightX = center.x + Math.sign(facing || 1) * radius * widthScale * 0.22;
    graphics.fillStyle(COLORS.white, alpha * (0.42 + Math.abs(facing) * 0.38));
    graphics.fillEllipse(
      highlightX,
      center.y - radius * 0.28,
      Math.max(1.5, radius * widthScale * 0.2),
      radius * 0.34,
    );
  }

  private drawCollectibleSelection(
    graphics: Phaser.GameObjects.Graphics,
    collectible: CollectibleDefinition,
  ): void {
    const center = this.collectibleCenter(collectible);
    const zoom = fromCameraZoom(this.cameras.main.zoom);
    graphics.lineStyle(2 / zoom, COLORS.orange, 0.96);
    graphics.strokeEllipse(
      center.x,
      center.y,
      (STAR_RENDER_RADIUS * 2 + 15) / zoom,
      (STAR_RENDER_RADIUS * 2 + 15) / zoom,
    );
  }

  private drawObstacle(
    graphics: Phaser.GameObjects.Graphics,
    obstacle: ObstacleDefinition,
    alpha = 1,
    valid = true,
  ): void {
    const width = obstacle.columns * CELL_SIZE;
    const height = obstacle.rows * CELL_SIZE;
    const center = this.obstacleCenter(obstacle);
    const angle = obstacle.angle ?? 0;
    const polygon = rectangleCorners(center, width, height, angle);
    graphics.fillStyle(valid ? COLORS.obstacle : COLORS.red, alpha);
    drawPolygon(graphics, polygon);
    graphics.lineStyle(2, valid ? COLORS.graphiteSoft : COLORS.red, 0.38 * alpha);
    linePolygon(graphics, polygon);
    graphics.lineStyle(3, COLORS.graphiteSoft, 0.13 * alpha);
    const minimumOffset = -width / 2 - height / 2;
    const maximumOffset = width / 2 + height / 2;
    for (let offset = minimumOffset; offset <= maximumOffset; offset += 24) {
      const minimumY = Math.max(-height / 2, -width / 2 - offset);
      const maximumY = Math.min(height / 2, width / 2 - offset);
      if (minimumY >= maximumY) continue;
      const start = localToWorld(center, angle, offset + minimumY, minimumY);
      const end = localToWorld(center, angle, offset + maximumY, maximumY);
      graphics.lineBetween(start.x, start.y, end.x, end.y);
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
    const fixedScenarioMachine =
      machine.fixed &&
      !machine.id.startsWith('ghost') &&
      (isConveyorType(machine.type) || isSpringType(machine.type));
    const machineAlpha = fixedScenarioMachine ? alpha * 0.9 : alpha;
    switch (machine.type) {
      case 'source':
        this.drawSource(graphics, machine, center, alpha, valid);
        break;
      case 'conveyor':
      case 'tracked-conveyor':
        this.drawTrackedConveyor(
          graphics,
          machine,
          center,
          machineAlpha,
          valid,
          fixedScenarioMachine,
        );
        break;
      case 'receiver':
        this.drawReceiver(graphics, machine, center, alpha, valid);
        break;
      case 'spring':
      case 'turbo-spring':
        this.drawSpring(
          graphics,
          machine,
          center,
          machineAlpha,
          color,
          fixedScenarioMachine,
        );
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
    const bodyColor = valid ? COLORS.machinePanel : COLORS.red;

    graphics.fillStyle(COLORS.graphite, alpha * 0.22);
    drawPolygon(
      graphics,
      roundedRectanglePoints(
        localToWorld(center, machine.angle, 1.5, 2),
        dimensions.width,
        dimensions.height,
        5,
        machine.angle,
      ),
    );

    graphics.fillStyle(bodyColor, alpha);
    drawPolygon(
      graphics,
      roundedRectanglePoints(center, dimensions.width, dimensions.height, 5, machine.angle),
    );
    graphics.lineStyle(2, COLORS.graphiteSoft, alpha * 0.9);
    linePolygon(
      graphics,
      roundedRectanglePoints(center, dimensions.width, dimensions.height, 5, machine.angle),
    );

    const panelCenter = localToWorld(center, machine.angle, 0, -7);
    graphics.fillStyle(COLORS.white, alpha);
    drawPolygon(
      graphics,
      [
        [-3.5, -17],
        [3.5, -17],
        [3.5, 1],
        [9, -4.5],
        [14, 0.5],
        [0, 15],
        [-14, 0.5],
        [-9, -4.5],
        [-3.5, 1],
      ].map(([x, y]) => localToWorld(panelCenter, machine.angle, x!, y!)),
    );

    const slotCenter = localToWorld(center, machine.angle, 0, dimensions.height / 2 - 6.5);
    graphics.fillStyle(COLORS.machineRecess, alpha);
    drawPolygon(graphics, roundedRectanglePoints(slotCenter, 40, 17, 5, machine.angle));
    graphics.fillStyle(COLORS.orange, alpha);
    drawPolygon(
      graphics,
      roundedRectanglePoints(
        localToWorld(center, machine.angle, 0, dimensions.height / 2 - 5.5),
        30,
        11,
        3,
        machine.angle,
      ),
    );
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
        roundedRectanglePoints(
          center,
          dimensions.width + pulse * 28,
          dimensions.height + pulse * 28,
          8 + pulse * 5,
          machine.angle,
        ),
      );
    }

    graphics.fillStyle(COLORS.graphite, alpha * 0.22);
    drawPolygon(
      graphics,
      roundedRectanglePoints(
        localToWorld(center, machine.angle, 1.5, 2),
        dimensions.width,
        dimensions.height,
        8,
        machine.angle,
      ),
    );

    graphics.fillStyle(valid ? COLORS.white : COLORS.red, alpha);
    drawPolygon(
      graphics,
      roundedRectanglePoints(center, dimensions.width, dimensions.height, 6, machine.angle),
    );
    graphics.lineStyle(2, valid ? COLORS.receiverBorder : COLORS.red, alpha * 0.95);
    linePolygon(
      graphics,
      roundedRectanglePoints(center, dimensions.width, dimensions.height, 6, machine.angle),
    );

    graphics.fillStyle(COLORS.orange, alpha);
    const cornerTriangles: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
      [
        [-28, -28],
        [-15, -28],
        [-28, -15],
      ],
      [
        [28, -28],
        [15, -28],
        [28, -15],
      ],
      [
        [-28, 28],
        [-15, 28],
        [-28, 15],
      ],
      [
        [28, 28],
        [15, 28],
        [28, 15],
      ],
    ];
    for (const triangle of cornerTriangles) {
      drawPolygon(
        graphics,
        triangle.map(([x, y]) => localToWorld(center, machine.angle, x, y)),
      );
    }

    this.drawReceiverReadout(graphics, machine, center, alpha);
  }

  private drawReceiverReadout(
    graphics: Phaser.GameObjects.Graphics,
    machine: MachineState,
    center: Point,
    alpha: number,
  ): void {
    const displayOffsetY = 0;
    const displayCenter = localToWorld(center, machine.angle, 0, displayOffsetY);
    graphics.fillStyle(COLORS.receiverBezel, alpha * 0.96);
    drawPolygon(graphics, roundedRectanglePoints(displayCenter, 58, 32, 6, machine.angle));
    graphics.fillStyle(COLORS.machinePanel, alpha * 0.97);
    drawPolygon(graphics, roundedRectanglePoints(displayCenter, 52, 26, 4, machine.angle));
    graphics.lineStyle(1, COLORS.graphiteSoft, alpha * 0.8);
    linePolygon(graphics, roundedRectanglePoints(displayCenter, 52, 26, 4, machine.angle));

    const delivered = Math.max(0, Math.floor(this.metrics.delivered));
    const goal = this.contract?.goal.deliveries;
    const readout = goal === undefined ? String(delivered) : `${delivered}/${goal}`;
    const characters = readout;
    const widths = [...characters].map((character) => (character === '/' ? 5 : 8));
    const gap = 2;
    const totalWidth =
      widths.reduce((total, width) => total + width, 0) + Math.max(0, characters.length - 1) * gap;
    const scale = Math.min(1, 44 / totalWidth);
    let offsetX = -(totalWidth * scale) / 2;

    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index]!;
      const width = widths[index]!;
      if (character === '/') {
        const start = localToWorld(center, machine.angle, offsetX, displayOffsetY - 5 * scale);
        const end = localToWorld(
          center,
          machine.angle,
          offsetX + width * scale,
          displayOffsetY + 5 * scale,
        );
        graphics.lineStyle(1.8 * scale, COLORS.red, alpha * 0.92);
        graphics.lineBetween(start.x, start.y, end.x, end.y);
      } else {
        this.drawLedDigit(
          graphics,
          center,
          machine.angle,
          offsetX + (width * scale) / 2,
          displayOffsetY,
          character,
          scale,
          alpha,
        );
      }
      offsetX += (width + gap) * scale;
    }
  }

  private drawLedDigit(
    graphics: Phaser.GameObjects.Graphics,
    center: Point,
    angle: number,
    offsetX: number,
    offsetY: number,
    digit: string,
    scale: number,
    alpha: number,
  ): void {
    const segments: Record<string, readonly number[]> = {
      '0': [0, 1, 2, 3, 4, 5],
      '1': [1, 2],
      '2': [0, 1, 6, 4, 3],
      '3': [0, 1, 6, 2, 3],
      '4': [5, 6, 1, 2],
      '5': [0, 5, 6, 2, 3],
      '6': [0, 5, 6, 4, 2, 3],
      '7': [0, 1, 2],
      '8': [0, 1, 2, 3, 4, 5, 6],
      '9': [0, 1, 2, 3, 5, 6],
    };
    const segmentPoints: ReadonlyArray<readonly [number, number, number, number]> = [
      [-3, -6, 3, -6],
      [3, -6, 3, 0],
      [3, 0, 3, 6],
      [-3, 6, 3, 6],
      [-3, 0, -3, 6],
      [-3, -6, -3, 0],
      [-3, 0, 3, 0],
    ];

    for (const segment of segments[digit] ?? []) {
      const [startX, startY, endX, endY] = segmentPoints[segment]!;
      const start = localToWorld(center, angle, offsetX + startX * scale, offsetY + startY * scale);
      const end = localToWorld(center, angle, offsetX + endX * scale, offsetY + endY * scale);
      graphics.lineStyle(3.6 * scale, COLORS.red, alpha * 0.18);
      graphics.lineBetween(start.x, start.y, end.x, end.y);
      graphics.lineStyle(1.8 * scale, COLORS.red, alpha * 0.98);
      graphics.lineBetween(start.x, start.y, end.x, end.y);
    }
  }

  private drawTrackedConveyor(
    graphics: Phaser.GameObjects.Graphics,
    machine: MachineState,
    center: Point,
    alpha: number,
    valid: boolean,
    muted = false,
  ): void {
    const dimensions = MACHINE_DIMENSIONS['tracked-conveyor'];
    const runtime = this.trackedConveyors.get(machine.id);
    const drawRuntime = Boolean(
      runtime &&
      runtime.machine.gridX === machine.gridX &&
      runtime.machine.gridY === machine.gridY &&
      runtime.machine.angle === machine.angle,
    );

    if (!valid) {
      const footprint = roundedRectanglePoints(
        center,
        dimensions.width,
        dimensions.height,
        10,
        machine.angle,
      );
      graphics.fillStyle(COLORS.red, alpha * 0.18);
      drawPolygon(graphics, footprint);
      graphics.lineStyle(2, COLORS.red, alpha * 0.9);
      linePolygon(graphics, footprint);
    }

    const wheelCenters = trackedConveyorWheelCenters(center, machine.angle);
    const outlineHeight = TRACKED_CONVEYOR_TRACK_RADIUS * 2 + TRACKED_CONVEYOR_LINK_HEIGHT;
    const outlineWidth =
      TRACKED_CONVEYOR_STRAIGHT_LENGTH +
      TRACKED_CONVEYOR_TRACK_RADIUS * 2 +
      TRACKED_CONVEYOR_LINK_HEIGHT;
    const panelColor = muted ? COLORS.fixedPanel : COLORS.machinePanel;
    const conveyorColor = muted ? COLORS.fixedConveyor : COLORS.conveyor;
    const highlightColor = muted ? COLORS.fixedHighlight : COLORS.white;
    const outlineColor = muted ? COLORS.fixedOutline : COLORS.graphite;
    graphics.fillStyle(valid ? panelColor : COLORS.graphite, alpha);
    drawPolygon(
      graphics,
      roundedRectanglePoints(
        center,
        outlineWidth - 1,
        outlineHeight - 1,
        (outlineHeight - 1) / 2,
        machine.angle,
        5,
      ),
    );

    for (let index = 0; index < wheelCenters.length; index += 1) {
      const wheelCenter = wheelCenters[index]!;
      graphics.fillStyle(valid ? conveyorColor : COLORS.red, alpha);
      graphics.fillCircle(wheelCenter.x, wheelCenter.y, TRACKED_CONVEYOR_WHEEL_RADIUS);
      graphics.lineStyle(
        1.5,
        valid ? (muted ? COLORS.fixedHighlight : COLORS.blueLight) : COLORS.graphite,
        alpha * 0.95,
      );
      graphics.strokeCircle(wheelCenter.x, wheelCenter.y, TRACKED_CONVEYOR_WHEEL_RADIUS);
    }

    const links = Array.from(
      { length: TRACKED_CONVEYOR_LINK_COUNT },
      (_, index) => {
        const link = trackedConveyorPoseAt(
          center,
          machine.angle,
          (index * TRACKED_CONVEYOR_TRACK_LENGTH) / TRACKED_CONVEYOR_LINK_COUNT +
            (drawRuntime ? runtime!.phase : 0),
        );
        return rectangleCorners(
          link.center,
          TRACKED_CONVEYOR_LINK_WIDTH,
          TRACKED_CONVEYOR_LINK_HEIGHT,
          Phaser.Math.RadToDeg(link.angle),
        );
      },
    );
    if (valid) {
      graphics.fillStyle(highlightColor, alpha);
      drawPolygons(graphics, links, 0);
      graphics.fillStyle(conveyorColor, alpha);
      drawPolygons(graphics, links, 1);
      graphics.lineStyle(0.9, outlineColor, alpha * 0.86);
      linePolygon(
        graphics,
        roundedRectanglePoints(
          center,
          outlineWidth,
          outlineHeight,
          outlineHeight / 2,
          machine.angle,
          5,
        ),
      );
    } else {
      graphics.fillStyle(COLORS.red, alpha);
      drawPolygons(graphics, links);
    }

    const direction = machine.reversed ? -1 : 1;
    graphics.fillStyle(valid ? highlightColor : COLORS.graphite, alpha * 0.96);
    for (const wheelCenter of wheelCenters) {
      const tip = localToWorld(wheelCenter, machine.angle, 4 * direction, 0);
      const upper = localToWorld(wheelCenter, machine.angle, -2.5 * direction, -3.4);
      const lower = localToWorld(wheelCenter, machine.angle, -2.5 * direction, 3.4);
      drawPolygon(graphics, [tip, upper, lower]);
    }
  }

  private drawSpring(
    graphics: Phaser.GameObjects.Graphics,
    machine: MachineState,
    center: Point,
    alpha: number,
    color: number,
    muted = false,
  ): void {
    const compression = this.springCompression.get(machine.id) ?? 0;
    const dimensions = MACHINE_DIMENSIONS[machine.type];
    const turbo = machine.type === 'turbo-spring';
    const baseColor =
      color === COLORS.red
        ? COLORS.red
        : turbo
          ? muted
            ? COLORS.fixedTurboSteel
            : COLORS.turboSteel
          : muted
            ? COLORS.fixedWood
            : COLORS.wood;
    const springColor =
      color === COLORS.red
        ? COLORS.red
        : turbo
          ? muted
            ? COLORS.fixedTurboSpring
            : COLORS.turboSpringRed
          : muted
            ? COLORS.fixedSpring
            : COLORS.springGreen;
    const plateHeight = 8;
    const topCompression = Math.max(0, compression) * 7;
    const bottomCompression = Math.max(0, -compression) * 7;
    const baseY = dimensions.height / 2 - plateHeight / 2 - bottomCompression;
    const topY = -dimensions.height / 2 + plateHeight / 2 + topCompression;
    const lowerSpringY = baseY - plateHeight / 2;
    const upperSpringY = topY + plateHeight / 2;
    graphics.fillStyle(baseColor, alpha);
    drawPolygon(
      graphics,
      rectangleCorners(
        localToWorld(center, machine.angle, 0, baseY),
        dimensions.width,
        plateHeight,
        machine.angle,
      ),
    );
    if (turbo && color !== COLORS.red) {
      graphics.lineStyle(1.5, COLORS.turboSteelLight, alpha * (muted ? 0.55 : 0.9));
      linePolygon(
        graphics,
        [
          localToWorld(center, machine.angle, -dimensions.width / 2 + 5, baseY - 1.5),
          localToWorld(center, machine.angle, dimensions.width / 2 - 5, baseY - 1.5),
        ],
        false,
      );
    }
    graphics.lineStyle(4, springColor, alpha);
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
    graphics.fillStyle(baseColor, alpha);
    drawPolygon(
      graphics,
      rectangleCorners(
        localToWorld(center, machine.angle, 0, topY),
        dimensions.width,
        plateHeight,
        machine.angle,
      ),
    );
    if (turbo && color !== COLORS.red) {
      graphics.lineStyle(1.5, COLORS.turboSteelLight, alpha * (muted ? 0.55 : 0.9));
      linePolygon(
        graphics,
        [
          localToWorld(center, machine.angle, -dimensions.width / 2 + 5, topY - 1.5),
          localToWorld(center, machine.angle, dimensions.width / 2 - 5, topY - 1.5),
        ],
        false,
      );
    }
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

  private updateBoxVisuals(): void {
    for (const box of this.boxes.values()) this.drawBox(box);
  }

  private drawSelection(
    graphics: Phaser.GameObjects.Graphics,
    machine: MachineState,
    valid: boolean,
    showHandle = true,
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
    if (!showHandle || !this.canEditMachine(machine) || !this.isRotatable(machine)) return;
    const center = machineCenter(machine);
    const handle = rotationHandle(machine);
    const edge = localToWorld(center, machine.angle, 0, -dimensions.height / 2 - 7);
    graphics.lineStyle(2 / logicalZoom, color, 0.8);
    graphics.lineBetween(edge.x, edge.y, handle.x, handle.y);
    graphics.fillStyle(COLORS.white, 1);
    graphics.fillCircle(handle.x, handle.y, 11 / logicalZoom);
    graphics.lineStyle(3 / logicalZoom, color, 1);
    graphics.strokeCircle(handle.x, handle.y, 11 / logicalZoom);
    const glyphRadius = 5 / logicalZoom;
    const glyphStart = Phaser.Math.DegToRad(-45);
    const glyphEnd = Phaser.Math.DegToRad(255);
    graphics.beginPath();
    graphics.arc(handle.x, handle.y, glyphRadius, glyphStart, glyphEnd, false);
    graphics.strokePath();
    const arrowTip = {
      x: handle.x + Math.cos(glyphEnd) * glyphRadius,
      y: handle.y + Math.sin(glyphEnd) * glyphRadius,
    };
    graphics.lineBetween(
      arrowTip.x,
      arrowTip.y,
      arrowTip.x - 4.5 / logicalZoom,
      arrowTip.y - 1 / logicalZoom,
    );
    graphics.lineBetween(
      arrowTip.x,
      arrowTip.y,
      arrowTip.x - 1 / logicalZoom,
      arrowTip.y + 4.5 / logicalZoom,
    );
  }

  private drawObstacleSelection(
    graphics: Phaser.GameObjects.Graphics,
    obstacle: ObstacleDefinition,
    valid: boolean,
    showHandle = true,
  ): void {
    if (!this.isAuthoring()) return;
    const logicalZoom = fromCameraZoom(this.cameras.main.zoom);
    const color = valid ? COLORS.orange : COLORS.red;
    const width = obstacle.columns * CELL_SIZE;
    const height = obstacle.rows * CELL_SIZE;
    const center = this.obstacleCenter(obstacle);
    const angle = obstacle.angle ?? 0;
    graphics.lineStyle(3 / logicalZoom, color, 1);
    linePolygon(
      graphics,
      rectangleCorners(
        center,
        width + 8 / logicalZoom,
        height + 8 / logicalZoom,
        angle,
      ),
    );
    if (!showHandle) return;

    const rotationHandle = this.obstacleRotationHandle(obstacle);
    const rotationEdge = localToWorld(
      center,
      angle,
      0,
      -height / 2 - 4 / logicalZoom,
    );
    graphics.lineStyle(2 / logicalZoom, color, 0.82);
    graphics.lineBetween(rotationEdge.x, rotationEdge.y, rotationHandle.x, rotationHandle.y);
    graphics.fillStyle(COLORS.white, 1);
    graphics.fillCircle(rotationHandle.x, rotationHandle.y, 11 / logicalZoom);
    graphics.lineStyle(3 / logicalZoom, color, 1);
    graphics.strokeCircle(rotationHandle.x, rotationHandle.y, 11 / logicalZoom);
    const glyphRadius = 5 / logicalZoom;
    const glyphStart = Phaser.Math.DegToRad(-45);
    const glyphEnd = Phaser.Math.DegToRad(255);
    graphics.beginPath();
    graphics.arc(
      rotationHandle.x,
      rotationHandle.y,
      glyphRadius,
      glyphStart,
      glyphEnd,
      false,
    );
    graphics.strokePath();
    const arrowTip = {
      x: rotationHandle.x + Math.cos(glyphEnd) * glyphRadius,
      y: rotationHandle.y + Math.sin(glyphEnd) * glyphRadius,
    };
    graphics.lineBetween(
      arrowTip.x,
      arrowTip.y,
      arrowTip.x - 4.5 / logicalZoom,
      arrowTip.y - 1 / logicalZoom,
    );
    graphics.lineBetween(
      arrowTip.x,
      arrowTip.y,
      arrowTip.x - 1 / logicalZoom,
      arrowTip.y + 4.5 / logicalZoom,
    );

    for (const handle of OBSTACLE_RESIZE_HANDLES) {
      const point = this.obstacleResizeHandlePoint(obstacle, handle);
      const radius = 5.5 / logicalZoom;
      graphics.fillStyle(COLORS.white, 1);
      graphics.fillCircle(point.x, point.y, radius);
      graphics.lineStyle(2.5 / logicalZoom, color, 1);
      graphics.strokeCircle(point.x, point.y, radius);
    }
  }

  private drawMarquee(graphics: Phaser.GameObjects.Graphics, start: Point, end: Point): void {
    const logicalZoom = fromCameraZoom(this.cameras.main.zoom);
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    graphics.fillStyle(COLORS.white, 0.08);
    graphics.fillRect(minX, minY, maxX - minX, maxY - minY);
    graphics.lineStyle(2 / logicalZoom, COLORS.orange, 0.96);
    const dashLength = 9 / logicalZoom;
    const gapLength = 6 / logicalZoom;
    drawDashedLine(graphics, { x: minX, y: minY }, { x: maxX, y: minY }, dashLength, gapLength);
    drawDashedLine(graphics, { x: maxX, y: minY }, { x: maxX, y: maxY }, dashLength, gapLength);
    drawDashedLine(graphics, { x: maxX, y: maxY }, { x: minX, y: maxY }, dashLength, gapLength);
    drawDashedLine(graphics, { x: minX, y: maxY }, { x: minX, y: minY }, dashLength, gapLength);
  }

  private createTrackedConveyorRuntime(machine: MachineState): TrackedConveyorRuntime {
    const center = machineCenter(machine);
    const composite = this.matter.composite.create({
      label: `tracked-conveyor:${machine.id}`,
    });
    const wheelCenters = trackedConveyorWheelCenters(center, machine.angle);
    const wheels = wheelCenters.map((wheelCenter, index) => {
      const wheel = this.matter.bodies.circle(
        wheelCenter.x,
        wheelCenter.y,
        TRACKED_CONVEYOR_WHEEL_RADIUS,
        {
          label: `tracked-conveyor-wheel:${machine.id}:${index}`,
          isStatic: true,
          friction: 1,
          frictionStatic: 5,
          restitution: 0,
          slop: 0.02,
        },
      );
      this.matter.body.setAngle(wheel, degreesToRadians(machine.angle));
      wheel.plugin = {
        ...wheel.plugin,
        factoryMachineId: machine.id,
        factoryType: machine.type,
        factoryTrackedWheel: index,
      };
      this.matter.composite.add(composite, wheel);
      return wheel;
    });

    const links = trackedConveyorLinkLayout(center, machine.angle).map((layout, index) => {
      const link = this.matter.bodies.rectangle(
        layout.center.x,
        layout.center.y,
        TRACKED_CONVEYOR_LINK_WIDTH,
        TRACKED_CONVEYOR_LINK_HEIGHT,
        {
          label: `tracked-conveyor-link:${machine.id}:${index}`,
          isStatic: true,
          friction: 1,
          frictionStatic: 5,
          restitution: 0,
          slop: 0.015,
          chamfer: { radius: 1.2 },
        },
      );
      this.matter.body.setAngle(link, layout.angle);
      link.plugin = {
        ...link.plugin,
        factoryMachineId: machine.id,
        factoryType: machine.type,
        factoryTrackedLink: index,
      };
      this.matter.composite.add(composite, link);
      return link;
    });

    this.matter.world.add(composite);
    return {
      machine,
      composite,
      wheels,
      links,
      phase: 0,
    };
  }

  private rebuildStaticBodies(): void {
    for (const runtime of this.machineBodies.values()) this.matter.world.remove(runtime.body, true);
    this.machineBodies.clear();
    for (const runtime of this.trackedConveyors.values()) {
      this.matter.world.remove(runtime.composite, true);
    }
    this.trackedConveyors.clear();
    for (const body of this.obstacleBodies) this.matter.world.remove(body, true);
    this.obstacleBodies.length = 0;
    this.sourceMachines = this.machines.filter((machine) => machine.type === 'source');
    this.conveyorMachines = this.machines.filter((machine) => machine.type === 'conveyor');
    this.springMachines = this.machines.filter((machine) => isSpringType(machine.type));
    this.receiverMachines = this.machines.filter((machine) => machine.type === 'receiver');

    // Build mode uses geometric hit tests, so Matter bodies can be created lazily when the
    // simulation starts. This avoids rebuilding hundreds of track links after every edit.
    if (this.status === 'build' && this.boxes.size === 0) {
      this.matter.world.pause();
      return;
    }

    for (const obstacle of this.obstacles) {
      const width = obstacle.columns * CELL_SIZE;
      const height = obstacle.rows * CELL_SIZE;
      const center = this.obstacleCenter(obstacle);
      const body = this.matter.add.rectangle(
        center.x,
        center.y,
        width,
        height,
        { isStatic: true, label: `obstacle:${obstacle.id}`, friction: 0.6 },
      );
      this.matter.body.setAngle(body, degreesToRadians(obstacle.angle ?? 0));
      this.obstacleBodies.push(body);
    }

    for (const machine of this.machines) {
      if (machine.type === 'tracked-conveyor') {
        this.trackedConveyors.set(machine.id, this.createTrackedConveyorRuntime(machine));
        continue;
      }
      const center = machineCenter(machine);
      const dimensions = MACHINE_PHYSICS_DIMENSIONS[machine.type];
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
          restitution: isSpringType(machine.type) ? 0.05 : 0,
          chamfer: { radius: machine.type === 'conveyor' || isSpringType(machine.type) ? 3 : 5 },
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
    obstacles = this.obstacles,
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
    for (const obstacle of obstacles) {
      if (polygonsOverlap(polygon, this.obstaclePolygon(obstacle))) return false;
    }
    return true;
  }

  private isObstaclePlacementValid(
    candidate: ObstacleDefinition,
    ignoredId?: string,
    obstacles = this.obstacles,
    machines = this.machines,
  ): boolean {
    if (
      !Number.isFinite(candidate.gridX) ||
      !Number.isFinite(candidate.gridY) ||
      Math.abs(candidate.gridX * 4 - Math.round(candidate.gridX * 4)) > 0.000_001 ||
      Math.abs(candidate.gridY * 4 - Math.round(candidate.gridY * 4)) > 0.000_001 ||
      !Number.isInteger(candidate.columns) ||
      !Number.isInteger(candidate.rows) ||
      candidate.columns < 1 ||
      candidate.rows < 1 ||
      (candidate.angle !== undefined && !Number.isFinite(candidate.angle))
    ) {
      return false;
    }

    const polygon = this.obstaclePolygon(candidate);
    if (
      !polygonWithinBounds(polygon, PLAY_AREA_WIDTH, PLAY_AREA_HEIGHT, 0, {
        x: PLAY_AREA_MIN_X,
        y: PLAY_AREA_MIN_Y,
      })
    ) {
      return false;
    }
    for (const obstacle of obstacles) {
      if (obstacle.id === ignoredId) continue;
      if (polygonsOverlap(polygon, this.obstaclePolygon(obstacle))) return false;
    }
    for (const machine of machines) {
      if (polygonsOverlap(polygon, machinePolygon(machine))) return false;
    }
    return true;
  }

  private isGroupPlacementValid(
    machines: readonly MachineState[],
    obstacles: readonly ObstacleDefinition[],
    collectibles: readonly CollectibleDefinition[] = [],
    ignoredMachineIds: ReadonlySet<string> = new Set(),
    ignoredObstacleIds: ReadonlySet<string> = new Set(),
  ): boolean {
    const currentMachines = this.machines.filter((machine) => !ignoredMachineIds.has(machine.id));
    const currentObstacles = this.obstacles.filter(
      (obstacle) => !ignoredObstacleIds.has(obstacle.id),
    );
    const stagedMachines = cloneMachines(currentMachines);
    const allObstacles = [...cloneObstacles(currentObstacles), ...cloneObstacles(obstacles)];
    for (const machine of machines) {
      if (!this.isMachinePlacementValid(machine, undefined, stagedMachines, allObstacles)) {
        return false;
      }
      stagedMachines.push({ ...machine });
    }

    const stagedObstacles = cloneObstacles(currentObstacles);
    const allMachines = [...cloneMachines(currentMachines), ...cloneMachines(machines)];
    for (const obstacle of obstacles) {
      if (!this.isObstaclePlacementValid(obstacle, undefined, stagedObstacles, allMachines)) {
        return false;
      }
      stagedObstacles.push({ ...obstacle });
    }
    for (const collectible of collectibles) {
      if (!this.isCollectiblePlacementValid(collectible)) return false;
    }
    return true;
  }

  private obstaclePolygon(obstacle: ObstacleDefinition): Point[] {
    const width = obstacle.columns * CELL_SIZE;
    const height = obstacle.rows * CELL_SIZE;
    return rectangleCorners(
      this.obstacleCenter(obstacle),
      width,
      height,
      obstacle.angle ?? 0,
    );
  }

  private obstacleCenter(obstacle: ObstacleDefinition): Point {
    return {
      x: (obstacle.gridX + obstacle.columns / 2) * CELL_SIZE,
      y: (obstacle.gridY + obstacle.rows / 2) * CELL_SIZE,
    };
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
    this.updateMachineMetrics();
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
      collectibles: cloneCollectibles(this.collectibles),
    };
  }

  private applyEditorDocument(document: EditorDocument, notify = true): void {
    this.machines = cloneMachines(document.machines).map((machine) => ({
      ...machine,
      fixed: this.isAuthoring() ? true : machine.fixed,
    }));
    this.obstacles = cloneObstacles(document.obstacles);
    this.collectibles = cloneCollectibles(document.collectibles);
    this.collectedCollectibleIds.clear();
    this.collectibleDisappear.clear();
    this.updateMachineMetrics();
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

  private replaceCollectibleWithHistory(
    previous: CollectibleDefinition,
    next: CollectibleDefinition,
    label: string,
  ): void {
    const before = this.captureEditorDocument();
    const after = cloneEditorDocument(before);
    after.collectibles = after.collectibles.map((collectible) =>
      collectible.id === previous.id ? { ...next } : collectible,
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
    this.collectedCollectibleIds.clear();
    this.collectibleDisappear.clear();
    this.metrics = this.freshMetrics();
    this.spawnAccumulator = 0;
    this.physicsAccumulator = 0;
    this.simulationTimeMs = 0;
    this.simulationVisualTimeMs = 0;
    this.budgetCompletionWarningShown = false;
    this.status = nextStatus;
    this.matter.world.pause();
  }

  private freshMetrics(): RunMetrics {
    return {
      delivered: 0,
      lost: 0,
      active: 0,
      placedPieces: this.machines.filter((machine) => !machine.fixed).length,
      collectedStars: 0,
      spent: this.calculateSpentBudget(),
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

  private getSelectedCollectible(): CollectibleDefinition | undefined {
    return this.collectibles.find(
      (collectible) => collectible.id === this.selectedCollectibleId,
    );
  }

  private getSelectedCollectibles(): CollectibleDefinition[] {
    return this.collectibles.filter((collectible) =>
      this.selectedCollectibleIds.has(collectible.id),
    );
  }

  private getSelectedMachines(): MachineState[] {
    return this.machines.filter((machine) => this.selectedMachineIds.has(machine.id));
  }

  private getSelectedObstacles(): ObstacleDefinition[] {
    return this.obstacles.filter((obstacle) => this.selectedObstacleIds.has(obstacle.id));
  }

  private selectionCount(): number {
    return (
      this.getSelectedMachines().length +
      this.getSelectedObstacles().length +
      this.getSelectedCollectibles().length
    );
  }

  private clearSelection(): void {
    this.selectedMachineIds.clear();
    this.selectedObstacleIds.clear();
    this.selectedCollectibleIds.clear();
  }

  private selectItemsInsideMarquee(start: Point, end: Point): void {
    this.clearSelection();
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    const contains = (point: Point) =>
      point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;

    for (const machine of this.machines) {
      if (this.canEditMachine(machine) && contains(machineCenter(machine))) {
        this.selectedMachineIds.add(machine.id);
      }
    }

    if (this.isAuthoring()) {
      for (const obstacle of this.obstacles) {
        const center = {
          x: (obstacle.gridX + obstacle.columns / 2) * CELL_SIZE,
          y: (obstacle.gridY + obstacle.rows / 2) * CELL_SIZE,
        };
        if (contains(center)) this.selectedObstacleIds.add(obstacle.id);
      }
      for (const collectible of this.collectibles) {
        if (contains(this.collectibleCenter(collectible))) {
          this.selectedCollectibleIds.add(collectible.id);
        }
      }
    }
  }

  private findMachineAt(point: Point): MachineState | undefined {
    return [...this.machines].reverse().find((machine) => pointInsideMachine(point, machine, 7));
  }

  private findObstacleAt(point: Point): ObstacleDefinition | undefined {
    return [...this.obstacles]
      .reverse()
      .find((obstacle) => this.pointInsideObstacle(point, obstacle));
  }

  private findCollectibleAt(point: Point): CollectibleDefinition | undefined {
    const hitRadius = (STAR_RENDER_RADIUS + 8) / fromCameraZoom(this.cameras.main.zoom);
    return [...this.collectibles]
      .reverse()
      .find((collectible) => distance(point, this.collectibleCenter(collectible)) <= hitRadius);
  }

  private pointInsideObstacle(point: Point, obstacle: ObstacleDefinition): boolean {
    const local = worldToLocal(this.obstacleCenter(obstacle), obstacle.angle ?? 0, point);
    return (
      Math.abs(local.x) <= (obstacle.columns * CELL_SIZE) / 2 &&
      Math.abs(local.y) <= (obstacle.rows * CELL_SIZE) / 2
    );
  }

  private obstacleResizeHandlePoint(
    obstacle: ObstacleDefinition,
    handle: ObstacleResizeHandle,
  ): Point {
    return localToWorld(
      this.obstacleCenter(obstacle),
      obstacle.angle ?? 0,
      (handle.x * obstacle.columns * CELL_SIZE) / 2,
      (handle.y * obstacle.rows * CELL_SIZE) / 2,
    );
  }

  private obstacleRotationHandle(obstacle: ObstacleDefinition): Point {
    return localToWorld(
      this.obstacleCenter(obstacle),
      obstacle.angle ?? 0,
      0,
      -(obstacle.rows * CELL_SIZE) / 2 - 38,
    );
  }

  private findObstacleResizeHandle(
    obstacle: ObstacleDefinition,
    point: Point,
  ): ObstacleResizeHandle | undefined {
    const radius = 16 / fromCameraZoom(this.cameras.main.zoom);
    return OBSTACLE_RESIZE_HANDLES.find(
      (handle) => distance(point, this.obstacleResizeHandlePoint(obstacle, handle)) <= radius,
    );
  }

  private sameObstacleState(a: ObstacleDefinition, b: ObstacleDefinition): boolean {
    return (
      a.id === b.id &&
      a.gridX === b.gridX &&
      a.gridY === b.gridY &&
      a.columns === b.columns &&
      a.rows === b.rows &&
      normalizeAngle(a.angle ?? 0) === normalizeAngle(b.angle ?? 0)
    );
  }

  private sameCollectibleState(
    a: CollectibleDefinition,
    b: CollectibleDefinition,
  ): boolean {
    return (
      a.id === b.id &&
      a.type === b.type &&
      a.gridX === b.gridX &&
      a.gridY === b.gridY
    );
  }

  private rotateSelectedBy(delta: number): void {
    const selected = this.getSelectedMachine();
    if (selected) {
      this.rotateSelectedTo(selected.angle + delta);
      return;
    }
    const selectedObstacle = this.getSelectedObstacle();
    if (selectedObstacle) {
      this.rotateSelectedObstacle((selectedObstacle.angle ?? 0) + delta);
    }
  }

  private toggleGrid(): void {
    if (!this.canBuild()) {
      this.toast('Pause a simulação para alterar a grade.', 'neutral');
      return;
    }
    this.gridEnabled = !this.gridEnabled;
    this.ghostMachine = undefined;
    if (this.groupGhostAnchor) this.updateGroupGhostAt(this.groupGhostAnchor);
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
      const snap = (coordinate: number, step: number) =>
        Math.round((coordinate / CELL_SIZE - 0.5) / step) * step;
      return {
        x: snap(point.x, GRID_POSITION_STEP),
        y: snap(point.y, GRID_POSITION_STEP),
      };
    }
    return {
      x: Math.round((point.x / CELL_SIZE - 0.5) * 1000) / 1000,
      y: Math.round((point.y / CELL_SIZE - 0.5) * 1000) / 1000,
    };
  }

  private collectiblePositionFromWorld(point: Point): { x: number; y: number } {
    const position = this.machinePositionFromWorld(point);
    return {
      x: this.snapEditorPosition(position.x),
      y: this.snapEditorPosition(position.y),
    };
  }

  private collectibleCenter(collectible: CollectibleDefinition): Point {
    return gridToWorld({ x: collectible.gridX, y: collectible.gridY });
  }

  private snapEditorPosition(value: number): number {
    return Math.round(value / GRID_POSITION_STEP) * GRID_POSITION_STEP;
  }

  private isCollectiblePlacementValid(collectible: CollectibleDefinition): boolean {
    if (!Number.isFinite(collectible.gridX) || !Number.isFinite(collectible.gridY)) return false;
    const center = this.collectibleCenter(collectible);
    return (
      center.x >= PLAY_AREA_MIN_X + STAR_RENDER_RADIUS &&
      center.x <= PLAY_AREA_MAX_X - STAR_RENDER_RADIUS &&
      center.y >= PLAY_AREA_MIN_Y + STAR_RENDER_RADIUS &&
      center.y <= PLAY_AREA_MAX_Y - STAR_RENDER_RADIUS
    );
  }

  private isRotatable(machine: MachineState): boolean {
    return (
      machine.type === 'conveyor' ||
      machine.type === 'tracked-conveyor' ||
      machine.type === 'spring' ||
      machine.type === 'turbo-spring' ||
      (this.isAuthoring() && (machine.type === 'source' || machine.type === 'receiver'))
    );
  }

  private canEditMachine(machine: MachineState): boolean {
    return this.isAuthoring() || !machine.fixed;
  }

  private isAuthoring(): boolean {
    return this.editorActive && !this.editorPreview;
  }

  private setEditorPersistenceLocked(locked: boolean): void {
    this.editorPersistenceLocked = locked && this.isAuthoring();
    if (this.editorPersistenceLocked) {
      this.setDragState(undefined);
      this.selectedTool = undefined;
      this.selectedEditorTool = undefined;
      this.ghostMachine = undefined;
      this.ghostObstacle = undefined;
      this.ghostCollectible = undefined;
      this.ghostGroupMachines = [];
      this.ghostGroupObstacles = [];
      this.ghostGroupCollectibles = [];
      this.groupGhostAnchor = undefined;
    }
    this.emitSnapshot();
  }

  private activeHistory(): CommandHistory {
    return this.isAuthoring() ? this.editorHistory : this.history;
  }

  private canBuild(): boolean {
    if (this.editorPersistenceLocked && this.isAuthoring()) return false;
    return this.status === 'build' || this.status === 'paused';
  }

  private getBudgetLimit(): number | undefined {
    const limit = this.contract?.economy.budgetLimit;
    if (limit === undefined || !Number.isFinite(limit)) return undefined;
    return Math.max(0, limit);
  }

  private machineCost(
    machine: Pick<MachineState, 'type' | 'fixed' | 'conveyorSpeed'>,
  ): number {
    if (machine.fixed || !this.contract) return 0;
    const type = activeMachineType(machine.type);
    const rawCost =
      type === 'tracked-conveyor'
        ? resolveConveyorSpeedCosts(this.contract.economy)[conveyorSpeed(machine)]
        : type === 'spring'
          ? this.contract.economy.machineCosts.spring
          : type === 'turbo-spring'
            ? (this.contract.economy.machineCosts['turbo-spring'] ?? 7_500)
          : 0;
    return Number.isFinite(rawCost) ? Math.max(0, rawCost) : 0;
  }

  private calculateSpentBudget(machines: readonly MachineState[] = this.machines): number {
    return machines.reduce((total, machine) => total + this.machineCost(machine), 0);
  }

  private canAffordMachines(machines: readonly MachineState[]): boolean {
    if (this.isAuthoring()) return true;
    const budgetLimit = this.getBudgetLimit();
    if (budgetLimit === undefined) return true;
    return this.calculateSpentBudget() + this.calculateSpentBudget(machines) <= budgetLimit * 2;
  }

  private updateMachineMetrics(): void {
    this.metrics.placedPieces = this.machines.filter((machine) => !machine.fixed).length;
    this.metrics.spent = this.calculateSpentBudget();
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

  private createCollectibleId(reserved: ReadonlySet<string> = new Set()): string {
    let id: string;
    do {
      id = `star-${++this.collectibleSequence}`;
    } while (reserved.has(id) || this.collectibles.some((collectible) => collectible.id === id));
    return id;
  }

  private normalizeCollectibles(
    collectibles: readonly CollectibleDefinition[],
  ): CollectibleDefinition[] {
    this.collectibleSequence = 0;
    const used = new Set<string>();
    for (const id of collectibles.map((collectible) => collectible.id)) {
      const match = /^star-(\d+)$/.exec(id);
      if (match?.[1]) {
        this.collectibleSequence = Math.max(this.collectibleSequence, Number(match[1]));
      }
    }
    return collectibles.flatMap((collectible) => {
      if (collectible.type !== 'star') return [];
      let id = collectible.id.trim();
      if (!id || used.has(id)) id = this.createCollectibleId(used);
      used.add(id);
      const normalized: CollectibleDefinition = {
        ...collectible,
        id,
        type: 'star',
        gridX: this.snapEditorPosition(collectible.gridX),
        gridY: this.snapEditorPosition(collectible.gridY),
      };
      return this.isCollectiblePlacementValid(normalized) ? [normalized] : [];
    });
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
        gridX: this.snapEditorPosition(obstacle.gridX),
        gridY: this.snapEditorPosition(obstacle.gridY),
        columns: Math.max(1, Math.round(obstacle.columns)),
        rows: Math.max(1, Math.round(obstacle.rows)),
        angle: normalizeAngle(obstacle.angle ?? 0),
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
        type: activeMachineType(machine.type),
        angle: normalizeAngle(machine.angle),
        conveyorSpeed: isConveyorType(machine.type) ? conveyorSpeed(machine) : undefined,
        fixed: preserveFixed ? machine.fixed : false,
      };
    });
  }

  private emitSnapshot(): void {
    appEvents.emit('game:snapshot', this.getSnapshot());
  }

  private machineClientBounds(machine: MachineState): {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } {
    const camera = this.cameras.main;
    const canvasBounds = this.game.canvas.getBoundingClientRect();
    const scaleX = canvasBounds.width / this.game.canvas.width;
    const scaleY = canvasBounds.height / this.game.canvas.height;
    const dimensions = MACHINE_DIMENSIONS[machine.type];
    const corners = rectangleCorners(
      machineCenter(machine),
      dimensions.width + 14,
      dimensions.height + 14,
      machine.angle,
    );
    const clientPoints = corners.map((point) => ({
      x:
        canvasBounds.left +
        (camera.x + (point.x - camera.worldView.x) * camera.zoom) * scaleX,
      y:
        canvasBounds.top +
        (camera.y + (point.y - camera.worldView.y) * camera.zoom) * scaleY,
    }));
    return {
      left: Math.min(...clientPoints.map(({ x }) => x)),
      top: Math.min(...clientPoints.map(({ y }) => y)),
      right: Math.max(...clientPoints.map(({ x }) => x)),
      bottom: Math.max(...clientPoints.map(({ y }) => y)),
    };
  }

  private serializeEditorContract(contract: ContractDefinition): string {
    return JSON.stringify({
      ...contract,
      fixedMachines: [...contract.fixedMachines]
        .map((machine) => ({ ...machine, fixed: true }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      obstacles: [...contract.obstacles].sort((a, b) => a.id.localeCompare(b.id)),
      collectibles: [...contract.collectibles].sort((a, b) => a.id.localeCompare(b.id)),
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
    const current = this.captureCamera();
    this.currentCamera = current;
    appEvents.emit('game:camera', {
      zoom: current.zoom,
      scrollX: camera.scrollX,
      scrollY: camera.scrollY,
    });
  }

  private syncEditorCamera(): void {
    if (!this.isAuthoring() || this.editorPersistenceLocked || !this.editorContract) return;
    const initialCamera = this.captureCamera();
    const previous = this.editorContract.initialCamera;
    if (
      previous.centerX === initialCamera.centerX &&
      previous.centerY === initialCamera.centerY &&
      previous.zoom === initialCamera.zoom
    ) {
      return;
    }
    this.editorContract = { ...this.editorContract, initialCamera };
    this.contract = this.editorContract;
    this.emitEditorChanged();
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

  private normalizeContractCamera(camera: ContractCamera): ContractCamera {
    const round = (value: number, precision: number): number => {
      const multiplier = 10 ** precision;
      const rounded = Math.round(value * multiplier) / multiplier;
      return Object.is(rounded, -0) ? 0 : rounded;
    };
    return {
      centerX: round(Number.isFinite(camera.centerX) ? camera.centerX : STAGE_WIDTH / 2, 2),
      centerY: round(Number.isFinite(camera.centerY) ? camera.centerY : STAGE_HEIGHT / 2, 2),
      zoom: round(
        Phaser.Math.Clamp(
          Number.isFinite(camera.zoom) ? camera.zoom : MIN_ZOOM,
          MIN_ZOOM,
          MAX_ZOOM,
        ),
        4,
      ),
    };
  }

  private captureCamera(): ContractCamera {
    const camera = this.cameras.main;
    const center = camera.getWorldPoint(camera.width / 2, camera.height / 2);
    return this.normalizeContractCamera({
      centerX: center.x,
      centerY: center.y,
      zoom: fromCameraZoom(camera.zoom),
    });
  }

  private applyContractCamera(initialCamera: ContractCamera): void {
    const camera = this.cameras.main;
    const normalized = this.normalizeContractCamera(initialCamera);
    camera.setZoom(toCameraZoom(normalized.zoom));
    camera.centerOn(normalized.centerX, normalized.centerY);
    this.drawGrid(true);
    this.emitCamera();
  }

  private initializeIdleState(): void {
    this.mode = 'sandbox';
    this.contract = undefined;
    this.availableMachines = [...SANDBOX_DEFINITION.availableMachines];
    this.machines = [];
    this.obstacles = [];
    this.collectibles = [];
    this.history.clear();
    this.editorHistory.clear();
    this.resetSimulation('build');
    this.rebuildStaticBodies();
    this.fitCamera();
    this.emitSnapshot();
  }

  private leaveToMenu(): void {
    this.setDragState(undefined);
    this.editorActive = false;
    this.editorPreview = false;
    this.editorContract = undefined;
    this.editorAuthoringState = undefined;
    this.editorBaseline = '';
    this.editorPersistenceLocked = false;
    this.clearClipboard();
    this.clearSelection();
    this.selectedTool = undefined;
    this.selectedEditorTool = undefined;
    this.ghostMachine = undefined;
    this.ghostObstacle = undefined;
    this.ghostCollectible = undefined;
    this.particles.length = 0;
    this.springCompression.clear();
    this.receiverPulse.clear();
    this.initializeIdleState();
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
    if (this.currentCamera) this.applyContractCamera(this.currentCamera);
    else this.fitCamera();
  }

  private installDebugApi(): void {
    window.__FACTORY_DEBUG__ = {
      getSnapshot: () => this.getSnapshot(),
      getSimulationSeconds: () => this.simulationTimeMs / 1000,
      getMachines: () => cloneMachines(this.machines),
      getObstacles: () => cloneObstacles(this.obstacles),
      getCollectibles: () => cloneCollectibles(this.collectibles),
      getBoxes: () =>
        [...this.boxes.values()].map(({ body }) => ({
          x: body.position.x,
          y: body.position.y,
          velocityX: body.velocity.x,
          velocityY: body.velocity.y,
        })),
      getCamera: () => {
        const current = this.captureCamera();
        return {
          scrollX: this.cameras.main.scrollX,
          scrollY: this.cameras.main.scrollY,
          centerX: current.centerX,
          centerY: current.centerY,
          zoom: current.zoom,
        };
      },
      setCamera: (centerX, centerY, zoom) => {
        if (this.editorPersistenceLocked && this.isAuthoring()) return;
        this.applyContractCamera({ centerX, centerY, zoom });
        this.syncEditorCamera();
      },
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
      getInvalidEntityFlash: () => ({
        machineIds: [...(this.invalidEntityFlash?.machineIds ?? [])],
        obstacleIds: [...(this.invalidEntityFlash?.obstacleIds ?? [])],
        collectibleIds: [...(this.invalidEntityFlash?.collectibleIds ?? [])],
        remainingMs: Math.max(
          0,
          (this.invalidEntityFlash?.endsAt ?? 0) - performance.now(),
        ),
      }),
      getEditorHitboxesVisible: () =>
        this.editorHitboxesVisible && this.isAuthoring(),
      selectEditorTool: (type) => this.selectEditorTool(type),
      selectTool: (type) => this.selectTool(type),
      placeMachine: (type, gridX, gridY, angle) => this.placeMachineAt(type, gridX, gridY, angle),
      selectMachine: (id) => this.selectMachine(id),
      selectArea: (minX, minY, maxX, maxY) => {
        this.selectItemsInsideMarquee({ x: minX, y: minY }, { x: maxX, y: maxY });
        this.emitSnapshot();
        return this.selectionCount();
      },
      rotateSelected: (angle) => this.rotateSelectedTo(angle),
      reverseSelected: () => this.reverseSelected(),
      deleteSelected: () => this.deleteSelected(),
      copySelected: () => this.copySelected(),
      cutSelected: () => this.cutSelected(),
      placeObstacle: (gridX, gridY, columns, rows) =>
        this.placeObstacleAt(gridX, gridY, columns, rows),
      selectObstacle: (id) => this.selectObstacle(id),
      moveSelectedObstacle: (gridX, gridY) => this.moveSelectedObstacle(gridX, gridY),
      resizeSelectedObstacle: (columns, rows) => this.resizeSelectedObstacle(columns, rows),
      rotateSelectedObstacle: (angle) => this.rotateSelectedObstacle(angle),
      placeCollectible: (gridX, gridY) => this.placeCollectibleAt(gridX, gridY),
      selectCollectible: (id) => this.selectCollectible(id),
      moveSelectedCollectible: (gridX, gridY) =>
        this.moveSelectedCollectible(gridX, gridY),
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
        this.updateBoxVisuals();
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
