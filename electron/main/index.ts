import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
} from 'electron';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnvironment } from 'dotenv';
import { AgentService } from '../agent-service.js';
import { DesktopBridge } from '../desktop-bridge.js';
import { SpeechService } from '../speech-service.js';
import { TaskStore } from '../store.js';
import type { BuddySettings, ListeningState } from '../types.js';
import { validAudio, validId, validListeningState, validPrompt, validSettings } from '../validation.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
loadEnvironment({ path: join(process.cwd(), '.env.local'), quiet: true });
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shutdownComplete = false;
let service: AgentService;
let speech: SpeechService;
let bridge: DesktopBridge;

function stopListening() {
  window?.webContents.send('voice:stop');
  speech?.reset();
}

function activateFriday(startVoice = true) {
  if (!window) return;
  window.show();
  window.focus();
  if (startVoice) window.webContents.send('voice:start');
}

function createWindow(openSilently: boolean) {
  window = new BrowserWindow({
    width: 760,
    height: 800,
    minWidth: 560,
    minHeight: 620,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
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
  window.on('hide', stopListening);
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
    if (!openSilently) activateFriday(true);
  });
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
  tray.on('click', () => activateFriday(true));
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
      model: process.env.LINUX_BUDDY_MODEL || 'kimi-k2.6',
    };
    speech = new SpeechService(settings.wakeWord);
    bridge = new DesktopBridge(() => window);
    await bridge.start();
    const runtimeDirectory = join(app.getPath('userData'), 'runtime');
    const extensionPath = join(runtimeDirectory, 'friday-extension.mjs');
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await copyFile(join(root, 'dist-electron/friday-extension.js'), extensionPath);
    service = new AgentService(new TaskStore(join(app.getPath('userData'), 'tasks.json')), settings, extensionPath, {
      url: bridge.url,
      token: bridge.token,
    });
    await service.init();
    const persistedSettings = service.getSettings();
    speech.setWakeWord(persistedSettings.wakeWord);
    app.setLoginItemSettings({ openAtLogin: persistedSettings.launchAtLogin });
    createWindow(openedAtLogin);
    createTray();
    if (!globalShortcut.register('CommandOrControl+Shift+Space', activateFriday))
      console.warn('Global shortcut Ctrl+Shift+Space is unavailable');

    service.on('task', (task) => {
      window?.webContents.send('task:changed', task);
      if (
        (task.status === 'completed' || task.status === 'failed' || task.status === 'awaiting_approval') &&
        Notification.isSupported()
      ) {
        const title =
          task.status === 'completed'
            ? 'Friday finished'
            : task.status === 'failed'
              ? 'Friday needs attention'
              : 'Friday needs approval';
        new Notification({ title, body: task.response || task.error || task.prompt }).show();
      }
    });

    const fromWindow = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
      if (!window || event.sender !== window.webContents) throw new Error('IPC request came from an untrusted page.');
    };
    ipcMain.handle('tasks:list', (event) => {
      fromWindow(event);
      return service.list();
    });
    ipcMain.handle('tasks:submit', (event, prompt: unknown) => {
      fromWindow(event);
      return service.submit(validPrompt(prompt));
    });
    ipcMain.handle('tasks:cancel', (event, id: unknown) => {
      fromWindow(event);
      return service.cancel(validId(id));
    });
    ipcMain.handle('tasks:approve', (event, id: unknown, approved: unknown) => {
      fromWindow(event);
      if (typeof approved !== 'boolean') throw new Error('Invalid approval response.');
      return service.resolveApproval(validId(id), approved);
    });
    ipcMain.handle('voice:transcribe', (event, audio: unknown, mimeType: unknown) => {
      fromWindow(event);
      if (!window?.isVisible()) throw new Error('Voice input stopped because Friday is hidden.');
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
    ipcMain.handle('window:hide', (event) => {
      fromWindow(event);
      stopListening();
      window?.hide();
    });
    ipcMain.on('voice:state', (event, state: ListeningState) => {
      try {
        fromWindow(event);
        tray?.setToolTip(`Friday — ${validListeningState(state)}`);
      } catch {
        /* Ignore forged one-way renderer messages. */
      }
    });
  });

app.on('second-instance', () => activateFriday(true));
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  quitting = true;
  stopListening();
  void (async () => {
    await service?.shutdown();
    shutdownComplete = true;
    app.quit();
  })();
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  bridge?.close();
});
app.on('window-all-closed', () => {});
