# Friday

Friday is a voice-first Linux desktop agent. Press **Ctrl+Shift+Space** and speak naturally. Saying **“Friday”** first is optional; when used, the wake word is removed before the request is sent. Audio is transcribed locally with the Canary model already installed through Handy and the recognized request is sent to a Pi agent running on OpenCode Go.

Example:

> “...anything before this is ignored... Friday, open my downloads and sort the screenshots into a folder.”

Friday can inspect and control the visible desktop, use applications and the browser, work with files, and run terminal tools. Its interface shows a conversational answer and concise activity instead of dumping command output. It works autonomously and asks only before consequential actions such as deletion, privilege escalation, purchases, sending, publishing, or exposing sensitive information.

## Requirements

- Linux graphical session (X11 is currently required for mouse/keyboard control)
- Node.js 22+ and pnpm
- `pi` 0.80+ on `PATH`
- `handy` with the `canary-180m-flash` model installed
- `ffmpeg`
- `OPENCODE_API_KEY`

The target machine already has Pi, Handy, FFmpeg, and the Canary Q8 model. `pnpm dev` passes Electron `--no-sandbox` because this host blocks Chromium user namespaces and the pnpm SUID helper is not root-owned. This exception is for local development only; use `pnpm dev:sandboxed` on a host with a correctly configured Chromium sandbox.

## Run

```bash
pnpm install
pnpm dev
```

Build the unpacked desktop app:

```bash
pnpm build
./release/linux-unpacked/linux-buddy
```

The window hides instead of quitting. Use the tray menu to quit. The shortcut always opens Friday and starts listening.

## Voice flow

1. The shortcut or tray icon opens Friday and enables the microphone.
2. Silence closes each local utterance and sends it to Handy's batch Canary transcription.
3. The recognized utterance becomes the request. If it contains the configured wake word, speech before it is discarded and the wake word is stripped.
4. If the user says only “Friday,” the next utterance becomes the command.
5. A detected request starts a Pi RPC session with the selected `opencode-go` model.
6. Pi streams assistant text, tools, completion, and native confirmation requests into the UI.

Canary audio is not sent to a speech service. The recognized command is sent to OpenCode Go for the agent run. When a task requires visual desktop interaction, Friday also sends the captured screenshot to the selected OpenCode Go model; the authenticated bridge itself remains loopback-only.

## Desktop tools and safety

Friday's Pi extension exposes two typed tools:

- `desktop_observe`: captures the desktop for the vision-capable model.
- `desktop_action`: clicks, types, presses keys, scrolls, or opens a path/URL.

The bridge binds to a random loopback port and requires a per-launch 256-bit bearer token. The token is passed only to the Pi child process. The extension enforces confirmation for high-risk shell patterns and asks the model to declare consequential GUI actions through Pi's confirmation protocol. Stop aborts the active Pi turn and terminates it if needed.

## Configuration

Environment overrides:

```bash
OPENCODE_API_KEY=...
LINUX_BUDDY_MODEL=kimi-k2.6
LINUX_BUDDY_WAKE_WORD=Friday
LINUX_BUDDY_STT_MODEL=handy-computer/canary-180m-flash-gguf/canary-180m-flash-Q8_0.gguf
LINUX_BUDDY_PI_BIN=pi
LINUX_BUDDY_HANDY_BIN=handy
LINUX_BUDDY_FFMPEG_BIN=ffmpeg
```

The UI also supports wake word, working folder, model, and launch-at-login settings.

## Quality checks

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
