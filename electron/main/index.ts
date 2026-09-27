import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, session, screen, shell, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnvironment } from 'dotenv';
import { AgentService } from '../agent-service.js';
import { DesktopBridge } from '../desktop-bridge.js';
import { Speaker } from '../speaker.js';
import { GnomeClient } from '../gnome-client.js';
import { SpeechService } from '../speech-service.js';
import { TaskStore } from '../store.js';
import type { BuddySettings, ListeningState, SurfaceLayout, TaskRecord } from '../types.js';
import { validAudio, validId, validListeningState, validPrompt, validSettings } from '../validation.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
loadEnvironment({ path: join(process.cwd(), '.env.local'), quiet: true });
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
const speaker = new Speaker();
let native: GnomeClient;
let surface: SurfaceLayout = 'orb';
let surfaceHeight: number | undefined;
let placementTimer: NodeJS.Timeout | undefined;

function surfaceBounds(layout: SurfaceLayout, contentHeight?: number) {
  const area = screen.getPrimaryDisplay().workArea;
  const [wantedWidth, wantedHeight] =
    layout === 'orb' ? [96, 96] : layout === 'bar' ? [520, 76] : layout === 'panel' ? [560, 420] : [760, 800];
  const width = Math.min(wantedWidth, area.width - 24);
  const height = Math.min(
    layout === 'panel' && contentHeight ? Math.max(96, Math.min(420, Math.ceil(contentHeight))) : wantedHeight,
    area.height - 24,
  );
  const x = layout === 'orb' ? area.x + area.width - width - 18 : area.x + Math.round((area.width - width) / 2);
  const y = area.y + 12;
  return { x, y, width, height };
}

function setSurface(layout: SurfaceLayout, contentHeight?: number) {
  if (!window || window.isDestroyed()) return;
  surface = layout;
  surfaceHeight = contentHeight;
  const bounds = surfaceBounds(layout, contentHeight);
  const current = window.getBounds();
  if (Object.entries(bounds).some(([key, value]) => current[key as keyof typeof bounds] !== value))
    window.setBounds(bounds);
  if (nativeWindowPlacement)
    void native
      ?.command({ op: 'place_companion', pid: process.pid, layout, width: bounds.width, height: bounds.height })
      .catch((error) => console.warn('Friday window placement requires the updated GNOME extension:', error.message));
}

function reanchorSurface() {
  if (placementTimer) clearTimeout(placementTimer);
  placementTimer = setTimeout(() => {
    placementTimer = undefined;
    setSurface(surface, surfaceHeight);
  }, 60);
}

function setExpanded(value: boolean) {
  if (!window) return;
  setSurface(value ? 'details' : 'orb');
  window.webContents.send('window:expanded', value);
}
function showCompanion() {
  const task = service
    .list()
    .find(
      (task) => task.role !== 'child' && ['queued', 'thinking', 'acting', 'awaiting_approval'].includes(task.status),
    );
  if (task) void bridge.setCaption(task.id, task.response || task.steps.at(-1)?.title || 'Friday is working…');
}

function stopListening() {
  service?.silence();
  speaker.stop();
  window?.webContents.send('voice:stop');
  speech?.reset();
}

