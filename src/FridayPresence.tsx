import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Keyboard,
  LoaderCircle,
  Mic,
  Settings,
  X,
} from 'lucide-react';
import {
  activeStatuses,
  type FridayState,
  type ListeningState,
  type SurfaceLayout,
  type TaskRecord,
} from '../electron/types';
import './presence.css';

interface Props {
  state?: FridayState;
  task?: TaskRecord;
  tasks: TaskRecord[];
  listening: ListeningState;
  speaking: boolean;
  level: number;
  heard: string;
  error?: string;
  onTalk(): void;
  onStop(): void;
  onDismiss(): void;
  onSubmit(text: string): void;
  onDetails(): void;
  onStopChild(id: string): void;
  onApprove(id: string, approved: boolean): void;
}

export function FridayPresence(props: Props) {
  const { state, task, listening, speaking } = props;
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [dismissed, setDismissed] = useState<string>();
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelRef = useRef<HTMLElement>(null);
  const busy = task && activeStatuses.has(task.status);
  const listeningToRequest = listening === 'armed' || listening === 'transcribing';
  const active = Boolean(busy || speaking || listeningToRequest || typing);
  const children = (state?.sessions ?? [])
    .filter((session) => session.role === 'child')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const running = children.filter((session) => session.status === 'running');
  const attention = children.filter((session) =>
    ['completed', 'failed', 'needs_input', 'interrupted'].includes(session.status),
  );
  const detail = props.error || task?.error || state?.presentation.text || '';
  const contentKey = `${state?.presentation.taskId ?? ''}:${detail}`;
  const agentExpanded = state?.presentation.expanded && dismissed !== contentKey;
  const expanded =
    pinned ||
    typing ||
    agentExpanded ||
    hovered ||
    (Boolean(props.error || task?.error || task?.approval) && dismissed !== contentKey);
  const surface: SurfaceLayout = expanded ? 'panel' : active ? 'bar' : 'orb';
  const status = speaking
    ? 'Speaking'
    : listening === 'transcribing'
      ? 'Listening · finishing your words'
      : listening === 'armed'
        ? 'Listening to you'
        : busy
          ? task?.steps.at(-1)?.title || 'Thinking'
          : running.length
            ? `${running.length} working in background`
            : attention.length
              ? 'An update is ready'
              : listening === 'listening'
                ? 'Listening for Friday'
                : 'Ready when you are';

  useEffect(() => {
    const panel = panelRef.current;
    if (surface !== 'panel' || !panel) {
      void window.buddy.setSurface(surface);
      return;
    }
    const resize = () => {
      void window.buddy.setSurface(surface, panel.getBoundingClientRect().height + 20);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [surface]);
  useEffect(
    () => () => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    },
    [],
  );

  function collapse() {
    setPinned(false);
    setHovered(false);
    setTyping(false);
    setDismissed(contentKey);
    props.onDismiss();
  }
  const mark = (
    <span
      className={`presence-mark ${busy || running.length ? 'working' : ''} ${speaking ? 'speaking' : ''}`}
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
    </span>
  );

  if (surface === 'orb')
    return (
      <main className="presence-root orb-root" data-surface="orb">
        <button
          className="friday-orb"
          aria-label="Talk to Friday"
          title={`${status}. Click to talk.`}
          onClick={props.onTalk}
        >
          {mark}
          {(running.length > 0 || attention.length > 0) && (
            <span className={`orb-badge ${attention.length ? 'ready' : ''}`}>
              {running.length || <Check size={11} />}
            </span>
          )}
          {listening === 'listening' && <span className="orb-listening" />}
        </button>
        <button
          className="orb-details"
          aria-label="Show Friday updates"
          title="Show updates and text input"
          onClick={() => setPinned(true)}
        >
          <ChevronDown size={12} />
        </button>
      </main>
    );

  return (
    <main
      className={`presence-root ${expanded ? 'panel-root' : 'bar-root'}`}
      data-surface={surface}
      onMouseEnter={() => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current);
        if (detail || children.length) setHovered(true);
      }}
      onMouseLeave={() => {
        leaveTimer.current = setTimeout(() => setHovered(false), 450);
      }}
    >
      <section ref={panelRef} className="friday-presence" aria-label="Friday companion">
        <header className="presence-bar">
          {mark}
          <div className="presence-heading">
            <strong>Friday</strong>
            <span role="status">{status}</span>
          </div>
          {listeningToRequest && (
            <div className="voice-meter" aria-hidden="true">
              {[0.4, 0.9, 0.6, 1, 0.5].map((scale, i) => (
                <i key={i} style={{ transform: `scaleY(${0.25 + props.level * scale})` }} />
              ))}
            </div>
          )}
          <button
            className={`presence-action ${listeningToRequest ? 'lit' : ''}`}
            aria-label="Talk to Friday"
            title="Talk or interrupt"
            onClick={props.onTalk}
          >
            <Mic size={17} />
          </button>
          {(busy || speaking || listeningToRequest) && (
            <button
              className="presence-action"
              aria-label="Stop foreground"
              title="Stop this interaction; background work continues"
              onClick={props.onStop}
            >
              <CircleStop size={17} />
            </button>
          )}
          <button
            className="presence-action"
            aria-label={expanded ? 'Collapse Friday' : 'Expand Friday'}
            onClick={() => (expanded ? collapse() : setPinned(true))}
          >
            {expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
          </button>
        </header>
        {expanded && (
          <div className="presence-body">
            {props.heard && listeningToRequest && <p className="heard-text">{props.heard}</p>}
            {detail ? (
              <p
                className={`presence-reply ${props.error || task?.error ? 'is-error' : ''}`}
                role={props.error || task?.error ? 'alert' : undefined}
              >
                {detail}
              </p>
            ) : (
              <p className="presence-hint">
                Tell me what you need. I can guide you here or keep working in the background.
              </p>
            )}
            {props.tasks
              .filter((item) => item.approval)
              .map((item) => (
                <div className="presence-approval" key={item.id}>
                  <strong>{item.approval!.title}</strong>
                  <p>{item.approval!.message}</p>
                  <button onClick={() => props.onApprove(item.approval!.id, true)}>Allow</button>
                  <button onClick={() => props.onApprove(item.approval!.id, false)}>Decline</button>
                </div>
              ))}
            {children.length > 0 && (
              <section className="background-list" aria-label="Background tasks">
                <h2>
                  In the background <span>{running.length} active</span>
                </h2>
                {children.slice(0, 8).map((session) => (
                  <div className="background-task" key={session.id}>
                    <span className={`task-dot ${session.status}`}>
                      {session.status === 'running' ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : session.status === 'completed' ? (
                        <Check size={14} />
                      ) : (
                        <span />
                      )}
                    </span>
                    <button
                      className="background-task-copy"
                      onClick={() =>
                        props.onSubmit(
                          `Check background task ${session.id} (${session.title}) and tell me its result or what it needs.`,
                        )
                      }
                    >
                      <strong>{session.title}</strong>
                      <small>
                        {session.question ||
                          (session.status === 'running'
                            ? session.summary || 'Working independently'
                            : session.status.replaceAll('_', ' '))}
                      </small>
                    </button>
                    {['running', 'needs_input'].includes(session.status) && (
                      <button
                        className="presence-action"
                        aria-label={`Stop ${session.title}`}
                        onClick={() => props.onStopChild(session.id)}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </section>
            )}
            {typing && (
              <form
                className="presence-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (text.trim()) {
                    props.onSubmit(text);
                    setText('');
                    setTyping(false);
                  }
                }}
              >
                <input
                  autoFocus
                  aria-label="Ask Friday"
                  placeholder="Type a request…"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
                <button aria-label="Send request" disabled={!text.trim()}>
                  <ArrowUp size={16} />
                </button>
              </form>
            )}
            <footer className="presence-footer">
              <button onClick={() => setTyping(!typing)}>
                <Keyboard size={14} /> Type instead
              </button>
              <button onClick={props.onDetails} aria-label="Open settings and history">
                <Settings size={14} /> Settings & history
              </button>
            </footer>
          </div>
        )}
      </section>
    </main>
  );
}
