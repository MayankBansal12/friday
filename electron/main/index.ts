import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, session, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnvironment } from 'dotenv';
import { AgentService } from '../agent-service.js';
import { DesktopBridge } from '../desktop-bridge.js';
import { SpeechService } from '../speech-service.js';
import { TaskStore } from '../store.js';
import type { BuddySettings, ListeningState } from '../types.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
loadEnvironment({ path: join(process.cwd(), '.env.local'), quiet: true });
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let service: AgentService;
let speech: SpeechService;
let bridge: DesktopBridge;

function activateFriday() {
  if (!window) return;
  window.show();
  window.focus();
  window.webContents.send('voice:start');
}

function createWindow() {
  window = new BrowserWindow({
    width: 680,
    height: 760,
    minWidth: 520,
    minHeight: 560,
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
      window?.hide();
    }
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(root, 'dist/index.html'));
  window.once('ready-to-show', activateFriday);
}

function createTray() {
  const iconPath = join(root, 'assets/icon.png');
  tray = new Tray(existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
  tray.setToolTip('Friday — idle');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Talk to Friday', click: activateFriday },
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
  tray.on('click', activateFriday);
}

app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) =>
    callback(permission === 'media'),
  );
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
  createWindow();
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

  ipcMain.handle('tasks:list', () => service.list());
  ipcMain.handle('tasks:submit', (_, prompt: string) => service.submit(prompt));
  ipcMain.handle('tasks:cancel', (_, id: string) => service.cancel(id));
  ipcMain.handle('tasks:approve', (_, id: string, approved: boolean) => service.resolveApproval(id, approved));
  ipcMain.handle('voice:transcribe', (_, audio: ArrayBuffer, mimeType: string) => speech.transcribe(audio, mimeType));
  ipcMain.handle('settings:get', () => service.getSettings());
  ipcMain.handle('settings:update', (_, value: Partial<BuddySettings>) => {
    if (typeof value.launchAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: value.launchAtLogin });
    if (typeof value.wakeWord === 'string') speech.setWakeWord(value.wakeWord);
    return service.updateSettings(value);
  });
  ipcMain.handle('window:hide', () => window?.hide());
  ipcMain.on('voice:state', (_, state: ListeningState) => {
    tray?.setToolTip(`Friday — ${state}`);
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  bridge?.close();
});
app.on('window-all-closed', () => {});
