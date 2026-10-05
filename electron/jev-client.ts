const endpoint = 'https://api.typesafe.ai/v1/systemone';
const maxResponseBytes = 16_384;
const maxField = 500;

/** What Friday was doing when the user's speech arrived. */
export interface TurnInput {
  /** Recognized speech, not addressed to Friday by the wake phrase. */
  heard: string;
  /** The request Friday is working on, if any. */
  task?: string;
  speaking: boolean;
  /** Friday's most recent spoken words. */
  lastSaid?: string;
}

export interface TurnDecision {
  interrupt: boolean;
  confidence: number;
  ms: number;
}

export interface JevOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** An ignore verdict below this confidence still lets the speech through. */
  minConfidence?: number;
  // Main-process only; never exposed over IPC.
  fetch?: typeof fetch;
}

const clip = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, maxField) : '');

export function validTurn(value: unknown): TurnInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid turn.');
  const input = value as Record<string, unknown>;
  const heard = clip(input.heard);
  if (!heard) throw new Error('Invalid turn.');
  return {
    heard,
    task: clip(input.task) || undefined,
    speaking: input.speaking === true,
    lastSaid: clip(input.lastSaid) || undefined,
  };
}

/**
 * TypeSafe's Jev decision model judges speech heard while Friday is busy: is the user talking to
 * Friday (a new request, correction or stop), or is it someone else, media, filler or a
 * mis-transcription that should not cancel the current work? Returns undefined when Jev cannot
 * answer, so the caller keeps its default behaviour.
 */
export class JevClient {
  readonly model: string;
  constructor(private readonly options: JevOptions) {
    this.model = options.model?.trim() || 'jev-latest';
  }

  async decide(turn: TurnInput): Promise<TurnDecision | undefined> {
    const started = Date.now();
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 1500);
    try {
      const response = await (this.options.fetch ?? fetch)(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          state: {
            assistant:
              "Friday, a voice assistant on the user's computer. Its microphone stays on while it works, so it also hears background speech, other people, media, and speech-to-text errors.",
            current_task: turn.task ?? 'none',
            friday_speaking: turn.speaking,
            friday_last_said: turn.lastSaid ?? '',
            heard: turn.heard,
          },
          questions: {
            turn: {
              type: 'choice',
              instructions:
                'Friday is busy with current_task. Decide whether `heard` is the user speaking to Friday, which interrupts its current work, or should be ignored. The user may switch to an unrelated request at any time and may mix Hindi and English. Missing a real request is worse than a needless interruption.',
              criteria: {
                interrupt:
                  'Plausibly said to an assistant: any command, request or question (related to current_task or not), a correction, refinement or detail for the task, or asking Friday to stop, wait, repeat, skip or slow down.',
                ignore:
                  'Clearly not meant for Friday: talking to someone else by name or on the phone, a meeting, TV, video or background audio, another assistant, filler or backchannel ("okay", "hmm", "thank you"), a remark to oneself, or garbled speech-to-text.',
              },
            },
          },
        }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return undefined;
      }
      const raw = await response.text();
      if (raw.length > maxResponseBytes) return undefined;
      const answer = (JSON.parse(raw) as { answers?: { turn?: { choice?: unknown; confidence?: unknown } } }).answers
        ?.turn;
      const confidence = typeof answer?.confidence === 'number' ? answer.confidence : 0;
      if (answer?.choice !== 'interrupt' && answer?.choice !== 'ignore') return undefined;
      const ignore = answer.choice === 'ignore' && confidence >= (this.options.minConfidence ?? 0.6);
      return { interrupt: !ignore, confidence, ms: Date.now() - started };
    } catch {
      return undefined;
    }
  }
}
