#!/usr/bin/env python3
"""Local control panel for the Music Factory workflow.

The server is deliberately bound to localhost. It manages only the user's
local release batch and opens existing Chrome profiles; it never publishes a
track or sends credentials.
"""

from __future__ import annotations

import json
import mimetypes
import subprocess
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


HOST = "127.0.0.1"
PORT = 8787
CHROME_APP = "/Applications/Google Chrome.app"
SOURCE_ROOT = Path("/Users/hlibokhai/Library/Mobile Documents/com~apple~CloudDocs/hjh")
BATCH_ROOT = SOURCE_ROOT / "Release_Batches" / "us_batch_001"
MANIFEST_PATH = BATCH_ROOT / "manifest.json"
ACE_LAUNCHER = Path(__file__).with_name("Start ACE-Step.command")
PROFILES = {
    "bos": ("Profile 7", "Бос · bos-423483424"),
    "gleb": ("Default", "Gleb Ohai · gleb-oxaj"),
    "rivi": ("Profile 4", "Boner Kurva · rivi-135338423"),
}


def read_manifest() -> dict:
    with MANIFEST_PATH.open(encoding="utf-8") as file:
        return json.load(file)


def write_manifest(manifest: dict) -> None:
    temporary = MANIFEST_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(MANIFEST_PATH)


def open_profile(profile_key: str) -> str:
    profile, label = PROFILES[profile_key]
    subprocess.Popen(
        ["open", "-na", CHROME_APP, "--args", f"--profile-directory={profile}", "--new-window", "https://soundcloud.com/you"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return f"Открыт профиль: {label}. Войди в SoundCloud вручную и проверь ник в URL."


def page(manifest: dict, message: str = "") -> str:
    cards = []
    for track in manifest["tracks"]:
        number = track["number"]
        status = track["status"]
        cards.append(
            f'''<article class="track"><div class="track-title"><b>{number:02d}. {track["title"]}</b><span class="pill {status}">{status}</span></div>
            <div class="meta">{track["genre"]} · {track["duration_seconds"]} sec · {track.get("soundcloud_account") or "unassigned"}</div>
            <audio controls preload="metadata" src="/audio/{number}"></audio>
            <div class="actions"><button onclick="setStatus({number},'approved')">Approve</button><button class="ghost" onclick="setStatus({number},'regenerate')">Regenerate</button></div></article>'''
        )
    notice = f'<div class="notice">{message}</div>' if message else ""
    return f'''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Music Factory</title>
    <style>:root{{--bg:#0c0f15;--panel:#171c27;--line:#303a4b;--text:#f4f6fa;--muted:#a1aaba;--accent:#ff7540;--good:#71d69c}}*{{box-sizing:border-box}}body{{margin:0;background:radial-gradient(850px 440px at 10% -10%,#ff75402b,transparent),var(--bg);font:15px system-ui;color:var(--text)}}main{{max-width:1020px;margin:auto;padding:38px 20px 70px}}h1{{font-size:34px;margin:0 0 6px}}h2{{font-size:19px;margin:0 0 8px}}p,.meta{{color:var(--muted)}}.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:28px 0}}.panel,.track{{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:16px}}button{{border:0;border-radius:8px;padding:9px 12px;background:var(--accent);font-weight:750;color:#241006;cursor:pointer}}button.ghost{{background:transparent;border:1px solid var(--line);color:var(--text)}}.actions{{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}}.notice{{background:#71d69c18;color:var(--good);border:1px solid #71d69c4c;border-radius:9px;padding:11px;margin:16px 0}}.tracks{{display:grid;gap:10px}}.track-title{{display:flex;justify-content:space-between;gap:10px}}.pill{{font:12px ui-monospace,monospace;color:#f5c47c}}.pill.approved{{color:var(--good)}}audio{{width:100%;margin-top:12px}}@media(max-width:700px){{.grid{{grid-template-columns:1fr}}}}</style>
    <main><h1>Music Factory</h1><p>Локальный пульт: генерация → ревью → распределение → публикация → монетизация.</p>{notice}
    <section class="grid"><article class="panel"><h2>1. ACE‑Step</h2><p>Генерация музыки локально.</p><div class="actions"><button onclick="post('/api/ace')">Open ACE‑Step</button></div></article>
    <article class="panel"><h2>2. SoundCloud profiles</h2><p>Открывай по одному и входи вручную.</p><div class="actions"><button onclick="post('/api/profile/bos')">Бос</button><button onclick="post('/api/profile/gleb')">Gleb</button><button onclick="post('/api/profile/rivi')">Rivi</button></div></article>
    <article class="panel"><h2>3. Publish queue</h2><p>Публикация выключена до ручной авторизации и одобрения трека.</p><div class="actions"><button class="ghost" onclick="alert('Сначала одобри трек и войди в нужный SoundCloud-профиль.')">Queue status</button></div></article></section>
    <h2>US Batch 001 · review</h2><div class="tracks">{''.join(cards)}</div></main>
    <script>async function post(url,data={{}}){{let r=await fetch(url,{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(data)}});let x=await r.json();location.href='/?message='+encodeURIComponent(x.message||'Updated')}}async function setStatus(n,status){{await post('/api/track/'+n,{{status}})}}</script></html>'''


class FactoryHandler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return

    def respond_json(self, data: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            message = parse_qs(urlparse(self.path).query).get("message", [""])[0]
            body = page(read_manifest(), message).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/audio/"):
            try:
                number = int(unquote(path.rsplit("/", 1)[-1]))
                track = next(t for t in read_manifest()["tracks"] if t["number"] == number)
                audio = (BATCH_ROOT / track["file"]).resolve()
                if BATCH_ROOT not in audio.parents or not audio.is_file():
                    raise FileNotFoundError
            except (ValueError, StopIteration, FileNotFoundError):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mimetypes.guess_type(audio.name)[0] or "audio/wav")
            self.send_header("Content-Length", str(audio.stat().st_size))
            self.end_headers()
            with audio.open("rb") as file:
                while chunk := file.read(1024 * 1024):
                    self.wfile.write(chunk)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.respond_json({"message": "Некорректные данные"}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/ace":
            subprocess.Popen(["open", str(ACE_LAUNCHER)])
            self.respond_json({"message": "Открыт запуск ACE-Step."})
            return
        if path.startswith("/api/profile/"):
            key = path.rsplit("/", 1)[-1]
            if key not in PROFILES:
                self.respond_json({"message": "Неизвестный профиль"}, HTTPStatus.NOT_FOUND)
                return
            self.respond_json({"message": open_profile(key)})
            return
        if path.startswith("/api/track/"):
            try:
                number = int(path.rsplit("/", 1)[-1])
                status = payload["status"]
                if status not in {"generated", "approved", "regenerate"}:
                    raise ValueError
                manifest = read_manifest()
                track = next(t for t in manifest["tracks"] if t["number"] == number)
                track["status"] = status
                write_manifest(manifest)
                self.respond_json({"message": f"{track['title']}: {status}"})
            except (KeyError, ValueError, StopIteration):
                self.respond_json({"message": "Не удалось обновить статус"}, HTTPStatus.BAD_REQUEST)
            return
        self.respond_json({"message": "Не найдено"}, HTTPStatus.NOT_FOUND)


if __name__ == "__main__":
    print(f"Music Factory: http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), FactoryHandler).serve_forever()
