#!/usr/bin/env python3
"""Install Friday's isolated CPU STT runtime; reuse models already downloaded by Handy."""

import argparse
import os
from pathlib import Path
import subprocess
import sys
import venv


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
    model = Path(os.environ.get("LINUX_BUDDY_STT_MODEL", data / "com.pais.handy/models/parakeet-tdt-0.6b-v3-int8"))
    print(f"STT Python: {python}")
    print(f"Parakeet model: {model} ({'found' if model.is_dir() else 'missing; download Parakeet V3 in Handy'})")
    if directory != data / "friday/stt-venv":
        print(f"Set LINUX_BUDDY_STT_PYTHON={python} when launching Friday.")


if __name__ == "__main__":
    main()
