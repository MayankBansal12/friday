# Handoff: UI craft pass and ship

Current commit is a complete Linux-first Electron MVP: floating frameless palette, durable background `TaskService`, atomic private history store, demo and Codex CLI providers, typed shell/file/browser tools, cancellation, risk approvals, tray/autostart/global-shortcut hooks, notifications, and 13 passing tests.

## Verified on the source host

- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`: pass
- `pnpm test`: 4 files / 13 tests pass
- `pnpm build`: production Vite and `release/linux-unpacked` Electron build pass
- `release/linux-buddy_0.1.0_amd64.deb`: produced (97 MB)
- Live GNOME launch reached the rendered UI with a healthy CommonJS preload/IPC boundary.
- Ubuntu AppArmor blocks Chromium user namespaces for the unpacked directory. It was live-tested with `--no-sandbox`; the `.deb` is intended to provide the normal installed sandbox helper ownership.
- Wayland Global Shortcuts Portal is enabled. The original X11 shortcut grab was unavailable in GNOME; verify the portal flow on the new host.

## Next mission

Treat the existing UI as a functional draft, not a visual direction. Rework it into an exceptionally restrained desktop tool: simple, minimal, dense but calm, and free of AI-generic gradients, glowing purple orbs, excessive pills, marketing copy, and decorative sparkle iconography. Aim for the clarity of Linear, the restraint of Notion, and Emil Kowalski-level interaction craft without copying any product.

Use the `emil-design-eng` skill before design work and the `review-animations` skill for a final motion audit. Apply its principles directly:

- the keyboard-summoned palette opens instantly with no entrance animation;
- motion exists only for state continuity/feedback, uses strong custom curves, stays under 300 ms, and honors reduced motion;
- all pressables have subtle tactile active states;
- settings/approval surfaces have correct spatial origins and clear hierarchy;
- live task output should be readable and quiet, with excellent empty/loading/error states;
- approval and Stop remain unmistakable without making the whole product feel alarming;
- typography, spacing, borders, color, and density should carry the interface—not effects.

Work autonomously through implementation, visual launch/inspection, iteration, tests, build, and packaging. Preserve the safe typed-tool boundary. Do not stop at an audit or plan.
