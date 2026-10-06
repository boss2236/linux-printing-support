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

"""Linux Printing Support — a friendly print dialog for driverless printers."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

__version__ = "1.0.0"

BROWSERS = ("chromium", "google-chrome-stable", "google-chrome", "brave", "brave-browser",
            "microsoft-edge-stable", "vivaldi-stable")


def _app_window(url: str) -> subprocess.Popen | None:
    """Open the UI in a chromeless app window that we can wait on."""
    for name in BROWSERS:
        exe = shutil.which(name)
        if not exe:
            continue
        # A dedicated profile makes this its own browser process, so the app quits
        # when its window closes instead of handing off to an already-open browser.
        profile = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "linux-printing-support/window"
        profile.mkdir(parents=True, exist_ok=True)
        return subprocess.Popen([
            exe, f"--app={url}", f"--user-data-dir={profile}", "--class=linux-printing-support",
            "--window-size=1320,880", "--no-first-run", "--no-default-browser-check",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return None


def main() -> None:
    ap = argparse.ArgumentParser(prog="linux-printing-support", description="Print anything, the easy way.")
    ap.add_argument("files", nargs="*", help="documents to open (PDF, images, Office files, …)")
    ap.add_argument("--port", type=int, default=0, help="port for the local UI (default: any free port)")
    ap.add_argument("--no-window", action="store_true", help="just print the URL; don't open a window")
    args = ap.parse_args()

    from .server import WORK, serve  # deferred so --help is instant

    httpd, url = serve(args.port, args.files)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    window = None if args.no_window else _app_window(url)
    if window is None:
        print(f"Linux Printing Support is running at:\n  {url}\nPress Ctrl+C to quit.", flush=True)
        if not args.no_window:
            webbrowser.open(url)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
    else:
        try:
            window.wait()
        except KeyboardInterrupt:
            window.terminate()
    httpd.shutdown()
    shutil.rmtree(WORK, ignore_errors=True)  # temp copies of opened files + converted docs
    sys.exit(0)
