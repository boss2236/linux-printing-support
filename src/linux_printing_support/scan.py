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

"""Driverless scanning over eSCL (AirScan / Mopria Scan).

Nearly every printer-scanner with the AirPrint or Mopria logo speaks eSCL: a
small HTTP + XML protocol. USB devices expose it through ipp-usb on
localhost, network devices on their own address. No SANE backend needed.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin
from xml.sax.saxutils import escape

import pymupdf

from . import cups, network

SCAN_NS = "http://schemas.hp.com/imaging/escl/2011/05/03"
PWG_NS = "http://www.pwg.org/schemas/2010/12/sm"

# Paper sizes offered for the scan area, in millimetres.
SIZES = [
    ("a4", "A4 · 210 × 297 mm", 210, 297),
    ("letter", "Letter · 8.5 × 11 in", 215.9, 279.4),
    ("legal", "Legal · 8.5 × 14 in", 215.9, 355.6),
    ("a5", "A5 · 148 × 210 mm", 148, 210),
    ("photo4x6", "Photo · 4 × 6 in", 101.6, 152.4),
    ("photo5x7", "Photo · 5 × 7 in", 127, 177.8),
    ("card", "ID / business card", 85.6, 54),
]
STD_RES = [75, 100, 150, 200, 300, 400, 600, 1200]


def _tag(el: ET.Element) -> str:
    return el.tag.rsplit("}", 1)[-1]


def _find(el: ET.Element | None, *path: str) -> ET.Element | None:
    """Namespace-agnostic child lookup (vendors are loose with prefixes)."""
    for name in path:
        if el is None:
            return None
        el = next((c for c in el if _tag(c) == name), None)
    return el


def _findall(el: ET.Element | None, name: str) -> list[ET.Element]:
    return [] if el is None else [c for c in el.iter() if _tag(c) == name]


def _text(el: ET.Element | None, *path: str, default: str = "") -> str:
    found = _find(el, *path) if path else el
    return (found.text or "").strip() if found is not None and found.text else default


def _http(url: str, data: bytes | None = None, method: str | None = None, timeout: float = 20):
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "text/xml"} if data else {})
    return urllib.request.urlopen(req, timeout=timeout)


# ---------------------------------------------------------------- discovery

def list_scanners() -> list[dict]:
    """eSCL scanners on the network and over USB (via ipp-usb)."""
    scanners, seen = [], set()
    for e in network.browse("_uscan._tcp"):
        rs = e["txt"].get("rs", "eSCL").strip("/")
        base = f"http://{e['addr']}:{e['port']}/{rs}".rstrip("/")
        if base in seen:
            continue
        seen.add(base)
        model = e["name"].removesuffix(" (USB)") or e["txt"].get("ty", "Scanner")
        scanners.append({
            "id": hashlib.sha1(base.encode()).hexdigest()[:10], "base": base, "model": model,
            "connection": "usb" if e["usb"] else "network", "uuid": network.norm_uuid(e["txt"].get("uuid", "")),
            "sources": e["txt"].get("is", ""), "admin": network._admin_for(e),
        })
    # No avahi-browse? ipp-usb still serves eSCL on each device's port.
    if not any(s["connection"] == "usb" for s in scanners):
        for d in cups.ipp_usb_status().get("devices", []):
            base = f"http://127.0.0.1:{d['port']}/eSCL"
            if base in seen or not _probe(base):
                continue
            seen.add(base)
            scanners.append({"id": hashlib.sha1(base.encode()).hexdigest()[:10], "base": base, "model": d["model"],
                             "connection": "usb", "uuid": "", "sources": "", "admin": ""})
    # USB first: it's the faster, more reliable path when both exist.
    scanners.sort(key=lambda s: (s["connection"] != "usb", s["model"].lower()))
    return scanners


def _probe(base: str) -> bool:
    try:
        with _http(base + "/ScannerCapabilities", timeout=4) as r:
            return b"ScannerCapabilities" in r.read(4096)
    except Exception:  # noqa: BLE001
        return False


_caps_cache: dict[str, tuple[float, dict]] = {}


def capabilities(base: str) -> dict:
    hit = _caps_cache.get(base)
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    with _http(base + "/ScannerCapabilities", timeout=8) as r:
        root = ET.fromstring(r.read())
    sources = {}
    for key, path in (("platen", ("Platen", "PlatenInputCaps")), ("feeder", ("Adf", "AdfSimplexInputCaps"))):
        caps = _find(root, *path)
        if caps is None:
            continue
        sources[key] = _input_caps(caps)
    # Many scanners (Canon for one) crop to the document's edges when the job carries an Intent,
    # and scan the exact area when it doesn't. Offer that as "Auto" for the glass.
    if "platen" in sources and "Document" in sources["platen"]["intents"]:
        sources["platen"]["sizes"].insert(0, {"id": "auto", "label": "Auto · crop to what's on the glass"})
    adf = _find(root, "Adf")
    if "feeder" in sources:
        sources["feeder"]["duplex"] = _find(adf, "AdfDuplexInputCaps") is not None
        sources["feeder"]["capacity"] = int(_text(adf, "FeederCapacity", default="0") or 0)
    info = {
        "model": _text(root, "MakeAndModel"),
        "version": _text(root, "Version", default="2.0"),
        "admin": _text(root, "AdminURI"),
        "sources": sources,
    }
    _caps_cache[base] = (time.time(), info)
    return info


def _input_caps(caps: ET.Element) -> dict:
    max_w = int(_text(caps, "MaxWidth", default="2550") or 2550)
    max_h = int(_text(caps, "MaxHeight", default="3508") or 3508)
    modes = list(dict.fromkeys(_text(m) for m in _findall(caps, "ColorMode")))
    res = sorted({int(_text(r, "XResolution") or 0) for r in _findall(caps, "DiscreteResolution")} - {0})
    if not res:  # some scanners give a range instead
        rng = _findall(caps, "XResolutionRange")
        if rng:
            lo = int(_text(rng[0], "Min", default="75")); hi = int(_text(rng[0], "Max", default="600"))
            res = [r for r in STD_RES if lo <= r <= hi]
    intents = [_text(i) for i in _findall(caps, "Intent")]
    sizes = [{"id": sid, "label": label} for sid, label, w, h in SIZES
             if _units(w) <= max_w * 1.01 and _units(h) <= max_h * 1.01]
    sizes.append({"id": "max", "label": "Whole scan area"})
    return {
        "colors": [c for c in ("RGB24", "Grayscale8") if c in modes] or modes[:1] or ["RGB24"],
        "resolutions": res or [300],
        "intents": intents,
        "sizes": sizes, "max": [max_w, max_h],
    }


def _units(mm: float) -> int:
    """mm -> eSCL's 1/300 inch."""
    return round(mm / 25.4 * 300)


