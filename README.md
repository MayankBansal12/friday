# Friday

Friday is a voice-first desktop assistant for this Fedora 43 / GNOME 49 / Wayland machine. One parent Pi session answers you, guides you on screen, and delegates independent work to background child sessions. Friday can look, draw, and complete short GUI tasks. The parent defaults to GPT 6.1 Sol through Pi’s Codex provider; computer control uses your signed-in Codex CLI.

See [the current request flow](docs/request-flow.md) for session boundaries, speech behavior, and the implementation diagram.

## Setup and launch

Requirements: Node.js 22+, pnpm, Python 3.12+ with venv/pip and PyGObject, GNOME Shell 49, `pi` 0.85.1+, `ffmpeg`, and `espeak-ng`. Desktop integration currently supports the built-in 1920×1080 display at 100% scale.

Configure Pi authentication for `openai-codex` to use the default GPT 6.1 Sol. Other model choices use OpenCode Go through `OPENCODE_API_KEY` in `.env` or existing Pi authentication. See [.env.example](.env.example) for environment overrides.

Speech recognition is hosted Groq Whisper (`whisper-large-v3-turbo`, multilingual) when `GROQ_API_KEY` is set; otherwise it falls back to local Parakeet V3, which additionally needs the int8 ONNX model files (available through Handy) and `pnpm stt:setup`.

