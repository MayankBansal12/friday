import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp,
  CircleHelp,
  TriangleAlert,
  Square,
  Check,
  CircleStop,
  LoaderCircle,
  Mic,
  MicOff,
  Maximize2,
  ChevronUp,
  X,
} from 'lucide-react';
import {
  activeStatuses,
  cameraStatus,
  type FridayState,
  type ListeningState,
  type NotchAnchor,
  type SurfaceLayout,
  type TaskRecord,
} from '../electron/types';
import { bottomCanvas } from '../electron/notch-placement';
import { FridayMascot, type FridayMood } from './FridayMascot';
import './presence.css';
import { Conversation } from './Conversation';
import { CameraStage } from './CameraStage';
import { useCameraLine } from './useCameraLine';

/** The camera panel never grows past the screen; Friday's window sits 5px below the top panel. */
const cameraMax = Math.min(690, window.screen.availHeight - 40);
/** Opening upward, the camera panel must also fit the room above the bar. */
function cameraMaxAbove(offsetY?: number) {
  const area = {
    y: (window.screen as Screen & { availTop?: number }).availTop ?? 0,
    height: window.screen.availHeight,
  };
  return Math.min(cameraMax, bottomCanvas(area, offsetY ?? 0, Infinity) - 12);
}

const notchSpring = { type: 'spring', stiffness: 420, damping: 40, mass: 1 } as const;

function NotchBody({
  children,
  reducedMotion,
  onStart,
  onComplete,
}: {
  children: ReactNode;
  reducedMotion: boolean;
  onStart(): void;
  onComplete(): void;
}) {
  const present = useIsPresent();
  return (
    <motion.div
      className="presence-reveal"
      inert={!present}
      aria-hidden={!present}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={reducedMotion ? { duration: 0 } : { ...notchSpring, opacity: { duration: 0.18 } }}
      onAnimationStart={onStart}
      onAnimationComplete={onComplete}
    >
      <div className="presence-body">{children}</div>
    </motion.div>
  );
}

interface Props {
  state?: FridayState;
  task?: TaskRecord;
  tasks: TaskRecord[];
  listening: ListeningState;
  speaking: boolean;
  guiding: boolean;
  controlling: boolean;
  level: number;
  heard: string;
  /** The heard words were judged not meant for Friday and did not interrupt it. */
  heardIgnored?: boolean;
  /** Submit ignored speech after all. */
  onSendIgnored?: () => void;
  /** The user's recognized words: live while they speak, final briefly after submission. */
  transcript?: { text: string; final: boolean };
  error?: string;
  /** A brief recoverable voice notice ("please say that again"), shown in the status line. */
  notice?: string;
  selectedChildId?: string;
  reportedChildren?: Record<string, number>;
  onSelectTask(id: string): void;
  onClearContext(): void;
  micEnabled: boolean;
  wakeWord: string;
  onMicOff(): void;
  typing: boolean;
  onTypingChange(value: boolean): void;
  draft: string;
  onDraftChange(value: string): void;
  onTalk(): void;
  onContinue(): void;
  onMicOn(): void;
  onStop(): void;
  onSubmit(text: string): void;
  onDetails(): void;
  onStopChild(id: string): void;
  onApprove(id: string, approved: boolean): void;
  notchOffset?: { x: number; y: number };
  onWindowDrag?(offset: { x: number; y: number }): void;
}

/** Quoted user words; live words keep their newest end visible in the narrow notch. */
function spokenLine(text: string, final: boolean) {
  const clean = text.trim().replace(/\s+/g, ' ');
  const shown = !final && clean.length > 56 ? `…${clean.slice(-55).trimStart()}` : clean;
  return `“${shown}”`;
}

