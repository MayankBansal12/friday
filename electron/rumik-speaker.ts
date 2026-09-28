import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import WebSocket from 'ws';
import { validateSpeech, speechRecovery } from './speech-policy.js';

const endpoint = 'https://silk-api.rumik.ai/v1/tts/ws-connect';
const maxAudioBytes = 24_000 * 2 * 45;
const voices = new Set([
  'emma',
  'mia',
  'sophia',
  'ava',
  'ira',
  'siya',
  'aisha',
  'zoya',
  'lucas',
  'noah',
  'theo',
  'adam',
]);
export type SpeechStage =
  | 'sessionHeaders'
  | 'sessionReady'
  | 'socketOpen'
  | 'socketReused'
  | 'firstPcm'
  | 'playerWrite'
  | 'synthesisDone'
  | 'playerDrained'
  | 'cancelled';
export interface RumikOptions {
  apiKey: string;
  speaker?: string;
  description?: string;
  // Dependency/measurement hooks are main-process only; never exposed over IPC.
  fetch?: typeof fetch;
  connect?: (url: string) => WebSocket;
  spawn?: typeof spawn;
  observe?: (stage: SpeechStage, elapsedMs: number) => void;
  audio?: (pcm: Buffer) => void;
  idleMs?: number;
  totalMs?: number;
  connectionIdleMs?: number;
}
class SpeechError extends Error {}
const fail = (message: string) => new SpeechError(message);
function httpError(status: number) {
  if (status === 401) return fail('Voice authentication failed. Check the Rumik key.');
  if (status === 403) return fail('Voice access denied. Enable the Rumik streaming scope.');
  if (status === 429) return fail('Voice service is busy. Try again shortly.');
  if (status >= 500) return fail('Voice service is unavailable. Try again shortly.');
  return fail('Voice request was rejected. Check the Rumik configuration.');
}

interface Transport {
  socket: WebSocket;
  healthy: boolean;
  open: boolean;
  idle?: ReturnType<typeof setTimeout>;
  message?: (data: WebSocket.RawData, binary: boolean) => void;
  fault?: (error: Error) => void;
}

