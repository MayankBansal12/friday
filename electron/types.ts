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
  timings?: { conversionMs: number; transcriptionMs: number; totalMs: number };
}
