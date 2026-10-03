import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureDebugLog, debugLog, debugUrl } from '../electron/debug-log.js';

describe('debug URL metadata', () => {
  it('omits credentials, paths, query tokens and fragments', () => {
    expect(debugUrl('https://user:secret@example.com/private/token?key=secret#secret')).toBe('https://example.com');
  });
  it('does not echo malformed input', () => {
    expect(debugUrl('secret')).toBe('invalid-url');
  });
});

describe('debug log file', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('never throws when the debug directory cannot be created', () => {
    vi.stubEnv('LINUX_BUDDY_DEBUG', '1');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const blocker = join(mkdtempSync(join(tmpdir(), 'friday-debug-')), 'debug');
    writeFileSync(blocker, '');
    expect(() => configureDebugLog(join(blocker, 'friday.jsonl'))).not.toThrow();
  });

  it('appends JSONL records to the configured file', () => {
    vi.stubEnv('LINUX_BUDDY_DEBUG', '1');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = join(mkdtempSync(join(tmpdir(), 'friday-debug-')), 'debug', 'friday.jsonl');
    configureDebugLog(file);
    debugLog('TEST', 'event', { value: 1 });
    const records = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ area: 'TEST', event: 'event', value: 1 });
  });
});
