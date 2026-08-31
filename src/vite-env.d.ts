/// <reference types="vite/client" />
import type { BuddySettings, ListeningState, TaskRecord, TranscriptResult } from '../electron/types';

declare global {
  interface Window {
    buddy: {
      listTasks(): Promise<TaskRecord[]>;
      submit(prompt: string): Promise<TaskRecord>;
      cancel(id: string): Promise<void>;
      approve(id: string, approved: boolean): Promise<void>;
      transcribe(audio: ArrayBuffer, mimeType: string): Promise<TranscriptResult>;
      getSettings(): Promise<BuddySettings>;
      updateSettings(value: Partial<BuddySettings>): Promise<BuddySettings>;
      hide(): Promise<void>;
      listening(state: ListeningState): void;
      onTask(callback: (task: TaskRecord) => void): () => void;
      onListen(callback: () => void): () => void;
      onStopListening(callback: () => void): () => void;
    };
  }
}

export {};
