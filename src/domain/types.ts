export const CELL_SIZE = 48;
export const COLLECTIBLE_STAR_RADIUS = 22;
export const GRID_COLUMNS = 30;
export const GRID_ROWS = 18;
export const PLAY_AREA_MARGIN_STAGES = 4;
export const PLAY_AREA_MIN_COLUMN = -GRID_COLUMNS * PLAY_AREA_MARGIN_STAGES;
export const PLAY_AREA_MAX_COLUMN = GRID_COLUMNS * (PLAY_AREA_MARGIN_STAGES + 1);
export const PLAY_AREA_MIN_ROW = -GRID_ROWS * PLAY_AREA_MARGIN_STAGES;
export const PLAY_AREA_MAX_ROW = GRID_ROWS * (PLAY_AREA_MARGIN_STAGES + 1);

export type MachineType =
  | 'source'
  | 'conveyor'
  | 'slow-conveyor'
  | 'tracked-conveyor'
  | 'fast-conveyor'
  | 'receiver'
  | 'spring'
  | 'turbo-spring';
export type ConveyorSpeed = 'slow' | 'normal' | 'fast';
export type GameMode = 'campaign' | 'sandbox' | 'editor' | 'preview';
export type SimulationStatus = 'build' | 'running' | 'paused' | 'success' | 'failure';
export type ContractId = string;
export type ContractStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface GridPoint {
  x: number;
  y: number;
}

export interface GridSize {
  columns: number;
  rows: number;
}

export interface MachineState {
  id: string;
  type: MachineType;
  gridX: number;
  gridY: number;
  angle: number;
  reversed: boolean;
  conveyorSpeed?: ConveyorSpeed;
  fixed: boolean;
}

export interface ObstacleDefinition {
  id: string;
  gridX: number;
  gridY: number;
  columns: number;
  rows: number;
  angle?: number;
}

export interface CollectibleDefinition {
  type: 'star';
  id: string;
  gridX: number;
  gridY: number;
}

export interface ContractGoal {
  deliveries: number;
  maxLosses?: number;
}

export interface ContractMachineCosts {
  'tracked-conveyor': number;
  spring: number;
  'turbo-spring'?: number;
}

export type ConveyorSpeedCosts = Record<ConveyorSpeed, number>;

export interface ContractEconomy {
  budgetLimit?: number;
  machineCosts: ContractMachineCosts;
  conveyorSpeedCosts?: ConveyorSpeedCosts;
}

export interface ContractCamera {
  centerX: number;
  centerY: number;
  zoom: number;
}

export interface ContractDefinition {
  id: ContractId;
  world: number;
  stage: ContractStage;
  revision: number;
  order: number;
  title: string;
  subtitle: string;
  description: string;
  grid: GridSize;
  availableMachines: MachineType[];
  fixedMachines: MachineState[];
  obstacles: ObstacleDefinition[];
  collectibles: CollectibleDefinition[];
  goal: ContractGoal;
  economy: ContractEconomy;
  spawnIntervalSeconds: number;
  initialCamera: ContractCamera;
}

export interface CampaignWorldDefinition {
  world: number;
  backgroundColor: string;
  gridColor: string;
}

export interface RunMetrics {
  delivered: number;
  lost: number;
  active: number;
  placedPieces: number;
  collectedStars: number;
  spent: number;
}

export interface SandboxSave {
  machines: MachineState[];
  updatedAt: string;
}

export interface CampaignLayoutSave {
  revision: number;
  machines: MachineState[];
  updatedAt: string;
}

export interface ProgressSave {
  version: 5;
  unlockedContracts: ContractId[];
  completedContracts: Partial<Record<ContractId, number>>;
  settings: {
    muted: boolean;
    volume: number;
  };
  sandbox: SandboxSave;
  campaignLayouts: Partial<Record<ContractId, CampaignLayoutSave>>;
}

export interface ContractCatalogFile {
  version: 4;
  worlds: CampaignWorldDefinition[];
  contracts: ContractDefinition[];
  updatedAt: string;
}

export interface PersistenceSuccess<T = undefined> {
  ok: true;
  value: T;
}

export interface PersistenceFailure<T = undefined> {
  ok: false;
  value: T;
  error: string;
}

export type PersistenceResult<T = undefined> = PersistenceSuccess<T> | PersistenceFailure<T>;

export interface GameSnapshot {
  mode: GameMode;
  contractId?: ContractId;
  contractTitle: string;
  contractDescription: string;
  status: SimulationStatus;
  resolutionReason?: 'deliveries' | 'losses' | 'budget';
  metrics: RunMetrics;
  goal?: ContractGoal;
  economy?: {
    spent: number;
    budgetLimit?: number;
    hardLimit?: number;
    machineCosts: ContractMachineCosts;
    conveyorSpeedCosts?: ConveyorSpeedCosts;
  };
  selectedMachine?: MachineState;
  selectionClientBounds?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  selectionRotationHandleClient?: {
    x: number;
    y: number;
    radius: number;
  };
  selectedObstacle?: ObstacleDefinition;
  selection: {
    machineIds: string[];
    obstacleIds: string[];
    collectibleIds: string[];
    count: number;
  };
  availableMachines: MachineType[];
  canUndo: boolean;
  canRedo: boolean;
  muted: boolean;
  gridEnabled: boolean;
  simulationSpeed: number;
}

export interface GameCommand {
  label: string;
  execute(): void;
  undo(): void;
}

export interface PlatformService {
  loadProgress(contracts?: readonly ContractDefinition[]): ProgressSave;
  saveProgress(progress: ProgressSave): PersistenceResult;
  loadContractCatalog(): Promise<PersistenceResult<ContractCatalogFile>>;
  saveContractCatalog(
    catalog: ContractCatalogFile,
  ): Promise<PersistenceResult<ContractCatalogFile>>;
  requestFullscreen(): Promise<void>;
  unlockAchievement(id: string): Promise<void>;
}
