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

"""Turn any input file into a print-ready PDF laid out exactly as the user chose.

The app does its own imposition (scaling, margins, orientation, pages per sheet)
and sends CUPS a PDF whose pages already match the paper. The preview is then a
render of the very file that gets printed, so what you see is what you get.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pymupdf

from .cups import media_size_mm

MM = 72 / 25.4  # points per millimetre

NATIVE = {".pdf", ".xps", ".oxps", ".epub", ".fb2", ".cbz", ".mobi", ".svg"}
IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".pnm", ".jxr", ".jpx", ".jp2"}
OFFICE = {
    ".doc", ".docx", ".odt", ".rtf", ".txt", ".md", ".html", ".htm", ".wpd", ".pages",
    ".xls", ".xlsx", ".ods", ".csv", ".ppt", ".pptx", ".odp", ".odg",
}
SUPPORTED = NATIVE | IMAGES | OFFICE

MARGIN_PRESETS = {"none": 0, "narrow": 6.35, "normal": 12.7, "wide": 25.4}
GRIDS = {1: [(1, 1)], 2: [(2, 1), (1, 2)], 4: [(2, 2)], 6: [(3, 2), (2, 3)], 9: [(3, 3)], 16: [(4, 4)]}
NUP_GAP_MM = 4


CONVERT_DIR: Path | None = None  # where converted Office files go (the server's temp dir)


class ConversionError(Exception):
    pass


def load_document(path: Path) -> pymupdf.Document:
    """Open a file of any supported type as a PDF document."""
    ext = path.suffix.lower()
    if ext in NATIVE:
        doc = pymupdf.open(path)
        if not doc.is_pdf:
            doc = pymupdf.open("pdf", doc.convert_to_pdf())
        if doc.needs_pass:
            raise ConversionError("This PDF is password-protected.")
        return doc
    if ext in IMAGES:
        img = pymupdf.open(path)
        return pymupdf.open("pdf", img.convert_to_pdf())
    if ext in OFFICE:
        return pymupdf.open(_office_to_pdf(path))
    raise ConversionError(f"Can't print {ext or 'this kind of'} files yet.")


def _office_to_pdf(path: Path) -> Path:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise ConversionError("Printing documents like this needs LibreOffice installed.")
    out = Path(tempfile.mkdtemp(prefix="conv-", dir=CONVERT_DIR))
    # A private profile avoids clashing with a LibreOffice window the user has open.
    profile = f"-env:UserInstallation=file://{out}/profile"
    r = subprocess.run([soffice, profile, "--headless", "--convert-to", "pdf", "--outdir", str(out), str(path)],
                       capture_output=True, timeout=180)
    pdf = out / (path.stem + ".pdf")
    if r.returncode != 0 or not pdf.exists():
        raise ConversionError("LibreOffice could not convert this file.")
    return pdf


# ---------------------------------------------------------------- page selection

def parse_ranges(spec: str, count: int) -> list[int]:
    """'1-3, 5, 8-' -> zero-based indexes. Empty spec means every page."""
    spec = (spec or "").strip()
    if not spec:
        return list(range(count))
    pages: list[int] = []
    for part in re.split(r"[,\s]+", spec):
        if not part:
            continue
        m = re.fullmatch(r"(\d*)\s*-\s*(\d*)", part)
        if m:
            a = int(m.group(1) or 1)
            b = int(m.group(2) or count)
            if a > b:
                a, b = b, a
            pages += range(a, b + 1)
        elif part.isdigit():
            pages.append(int(part))
        else:
            raise ValueError(f"'{part}' isn't a page number or range")
    picked = [p - 1 for p in pages if 1 <= p <= count]
    if not picked:
        raise ValueError(f"No pages in that range (this document has {count})")
    return picked


def select_pages(settings: dict, count: int) -> list[int]:
    pages = parse_ranges(settings.get("pages", ""), count)
    subset = settings.get("subset", "all")
    if subset == "odd":
        pages = [p for i, p in enumerate(pages) if i % 2 == 0]
    elif subset == "even":
        pages = [p for i, p in enumerate(pages) if i % 2 == 1]
    return pages


# ---------------------------------------------------------------- imposition

def _margins_pt(settings: dict) -> tuple[float, float, float, float]:
    preset = settings.get("margins", "normal")
    if preset == "custom":
        m = settings.get("margin_mm") or {}
        vals = [max(0.0, float(m.get(k, 0) or 0)) for k in ("top", "right", "bottom", "left")]
    else:
        vals = [MARGIN_PRESETS.get(preset, 12.7)] * 4
    return tuple(v * MM for v in vals)  # type: ignore[return-value]


def _plan_sheet(page_sizes, paper, orientation, n, margins):
    """Pick sheet orientation + grid for one sheet that makes its pages largest."""
    pw, ph = paper
    t, r, b, l = margins
    gap = NUP_GAP_MM * MM if n > 1 else 0
    sheets = []
    if orientation in ("auto", "portrait"):
        sheets.append((min(pw, ph), max(pw, ph)))
    if orientation in ("auto", "landscape"):
        sheets.append((max(pw, ph), min(pw, ph)))
    best = None
    for sw, sh in sheets:
        aw, ah = sw - l - r, sh - t - b
        if aw <= 10 or ah <= 10:
            continue
        for cols, rows in GRIDS[n]:
            cw, ch = (aw - gap * (cols - 1)) / cols, (ah - gap * (rows - 1)) / rows
            score = min(min(cw / w, ch / h) for w, h in page_sizes)
            if best is None or score > best[0] + 1e-6:
                best = (score, (sw, sh), (cols, rows), (cw, ch), gap)
    if best is None:
        raise ValueError("The margins are larger than the paper")
    return best[1:]


def impose(src: pymupdf.Document, settings: dict) -> pymupdf.Document:
    paper_mm = media_size_mm(settings.get("media", "iso_a4_210x297mm")) or (210, 297)
    paper = (paper_mm[0] * MM, paper_mm[1] * MM)
    n = int(settings.get("per_sheet", 1))
    if n not in GRIDS:
        n = 1
    orientation = settings.get("orientation", "auto")
    scale_mode = settings.get("scale_mode", "fit")
    custom = max(10.0, min(400.0, float(settings.get("scale", 100) or 100))) / 100
    margins = _margins_pt(settings)
    t, r, b, l = margins
    borders = bool(settings.get("borders")) and n > 1

    pages = select_pages(settings, src.page_count)
    if settings.get("reverse"):
        pages = pages[::-1]

    out = pymupdf.open()
    for start in range(0, len(pages), n):
        group = pages[start:start + n]
        sizes = [(src[p].rect.width, src[p].rect.height) for p in group]
        (sw, sh), (cols, rows), (cw, ch), gap = _plan_sheet(sizes, paper, orientation, n, margins)
        sheet = out.new_page(width=sw, height=sh)
        for i, pno in enumerate(group):
            col, row = i % cols, i // cols
            cell = pymupdf.Rect(l + col * (cw + gap), t + row * (ch + gap), 0, 0)
            cell.x1, cell.y1 = cell.x0 + cw, cell.y0 + ch
            w, h = sizes[i]
            fit = min(cw / w, ch / h)
            clip = None
            if scale_mode == "actual" and n == 1:
                s = 1.0
            elif scale_mode == "custom" and n == 1:
                s = custom
            elif scale_mode == "fill":
                s = max(cw / w, ch / h)
                # Crop the source to the cell's shape instead of overflowing it.
                vw, vh = cw / s, ch / s
                src_rect = src[pno].rect
                clip = pymupdf.Rect(src_rect.x0 + (w - vw) / 2, src_rect.y0 + (h - vh) / 2, 0, 0)
                clip.x1, clip.y1 = clip.x0 + vw, clip.y0 + vh
                w, h = vw, vh
            else:
                s = fit
            tw, th = w * s, h * s
            cx, cy = (cell.x0 + cell.x1) / 2, (cell.y0 + cell.y1) / 2
            target = pymupdf.Rect(cx - tw / 2, cy - th / 2, cx + tw / 2, cy + th / 2)
            sheet.show_pdf_page(target, src, pno, clip=clip)
            if borders:
                sheet.draw_rect(target, color=(0.6, 0.6, 0.6), width=0.5)
    return out


def render_sheet(doc: pymupdf.Document, index: int, width_px: int = 900, gray: bool = False) -> bytes:
    page = doc[index]
    zoom = width_px / page.rect.width
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csGRAY if gray else pymupdf.csRGB,
                          alpha=False)
    return pix.tobytes("png")


def split_for_manual_duplex(doc: pymupdf.Document) -> tuple[pymupdf.Document, pymupdf.Document]:
    """Fronts (sheets 1,3,5…) and backs (2,4,6… in reverse) for printers without duplex.

    After the fronts print, the stack is turned over and fed back in; printing the
    backs last-to-first lines each back up with its front. An odd sheet count gets
    a blank back so the stack stays aligned.
    """
    fronts, backs = pymupdf.open(), pymupdf.open()
    count = doc.page_count
    for i in range(0, count, 2):
        fronts.insert_pdf(doc, from_page=i, to_page=i)
    if count % 2:  # printed first, since the backs go last-to-first
        last = doc[count - 1].rect
        backs.new_page(width=last.width, height=last.height)
    for i in reversed(range(1, count, 2)):
        backs.insert_pdf(doc, from_page=i, to_page=i)
    return fronts, backs
