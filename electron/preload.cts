import type { PcmRequest, PcmResult } from './pcm-transcription.js';
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopStatus } from './desktop-status.js';
import type { TurnDecision, TurnInput } from './jev-client.js';
import type {
  BuddySettings,
  LiveKitSession,
  FridayState,
  ListeningState,
  NotchAnchor,
  SurfaceLayout,
  RequestContext,
  TaskRecord,
  TranscriptResult,
  VoiceGate,
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
  controlling: (): Promise<boolean> => invoke('desktop:controlling', 10_000),
  onControlling: (callback: (active: boolean) => void) => {
    const handler = (_: unknown, active: boolean) => callback(active);
    ipcRenderer.on('desktop:controlling', handler);
    return () => ipcRenderer.removeListener('desktop:controlling', handler);
  },
  onGuidance: (callback: (guiding: boolean) => void) => {
    const handler = (_: unknown, guiding: boolean) => callback(guiding);
    ipcRenderer.on('desktop:guidance', handler);
    return () => ipcRenderer.removeListener('desktop:guidance', handler);
  },
  fridayState: (): Promise<FridayState> => invoke('friday:state', 10_000),
  stopChild: (id: string) => invoke('sessions:stop', 10_000, id),
  stopForeground: (): Promise<void> => invoke('foreground:stop', 15_000),
  setSurface: (layout: SurfaceLayout, height?: number, contentWidth?: number): Promise<void> =>
    invoke('window:surface', 10_000, layout, height, contentWidth),
  setNotchOffset: (offset?: { x: number; y: number }): Promise<void> => invoke('window:notch-offset', 10_000, offset),
  notchAnchor: (): Promise<NotchAnchor> => invoke('window:anchor', 10_000),
  notchAnchorReady: () => ipcRenderer.send('window:anchor-ready'),
  onNotchAnchorPrepare: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('window:anchor-prepare', handler);
    return () => ipcRenderer.removeListener('window:anchor-prepare', handler);
  },
  onNotchAnchor: (callback: (anchor: NotchAnchor) => void) => {
    const handler = (_: unknown, anchor: NotchAnchor) => callback(anchor);
    ipcRenderer.on('window:anchor', handler);
    return () => ipcRenderer.removeListener('window:anchor', handler);
  },
  onFridayState: (callback: (state: FridayState) => void) => {
    const handler = (_: unknown, state: FridayState) => callback(state);
    ipcRenderer.on('friday:state', handler);
    return () => ipcRenderer.removeListener('friday:state', handler);
  },
  listTasks: (): Promise<TaskRecord[]> => invoke('tasks:list', 10_000),
  submit: (prompt: string, context?: RequestContext): Promise<TaskRecord> =>
    invoke('tasks:submit', 15_000, prompt, context),
  newConversation: (): Promise<string> => invoke('conversation:new', 10_000),
  setCamera: (on: boolean): Promise<void> => invoke('camera:set', 15_000, on),
  onCameraFrame: (callback: (jpeg: Uint8Array) => void) => {
    const handler = (_: unknown, jpeg: Uint8Array) => callback(jpeg);
    ipcRenderer.on('camera:frame', handler);
    return () => ipcRenderer.removeListener('camera:frame', handler);
  },
  desktopStatus: (): Promise<DesktopStatus> => invoke('desktop:status', 30_000),
  mark: (): Promise<void> => invoke('desktop:mark', 30_000),
  clearDrawing: (): Promise<void> => invoke('desktop:clear', 30_000),
  stop: (): Promise<void> => invoke('desktop:stop', 15_000),
  onMark: (callback: (mark: Record<string, unknown>) => void) => {
    const handler = (_: unknown, mark: Record<string, unknown>) => callback(mark);
    ipcRenderer.on('desktop:marked', handler);
    return () => ipcRenderer.removeListener('desktop:marked', handler);
  },
  onPointer: (callback: (pointer: { x: number; y: number }) => void) => {
    const handler = (_: unknown, pointer: { x: number; y: number }) => callback(pointer);
    ipcRenderer.on('desktop:pointer', handler);
    return () => ipcRenderer.removeListener('desktop:pointer', handler);
  },
  approve: (id: string, approved: boolean): Promise<void> => invoke('tasks:approve', 15_000, id, approved),
  transcribePcm: (request: PcmRequest): Promise<PcmResult> => invoke('voice:pcm', 130_000, request),
  voiceGate: (): Promise<VoiceGate> => invoke('voice:wake-status', 10_000),
  /** Segment diagnostics for the opt-in debug log; main validates and keeps metadata only. */
  voiceTrace: (trace: Record<string, unknown>) => ipcRenderer.send('voice:trace', trace),
  feedWakeWord: (audio: ArrayBuffer): Promise<boolean> => invoke('voice:wake-feed', 10_000, audio),
  turnGate: (turn: TurnInput): Promise<TurnDecision | undefined> => invoke('voice:turn-gate', 5_000, turn),
  transcribe: (audio: ArrayBuffer, mimeType: string): Promise<TranscriptResult> =>
    invoke('voice:transcribe', 160_000, audio, mimeType),
  getSettings: (): Promise<BuddySettings> => invoke('settings:get', 10_000),
  updateSettings: (value: Partial<BuddySettings>): Promise<BuddySettings> => invoke('settings:update', 15_000, value),
  speak: (taskId: string): Promise<void> => invoke('voice:speak', 180_000, taskId),
  silence: (): Promise<void> => invoke('voice:silence', 10_000),
  interrupt: (): Promise<void> => invoke('voice:interrupt', 10_000),
  livekit: {
    /** Undefined when LiveKit is not configured; rejects while the room is unreachable. */
    session: (): Promise<LiveKitSession | undefined> => invoke('livekit:session', 20_000),
    listener: (ready: boolean) => ipcRenderer.send('livekit:listener', ready),
    observed: (id: number) => ipcRenderer.send('livekit:observed', id),
    onExpect: (callback: (id: number) => void) => {
      const handler = (_: unknown, id: number) => callback(id);
      ipcRenderer.on('livekit:expect', handler);
      return () => ipcRenderer.removeListener('livekit:expect', handler);
    },
    onCancelled: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('livekit:cancelled', handler);
      return () => ipcRenderer.removeListener('livekit:cancelled', handler);
    },
    onMicrophone: (callback: (frame: ArrayBuffer) => void) => {
      const handler = (_: unknown, frame: ArrayBuffer) => callback(frame);
      ipcRenderer.on('livekit:microphone', handler);
      return () => ipcRenderer.removeListener('livekit:microphone', handler);
    },
    onMicrophoneReady: (callback: (sid: string) => void) => {
      const handler = (_: unknown, sid: string) => callback(sid);
      ipcRenderer.on('livekit:microphone-ready', handler);
      return () => ipcRenderer.removeListener('livekit:microphone-ready', handler);
    },
  },
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
