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

"""Everything that talks to CUPS: printer discovery, capabilities, jobs, repair.

Uses the stock CUPS command-line tools (lpstat, lp, ipptool, ...) so the app
works on any distro that ships CUPS, with no compiled bindings.
"""

from __future__ import annotations

import getpass
import re
import shutil
import socket
import subprocess
import time
from dataclasses import dataclass, field

PRINTER_ATTRS = (
    "printer-name printer-info printer-make-and-model printer-location "
    "printer-state printer-state-message printer-state-reasons printer-is-accepting-jobs "
    "media-supported media-default sides-supported sides-default "
    "print-color-mode-supported print-color-mode-default "
    "print-quality-supported print-quality-default copies-supported "
    "marker-names marker-levels marker-colors marker-types device-uri"
).split()

QUALITY_ENUM = {"3": "draft", "4": "normal", "5": "high"}
STATE_ENUM = {"3": "idle", "4": "printing", "5": "stopped"}


def run(cmd: list[str], timeout: float = 15, input: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, timeout=timeout, input=input)


def text(cmd: list[str], timeout: float = 15) -> str:
    try:
        return run(cmd, timeout).stdout.decode(errors="replace")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""


# ---------------------------------------------------------------- IPP queries

def _ipp_attrs(uri: str, attrs: list[str], timeout: float = 8) -> dict[str, list[str]]:
    """Get-Printer-Attributes via ipptool, parsed into {name: [values]}."""
    test = (
        "{\n OPERATION Get-Printer-Attributes\n GROUP operation-attributes-tag\n"
        " ATTR charset attributes-charset utf-8\n ATTR naturalLanguage attributes-natural-language en\n"
        " ATTR uri printer-uri $uri\n"
        f" ATTR keyword requested-attributes {','.join(attrs)}\n"
        "}\n"
    )
    try:
        out = run(["ipptool", "-tv", uri, "/dev/stdin"], timeout, test.encode()).stdout.decode(errors="replace")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return {}
    result: dict[str, list[str]] = {}
    for line in out.splitlines():
        m = re.match(r"\s+([a-z0-9-]+) \(([^)]*)\) = (.*)$", line)
        if m and m.group(1) in attrs:
            result[m.group(1)] = m.group(3).split(",") if "1setOf" in m.group(2) else [m.group(3)]
    return result


def media_size_mm(keyword: str) -> tuple[float, float] | None:
    """PWG media keyword -> (width_mm, height_mm). e.g. iso_a4_210x297mm."""
    m = re.search(r"_([\d.]+)x([\d.]+)(mm|in)$", keyword)
    if not m:
        return None
    w, h = float(m.group(1)), float(m.group(2))
    if m.group(3) == "in":
        w, h = w * 25.4, h * 25.4
    return round(w, 1), round(h, 1)


_MEDIA_NAMES = {
    "iso_a3": "A3", "iso_a4": "A4", "iso_a5": "A5", "iso_a6": "A6", "iso_b5": "B5", "jis_b5": "B5 (JIS)",
    "na_letter": "Letter", "na_legal": "Legal", "na_executive": "Executive", "na_foolscap": "Foolscap",
    "na_oficio": "Oficio", "na_index-4x6": "Photo 4×6\"", "na_5x7": "Photo 5×7\"",
    "na_govt-letter": "Photo 8×10\"", "oe_photo-l": "Photo L (3.5×5\")", "jpn_hagaki": "Postcard (Hagaki)",
    "na_number-10": "Envelope #10", "iso_dl": "Envelope DL", "iso_c5": "Envelope C5",
    "na_monarch": "Envelope Monarch", "jpn_chou3": "Envelope Chou 3", "jpn_chou4": "Envelope Chou 4",
    "jpn_you4": "Envelope You 4", "jpn_you6": "Envelope You 6",
}