def status(base: str) -> dict:
    try:
        with _http(base + "/ScannerStatus", timeout=5) as r:
            root = ET.fromstring(r.read())
    except Exception as e:  # noqa: BLE001
        return {"state": "offline", "adf": "", "error": str(e)}
    return {"state": _text(root, "State", default="Idle"), "adf": _text(root, "AdfState")}


# ---------------------------------------------------------------- scan jobs

class ScanError(Exception):
    pass


class Job:
    def __init__(self, scanner: dict, settings: dict, out_dir: Path):
        self.id = uuid.uuid4().hex[:10]
        self.scanner, self.settings, self.out_dir = scanner, settings, out_dir
        self.state = "starting"  # starting | scanning | done | error | cancelled
        self.message = ""
        self.pages: list[dict] = []
        self.location = ""
        self.cancelled = False
        self.thread = threading.Thread(target=self._run, daemon=True)

    def to_dict(self) -> dict:
        return {"id": self.id, "state": self.state, "message": self.message,
                "pages": [{k: v for k, v in p.items() if k not in ("path", "preview")} for p in self.pages]}

    # ---- protocol
    def _settings_xml(self) -> bytes:
        s, base = self.settings, self.scanner["base"]
        caps = capabilities(base)
        source = "feeder" if s.get("source") == "feeder" and "feeder" in caps["sources"] else "platen"
        sc = caps["sources"].get(source) or next(iter(caps["sources"].values()))
        max_w, max_h = sc["max"]
        size = next((x for x in SIZES if x[0] == s.get("size")), None)
        w, h = (min(_units(size[2]), max_w), min(_units(size[3]), max_h)) if size else (max_w, max_h)
        res = int(s.get("resolution", 300))
        if res not in sc["resolutions"]:
            res = min(sc["resolutions"], key=lambda r: abs(r - res))
        color = s.get("color", "RGB24") if s.get("color") in sc["colors"] else sc["colors"][0]
        self.dpi = res
        ver = caps.get("version") or "2.0"
        try:
            new_fmt = float(ver) >= 2.1
        except ValueError:
            new_fmt = False
        fmt = ("<scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>" if new_fmt
               else "<pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>")
        auto = s.get("size") == "auto" and source == "platen"
        intent_xml = "<scan:Intent>Document</scan:Intent>" if auto else ""
        duplex = ""
        if source == "feeder" and sc.get("duplex"):
            duplex = f"<scan:Duplex>{'true' if s.get('duplex') else 'false'}</scan:Duplex>"
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<scan:ScanSettings xmlns:scan="{SCAN_NS}" xmlns:pwg="{PWG_NS}">'
            f"<pwg:Version>{escape(ver)}</pwg:Version>{intent_xml}"
            "<pwg:ScanRegions><pwg:ScanRegion>"
            f"<pwg:Height>{h}</pwg:Height><pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>"
            f"<pwg:Width>{w}</pwg:Width><pwg:XOffset>0</pwg:XOffset><pwg:YOffset>0</pwg:YOffset>"
            "</pwg:ScanRegion></pwg:ScanRegions>"
            f"<pwg:InputSource>{'Feeder' if source == 'feeder' else 'Platen'}</pwg:InputSource>"
            f"<scan:ColorMode>{escape(color)}</scan:ColorMode>"
            f"<scan:XResolution>{res}</scan:XResolution><scan:YResolution>{res}</scan:YResolution>"
            f"{fmt}{duplex}</scan:ScanSettings>"
        )
        self.source = source
        return xml.encode()

    def _wait_idle(self, limit: float = 45):
        """Scanners refuse or silently cancel jobs sent while still parking the scan head."""
        base = self.scanner["base"]
        end = time.time() + limit
        while time.time() < end and not self.cancelled:
            st = status(base)
            if st["state"] == "Idle":
                return st
            if st["state"] == "offline":
                raise ScanError("The scanner isn't responding. Check it's switched on and connected.")
            time.sleep(1)
        raise ScanError("The scanner is busy. Wait for it to finish, then try again.")

    def _create(self, body: bytes) -> str:
        base = self.scanner["base"]
        for _ in range(20):
            try:
                with _http(base + "/ScanJobs", data=body, method="POST", timeout=30) as r:
                    loc = r.headers.get("Location", "")
                    if not loc:
                        raise ScanError("The scanner didn't start the scan.")
                    return urljoin(base + "/ScanJobs/", loc).rstrip("/")
            except urllib.error.HTTPError as e:
                if e.code == 503:  # busy: try again shortly
                    time.sleep(1.5)
                    continue
                if e.code == 409:
                    raise ScanError("The document feeder is empty. Put your pages in it, face up.") from e
                raise ScanError(f"The scanner refused the scan settings (HTTP {e.code}).") from e
            if self.cancelled:
                break
        raise ScanError("The scanner stayed busy. Try again in a moment.")

    def _next_page(self) -> bytes | None:
        """One page, or None when the job has no more pages."""
        for _ in range(240):
            if self.cancelled:
                return None
            try:
                with _http(self.location + "/NextDocument", timeout=180) as r:
                    return r.read()
            except urllib.error.HTTPError as e:
                if e.code == 503:  # still scanning
                    time.sleep(1)
                    continue
                if e.code in (404, 410):
                    return None
                raise ScanError(f"The scanner stopped (HTTP {e.code}).") from e
        raise ScanError("The scanner took too long to send the page.")

    def _save_page(self, data: bytes):
        n = len(self.pages)
        path = self.out_dir / f"scan-{self.id}-{n:03d}.jpg"
        path.write_bytes(data)
        pix = pymupdf.Pixmap(str(path))
        w, h = pix.width, pix.height
        while pix.width > 1100:
            pix.shrink(1)
        prev = self.out_dir / f"scan-{self.id}-{n:03d}-prev.jpg"
        prev.write_bytes(pix.tobytes("jpg", jpg_quality=82))
        page_id = f"{self.id}{n:03d}"
        self.pages.append({"id": page_id, "w": w, "h": h, "dpi": self.dpi, "path": str(path), "preview": str(prev)})
        PAGES[page_id] = self.pages[-1]

    def _run(self):
        try:
            body = self._settings_xml()
            for attempt in range(2):
                st = self._wait_idle()
                if self.source == "feeder" and "Empty" in (st.get("adf") or ""):
                    raise ScanError("The document feeder is empty. Put your pages in it, face up.")
                if attempt:
                    time.sleep(2)
                self.state = "scanning"
                self.location = self._create(body)
                got = 0
                while not self.cancelled:
                    data = self._next_page()
                    if not data:
                        break
                    self._save_page(data)
                    got += 1
                    if self.source == "platen":
                        self._next_page()  # lets the scanner close the job (expects a 404)
                        break
                # A scanner that was asleep sometimes cancels the first job itself. Retry once.
                if got or self.cancelled:
                    break
            if self.cancelled:
                self.state = "cancelled"
            elif not self.pages:
                raise ScanError("The scanner didn't send a page. Make sure the lid is closed and try again.")
            else:
                self.state = "done"
        except ScanError as e:
            self.state, self.message = "error", str(e)
        except Exception as e:  # noqa: BLE001
            self.state, self.message = "error", f"Scanning failed: {e}"

    def cancel(self):
        self.cancelled = True
        if self.location:
            try:
                _http(self.location, method="DELETE", timeout=5).close()
            except Exception:  # noqa: BLE001
                pass