For computer control, install Codex CLI (tested with 0.155.1), run `codex login`, and check `codex login status`. Your existing ChatGPT sign-in works; no separate OpenAI API key is required. Chat, speech, guidance, and background tasks do not require the Codex CLI. The operator uses the [Codex app-server protocol](https://developers.openai.com/codex/app-server) with Friday's bounded desktop tools.

```sh
pnpm install
pnpm stt:setup
pnpm wake:setup
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

- Friday opens in active listening. After ten seconds without a request, it rests and shows **Say “hey friday” to wake her up**. The on-device wake word detector (see [Wake word](#wake-word)) keeps listening in rest: “Hey Friday” opens a new request, and “Hey Friday, open my calendar” includes the request in one utterance.
- One top-center notch shows listening, work, speech, and drawing guidance, 5 px below the system panel. At rest it contracts to a smaller pill with the wake hint and microphone toggle; listening and work use the full-width bar. Hover to open details, move away to collapse. Motion animates the size changes without scaling the text and respects reduced-motion preferences. Keyboard focus also opens details. Hover or focus the pill to reveal the workspace icon. Drag the notch bar to move it anywhere inside the work area — it follows the pointer and remembers its spot across restarts. Dragging closes the hover panel, which stays closed after the drop until the pointer leaves and returns. It opens downward wherever its panel fits below the bar; near the bottom of the screen, where it doesn't, it opens upward instead, with its bar staying under the pointer.
- The notch shows **Stop Friday** while work, speech, guidance, or computer control is active. Clicking it cancels speech and all running actions, clears drawings, and returns an enabled microphone to rest. Explicit microphone-off remains off until enabled again. Use the tray’s **Quit** to close Friday.
- A voice request keeps the conversation engaged: Friday keeps listening while it works and speaks. Talking over Friday (two or more words besides “um”/“uh”, or anything addressed to Friday) stops its voice immediately, and the finished sentence replaces the unfinished request, so “no, the other one” works as a correction. Friday's own voice is filtered by the browser's echo canceller and an echo guard that drops transcripts matching what Friday was saying (within 1.5 s of it stopping); corrections containing words such as “no”, “not” or “instead” are never treated as echo. While Friday talks, a lone “yeah” or “okay” is treated as listening, not a new request; “no”, “wait” and addressed speech still count. If you pause mid-request and continue within 2.5 s, before Friday has acted or answered, the whole request is resubmitted instead of only its second half.
- While a voice request runs, Friday plays one short local acknowledgement clip (“hmm”, “okay”, “let's see”) from `assets/acknowledgements/`. It costs no voice request, is skipped when replies are muted (and for typed requests unless **Speak replies to typed requests** is on), and stops as soon as the answer, Stop, a new request or talk-over arrives. The notch shows your recognized words while you speak and for 3 s after the request is sent.
- Typed requests return to wake waiting and are answered on screen unless **Speak replies to typed requests** is on. Opening the text composer pauses recognition, so nearby conversation cannot submit a request.
- There is no spoken stop keyword. Ask Friday in your own words (“stop everything”, “forget all of that”) and it calls its `stop_all` tool to cancel every background task, then confirms what it stopped; for one named task it stops only that task, and when the target is unclear it asks. Any new voice request already interrupts Friday's current reply.
- Background tasks use the existing upper-right circle. Hover or focus it for updates; select a task to ask about it. Selection alone sends nothing. A new “Hey Friday” clears old task context. A task's own Stop affects only that task; the notch Stop cancels all work. Completed updates can be dismissed individually.
- **Guiding you** appears in the same notch only after a drawing is confirmed on screen. Screenshot-only work never enters guidance. Friday briefly hides for the screenshot itself, then returns without taking focus; drawing does not replace it with another box.
- Hover to type in the bottom input or open the workspace from the header. The workspace contains conversation, history, settings, and **Mark screen**. **New conversation** resets the parent conversation; normal requests reuse it.
- **Ctrl+Shift+Space** or the tray's **Talk to Friday** activates listening. **Ctrl+Shift+Escape** stops all work and recording. Native **Escape** clears the overlay and stops its desktop request.
- During computer control, the same notch shows **Controlling your computer · Esc twice to stop**. It passes clicks through and is excluded from the screenshots sent to the operator. Press Escape twice within 1.5 seconds, click Stop, or activate Friday to release control. Short speech updates continue alongside actions; the notch returns to its normal status when control finishes.
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
2. The main process subscribes and forwards 16 kHz frames to the same segmenter and recognizer as the direct path. There is one recognizer, and it follows the configured STT provider.
3. The transcript goes to the same parent Pi session and model. There is no second LLM.
4. Rumik PCM from `speak_tool` is published as Friday's voice track. The window plays it through an audio element, which gives Chromium's echo canceller its reference.

Credentials stay in the main process. The renderer receives only a short-lived token for the `friday-listener` identity, which may publish only a microphone track. The URL must be `wss://`, or `ws://` on localhost.

Fallbacks are automatic and never silent:

- Unset configuration uses the direct microphone and `pw-cat`.
- If the room is unreachable, or main does not receive the published microphone within 3 s, Friday uses the direct microphone. Playback goes through LiveKit only while main is connected and the window reports its voice element is playing; otherwise it uses `pw-cat`.
- A listener that leaves mid-reply fails that reply rather than dropping it silently.
- Stop and barge-in clear the sender queue and mute audio already buffered in the window.

Transcription is batch recognition. While you speak, the recorder re-decodes the growing segment to produce revisable partials, which drive barge-in. The final transcript comes only after the 850 ms end-of-speech pause (1.6 s when the words so far end mid-phrase, such as “open the”). Speech detection adapts to the room's noise floor, so quiet speech and soft word endings are kept; during Friday's playback it needs a louder onset. LiveKit reduces playback and transport latency; it does not make recognition streaming.

For development, run a local server such as `livekit-server --dev --bind 127.0.0.1` (key `devkey`, secret `secret`, URL `ws://127.0.0.1:7880`). Do not use development credentials for a remote server.

## Speech recognition

Hosted Groq Whisper (`whisper-large-v3-turbo`) is used when `GROQ_API_KEY` is present in `.env`. It recognizes 99+ languages including Hindi with auto-detection, needs no local model, and returns in roughly half a second. Every utterance audio is uploaded to Groq — that is the tradeoff for multilingual capture. Set `LINUX_BUDDY_STT_PROVIDER=parakeet` to force the offline engine, `LINUX_BUDDY_GROQ_STT_MODEL` to change the model, or `LINUX_BUDDY_GROQ_STT_LANGUAGE` (an ISO code such as `hi`) to pin a language instead of auto-detection. The key is removed from the environment before agents or audio helpers start.

### Speech while Friday is busy

When `TYPESAFE_API_KEY` is set, speech that is not addressed with "Hey Friday" while Friday works or talks goes to TypeSafe's Jev decision model (`jev-latest`, about 300 ms) before it can cancel the current turn. Jev sees the transcript, the current request and what Friday last said, and answers `interrupt` or `ignore`. A confident `ignore` (a phone call, TV, filler, a mis-transcription) is shown dimmed in the notch as "Ignored" and Friday keeps going; click it to send it anyway, or say the same thing again within 15 seconds and it goes straight through. Corrections that start with "no", "wait", "stop", "actually" and similar skip the check, and any Jev error or timeout (1.5 s) falls back to interrupting. The transcript text is sent to TypeSafe. Set `LINUX_BUDDY_TURN_GATE=off` to disable it.

### Wake word

At rest, microphone audio never leaves the machine. A small on-device keyword spotter ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) with the 3.3M-parameter GigaSpeech zipformer, about 3% of one CPU core) listens only for “Hey” plus the configured wake word. Only after it fires is audio transcribed: the last two seconds are replayed so the phrase is not clipped, and the transcript must actually contain “Hey Friday” or the wake is discarded. Follow-ups during an engaged conversation need no wake phrase. `pnpm wake:setup` downloads the ~13 MB model into `$XDG_DATA_HOME/friday/wake-word/`. Without the model (or with `LINUX_BUDDY_WAKE_DETECTOR=off`) Friday falls back to transcribing all speech and matching the wake word in text, which uploads everything to Groq when that provider is active. `LINUX_BUDDY_WAKE_MODEL` points to another model directory; `LINUX_BUDDY_WAKE_SCORE` (default 1.5, higher triggers more easily) and `LINUX_BUDDY_WAKE_THRESHOLD` (default 0.25, lower triggers more easily) tune sensitivity. Periodic interim re-decodes are off with Groq. A continuing turn is probed after eight seconds to distinguish wordless noise from a long request, so a long utterance can make a probe request plus its final transcription. If a probe finds only noise and trims it, another probe may follow while the same turn continues; the 25-second turn limit still applies.

