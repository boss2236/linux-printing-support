# Copyright 2026 boss2236 — https://github.com/boss2236/linux-printing-support
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Local HTTP server: serves the UI and a small JSON API on 127.0.0.1 only."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import secrets
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from urllib.parse import unquote, urlparse

import pymupdf

from . import cups, layout

WORK = Path(tempfile.mkdtemp(prefix="lps-"))
layout.CONVERT_DIR = WORK
STATIC = resources.files(__package__) / "static"
LOCK = threading.RLock()  # MuPDF documents are not thread-safe


class Store:
    def __init__(self):
        self.docs: dict[str, dict] = {}
        self.imposed: dict[str, pymupdf.Document] = {}
        self.pending_backs: dict[str, dict] = {}
        self.initial: list[str] = []

    def add_file(self, path: Path, name: str | None = None) -> dict:
        doc = layout.load_document(path)
        doc_id = uuid.uuid4().hex[:12]
        first = doc[0].rect if doc.page_count else pymupdf.Rect(0, 0, 595, 842)
        meta = {"id": doc_id, "name": name or path.name, "pages": doc.page_count,
                "landscape": first.width > first.height}
        self.docs[doc_id] = {**meta, "doc": doc, "path": str(path)}
        return meta

    def clear(self, keep: str | None = None) -> dict:
        """Forget every open document, preview and temp file (except the doc on screen)."""
        with LOCK:
            kept = self.docs.get(keep or "")
            self.docs = {keep: kept} if kept else {}
            self.imposed.clear()
            self.pending_backs.clear()
            freed = 0
            keep_file = kept.get("path") if kept else None
            for f in WORK.rglob("*"):
                if f.is_file() and str(f) != keep_file:
                    freed += f.stat().st_size
                    f.unlink(missing_ok=True)
        return {"ok": True, "freed": freed}

    def impose(self, doc_id: str, settings: dict) -> tuple[str, pymupdf.Document]:
        entry = self.docs.get(doc_id)
        if not entry:
            raise KeyError("That document is no longer open")
        key = hashlib.sha1((doc_id + json.dumps(settings, sort_keys=True)).encode()).hexdigest()[:16]
        if key not in self.imposed:
            if len(self.imposed) > 24:
                self.imposed.pop(next(iter(self.imposed)))
            self.imposed[key] = layout.impose(entry["doc"], settings)
        return key, self.imposed[key]


STORE = Store()


def print_options(req: dict) -> dict[str, str]:
    s = req.get("settings", {})
    opts = {"media": s.get("media", "iso_a4_210x297mm"), "print-scaling": "none"}
    opts["print-color-mode"] = "monochrome" if req.get("color") == "gray" else "color"
    opts["print-quality"] = {"draft": "3", "normal": "4", "high": "5"}.get(req.get("quality", "normal"), "4")
    if req.get("collate", True):
        opts["multiple-document-handling"] = "separate-documents-collated-copies"
        opts["collate"] = "true"
    sides = req.get("sides", "one-sided")
    if sides in ("two-sided-long-edge", "two-sided-short-edge") and not req.get("manual_duplex"):
        opts["sides"] = sides
    else:
        opts["sides"] = "one-sided"
    return opts


def save_pdf(doc: pymupdf.Document, stem: str) -> Path:
    path = WORK / f"{stem}-{uuid.uuid4().hex[:6]}.pdf"
    doc.save(path, garbage=1, deflate=True)
    return path


