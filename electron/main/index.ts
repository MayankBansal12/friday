import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, session, screen, shell, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnvironment } from 'dotenv';
import { AgentService } from '../agent-service.js';
import { DesktopBridge } from '../desktop-bridge.js';
import { createSpeakerFromEnvironment } from '../speaker.js';
import { acknowledgementDirectory, Acknowledgements, loadAcknowledgements } from '../acknowledgement.js';
import { pwCatSink } from '../speech-output.js';
import {
  listenerIdentity,
  liveKitConfigFromEnvironment,
  LiveKitVoice,
  liveKitToken,
  voiceIdentity,
} from '../livekit.js';
import { GnomeClient } from '../gnome-client.js';
import { SpeechService } from '../speech-service.js';
import { TaskStore } from '../store.js';
import { stageRuntimeExtension } from '../runtime-extension.js';
import {
  activeStatuses,
  type BuddySettings,
  type ListeningState,
  type SurfaceLayout,
  type TaskRecord,
} from '../types.js';
import {
  validAudio,
  validId,
  validListeningState,
  validPrompt,
  validRequestContext,
  validSettings,
} from '../validation.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
loadEnvironment({ path: join(process.cwd(), '.env'), quiet: true });
// The companion needs absolute positioning and always-on-top support. Electron
// cannot provide those on native Wayland; use XWayland when an X display exists.
if (process.platform === 'linux' && process.env.DISPLAY && !app.commandLine.hasSwitch('ozone-platform'))
  app.commandLine.appendSwitch('ozone-platform', 'x11');
const nativeWindowPlacement =
  process.platform === 'linux' &&
  (app.commandLine.getSwitchValue('ozone-platform') === 'wayland' || !process.env.DISPLAY);
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shutdownComplete = false;
let service: AgentService;
let speech: SpeechService;
let bridge: DesktopBridge;
const speaker = createSpeakerFromEnvironment();
// Bundled clips (app.asar when packaged); they follow Friday's voice route, LiveKit or pw-cat.
let acknowledgements: Acknowledgements | undefined;
try {
  acknowledgements = new Acknowledgements(
    loadAcknowledgements(acknowledgementDirectory(root)),
    () => speaker.sink ?? pwCatSink(),
  );
} catch (error) {
  console.warn('Acknowledgement clips are unavailable:', error instanceof Error ? error.message : error);
}
// Read once after dotenv; this removes the LiveKit key and secret from inherited environments.
const liveKitSetup = liveKitConfigFromEnvironment();
if (liveKitSetup.error) console.warn(`LiveKit is off: ${liveKitSetup.error}`);
let liveKit: LiveKitVoice | undefined;
let native: GnomeClient;
let surface: SurfaceLayout = 'quiet';
let surfaceHeight: number | undefined;
let surfaceWidth: number | undefined;
let nativePlacement: string | undefined;
let placementTimer: NodeJS.Timeout | undefined;
let notchOffset: { x: number; y: number } | undefined;
let notchPersistTimer: NodeJS.Timeout | undefined;

function surfaceBounds(layout: SurfaceLayout, contentHeight?: number) {
  const area = screen.getPrimaryDisplay().workArea;
  const notch = ['quiet', 'bar', 'panel'].includes(layout);
  const [wantedWidth, wantedHeight] =
    layout === 'orb'
      ? [96, 96]
      : layout === 'tasks'
        ? [400, 420]
        : layout === 'quiet'
          ? [520, 54]
          : layout === 'bar'
            ? [520, 66]
            : layout === 'panel'
              ? [520, 420]
              : [760, 800];
  const width = Math.min(wantedWidth, area.width - 24);
  const height = Math.min(
    (notch || layout === 'tasks') && contentHeight
      ? Math.max(notch ? 1 : 96, Math.min(420, Math.ceil(contentHeight)))
      : wantedHeight,
    area.height - 24,
  );
  const x = ['orb', 'tasks'].includes(layout)
    ? area.x + area.width - width - 18
    : area.x + Math.round((area.width - width) / 2);
  // Keep the visible edge 5px below the desktop's system panel, outside its input region.
  const y = area.y + (notch ? 5 : 12);
  if ((notch || layout === 'details') && notchOffset) {
    const nextX = Math.min(Math.max(x + notchOffset.x, area.x), area.x + area.width - width);
    const nextY = Math.min(Math.max(y + notchOffset.y, area.y), area.y + area.height - height);
    if (nextX < 0 || nextY < 0 || !Number.isFinite(nextX) || !Number.isFinite(nextY)) return { x, y, width, height };
    return { x: nextX, y: nextY, width, height };
  }
  return { x, y, width, height };
}

