#!/usr/bin/env python3
"""Create a private SoundCloud draft using existing local Chrome profile via CDP.

Updated to use Playwright over CDP and modern /n/upload iframe architecture.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from soundcloud_uploader import (
    PROFILE_BY_ACCOUNT,
    get_upload_frame,
    launch_chrome_with_cdp,
    log,
)
from playwright.sync_api import Error as PlaywrightError, sync_playwright

BATCH_ROOT = Path("/Users/hlibokhai/Library/Mobile Documents/com~apple~CloudDocs/hjh/Release_Batches/us_batch_001")
MANIFEST_PATH = BATCH_ROOT / "manifest.json"


def track_for_number(number: int) -> dict:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return next(track for track in manifest["tracks"] if track["number"] == number)


def set_private(upload_frame) -> None:
    """Choose private visibility when the form exposes it."""
    selectors = [
        'input[type="radio"][value="private"]',
        'input[name*="privacy"][value="private"]',
        'label:has-text("Private")',
    ]
    for selector in selectors:
        control = upload_frame.locator(selector).first
        if control.count() and control.is_visible():
            control.click()
            return


def upload_draft(track_number: int, port: int = 9222) -> None:
    track = track_for_number(track_number)
    account = track.get("soundcloud_account")
    profile = PROFILE_BY_ACCOUNT.get(account, "Profile 7")
    audio = (BATCH_ROOT / track["file"]).resolve()
    if not audio.is_file():
        raise RuntimeError(f"Audio file not found: {audio}")

    launch_chrome_with_cdp(profile=profile, port=port)

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else context.new_page()

        if not page.url.startswith("https://soundcloud.com/upload"):
            page.goto("https://soundcloud.com/upload")
            page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(3000)

        upload_frame = get_upload_frame(page, timeout_sec=30)
        file_input = upload_frame.locator('input[type="file"]').first
        file_input.set_input_files(str(audio))

        title_input = upload_frame.locator('input[name="title"]').first
        title_input.wait_for(state="visible", timeout=45000)
        title_input.fill(track["title"])
        set_private(upload_frame)

        save_btn = upload_frame.locator('button[aria-label="Upload"], button:has-text("Save"), button:has-text("Upload")').first
        save_btn.wait_for(state="visible", timeout=60000)
        for _ in range(60):
            if save_btn.is_enabled():
                break
            page.wait_for_timeout(1000)
        save_btn.click()
        page.wait_for_timeout(5000)
        print(json.dumps({"ok": True, "track": track["title"], "account": account, "mode": "private_draft"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--track", type=int, required=True)
    parser.add_argument("--port", type=int, default=9222)
    args = parser.parse_args()
    try:
        upload_draft(args.track, port=args.port)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)