JOBS: dict[str, Job] = {}
PAGES: dict[str, dict] = {}
_job_lock = threading.Lock()


def start(scanner_id: str, settings: dict, out_dir: Path) -> Job:
    scanner = next((s for s in list_scanners() if s["id"] == scanner_id), None)
    if not scanner:
        raise ScanError("That scanner is no longer available. Check it's on, then press Refresh.")
    with _job_lock:
        if any(j.state in ("starting", "scanning") for j in JOBS.values()):
            raise ScanError("A scan is already running")
        job = Job(scanner, settings, out_dir)
        JOBS[job.id] = job
    job.thread.start()
    return job


# ---------------------------------------------------------------- output

def build_pdf(pages: list[dict]) -> pymupdf.Document:
    """pages: [{id, rot}] in order. JPEGs are embedded as-is (no re-encoding)."""
    doc = pymupdf.open()
    for item in pages:
        p = PAGES.get(item.get("id", ""))
        if not p:
            raise KeyError("A scanned page is no longer available")
        rot = int(item.get("rot", 0)) % 360
        w, h = p["w"] / p["dpi"] * 72, p["h"] / p["dpi"] * 72
        if rot in (90, 270):
            w, h = h, w
        page = doc.new_page(width=w, height=h)
        page.insert_image(page.rect, filename=p["path"], rotate=rot)
    return doc