function setSurface(layout: SurfaceLayout, contentHeight?: number, contentWidth?: number) {
  if (!window || window.isDestroyed()) return;
  if (bridge?.controlling) {
    layout = 'bar';
    contentHeight = 64;
    contentWidth = 500;
  }
  const layoutChanged = layout !== surface;
  surface = layout;
  surfaceHeight = contentHeight;
  surfaceWidth = contentWidth;
  const bounds = surfaceBounds(layout, contentHeight);
  const current = window.getBounds();
  const boundsChanged = Object.entries(bounds).some(([key, value]) => current[key as keyof typeof bounds] !== value);
  if (boundsChanged) window.setBounds(bounds);
  // XWayland input shape leaves the empty space beside the task circle click-through.
  // Keep a small margin for the shadow and the bridge into the hover panel.
  if (process.platform === 'linux' && !bridge?.controlling) {
    const { width, height } = bounds;
    const notchWidth = Math.max(1, Math.min(width, Math.ceil((contentWidth ?? (layout === 'quiet' ? 360 : 500)) + 20)));
    const regions =
      layout === 'tasks'
        ? [
            { x: width - 84, y: 4, width: 80, height: 80 },
            { x: 4, y: 82, width: width - 8, height: Math.max(1, height - 86) },
          ]
        : layout === 'orb'
          ? [{ x: width - 84, y: 4, width: 80, height: 80 }]
          : layout === 'details'
            ? [{ x: 0, y: 0, width, height }]
            : [{ x: Math.floor((width - notchWidth) / 2), y: 0, width: notchWidth, height }];
    window.setShape(regions);
  }
  const placement = JSON.stringify({ layout, ...bounds });
  if (nativeWindowPlacement && (layoutChanged || boundsChanged || nativePlacement !== placement))
    void native
      ?.command({
        op: 'place_companion',
        pid: process.pid,
        layout,
        width: bounds.width,
        height: bounds.height,
        ...(surface === layout && notchOffset ? { notchOffsetX: notchOffset.x, notchOffsetY: notchOffset.y } : {}),
      })
      .then((result) => {
        if (result.placed) nativePlacement = placement;
      })
      .catch((error) => console.warn('Friday window placement requires the updated GNOME extension:', error.message));
}

function reanchorSurface() {
  if (placementTimer) clearTimeout(placementTimer);
  placementTimer = setTimeout(() => {
    placementTimer = undefined;
    setSurface(surface, surfaceHeight, surfaceWidth);
  }, 60);
}

function setExpanded(value: boolean) {
  if (!window) return;
  if (value) setSurface('details');
  else if (surface === 'details') setSurface('quiet');
  window.webContents.send('window:expanded', value);
}
function stopListening() {
  service?.silence();
  speaker.stop();
  liveKit?.reset();
  window?.webContents.send('voice:stop');
  speech?.reset();
}

async function activateFriday(startVoice = true) {
  if (!window) return;
  await bridge?.interruptControl();
  bridge?.restore();
  window.setFocusable(true);
  if (window.isMinimized()) window.hide();
  window.show();
  if (startVoice) {
    window.webContents.send('window:expanded', false);
    setSurface('bar');
  }
  window.focus();
  if (startVoice) window.webContents.send('voice:start');
}

