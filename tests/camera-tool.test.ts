import { afterEach, describe, expect, it, vi } from 'vitest';
import fridayExtension from '../electron/friday-extension.js';

type Tool = Parameters<Parameters<typeof fridayExtension>[0]['registerTool']>[0];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('camera image delivery', () => {
  it('returns an image block to the model and keeps pixels out of metadata', async () => {
    vi.stubEnv('LINUX_BUDDY_ROLE', 'parent');
    vi.stubEnv('LINUX_BUDDY_RUNTIME_URL', 'http://127.0.0.1:9999');
    vi.stubEnv('LINUX_BUDDY_RUNTIME_TOKEN', 'test-token');
    const fetchMock = vi.fn(async () => Response.json({ data: '/9j/2Q==', mimeType: 'image/jpeg', capturedAt: 1000 }));
    vi.stubGlobal('fetch', fetchMock);
    const tools: Tool[] = [];
    fridayExtension({
      on() {},
      registerTool(tool) {
        tools.push(tool);
      },
    });
    const abort = new AbortController();
    const result = await tools
      .find((tool) => tool.name === 'camera_snapshot')!
      .execute('capture', {}, abort.signal, undefined, { ui: { confirm: async () => false } });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/tools/camera_snapshot',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(result.content).toContainEqual({ type: 'image', data: '/9j/2Q==', mimeType: 'image/jpeg' });
    expect(result.content[0].text).toContain('camera is now closed');
    expect(result.details).not.toHaveProperty('data');
  });
});
