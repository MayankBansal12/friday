import { afterEach, describe, expect, it, vi } from 'vitest';
import fridayExtension from '../electron/friday-extension.js';
import { cameraActivityLine } from '../electron/types.js';

type Tool = Parameters<Parameters<typeof fridayExtension>[0]['registerTool']>[0];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('camera image delivery', () => {
  it('returns every watched frame as an image block and keeps pixels out of metadata', async () => {
    vi.stubEnv('LINUX_BUDDY_ROLE', 'parent');
    vi.stubEnv('LINUX_BUDDY_RUNTIME_URL', 'http://127.0.0.1:9999');
    vi.stubEnv('LINUX_BUDDY_RUNTIME_TOKEN', 'test-token');
    const frames = [
      { data: '/9j/AQ==', capturedAt: 1000 },
      { data: '/9j/Ag==', capturedAt: 3000 },
    ];
    const fetchMock = vi.fn(async () => Response.json({ frames, mimeType: 'image/jpeg' }));
    vi.stubGlobal('fetch', fetchMock);
    const tools: Tool[] = [];
    fridayExtension({
      on() {},
      registerTool(tool) {
        tools.push(tool);
      },
    });
    const result = await tools
      .find((tool) => tool.name === 'camera_look')!
      .execute('look', { seconds: 2 }, new AbortController().signal, undefined, {
        ui: { confirm: async () => false },
      });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/tools/camera_look',
      expect.objectContaining({ method: 'POST', body: '{"seconds":2}' }),
    );
    expect(result.content.slice(1)).toEqual(
      frames.map((frame) => ({ type: 'image', data: frame.data, mimeType: 'image/jpeg' })),
    );
    expect(result.content[0].text).toMatch(/2 live webcam frames, oldest first, over 2\.0s/);
    expect(JSON.stringify(result.details)).not.toContain('/9j/');
    expect(tools.some((tool) => tool.name === 'camera_off')).toBe(true);
  });
});

describe('camera narration', () => {
  it('narrates starting, looking, watching, a recent look, and closing', () => {
    expect(cameraActivityLine({ camera: 'opening' }, 0)).toBe('Starting your camera to see…');
    expect(cameraActivityLine({ camera: 'live', cameraActivity: { kind: 'looking', at: 0 } }, 0)).toBe(
      'Looking through your camera…',
    );
    expect(cameraActivityLine({ camera: 'live', cameraActivity: { kind: 'watching', seconds: 5, at: 0 } }, 0)).toBe(
      'Watching for 5s…',
    );
    const looked = { camera: 'live' as const, cameraActivity: { kind: 'looked' as const, frames: 1, at: 1000 } };
    expect(cameraActivityLine(looked, 2000)).toBe('Looked through your camera');
    expect(cameraActivityLine(looked, 7000)).toBeUndefined();
    expect(cameraActivityLine({ camera: 'live', cameraActivity: { kind: 'looked', frames: 4, at: 1000 } }, 2000)).toBe(
      'Checked 4 frames',
    );
    expect(cameraActivityLine({ camera: 'closing' }, 0)).toBe('Turning your camera off…');
    expect(cameraActivityLine({ camera: 'off' }, 0)).toBeUndefined();
  });
});