Without a key, recognition runs fully offline through local Parakeet V3. `pnpm stt:setup` installs a pinned CPU ONNX runtime into `$XDG_DATA_HOME/friday/stt-venv` (default `~/.local/share/friday/stt-venv`). Friday reads the existing Parakeet V3 model in `$XDG_DATA_HOME/com.pais.handy/models/parakeet-tdt-0.6b-v3-int8`. It does not download model weights or invoke Handy. Set `LINUX_BUDDY_STT_MODEL` to a different local directory if needed; it must contain `config.json`, `vocab.txt`, `encoder-model.int8.onnx`, and `decoder_joint-model.int8.onnx`. Parakeet V3 covers 25 European languages; Hindi is not among them, so multilingual use needs Groq.

The Python worker starts when listening begins, stays loaded until Friday quits, and communicates over private process pipes. Recognition runs locally and temporary audio files are removed after each request. Model loading and inference have timeouts; a failed worker can restart on the next request. A custom environment can be installed with `pnpm stt:setup --venv /path/to/venv`; launch Friday with `LINUX_BUDDY_STT_PYTHON=/path/to/venv/bin/python` to use it. Both development and packaged apps use the same external runtime/model.

This is utterance-based recognition, not streaming: the existing recorder submits after a pause (850 ms) or microphone-button release, with a 25-second segment limit. The worker accepts up to 30 seconds. Keeping the model loaded avoids loading it for each utterance. `LINUX_BUDDY_STT_THREADS` controls CPU inference threads (default 4).

## Desktop integration and permissions

**Camera** is enabled by default in Settings. Ask “Look at me”, “What am I holding?”, or “Watch while I turn this”. Friday's parent session calls `camera_look`, which turns the webcam on and returns the latest frame, or up to six frames spread over 1–10 `seconds` to watch a movement. The camera then stays live, so follow-ups like “check now” see the scene immediately. You can also turn it on with the camera button next to the microphone.

While the camera is on, Friday reveals its window without taking focus and switches to camera mode: the notch stays expanded with a live video of the whole frame the camera sees above the conversation, and the workspace shows the same video above its transcript. On short screens the video shrinks first so the conversation and composer stay usable. The preview is mirrored like a video call; the model gets unmirrored frames. The status line narrates the camera: **Starting your camera to see…**, **Looking through your camera…**, **Watching for 5s…**, **Looked through your camera**, **Turning your camera off…**. While Friday takes frames the video gets a lime ring; between looks it reads **Friday only sees when it looks**. While the camera is on, a voice conversation stays awake for a minute between requests instead of ten seconds; when Friday goes back to sleep, the camera turns off with her. It also turns off after a minute with no request or look, with its off button, when Friday calls `camera_off`, on Stop, New conversation, disabling camera access, closing or minimizing Friday (by any means), a renderer crash or reload, or Quit. It stays off while Friday controls the desktop, since that hides Friday's window. If the camera stops on its own (unplugged, stalled, busy), Friday shows why. Each conversation turn that used the camera is marked “Looked through your camera” on Friday's side. Friday looks only through explicit tool calls; streaming frames feed the preview, not the model. Background children cannot use the camera.

Switching camera access off in Settings is remembered across restarts. Frames Friday looked at are sent to your configured model and retained in Pi's local conversation history, like screenshots; no separate photo file is created. Earlier frames may be sent again with later turns in that conversation, even after camera access is turned off. **New conversation** stops using the old context; it does not delete the saved history. The setting gates Friday's camera tools, not arbitrary shell access. Camera frames cannot be used as desktop drawing observations.

