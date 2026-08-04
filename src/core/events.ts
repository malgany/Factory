import type {
  CampaignWorldDefinition,
  ContractDefinition,
  ContractId,
  GameMode,
  GameSnapshot,
  MachineState,
  MachineType,
} from '../domain/types';
import { EventBus } from './EventBus';

export interface AppEvents {
  'game:ready': undefined;
  'game:snapshot': GameSnapshot;
  'game:angle': { angle: number; clientX: number; clientY: number; visible: boolean };
  'game:dragging': { active: boolean };
  'game:cost-feedback': { amount: number; clientX: number; clientY: number };
  'game:camera': { zoom: number; scrollX: number; scrollY: number };
  'game:toast': { message: string; tone: 'neutral' | 'success' | 'danger' };
  'game:result': { contractId: ContractId; snapshot: GameSnapshot };
  'game:completion-recorded': {
    contractId: ContractId;
    snapshot: GameSnapshot;
  };
  'game:sandbox-changed': MachineState[];
  'game:campaign-changed': {
    contractId: ContractId;
    contractRevision: number;
    machines: MachineState[];
  };
  'game:editor-changed': { contract: ContractDefinition; dirty: boolean };
  'game:editor-preview': { active: boolean };
  'game:audio': { kind: 'spawn' | 'place' | 'bounce' | 'deliver' | 'error' | 'success' };
  'ui:start-mode': {
    mode: GameMode;
    contractId?: ContractId;
    contract?: ContractDefinition;
    machines?: MachineState[];
    worldTheme?: CampaignWorldDefinition;
  };
  'ui:start-editor': {
    contract: ContractDefinition;
    isNew?: boolean;
    worldTheme?: CampaignWorldDefinition;
  };
  'ui:editor-tool': { type: MachineType | 'obstacle' | 'star' };
  'ui:editor-update-settings': { contract: ContractDefinition };
  'ui:editor-test': { contract: ContractDefinition };
  'ui:editor-begin-preview': undefined;
  'ui:editor-return': undefined;
  'ui:editor-save': { contract: ContractDefinition };
  'ui:editor-swap-contracts': {
    contract: ContractDefinition;
    conflictingContractId: ContractId;
    beginPreviewAfterSave: boolean;
  };
  'ui:editor-highlight-invalid': { paths: string[] };
  'ui:editor-persistence': { saving: boolean };
  'ui:editor-mark-saved': { contract: ContractDefinition };
  'ui:editor-cancel': undefined;
  'ui:editor-configure': { open: boolean };
  'ui:editor-hitboxes': { enabled: boolean };
  'ui:admin-mode': { enabled: boolean };
  'ui:admin-create-contract': { world: number };
  'ui:admin-create-world': {
    backgroundColor: CampaignWorldDefinition['backgroundColor'];
    gridColor: CampaignWorldDefinition['gridColor'];
  };
  'ui:admin-update-world': {
    world: number;
    backgroundColor: CampaignWorldDefinition['backgroundColor'];
    gridColor: CampaignWorldDefinition['gridColor'];
  };
  'ui:admin-delete-world': { world: number };
  'ui:admin-edit-contract': { contractId: ContractId };
  'ui:admin-delete-contract': { contractId: ContractId };
  'ui:tool': { type: MachineType };
  'ui:tool-drag': {
    type: MachineType | 'obstacle' | 'star';
    phase: 'start' | 'move' | 'end' | 'cancel';
    clientX: number;
    clientY: number;
  };
  'ui:run': undefined;
  'ui:toggle-simulation': undefined;
  'ui:pause': undefined;
  'ui:reset': undefined;
  'ui:clear': undefined;
  'ui:undo': undefined;
  'ui:redo': undefined;
  'ui:delete-selected': undefined;
  'ui:copy-selected': undefined;
  'ui:cut-selected': undefined;
  'ui:reverse-selected': undefined;
  'ui:toggle-grid': undefined;
  'ui:set-simulation-speed': { speed: number };
  'ui:set-muted': { muted: boolean };
  'ui:set-volume': { volume: number };
  'ui:fullscreen': undefined;
  'ui:replay': undefined;
  'ui:next-contract': undefined;
  'ui:menu': undefined;
  'debug:set-machines': MachineState[];
}

export const appEvents = new EventBus<AppEvents>();