function createWindow(openSilently: boolean) {
  window = new BrowserWindow({
    ...surfaceBounds(surface, surfaceHeight),
    minWidth: 1,
    minHeight: 1,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      preload: join(root, 'dist-electron/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      stopListening();
      window?.hide();
    }
  });
  window.webContents.on('will-navigate', (event, url) => {
    const devOrigin = process.env.VITE_DEV_SERVER_URL;
    if ((devOrigin && url.startsWith(devOrigin)) || url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  // A reloaded or crashed renderer is no longer listening; never route voice to it.
  window.webContents.on('did-start-loading', () => liveKit?.listener(false));
  window.webContents.on('render-process-gone', () => liveKit?.listener(false));
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(root, 'dist/index.html'));
  window.once('ready-to-show', () => {
    setSurface(surface, surfaceHeight, surfaceWidth);
    if (!openSilently) activateFriday(false);
  });
  window.on('show', () => {
    nativePlacement = undefined;
    setSurface(surface, surfaceHeight, surfaceWidth);
  });
  window.on('restore', () => {
    nativePlacement = undefined;
    reanchorSurface();
  });
  window.on('move', reanchorSurface);
  screen.on('display-metrics-changed', reanchorSurface);
  screen.on('display-added', reanchorSurface);
  screen.on('display-removed', reanchorSurface);
}

function createTray() {
  const iconPath = join(root, 'assets/icon.png');
  tray = new Tray(existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
  tray.setToolTip('Friday — idle');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Talk to Friday', click: () => activateFriday(true) },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => activateFriday(false));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
if (hasSingleInstanceLock)
  app.whenReady().then(async () => {
    const openedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin;
    session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
      return webContents === window?.webContents && permission === 'media' && details.mediaType === 'audio';
    });
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const mediaTypes = 'mediaTypes' in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
      callback(
        webContents === window?.webContents &&
          permission === 'media' &&
          mediaTypes.length > 0 &&
          mediaTypes.every((type) => type === 'audio'),
      );
    });
    const settings: BuddySettings = {
      defaultCwd: process.env.HOME || process.cwd(),
      launchAtLogin: app.getLoginItemSettings().openAtLogin,
      wakeWord: process.env.LINUX_BUDDY_WAKE_WORD || 'Friday',
      model: process.env.LINUX_BUDDY_MODEL || 'gpt-6-luna',
      autoSpeak: true,
    };
    speech = new SpeechService(settings.wakeWord, {
      workerPath: app.isPackaged
        ? join(process.resourcesPath, 'parakeet-worker.py')
        : join(root, 'native/parakeet-worker.py'),
    });
    native = new GnomeClient(
      app.isPackaged ? join(process.resourcesPath, 'desktop-client.py') : join(root, 'native/desktop-client.py'),
    );
    native.onReveal = () => activateFriday(true);
    native.onStopped = (id, error) => bridge.nativeStopped(id, error);
    bridge = new DesktopBridge(
      native,
      () =>
        window
          ? {
              isVisible: () => window!.isVisible() && !window!.isMinimized(),
              hide: () => window!.hide(),
              showInactive: () => {
                window!.showInactive();
              },
              setControlling: (active) => {
                window!.setFocusable(!active);
                if (active) {
                  setExpanded(false);
                  setSurface('bar');
                  // Shape updates replace X11's input region. Clear the old
                  // outline once, then leave it alone while clicks pass through.
                  window!.setShape([]);
                  if (!window!.isVisible()) window!.showInactive();
                }
                window!.setIgnoreMouseEvents(active);
              },
            }
          : null,
      (data) => {
        const image = nativeImage
          .createFromBuffer(Buffer.from(data, 'base64'))
          .resize({ width: 1440, quality: 'good' });
        const dimensions = image.getSize();
        return { data: image.toJPEG(82).toString('base64'), ...dimensions, mimeType: 'image/jpeg' };
      },
    );
    await bridge.start();
    if (liveKitSetup.config)
      liveKit = new LiveKitVoice(liveKitSetup.config, {
        expect: (id) => window?.webContents.send('livekit:expect', id ?? 0),
        cancelled: () => window?.webContents.send('livekit:cancelled'),
        // Rumik PCM goes to LiveKit only while a renderer is subscribed; otherwise pw-cat plays it.
        routable: (ready) => {
          speaker.sink = ready ? liveKit?.sink : undefined;
        },
        microphone: (frame) => window?.webContents.send('livekit:microphone', frame.buffer),
        microphoneReady: (sid) => window?.webContents.send('livekit:microphone-ready', sid),
      });
    const runtimeDirectory = join(app.getPath('userData'), 'runtime');
    const extensionPath = await stageRuntimeExtension(join(root, 'dist-electron'), runtimeDirectory);
    service = new AgentService(
      new TaskStore(join(app.getPath('userData'), 'tasks.json')),
      settings,
      extensionPath,
      bridge,
      { voice: speaker, acknowledgements },
    );
    bridge.onStopped = (id, error) => {
      stopListening();
      void service.desktopInterrupted(id, error).catch(() => {});
    };
    bridge.onMark = (mark) => window?.webContents.send('desktop:marked', mark);
    bridge.onControlProgress = (id, text, spoken) => service.controlProgress(id, text, spoken);
    await service.init();
    const persistedSettings = service.getSettings();
    notchOffset = persistedSettings.notchOffset;
    speech.setWakeWord(persistedSettings.wakeWord);
    app.setLoginItemSettings({ openAtLogin: persistedSettings.launchAtLogin });
    createWindow(openedAtLogin);
    createTray();
    globalShortcut.register('CommandOrControl+Shift+Escape', () => {
      stopListening();
      bridge.stop();
      for (const task of service.list()) if (activeStatuses.has(task.status)) void service.cancel(task.id);
    });
    if (!globalShortcut.register('CommandOrControl+Shift+Space', activateFriday))
      console.warn('Global shortcut Ctrl+Shift+Space is unavailable');

    bridge.onGuidanceChanged = (guiding) => {
      if (window && !window.isDestroyed()) window.webContents.send('desktop:guidance', guiding);
    };
    bridge.onControlChanged = (active) => {
      if (window && !window.isDestroyed()) window.webContents.send('desktop:controlling', active);
    };
    service.on('state', (state) => window?.webContents.send('friday:state', state));
    service.on('task', (task: TaskRecord) => {
      window?.webContents.send('task:changed', task);
    });

    const fromWindow = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
      if (!window || event.sender !== window.webContents) throw new Error('IPC request came from an untrusted page.');
    };
    ipcMain.handle('tasks:list', (event) => {
      fromWindow(event);
      return service.list();
    });
    ipcMain.handle('friday:state', (event) => {
      fromWindow(event);
      return service.state();
    });
    ipcMain.handle('sessions:stop', (event, id: unknown) => {
      fromWindow(event);
      return service.stopChild(validId(id));
    });
    ipcMain.handle('window:surface', (event, layout: unknown, height: unknown, width: unknown) => {
      fromWindow(event);
      if (!['orb', 'tasks', 'quiet', 'bar', 'panel', 'details'].includes(String(layout)))
        throw new Error('Invalid surface');
      setSurface(
        layout as SurfaceLayout,
        typeof height === 'number' && Number.isFinite(height) ? height : undefined,
        typeof width === 'number' && Number.isFinite(width) ? width : undefined,
      );
    });
    ipcMain.handle('foreground:stop', async (event) => {
      fromWindow(event);
      service.silence();
      speaker.stop();
      liveKit?.reset();
      bridge.stop();
      const task = service.list().find((item) => item.role !== 'child' && activeStatuses.has(item.status));
      if (task) await service.cancel(task.id);
    });
    ipcMain.handle('tasks:submit', (event, prompt: unknown, context: unknown) => {
      fromWindow(event);
      // Validate before touching output: an invalid submission must not silence the current reply.
      const text = validPrompt(prompt);
      const request = validRequestContext(context);
      return service.submit(text, request);
    });
    ipcMain.handle('tasks:approve', (event, id: unknown, approved: unknown) => {
      fromWindow(event);
      if (typeof approved !== 'boolean') throw new Error('Invalid approval response.');
      return service.resolveApproval(validId(id), approved);
    });
    ipcMain.handle('conversation:new', async (event) => {
      fromWindow(event);
      const id = await service.newConversation();
      bridge.stop();
      await bridge.clear().catch(() => {});
      return id;
    });
    ipcMain.handle('desktop:controlling', (event) => {
      fromWindow(event);
      return bridge.controlling;
    });
    ipcMain.handle('desktop:guidance', (event) => {
      fromWindow(event);
      return bridge.guiding;
    });
    ipcMain.handle('desktop:status', (event) => {
      fromWindow(event);
      return bridge.status();
    });
    ipcMain.handle('desktop:mark', (event) => {
      fromWindow(event);
      return bridge.mark();
    });
    ipcMain.handle('desktop:clear', (event) => {
      fromWindow(event);
      return bridge.clear();
    });
    ipcMain.handle('desktop:stop', async (event) => {
      fromWindow(event);
      bridge.stop();
      speaker.stop();
      liveKit?.reset();
      await service.stop();
    });
    ipcMain.handle('voice:speak', (event, taskId: unknown) => {
      fromWindow(event);
      if (typeof taskId !== 'string') throw new Error('Invalid reply');
      return service.readAloud(taskId);
    });
    ipcMain.handle('voice:silence', (event) => {
      fromWindow(event);
      service.silence();
    });
    // Barge-in: the user is speaking over Friday. Stops audio and unrevealed presentation only.
    ipcMain.handle('voice:interrupt', (event) => {
      fromWindow(event);
      service.interrupt();
    });
    ipcMain.handle('livekit:session', async (event) => {
      fromWindow(event);
      if (!liveKit) return undefined;
      await liveKit.connect();
      return {
        url: liveKit.config.url,
        token: await liveKitToken(liveKit.config, listenerIdentity),
        voice: voiceIdentity,
      };
    });
    ipcMain.on('livekit:listener', (event, ready: unknown) => {
      try {
        fromWindow(event);
        if (typeof ready === 'boolean') liveKit?.listener(ready);
      } catch {
        /* Ignore forged one-way renderer messages. */
      }
    });
    ipcMain.on('livekit:observed', (event, id: unknown) => {
      try {
        fromWindow(event);
        if (Number.isSafeInteger(id) && (id as number) > 0) liveKit?.observed(id as number);
      } catch {
        /* Ignore forged one-way renderer messages. */
      }
    });
    ipcMain.handle('voice:pcm', (event, request: unknown) => {
      fromWindow(event);
      return speech.transcribePcm(request);
    });
    ipcMain.handle('voice:transcribe', (event, audio: unknown, mimeType: unknown) => {
      fromWindow(event);
      const valid = validAudio(audio, mimeType);
      return speech.transcribe(valid.audio, valid.mimeType);
    });
    ipcMain.handle('settings:get', (event) => {
      fromWindow(event);
      return service.getSettings();
    });
    ipcMain.handle('settings:update', async (event, value: unknown) => {
      fromWindow(event);
      const next = validSettings(value);
      if (next.defaultCwd) {
        const info = await stat(next.defaultCwd).catch(() => undefined);
        if (!info?.isDirectory()) throw new Error('Working folder does not exist or is not a directory.');
      }
      const updated = await service.updateSettings(next);
      if (typeof next.launchAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
      if (typeof next.wakeWord === 'string') speech.setWakeWord(next.wakeWord);
      return updated;
    });
    ipcMain.handle('window:expand', async (event, value: unknown) => {
      fromWindow(event);
      if (typeof value !== 'boolean') throw new Error('Invalid window layout');
      await bridge.interruptControl();
      setExpanded(value);
      window?.setFocusable(true);
      window?.show();
      window?.focus();
    });
    ipcMain.handle('window:notch-offset', (event, value: unknown) => {
      fromWindow(event);
      if (value === undefined || value === null) {
        if (notchOffset) {
          notchOffset = undefined;
          setSurface(surface, surfaceHeight, surfaceWidth);
          void service.updateSettings({ notchOffset: undefined }).catch(() => {});
        }
        return;
      }
      if (!value || typeof value !== 'object') throw new Error('Invalid notch offset');
      const offset = value as Record<string, unknown>;
      if (typeof offset.x !== 'number' || typeof offset.y !== 'number') throw new Error('Invalid notch offset');
      // Drags compose over the previous offset and re-place synchronously;
      // persistence happens in the background.
      notchOffset = { x: Math.round(offset.x), y: Math.round(offset.y) };
      setSurface(surface, surfaceHeight, surfaceWidth);
      if (notchPersistTimer) clearTimeout(notchPersistTimer);
      notchPersistTimer = setTimeout(() => {
        notchPersistTimer = undefined;
        void service.updateSettings({ notchOffset }).catch(() => {});
      }, 1000);
    });
    ipcMain.handle('window:hide', (event) => {
      fromWindow(event);
      stopListening();
      window?.minimize();
    });
    ipcMain.on('voice:state', (event, state: ListeningState) => {
      try {
        fromWindow(event);
        const next = validListeningState(state);
        tray?.setToolTip(
          `Friday — ${
            {
              idle: 'Microphone off',
              paused: 'Microphone paused',
              starting: 'Opening microphone…',
              listening: `Say Hey ${service.getSettings().wakeWord}`,
              transcribing: 'One moment…',
              armed: 'Go ahead…',
              error: 'Check your microphone',
            }[next as ListeningState]
          }`,
        );
        if (next === 'listening' || next === 'armed')
          void speech.prepare().catch((error) => console.error('Local STT preparation failed', error.message));
        if (next === 'idle' || next === 'paused' || next === 'error' || next === 'listening') speech.reset();
      } catch {
        /* Ignore forged one-way renderer messages. */
      }
    });
  });

app.on('second-instance', () => activateFriday(false));
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  quitting = true;
  stopListening();
  speaker.dispose();
  void liveKit?.close();
  speech?.close();
  void (async () => {
    bridge?.stop();
    await service?.shutdown();
    shutdownComplete = true;
    app.quit();
  })();
});
app.on('will-quit', () => {
  if (placementTimer) clearTimeout(placementTimer);
  if (notchPersistTimer) clearTimeout(notchPersistTimer);
  globalShortcut.unregisterAll();
  bridge?.close();
});
app.on('window-all-closed', () => {});
