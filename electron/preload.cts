import { contextBridge, ipcRenderer } from 'electron';
import type { BuddySettings, ListeningState, TaskRecord, TranscriptResult } from './types.js';

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
  listTasks: (): Promise<TaskRecord[]> => invoke('tasks:list', 10_000),
  submit: (prompt: string): Promise<TaskRecord> => invoke('tasks:submit', 15_000, prompt),
  cancel: (id: string): Promise<void> => invoke('tasks:cancel', 15_000, id),
  approve: (id: string, approved: boolean): Promise<void> => invoke('tasks:approve', 15_000, id, approved),
  transcribe: (audio: ArrayBuffer, mimeType: string): Promise<TranscriptResult> =>
    invoke('voice:transcribe', 160_000, audio, mimeType),
  getSettings: (): Promise<BuddySettings> => invoke('settings:get', 10_000),
  updateSettings: (value: Partial<BuddySettings>): Promise<BuddySettings> => invoke('settings:update', 15_000, value),
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
