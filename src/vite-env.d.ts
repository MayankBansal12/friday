/// <reference types="vite/client" />
import type { DesktopStatus } from '../electron/desktop-status';
import type { BuddySettings, ListeningState, TaskRecord, TranscriptResult } from '../electron/types';

declare global {
  interface Window {
    buddy: {
      listTasks(): Promise<TaskRecord[]>;
      submit(prompt: string, conversationId?: string): Promise<TaskRecord>;
      newConversation(): Promise<string>;
      desktopStatus(): Promise<DesktopStatus>;
      mark(): Promise<void>;
      clearDrawing(): Promise<void>;
      stop(): Promise<void>;
      onMark(callback: (mark: Record<string, unknown>) => void): () => void;
      cancel(id: string): Promise<void>;
      approve(id: string, approved: boolean): Promise<void>;
      transcribe(audio: ArrayBuffer, mimeType: string): Promise<TranscriptResult>;
      getSettings(): Promise<BuddySettings>;
      updateSettings(value: Partial<BuddySettings>): Promise<BuddySettings>;
      speak(text: string): Promise<void>;
      silence(): Promise<void>;
      setExpanded(value: boolean): Promise<void>;
      onExpanded(callback: (expanded: boolean) => void): () => void;
      hide(): Promise<void>;
      listening(state: ListeningState): void;
      onTask(callback: (task: TaskRecord) => void): () => void;
      onListen(callback: () => void): () => void;
      onStopListening(callback: () => void): () => void;
    };
  }
}

export {};
