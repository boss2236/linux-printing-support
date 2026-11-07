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

"""How a printer is connected: USB (via ipp-usb), Wi-Fi/network, or both.

Driverless printers announce themselves over mDNS with a UUID in their TXT
record. ipp-usb re-announces USB printers on the loopback interface with the
same UUID, so one physical printer can be matched across USB and Wi-Fi.
"""

from __future__ import annotations

import ipaddress
import re
import shutil
import ssl
import subprocess
import threading
import time
import urllib.request
from urllib.parse import urlparse

from . import cups

_lock = threading.Lock()
_browse_cache: dict[str, tuple[float, list[dict]]] = {}


def _unescape(s: str) -> str:
    # avahi-browse -p escapes bytes as \DDD (decimal).
    return re.sub(r"\\(\d{3})", lambda m: chr(int(m.group(1))), s)


def browse(service: str, max_age: float = 6) -> list[dict]:
    """Resolved IPv4 mDNS announcements for a service type, e.g. _ipp._tcp."""
    with _lock:
        hit = _browse_cache.get(service)
        if hit and time.time() - hit[0] < max_age:
            return hit[1]
    exe = shutil.which("avahi-browse")
    out = ""
    if exe:
        try:
            out = subprocess.run([exe, "-rtp", service], capture_output=True, timeout=10).stdout.decode(errors="replace")
        except subprocess.TimeoutExpired as e:
            out = (e.stdout or b"").decode(errors="replace")
    found, seen = [], set()
    for line in out.splitlines():
        parts = line.split(";", 9)
        if len(parts) < 10 or parts[0] != "=" or parts[2] != "IPv4":
            continue
        iface, name, host, addr, port, txt_raw = parts[1], _unescape(parts[3]), parts[6], parts[7], parts[8], parts[9]
        txt = {}
        for item in re.findall(r'"((?:[^"\\]|\\.)*)"', txt_raw):
            k, _, v = _unescape(item).partition("=")
            txt[k.lower()] = v
        key = (name, addr, port)
        if key in seen:  # the same printer is seen once per network interface
            continue
        seen.add(key)
        found.append({"iface": iface, "name": name, "host": host.rstrip("."), "addr": addr, "port": int(port),
                      "txt": txt, "usb": iface == "lo" or addr.startswith("127.")})
    with _lock:
        _browse_cache[service] = (time.time(), found)
    return found


def norm_uuid(u: str) -> str:
    return u.lower().removeprefix("urn:uuid:").strip()


def _fetch(url: str, timeout: float = 3) -> str:
    """GET a page from a printer. Printers use self-signed certificates, so HTTPS isn't verified;
    only harmless status pages are read this way."""
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
    for _ in range(2):
        try:
            with urllib.request.urlopen(url, timeout=timeout, context=ctx) as r:
                body = r.read(200_000).decode(errors="replace")
        except Exception:  # noqa: BLE001 - best effort
            return ""
        # Some printers bounce plain HTTP to HTTPS with a meta refresh instead of a redirect.
        m = re.search(r'http-equiv="refresh"\s+content="0;\s*url=(https://[^"]+)"', body, re.I)
        if not m:
            return body
        url = m.group(1)
    return ""


_uuid_cache: dict[str, str] = {}


def device_uuid(uri: str) -> str:
    """UUID of the physical device behind a CUPS device-uri."""
    if uri in _uuid_cache:
        return _uuid_cache[uri]
    u = ""
    if m := re.search(r"[?&]uuid=([0-9a-fA-F-]{36})", uri):  # dnssd://…?uuid=…
        u = m.group(1)
    elif uri.startswith(("ipp://", "ipps://")):
        u = (cups._ipp_attrs(uri, ["printer-uuid"], timeout=4).get("printer-uuid") or [""])[0]
    u = norm_uuid(u)
    if u:
        _uuid_cache[uri] = u
    return u


def _is_local_host(host: str) -> bool:
    host = (host or "").lower().rstrip(".")
    if host in ("localhost",) or host.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        return False