export class RumikSpeaker {
  private transport?: Transport;
  private disposed = false;
  private retire(transport: Transport) {
    if (!transport.healthy) return;
    transport.healthy = false;
    clearTimeout(transport.idle);
    transport.message = undefined;
    transport.fault = undefined;
    if (this.transport === transport) this.transport = undefined;
    transport.socket.terminate();
  }
  dispose() {
    this.disposed = true;
    this.stop();
    if (this.transport) this.retire(this.transport);
  }
  private cancel?: () => void;
  constructor(private readonly options: RumikOptions) {}
  stop() {
    this.cancel?.();
  }
  speak(text: string): Promise<void> {
    const decision = validateSpeech(text);
    if (!decision.ok) return Promise.reject(new Error(`${decision.reason} ${speechRecovery}`));
    const voice = this.options.speaker?.trim() || 'ira';
    const description =
      this.options.description?.trim() || 'A warm female voice with an Indian accent and conversational pacing.';
    if (!this.options.apiKey || !voices.has(voice) || !description.trim() || description.length > 500)
      return Promise.reject(fail('Voice is not configured. Check the Rumik key and voice settings.'));
    if (this.disposed) return Promise.reject(fail('Voice output is closed.'));
    this.stop();
    const started = performance.now();
    const mark = (stage: SpeechStage) => this.options.observe?.(stage, performance.now() - started);
    const abort = new AbortController();
    let socket: WebSocket | undefined;
    let transport: Transport | undefined;
    let sent = false;
    let player: ChildProcessWithoutNullStreams | undefined;
    let idle: ReturnType<typeof setTimeout>;
    let reap: ReturnType<typeof setTimeout> | undefined;
    let ended = false,
      settled = false,
      done = false,
      bytes = 0;
    let tail = Buffer.alloc(0);
    let prefix = Buffer.alloc(0);
    let formatChecked = false;
    let failure: Error | undefined;
    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        clearTimeout(total);
        clearTimeout(reap);
        if (this.cancel === cancel) this.cancel = undefined;
        if (failure) reject(failure);
        else resolve();
      };
      const finish = (error?: Error, retain = false) => {
        if (ended) return;
        ended = true;
        failure = error;
        clearTimeout(idle);
        clearTimeout(total);
        abort.abort();
        if (transport) {
          if (retain && transport.healthy && !this.disposed) {
            transport.message = undefined;
            transport.fault = undefined;
            const retained = transport;
            retained.idle = setTimeout(() => this.retire(retained), this.options.connectionIdleMs ?? 60_000);
            retained.idle.unref();
          } else this.retire(transport);
        }
        if (player) {
          player.stdin.destroy();
          player.kill('SIGKILL');
          // A missing close is a bounded failure, never a successful drain.
          // The caller may clear speaking and resume capture after this rejection.
          reap = setTimeout(() => {
            failure = fail('Voice output did not stop. Check the audio device.');
            settle();
          }, 1500);
          reap.unref();
        } else settle();
      };
      const cancel = () => {
        mark('cancelled');
        finish();
      };
      this.cancel = cancel;
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => finish(fail('Voice response stalled. Try again.')), this.options.idleMs ?? 10_000);
        idle.unref();
      };
      const total = setTimeout(
        () => finish(fail('Voice response timed out. Try again.')),
        this.options.totalMs ?? 60_000,
      );
      total.unref();
      touch();
      const outputFailure = () => finish(fail('Voice output failed. Check the audio device and pw-cat installation.'));
      const startPlayer = () => {
        const env = { ...process.env };
        delete env.RUMIK_API_KEY;
        player = (this.options.spawn ?? spawn)(
          'pw-cat',
          ['--playback', '--raw', '--rate', '24000', '--channels', '1', '--format', 's16', '--latency', '40ms', '-'],
          { stdio: ['pipe', 'pipe', 'pipe'], env },
        );
        player.stdout.resume();
        player.stderr.resume();
        player.once('error', outputFailure);
        player.stdin.on('error', outputFailure);
        player.stdin.on('drain', () => {
          if (!ended && !done) socket?.resume();
        });
        player.once('close', (code, signal) => {
          player = undefined;
          if (ended) {
            settle();
            return;
          }
          if (code !== 0 || signal || !done) {
            outputFailure();
            return;
          }
          mark('playerDrained');
          finish(undefined, true);
        });
      };
      const run = async () => {
        const response = await (this.options.fetch ?? fetch)(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: abort.signal,
          headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'mulberry', text: decision.text, audio_format: 'pcm' }),
        });
        if (ended) {
          await response.body?.cancel();
          return;
        }
        mark('sessionHeaders');
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw httpError(response.status);
        }
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
          void response.body?.cancel().catch(() => {});
          throw fail('Voice service returned an invalid session.');
        }
        const reader = response.body?.getReader();
        if (!reader) throw fail('Voice service returned an empty session.');
        let size = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const next = await reader.read();
          if (ended) {
            await reader.cancel();
            return;
          }
          if (next.done) break;
          size += next.value.length;
          if (size > 16_384) {
            await reader.cancel();
            throw fail('Voice session exceeded its size limit.');
          }
          chunks.push(next.value);
        }
        const session = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const url = new URL(session.ws_url);
        // Trust only the documented gateway, even if a mint response suggests another host.
        if (
          url.origin !== 'wss://silk-api.rumik.ai' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          typeof session.token !== 'string' ||
          !session.token ||
          session.token.length > 4096
        )
          throw fail('Voice service returned an unsupported streaming address.');
        url.searchParams.set('token', session.token);
        mark('sessionReady');
        if (ended) return;
        socket = (
          this.options.connect ??
          ((address) =>
            new WebSocket(address, {
              followRedirects: false,
              maxPayload: 262_144,
              perMessageDeflate: false,
              handshakeTimeout: 10_000,
            }))
        )(url.href);
        transport = { socket, healthy: true, open: false };
        this.transport = transport;
        const owned = transport;
        const fault = (error: Error) => {
          const notify = owned.fault;
          this.retire(owned);
          notify?.(error);
        };
        socket.on('error', () => fault(fail('Voice connection failed. Check the network and try again.')));
        socket.on('close', () => fault(fail('Voice stream ended early. Try again.')));
        socket.on('message', (data, binary) => {
          if (!owned.healthy) return;
          if (owned.message) owned.message(data, binary);
          else this.retire(owned); // Unsolicited audio/control makes ownership ambiguous.
        });
        socket.once('open', () => {
          if (ended || !owned.healthy) return;
          owned.open = true;
          mark('socketOpen');
          send();
        });
        bind();
      };
      const send = () => {
        if (ended || sent) return;
        sent = true;
        touch();
        try {
          socket!.send(JSON.stringify({ text: decision.text, description, speaker: voice }));
        } catch {
          finish(fail('Voice connection failed. Check the network and try again.'));
        }
      };
      const bind = () => {
        transport!.fault = (error) => {
          // PCM after done belongs to the draining player, independent of transport.
          if (!done) finish(error);
        };
        transport!.message = (data, binary) => {
          if (ended) return;
          if (done) {
            this.retire(transport!);
            return;
          }
          if (!sent) {
            finish(fail('Voice stream was interrupted. Try again.'));
            return;
          }
          try {
            touch();
            let chunk = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
            if (!binary) {
              if (chunk.length > 16_384) throw fail('Voice service returned invalid control data.');
              const frame = JSON.parse(chunk.toString('utf8'));
              if (frame.error) throw fail('Voice synthesis failed. Check service availability and voice settings.');
              if (frame.type !== 'done') throw fail('Voice stream was interrupted. Try again.');
              if (!bytes || tail.length || !formatChecked)
                throw fail('Voice service returned empty or incomplete audio.');
              done = true;
              mark('synthesisDone');
              socket!.resume();
              player!.stdin.end();
              // Allow the already bounded PCM to drain; total deadline still applies.
              clearTimeout(idle);
              return;
            }
            if (!chunk.length) throw fail('Voice service returned empty audio.');
            bytes += chunk.length;
            if (bytes > maxAudioBytes) throw fail('Voice audio exceeded its duration limit.');
            // Inspect the first four bytes even when the transport splits a header.
            // Raw PCM cannot prove codec/sample-rate correctness beyond this contract.
            if (!formatChecked) {
              prefix = Buffer.concat([prefix, chunk]);
              if (prefix.length < 4) return;
              if (/^(RIFF|OggS|ID3|\{)/.test(prefix.subarray(0, 4).toString('ascii')))
                throw fail('Voice service returned the wrong audio format.');
              chunk = prefix;
              prefix = Buffer.alloc(0);
              formatChecked = true;
            }
            const joined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
            const aligned = joined.subarray(0, joined.length - (joined.length % 2));
            tail = Buffer.from(joined.subarray(aligned.length));
            if (!aligned.length) return;
            if (!player) {
              mark('firstPcm');
              startPlayer();
              mark('playerWrite');
            }
            this.options.audio?.(aligned);
            if (player!.stdin.writableLength + aligned.length > 524_288)
              throw fail('Voice playback could not keep up. Check the audio device.');
            if (!player!.stdin.write(aligned)) socket!.pause();
          } catch (error) {
            finish(error instanceof SpeechError ? error : fail('Voice service returned malformed audio data.'));
          }
        };
      };
      const acquire = async () => {
        const available = this.transport;
        if (available?.healthy && available.open) {
          transport = available;
          socket = available.socket;
          clearTimeout(available.idle);
          bind();
          mark('socketReused');
          send();
        } else await run();
      };
      void acquire().catch((error) => {
        if (!ended)
          finish(
            error instanceof SpeechError ? error : fail('Voice connection failed. Check the network and try again.'),
          );
      });
    });
  }
}
