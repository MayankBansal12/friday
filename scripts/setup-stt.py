#!/usr/bin/env python3
"""Install Friday's offline speech recognition: a CPU ONNX runtime and Parakeet V3 (~670 MB)."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import venv

MODEL = "parakeet-tdt-0.6b-v3-int8"
REPO = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce"
# Exact sizes catch a download the server cut short.
FILES = {
    "config.json": 97,
    "vocab.txt": 93939,
    "decoder_joint-model.int8.onnx": 18202004,
    "encoder-model.int8.onnx": 652183999,
}


def installed(directory):
    return all((directory / name).is_file() and (directory / name).stat().st_size == size for name, size in FILES.items())


def download(target):
    target.parent.mkdir(parents=True, exist_ok=True)
    # Download beside the target and rename at the end, so an interrupted run leaves no partial model.
    temp = Path(tempfile.mkdtemp(prefix=f".{MODEL}-", dir=target.parent))
    try:
        for name in FILES:
            print(f"Downloading {name}")
            with urllib.request.urlopen(f"{REPO}/{name}", timeout=60) as response, (temp / name).open("wb") as out:
                shutil.copyfileobj(response, out, 1 << 20)
        if not installed(temp):
            raise SystemExit("The Parakeet download was incomplete. Run pnpm stt:setup again.")
        shutil.rmtree(target, ignore_errors=True)
        temp.rename(target)
    finally:
        shutil.rmtree(temp, ignore_errors=True)


def main():
    if sys.version_info < (3, 12):
        raise SystemExit("Friday's pinned STT runtime requires Python 3.12 or newer.")
    data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    parser = argparse.ArgumentParser()
    parser.add_argument("--venv", type=Path, default=data / "friday/stt-venv")
    args = parser.parse_args()
    directory = args.venv.expanduser().resolve()
    venv.EnvBuilder(with_pip=True).create(directory)
    python = directory / "bin/python"
    requirements = Path(__file__).resolve().parent.parent / "native/stt-requirements.txt"
    subprocess.run([
        str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir",
        "-r", str(requirements),
    ], check=True)
    print(f"STT Python: {python}")
    if directory != data / "friday/stt-venv":
        print(f"Set LINUX_BUDDY_STT_PYTHON={python} when launching Friday.")

    own = data / "friday" / MODEL
    handy = data / "com.pais.handy/models" / MODEL
    if os.environ.get("LINUX_BUDDY_STT_MODEL"):
        model = Path(os.environ["LINUX_BUDDY_STT_MODEL"]).expanduser()
        if not installed(model):
            raise SystemExit(f"LINUX_BUDDY_STT_MODEL={model} is missing Parakeet V3 int8 files. Unset it to download the model.")
        print(f"Parakeet model: {model}")
    elif installed(own) or (installed(handy) and not own.exists()):
        print(f"Parakeet model: {own if installed(own) else handy} (already installed)")
    else:
        download(own)
        print(f"Parakeet model: {own}")


if __name__ == "__main__":
    main()
