/// <reference types="vite/client" />
import type { BuddySettings, TaskRecord } from '../electron/types';
declare global {
  interface Window {
    buddy: {
      listTasks(): Promise<TaskRecord[]>;
      submit(prompt: string): Promise<TaskRecord>;
      cancel(id: string): Promise<void>;
      approve(id: string, approved: boolean): Promise<void>;
      getSettings(): Promise<BuddySettings>;
      updateSettings(value: Partial<BuddySettings>): Promise<void>;
      hide(): Promise<void>;
      onTask(callback: (task: TaskRecord) => void): () => void;
    };
  }
}
export {};
