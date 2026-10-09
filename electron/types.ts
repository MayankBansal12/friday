export type RunStatus = 'thinking' | 'acting' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
export const activeStatuses: ReadonlySet<RunStatus> = new Set(['thinking', 'acting', 'awaiting_approval']);

export interface AgentStep {
  id: string;
  kind: 'thought' | 'tool' | 'result' | 'status';
  title: string;
  detail?: string;
  status: 'running' | 'done' | 'failed';
  createdAt: number;
  durationMs?: number;
  metrics?: Record<string, number>;
}

export interface Approval {
  id: string;
  title: string;
  message: string;
  createdAt: number;
}

export interface TaskRecord {
  conversationId?: string;
  role?: 'parent' | 'child';
  parentId?: string;
  /** Speech handled this turn (including mute). */
  spoken?: boolean;
  /** Last host-validated utterance, used only for explicit replay. */
  speechText?: string;
  speechIssue?: string;
  /** Where the request came from; decides the default reply channel. */
  source?: RequestSource;
  /** Every interact group for this request, with its actual delivery outcome. */
  interactions?: InteractionRecord[];
  id: string;
  prompt: string;
  status: RunStatus;
  stopReason?: 'user' | 'escape';
  timings?: {
    startupMs?: number;
    firstModelMs?: number;
    firstTextMs?: number;
    firstDrawingMs?: number;
    totalMs?: number;
  };
  createdAt: number;
  updatedAt: number;
  response?: string;
  /** Camera frames Friday looked at for this request, so the transcript shows camera use. */
  cameraFrames?: number;
  error?: string;
  steps: AgentStep[];
  approval?: Approval;
}

export interface SessionRecord {
  id: string;
  role: 'parent' | 'child';
  parentId?: string;
  title: string;
  status: 'idle' | 'running' | 'needs_input' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  latestTaskId?: string;
  summary?: string;
  question?: string;
}

export interface EchoEntry {
  text: string;
  /** Epoch ms when playback ended; absent while it is still playing. The renderer applies its own expiry. */
  endedAt?: number;
}

export interface PresentationState {
  text: string;
  expanded: boolean;
  speaking: boolean;
  /** The speech playing is only a short "hmm, let's see" acknowledgement, not a reply. */
  acknowledging?: boolean;
  taskId?: string;
  /** Current or recent Friday utterances; the renderer drops transcripts that echo them. */
  echo?: EchoEntry[];
}

export type CameraState = 'off' | 'opening' | 'live' | 'closing';

/** What Friday is doing with the live camera, so the UI can narrate every look. */
export interface CameraActivity {
  kind: 'looking' | 'watching' | 'looked';
  /** Watching only: how long Friday watches. */
  seconds?: number;
  /** Looked only: how many frames went to the model. */
  frames?: number;
  at: number;
}

export interface FridayState {
  /** Off only once every capture process has released the device, including cancellation cleanup. */
  camera?: CameraState;
  cameraActivity?: CameraActivity;
  /** Why the camera last stopped on its own; cleared when it turns on again. */
  cameraError?: { message: string; at: number };
  parentId: string;
  sessions: SessionRecord[];
  presentation: PresentationState;
}

/** How long "Looked through your camera" stays in the status line after a look. */
export const cameraLookedMs = 5000;

/** The status line while the camera is on: every start, look, and close is narrated. */
export function cameraActivityLine(state: Pick<FridayState, 'camera' | 'cameraActivity'> | undefined, now: number) {
  const activity = state?.cameraActivity;
  if (state?.camera === 'opening') return 'Starting your camera to see…';
  if (state?.camera === 'closing') return 'Turning your camera off…';
  if (state?.camera !== 'live') return undefined;
  if (activity?.kind === 'looking') return 'Looking through your camera…';
  if (activity?.kind === 'watching') return `Watching for ${activity.seconds}s…`;
  if (activity?.kind === 'looked' && now - activity.at < cameraLookedMs)
    return activity.frames && activity.frames > 1 ? `Checked ${activity.frames} frames` : 'Looked through your camera';
  return undefined;
}