Linux capture uses the existing `ffmpeg` dependency with Video4Linux2 (`/dev/video0` by default; override with `LINUX_BUDDY_CAMERA_DEVICE=/dev/video2` or a stable `/dev/v4l/by-id/…` / `/dev/v4l/by-path/…` device). The stream runs at five frames per second, scaled to at most 1024×768, skips the first half second for exposure, and closes if the camera does not start within ten seconds or stops sending frames for five. Missing, busy, or inaccessible devices return a setup message. Friday opens the device directly rather than through PipeWire, so desktop privacy indicators that track PipeWire camera access may not show it; Friday's preview is the indicator. Whether the webcam light turns on is up to the camera hardware. If a wedged device will not close, Friday keeps **Camera on · Closing…** visible and refuses to reopen it, while Stop, new requests, and Quit remain available. Reconnect the webcam if its light stays on. See [FFmpeg's Video4Linux2 documentation](https://ffmpeg.org/ffmpeg-devices.html#video4linux2_002c-v4l2).

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

| Command                                   | Coverage                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `node tests/native/notch-flow.mjs`        | Every notch state, wake/rest, engaged listening, replacement, Stop, guidance                                 |
| `node tests/native/presence-speech.mjs`   | Playback, engaged listening while speaking, delayed replay races                                             |
| `node tests/native/presence-review.mjs`   | Regression probes from the independent UX review                                                             |
| `node tests/native/interact-flow.mjs`     | Barge-in on partials, voice/typed corrections while busy, echo drop, late-transcript fencing                 |
| `node tests/native/camera.mjs`            | Real FFmpeg live frames, close, and reopen using synthetic video (build desktop first)                       |
| `node tests/native/notch-drag.mjs`        | Dragging the pill closes its hover panel, which stays closed until the pointer returns (CDP 9338, Vite 5178) |
| `node tests/native/notch-bottom.mjs`      | A notch dragged to the bottom opens upward and keeps its bar under the pointer (CDP 9338, Vite 5178)         |
| `node tests/native/camera-ui.mjs`         | Live preview, camera button, Stop, transcript, and Settings on/off (CDP 9338, Vite 5178)                     |
| `node tests/native/notch-audio.mjs`       | Synthetic speech through real local Parakeet and the React app                                               |
| `node tests/native/livekit-transport.mjs` | Compiled main `LiveKitVoice` against a local server: synthetic mic in, voice out, abort                      |
| `node tests/native/livekit-renderer.mjs`  | Real browser LiveKit SDK and `LiveKitLink` against main `LiveKitVoice` (CDP 9335)                            |

The LiveKit harnesses need `pnpm desktop:build` and a local dev server (`LIVEKIT_TEST_URL`, `LIVEKIT_TEST_KEY`, `LIVEKIT_TEST_SECRET`; defaults `ws://127.0.0.1:18780`, `devkey`, `secret`). They use synthetic tones only, and their timings are transport-level, not acoustic. None of these harnesses use a physical microphone, speakers, a model or a hosted TTS service.

Native tests run in an isolated headless GNOME session with a synthetic GTK target. They require Python Pillow for pixel checks and print a temporary artifact directory for screenshots/logs. They check controlled input, independent input shielding, popup survival, Enter delivery, double Escape, stop during typing, watchdog release, and drawing/capture coexistence. `pnpm test:sessions:agent` exercises real parent/child delegation, concurrent replies, history search, and result presentation without a desktop. It and `test:native:agent` use Pi credentials; `test:native:computer` uses Codex login and sends only the synthetic desktop to its configured model. Other checks make no model calls. The test driver is never installed in the user's desktop or bundled with the app.

Code layout:

- `electron/`: app lifecycle, agent sessions, desktop bridge/validation, and speech services.
- `native/`: authenticated D-Bus transport, GNOME drawing extension, and local speech worker.
- `src/`: React interface and voice interaction.
- `scripts/`: desktop install/status, speech setup, and the desktop launcher.
- `tests/`: unit tests and reusable native/UI integration harness.

Settings include working folder, model, wake word, launch at login, spoken replies, and spoken replies to typed requests. Environment overrides include `LINUX_BUDDY_MODEL`, `LINUX_BUDDY_WAKE_WORD`, `LINUX_BUDDY_STT_MODEL`, `LINUX_BUDDY_STT_PYTHON`, `LINUX_BUDDY_STT_THREADS`, `LINUX_BUDDY_WAKE_MODEL`, `LINUX_BUDDY_WAKE_DETECTOR`, `LINUX_BUDDY_WAKE_SCORE`, `LINUX_BUDDY_WAKE_THRESHOLD`, `LINUX_BUDDY_PI_BIN`, `LINUX_BUDDY_FFMPEG_BIN`, and the optional `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `LIVEKIT_ROOM`. Activity reports model/tool/capture/transcription timings; hosted inference remains the main source of latency.
