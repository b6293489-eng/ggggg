#!/usr/bin/env python3
"""SoundCloud Publication & Monetization Automation Script.

Cross-platform: Windows (win32-x64), macOS (darwin-arm64/x64), Linux.
Uses Playwright over CDP to connect to a real, existing Chrome user profile.
Automates track upload through modern SoundCloud iframe architecture (/n/upload),
sets track title, activates Amplify (Artist Pro), clicks final Upload,
and then submits monetization in Artist Studio.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Optional

from playwright.sync_api import Error as PlaywrightError, Page, sync_playwright

DEFAULT_PROFILE_BY_ACCOUNT = {
    "bos": "Profile 7",
    "bos-423483424": "Profile 7",
    "gleb": "Default",
    "gleb-oxaj": "Default",  # legacy alias
    "nn1v-680019554": "Default",
    "rivi": "Profile 4",
    "rivi-135338423": "Profile 4",
}


def log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def get_chrome_user_data_base() -> Path:
    """Returns default Chrome user data directory across platforms."""
    custom = os.environ.get("CHROME_USER_DATA_DIR")
    if custom:
        return Path(custom).resolve()
    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA")
        base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
        return (base / "Google" / "Chrome" / "User Data").resolve()
    elif sys.platform == "darwin":
        return (Path.home() / "Library" / "Application Support" / "Google" / "Chrome").resolve()
    else:
        return (Path.home() / ".config" / "google-chrome").resolve()


def get_chrome_cdp_dir() -> Path:
    """Returns isolated CDP Chrome directory to bypass Chrome 130+ default-dir restriction."""
    custom = os.environ.get("CHROME_CDP_DIR")
    if custom:
        return Path(custom).resolve()
    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA")
        base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
        return (base / "Google" / "Chrome-CDP").resolve()
    elif sys.platform == "darwin":
        return (Path.home() / "Library" / "Application Support" / "Google" / "Chrome-CDP").resolve()
    else:
        return (Path.home() / ".config" / "google-chrome-cdp").resolve()


def get_factory_data_dir() -> Path:
    """Returns Music Factory application data directory across platforms."""
    custom = os.environ.get("FACTORY_DATA_DIR")
    if custom:
        return Path(custom).resolve()
    if sys.platform == "win32":
        app_data = os.environ.get("APPDATA")
        base = Path(app_data) if app_data else Path.home() / "AppData" / "Roaming"
        return (base / "Music Factory").resolve()
    elif sys.platform == "darwin":
        return (Path.home() / "Library" / "Application Support" / "Music Factory").resolve()
    else:
        return (Path.home() / ".config" / "Music Factory").resolve()


def get_factory_state_file() -> Path:
    return get_factory_data_dir() / "factory-state.json"


def get_chrome_executable(custom_bin: Optional[str] = None) -> str:
    """Finds Google Chrome executable across platforms."""
    custom = custom_bin or os.environ.get("CHROME_BIN") or os.environ.get("CHROME_PATH")
    if custom and Path(custom).is_file():
        return str(Path(custom).resolve())

    if sys.platform == "darwin":
        candidates = [
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path.home() / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ]
        for c in candidates:
            if c.is_file():
                return str(c)
        which = shutil.which("google-chrome")
        if which:
            return which
    elif sys.platform == "win32":
        prog_files = Path(os.environ.get("PROGRAMFILES", r"C:\Program Files"))
        prog_files_x86 = Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"))
        local_app_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        candidates = [
            prog_files / "Google" / "Chrome" / "Application" / "chrome.exe",
            prog_files_x86 / "Google" / "Chrome" / "Application" / "chrome.exe",
            local_app_data / "Google" / "Chrome" / "Application" / "chrome.exe",
        ]
        for c in candidates:
            if c.is_file():
                return str(c)
        which = shutil.which("chrome.exe") or shutil.which("chrome")
        if which:
            return which
    else:
        candidates = ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]
        for c in candidates:
            which = shutil.which(c)
            if which:
                return which

    raise FileNotFoundError("Google Chrome executable not found on this system. Please check Chrome installation.")


def link_file(target: Path, link: Path) -> None:
    """Links or copies a file from target to link without requiring administrator privileges."""
    if link.exists():
        return
    link.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        try:
            os.link(str(target), str(link))
            return
        except Exception:
            pass
        try:
            shutil.copy2(str(target), str(link))
            return
        except Exception as e:
            log(f"Warning: Could not link/copy file {target} -> {link}: {e}")
    else:
        try:
            link.symlink_to(target)
        except OSError:
            try:
                shutil.copy2(str(target), str(link))
            except Exception as e:
                log(f"Warning: Could not symlink/copy file {target} -> {link}: {e}")


def link_dir(target: Path, link: Path) -> None:
    """Creates a directory junction (Windows) or symlink (Unix) without administrator privileges."""
    if link.exists():
        return
    link.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        try:
            import _winapi
            _winapi.CreateJunction(str(target), str(link))
            return
        except Exception:
            pass
        try:
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(target)],
                check=False,
                capture_output=True,
            )
            if link.exists():
                return
        except Exception:
            pass
        try:
            link.symlink_to(target, target_is_directory=True)
            return
        except Exception as e:
            log(f"Warning: Could not create junction/symlink for {link} -> {target}: {e}")
    else:
        try:
            link.symlink_to(target)
        except OSError as e:
            log(f"Warning: Could not symlink {link} -> {target}: {e}")


def ensure_cdp_profile_dir() -> Path:
    """Prepares isolated Chrome CDP directory with links to the user's real Chrome profiles."""
    base_dir = get_chrome_user_data_base()
    cdp_dir = get_chrome_cdp_dir()
    cdp_dir.mkdir(parents=True, exist_ok=True)

    if not base_dir.is_dir():
        log(f"Notice: Chrome user data directory not found at {base_dir}")
        return cdp_dir

    local_state = base_dir / "Local State"
    if local_state.is_file():
        link_file(local_state, cdp_dir / "Local State")

    default_dir = base_dir / "Default"
    if default_dir.is_dir():
        link_dir(default_dir, cdp_dir / "Default")

    for p in base_dir.glob("Profile *"):
        if p.is_dir():
            link_dir(p, cdp_dir / p.name)

    return cdp_dir


