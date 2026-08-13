import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  CircleStop,
  Clock3,
  LoaderCircle,
  Mic,
  MicOff,
  Minus,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';
import type { BuddySettings, ListeningState, TaskRecord } from '../electron/types';

const activeStatuses = new Set(['queued', 'thinking', 'acting', 'awaiting_approval']);

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function statusCopy(state: ListeningState, wakeWord: string) {
  if (state === 'listening') return `Listening for “${wakeWord}”`;
  if (state === 'armed') return 'I’m listening — what should I do?';
  if (state === 'transcribing') return 'Understanding you…';
  if (state === 'error') return 'Voice input unavailable';
  return `Say “${wakeWord}” after opening Friday`;
}

export default function App() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selected, setSelected] = useState<string>();
  const [settings, setSettings] = useState<BuddySettings>();
  const [prompt, setPrompt] = useState('');
  const [listenState, setListenState] = useState<ListeningState>('idle');
  const [heard, setHeard] = useState('');
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showActivity, setShowActivity] = useState(true);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const streamRef = useRef<MediaStream | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const animationRef = useRef<number | undefined>(undefined);
  const generationRef = useRef(0);
  const beginSegmentRef = useRef<
    ((stream: MediaStream, analyser: AnalyserNode, generation: number) => void) | undefined
  >(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  const task = useMemo(() => tasks.find((item) => item.id === selected) ?? tasks[0], [selected, tasks]);
  const wakeWord = settings?.wakeWord || 'Friday';
  const running = task ? activeStatuses.has(task.status) : false;

  const updateListening = useCallback((state: ListeningState) => {
    setListenState(state);
    window.buddy.listening(state);
  }, []);

  const stopListening = useCallback(() => {
    generationRef.current += 1;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();
    recorderRef.current = undefined;
    streamRef.current = undefined;
    audioContextRef.current = undefined;
    setVoiceLevel(0);
    updateListening('idle');
  }, [updateListening]);

  const beginSegment = useCallback(
    (stream: MediaStream, analyser: AnalyserNode, generation: number) => {
      if (generation !== generationRef.current || !stream.active) return;
      const chunks: Blob[] = [];
      const supported = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(stream, supported ? { mimeType: supported } : undefined);
      recorderRef.current = recorder;
      let hasSpeech = false;
      let silenceStarted = 0;
      const startedAt = performance.now();
      const samples = new Uint8Array(analyser.fftSize);
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        if (generation !== generationRef.current || !stream.active) return;
        if (!hasSpeech) {
          beginSegmentRef.current?.(stream, analyser, generation);
          return;
        }
        updateListening('transcribing');
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const result = await window.buddy.transcribe(await blob.arrayBuffer(), blob.type);
          if (generation !== generationRef.current) return;
          if (result.text) setHeard(result.text);
          if (result.command) {
            stopListening();
            setPrompt('');
            setSubmitting(true);
            try {
              const created = await window.buddy.submit(result.command);
              setSelected(created.id);
              setShowActivity(true);
            } catch (error) {
              setActionError(errorMessage(error, 'Friday could not start that task.'));
            } finally {
              setSubmitting(false);
            }
            return;
          }
          updateListening(result.wakeDetected ? 'armed' : 'listening');
          beginSegmentRef.current?.(stream, analyser, generation);
        } catch (error) {
          setActionError(errorMessage(error, 'Local speech transcription failed.'));
          updateListening('error');
        }
      };
      recorder.start(250);
      const monitor = () => {
        if (generation !== generationRef.current || recorder.state !== 'recording') return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) {
          const normalized = (value - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / samples.length);
        setVoiceLevel(Math.min(1, rms * 9));
        const now = performance.now();
        if (rms > 0.025) {
          hasSpeech = true;
          silenceStarted = 0;
        } else if (hasSpeech) {
          if (!silenceStarted) silenceStarted = now;
          if (now - silenceStarted > 850) {
            recorder.stop();
            return;
          }
        } else if (now - startedAt > 10_000) {
          recorder.stop();
          return;
        }
        if (now - startedAt > 25_000) {
          recorder.stop();
          return;
        }
        animationRef.current = requestAnimationFrame(monitor);
      };
      animationRef.current = requestAnimationFrame(monitor);
    },
    [stopListening, updateListening],
  );

  useEffect(() => {
    beginSegmentRef.current = beginSegment;
  }, [beginSegment]);

  const startListening = useCallback(async () => {
    if (streamRef.current?.active) return;
    setActionError(undefined);
    setHeard('');
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      if (generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.72;
      context.createMediaStreamSource(stream).connect(analyser);
      streamRef.current = stream;
      audioContextRef.current = context;
      updateListening('listening');
      beginSegment(stream, analyser, generation);
    } catch (error) {
      setActionError(errorMessage(error, 'Allow microphone access to talk to Friday.'));
      updateListening('error');
    }
  }, [beginSegment, updateListening]);

  useEffect(() => {
    let disposed = false;
    void Promise.all([window.buddy.listTasks(), window.buddy.getSettings()])
      .then(([history, config]) => {
        if (disposed) return;
        setTasks(history);
        setSettings(config);
        setSelected(history[0]?.id);
      })
      .catch((error) => setActionError(errorMessage(error, 'Friday could not load.')))
      .finally(() => setLoading(false));
    const removeTask = window.buddy.onTask((next) => {
      setTasks((current) =>
        [next, ...current.filter((item) => item.id !== next.id)].sort((a, b) => b.createdAt - a.createdAt),
      );
      setSelected((current) => current || next.id);
    });
    const removeListen = window.buddy.onListen(() => void startListening());
    return () => {
      disposed = true;
      removeTask();
      removeListen();
      stopListening();
    };
  }, [startListening, stopListening]);

  useEffect(() => {
    if (!conversationRef.current) return;
    conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, [task?.response, task?.steps.length, task?.status]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showSettings) setShowSettings(false);
      else if (listenState !== 'idle') stopListening();
      else void window.buddy.hide();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [listenState, showSettings, stopListening]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || submitting) return;
    stopListening();
    setSubmitting(true);
    setActionError(undefined);
    setPrompt('');
    try {
      const created = await window.buddy.submit(value);
      setSelected(created.id);
      setShowActivity(true);
    } catch (error) {
      setPrompt(value);
      setActionError(errorMessage(error, 'Friday could not start that task.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function saveSettings(next: Partial<BuddySettings>) {
    if (!settings) return;
    const value = { ...settings, ...next };
    setSettings(value);
    try {
      await window.buddy.updateSettings(next);
    } catch (error) {
      setActionError(errorMessage(error, 'Settings could not be saved.'));
    }
  }

  return (
    <main className="shell">
      <section className="friday" aria-label="Friday desktop agent">
        <header className="titlebar">
          <button
            className="brand"
            type="button"
            onClick={() => setShowHistory((value) => !value)}
            aria-expanded={showHistory}
          >
            <span className="brand-glyph">
              <Sparkles size={14} />
            </span>
            <span>Friday</span>
            <ChevronDown size={13} className={showHistory ? 'rotated' : ''} />
          </button>
          <div className="title-actions">
            <span className={`connection ${listenState !== 'idle' ? 'live' : ''}`}>
              {listenState !== 'idle' ? 'Mic on' : 'Ready'}
            </span>
            <button className="icon-button" type="button" aria-label="Settings" onClick={() => setShowSettings(true)}>
              <Settings size={16} />
            </button>
            <button className="icon-button" type="button" aria-label="Hide Friday" onClick={() => window.buddy.hide()}>
              <Minus size={17} />
            </button>
          </div>
        </header>

        {showHistory && (
          <aside className="history-popover">
            <div className="popover-label">Recent tasks</div>
            {tasks.length ? (
              tasks.slice(0, 8).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === task?.id ? 'history-item selected' : 'history-item'}
                  onClick={() => {
                    setSelected(item.id);
                    setShowHistory(false);
                  }}
                >
                  <span>{item.prompt}</span>
                  <small>{item.status.replace('_', ' ')}</small>
                </button>
              ))
            ) : (
              <p className="empty-history">Your completed work will appear here.</p>
            )}
          </aside>
        )}

        {showSettings && settings && (
          <aside className="settings-panel" role="dialog" aria-label="Friday settings">
            <div className="panel-heading">
              <div>
                <strong>Settings</strong>
                <small>Kept on this device</small>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close settings"
                onClick={() => setShowSettings(false)}
              >
                <X size={15} />
              </button>
            </div>
            <label>
              Wake word
              <input
                value={settings.wakeWord}
                onChange={(event) => setSettings({ ...settings, wakeWord: event.target.value })}
                onBlur={(event) => void saveSettings({ wakeWord: event.target.value || 'Friday' })}
              />
            </label>
            <label>
              Working folder
              <input
                value={settings.defaultCwd}
                onChange={(event) => setSettings({ ...settings, defaultCwd: event.target.value })}
                onBlur={(event) => void saveSettings({ defaultCwd: event.target.value })}
              />
            </label>
            <label>
              OpenCode Go model
              <select value={settings.model} onChange={(event) => void saveSettings({ model: event.target.value })}>
                <option value="kimi-k2.6">Kimi K2.6</option>
                <option value="kimi-k2.7-code">Kimi K2.7 Code</option>
                <option value="glm-5.2">GLM 5.2</option>
                <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
              </select>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.launchAtLogin}
                onChange={(event) => void saveSettings({ launchAtLogin: event.target.checked })}
              />
              <span>
                <strong>Launch at login</strong>
                <small>Keep Friday one shortcut away.</small>
              </span>
            </label>
          </aside>
        )}

        <div className="conversation" ref={conversationRef}>
          {!task && !loading ? (
            <section className="welcome">
              <div
                className={`voice-orb ${listenState}`}
                style={{ '--voice-level': voiceLevel } as React.CSSProperties}
              >
                <div className="orb-core">
                  <Mic size={24} />
                </div>
                <i />
                <i />
                <i />
              </div>
              <h1>{listenState === 'armed' ? 'Yes?' : 'Ready when you are'}</h1>
              <p>{statusCopy(listenState, wakeWord)}</p>
              {heard && <blockquote>“{heard}”</blockquote>}
              <button
                className="listen-button"
                type="button"
                onClick={() =>
                  listenState === 'idle' || listenState === 'error' ? void startListening() : stopListening()
                }
              >
                {listenState === 'idle' || listenState === 'error' ? (
                  <>
                    <Mic size={16} /> Start listening
                  </>
                ) : (
                  <>
                    <MicOff size={16} /> Stop listening
                  </>
                )}
              </button>
              <span className="privacy-note">Canary transcription stays on this computer</span>
            </section>
          ) : task ? (
            <div className="thread">
              <div className="user-message">
                <span>You</span>
                <p>{task.prompt}</p>
              </div>
              <div className="assistant-message">
                <div className="assistant-name">
                  <span className="mini-glyph">
                    <Sparkles size={11} />
                  </span>
                  Friday
                </div>
                {task.response ? (
                  <p>{task.response}</p>
                ) : task.status === 'failed' ? null : (
                  <div className="thinking">
                    <LoaderCircle className="spin" size={15} />
                    Thinking through the task…
                  </div>
                )}
              </div>

              {task.steps.length > 0 && (
                <section className="activity-card">
                  <button
                    type="button"
                    className="activity-heading"
                    onClick={() => setShowActivity((value) => !value)}
                    aria-expanded={showActivity}
                  >
                    <span>
                      {task.status === 'completed' ? (
                        <Check size={14} />
                      ) : task.status === 'failed' ? (
                        <X size={14} />
                      ) : (
                        <LoaderCircle className="spin" size={14} />
                      )}{' '}
                      {task.status === 'completed'
                        ? 'Completed'
                        : task.status === 'failed'
                          ? 'Stopped with an issue'
                          : 'Working on your computer'}
                    </span>
                    <ChevronDown size={14} className={showActivity ? 'rotated' : ''} />
                  </button>
                  {showActivity && (
                    <div className="steps">
                      {task.steps.map((step) => (
                        <div className={`step ${step.status}`} key={step.id}>
                          <span>
                            {step.status === 'running' ? (
                              <LoaderCircle className="spin" size={12} />
                            ) : step.status === 'failed' ? (
                              <X size={12} />
                            ) : (
                              <Check size={12} />
                            )}
                          </span>
                          <p>{step.title}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {task.approval && (
                <section className="approval-card">
                  <div className="approval-icon">
                    <ShieldAlert size={19} />
                  </div>
                  <div>
                    <strong>{task.approval.title}</strong>
                    <p>{task.approval.message}</p>
                    <div className="approval-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void window.buddy.approve(task.approval!.id, false)}
                      >
                        Don’t allow
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => void window.buddy.approve(task.approval!.id, true)}
                      >
                        Allow once
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {task.error && (
                <div className="error-card">
                  <X size={15} />
                  <div>
                    <strong>Friday couldn’t finish</strong>
                    <p>{task.error}</p>
                  </div>
                </div>
              )}
              {task.status === 'cancelled' && (
                <div className="stopped-note">
                  <CircleStop size={14} /> Task stopped
                </div>
              )}
            </div>
          ) : (
            <div className="loading">
              <LoaderCircle className="spin" />
              Loading Friday…
            </div>
          )}
        </div>

        {actionError && (
          <div className="action-error" role="alert">
            {actionError}
            <button type="button" onClick={() => setActionError(undefined)}>
              <X size={13} />
            </button>
          </div>
        )}

        <footer className="composer-area">
          {listenState !== 'idle' && !running && (
            <div className="listening-strip">
              <span className="listening-dot" />
              <span>{statusCopy(listenState, wakeWord)}</span>
              {heard && <em>“{heard}”</em>}
            </div>
          )}
          <form className="composer" onSubmit={submit}>
            <textarea
              ref={inputRef}
              rows={1}
              value={prompt}
              placeholder={running ? 'Add another request…' : 'Ask Friday to do something…'}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              className={`mic-button ${listenState !== 'idle' ? 'active' : ''}`}
              type="button"
              aria-label={listenState === 'idle' ? 'Start listening' : 'Stop listening'}
              onClick={() =>
                listenState === 'idle' || listenState === 'error' ? void startListening() : stopListening()
              }
            >
              {listenState === 'idle' || listenState === 'error' ? <Mic size={18} /> : <MicOff size={18} />}
            </button>
            {running ? (
              <button className="stop-button" type="button" onClick={() => task && void window.buddy.cancel(task.id)}>
                <CircleStop size={16} /> Stop
              </button>
            ) : (
              <button
                className="send-button"
                type="submit"
                disabled={!prompt.trim() || submitting}
                aria-label="Send request"
              >
                <Send size={17} />
              </button>
            )}
          </form>
          <div className="footer-meta">
            <span>
              <Clock3 size={11} /> Ctrl ⇧ Space
            </span>
            <span>Local voice • Pi agent</span>
          </div>
        </footer>
      </section>
    </main>
  );
}
