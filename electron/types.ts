import type { CompanionMode } from './desktop-protocol.js';
export type RunStatus = 'queued' | 'thinking' | 'acting' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface AgentStep {
  id: string;
  kind: 'thought' | 'tool' | 'result' | 'status';
  title: string;
  detail?: string;
  status: 'running' | 'done' | 'failed';
  createdAt: number;
  durationMs?: number;
  metrics?: Record<string, number>;
}

export interface Approval {
  id: string;
  title: string;
  message: string;
  createdAt: number;
}

export interface TaskRecord {
  conversationId?: string;
  role?: 'parent' | 'child';
  parentId?: string;
  spoken?: boolean;
  mode?: CompanionMode;
  id: string;
  prompt: string;
  status: RunStatus;
  stopReason?: 'user' | 'escape';
  timings?: {
    queueMs?: number;
    startupMs?: number;
    firstModelMs?: number;
    firstTextMs?: number;
    firstDrawingMs?: number;
    totalMs?: number;
  };
  createdAt: number;
  updatedAt: number;
  response?: string;
  error?: string;
  steps: AgentStep[];
  approval?: Approval;
}

export interface SessionRecord {
  id: string;
  role: 'parent' | 'child';
  parentId?: string;
  title: string;
  status: 'idle' | 'running' | 'needs_input' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  latestTaskId?: string;
  summary?: string;
  question?: string;
}

export interface PresentationState {
  text: string;
  expanded: boolean;
  speaking: boolean;
  taskId?: string;
}

export interface FridayState {
  parentId: string;
  sessions: SessionRecord[];
  presentation: PresentationState;
}

export type SurfaceLayout = 'orb' | 'bar' | 'panel' | 'details';

export interface BuddySettings {
  defaultCwd: string;
  launchAtLogin: boolean;
  wakeWord: string;
  model: string;
  autoSpeak?: boolean;
}

export type ListeningState = 'idle' | 'listening' | 'transcribing' | 'armed' | 'error';

export interface TranscriptResult {
  text: string;
  wakeDetected: boolean;
  command?: string;
  timings?: {
    conversionMs: number;
    transcriptionMs: number;
    totalMs: number;
    modelWaitMs?: number;
    inferenceMs?: number;
  };
}