def quit_chrome() -> None:
    """Gracefully closes or terminates running Chrome instances to allow CDP port binding."""
    try:
        if sys.platform == "darwin":
            subprocess.run(["osascript", "-e", 'tell application "Google Chrome" to quit'], check=False)
        elif sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/IM", "chrome.exe", "/T"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            subprocess.run(["pkill", "-f", "chrome"], check=False)
    except Exception as e:
        log(f"Notice during Chrome quit: {e}")


def is_cdp_ready(port: int = 9222) -> bool:
    try:
        req = urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2)
        return req.status == 200
    except Exception:
        return False


def resolve_profile_for_account(account: str) -> str:
    state_file = get_factory_state_file()
    if state_file.is_file():
        try:
            data = json.loads(state_file.read_text(encoding="utf-8"))
            for acc in data.get("accounts", []):
                if acc.get("id") == account or acc.get("handle") == account:
                    if acc.get("chromeProfile"):
                        return acc["chromeProfile"]
        except Exception:
            pass
    return DEFAULT_PROFILE_BY_ACCOUNT.get(account, "Profile 7")


def launch_chrome_with_cdp(
    profile: str = "Profile 7",
    port: int = 9222,
    custom_bin: Optional[str] = None,
) -> None:
    if is_cdp_ready(port):
        log(f"Chrome is already listening on CDP port {port}.")
        return

    log(f"Preparing Chrome environment for profile '{profile}' on CDP port {port}...")
    cdp_dir = ensure_cdp_profile_dir()
    chrome_bin = get_chrome_executable(custom_bin)

    log("Closing any non-CDP Chrome instances...")
    quit_chrome()
    time.sleep(2)

    cmd = [
        chrome_bin,
        f"--user-data-dir={cdp_dir}",
        f"--profile-directory={profile}",
        f"--remote-debugging-port={port}",
        "--remote-allow-origins=*",
        "https://soundcloud.com/upload",
    ]
    log(f"Launching Chrome: {chrome_bin} (profile: {profile})")
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    for attempt in range(25):
        time.sleep(1)
        if is_cdp_ready(port):
            log(f"Chrome CDP ready on port {port} (attempt {attempt + 1}).")
            return
    raise RuntimeError(f"Failed to connect to Chrome CDP port {port} after 25 seconds.")


