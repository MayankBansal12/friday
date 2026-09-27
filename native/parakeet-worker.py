#!/usr/bin/env python3
"""Local, persistent Parakeet worker. JSONL on stdin/stdout; no microphone access."""

import argparse
import json
from pathlib import Path
import sys
import time
import wave


def emit(value):
    print(json.dumps(value), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    started = time.perf_counter()
    try:
        for name in ("encoder-model.int8.onnx", "decoder_joint-model.int8.onnx", "vocab.txt", "config.json"):
            if not (args.model_dir / name).is_file():
                raise ValueError(f"Missing Parakeet file: {args.model_dir / name}")
        if not 1 <= args.threads <= 32:
            raise ValueError("STT threads must be between 1 and 32")
        import onnxruntime as ort
        import onnx_asr

        ort.disable_telemetry_events()
        options = ort.SessionOptions()
        options.intra_op_num_threads = args.threads
        options.inter_op_num_threads = 1
        # A resident model should not spin CPU cores while the user is idle.
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        options.add_session_config_entry("session.inter_op.allow_spinning", "0")
        # Architecture + an existing directory: never resolve/download a Hub model.
        model = onnx_asr.load_model(
            "nemo-conformer-tdt", args.model_dir, quantization="int8",
            providers=["CPUExecutionProvider"], sess_options=options,
        )
    except Exception as error:
        emit({"type": "error", "error": f"Parakeet could not start: {error}. Run pnpm stt:setup and check LINUX_BUDDY_STT_MODEL."})
        return 1

    emit({"type": "ready", "loadMs": round((time.perf_counter() - started) * 1000)})
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            audio_path = request["path"]
            with wave.open(audio_path, "rb") as audio:
                if audio.getnchannels() != 1 or audio.getframerate() != 16000 or audio.getsampwidth() != 2:
                    raise ValueError("Expected mono 16 kHz PCM16 WAV audio")
                duration = audio.getnframes() / audio.getframerate()
                if not 0 < duration <= 30:
                    raise ValueError("Audio must be between 0 and 30 seconds")
            started = time.perf_counter()
            text = model.recognize(audio_path)
            emit({"id": request_id, "text": text.strip(), "inferenceMs": round((time.perf_counter() - started) * 1000)})
        except Exception as error:
            emit({"id": request_id, "error": str(error)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
