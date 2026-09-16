"""One local ACE-Step 1.5 Gradio render; progress is JSON lines on stdout.

Uses the API mapping validated against this machine's ACE-Step. Unknown API
versions fail explicitly instead of silently shifting positional parameters.
Run with the ACE-Step virtual environment, which already has gradio_client.
"""
import json
import os
from pathlib import Path
import random
import shutil
import struct
import sys
import wave


def emit(kind, **data):
    print(json.dumps({"type": kind, **data}, ensure_ascii=False), flush=True)


def generate(client, item, dummy):
    from gradio_client import handle_file
    values = {
        0: item["caption"], 1: item.get("lyrics", ""), 2: item.get("bpm", 110),
        3: item.get("key_scale", "C major"), 4: item.get("time_signature", "4"),
        5: item.get("vocal_language", "en"), 6: 8, 7: 7, 8: True, 9: "-1",
        10: handle_file(str(dummy)), 11: item.get("duration", 165), 12: 1,
        13: handle_file(str(dummy)), 14: "", 15: 0, 16: -1,
        17: "Fill the audio semantic mask based on the given conditions:", 18: 1, 19: 0,
        21: False, 22: False, 23: 0, 24: 1, 25: 3, 26: "ode", 27: "euler",
        28: 0, 29: 0, 30: True, 31: "double", 32: 0.05, 33: 0.02, 34: "haar", 35: "",
        36: "wav", 37: "192k", 38: 44100, 39: 0.85, 40: False, 41: 2, 42: 0,
        43: 0.9, 44: "NO USER INPUT", 45: True, 46: False, 47: True, 49: False,
        50: True, 51: False, 52: False, 53: 0.5, 54: 8, 55: None, 56: [],
        57: True, 58: -1, 59: 0, 60: 0, 61: 0, 62: 1, 63: "balanced", 64: 0.5,
        65: 0, 66: "", 67: False, 68: "", 69: "", 70: 0, 71: 1, 72: 1, 73: False,
    }
    return client.predict(**{f"param_{key}": value for key, value in values.items()}, api_name="/generation_wrapper")


def output_audio(result):
    if not isinstance(result, (list, tuple)):
        raise RuntimeError("ACE-Step returned an unsupported response. Check the installed ACE-Step API version.")
    candidates = result[8] if len(result) > 8 and isinstance(result[8], list) else []
    candidates = [*candidates, *result[:8]]
    for item in candidates:
        if isinstance(item, dict):
            item = item.get("path") or item.get("name")
        if isinstance(item, str) and Path(item).suffix.lower() == ".wav" and Path(item).is_file():
            return Path(item)
    raise RuntimeError("ACE-Step did not return a WAV file: " + str(result[10] if len(result) > 10 else ""))


def main():
    from gradio_client import Client
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    output = Path(request["output"])
    if not output.is_absolute():
        raise ValueError("Absolute output path is required")
    output.parent.mkdir(parents=True, exist_ok=True)
    dummy = output.parent / "reference-noise.wav"
    if not dummy.exists():
        rng = random.Random(42)
        samples = [rng.randint(-800, 800) for _ in range(88200)]
        with wave.open(str(dummy), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(44100)
            audio.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    emit("progress", message="Подключение к ACE-Step…")
    client = Client(request["server"], verbose=False)
    emit("progress", message="ACE-Step генерирует трек. Это может занять несколько минут…")
    result = generate(client, request["track"], dummy)
    source = output_audio(result)
    temporary = output.with_suffix(".wav.partial")
    shutil.copyfile(source, temporary)
    # Parse RIFF ourselves: ACE exports IEEE float WAV on some versions,
    # which Python 3.11's wave module cannot read despite valid audio.
    with temporary.open("rb") as audio:
        header = audio.read(12)
        if header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise RuntimeError("ACE-Step returned an invalid WAV header")
    if temporary.stat().st_size <= 44:
        raise RuntimeError("ACE-Step returned empty audio")
    os.replace(temporary, output)
    emit("complete", path=str(output), bytes=output.stat().st_size)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("error", message=f"{type(error).__name__}: {error}")
        sys.exit(1)
