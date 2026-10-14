# Friday

Friday is a voice assistant that lives on your Linux desktop. Say "Hey Friday", ask for something, and she answers out loud, points things out on your screen, or does the work for you.

## What Friday can do

- **Talks with you.** Say "Hey Friday" and just talk. Interrupt or correct her mid-sentence and she adapts. While she rests, she listens for her name on your laptop and sends nothing anywhere.
- **Shows you where.** Ask how to do something and she circles, points, and numbers the steps right on your screen.
- **Does it for you.** She can click and type through short tasks on your desktop. Press Escape twice to take back control.
- **Works in the background.** Hand off longer tasks and keep talking. Check on them from the small circle in the corner.
- **Sees through your camera.** "What am I holding?" or "Watch while I turn this."
- **Understands many languages,** including Hindi with Groq speech recognition.

## Install

Friday runs on Fedora 43 with GNOME 49 on Wayland, on a 1920×1080 display at 100% scale.

You'll need:

- A ChatGPT subscription. Friday thinks with it through [Pi](https://pi.dev), and uses [Codex](https://developers.openai.com/codex/cli) to control your computer.
- A [Groq API key](https://console.groq.com/keys) for speech recognition (free tier works). Without one, Friday downloads a 670 MB offline model instead.
- A [Rumik](https://rumik.ai) API key for a natural voice (optional). Without one, Friday uses a robotic offline voice.

Paste this into your coding agent (Claude Code, Codex, or similar):

```text
Set up Friday on this laptop: https://github.com/MayankBansal12/friday

1. Install git, Node.js 22.12+, and pnpm if they are missing. Clone the repo,
   run `pnpm install`, then run `pnpm doctor`. Doctor is the checklist: it
   lists every missing piece and how to fix it.
2. Install missing system packages with dnf. Ask me before using sudo.
3. Run `pnpm wake:setup`, `pnpm desktop:install`, and `pnpm build`.
4. Copy `.env.example` to `.env`. Never ask me to paste API keys into this
   chat. Tell me which keys to add to `.env` myself: GROQ_API_KEY for speech
   recognition and, optionally, RUMIK_API_KEY for a natural voice. If I have
   no Groq key, run `pnpm stt:setup` for offline speech recognition instead.
5. I have to do some steps myself. Tell me when, and wait for me:
   - Sign Pi in to ChatGPT: run `pi`, type `/login`, and choose ChatGPT.
   - Sign Codex in for computer control: `codex login`.
   - After `pnpm desktop:install`, sign out of GNOME and back in once.
6. Run `pnpm doctor` again until nothing is marked ✗, then start Friday with
   `pnpm start:desktop`.
```

Everything else, including settings, privacy, and how Friday works, is in the [guide](docs/guide.md).