def media_label(keyword: str) -> str:
    prefix = "_".join(keyword.split("_")[:2])
    size = media_size_mm(keyword)
    dims = f"{size[0]:g} × {size[1]:g} mm" if size else ""
    name = _MEDIA_NAMES.get(prefix)
    if not name:
        name = dims or keyword
        dims = ""
    return f"{name} · {dims}" if dims else name


@dataclass
class Printer:
    name: str
    info: str = ""
    model: str = ""
    location: str = ""
    state: str = "unknown"
    state_message: str = ""
    reasons: list[str] = field(default_factory=list)
    accepting: bool = True
    is_default: bool = False
    temporary: bool = False  # auto-discovered, not yet a permanent queue
    uri: str = ""
    media: list[dict] = field(default_factory=list)
    media_default: str = "iso_a4_210x297mm"
    duplex: bool = False
    color: bool = True
    qualities: list[str] = field(default_factory=lambda: ["normal"])
    max_copies: int = 99
    ink: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return self.__dict__.copy()


_cache: dict[str, tuple[float, Printer]] = {}


def default_printer() -> str:
    out = text(["lpstat", "-d"])
    m = re.search(r"destination: (\S+)", out)
    return m.group(1) if m else ""


def list_printers(refresh: bool = False) -> list[Printer]:
    dests = {}  # name -> (kind, uri) from "lpstat -l -e": "NAME permanent|network|... ... URI"
    for line in text(["lpstat", "-l", "-e"]).splitlines():
        parts = line.split()
        if len(parts) >= 2:
            dests[parts[0]] = (parts[1], parts[-1])
    default = default_printer()
    printers, permanent_models = [], []
    for name, (kind, uri) in dests.items():
        if kind != "permanent":
            continue
        p = printer_details(name, refresh)
        p.is_default = name == default
        printers.append(p)
        permanent_models.append(_norm(p.model or p.name))
    for name, (kind, uri) in dests.items():
        # CUPS also lists printers it auto-discovered (network / ipp-usb). Hide the ones
        # that are just another path to a printer that's already set up.
        if kind == "permanent" or any(m and m in _norm(name) for m in permanent_models):
            continue
        p = Printer(name=name, info=name.replace("_", " "), temporary=True, uri=uri, is_default=name == default,
                    state="idle", state_message="Found automatically — not set up yet")
        printers.append(p)
    # Permanent queues first, default first of all.
    printers.sort(key=lambda p: (not p.is_default, p.temporary, p.name.lower()))
    return printers


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def printer_details(name: str, refresh: bool = False) -> Printer:
    hit = _cache.get(name)
    if hit and not refresh and time.time() - hit[0] < 20:
        return hit[1]
    a = _ipp_attrs(f"ipp://localhost/printers/{name}", PRINTER_ATTRS)
    one = lambda k, d="": (a.get(k) or [d])[0]
    p = Printer(name=name)
    p.info = one("printer-info", name)
    p.model = one("printer-make-and-model").replace(" - IPP Everywhere", "")
    p.location = one("printer-location")
    p.state = STATE_ENUM.get(one("printer-state"), one("printer-state", "unknown"))
    p.state_message = one("printer-state-message")
    p.reasons = [r for r in a.get("printer-state-reasons", []) if r != "none"]
    p.accepting = one("printer-is-accepting-jobs", "true") == "true"
    p.uri = one("device-uri")
    media = [m for m in a.get("media-supported", []) if media_size_mm(m) and not m.startswith("custom_m")]
    p.media = [{"id": m, "label": media_label(m), "mm": media_size_mm(m)} for m in media]
    p.media_default = one("media-default", media[0] if media else "iso_a4_210x297mm")
    p.duplex = any(s.startswith("two-sided") for s in a.get("sides-supported", []))
    p.color = "color" in a.get("print-color-mode-supported", ["color"])
    p.qualities = [QUALITY_ENUM.get(q, q) for q in a.get("print-quality-supported", ["4"])]
    if m := re.match(r"\d+-(\d+)", one("copies-supported", "1-99")):
        p.max_copies = int(m.group(1))
    names_, levels, colors = a.get("marker-names", []), a.get("marker-levels", []), a.get("marker-colors", [])
    for i, n in enumerate(names_):
        try:
            level = int(levels[i])
        except (IndexError, ValueError):
            level = -1
        p.ink.append({"name": n, "level": level, "color": colors[i] if i < len(colors) else "#888"})
    if not a:  # printer unreachable: fall back to lpstat so it still shows up
        out = text(["lpstat", "-p", name])
        p.state = "printing" if "printing" in out else "stopped" if "disabled" in out else "idle"
        p.state_message = "Could not read printer details"
    _cache[name] = (time.time(), p)
    return p


