#!/usr/bin/env python3
"""Create non-destructive, direct-public SoundCloud upload batches.

This only stages local copies and a manifest. It never logs in, uploads, or
changes SoundCloud visibility.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path


OUTPUTS = Path(__file__).resolve().parent
SOURCE = Path("/Users/hlibokhai/Library/Mobile Documents/com~apple~CloudDocs/hjh")
FIRST_AUDIO = SOURCE / "Release_Batches" / "us_batch_001" / "audio"
NEW_AUDIO = OUTPUTS / "generated" / "us_batch_002" / "run_2026-09-08_18-27-57"
DESTINATION = OUTPUTS / "public_upload_batches" / "us_2026_09_08"

ACCOUNTS = {
    "bos": {"handle": "bos-423483424", "first": ("01 - Porcelain Sky.wav", "Porcelain Sky"), "titles": [
        "Dusty Neon", "One More County Line", "Backroad Radio", "Porchlight Promise", "Small Town Cinema", "Wildflower Weather", "Gas Station Roses", "Midnight Mile", "Lakeside July"
    ]},
    "gleb": {"handle": "gleb-oxaj", "first": ("02 - Offline Mode.wav", "Offline Mode"), "titles": [
        "City On Silent", "Paper Planes", "Afterparty Alone", "Blue Light Fever", "No Signal Summer", "Glass Elevator", "Half Past Gold", "Anywhere But Here", "Concrete Constellations"
    ]},
    "rivi": {"handle": "rivi-135338423", "first": ("03 - After The Rain.wav", "After The Rain"), "titles": [
        "Better In The Morning", "Cherry Soda", "Never Needed A Map", "Mirrorball Heart", "Weekend Language", "Golden Hour Text", "Closer To The Floor", "Soft Landing", "Last Call Glitter"
    ]},
}


def stage_account(key: str, spec: dict) -> dict:
    folder = DESTINATION / key
    folder.mkdir(parents=True, exist_ok=True)
    first_file, first_title = spec["first"]
    tracks = [(FIRST_AUDIO / first_file, first_title)]
    tracks += [(NEW_AUDIO / f"us002_{key}_{index:02d}_1.wav", title) for index, title in enumerate(spec["titles"], 2)]
    manifest_tracks = []
    for number, (source, title) in enumerate(tracks, 1):
        if not source.is_file():
            raise FileNotFoundError(source)
        target = folder / f"{number:02d} - {title}{source.suffix.lower()}"
        shutil.copy2(source, target)
        manifest_tracks.append({"number": number, "title": title, "file": target.name})
    return {"account": spec["handle"], "folder": str(folder), "tracks": manifest_tracks}


def main() -> None:
    batches = [stage_account(key, spec) for key, spec in ACCOUNTS.items()]
    manifest = {
        "batch": "us_2026_09_08",
        "visibility": "public",
        "rule": "Upload every account folder as one direct public batch. Do not make private drafts.",
        "accounts": batches,
    }
    (DESTINATION / "publish_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Created {len(batches)} public batches with 10 tracks each in {DESTINATION}")


if __name__ == "__main__":
    main()