function taskPreview(text: string) {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('|'))
      ?.replace(/^#{1,6}\s+/, '')
      .replace(/[*_`]/g, '')
      .slice(0, 180) || 'Done'
  );
}

export function FridayPresence(props: Props) {
  const { state, task, listening, speaking } = props;
  const cameraOn = Boolean(cameraStatus(state));
  const cameraLine = useCameraLine(state);
  // Starting, looking, watching, and closing lead the status line; a finished look yields to speech.
  const cameraNow =
    cameraLine && !(state?.camera === 'live' && state.cameraActivity?.kind === 'looked') ? cameraLine : undefined;
  const cameraChanging = state?.camera === 'opening' || state?.camera === 'closing';
  const reducedMotion = Boolean(useReducedMotion());
  const [hovered, setHovered] = useState(false);
  // Moving the pill is not asking to see it: a drag closes the hover panel, and the pointer must
  // leave and come back before hovering opens it again.
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const hoverHeld = useRef(false);
  // Near the bottom of the screen, where its panel can't fit below, the notch grows upward, with its bar at the bottom.
  const [anchor, setAnchor] = useState<NotchAnchor>('top');
  // Switching edges hides the pill while the window is re-placed, so it never flashes at the old edge.
  const [reanchoring, setReanchoring] = useState(false);
  useEffect(() => {
    let disposed = false;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reveal: (() => void) | undefined;
    // Each switch starts clean: a reveal still pending from the last one must not show the pill early.
    const reset = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      if (reveal) window.removeEventListener('resize', reveal);
      reveal = undefined;
    };
    // Two frames: the first commits the change, the second is on screen.
    const settle = (done: () => void) => {
      frame = requestAnimationFrame(() => (frame = requestAnimationFrame(done)));
    };
    const removePrepare = window.buddy.onNotchAnchorPrepare(() => {
      reset();
      setReanchoring(true);
      settle(() => window.buddy.notchAnchorReady());
    });
    const removeAnchor = window.buddy.onNotchAnchor((next) => {
      reset();
      setAnchor(next);
      // Show the pill once the window has its new size; a switch back to the same size has none.
      const show = () => {
        reset();
        settle(() => setReanchoring(false));
      };
      reveal = show;
      window.addEventListener('resize', show);
      timer = setTimeout(show, 120);
    });
    void window.buddy.notchAnchor().then((value) => {
      if (!disposed) setAnchor(value);
    });
    return () => {
      disposed = true;
      reset();
      removePrepare();
      removeAnchor();
    };
  }, []);
  const [showTasks, setShowTasks] = useState(false);
  const { typing, onTypingChange: setTyping } = props;
  const { draft: text, onDraftChange: setText } = props;
  const [dismissed, setDismissed] = useState<string>();
  const [autoOpen, setAutoOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState<Record<string, number>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('friday.taskUpdates') || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved)
        ? Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'number'))
        : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        'friday.taskUpdates',
        JSON.stringify(Object.fromEntries(Object.entries(acknowledged).slice(-200))),
      );
    } catch {
      /* Dismissal still works for this view if storage is unavailable. */
    }
  }, [acknowledged]);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelRef = useRef<HTMLElement>(null);
  const previousPanel = useRef<HTMLElement | null>(null);
  const activeMotions = useRef(new Set<string>());
  const previousExpanded = useRef(false);
  const transitioning = useRef(false);
  const syncSurface = useRef<() => void>(() => {});
  const keyboardFocus = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const busy = task && activeStatuses.has(task.status);
  // A brief pleased squint once a task she was working on finishes and she has stopped talking.
  const [pleased, setPleased] = useState(false);
  const workedOn = useRef(new Set<string>());
  useEffect(() => {
    if (!task) return;
    if (activeStatuses.has(task.status)) workedOn.current.add(task.id);
    if (task.status !== 'completed' || speaking || !workedOn.current.delete(task.id)) return;
    const start = setTimeout(() => setPleased(true), 0);
    const end = setTimeout(() => setPleased(false), 700);
    return () => {
      clearTimeout(start);
      clearTimeout(end);
      setPleased(false);
    };
  }, [task, speaking]);
  const listeningToRequest = ['starting', 'armed', 'transcribing'].includes(listening);
  const children = (state?.sessions ?? []).filter((s) => s.role === 'child').sort((a, b) => b.updatedAt - a.updatedAt);
  const visible = children.filter(
    (s) =>
      ['running', 'needs_input'].includes(s.status) ||
      (['completed', 'failed', 'interrupted'].includes(s.status) &&
        acknowledged[s.id] !== s.updatedAt &&
        (props.reportedChildren?.[s.id] ?? 0) < s.updatedAt),
  );
  const running = children.filter((s) => s.status === 'running');
  const canStop = Boolean(
    cameraChanging ||
    busy ||
    speaking ||
    props.controlling ||
    props.guiding ||
    running.length ||
    listening === 'transcribing',
  );
  const attention = visible.filter((s) => ['needs_input', 'failed', 'interrupted'].includes(s.status)).length;
  const selected = children.find((s) => s.id === props.selectedChildId);
  const detail = props.error || task?.error || state?.presentation.text || '';
  const contentKey = `${state?.presentation.taskId ?? ''}:${detail}`;
  // A camera that stopped on its own opens the panel like a reply, so the reason is seen, not hovered for.
  const cameraFailed = Boolean(props.error && props.error === state?.cameraError?.message);
  useEffect(() => {
    if (!(state?.presentation.expanded || cameraFailed) || !detail || dismissed === contentKey) return;
    const opening = setTimeout(() => setAutoOpen(true), 0);
    const timer = setTimeout(() => setAutoOpen(false), 15_000);
    return () => {
      clearTimeout(opening);
      clearTimeout(timer);
    };
  }, [contentKey, state?.presentation.expanded, cameraFailed, detail, dismissed]);
  const approvals = props.tasks.filter((t) => t.approval);
  const important = Boolean(
    approvals.length || ((props.error || task?.error || state?.presentation.expanded) && dismissed !== contentKey),
  );
  // The user's words take the status line until Friday answers or needs something.
  const userWords =
    props.transcript?.text.trim() &&
    !cameraNow &&
    !props.controlling &&
    !typing &&
    !approvals.length &&
    !props.guiding &&
    !speaking
      ? props.transcript
      : undefined;
  const engaged = Boolean(
    cameraOn ||
    props.controlling ||
    busy ||
    speaking ||
    props.guiding ||
    listeningToRequest ||
    typing ||
    important ||
    selected ||
    userWords,
  );
  const background = !engaged && visible.length > 0;
  // A live camera keeps the panel open: its video stays on screen for as long as the camera is on.
  const expanded =
    !props.controlling &&
    !background &&
    (cameraOn || typing || (!dragging && (hovered || (autoOpen && dismissed !== contentKey))));
  const conversation = props.tasks
    .filter((item) => item.role !== 'child' && item.conversationId === state?.parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const resting = !engaged && !expanded;
  useEffect(() => {
    if (expanded) followLatest.current = true;
  }, [expanded]);
  // The expanded panel's own scroll stays at the newest content instead of a mid-scroll position.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !expanded || !followLatest.current) return;
    content.scrollTop = content.scrollHeight;
  }, [expanded, detail, conversation.length, approvals.length, props.heard, listeningToRequest]);
  const surface: SurfaceLayout = background
    ? hovered
      ? 'tasks'
      : 'orb'
    : expanded
      ? 'panel'
      : engaged
        ? 'bar'
        : 'quiet';
  const status = cameraNow
    ? cameraNow
    : props.controlling
      ? 'Controlling your computer · Esc twice to stop'
      : typing
        ? 'Type your request…'
        : approvals.length
          ? 'Needs your approval'
          : props.guiding
            ? 'Guiding you'
            : speaking
              ? 'Speaking…'
              : userWords
                ? spokenLine(userWords.text, userWords.final)
                : props.notice
                  ? props.notice
                  : cameraLine
                    ? cameraLine
                    : listening === 'starting'
                      ? 'Opening microphone…'
                      : listening === 'transcribing'
                        ? 'One moment…'
                        : busy
                          ? 'Working on it…'
                          : listening === 'armed'
                            ? 'Listening…'
                            : listening === 'error'
                              ? 'Check your microphone'
                              : cameraOn
                                ? 'Camera on · Ask me to look'
                                : !props.micEnabled
                                  ? 'Microphone off'
                                  : `Say “hey ${props.wakeWord.toLowerCase()}” to wake her up`;

  function motionStarted(part: string) {
    activeMotions.current.add(part);
    transitioning.current = true;
  }
  function motionCompleted(part: string) {
    activeMotions.current.delete(part);
    if (activeMotions.current.size) return;
    transitioning.current = false;
    syncSurface.current();
  }

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const mounted = previousPanel.current !== panel;
    previousPanel.current = panel;
    let previous = '';
    const resize = () => {
      if (transitioning.current && !background) return;
      const rect = panel?.getBoundingClientRect();
      const height = rect ? Math.ceil(rect.height) + (background ? 24 : 10) : undefined;
      const width = rect && !background ? Math.ceil(rect.width) : undefined;
      const measurement = `${height}:${width}`;
      if (measurement === previous) return;
      previous = measurement;
      void window.buddy.setSurface(surface, height, width);
    };
    syncSurface.current = resize;
    if (background || reducedMotion || mounted) {
      activeMotions.current.clear();
      transitioning.current = false;
    }
    const rect = panel?.getBoundingClientRect();
    const targetWidth = Math.min(resting ? 360 : 500, (panel?.parentElement?.clientWidth ?? 520) - 20);
    const barHeight = panel?.querySelector('.presence-bar')?.getBoundingClientRect().height;
    const changingSize =
      !mounted &&
      rect &&
      (Math.abs(rect.width - targetWidth) > 0.5 ||
        Math.abs((barHeight ?? 0) - (resting ? 42 : 54)) > 0.5 ||
        previousExpanded.current !== expanded);
    previousExpanded.current = expanded;
    if (!background && !reducedMotion && (changingSize || activeMotions.current.size)) {
      // Reserve the canvas before opening. Resizing/shaping a native window every
      // frame lags behind the spring and clips its edges on XWayland.
      transitioning.current = true;
      void window.buddy.setSurface(
        surface,
        Math.max(Math.ceil(rect?.height ?? 0) + 10, expanded ? 420 : resting ? 54 : 66),
        Math.max(Math.ceil(rect?.width ?? 0), resting ? 360 : 500),
      );
    } else {
      transitioning.current = false;
      resize();
    }
    // Completions shrink to the actual size; content changes are observed only
    // after motion settles. Initial renders with matching dimensions need no animation.
    const observer = new ResizeObserver(resize);
    if (panel) observer.observe(panel);
    return () => {
      observer.disconnect();
      syncSurface.current = () => {};
    };
  }, [surface, background, expanded, resting, reducedMotion, props.controlling]);
  // Drag the notch by its bar. Deltas use screen coordinates: the window moves
  // under the pointer, so client coordinates would cancel the drag. Offsets
  // compose over the last committed anchor; main clamps to the work area.
  const dragRef = useRef(props.onWindowDrag);
  const offsetRef = useRef(props.notchOffset);
  const controllingRef = useRef(props.controlling);
  useEffect(() => {
    dragRef.current = props.onWindowDrag;
    offsetRef.current = props.notchOffset;
    controllingRef.current = props.controlling;
  });
  useEffect(() => {
    if (!props.onWindowDrag) return;
    const root = panelRef.current?.closest('main') ?? document.body;
    let origin: { x: number; y: number } | undefined;
    let base: { x: number; y: number } | undefined;
    let pending: { x: number; y: number } | undefined;
    let moved = false;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const latest = pending;
      pending = undefined;
      // With no pending frame the last rAF already sent the final offset.
      if (latest) dragRef.current?.(latest);
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || controllingRef.current) return;
      if (!event.target || !(event.target as Element).closest?.('.presence-bar')) return;
      origin = { x: event.screenX, y: event.screenY };
      base = { ...(offsetRef.current ?? { x: 0, y: 0 }) };
      moved = false;
      // Keep receiving moves if the pointer leaves the narrow window mid-drag.
      // Never capture on buttons: pointer capture would retarget their clicks.
      if (event.target instanceof Element && !event.target.closest('button, input, a'))
        event.target.setPointerCapture?.(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!origin || !base) return;
      const dx = Math.round(event.screenX - origin.x);
      const dy = Math.round(event.screenY - origin.y);
      if (!moved && Math.hypot(dx, dy) < 6) return;
      if (!moved) {
        if (leaveTimer.current) clearTimeout(leaveTimer.current);
        hoverHeld.current = draggingRef.current = true;
        setHovered(false);
        setDragging(true);
      }
      moved = true;
      event.preventDefault();
      if (!panelRef.current?.hasPointerCapture?.(event.pointerId))
        panelRef.current?.setPointerCapture?.(event.pointerId);
      pending = { x: base.x + dx, y: base.y + dy };
      if (frame) return;
      frame = requestAnimationFrame(flush);
    };
    const up = (event: PointerEvent) => {
      if (panelRef.current?.hasPointerCapture?.(event.pointerId))
        panelRef.current.releasePointerCapture(event.pointerId);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (moved) {
        flush();
        draggingRef.current = false;
        setHovered(false);
        setDragging(false);
        // Dropped away from the pointer, there is no leave to wait for: hover works on the next visit.
        requestAnimationFrame(() => {
          if (!panelRef.current?.matches(':hover')) hoverHeld.current = false;
        });
      }
      origin = undefined;
      base = undefined;
      moved = false;
    };
    root.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      root.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [props.onWindowDrag]);
  useEffect(
    () => () => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    },
    [],
  );

  function enter() {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    if (!hoverHeld.current) setHovered(true);
  }
  function leave() {
    if (!draggingRef.current) hoverHeld.current = false;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      if (!keyboardFocus.current || !panelRef.current?.contains(document.activeElement)) {
        setHovered(false);
        if (!typing && panelRef.current?.contains(document.activeElement))
          (document.activeElement as HTMLElement).blur();
      }
    }, 450);
  }
  const collapse = useCallback(() => {
    setHovered(false);
    setAutoOpen(false);
    setTyping(false);
    setDismissed(contentKey);
  }, [contentKey, setTyping]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') collapse();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [collapse]);
  useEffect(() => {
    const blur = () => {
      keyboardFocus.current = false;
      setDismissed(contentKey);
      setHovered(false);
      setAutoOpen(false);
      setTyping(false);
    };
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, [contentKey, setTyping]);
  const mood: FridayMood =
    approvals.length || props.error || task?.error || listening === 'error'
      ? 'worried'
      : speaking
        ? 'speaking'
        : pleased
          ? 'pleased'
          : // Guiding and controlling look at her own mark or cursor instead of thinking.
            props.controlling || props.guiding
            ? 'idle'
            : busy || listening === 'transcribing'
              ? 'thinking'
              : listeningToRequest || typing
                ? 'listening'
                : !props.micEnabled
                  ? 'muted'
                  : resting
                    ? 'sleepy'
                    : !engaged
                      ? 'peeking'
                      : 'idle';
  const mark = <FridayMascot mood={mood} className="presence-mark" />;
  const taskList = (
    <section className="background-list" aria-label="Background tasks">
      <h2>
        Background tasks <span>{running.length ? `${running.length} running` : 'Updates'}</span>
      </h2>
      {visible.map((session) => (
        <div className="background-task" key={session.id}>
          <span className={`task-dot ${session.status}`}>
            {session.status === 'running' ? (
              <LoaderCircle size={14} className="spin" />
            ) : session.status === 'completed' ? (
              <Check size={14} />
            ) : session.status === 'needs_input' ? (
              <CircleHelp size={16} />
            ) : (
              <TriangleAlert size={16} />
            )}
          </span>
          <button
            className="background-task-copy"
            onClick={() => {
              setHovered(false);
              props.onSelectTask(session.id);
            }}
            title={`Talk about ${session.title}`}
          >
            <strong>{session.title}</strong>
            <small>
              {session.status === 'needs_input'
                ? session.question || 'Needs your input'
                : session.status === 'failed'
                  ? 'Couldn’t finish'
                  : session.status === 'interrupted'
                    ? 'Interrupted'
                    : session.status === 'completed'
                      ? taskPreview(session.summary || 'Done')
                      : taskPreview(session.summary || 'Working on it…')}
            </small>
          </button>
          {['running', 'needs_input'].includes(session.status) ? (
            <button
              className="presence-action"
              aria-label={`Stop ${session.title}`}
              title="Stop task"
              onClick={(e) => {
                e.stopPropagation();
                props.onStopChild(session.id);
              }}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              className="presence-action"
              aria-label={`Dismiss update for ${session.title}`}
              title="Dismiss update"
              onClick={() => setAcknowledged((v) => ({ ...v, [session.id]: session.updatedAt }))}
            >
              <X size={16} />
            </button>
          )}
        </div>
      ))}
    </section>
  );

  return (
    <main
      className={`presence-root ${background ? 'background-root' : surface === 'quiet' ? 'quiet-root' : ''} ${anchor === 'bottom' && !background ? 'anchor-bottom' : ''} ${reanchoring ? 'is-reanchoring' : ''}`}
      data-surface={surface}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onPointerDown={() => {
        keyboardFocus.current = false;
      }}
      onFocus={(e) => {
        if (e.target.matches(':focus-visible')) {
          keyboardFocus.current = true;
          enter();
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          keyboardFocus.current = false;
          leave();
        }
      }}
    >
      {background ? (
        <section ref={panelRef} className="background-group">
          <button
            className="friday-orb"
            aria-label={`Talk to Friday, ${visible.length} background ${visible.length === 1 ? 'task' : 'tasks'}${attention ? `, ${attention} need attention` : ''}, microphone ${props.micEnabled ? 'on' : 'off'}`}
            aria-expanded={hovered}
            aria-controls={hovered ? 'task-popover' : undefined}
            onClick={props.onTalk}
          >
            {mark}
            <span className={`orb-badge ${attention ? 'attention' : ''}`}>{visible.length}</span>
            <span className={`orb-mic ${props.micEnabled ? 'on' : ''}`} aria-hidden="true">
              {props.micEnabled ? <Mic size={11} /> : <MicOff size={11} />}
            </span>
          </button>
          {hovered && (
            <div className="task-popover" id="task-popover">
              {taskList}
              <footer className="presence-footer">
                <button
                  onClick={props.micEnabled ? props.onMicOff : props.onMicOn}
                  aria-label={props.micEnabled ? 'Turn microphone off' : 'Turn microphone on'}
                >
                  {props.micEnabled ? <Mic size={14} /> : <MicOff size={14} />}Microphone{' '}
                  {props.micEnabled ? 'on' : 'off'}
                </button>
              </footer>
            </div>
          )}
        </section>
      ) : (
        <motion.section
          ref={panelRef}
          className={`friday-presence ${expanded ? 'is-expanded' : ''} ${cameraOn && expanded ? 'is-camera' : ''}`}
          style={
            cameraOn
              ? ({
                  '--camera-max': `${anchor === 'bottom' ? cameraMaxAbove(props.notchOffset?.y) : cameraMax}px`,
                } as CSSProperties)
              : undefined
          }
          aria-label="Friday companion"
          initial={false}
          animate={{ width: resting ? 360 : 500, borderRadius: expanded ? 28 : resting ? 22 : 28 }}
          transition={reducedMotion ? { duration: 0 } : notchSpring}
          onAnimationStart={() => motionStarted('shell')}
          onAnimationComplete={() => motionCompleted('shell')}
        >
          <motion.header
            className="presence-bar"
            initial={false}
            animate={{ height: resting ? 42 : 54 }}
            transition={reducedMotion ? { duration: 0 } : notchSpring}
            onAnimationStart={() => motionStarted('bar')}
            onAnimationComplete={() => motionCompleted('bar')}
          >
            {mark}
            <button
              className="presence-heading"
              onClick={props.onContinue}
              aria-label="Talk to Friday"
              aria-expanded={expanded}
            >
              <strong>Friday</strong>
              <span role="status">
                <motion.span
                  className={`presence-status-copy ${userWords ? 'presence-transcript' : ''}`}
                  // Live words update in place; only a change of kind animates.
                  key={userWords ? 'transcript' : status}
                  aria-label={userWords ? `You said: ${userWords.text}` : undefined}
                  initial={reducedMotion ? false : { opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.18 }}
                >
                  {status}
                </motion.span>
              </span>
            </button>
            {listeningToRequest && !typing && (
              <div className="voice-meter" aria-hidden="true">
                {[0.4, 0.9, 0.6, 1, 0.5].map((scale, i) => (
                  <i key={i} style={{ transform: `scaleY(${0.15 + props.level * scale})` }} />
                ))}
              </div>
            )}
            {visible.length > 0 && (
              <button
                className="task-count"
                aria-label={`Show ${visible.length} background tasks`}
                aria-expanded={expanded}
                onClick={() => {
                  setShowTasks(!showTasks);
                  enter();
                }}
              >
                {visible.length}
                <span> tasks</span>
              </button>
            )}
            <div className="presence-controls">
              <button
                className="presence-action"
                onClick={props.micEnabled ? props.onMicOff : props.onMicOn}
                aria-label={props.micEnabled ? 'Turn microphone off' : 'Turn microphone on'}
                aria-pressed={props.micEnabled}
                title={props.micEnabled ? 'Turn microphone off' : 'Turn microphone on'}
              >
                {props.micEnabled ? <Mic size={14} strokeWidth={1.5} /> : <MicOff size={14} strokeWidth={1.5} />}
              </button>
              {hovered && (
                <button
                  className="presence-action"
                  onClick={props.onDetails}
                  aria-label="Open workspace"
                  title="Open workspace"
                >
                  <Maximize2 size={14} strokeWidth={1.5} />
                </button>
              )}
              {canStop && (
                <button
                  className="presence-action"
                  aria-label="Stop Friday"
                  title="Stop speech and all tasks"
                  onClick={() => {
                    setDismissed(contentKey);
                    props.onStop();
                  }}
                >
                  <CircleStop size={14} strokeWidth={1.5} />
                </button>
              )}
            </div>
          </motion.header>
          <AnimatePresence initial={false}>
            {expanded && (
              <NotchBody
                key="details"
                reducedMotion={reducedMotion}
                onStart={() => motionStarted('body')}
                onComplete={() => motionCompleted('body')}
              >
                {selected && (
                  <div className="task-context">
                    <span>About: {selected.title}</span>
                    <button className="presence-action" aria-label="Clear task context" onClick={props.onClearContext}>
                      <X size={14} />
                    </button>
                  </div>
                )}
                {selected?.question && <p className="selected-question">{selected.question}</p>}
                <CameraStage state={state} closable />
                <div
                  className="presence-content"
                  ref={contentRef}
                  onScroll={(event) => {
                    const el = event.currentTarget;
                    followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
                  }}
                >
                  {!conversation.length && !detail && !approvals.length && !visible.length && (
                    <div className="presence-welcome">
                      <strong>What can I help with?</strong>
                      <p>Ask a question or tell me what you’d like done.</p>
                    </div>
                  )}
                  {props.heard &&
                    listeningToRequest &&
                    (props.heardIgnored ? (
                      <button
                        className="heard-text ignored"
                        title="Friday thought this wasn’t meant for it. Send it anyway."
                        onClick={props.onSendIgnored}
                      >
                        Ignored: “{props.heard}” · Send
                      </button>
                    ) : (
                      <p className="heard-text">{props.heard}</p>
                    ))}
                  <Conversation tasks={conversation} state={state} />
                  {detail &&
                    (props.error ||
                      (task?.error
                        ? !conversation.some((item) => item.id === task.id)
                        : !conversation.some((item) => item.id === state?.presentation.taskId))) && (
                      <div
                        className={`presence-reply presence-markdown ${props.error || task?.error ? 'is-error' : ''}`}
                        role={props.error || task?.error ? 'alert' : undefined}
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail}</ReactMarkdown>
                      </div>
                    )}
                  {approvals.map((item) => (
                    <div className="presence-approval" key={item.id}>
                      <strong>{item.approval!.title}</strong>
                      <p>{item.approval!.message}</p>
                      <button onClick={() => props.onApprove(item.approval!.id, true)}>Allow</button>
                      <button onClick={() => props.onApprove(item.approval!.id, false)}>Decline</button>
                    </div>
                  ))}
                  {visible.length > 0 && !typing && (!selected || showTasks) && taskList}
                </div>
                <footer className="presence-input-row">
                  {typing ? (
                    <form
                      className="presence-composer"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (text.trim()) {
                          props.onSubmit(text);
                          setTyping(false);
                        }
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="Ask Friday"
                        placeholder="Type a request…"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                      />
                      <button aria-label="Send request" disabled={!text.trim()}>
                        <ArrowUp size={16} />
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className={`presence-composer is-idle${text ? ' has-draft' : ''}`}
                      onClick={() => setTyping(true)}
                    >
                      {text || 'Type a message…'}
                    </button>
                  )}
                  {!cameraOn && (
                    <button
                      className="presence-action"
                      onClick={collapse}
                      aria-label="Collapse to pill"
                      title="Collapse to pill"
                    >
                      <ChevronUp size={14} />
                    </button>
                  )}
                </footer>
              </NotchBody>
            )}
          </AnimatePresence>
        </motion.section>
      )}
    </main>
  );
}