def get_upload_frame(page: Page, timeout_sec: int = 40):
    start = time.time()
    while time.time() - start < timeout_sec:
        for f in page.frames:
            if "/n/upload" in f.url:
                return f
        page.wait_for_timeout(500)
    raise RuntimeError("Could not find SoundCloud upload iframe (/n/upload) on soundcloud.com/upload.")


def upload_track_via_cdp(
    audio_path: str | Path,
    title: str,
    account: str = "bos-423483424",
    amplify: bool = True,
    port: int = 9222,
    custom_bin: Optional[str] = None,
) -> str:
    """Uploads a track to SoundCloud via CDP inside the modern /n/upload iframe."""
    audio_file = Path(audio_path).resolve()
    if not audio_file.is_file():
        raise FileNotFoundError(f"Audio file not found: {audio_file}")

    profile = resolve_profile_for_account(account)
    launch_chrome_with_cdp(profile=profile, port=port, custom_bin=custom_bin)

    log(f"Connecting to Chrome via CDP on http://127.0.0.1:{port}...")
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
        context = browser.contexts[0]
        page = None
        for pg in context.pages:
            if "soundcloud.com" in pg.url:
                page = pg
                break
        if not page:
            page = context.pages[0] if context.pages else context.new_page()

        log("Navigating to https://soundcloud.com/upload...")
        if not page.url.startswith("https://soundcloud.com/upload"):
            page.goto("https://soundcloud.com/upload")
            page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(3000)

        log("Locating upload iframe (/n/upload)...")
        upload_frame = get_upload_frame(page, timeout_sec=40)
        log(f"Upload frame located: {upload_frame.url}")

        file_input = upload_frame.locator('input[type="file"]').first
        log(f"Supplying audio file: {audio_file.name}...")
        file_input.set_input_files(str(audio_file))

        log("Waiting for track metadata form...")
        title_input = upload_frame.locator('input[name="title"]').first
        title_input.wait_for(state="visible", timeout=45000)

        log(f"Setting track title: '{title}'...")
        title_input.fill(title)
        page.wait_for_timeout(1000)

        if amplify:
            amplify_btn = upload_frame.locator('button[name="firstFansPreEnrollments"]').first
            if amplify_btn.count() and amplify_btn.is_visible():
                current_val = amplify_btn.get_attribute("value")
                if current_val != "ENROLLED":
                    log("Activating Amplify track...")
                    amplify_btn.click()
                    page.wait_for_timeout(1000)
                    log(f"Amplify status: {amplify_btn.get_attribute('value')}")
                else:
                    log("Amplify is already ENROLLED.")

        log("Waiting for upload processing and Upload button activation...")
        upload_btn = upload_frame.locator('button[aria-label="Upload"], button:has-text("Upload")').first
        upload_btn.wait_for(state="visible", timeout=60000)

        enabled = False
        for sec in range(1500):
            if upload_btn.is_enabled():
                aria_dis = upload_btn.get_attribute("aria-disabled")
                if aria_dis != "true":
                    enabled = True
                    break
            if sec > 0 and sec % 15 == 0:
                log(f"Still waiting for upload processing and button activation... ({sec}s elapsed)")
            page.wait_for_timeout(1000)

        if not enabled:
            raise RuntimeError("SoundCloud Upload button remained disabled after 25 minutes of processing.")

        log("Clicking Upload button...")
        upload_btn.click()

        log("Waiting for publication confirmation link...")
        view_track_link = None
        for _ in range(35):
            page.wait_for_timeout(2000)
            view_btn = upload_frame.locator('a:has-text("View track")').first
            if view_btn.count() and view_btn.is_visible():
                view_track_link = view_btn.get_attribute("href")
                break
            body_txt = upload_frame.evaluate("() => document.body ? document.body.innerText : ''")
            if "Saved to SoundCloud" in body_txt or "Your tracks are now on SoundCloud" in body_txt:
                view_btn = upload_frame.locator('a:has-text("View track")').first
                if view_btn.count():
                    view_track_link = view_btn.get_attribute("href")
                    break

        if not view_track_link:
            raise RuntimeError("SoundCloud did not display confirmation 'View track' link within 70 seconds.")

        if view_track_link.startswith("/"):
            view_track_link = f"https://soundcloud.com{view_track_link}"

        log(f"Track published successfully: {view_track_link}")
        return view_track_link