/** Camera indicator text, shown until every capture process has released the device. */
export function cameraStatus(state?: Pick<FridayState, 'camera'>) {
  return state?.camera === 'opening'
    ? 'Camera on · Starting…'
    : state?.camera === 'live'
      ? 'Camera on'
      : state?.camera === 'closing'
        ? 'Camera on · Closing…'
        : undefined;
}

/** The notch edge that stays put while it resizes: bottom when dragged into the lower half of the screen. */
export type NotchAnchor = 'top' | 'bottom';

export type SurfaceLayout = 'orb' | 'tasks' | 'quiet' | 'bar' | 'panel' | 'details';

export interface BuddySettings {
  /** Let Friday turn on the webcam when asked to look; enabled by default. */
  cameraEnabled?: boolean;
  defaultCwd: string;
  launchAtLogin: boolean;
  wakeWord: string;
  model: string;
  autoSpeak?: boolean;
  /** Typed requests reply visibly by default; opt in to also speak them. */
  speakTypedReplies?: boolean;
  /** Renderer drag offset from the default top-center notch anchor, in CSS px. */
  notchOffset?: { x: number; y: number };
}

export type ListeningState = 'idle' | 'paused' | 'starting' | 'listening' | 'transcribing' | 'armed' | 'error';

/** How the renderer gates the microphone before audio reaches speech recognition. */
export interface VoiceGate {
  /** A local wake word detector hears "Hey Friday"; other speech is never transcribed. */
  localWake: boolean;
  /** Interim re-decodes while speaking; off for hosted recognition, billed per request. */
  partials: boolean;
}

export interface TranscriptResult {
  text: string;
  wakeDetected: boolean;
  command?: string;
  timings?: {
    conversionMs: number;
    transcriptionMs: number;
    totalMs: number;
    modelWaitMs?: number;
    inferenceMs?: number;
  };
}

export type RequestSource = 'voice' | 'typed';
export interface RequestContext {
  selectedChildId?: string;
  source?: RequestSource;
}

export type InteractTool = 'speak_tool' | 'draw_tool' | 'show_text_tool';
/**
 * accepted: validated, not yet delivered. scheduled: speech PCM handed to the audio sink
 * (not proof of playout). completed: terminal success — drawing rendered (GNOME ack),
 * text shown, or speech playback finished.
 */
export type InteractActionStatus =
  'accepted' | 'scheduled' | 'completed' | 'failed' | 'cancelled' | 'suppressed' | 'interrupted';
export interface InteractActionRecord {
  tool: InteractTool;
  status: InteractActionStatus;
  /** Host-generated annotation IDs; pass them to desktop_clear. */
  ids?: string[];
  text?: string;
  error?: string;
  reason?: string;
  /** Drawing only: GNOME confirmed it rendered. */
  rendered?: boolean;
  /** Speech only: visuals were released before its first audio arrived. */
  late?: boolean;
  /** Speech only. Durations are estimates labelled by evidence, never "heard words". */
  playback?: {
    evidence: 'dispatch-estimate' | 'transport' | 'client-observed' | 'none';
    pcmArrivedMs?: number;
    sinkScheduledMs?: number;
    playbackObservedMs?: number;
    scheduledAudioMs?: number;
    playedMs?: number;
    interrupted: boolean;
    /** Text alignment is unavailable: which words were heard is never inferred from elapsed time. */
    heardWords: 'unknown' | 'none';
    /** The local player drained every scheduled sample (pw-cat only); transport completion is not playout. */
    localPlayoutDrained?: boolean;
  };
}
export interface InteractionRecord {
  id: string;
  createdAt: number;
  timing: 'parallel' | 'together';
  status: 'in_progress' | 'completed' | 'partial' | 'failed' | 'cancelled';
  actions: InteractActionRecord[];
  updatedAt: number;
}

/** Renderer credentials for the local LiveKit room: a short-lived token, never the API secret. */
export interface LiveKitSession {
  url: string;
  token: string;
  /** Identity whose track carries Friday's voice. */
  voice: string;
}