def safe_admin_url(url: str) -> bool:
    """Only open printer pages on this machine or the local network."""
    p = urlparse(url)
    return p.scheme in ("http", "https") and _is_local_host(p.hostname or "")


def _admin_for(entry: dict) -> str:
    url = entry["txt"].get("adminurl", "")
    if not url:
        return f"http://{entry['addr']}/" if not entry["usb"] else ""
    # Point at the IP: mDNS names often resolve to IPv6 link-local first, which browsers dislike.
    p = urlparse(url)
    if not entry["usb"] and p.hostname and p.hostname.rstrip(".").endswith(".local"):
        url = url.replace(p.netloc, entry["addr"] + (f":{p.port}" if p.port else ""), 1)
    return url


def wifi_signal(admin_url: str) -> int | None:
    """Signal strength in % if the printer's web page reports it (Canon Remote UI does)."""
    p = urlparse(admin_url)
    if not p.scheme:
        return None
    js = _fetch(f"{p.scheme}://{p.netloc}/rui/JS_MDL/model_top.js", timeout=2.5)
    m = re.search(r"g_signal_strength\s*=\s*'(\d+)'", js)
    return int(m.group(1)) if m else None


def computer_network() -> list[dict]:
    """The computer's active connections, so we can say 'same network?'."""
    if not shutil.which("nmcli"):
        return []
    out = cups.text(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"], timeout=4)
    nets = []
    for line in out.splitlines():
        parts = re.split(r"(?<!\\):", line)
        if len(parts) < 3:
            continue
        name, typ = parts[0].replace("\\:", ":"), parts[1]
        if typ.endswith("wireless"):
            nets.append({"type": "wifi", "name": name})
        elif typ.endswith("ethernet"):
            nets.append({"type": "ethernet", "name": name})
    return nets


def connection(printer_name: str) -> dict:
    """Everything the 'Printer & Wi-Fi' panel shows for one printer queue."""
    p = cups.printer_details(printer_name)
    uri = p.uri
    uuid = device_uuid(uri) if uri else ""
    entries = [e for e in browse("_ipp._tcp") if uuid and norm_uuid(e["txt"].get("uuid", "")) == uuid]
    usb = next((e for e in entries if e["usb"]), None)
    net = next((e for e in entries if not e["usb"]), None)
    if not uuid:  # can't match by UUID (unreachable, or not driverless): fall back to the model name
        model = cups._norm(p.model)
        same = [e for e in browse("_ipp._tcp") if model and model in cups._norm(e["txt"].get("ty", e["name"]))]
        usb = usb or next((e for e in same if e["usb"]), None)
        net = net or next((e for e in same if not e["usb"]), None)

    # Which of the user's queues point at this same printer, and how.
    queues = []
    for q in cups.list_printers():
        if q.temporary or not q.uri:
            continue
        if q.name == printer_name or (uuid and device_uuid(q.uri) == uuid):
            queues.append({"name": q.name, "info": q.info, "kind": cups.connection_kind(q.uri)})

    net_info = None
    if net:
        rp = net["txt"].get("rp", "ipp/print")
        admin = _admin_for(net)
        net_info = {
            "host": net["host"], "addr": net["addr"], "admin": admin,
            "uri": f"ipp://{net['host']}:{net['port']}/{rp}",
        }
    usb_admin = _admin_for(usb) if usb else ""
    if net_info:  # ask over USB when we can: it's quicker and needs no certificate dance
        net_info["signal"] = (wifi_signal(usb_admin) if usb_admin else None) or wifi_signal(net_info["admin"])
    return {
        "printer": printer_name, "model": p.model or p.info, "uuid": uuid,
        "current": cups.connection_kind(uri) if uri else "",
        "usb": {"admin": usb_admin} if usb else None,
        "network": net_info,
        "queues": queues,
        "admin": usb_admin or (net_info or {}).get("admin", ""),
        "computer": computer_network(),
    }


def open_url(url: str) -> tuple[bool, str]:
    if not safe_admin_url(url):
        return False, "Only printer pages on your own network can be opened"
    if not shutil.which("xdg-open"):
        return False, "xdg-open is not installed"
    subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return True, ""