function activateFriday(startVoice = true) {
  if (!window) return;
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
    },
  });
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      stopListening();
      window?.hide();
    }
  });
  // Capture hides the companion without ending the conversation or follow-up listening.
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
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(root, 'dist/index.html'));
  window.once('ready-to-show', () => {
    setSurface(surface, surfaceHeight);
    if (!openSilently) activateFriday(false);
  });
  window.on('show', () => setSurface(surface, surfaceHeight));
  window.on('restore', reanchorSurface);
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
      model: process.env.LINUX_BUDDY_MODEL || 'glm-5.3-flash',
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
              hide: () => window!.minimize(),
              showInactive: () => {
                window!.restore();
                // Wayland has no xdg-shell unminimize request. Remap the surface to bring it back.
                window!.hide();
                window!.show();
                window!.focus();
              },
              showCompanion,
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
    const runtimeDirectory = join(app.getPath('userData'), 'runtime');
    const extensionPath = join(runtimeDirectory, 'friday-extension.mjs');
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      copyFile(join(root, 'dist-electron/friday-extension.js'), extensionPath),
      copyFile(join(root, 'dist-electron/desktop-protocol.js'), join(runtimeDirectory, 'desktop-protocol.js')),
    ]);
    service = new AgentService(
      new TaskStore(join(app.getPath('userData'), 'tasks.json')),
      settings,
      extensionPath,
      bridge,
      { speak: (text) => speaker.speak(text), silence: () => speaker.stop() },
    );
    bridge.onStopped = (id, error) => {
      stopListening();
      void service.desktopInterrupted(id, error).catch(() => {});
    };
    bridge.onMark = (mark) => window?.webContents.send('desktop:marked', mark);
    await service.init();
    const persistedSettings = service.getSettings();
    speech.setWakeWord(persistedSettings.wakeWord);
    app.setLoginItemSettings({ openAtLogin: persistedSettings.launchAtLogin });
    createWindow(openedAtLogin);
    createTray();
    globalShortcut.register('CommandOrControl+Shift+Escape', () => {
      stopListening();
      bridge.stop();
      for (const task of service.list())
        if (['queued', 'thinking', 'acting', 'awaiting_approval'].includes(task.status)) void service.cancel(task.id);
    });
    if (!globalShortcut.register('CommandOrControl+Shift+Space', activateFriday))
      console.warn('Global shortcut Ctrl+Shift+Space is unavailable');

    service.on('state', (state) => window?.webContents.send('friday:state', state));
    service.on('task', (task: TaskRecord) => {
      window?.webContents.send('task:changed', task);
      if (task.role !== 'child')
        void bridge.setCaption(
          task.id,
          task.error || task.response || task.steps.at(-1)?.title || 'Friday is working…',
          ['completed', 'failed', 'cancelled'].includes(task.status),
        );
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
    ipcMain.handle('window:surface', (event, layout: unknown, height: unknown) => {
      fromWindow(event);
      if (!['orb', 'bar', 'panel', 'details'].includes(String(layout))) throw new Error('Invalid surface');
      setSurface(layout as SurfaceLayout, typeof height === 'number' && Number.isFinite(height) ? height : undefined);
    });
    ipcMain.handle('foreground:stop', async (event) => {
      fromWindow(event);
      stopListening();
      bridge.stop();
      const task = service
        .list()
        .find(
          (item) =>
            item.role !== 'child' && ['queued', 'thinking', 'acting', 'awaiting_approval'].includes(item.status),
        );
      if (task) await service.cancel(task.id);
    });
    ipcMain.handle('tasks:submit', (event, prompt: unknown, conversationId: unknown) => {
      fromWindow(event);
      speaker.stop();
      if (conversationId !== undefined) validId(conversationId);
      return service.submit(validPrompt(prompt));
    });
    ipcMain.handle('tasks:cancel', (event, id: unknown) => {
      fromWindow(event);
      stopListening();
      return service.cancel(validId(id));
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
      stopListening();
      bridge.stop();
      await Promise.all(
        service
          .list()
          .filter((task) => ['queued', 'thinking', 'acting', 'awaiting_approval'].includes(task.status))
          .map((task) => service.cancel(task.id)),
      );
    });
    ipcMain.handle('voice:speak', (event, text: unknown) => {
      fromWindow(event);
      if (typeof text !== 'string') throw new Error('Invalid speech text');
      return speaker.speak(text);
    });
    ipcMain.handle('voice:silence', (event) => {
      fromWindow(event);
      service.silence();
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
    ipcMain.handle('window:expand', (event, value: unknown) => {
      fromWindow(event);
      if (typeof value !== 'boolean') throw new Error('Invalid window layout');
      setExpanded(value);
      window?.setFocusable(true);
      window?.show();
      window?.focus();
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
        tray?.setToolTip(`Friday — ${next}`);
        if (next === 'listening' || next === 'armed')
          void speech.prepare().catch((error) => console.error('Local STT preparation failed', error.message));
        if (next === 'idle' || next === 'error') speech.reset();
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
  globalShortcut.unregisterAll();
  bridge?.close();
});
app.on('window-all-closed', () => {});