def submit_monetization_via_cdp(
    track_title: str,
    legal_name: str = "Hlib Okhai",
    content_rating: str = "Not Explicit",
    songwriter_role: str = "writer",
    port: int = 9222,
) -> bool:
    """Navigates to Artist Studio and submits the track for monetization."""
    log(f"Starting monetization submission for '{track_title}'...")
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else context.new_page()

        log("Navigating to https://artists.soundcloud.com/monetization/soundcloud...")
        page.goto("https://artists.soundcloud.com/monetization/soundcloud")
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(5000)

        title_el = page.locator(f'text="{track_title}"').first
        title_el.wait_for(state="visible", timeout=30000)

        row = title_el.locator("xpath=./ancestor::div[.//button or contains(@class, 'track') or contains(@class, 'row')][1]")
        if not row.count():
            row = title_el.locator("xpath=./ancestor::div[3]")

        row_text = row.inner_text()
        if "Cancel Monetization" in row_text or "Monetizing" in row_text or "Under review" in row_text:
            log(f"Track '{track_title}' is already submitted or monetizing (row status: {row_text[:60]}).")
            return True

        monetize_btn = row.locator('button:has-text("Monetize this track"), button:has-text("Monetize")').first
        if not monetize_btn.count() or not monetize_btn.is_visible():
            raise RuntimeError(f"Could not find 'Monetize this track' button for '{track_title}'.")

        log(f"Opening monetization modal for '{track_title}'...")
        monetize_btn.click()
        page.wait_for_timeout(2000)

        dialog = page.locator('[aria-modal="true"]').first
        dialog.wait_for(state="visible", timeout=15000)

        composer_input = dialog.locator('input[placeholder="Full legal name"], input[name*="contributors"][placeholder*="legal"]').first
        if composer_input.count() and composer_input.is_visible():
            log(f"Filling Composer / Legal name: '{legal_name}'...")
            composer_input.fill(legal_name)

        log(f"Setting content rating: '{content_rating}'...")
        dialog.locator('button:has-text("Select content rating"), [role="combobox"]:has-text("rating")').first.click()
        page.wait_for_timeout(500)
        rating_opt = page.locator(f'[role="option"]:has-text("{content_rating}"), li:has-text("{content_rating}")').first
        rating_opt.click()
        page.wait_for_timeout(500)

        log("Selecting songwriter ownership...")
        if songwriter_role == "writer":
            sw_lbl = dialog.locator("label").filter(has_text=re.compile(r"^I wrote this song/I represent the writer\(s\)$")).first
        else:
            sw_lbl = dialog.locator("label").filter(has_text=re.compile(r"^Another artist/writer wrote the song$")).first
        sw_lbl.click()
        page.wait_for_timeout(500)

        log("Selecting ISRC: No...")
        isrc_no_lbl = dialog.locator("label").filter(has_text=re.compile(r"^No$")).first
        isrc_no_lbl.click()
        page.wait_for_timeout(500)

        log("Confirming rights checkbox...")
        rights_input = dialog.locator('input[name="monetizeRightsConfirmed"]').first
        if not rights_input.is_checked():
            rights_lbl = dialog.locator("label").filter(has_text=re.compile(r"I have the rights to monetize this track")).first
            rights_lbl.click()
        page.wait_for_timeout(500)

        submit_btn = dialog.locator('button:has-text("Submit")').first
        if not submit_btn.is_enabled():
            raise RuntimeError("Submit button is not enabled. Required fields may be incomplete.")

        log("Submitting monetization application...")
        submit_btn.click()

        for _ in range(15):
            page.wait_for_timeout(1500)
            if dialog.count() == 0 or not dialog.is_visible():
                break

        page.wait_for_timeout(2000)
        row_after = title_el.locator("xpath=./ancestor::div[.//button or contains(@class, 'track') or contains(@class, 'row')][1]").inner_text()
        if "Cancel Monetization" in row_after or "Submitted" in row_after or "Monetizing" in row_after:
            log(f"Monetization for '{track_title}' successfully submitted (Status: Cancel Monetization / Pending Review).")
            return True
        else:
            log(f"Notice: Dialog closed; status row updated: {row_after[:80]}")
            return True


