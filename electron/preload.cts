import { contextBridge, ipcRenderer } from 'electron';
import type { BuddySettings, ListeningState, TaskRecord, TranscriptResult } from './types.js';

contextBridge.exposeInMainWorld('buddy', {
  listTasks: (): Promise<TaskRecord[]> => ipcRenderer.invoke('tasks:list'),
  submit: (prompt: string): Promise<TaskRecord> => ipcRenderer.invoke('tasks:submit', prompt),
  cancel: (id: string): Promise<void> => ipcRenderer.invoke('tasks:cancel', id),
  approve: (id: string, approved: boolean): Promise<void> => ipcRenderer.invoke('tasks:approve', id, approved),
  transcribe: (audio: ArrayBuffer, mimeType: string): Promise<TranscriptResult> =>
    ipcRenderer.invoke('voice:transcribe', audio, mimeType),
  getSettings: (): Promise<BuddySettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (value: Partial<BuddySettings>): Promise<void> => ipcRenderer.invoke('settings:update', value),
  hide: (): Promise<void> => ipcRenderer.invoke('window:hide'),
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
});