# ---------------------------------------------------------------- jobs

JOB_STATE = {"3": "pending", "4": "held", "5": "printing", "6": "stopped", "7": "cancelled", "8": "aborted",
             "9": "completed"}


def get_jobs(which: str = "not-completed") -> list[dict]:
    """This user's jobs via IPP Get-Jobs, newest first. which: not-completed | completed."""
    test = (
        "{\n OPERATION Get-Jobs\n GROUP operation-attributes-tag\n"
        " ATTR charset attributes-charset utf-8\n ATTR naturalLanguage attributes-natural-language en\n"
        " ATTR uri printer-uri $uri\n"
        f" ATTR name requesting-user-name {getpass.getuser()}\n"
        f" ATTR keyword which-jobs {which}\n ATTR boolean my-jobs true\n"
        " ATTR keyword requested-attributes job-id,job-name,job-state,job-printer-uri,time-at-creation,"
        "time-at-completed,job-impressions-completed,job-printer-state-message,job-state-reasons\n}\n"
    )
    try:
        out = run(["ipptool", "-tv", "ipp://localhost/", "/dev/stdin"], 10, test.encode()).stdout.decode(errors="replace")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    out = out.split("RECEIVED", 1)[-1]
    jobs = []
    for block in out.split("-- separator --"):
        a = dict(re.findall(r"^\s+([a-z-]+) \([^)]*\) = (.*)$", block, re.M))
        if "job-id" not in a:
            continue
        jobs.append({
            "id": a["job-id"],
            "title": a.get("job-name", ""),
            "printer": a.get("job-printer-uri", "").rsplit("/", 1)[-1],
            "state": JOB_STATE.get(a.get("job-state", ""), a.get("job-state", "unknown")),
            "created": int(a.get("time-at-creation", 0) or 0),
            "completed": int(a.get("time-at-completed", 0) or 0),
            "pages": int(a.get("job-impressions-completed", 0) or 0),
            # Driverless queues log harmless filter chatter here; don't show it as a status.
            "status": "" if "Unable to detect" in a.get("job-printer-state-message", "") else a.get("job-printer-state-message", ""),
        })
    jobs.sort(key=lambda j: int(j["id"]), reverse=True)
    return jobs


def cancel_job(job_id: str) -> tuple[bool, str]:
    r = run(["cancel", str(job_id)])
    return r.returncode == 0, r.stderr.decode().strip()


def remove_from_history(job_ids: list[str]) -> tuple[bool, str]:
    """Purge finished jobs (and their spooled files) from CUPS' history.

    `cancel -x` works without root for the user's own jobs.
    """
    if not job_ids:
        return True, ""
    r = run(["cancel", "-x", *map(str, job_ids)])
    return r.returncode == 0, r.stderr.decode().strip()


def submit(printer: str, pdf_path: str, title: str, options: dict[str, str], copies: int = 1) -> tuple[bool, str]:
    cmd = ["lp", "-d", printer, "-t", title, "-n", str(copies)]
    for k, v in options.items():
        cmd += ["-o", f"{k}={v}"]
    cmd.append(pdf_path)
    r = run(cmd, timeout=60)
    out = r.stdout.decode() + r.stderr.decode()
    m = re.search(r"request id is (\S+)", out)
    return r.returncode == 0, m.group(1) if m else out.strip()


# ---------------------------------------------------------------- setup / repair

