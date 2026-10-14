#!/usr/bin/env python3
"""Check that this machine is ready to run Friday. Read-only; never prints credential values."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
failed = False


def report(ok, name, detail, required=True):
    global failed
    failed |= required and not ok
    mark = "✓" if ok else ("✗" if required else "–")
    print(f"{mark} {name}: {detail}")


def run(*command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        return result.returncode, (result.stdout + result.stderr).strip()
    except (OSError, subprocess.TimeoutExpired):
        return None, ""


def version(text):
    match = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text)
    return tuple(int(part or 0) for part in match.groups()) if match else (0,)


def env():
    values = {}
    path = root / ".env"
    if path.is_file():
        for line in path.read_text().splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and not key.startswith("#"):
                values[key.strip()] = value.strip().strip("'\"")
    # Like the app: the real environment wins over .env.
    return values | {key: value for key, value in os.environ.items() if value}


def has_files(directory, *names):
    return all((directory / name).is_file() for name in names)


def main():
    keys = env()
    print("Friday doctor\n")

    _, text = run("gnome-shell", "--version")
    report(version(text)[0] == 49, "GNOME Shell 49", text or "not found")
    _, text = run("node", "--version")
    report(version(text)[0] >= 22, "Node.js 22+", text or "not found; install nodejs")
    report(bool(shutil.which("pnpm")), "pnpm", "found" if shutil.which("pnpm") else "not found; run: npm install -g pnpm")
    report(sys.version_info >= (3, 12), "Python 3.12+", sys.version.split()[0])
    gi = run(sys.executable, "-c", "import gi")[0] == 0
    report(gi, "PyGObject", "found" if gi else "not found; install python3-gobject")
    for command, package in (("ffmpeg", "ffmpeg-free"), ("pw-cat", "pipewire-utils")):
        report(bool(shutil.which(command)), command, "found" if shutil.which(command) else f"not found; install {package}")
    report((root / "node_modules").is_dir(), "Dependencies", "installed" if (root / "node_modules").is_dir() else "run: pnpm install")

    pi = keys.get("LINUX_BUDDY_PI_BIN", "pi")
    _, text = run(pi, "--version")
    report(version(text) >= (0, 85, 1), "Pi 0.85.1+", text or "not found; run: npm install -g @earendil-works/pi-coding-agent")
    auth = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi/agent")) / "auth.json"
    try:
        signed_in = "openai-codex" in json.loads(auth.read_text())
    except (OSError, ValueError):
        signed_in = False
    report(signed_in, "ChatGPT sign-in for Pi", "found" if signed_in else "run pi, type /login and choose ChatGPT (Codex)")

    provider = keys.get("LINUX_BUDDY_STT_PROVIDER", "groq" if keys.get("GROQ_API_KEY") else "parakeet")
    if provider == "groq":
        report(bool(keys.get("GROQ_API_KEY")), "Speech recognition", "Groq" if keys.get("GROQ_API_KEY") else "add GROQ_API_KEY to .env")
    else:
        stt_python = Path(keys.get("LINUX_BUDDY_STT_PYTHON", data / "friday/stt-venv/bin/python"))
        files = ("config.json", "vocab.txt", "encoder-model.int8.onnx", "decoder_joint-model.int8.onnx")
        models = [Path(keys["LINUX_BUDDY_STT_MODEL"])] if keys.get("LINUX_BUDDY_STT_MODEL") else [
            data / "friday/parakeet-tdt-0.6b-v3-int8", data / "com.pais.handy/models/parakeet-tdt-0.6b-v3-int8"]
        ready = stt_python.is_file() and any(has_files(model, *files) for model in models)
        report(ready, "Speech recognition", "offline Parakeet" if ready else "add GROQ_API_KEY to .env, or run: pnpm stt:setup")

    tts = keys.get("LINUX_BUDDY_TTS_PROVIDER", "rumik" if keys.get("RUMIK_API_KEY") else "espeak")
    if tts == "rumik":
        report(bool(keys.get("RUMIK_API_KEY")), "Voice", "Rumik" if keys.get("RUMIK_API_KEY") else "add RUMIK_API_KEY to .env")
    else:
        espeak = bool(shutil.which("espeak-ng"))
        report(espeak, "Voice", "espeak (add RUMIK_API_KEY for a natural voice)" if espeak else "install espeak-ng, or add RUMIK_API_KEY to .env")

    wake = Path(keys.get("LINUX_BUDDY_WAKE_MODEL", data / "friday/wake-word/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"))
    ready = has_files(wake, "tokens.txt", "bpe.model")
    report(ready, "Wake word", "installed" if ready else "run: pnpm wake:setup")

    code, text = run(sys.executable, str(root / "scripts/desktop-command.py"))
    try:
        status = json.loads(text)
    except ValueError:
        status = {}
    if code == 0:
        display = status.get("display", {})
        size = (display.get("width"), display.get("height"), display.get("scale"))
        report(True, "Desktop extension", "ready")
        report(size == (1920, 1080, 1), "Display 1920×1080 at 100%", "yes" if size == (1920, 1080, 1) else
               f"{size[0]}×{size[1]} at {round((size[2] or 1) * 100)}%; drawings and computer control may be misplaced", False)
    else:
        report(False, "Desktop extension", status.get("actionRequired") or
               "run: pnpm desktop:install, then sign out of GNOME and back in once")

    built = (root / "dist-electron/main/index.js").is_file()
    report(built, "Build", "done" if built else "run: pnpm build")

    print()
    codex = keys.get("LINUX_BUDDY_CODEX_BIN", "codex")
    code, _ = run(codex, "login", "status")
    report(code == 0, "Computer control (optional)", "Codex signed in" if code == 0 else
           "install Codex CLI and run: codex login", False)
    report(bool(keys.get("TYPESAFE_API_KEY")), "Ignore background talk (optional)", "TypeSafe" if keys.get("TYPESAFE_API_KEY") else
           "add TYPESAFE_API_KEY to .env", False)

    print("\nReady. Run: pnpm start:desktop" if not failed else "\nFix the ✗ items above, then run pnpm doctor again.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
