# Friday implementation handoff

Linux Buddy's fixed command planner and terminal-output UI have been replaced by a voice-first desktop agent.

Implemented:

- Shortcut-triggered continuous microphone listening with utterance segmentation.
- Local Handy/Canary transcription and wake-word extraction.
- Pi RPC agent runs using the built-in `opencode-go` provider.
- Vision screenshots plus Linux mouse, keyboard, scroll, and open actions through nut.js.
- Native Pi confirmation requests and enforced high-risk shell gates.
- Conversational UI with activity, approvals, Stop, history, and settings.
- Private token-authenticated loopback desktop bridge.
- Packaged runtime copying of the standalone Pi extension from the Electron ASAR.

Status: ready for user manual testing. Automated and authenticated integration checks pass. Manual UX validation remaining:

1. Real microphone transcription accuracy and silence thresholds.
2. One file task, one browser task, and one multi-step GUI task.
3. A consequential action that produces Allow once / Don't allow.
4. Stop during a running shell tool and during a GUI workflow.
5. X11 desktop coordinate accuracy at the user's real scaling setting.

Wayland native input is not yet supported by nut.js; desktop mouse/keyboard control currently targets X11.
