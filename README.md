# Friday

Friday is a desktop assistant for this Fedora 43 / GNOME 49 / Wayland machine. Type a request or hold the microphone button; Friday chooses whether to answer, look at the screen, draw, or act. Follow-ups such as “open that” stay in the same conversation. The current runtime is Pi with OpenCode Go.

## Setup and launch

Requirements: Node.js 22+, pnpm, Python 3 with PyGObject, GNOME Shell 49, `pi` 0.80+, `handy` with the Canary model, `ffmpeg`, and `espeak-ng`. Desktop integration currently supports the built-in 1920×1080 display at 100% scale.

Configure OpenCode Go through `OPENCODE_API_KEY` in `.env` or existing Pi authentication. See [.env.example](.env.example) for environment overrides.

```sh
pnpm install
pnpm desktop:install
# On first install or after changing the GNOME extension:
# save your work, sign out, then sign back in once.
pnpm desktop:status
pnpm build
pnpm start:desktop
```

`desktop:status` must report `ready: true` and `protocolVersion: 3`. GNOME caches loaded extension modules, so reopening Friday alone cannot activate an extension update. App-only changes need a rebuild and app restart, without another login.

The installer writes the extension to `~/.local/share/gnome-shell/extensions/friday-desktop@linux-buddy.local`, creates a private token at `~/.config/friday-desktop/token`, and enables Friday in GNOME. It does not restart the desktop or log you out.

For development, use `pnpm dev`. The local launch commands use `--no-sandbox` because this machine's Chromium sandbox is not configured; `pnpm dev:sandboxed` is available with a working sandbox. The packaged app is built in `release/linux-unpacked/`.

## Using Friday

- Ask “Look at my screen and highlight the main graph,” then follow up in the same conversation. **New task** starts a new conversation; archived tasks can be resumed.
- **Open conversation** expands the companion for history, activity, settings, and timing details.
- The minus button minimizes Friday. Use **Alt+Tab** to return. Closing the window keeps the process running; the tray menu has **Quit**.
- During screen work, Friday minimizes and shows a native progress caption with **Reply** and **Stop/Clear**. The answer window returns when the drawing clears or expires.
- **Mark screen** lets you draw around an element and ask about it. Agent drawings are click-through and preserve normal pointer movement. Drawings expire after 30 seconds and clear when input, focus, or geometry changes make them stale.
- **Stop** or **Escape** clears overlays and cancels desktop work. **Ctrl+Shift+Escape** also stops work when GNOME grants the global shortcut.

Hold the microphone button to submit direct speech. **Ctrl+Shift+Space** or the tray's **Talk to Friday** starts wake-word listening: say “Friday” followed by the request. Global shortcuts depend on GNOME granting them. Opening the app does not start recording. Transcription uses local Handy/Canary; **Read aloud** uses local espeak-ng. Automatic spoken replies are optional in Settings.

## Desktop integration and permissions

The Pi extension exposes `desktop_observe`, `desktop_draw`, `desktop_clear`, and `desktop_action`. Observations carry fresh IDs and a 1440px JPEG; the host validates and maps screenshot coordinates to the native display. GNOME renders arrows, ellipses, rectangles, highlights, labels, and paths, and acknowledges drawing only after painting. Visible overlays inhibit fullscreen display bypass and release that hold when hidden.

Desktop input requires a native confirmation dialog. Users can allow one exact action or up to five clicks/scrolls in the same window for the current request, lasting at most 60 seconds. Typing, key presses, right/double clicks, and actions marked consequential require fresh confirmation. Each action consumes its observation. Stop, lock, overview, display changes, disconnect, and task completion revoke desktop control; a heartbeat expires abandoned sessions.

Normal agent requests also have file and shell tools running as the logged-in user. Consequential shell commands request confirmation through a heuristic check; this is not an operating-system sandbox. Screenshot/tool results are sent to the configured model and retained in local conversation files under Electron's user-data directory. Microphone audio is transcribed locally; recognized requests go to the model.

## Development and checks

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

| Command                  | Coverage                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `pnpm test:native`       | Local GNOME rendering, fullscreen pixels, click-through, consent, marking, and cancellation |
| `pnpm test:native:ui`    | Native checks plus the packaged UI with integration available, unavailable, and reconnected |
| `pnpm test:native:agent` | Optional real-model UI request → drawing → window return → follow-up click and verification |

Native tests run in an isolated headless GNOME session with a synthetic GTK target. They require Python Pillow for pixel checks and print a temporary artifact directory for screenshots/logs. The model test uses configured OpenCode credentials and sends the synthetic desktop screenshots to that provider. Other checks make no model calls. The test driver is never installed in the user's desktop or bundled with the app.

Code layout:

- `electron/`: app lifecycle, agent sessions, desktop bridge/validation, and speech services.
- `native/`: authenticated D-Bus transport and GNOME drawing/input extension.
- `src/`: React interface and voice interaction.
- `scripts/`: desktop installation and status commands.
- `tests/`: unit tests and reusable native/UI integration harness.

Settings include working folder, model, wake word, launch at login, and automatic spoken replies. Environment overrides include `LINUX_BUDDY_MODEL`, `LINUX_BUDDY_WAKE_WORD`, `LINUX_BUDDY_STT_MODEL`, `LINUX_BUDDY_PI_BIN`, `LINUX_BUDDY_HANDY_BIN`, and `LINUX_BUDDY_FFMPEG_BIN`. Activity reports model/tool/capture/transcription timings; hosted inference remains the main source of latency.