def _is_gray(p: dict) -> bool:
    return pymupdf.Pixmap(p["preview"]).n == 1


def default_folder() -> Path:
    docs = cups.text(["xdg-user-dir", "DOCUMENTS"], timeout=3).strip() if shutil.which("xdg-user-dir") else ""
    base = Path(docs) if docs and docs != str(Path.home()) else Path.home() / "Documents"
    return base / "Scans"


def default_name() -> str:
    return "Scan " + datetime.now().strftime("%Y-%m-%d %H.%M")


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(2, 1000):
        cand = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not cand.exists():
            return cand
    raise ScanError("Too many files with that name")


def save(pages: list[dict], fmt: str, name: str, folder: str) -> list[str]:
    if not pages:
        raise ScanError("Nothing to save yet")
    folder_p = Path(folder).expanduser() if folder else default_folder()
    folder_p.mkdir(parents=True, exist_ok=True)
    stem = "".join(c for c in (name or default_name()) if c not in '/\\\0').strip(" .") or default_name()
    doc = build_pdf(pages)
    if fmt == "pdf":
        out = _unique(folder_p / f"{stem}.pdf")
        doc.save(out, garbage=1, deflate=True)
        return [str(out)]
    ext = "png" if fmt == "png" else "jpg"
    paths = []
    for i, item in enumerate(pages):
        suffix = f" {i + 1}" if len(pages) > 1 else ""
        out = _unique(folder_p / f"{stem}{suffix}.{ext}")
        p = PAGES[item["id"]]
        if ext == "jpg" and int(item.get("rot", 0)) % 360 == 0:
            shutil.copyfile(p["path"], out)  # untouched original
        else:
            pix = doc[i].get_pixmap(dpi=p["dpi"], colorspace=pymupdf.csGRAY if _is_gray(p) else pymupdf.csRGB)
            pix.save(out, jpg_quality=92)  # quality is ignored for PNG
        paths.append(str(out))
    return paths


def pick_folder(start: str) -> str | None:
    """Native folder chooser. Returns None if no chooser is installed, "" if cancelled."""
    start = str(Path(start).expanduser()) if start else str(default_folder())
    if shutil.which("zenity"):
        cmd = ["zenity", "--file-selection", "--directory", "--title=Save scans in", f"--filename={start.rstrip('/')}/"]
    elif shutil.which("kdialog"):
        cmd = ["kdialog", "--getexistingdirectory", start, "--title", "Save scans in"]
    else:
        return None
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=600)
    except subprocess.TimeoutExpired:
        return ""
    return r.stdout.decode().strip() if r.returncode == 0 else ""


def show_in_folder(path: str) -> None:
    p = Path(path)
    target = p if p.is_dir() else p.parent
    if not target.is_dir():
        raise ScanError("That folder no longer exists")
    subprocess.Popen(["xdg-open", str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
