import { mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

type Fields = Record<string, string | number | boolean | undefined>;
let destination: number | undefined;
let sequence = 0;
export function debugEnabled() {
  return process.env.LINUX_BUDDY_DEBUG === '1';
}

export function debugId() {
  return `r${++sequence}`;
}

/** Never log URL credentials, query strings, fragments, headers or payloads. */
export function debugUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'invalid-url';
  }
}

export function configureDebugLog(path: string) {
  if (!debugEnabled()) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    destination = openSync(path, 'a', 0o600);
  } catch (error) {
    // Diagnostics must never break the app; fall back to stdout only.
    debugLog('APP', 'debug file unavailable', { error: error instanceof Error ? error.name : 'UnknownError' });
    return;
  }
  debugLog('APP', 'debug enabled', { pid: process.pid, file: path });
}

/** Fields must be explicit safe metadata, never user content or arbitrary objects. */
export function debugLog(area: string, event: string, fields: Fields = {}) {
  if (!debugEnabled()) return;
  const record = { time: new Date().toISOString(), area, event, ...fields };
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  console.log(`[FRIDAY] ${record.time} ${area.padEnd(8)} ${event} ${detail}`);
  // Synchronous so the last records before a crash or exit still reach the file.
  if (destination !== undefined) {
    try {
      writeSync(destination, `${JSON.stringify(record)}\n`);
    } catch {
      // Diagnostics must never break the app.
    }
  }
}

export function installDebugFetch() {
  if (!debugEnabled()) return;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const id = debugId();
    const started = Date.now();
    const url = debugUrl(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    debugLog('NETWORK', 'request', { id, url, method, transport: 'node-fetch' });
    try {
      const response = await original(input, init);
      debugLog('NETWORK', 'response headers', { id, status: response.status, ms: Date.now() - started });
      return response;
    } catch (error) {
      debugLog('NETWORK', 'failed', {
        id,
        ms: Date.now() - started,
        error: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  };
}
