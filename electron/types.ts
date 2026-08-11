export type TaskStatus = 'queued' | 'planning' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled';
export type Risk = 'low' | 'medium' | 'high' | 'blocked';

export type ShellTool = { kind: 'shell'; command: string; args: string[]; cwd: string; timeoutMs: number };
export type FileTool = { kind: 'file'; operation: 'list' | 'read' | 'stat'; path: string; maxBytes?: number };
export type BrowserTool = { kind: 'browser'; url: string };
export type ToolCall = ShellTool | FileTool | BrowserTool;

export interface Approval {
  id: string;
  taskId: string;
  reason: string;
  risk: Risk;
  call: ToolCall;
  createdAt: number;
}

export interface TaskRecord {
  id: string;
  prompt: string;
  status: TaskStatus;
  provider: string;
  createdAt: number;
  updatedAt: number;
  output: string[];
  error?: string;
  approval?: Approval;
}

export interface BuddySettings {
  provider: 'demo' | 'codex';
  defaultCwd: string;
  launchAtLogin: boolean;
}
