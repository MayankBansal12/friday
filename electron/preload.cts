import type { PcmRequest, PcmResult } from './pcm-transcription.js';
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopStatus } from './desktop-status.js';
import type {
  BuddySettings,
  FridayState,
  ListeningState,
  SurfaceLayout,
  RequestContext,
  TaskRecord,
  TranscriptResult,
} from './types.js';

function invoke<T>(channel: string, timeoutMs: number, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${channel} timed out`)), timeoutMs);
    void (ipcRenderer.invoke(channel, ...args) as Promise<T>).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

contextBridge.exposeInMainWorld('buddy', {
  guidance: (): Promise<boolean> => invoke('desktop:guidance', 10_000),
  onGuidance: (callback: (guiding: boolean) => void) => {
    const handler = (_: unknown, guiding: boolean) => callback(guiding);
    ipcRenderer.on('desktop:guidance', handler);
    return () => ipcRenderer.removeListener('desktop:guidance', handler);
  },
  fridayState: (): Promise<FridayState> => invoke('friday:state', 10_000),
  stopChild: (id: string) => invoke('sessions:stop', 10_000, id),
  stopForeground: (): Promise<void> => invoke('foreground:stop', 15_000),
  setSurface: (layout: SurfaceLayout, height?: number): Promise<void> =>
    invoke('window:surface', 10_000, layout, height),
  onFridayState: (callback: (state: FridayState) => void) => {
    const handler = (_: unknown, state: FridayState) => callback(state);
    ipcRenderer.on('friday:state', handler);
    return () => ipcRenderer.removeListener('friday:state', handler);
  },
  listTasks: (): Promise<TaskRecord[]> => invoke('tasks:list', 10_000),
  submit: (prompt: string, context?: RequestContext): Promise<TaskRecord> =>
    invoke('tasks:submit', 15_000, prompt, context),
  newConversation: (): Promise<string> => invoke('conversation:new', 10_000),
  desktopStatus: (): Promise<DesktopStatus> => invoke('desktop:status', 30_000),
  mark: (): Promise<void> => invoke('desktop:mark', 30_000),
  clearDrawing: (): Promise<void> => invoke('desktop:clear', 30_000),
  stop: (): Promise<void> => invoke('desktop:stop', 15_000),
  onMark: (callback: (mark: Record<string, unknown>) => void) => {
    const handler = (_: unknown, mark: Record<string, unknown>) => callback(mark);
    ipcRenderer.on('desktop:marked', handler);
    return () => ipcRenderer.removeListener('desktop:marked', handler);
  },
  approve: (id: string, approved: boolean): Promise<void> => invoke('tasks:approve', 15_000, id, approved),
  transcribePcm: (request: PcmRequest): Promise<PcmResult> => invoke('voice:pcm', 130_000, request),
  transcribe: (audio: ArrayBuffer, mimeType: string): Promise<TranscriptResult> =>
    invoke('voice:transcribe', 160_000, audio, mimeType),
  getSettings: (): Promise<BuddySettings> => invoke('settings:get', 10_000),
  updateSettings: (value: Partial<BuddySettings>): Promise<BuddySettings> => invoke('settings:update', 15_000, value),
  speak: (taskId: string): Promise<void> => invoke('voice:speak', 180_000, taskId),
  silence: (): Promise<void> => invoke('voice:silence', 10_000),
  setExpanded: (value: boolean): Promise<void> => invoke('window:expand', 10_000, value),
  onExpanded: (callback: (expanded: boolean) => void) => {
    const handler = (_: unknown, expanded: boolean) => callback(expanded);
    ipcRenderer.on('window:expanded', handler);
    return () => ipcRenderer.removeListener('window:expanded', handler);
  },
  hide: (): Promise<void> => invoke('window:hide', 10_000),
  listening: (state: ListeningState) => ipcRenderer.send('voice:state', state),
  onTask: (callback: (task: TaskRecord) => void) => {
    const handler = (_: unknown, task: TaskRecord) => callback(task);
    ipcRenderer.on('task:changed', handler);
    return () => ipcRenderer.removeListener('task:changed', handler);
  },
  onListen: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('voice:start', handler);
    return () => ipcRenderer.removeListener('voice:start', handler);
  },
  onStopListening: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('voice:stop', handler);
    return () => ipcRenderer.removeListener('voice:stop', handler);
  },
});
