/// <reference types="vite/client" />
import type { PcmRequest, PcmResult } from '../electron/pcm-transcription';
import type { DesktopStatus } from '../electron/desktop-status';
import type {
  BuddySettings,
  LiveKitSession,
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
      setNotchOffset(offset?: { x: number; y: number }): Promise<void>;
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
      /** Barge-in: stop Friday's voice and unrevealed presentation; the unfinished turn stays silent. */
      interrupt(): Promise<void>;
      /** Local LiveKit room: Friday's voice in, the echo-cancelled microphone out. */
      livekit: {
        session(): Promise<LiveKitSession | undefined>;
        listener(ready: boolean): void;
        /** First audible output of the playback main said to expect. */
        observed(id: number): void;
        /** A new playback is about to arrive; 0 means none is expected. */
        onExpect(callback: (id: number) => void): () => void;
        /** Playback was cut off: drop audio already buffered for output. */
        onCancelled(callback: () => void): () => void;
        /** 20 ms, 16 kHz mono PCM16 of this microphone, as received by main over LiveKit. */
        onMicrophone(callback: (frame: ArrayBuffer) => void): () => void;
        /** Track SID of the microphone main is receiving over LiveKit; '' when none. */
        onMicrophoneReady(callback: (sid: string) => void): () => void;
      };
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
