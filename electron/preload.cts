import { contextBridge, ipcRenderer } from 'electron';
import type { BuddySettings, TaskRecord } from './types.js';

contextBridge.exposeInMainWorld('buddy', {
  listTasks: (): Promise<TaskRecord[]> => ipcRenderer.invoke('tasks:list'),
  submit: (prompt: string): Promise<TaskRecord> => ipcRenderer.invoke('tasks:submit', prompt),
  cancel: (id: string): Promise<void> => ipcRenderer.invoke('tasks:cancel', id),
  approve: (id: string, approved: boolean): Promise<void> => ipcRenderer.invoke('tasks:approve', id, approved),
  getSettings: (): Promise<BuddySettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (value: Partial<BuddySettings>): Promise<void> => ipcRenderer.invoke('settings:update', value),
  hide: (): Promise<void> => ipcRenderer.invoke('window:hide'),
  onTask: (callback: (task: TaskRecord) => void) => {
    const handler = (_: unknown, task: TaskRecord) => callback(task);
    ipcRenderer.on('task:changed', handler);
    return () => ipcRenderer.removeListener('task:changed', handler);
  },
  onFocusInput: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('window:focus-input', handler);
    return () => ipcRenderer.removeListener('window:focus-input', handler);
  },
});