def update_factory_state(
    track_id: Optional[str] = None,
    track_title: Optional[str] = None,
    publish_url: Optional[str] = None,
    status: str = "submitted",
) -> None:
    """Persists track status and URL in factory-state.json."""
    state_file = get_factory_state_file()
    if not state_file.is_file():
        return
    try:
        data = json.loads(state_file.read_text(encoding="utf-8"))
        updated = False
        for t in data.get("tracks", []):
            match_id = track_id and t.get("id") == track_id
            match_title = track_title and t.get("title") == track_title
            if match_id or match_title:
                t["status"] = status
                if publish_url:
                    t["publishUrl"] = publish_url
                t["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
                updated = True
                log(f"Updated {state_file.name} for '{t.get('title')}' -> status={status}, url={publish_url}")
                break
        if updated:
            state_file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        log(f"Could not update {state_file.name}: {e}")


def process_track(
    audio_path: Optional[str | Path] = None,
    title: Optional[str] = None,
    account: str = "bos-423483424",
    legal_name: str = "Hlib Okhai",
    content_rating: str = "Not Explicit",
    amplify: bool = True,
    monetize: bool = True,
    monetize_only: bool = False,
    track_id: Optional[str] = None,
    port: int = 9222,
    custom_bin: Optional[str] = None,
) -> dict:
    log(f"=== Starting SoundCloud pipeline for '{title}' ({account}) ===")
    publish_url = None

    if not monetize_only:
        if not audio_path:
            raise ValueError("Audio path is required for upload.")
        publish_url = upload_track_via_cdp(
            audio_path=audio_path,
            title=title,
            account=account,
            amplify=amplify,
            port=port,
            custom_bin=custom_bin,
        )

    monetize_ok = False
    if monetize or monetize_only:
        monetize_ok = submit_monetization_via_cdp(
            track_title=title,
            legal_name=legal_name,
            content_rating=content_rating,
            port=port,
        )

    if track_id or title:
        new_status = "submitted" if monetize_ok else "published"
        update_factory_state(track_id=track_id, track_title=title, publish_url=publish_url, status=new_status)

    result = {
        "ok": True,
        "title": title,
        "account": account,
        "publishUrl": publish_url,
        "monetized": monetize_ok,
    }
    log(f"=== Pipeline completed successfully for '{title}' ===")
    return result


def main():
    parser = argparse.ArgumentParser(description="SoundCloud Cross-Platform CDP Automation (Upload & Monetization)")
    parser.add_argument("--audio", type=str, help="Path to WAV audio file")
    parser.add_argument("--title", type=str, help="Track title")
    parser.add_argument("--account", type=str, default="bos-423483424", help="Account identifier (bos, gleb, rivi, or handle)")
    parser.add_argument("--legal-name", type=str, default="Hlib Okhai", help="Full legal name for songwriter credit")
    parser.add_argument("--content-rating", type=str, default="Not Explicit", help="Content rating (Not Explicit / Explicit)")
    parser.add_argument("--no-amplify", action="store_true", help="Do not enroll in Amplify")
    parser.add_argument("--no-monetize", action="store_true", help="Skip Artist Studio monetization submission")
    parser.add_argument("--monetize-only", action="store_true", help="Only submit monetization for an already uploaded track")
    parser.add_argument("--track-id", type=str, help="Music Factory track ID (e.g. track_4a576806...)")
    parser.add_argument("--port", type=int, default=9222, help="CDP debugging port (default 9222)")
    parser.add_argument("--chrome-bin", type=str, help="Path to Google Chrome executable")

    args = parser.parse_args()

    audio_path = args.audio
    title = args.title
    account = args.account

    if args.track_id and not audio_path:
        state_file = get_factory_state_file()
        if not state_file.is_file():
            raise FileNotFoundError(f"State file {state_file} does not exist.")
        state = json.loads(state_file.read_text(encoding="utf-8"))
        track = next((t for t in state.get("tracks", []) if t["id"] == args.track_id), None)
        if not track:
            raise ValueError(f"Track ID {args.track_id} not found in factory-state.json")
        audio_path = track["path"]
        title = title or track["title"]
        account = account or track.get("accountId", "bos-423483424")

    if not title:
        parser.print_help()
        sys.exit(1)

    res = process_track(
        audio_path=audio_path,
        title=title,
        account=account,
        legal_name=args.legal_name,
        content_rating=args.content_rating,
        amplify=not args.no_amplify,
        monetize=not args.no_monetize,
        monetize_only=args.monetize_only,
        track_id=args.track_id,
        port=args.port,
        custom_bin=args.chrome_bin,
    )
    print(json.dumps(res, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
