# Handoff: restrained desktop UI shipped

Linux Buddy is a complete Linux-first Electron MVP with a finished design-engineering pass. The renderer is now a dense, neutral desktop tool with clear task history, readable live output, deliberate approvals, an unmistakable Stop action, settings, and explicit loading, empty, and error states.

## Design and interaction state

- Keyboard invocation is instant. The window has no open or close animation and the composer regains focus whenever the shortcut shows it.
- Motion is limited to 120 ms transform-only press feedback and the status spinner. Hover states are pointer-gated, and reduced motion replaces rotation with an opacity pulse.
- The interface uses neutral surfaces, quiet system typography, precise borders and spacing, and a single restrained blue focus/status accent. There are no gradients, glows, or sparkle/orb decoration.
- Settings support keyboard focus, Escape, click-outside dismissal, save/error feedback, and a typed IPC focus listener.
- Approval, running, completed, stopped, failed, loading, and empty states were exercised in the real Electron renderer at both 720×760 and the 560×540 minimum size.
- A custom `>_` application icon is packaged and used by the tray. The Linux desktop filename, app ID, and `StartupWMClass` are synchronized.

## Verification on echio-staging

- `pnpm format:check`, `pnpm lint`, and `pnpm typecheck`: pass
- `pnpm test`: 5 files / 16 tests pass
- `pnpm build`: Vite production build and `release/linux-unpacked` Electron build pass
- `release/linux-buddy_0.1.0_amd64.deb`: produced (97 MB)
- Final Debian artifact SHA-256: `c444d6d7a8fd80b814cdbfd4e8d8433ec6b79ac70b318e17b0a4ff30dbe80a9a`
- The final `.deb` was installed temporarily and launched from `/opt/Linux Buddy` without `--no-sandbox`. Its renderer reported `--enable-sandbox`, `NoNewPrivs: 1`, and seccomp mode 2. The temporary install was then removed and the unpacked release restored.
- Chromium received `GlobalShortcutsPortal` and `GlobalShortcutsPortalPreferredTrigger`. This headless Debian host has no Wayland session or `xdg-desktop-portal` service, so the desktop consent dialog cannot be exercised here; the X11 registration path succeeded under Xvfb.

The safe typed-tool boundary remains intact. The only provider change fixes the documented “Show disk usage” and “Show running processes” demo phrases, with regression coverage.
