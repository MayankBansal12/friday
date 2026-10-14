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
failed = False
config = {}


def report(ok, name, detail, required=True):
    global failed
    failed |= required and not ok
    mark = "✓" if ok else ("✗" if required else "–")
    print(f"{mark} {name}: {detail}")


def run(*command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20, env=config)
        return result.returncode, (result.stdout + result.stderr).strip()
    except (OSError, subprocess.TimeoutExpired):
        return None, ""


def version(text):
    match = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text)
    return tuple(int(part or 0) for part in match.groups()) if match else (0,)


def load_config():
    """Like the app's dotenv: .env fills in only what the environment does not already set."""
    values = {}
    path = root / ".env"
    if path.is_file():
        for line in path.read_text().splitlines():
            key, sep, value = line.strip().removeprefix("export ").partition("=")
            if not sep or key.startswith("#"):
                continue
            value = value.strip()
            quote = value[:1]
            if quote in ("'", '"') and quote in value[1:]:
                value = value[1:value.index(quote, 1)]
            else:
                value = re.sub(r"(^|\s)#.*", "", value).strip()
            values[key.strip()] = value
    return values | dict(os.environ)


def get(key, default=""):
    return config.get(key) or default


def has_files(directory, *names):
    return all((Path(directory) / name).is_file() for name in names)


def main():
    config.update(load_config())
    data = Path(get("XDG_DATA_HOME", Path.home() / ".local/share"))
    print("Friday doctor\n")

    _, text = run("gnome-shell", "--version")
    if text:
        # Built and tested on 49; other versions may need the extension adapted.
        report(version(text)[0] == 49, "GNOME Shell 49", text if version(text)[0] == 49 else
               f"{text}; Friday's extension targets 49 and may need adapting", False)
    else:
        report(False, "GNOME Shell", "not found; Friday's screen features need GNOME")
    _, text = run("node", "--version")
    report((22, 12) <= version(text) < (23,) or version(text) >= (24,), "Node.js 22.12+", text or "not found; install nodejs")
    report(bool(shutil.which("pnpm")), "pnpm", "found" if shutil.which("pnpm") else "not found; run: npm install -g pnpm")
    report(sys.version_info >= (3, 12), "Python 3.12+", sys.version.split()[0])
    gi = run(sys.executable, "-c", "import gi")[0] == 0
    report(gi, "PyGObject", "found" if gi else "not found; install PyGObject for this Python")
    for command, package in (("ffmpeg", "ffmpeg"), ("pw-cat", "PipeWire's command-line tools")):
        report(bool(shutil.which(command)), command, "found" if shutil.which(command) else f"not found; install {package}")
    report((root / "node_modules").is_dir(), "Dependencies", "installed" if (root / "node_modules").is_dir() else "run: pnpm install")

    _, text = run(get("LINUX_BUDDY_PI_BIN", "pi"), "--version")
    report(version(text) >= (0, 85, 1), "Pi 0.85.1+", text or "not found; run: npm install -g @earendil-works/pi-coding-agent")
    try:
        auth = json.loads((Path(get("PI_CODING_AGENT_DIR", Path.home() / ".pi/agent")) / "auth.json").read_text())
    except (OSError, ValueError):
        auth = {}
    # The app runs the default model through ChatGPT and every other model through OpenCode Go.
    # A model chosen in Friday's Settings is not visible here.
    if get("LINUX_BUDDY_MODEL", "gpt-6.1-sol") == "gpt-6.1-sol":
        ok = bool(auth.get("openai-codex"))
        report(ok, "ChatGPT sign-in for Pi", "found" if ok else "run pi, type /login and choose ChatGPT (Codex)")
    else:
        ok = bool(get("OPENCODE_API_KEY") or auth.get("opencode-go"))
        report(ok, "OpenCode Go for Pi", "found" if ok else "add OPENCODE_API_KEY to .env")

    stt = get("LINUX_BUDDY_STT_PROVIDER", "groq" if get("GROQ_API_KEY") else "parakeet")
    if stt == "groq":
        report(bool(get("GROQ_API_KEY")), "Speech recognition", "Groq" if get("GROQ_API_KEY") else "add GROQ_API_KEY to .env")
    elif stt == "parakeet":
        files = ("config.json", "vocab.txt", "encoder-model.int8.onnx", "decoder_joint-model.int8.onnx")
        models = [get("LINUX_BUDDY_STT_MODEL")] if get("LINUX_BUDDY_STT_MODEL") else [
            data / "friday/parakeet-tdt-0.6b-v3-int8", data / "com.pais.handy/models/parakeet-tdt-0.6b-v3-int8"]
        python = get("LINUX_BUDDY_STT_PYTHON", data / "friday/stt-venv/bin/python")
        ready = any(has_files(model, *files) for model in models) and \
            run(str(python), "-c", "import numpy, onnxruntime, onnx_asr")[0] == 0
        report(ready, "Speech recognition", "offline Parakeet" if ready else "add GROQ_API_KEY to .env, or run: pnpm stt:setup")
    else:
        report(False, "Speech recognition", f"unknown LINUX_BUDDY_STT_PROVIDER={stt}; use groq or parakeet")

    # The app falls back to espeak without a key; doctor wants that to be a choice, not an accident.
    tts = get("LINUX_BUDDY_TTS_PROVIDER", "rumik")
    if tts == "rumik":
        report(bool(get("RUMIK_API_KEY")), "Voice", "Rumik" if get("RUMIK_API_KEY") else
               "add RUMIK_API_KEY to .env, or set LINUX_BUDDY_TTS_PROVIDER=espeak for the offline voice")
    elif tts == "espeak":
        espeak = bool(shutil.which("espeak-ng"))
        report(espeak, "Voice", "offline espeak" if espeak else "install espeak-ng")
    else:
        report(False, "Voice", f"unknown LINUX_BUDDY_TTS_PROVIDER={tts}; use rumik or espeak")

    # Without the detector, Friday transcribes all speech to find the wake word, through Groq when that is selected.
    wake = get("LINUX_BUDDY_WAKE_MODEL", data / "friday/wake-word/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01")
    ready = has_files(wake, "bpe.model", "tokens.txt", "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
                      "decoder-epoch-12-avg-2-chunk-16-left-64.onnx", "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
    if get("LINUX_BUDDY_WAKE_DETECTOR") == "off":
        report(False, "On-device wake word", "turned off by LINUX_BUDDY_WAKE_DETECTOR; all speech is transcribed", False)
    else:
        report(ready, "On-device wake word", "installed" if ready else "run: pnpm wake:setup")

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

    built = has_files(root, "dist-electron/main/index.js", "dist/index.html")
    report(built, "Build", "done" if built else "run: pnpm build")

    print()
    code, _ = run(get("LINUX_BUDDY_CODEX_BIN", "codex"), "login", "status")
    report(code == 0, "Computer control (optional)", "Codex signed in" if code == 0 else
           "install Codex CLI and run: codex login", False)
    report(bool(get("TYPESAFE_API_KEY")), "Ignore background talk (optional)", "TypeSafe" if get("TYPESAFE_API_KEY") else
           "add TYPESAFE_API_KEY to .env", False)

    print("\nReady. Run: pnpm start:desktop" if not failed else "\nFix the ✗ items above, then run pnpm doctor again.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
