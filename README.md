# Linux Buddy

A Linux-first floating desktop assistant MVP. Press **Ctrl+Shift+Space**, type a request, and Buddy plans typed tools, runs them in its background Electron process, streams progress, asks before consequential actions, and keeps durable local history even when its window is hidden.

## Run it

Requirements: Linux, Node.js 22+, pnpm, and a graphical X11/Wayland session.

```bash
pnpm install
pnpm dev
```

Production build and launch:

```bash
pnpm build
./release/linux-unpacked/linux-buddy
```

The window hides instead of terminating; use its tray menu to quit. Toggle **Launch at login** in Settings to use Electron's desktop autostart integration.

## Requests and providers

The default `demo` provider needs no key and supports useful offline phrases:

- `Show disk usage`, `Show running processes`, `List files`
- `Read README.md`, `Open https://example.com`
- `Run git status` or any single executable plus arguments

Shell syntax (`|`, `;`, redirects, command substitution) is rejected. Commands execute directly as a typed command/argv pair with an explicit working directory, capped timeout, cancellation signal, and bounded/redacted output.

For richer natural-language planning, this machine's authenticated Codex CLI is supported:

```bash
LINUX_BUDDY_PROVIDER=codex pnpm dev
# Optional custom location:
LINUX_BUDDY_CODEX_BIN=/path/to/codex LINUX_BUDDY_PROVIDER=codex pnpm dev
```

The Codex process only produces schema-validated tool plans in read-only mode. Linux Buddy—not model text—applies policy and executes each typed call. No credentials are stored by the app. `.env` files are gitignored.

## Safety model

- Known inspection commands and ordinary file listing/reading run immediately.
- Unknown state-changing commands, destructive commands, privilege escalation, publishing/network transfer, and potentially sensitive paths require explicit **Allow once** approval.
- `su` and `pkexec` are blocked. External URLs are restricted to HTTP(S).
- The prominent **Stop** button aborts provider and process execution. Child commands use no shell and are killed on timeout.
- History is an atomic, versioned JSON database at Electron's private app-data path (`~/.config/linux-buddy/tasks.json` on typical Linux installations), written mode `0600`. This is the SQLite-equivalent persistence layer for the MVP and is isolated behind `TaskStore` for a future SQLite migration.

## Architecture

```text
React palette (sandboxed renderer)
       │ typed IPC through context-isolated preload
       ▼
Electron main / durable TaskService ── atomic TaskStore
       │
       ├── Provider: deterministic demo or Codex CLI planner
       ├── Policy: risk classification and approval gate
       └── Tools: shell argv, bounded file inspection, open HTTP(S) URL
```

Closing the UI hides it while Electron's main process continues active jobs. Restart recovery marks any truly interrupted jobs failed instead of leaving them stuck. The provider and typed `ToolCall` union are deliberate extension points for Ollama/OpenAI-compatible providers, AT-SPI desktop tools, screen context, and browser automation.

## Stack decision

Electron was selected after inspecting the target host. Node 24 and GTK 3 are installed, while Rust/Cargo and WebKitGTK development packages are absent. Tauri 2 would require both a new language toolchain and native system packages before compiling; Electron provides a runnable MVP now without sacrificing the isolated main-process service, global shortcut, tray, or autostart requirements. Tauri remains viable if installed size becomes more important than the current zero-system-setup build.

## Quality checks

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Tests cover low/high-risk command decisions, sensitive paths, atomic persistence, successful execution, approval, denial, and final lifecycle state.

## Short roadmap

1. Wayland `xdg-desktop-portal` ScreenCast/PipeWire capture with explicit per-session consent; add OCR and bounded screenshot context.
2. Non-interactive, click-through overlay surfaces for highlights and task feedback across monitors.
3. AT-SPI accessibility-tree inspection and typed, approval-aware native UI actions.
4. Playwright browser bridge with a visible controlled profile, domain allowlists, and confirmation before form submission/publishing.
5. SQLite WAL storage, resumable task checkpoints, system notifications with action buttons, and optional user service packaging.
