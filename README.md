# Friday

Friday is a voice-first desktop assistant for this Fedora 43 / GNOME 49 / Wayland machine. One parent Pi session answers you, guides you on screen, and delegates independent work to background child sessions. Friday can look, draw, and complete short GUI tasks. The parent uses OpenCode Go; computer control uses your signed-in Codex CLI.

See [the current request flow](docs/request-flow.md) for session boundaries, speech behavior, and the implementation diagram.

## Setup and launch

Requirements: Node.js 22+, pnpm, Python 3.12+ with venv/pip and PyGObject, GNOME Shell 49, `pi` 0.85.1+, local Parakeet V3 int8 ONNX model files (available through Handy), `ffmpeg`, and `espeak-ng`. Desktop integration currently supports the built-in 1920×1080 display at 100% scale.

Configure OpenCode Go through `OPENCODE_API_KEY` in `.env` or existing Pi authentication. See [.env.example](.env.example) for environment overrides.

For computer control, install Codex CLI (tested with 0.155.1), run `codex login`, and check `codex login status`. Your existing ChatGPT sign-in works; no separate OpenAI API key is required. Chat, speech, guidance, and background tasks still work without Codex. The operator uses the [Codex app-server protocol](https://developers.openai.com/codex/app-server) with Friday's bounded desktop tools.

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

`desktop:status` must report `ready: true` and `protocolVersion: 8` for screen guidance/control. GNOME caches loaded extension modules, so reopening Friday alone cannot activate an extension update. App-only changes need a rebuild and app restart, without another login.

The installer writes the extension to `~/.local/share/gnome-shell/extensions/friday-desktop@linux-buddy.local`, creates a private token at `~/.config/friday-desktop/token`, and enables Friday in GNOME. It does not restart the desktop or log you out.

For development, use `pnpm dev`. The local launch commands use `--no-sandbox` because this machine's Chromium sandbox is not configured; `pnpm dev:sandboxed` is available with a working sandbox. The packaged app is built in `release/linux-unpacked/`.

## Using Friday

- Friday opens in active listening. After ten seconds without a request, it rests and shows **Say “hey friday” to wake her up**. The local detector keeps listening in rest: “Hey Friday” opens a new request, and “Hey Friday, open my calendar” includes the request in one utterance.
- One top-center notch shows listening, work, speech, and drawing guidance, 5 px below the system panel. At rest it contracts to a smaller pill with the wake hint and Stop; listening and work use the full-width bar. Hover to open details, move away to collapse. Motion animates the size changes without scaling the text and respects reduced-motion preferences. Keyboard focus also opens details. There are no extra expand/collapse or microphone buttons in the bar. Drag the notch bar to move it anywhere inside the work area — it follows the pointer and remembers its spot across restarts.
- The notch always has **Stop Friday**. Clicking it or saying **“Friday stop”** cancels speech and all running actions, clears drawings, and returns an enabled microphone to rest. Explicit microphone-off remains off until enabled again.
- A voice request keeps the conversation engaged: Friday keeps listening while it works and speaks. Talking over Friday (two or more words besides “um”/“uh”, or anything addressed to Friday) stops its voice immediately, and the finished sentence replaces the unfinished request, so “no, the other one” works as a correction. Friday's own voice is filtered by the browser's echo canceller and an echo guard that drops transcripts matching what Friday was saying (within 1.5 s of it stopping); corrections containing words such as “no”, “not” or “instead” are never treated as echo. While Friday talks, a lone “yeah” or “okay” is treated as listening, not a new request; “no”, “wait” and addressed speech still count. If you pause mid-request and continue within 2.5 s, before Friday has acted or answered, the whole request is resubmitted instead of only its second half.
- While a voice request runs, Friday plays one short local acknowledgement clip (“hmm”, “okay”, “let's see”) from `assets/acknowledgements/`. It costs no voice request, is skipped when replies are muted (and for typed requests unless **Speak replies to typed requests** is on), and stops as soon as the answer, Stop, a new request or talk-over arrives. The notch shows your recognized words while you speak and for 3 s after the request is sent.
- Typed requests return to wake waiting and are answered on screen unless **Speak replies to typed requests** is on. Opening the text composer keeps only Stop recognition active, so nearby conversation cannot submit a request. Wake/Stop detection uses local Parakeet transcription with an 850 ms speech endpoint plus inference time; it is not an instant dedicated wake engine.
- Background tasks use the existing upper-right circle. Hover or focus it for updates; select a task to ask about it. Selection alone sends nothing. A new “Hey Friday” clears old task context. A task's own Stop affects only that task; the notch Stop cancels all work. Completed updates can be dismissed individually.
- **Guiding you** appears in the same notch only after a drawing is confirmed on screen. Screenshot-only work never enters guidance. Friday briefly hides for the screenshot itself, then returns without taking focus; drawing does not replace it with another box.
- Hover for **Type instead**, the microphone on/off toggle, and **Settings & history**. Settings/history contains previous requests and **Mark screen**. **New task** resets the parent conversation; normal requests reuse it.
- **Ctrl+Shift+Space** or the tray's **Talk to Friday** activates listening. **Ctrl+Shift+Escape** stops all work and recording. Native **Escape** clears the overlay and stops its desktop request.
- During computer control, the same notch shows **Controlling your computer · Esc twice to stop**. It passes clicks through and is excluded from the screenshots sent to the operator. Press Escape twice within 1.5 seconds, say **“Friday stop”**, or activate Friday to release control. Short speech updates continue alongside actions; the notch returns to its normal status when control finishes.
- Agent drawings are click-through and preserve normal pointer movement. Drawings expire after 30 seconds and clear when input, focus, or geometry changes make them stale. Guidance advances when you ask; it does not continuously watch the screen.
- Closing the window hides Friday; the tray menu has **Quit**. Quitting interrupts running children and saves their history. Reopening starts a new parent Pi session; all earlier sessions and the task registry stay searchable through the session tools, and interrupted children resume only on request.

Global shortcuts depend on GNOME granting them. **Read replies aloud** and **Speak replies to typed requests** are in Settings. Existing settings are preserved.

## How Friday replies

The parent replies only through one `interact` tool call with up to three actions, at most one of each:

- `speak_tool {text}`: short speech through the configured voice (Rumik streaming, or local espeak).
- `draw_tool {items}`: annotations on the latest `desktop_observe` screenshot, rendered by the GNOME extension. The host binds the observation and assigns annotation IDs; the model never passes them.
- `show_text_tool {text}`: plain text in the notch.

The whole call is validated before anything runs; a rejection lists every bad field and nothing happens. Otherwise each action reports its own status (`completed`, `scheduled`, `failed`, `suppressed` with a reason, `interrupted`, …). `timing: "parallel"` (default) starts everything at once. `timing: "together"` waits (up to 1.5 s) for the first playable audio, then draws and waits for GNOME's paint acknowledgement, then starts speech and text together. If the voice is not ready in time, the visuals go first and speech follows; if the drawing fails, its speech is suppressed. An identical repeated call returns `duplicate` and does nothing. There is no automatic speech: if the parent ends without an effective `interact`, its final text is shown silently.

Speech status reports its evidence honestly: `dispatch-estimate` (audio handed to `pw-cat`), `transport` (audio accepted by LiveKit), or `client-observed` (the Friday window detected audible energy from its playing voice element). None of these is an acoustic measurement of what you heard.

## Realtime voice through LiveKit (optional)

With `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` set (and optionally `LIVEKIT_ROOM`, default `friday`), audio uses a LiveKit room:

1. The Friday window publishes its echo-cancelled microphone to the room.
2. The main process subscribes and forwards 16 kHz frames to the same segmenter and local Parakeet recognizer as the direct path. There is one recognizer, and it runs locally.
3. The transcript goes to the same parent Pi session and model. There is no second LLM.
4. Rumik PCM from `speak_tool` is published as Friday's voice track. The window plays it through an audio element, which gives Chromium's echo canceller its reference.

Credentials stay in the main process. The renderer receives only a short-lived token for the `friday-listener` identity, which may publish only a microphone track. The URL must be `wss://`, or `ws://` on localhost.

Fallbacks are automatic and never silent:

- Unset configuration uses the direct microphone and `pw-cat`.
- If the room is unreachable, or main does not receive the published microphone within 3 s, Friday uses the direct microphone. Playback goes through LiveKit only while main is connected and the window reports its voice element is playing; otherwise it uses `pw-cat`.
- A listener that leaves mid-reply fails that reply rather than dropping it silently.
- Stop and barge-in clear the sender queue and mute audio already buffered in the window.

Parakeet is batch recognition. While you speak, the recorder re-decodes the growing segment to produce revisable partials, which drive barge-in. The final transcript comes only after the 850 ms end-of-speech pause (1.6 s when the words so far end mid-phrase, such as “open the”). Speech detection adapts to the room's noise floor, so quiet speech and soft word endings are kept; during Friday's playback it needs a louder onset. LiveKit reduces playback and transport latency; it does not make recognition streaming.

For development, run a local server such as `livekit-server --dev --bind 127.0.0.1` (key `devkey`, secret `secret`, URL `ws://127.0.0.1:7880`). Do not use development credentials for a remote server.

## Local speech recognition

`pnpm stt:setup` installs a pinned CPU ONNX runtime into `$XDG_DATA_HOME/friday/stt-venv` (default `~/.local/share/friday/stt-venv`). Friday reads the existing Parakeet V3 model in `$XDG_DATA_HOME/com.pais.handy/models/parakeet-tdt-0.6b-v3-int8`. It does not download model weights or invoke Handy. Set `LINUX_BUDDY_STT_MODEL` to a different local directory if needed; it must contain `config.json`, `vocab.txt`, `encoder-model.int8.onnx`, and `decoder_joint-model.int8.onnx`.

The Python worker starts when listening begins, stays loaded until Friday quits, and communicates over private process pipes. Recognition runs locally and temporary audio files are removed after each request. Model loading and inference have timeouts; a failed worker can restart on the next request. A custom environment can be installed with `pnpm stt:setup --venv /path/to/venv`; launch Friday with `LINUX_BUDDY_STT_PYTHON=/path/to/venv/bin/python` to use it. Both development and packaged apps use the same external runtime/model.

This is utterance-based recognition, not streaming: the existing recorder submits after a pause (850 ms) or microphone-button release, with a 25-second segment limit. The worker accepts up to 30 seconds. Keeping the model loaded avoids loading it for each utterance. `LINUX_BUDDY_STT_THREADS` controls CPU inference threads (default 4).

## Desktop integration and permissions

The parent Pi session exposes `desktop_observe`, `interact` (with `draw_tool`), `desktop_clear`, and `desktop_control`. Children cannot call screen or presentation tools. Observations carry fresh IDs and a 1440px JPEG; the host validates and maps screenshot coordinates to the native display. GNOME renders consistent sketch-style annotations and acknowledges drawing only after painting. Captures exclude overlays without erasing valid drawings. Visible overlays inhibit fullscreen display bypass and release that hold when hidden.

`desktop_control` runs one bounded Codex task within the parent's existing desktop lease. It supports clicks, double clicks, pointer movement, dragging, scrolling, text, key combinations, and drawing. Input batches consume one fresh observation and automatically return another screenshot. Drawings use a separate call after observing the changed screen. The operator has no shell, environment, browser, MCP, or plugin tools. Ordinary shell/file tasks stay with the parent because they are faster there.

GNOME cannot guarantee exclusive physical input while accepting Friday's virtual events. V0 shields the screen between short action bursts; physical input can get through during those bursts, and some system shortcuts or input-method composition can bypass the shield. A physical click may dismiss a popup. This reduces interference; it is not a security boundary or a complete keyboard/mouse lock. Avoid interacting until control finishes, or stop first. Hardware touchpad/touchscreen and non-default input methods still need hands-on validation.

Control is limited to four minutes, 25 action batches, and 60 tool calls. Each batch has at most 12 actions, 500 ASCII characters, and three seconds of explicit waits. ASCII typing is supported across the current backends; unsupported text fails explicitly. The native heartbeat expires within about 3.25 seconds if the app stops responding. Errors and cancellation release held keys/buttons and remove the shield. The operator asks when an exact consequential action or target has not been explicitly authorized; this is a model instruction, not a transaction-enforcement layer.

Screenshots for control are sent through Codex to its configured model using ephemeral threads. Friday does not read or copy Codex credentials, and retains only the operator summary/progress and timings in parent history. Model calls dominate latency: the runner batches predictable actions, uses low reasoning, keeps its authenticated process warm, and avoids the usual 180ms capture delay on each control step. `LINUX_BUDDY_COMPUTER_MODEL` optionally overrides the Codex model; otherwise `gpt-6-sol` is used.

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

`strike` and `cross` use the same box geometry as a rectangle. Text is plain, not Markdown. A note needs text or a title; other visual marks work without words. For example, after `desktop_observe`, call `interact`; the host binds the latest observation and assigns item IDs:

```json
{
  "timing": "together",
  "actions": [
    { "tool": "speak_tool", "args": { "text": "Open Settings here." } },
    {
      "tool": "draw_tool",
      "args": {
        "items": [
          { "kind": "circle", "x": 420, "y": 180, "width": 120, "height": 40 },
          { "kind": "step", "x": 400, "y": 200, "step": 1, "text": "Open Settings" }
        ]
      }
    }
  ]
}
```

Stop, lock, overview, display changes, disconnect, and task completion revoke the active desktop lease; a heartbeat expires abandoned sessions.

Normal agent requests also have file and shell tools running as the logged-in user. Consequential shell commands request confirmation through a heuristic check; this is not an operating-system sandbox. Screenshot/tool results are sent to the configured model and retained in local conversation files under Electron's user-data directory. Microphone audio is transcribed locally; recognized requests go to the model. Reply text goes to Rumik when it is the voice provider. With LiveKit configured, microphone and reply audio pass through that LiveKit server, so use a local or trusted one.

## Development and checks

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

| Command                     | Coverage                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm test:native`          | Local GNOME rendering, fullscreen pixels, click-through, marking, Stop/Escape/overview      |
| `pnpm test:native:ui`       | Native checks plus the packaged UI with integration available, unavailable, and reconnected |
| `pnpm test:native:agent`    | Optional real-model UI request → drawing → window return → same-parent follow-up guidance   |
| `pnpm test:native:computer` | Real signed-in Codex → isolated GTK input/menu → fresh visual verification → drawing        |

Manual renderer harnesses drive the real React app in `tests/presence-preview.html` with simulated media and IPC. Start Vite and a muted headless Chromium first, e.g. `pnpm vite --host 127.0.0.1 --port 5174` and `chromium --headless --remote-debugging-port=9333 --mute-audio`. `CDP_PORT` and `FRIDAY_PREVIEW_URL` select another pair.

| Command                                   | Coverage                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `node tests/native/notch-flow.mjs`        | Every notch state, wake/rest, engaged listening, replacement, Stop, guidance                 |
| `node tests/native/presence-speech.mjs`   | Playback, engaged listening while speaking, delayed replay races                             |
| `node tests/native/presence-review.mjs`   | Regression probes from the independent UX review                                             |
| `node tests/native/interact-flow.mjs`     | Barge-in on partials, voice/typed corrections while busy, echo drop, late-transcript fencing |
| `node tests/native/notch-audio.mjs`       | Synthetic speech through real local Parakeet and the React app                               |
| `node tests/native/livekit-transport.mjs` | Compiled main `LiveKitVoice` against a local server: synthetic mic in, voice out, abort      |
| `node tests/native/livekit-renderer.mjs`  | Real browser LiveKit SDK and `LiveKitLink` against main `LiveKitVoice` (CDP 9335)            |

The LiveKit harnesses need `pnpm desktop:build` and a local dev server (`LIVEKIT_TEST_URL`, `LIVEKIT_TEST_KEY`, `LIVEKIT_TEST_SECRET`; defaults `ws://127.0.0.1:18780`, `devkey`, `secret`). They use synthetic tones only, and their timings are transport-level, not acoustic. None of these harnesses use a physical microphone, speakers, a model or a hosted TTS service.

Native tests run in an isolated headless GNOME session with a synthetic GTK target. They require Python Pillow for pixel checks and print a temporary artifact directory for screenshots/logs. They check controlled input, independent input shielding, popup survival, Enter delivery, double Escape, stop during typing, watchdog release, and drawing/capture coexistence. `pnpm test:sessions:agent` exercises real parent/child delegation, concurrent replies, history search, and result presentation without a desktop. It and `test:native:agent` use Pi credentials; `test:native:computer` uses Codex login and sends only the synthetic desktop to its configured model. Other checks make no model calls. The test driver is never installed in the user's desktop or bundled with the app.

Code layout:

- `electron/`: app lifecycle, agent sessions, desktop bridge/validation, and speech services.
- `native/`: authenticated D-Bus transport, GNOME drawing extension, and local speech worker.
- `src/`: React interface and voice interaction.
- `scripts/`: desktop install/status, speech setup, and the desktop launcher.
- `tests/`: unit tests and reusable native/UI integration harness.

Settings include working folder, model, wake word, launch at login, spoken replies, and spoken replies to typed requests. Environment overrides include `LINUX_BUDDY_MODEL`, `LINUX_BUDDY_WAKE_WORD`, `LINUX_BUDDY_STT_MODEL`, `LINUX_BUDDY_STT_PYTHON`, `LINUX_BUDDY_STT_THREADS`, `LINUX_BUDDY_PI_BIN`, `LINUX_BUDDY_FFMPEG_BIN`, and the optional `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `LIVEKIT_ROOM`. Activity reports model/tool/capture/transcription timings; hosted inference remains the main source of latency.
