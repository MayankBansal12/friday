#!/usr/bin/env python3
"""Download Friday's local "Hey Friday" detector (sherpa-onnx keyword spotter, ~13 MB)."""

import argparse
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request

MODEL = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/{MODEL}.tar.bz2"
FILES = (
    "bpe.model",
    "tokens.txt",
    "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
    "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
)


def main():
    data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", type=Path, default=data / "friday/wake-word" / MODEL)
    args = parser.parse_args()
    target = args.dir.expanduser().resolve()
    if all((target / name).is_file() for name in FILES):
        print(f"Wake word model: {target} (already installed)")
        return
    with tempfile.TemporaryDirectory() as temp:
        archive = Path(temp) / "model.tar.bz2"
        print(f"Downloading {URL}")
        with urllib.request.urlopen(URL, timeout=60) as response, archive.open("wb") as out:
            shutil.copyfileobj(response, out)
        with tarfile.open(archive) as tar:
            members = [m for m in tar.getmembers() if m.isfile() and Path(m.name).name in FILES]
            if len(members) != len(FILES):
                raise SystemExit("The downloaded wake word archive is missing model files.")
            target.mkdir(parents=True, exist_ok=True)
            for member in members:
                with tar.extractfile(member) as source, (target / Path(member.name).name).open("wb") as out:
                    shutil.copyfileobj(source, out)
    print(f"Wake word model: {target}")
    if target != (data / "friday/wake-word" / MODEL).resolve():
        print(f"Set LINUX_BUDDY_WAKE_MODEL={target} when launching Friday.")


if __name__ == "__main__":
    main()
