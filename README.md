# Friday

Friday is a voice-first desktop assistant for this Fedora 43 / GNOME 49 / Wayland machine. One parent Pi session answers you, guides you on screen, and delegates independent work to background child sessions. Friday can look at and draw on your screen, but never clicks or types for you. The current model provider is OpenCode Go.

See [the current request flow](docs/request-flow.md) for session boundaries, speech behavior, and the implementation diagram.

## Setup and launch

Requirements: Node.js 22+, pnpm, Python 3.12+ with venv/pip and PyGObject, GNOME Shell 49, `pi` 0.85.1+, local Parakeet V3 int8 ONNX model files (available through Handy), `ffmpeg`, and `espeak-ng`. Desktop integration currently supports the built-in 1920×1080 display at 100% scale.

Configure OpenCode Go through `OPENCODE_API_KEY` in `.env` or existing Pi authentication. See [.env.example](.env.example) for environment overrides.

```sh
pnpm install
pnpm stt:setup
pnpm desktop:install
# On first install or after changing the GNOME extension:
# save your work, sign out, then sign back in once.
pnpm desktop:status
pnpm build
pnpm start:desktop
```

The floating companion uses XWayland so Electron can place it at fixed screen coordinates: the circle at the upper right, and the bar/panel at the top center. Placement is reapplied after reopening, moving, and display changes. `pnpm start:desktop` retrieves the logged-in display settings when launched remotely. Native Wayland can still be explicitly selected, but its placement requires the updated GNOME extension. [Electron documents this positioning limitation](https://www.electronjs.org/docs/latest/api/browser-window).

`desktop:status` must report `ready: true` and `protocolVersion: 5` for screen guidance. GNOME caches loaded extension modules, so reopening Friday alone cannot activate an extension update. App-only changes need a rebuild and app restart, without another login.

The installer writes the extension to `~/.local/share/gnome-shell/extensions/friday-desktop@linux-buddy.local`, creates a private token at `~/.config/friday-desktop/token`, and enables Friday in GNOME. It does not restart the desktop or log you out.

For development, use `pnpm dev`. The local launch commands use `--no-sandbox` because this machine's Chromium sandbox is not configured; `pnpm dev:sandboxed` is available with a working sandbox. The packaged app is built in `release/linux-unpacked/`.

## Using Friday

- Friday opens in active listening. After ten seconds without a request, it rests and shows **Say “hey friday” to wake her up**. The local detector keeps listening in rest: “Hey Friday” opens a new request, and “Hey Friday, open my calendar” includes the request in one utterance.
- One top-center notch shows listening, work, speech, and drawing guidance, 5 px below the system panel. At rest it contracts to a smaller pill with the wake hint and Stop; listening and work use the full-width bar. Hover to open details, move away to collapse. Motion animates the size changes without scaling the text and respects reduced-motion preferences. Keyboard focus also opens details. There are no extra expand/collapse or microphone buttons in the bar.
- The notch always has **Stop Friday**. Clicking it or saying **“Friday stop”** cancels speech and all running actions, clears drawings, and returns an enabled microphone to rest. The detector stays active during work and playback, but only an addressed Stop can act during those states. Explicit microphone-off remains off until enabled again.
- Voice replies reopen active listening for a follow-up. Typed requests return to wake waiting. Opening the text composer keeps only Stop recognition active, so nearby conversation cannot submit a request. Wake/Stop detection uses local Parakeet transcription with an 850 ms speech endpoint plus inference time; it is not an instant dedicated wake engine.
- Background tasks use the existing upper-right circle. Hover or focus it for updates; select a task to ask about it. Selection alone sends nothing. A new “Hey Friday” clears old task context. A task's own Stop affects only that task; the notch Stop cancels all work. Completed updates can be dismissed individually.
- **Guiding you** appears in the same notch only after a drawing is confirmed on screen. Screenshot-only work never enters guidance. Friday briefly hides for the screenshot itself, then returns without taking focus; drawing does not replace it with another box.
- Hover for **Type instead**, the microphone on/off toggle, and **Settings & history**. Settings/history contains previous requests and **Mark screen**. **New task** resets the parent conversation; normal requests reuse it.
- **Ctrl+Shift+Space** or the tray's **Talk to Friday** activates listening. **Ctrl+Shift+Escape** stops all work and recording. Native **Escape** clears the overlay and stops its desktop request.
- Agent drawings are click-through and preserve normal pointer movement. Drawings expire after 30 seconds and clear when input, focus, or geometry changes make them stale. Guidance advances when you ask; it does not continuously watch the screen.
- Closing the window hides Friday; the tray menu has **Quit**. Quitting interrupts running children and saves their history. Reopening restores the parent identity and task registry; interrupted children resume only on request.

Global shortcuts depend on GNOME granting them. **Read replies aloud** can be disabled in Settings. Existing settings are preserved.

## Local speech recognition

`pnpm stt:setup` installs a pinned CPU ONNX runtime into `$XDG_DATA_HOME/friday/stt-venv` (default `~/.local/share/friday/stt-venv`). Friday reads the existing Parakeet V3 model in `$XDG_DATA_HOME/com.pais.handy/models/parakeet-tdt-0.6b-v3-int8`. It does not download model weights or invoke Handy. Set `LINUX_BUDDY_STT_MODEL` to a different local directory if needed; it must contain `config.json`, `vocab.txt`, `encoder-model.int8.onnx`, and `decoder_joint-model.int8.onnx`.

The Python worker starts when listening begins, stays loaded until Friday quits, and communicates over private process pipes. Audio stays local and temporary audio files are removed after each request. Model loading and inference have timeouts; a failed worker can restart on the next request. A custom environment can be installed with `pnpm stt:setup --venv /path/to/venv`; launch Friday with `LINUX_BUDDY_STT_PYTHON=/path/to/venv/bin/python` to use it. Both development and packaged apps use the same external runtime/model.

This is utterance-based recognition, not streaming: the existing recorder submits after a pause (850 ms) or microphone-button release, with a 25-second segment limit. The worker accepts up to 30 seconds. Keeping the model loaded avoids loading it for each utterance. `LINUX_BUDDY_STT_THREADS` controls CPU inference threads (default 4).

## Desktop integration and permissions

The parent Pi session exposes `desktop_observe`, `desktop_draw`, and `desktop_clear`. There is no desktop input tool, and children cannot call screen or presentation tools. Observations carry fresh IDs and a 1440px JPEG; the host validates and maps screenshot coordinates to the native display. GNOME renders consistent sketch-style annotations and acknowledges drawing only after painting. Visible overlays inhibit fullscreen display bypass and release that hold when hidden.

Screen guidance is visual first: usually 1–3 marks, with text only when it adds useful information. Use `circle`, `arrow`, `highlight`, `step`, or `note`; `rectangle`, `underline`, `bracket`, and the existing `ellipse`, `label`, and `path` also work. Text wraps into padded cards placed beside targets when space permits. Notes can have a short heading. Styling and placement are handled by the native renderer, with no browser overlay or extra dependency.

Pen marks use two thin, slightly irregular strokes inspired by Rough Notation. Circles and underlines default to red; arrows, boxes, brackets, paths, and numbered markers use blue. Highlights retain a translucent citron wash, and labels retain the warm paper style. Custom colors still work. Stroke variation stays fixed across repaints.

| Annotation                                        | Optional text limit | Geometry in screenshot pixels                                                  |
| ------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| Circle / ellipse, rectangle, highlight, underline | 40 characters       | Target top-left `x/y`, full `width/height`                                     |
| Arrow                                             | 60 characters       | Target tip `x/y`; optionally supply `toX/toY` to use `x/y` as an explicit tail |
| Bracket                                           | 60 characters       | Target top-left `x/y`, full `width/height`; bracket appears on the right       |
| Numbered step                                     | 80 characters       | Marker center `x/y`, `step` from 1–9                                           |
| Note / legacy label                               | 160 characters      | Card origin `x/y`; note also accepts a 40-character `title`                    |
| Path                                              | 60 characters       | `x/y` and `points`                                                             |

All items need an `id`. Text is plain, not Markdown. A note needs text or a title; other visual marks work without words. For example, after `desktop_observe`, call `desktop_draw` with its current IDs:

```json
{
  "observationId": "<current observation ID>",
  "displayId": "<current display ID>",
  "items": [
    { "id": "settings", "kind": "circle", "x": 420, "y": 180, "width": 120, "height": 40 },
    { "id": "next", "kind": "step", "x": 400, "y": 200, "step": 1, "text": "Open Settings" }
  ]
}
```

Stop, lock, overview, display changes, disconnect, and task completion revoke the active desktop lease; a heartbeat expires abandoned sessions.

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
| `pnpm test:native`       | Local GNOME rendering, fullscreen pixels, click-through, marking, Stop/Escape/overview      |
| `pnpm test:native:ui`    | Native checks plus the packaged UI with integration available, unavailable, and reconnected |
| `pnpm test:native:agent` | Optional real-model UI request → drawing → window return → same-parent follow-up guidance   |

Native tests run in an isolated headless GNOME session with a synthetic GTK target. They require Python Pillow for pixel checks and print a temporary artifact directory for screenshots/logs. `pnpm test:sessions:agent` exercises real parent/child delegation, concurrent replies, history search, and result presentation without a desktop. It and `test:native:agent` use your configured credentials (the latter sends the synthetic desktop screenshots to the provider); all other checks make no model calls. The test driver is never installed in the user's desktop or bundled with the app.

Code layout:

- `electron/`: app lifecycle, agent sessions, desktop bridge/validation, and speech services.
- `native/`: authenticated D-Bus transport, GNOME drawing extension, and local speech worker.
- `src/`: React interface and voice interaction.
- `scripts/`: desktop install/status, speech setup, and the desktop launcher.
- `tests/`: unit tests and reusable native/UI integration harness.

Settings include working folder, model, wake word, launch at login, and automatic spoken replies. Environment overrides include `LINUX_BUDDY_MODEL`, `LINUX_BUDDY_WAKE_WORD`, `LINUX_BUDDY_STT_MODEL`, `LINUX_BUDDY_STT_PYTHON`, `LINUX_BUDDY_STT_THREADS`, `LINUX_BUDDY_PI_BIN`, and `LINUX_BUDDY_FFMPEG_BIN`. Activity reports model/tool/capture/transcription timings; hosted inference remains the main source of latency.
