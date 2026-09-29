/// <reference types="vite/client" />
import type { PcmRequest, PcmResult } from '../electron/pcm-transcription';
import type { DesktopStatus } from '../electron/desktop-status';
import type {
  BuddySettings,
  FridayState,
  ListeningState,
  SurfaceLayout,
  RequestContext,
  TaskRecord,
  TranscriptResult,
} from '../electron/types';

declare global {
  interface Window {
    buddy: {
      controlling(): Promise<boolean>;
      onControlling(callback: (active: boolean) => void): () => void;
      guidance(): Promise<boolean>;
      onGuidance(callback: (guiding: boolean) => void): () => void;
      fridayState(): Promise<FridayState>;
      stopChild(id: string): Promise<unknown>;
      stopForeground(): Promise<void>;
      setSurface(layout: SurfaceLayout, height?: number, contentWidth?: number): Promise<void>;
      onFridayState(callback: (state: FridayState) => void): () => void;
      listTasks(): Promise<TaskRecord[]>;
      submit(prompt: string, context?: RequestContext): Promise<TaskRecord>;
      newConversation(): Promise<string>;
      desktopStatus(): Promise<DesktopStatus>;
      mark(): Promise<void>;
      clearDrawing(): Promise<void>;
      stop(): Promise<void>;
      onMark(callback: (mark: Record<string, unknown>) => void): () => void;
      approve(id: string, approved: boolean): Promise<void>;
      transcribePcm(request: PcmRequest): Promise<PcmResult>;
      transcribe(audio: ArrayBuffer, mimeType: string): Promise<TranscriptResult>;
      getSettings(): Promise<BuddySettings>;
      updateSettings(value: Partial<BuddySettings>): Promise<BuddySettings>;
      speak(taskId: string): Promise<void>;
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
