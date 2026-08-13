export type RunStatus = 'queued' | 'thinking' | 'acting' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface AgentStep {
  id: string;
  kind: 'thought' | 'tool' | 'result' | 'status';
  title: string;
  detail?: string;
  status: 'running' | 'done' | 'failed';
  createdAt: number;
}

export interface Approval {
  id: string;
  title: string;
  message: string;
  createdAt: number;
}

export interface TaskRecord {
  id: string;
  prompt: string;
  status: RunStatus;
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
}

export type ListeningState = 'idle' | 'listening' | 'transcribing' | 'armed' | 'error';

export interface TranscriptResult {
  text: string;
  wakeDetected: boolean;
  command?: string;
}