class Handler(BaseHTTPRequestHandler):
    token = ""
    server_version = "LinuxPrintingSupport/1.0"

    def log_message(self, fmt, *args):
        pass

    # ------------------------------------------------------------ plumbing
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, code: int = 200):
        self._send(code, json.dumps(data).encode(), "application/json")

    def _error(self, msg: str, code: int = 400):
        self._json({"error": msg}, code)

    def _body(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def _authed(self) -> bool:
        # A custom header can't be sent cross-origin without a CORS preflight we never
        # answer, so other web pages can't drive the printer through this server.
        if self.headers.get("X-LPS-Token") == self.token:
            return True
        self._error("forbidden", 403)
        return False

    # ------------------------------------------------------------ GET
    def do_GET(self):
        url = urlparse(self.path)
        p = url.path
        if not p.startswith("/api/"):
            return self._static(p)
        if p.startswith("/api/sheet/"):  # images are loaded by <img>, token rides in the path
            return self._sheet(p)
        if not self._authed():
            return
        try:
            if p == "/api/printers":
                refresh = "refresh" in url.query
                self._json({"printers": [x.to_dict() for x in cups.list_printers(refresh)],
                            "ipp_usb": cups.ipp_usb_status()})
            elif p == "/api/jobs":
                self._json({"active": cups.get_jobs("not-completed"), "recent": cups.get_jobs("completed")[:50]})
            elif p == "/api/initial":
                self._json({"docs": [{k: v for k, v in STORE.docs[i].items() if k not in ("doc", "path")}
                                     for i in STORE.initial if i in STORE.docs]})
                STORE.initial.clear()
            elif p == "/api/discover":
                self._json({"found": cups.discover()})
            else:
                self._error("not found", 404)
        except Exception as e:  # noqa: BLE001 - surface any failure to the UI
            self._error(str(e), 500)

    def _static(self, p: str):
        name = "index.html" if p in ("/", "") else unquote(p.lstrip("/"))
        if ".." in name:
            return self._error("not found", 404)
        f = STATIC / name
        if not f.is_file():
            return self._error("not found", 404)
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        self._send(200, f.read_bytes(), ctype + ("; charset=utf-8" if ctype.startswith("text") else ""))

    def _sheet(self, p: str):
        m = re.fullmatch(r"/api/sheet/([^/]+)/([0-9a-f]+)/(\d+)(-g)?\.png", p)
        if not m or m.group(1) != self.token:
            return self._error("not found", 404)
        doc = STORE.imposed.get(m.group(2))
        idx = int(m.group(3))
        if not doc or idx >= doc.page_count:
            return self._error("gone", 404)
        with LOCK:
            png = layout.render_sheet(doc, idx, gray=bool(m.group(4)))
        self._send(200, png, "image/png")

    # ------------------------------------------------------------ POST
    def do_POST(self):
        if not self._authed():
            return
        p = urlparse(self.path).path
        try:
            if p == "/api/upload":
                name = unquote(self.headers.get("X-Filename", "document.pdf"))
                safe = re.sub(r"[^\w.\- ]+", "_", Path(name).name) or "document.pdf"
                path = WORK / f"{uuid.uuid4().hex[:6]}-{safe}"
                path.write_bytes(self._body())
                with LOCK:
                    meta = STORE.add_file(path, name)
                return self._json(meta)

            req = json.loads(self._body() or b"{}")
            if p == "/api/preview":
                with LOCK:
                    key, doc = STORE.impose(req["doc_id"], req.get("settings", {}))
                    sheets = [{"w": round(pg.rect.width), "h": round(pg.rect.height)} for pg in doc]
                return self._json({"key": key, "sheets": sheets})
            if p == "/api/print":
                return self._print(req)
            if p == "/api/print/continue":
                pending = STORE.pending_backs.pop(req.get("ticket", ""), None)
                if not pending:
                    return self._error("Nothing waiting to print")
                ok, res = cups.submit(**pending)
                return self._json({"ok": ok, "job": res}) if ok else self._error(res)
            if p == "/api/history/remove":
                ok, msg = cups.remove_from_history(req.get("ids", []))
                return self._json({"ok": ok}) if ok else self._error(msg or "Could not remove")
            if p == "/api/history/clear":
                ids = [j["id"] for j in cups.get_jobs("completed")]
                ok, msg = cups.remove_from_history(ids)
                return self._json({"ok": ok, "removed": len(ids)}) if ok else self._error(msg or "Could not clear history")
            if p == "/api/clear-data":
                return self._json(STORE.clear(keep=req.get("keep")))
            if p == "/api/cancel":
                ok, msg = cups.cancel_job(req["id"])
                return self._json({"ok": ok}) if ok else self._error(msg or "Could not cancel")
            if p == "/api/default":
                ok, msg = cups.set_user_default(req["name"])
                return self._json({"ok": ok}) if ok else self._error(msg)
            if p == "/api/repair":
                ok, msg = cups.repair()
                return self._json({"ok": ok, "message": msg}) if ok else self._error(msg or "Repair failed")
            if p == "/api/add-printer":
                ok, msg = cups.add_printer(req["name"], req["uri"])
                cups._cache.clear()
                return self._json({"ok": ok}) if ok else self._error(msg or "Could not add printer")
            if p == "/api/remove-printer":
                ok, msg = cups.remove_printer(req["name"])
                cups._cache.clear()
                return self._json({"ok": ok}) if ok else self._error(msg or "Could not remove printer")
            if p == "/api/close":
                with LOCK:
                    STORE.docs.pop(req.get("doc_id", ""), None)
                return self._json({"ok": True})
            self._error("not found", 404)
        except layout.ConversionError as e:
            self._error(str(e), 422)
        except (ValueError, KeyError) as e:
            self._error(str(e).strip("'\""), 400)
        except Exception as e:  # noqa: BLE001
            self._error(f"{type(e).__name__}: {e}", 500)

    def _print(self, req: dict):
        printer = req.get("printer") or cups.default_printer()
        if not printer:
            return self._error("Choose a printer first")
        entry = STORE.docs.get(req.get("doc_id", ""))
        if not entry:
            return self._error("That document is no longer open")
        copies = max(1, min(99, int(req.get("copies", 1))))
        title = Path(entry["name"]).stem
        opts = print_options(req)
        with LOCK:
            _, doc = STORE.impose(entry["id"], req.get("settings", {}))
            manual = req.get("manual_duplex") and req.get("sides", "one-sided") != "one-sided" and doc.page_count > 1
            if not manual:
                path = save_pdf(doc, "job")
            else:
                fronts, backs = layout.split_for_manual_duplex(doc)
                path, back_path = save_pdf(fronts, "fronts"), save_pdf(backs, "backs")
        ok, res = cups.submit(printer, str(path), title, opts, copies)
        if not ok:
            return self._error(res or "The print system refused the job")
        if not manual:
            return self._json({"ok": True, "job": res})
        ticket = secrets.token_hex(6)
        STORE.pending_backs[ticket] = {"printer": printer, "pdf_path": str(back_path),
                                       "title": f"{title} (back sides)", "options": opts, "copies": copies}
        return self._json({"ok": True, "job": res, "ticket": ticket, "flip": True})


def serve(port: int = 0, files: list[str] | None = None) -> tuple[ThreadingHTTPServer, str]:
    Handler.token = secrets.token_urlsafe(16)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    for f in files or []:
        try:
            with LOCK:
                STORE.initial.append(STORE.add_file(Path(f))["id"])
        except Exception as e:  # noqa: BLE001 - a bad file shouldn't stop the app
            print(f"Could not open {f}: {e}")
    url = f"http://127.0.0.1:{httpd.server_address[1]}/#{Handler.token}"
    return httpd, url