def set_user_default(name: str) -> tuple[bool, str]:
    r = run(["lpoptions", "-d", name])
    return r.returncode == 0, r.stderr.decode().strip()


def discover() -> list[dict]:
    """Driverless printers visible on the network or via ipp-usb."""
    out = text(["ippfind", "-T", "4", "_ipp._tcp", "-p"], timeout=10) if shutil.which("ippfind") else ""
    found, seen = [], set()
    me = socket.gethostname().lower()
    configured = {(_norm(p.model), p.uri) for p in list_printers() if not p.temporary}
    for uri in out.split():
        # ipp-usb advertises USB printers under this machine's own hostname.
        uri = re.sub(rf"//({re.escape(me)}\.local|127\.0\.0\.1)(?=:)", "//localhost", uri, flags=re.I)
        if uri in seen or "/printers/" in uri:  # skip queues shared by CUPS itself
            continue
        seen.add(uri)
        a = _ipp_attrs(uri, ["printer-make-and-model", "printer-info"], timeout=5)
        model = (a.get("printer-make-and-model") or a.get("printer-info") or [uri])[0].replace(" - IPP Everywhere", "")
        usb = uri.startswith("ipp://localhost:")
        found.append({"uri": uri, "model": model, "usb": usb,
                      "configured": any(u == uri or (m and m in _norm(model)) for m, u in configured)})
    return found


def _tool(name: str) -> str | None:
    # Debian/Ubuntu keep admin tools like ipp-usb in sbin, which isn't on a normal user's PATH.
    return shutil.which(name) or shutil.which(name, path="/usr/sbin:/sbin:/usr/local/sbin")


def ipp_usb_status() -> dict:
    exe = _tool("ipp-usb")
    if not exe:
        return {"installed": False, "running": False, "devices": []}
    out = text([exe, "status"], timeout=5)
    devices = []
    for m in re.finditer(r'\d+\.\s+(.+?)\s+([0-9a-f]{4}:[0-9a-f]{4})\s+(\S+)\s+"([^"]*)"\s*\n\s+status:\s*(.*)', out):
        devices.append({"model": m.group(4), "port": m.group(3), "status": m.group(5).strip()})
    return {"installed": True, "running": "daemon: running" in out, "devices": devices}


def _pkexec(script: str) -> tuple[bool, str]:
    """Run a root shell snippet behind the desktop's graphical password prompt."""
    if not shutil.which("pkexec"):
        return False, "pkexec (polkit) is not installed"
    try:
        r = run(["pkexec", "/bin/sh", "-c", script], timeout=180)
    except subprocess.TimeoutExpired:
        return False, "Timed out waiting for the password prompt"
    if r.returncode in (126, 127):
        return False, "Cancelled"
    return r.returncode == 0, (r.stdout + r.stderr).decode().strip()


def add_printer(name: str, uri: str) -> tuple[bool, str]:
    name = re.sub(r"[^A-Za-z0-9_-]+", "-", name).strip("-")[:60] or "Printer"
    uri_q = uri.replace("'", "")
    return _pkexec(f"lpadmin -p '{name}' -E -v '{uri_q}' -m everywhere")


def remove_printer(name: str) -> tuple[bool, str]:
    return _pkexec(f"lpadmin -x '{name}'")


def repair() -> tuple[bool, str]:
    """Clear the usual causes of a printer that 'prints' but nothing comes out.

    A legacy usb:// queue can leave a backend process holding the USB port, which
    blocks ipp-usb (libusb 'Resource busy'). Kill it, restart ipp-usb, re-enable
    queues that CUPS stopped after an error.
    """
    script = (
        "pkill -9 -f '^usb://' ; "
        "systemctl restart ipp-usb 2>/dev/null ; "
        "for p in $(lpstat -p 2>/dev/null | awk '/disabled/ {print $2}'); do cupsenable \"$p\"; cupsaccept \"$p\"; done ; "
        "sleep 3 ; true"
    )
    ok, msg = _pkexec(script)
    _cache.clear()
    return ok, msg
