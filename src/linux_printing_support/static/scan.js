"use strict";
/*
 * Copyright 2026 boss2236 — https://github.com/boss2236/linux-printing-support
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Scan mode. Shares $, api, toast, modal, icon, esc, store, armed… with app.js.

const SCAN_DEFAULTS = { source: "platen", color: "RGB24", resolution: 300, size: "a4", duplex: false, format: "pdf", folder: "" };
const sc = {
  loaded: false, scanners: [], scanner: null, caps: null, status: null,
  pages: [],          // [{id, w, h, dpi, rot}]
  job: null, pendingSince: 0, thumb: store.get("scan.thumb", 210), saved: false,
  o: { ...SCAN_DEFAULTS, ...store.get("scan.opts", {}) },
  name: "", defaultFolder: "",
};

const RES_LABELS = { 75: "Draft", 100: "Draft", 150: "Fast", 200: "Fast", 300: "Standard", 400: "Fine", 600: "Fine", 1200: "Maximum" };
const FORMAT_HINT = { pdf: "All pages in one PDF document.", jpg: "One JPEG image per page. Best for photos.", png: "One PNG image per page. Lossless, larger files." };
const homeShort = (p) => String(p || "").replace(/^\/home\/[^/]+/, "~");

// ------------------------------------------------------------ mode switching
function setMode(mode) {
  const scan = mode === "scan";
  document.body.classList.toggle("mode-scan", scan);
  $("#printMain").classList.toggle("hidden", scan);
  $("#scanMain").classList.toggle("hidden", !scan);
  $$("#modeTabs button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("#topSpacer").classList.toggle("hidden", !scan && !!state.doc);
  closeScannerMenu();
  toggleMenu(false);
  store.set("mode", mode);
  if (scan) {
    document.title = "Scan — Linux Printing Support";
    if (!sc.loaded) loadScanners();
    else refreshScannerStatus();
  } else {
    document.title = state.doc ? `${state.doc.name} — Linux Printing Support` : "Linux Printing Support";
  }
}
window.setMode = setMode;

// ------------------------------------------------------------ scanners
async function loadScanners(refresh = false) {
  sc.loaded = true;
  if (refresh || !sc.scanners.length) {
    $("#sName").textContent = "Looking for scanners…";
    $("#sSub").innerHTML = "&nbsp;";
  }
  try {
    const data = await api("/api/scanners");
    sc.scanners = data.scanners;
    sc.defaultFolder = data.folder;
    if (!sc.name) sc.name = data.name;
  } catch (e) {
    toast(e.message, "bad");
    sc.scanners = [];
  }
  const wanted = sc.scanner?.id || store.get("scanner", null);
  // Prefer the scanner that belongs to the printer picked in Print mode.
  const printerModel = (state.printer?.model || "").toLowerCase();
  const pick = sc.scanners.find((s) => s.id === wanted)
    || sc.scanners.find((s) => printerModel && s.model.toLowerCase().includes(printerModel))
    || sc.scanners[0] || null;
  await setScanner(pick, false);
  renderSaveSection();
}

async function setScanner(s, userChose = true) {
  sc.scanner = s;
  sc.caps = null;
  if (s && userChose) store.set("scanner", s.id);
  renderScanner();
  if (!s) { renderScanOptions(); return; }
  try {
    const r = await api("/api/scanner?id=" + encodeURIComponent(s.id));
    if (sc.scanner?.id !== s.id) return;
    sc.caps = r.caps;
    sc.status = r.status;
  } catch (e) {
    sc.status = { state: "offline", error: e.message };
  }
  renderScanner();
  renderScanOptions();
}

async function refreshScannerStatus() {
  if (!sc.scanner || sc.job) return;
  try {
    sc.status = await api("/api/scanner/status?id=" + encodeURIComponent(sc.scanner.id));
    renderScanner();
    renderSourceHint();
  } catch { /* keep last */ }
}

const connLabel = (s) => s.connection === "usb" ? "USB" : "Wi-Fi";
const scannerStateText = () => {
  const st = sc.status?.state;
  if (sc.job) return "Scanning…";
  if (!st) return "Checking…";
  if (st === "offline") return "Not responding";
  if (st === "Idle") return "Ready";
  if (st === "Processing") return "Busy";
  return st;
};

function renderScanner() {
  const s = sc.scanner;
  $("#sName").textContent = s ? s.model : "No scanner found";
  $("#sSub").innerHTML = s
    ? `${esc(scannerStateText())} · ${icon(s.connection === "usb" ? "i-usb" : "i-wifi", 12).replace("<svg", '<svg style="display:inline;vertical-align:-1px;margin-right:3px"')}${connLabel(s)}`
    : "Plug in or switch on a printer that can scan";
  const st = sc.status?.state;
  $("#sDot").className = "status-dot " + (!s ? "stopped" : sc.job ? "printing" : st === "Idle" ? "idle" : st === "offline" ? "stopped" : "");

  let alert = "";
  if (!s && sc.loaded) {
    alert = alertBox("No scanner found", "Make sure the printer is switched on and plugged in by USB or on the same Wi-Fi, then press Refresh.", "", "Refresh", "refresh");
  } else if (s && st === "offline") {
    alert = alertBox("The scanner isn't responding", "It may be asleep or switched off. Wake it up, then try again.", "bad", "Retry", "retry");
  } else if (/Jam/i.test(sc.status?.adf || "")) {
    alert = alertBox("Paper jam in the feeder", "Open the feeder cover and remove the stuck page.", "bad");
  }
  $("#scannerAlert").innerHTML = alert;
  $("#scannerAlert [data-act=refresh]")?.addEventListener("click", () => loadScanners(true));
  $("#scannerAlert [data-act=retry]")?.addEventListener("click", () => setScanner(sc.scanner, false));
  updateScanFoot();
}

function closeScannerMenu() {
  $("#scannerMenu")?.classList.add("hidden");
  $("#scannerCard")?.classList.remove("open");
}

function toggleScannerMenu() {
  const menu = $("#scannerMenu");
  const open = menu.classList.contains("hidden");
  if (!open) return closeScannerMenu();
  menu.classList.remove("hidden");
  $("#scannerCard").classList.add("open");
  const items = sc.scanners.map((s) => `
    <button class="menu-item ${s.id === sc.scanner?.id ? "active" : ""}" data-id="${esc(s.id)}">
      <div class="printer-glyph" style="width:32px;height:32px">${icon(s.connection === "usb" ? "i-usb" : "i-wifi", 17)}</div>
      <div class="grow"><div class="printer-name">${esc(s.model)}</div>
        <div class="printer-sub">${s.connection === "usb" ? "USB cable · fastest" : "Wi-Fi · no cable needed"}</div></div>
    </button>`).join("");
  const admin = sc.caps?.admin || sc.scanner?.admin;
  menu.innerHTML = `${items || '<div class="empty-note">No scanners found</div>'}
    <div class="menu-sep"></div>
    ${admin ? `<button class="menu-item subtle" data-act="admin">${icon("i-ext")}Scanner settings page</button>` : ""}
    <button class="menu-item subtle" data-act="refresh">${icon("i-refresh")}Refresh</button>`;
  $$(".menu-item[data-id]", menu).forEach((b) => b.addEventListener("click", () => {
    closeScannerMenu();
    setScanner(sc.scanners.find((s) => s.id === b.dataset.id));
  }));
  $$(".menu-item[data-act]", menu).forEach((b) => b.addEventListener("click", async () => {
    closeScannerMenu();
    if (b.dataset.act === "refresh") { await loadScanners(true); toast("Scanners refreshed"); }
    if (b.dataset.act === "admin") {
      try { await api("/api/open-url", { url: admin }); } catch (e) { toast(e.message, "bad"); }
    }
  }));
}

// ------------------------------------------------------------ options
const srcCaps = () => sc.caps?.sources?.[sc.o.source] || (sc.caps && Object.values(sc.caps.sources)[0]) || null;

function setOpt(patch) {
  Object.assign(sc.o, patch);
  store.set("scan.opts", sc.o);
  renderScanOptions();
}

function renderScanOptions() {
  const caps = sc.caps;
  const has = (k) => !!caps?.sources?.[k];
  if (caps && !has(sc.o.source)) sc.o.source = has("platen") ? "platen" : "feeder";
  const src = srcCaps();

  const srcSeg = $('[data-scan="source"]');
  $('[data-v="platen"]', srcSeg).disabled = caps ? !has("platen") : false;
  $('[data-v="feeder"]', srcSeg).disabled = caps ? !has("feeder") : false;
  $('[data-v="feeder"]', srcSeg).classList.toggle("hidden", !!caps && !has("feeder"));

  if (src) {
    if (!src.colors.includes(sc.o.color)) sc.o.color = src.colors[0];
    $$('[data-scan="color"] button').forEach((b) => { b.disabled = !src.colors.includes(b.dataset.v); });

    // A handful of sensible steps rather than every resolution the scanner knows.
    let res = [150, 300, 600, 1200].filter((r) => src.resolutions.includes(r));
    if (res.length < 2) res = src.resolutions.slice(-4);
    if (!res.includes(+sc.o.resolution)) sc.o.resolution = res.includes(300) ? 300 : res[Math.floor(res.length / 2)];
    $("#resChips").style.setProperty("--n", res.length);
    $("#resChips").innerHTML = res.map((r) => `<button class="chip ${+sc.o.resolution === r ? "on" : ""}" data-v="${r}"><b>${r}</b><span>${RES_LABELS[r] || "dpi"}</span></button>`).join("");
    $$("#resChips .chip").forEach((c) => c.addEventListener("click", () => setOpt({ resolution: +c.dataset.v })));

    if (!src.sizes.some((x) => x.id === sc.o.size)) sc.o.size = src.sizes.some((x) => x.id === "a4") ? "a4" : src.sizes[0].id;
    $("#scanSize").innerHTML = src.sizes.map((x) => `<option value="${esc(x.id)}" ${x.id === sc.o.size ? "selected" : ""}>${esc(x.label)}</option>`).join("");
    $("#duplexRow").classList.toggle("hidden", !(sc.o.source === "feeder" && src.duplex));
  }
  $("#scanDuplex").checked = !!sc.o.duplex;
  $$(".seg[data-scan]").forEach((seg) => {
    $$("button", seg).forEach((b) => b.classList.toggle("on", String(sc.o[seg.dataset.scan]) === b.dataset.v));
  });
  $("#resHint").textContent = `${sc.o.resolution} dpi`;
  $("#sizeHint").textContent = sc.o.size === "auto" ? "The scanner finds the edges of what's on the glass: good for receipts, cards and photos."
    : sc.o.size === "max" ? "Scans the whole glass." : "";
  $("#sizeHint").classList.toggle("hidden", !$("#sizeHint").textContent);
  $("#formatHint").textContent = FORMAT_HINT[sc.o.format];
  renderSourceHint();
  updateScanFoot();
}

function renderSourceHint() {
  const src = sc.caps?.sources?.feeder;
  const adf = sc.status?.adf || "";
  let hint;
  if (sc.o.source === "feeder") {
    hint = /Loaded/i.test(adf) ? "Pages are loaded and ready."
      : /Empty/i.test(adf) ? `Put your pages in the feeder, face up${src?.capacity ? ` (up to ${src.capacity})` : ""}.`
      : "Put your pages in the feeder, face up.";
  } else {
    hint = "One page at a time. Lift the lid and place it face down.";
  }
  $("#sourceHint").textContent = hint;
  $("#sourceHint").classList.toggle("warn", sc.o.source === "feeder" && /Empty/i.test(adf));

  const tips = [];
  if (sc.caps?.sources?.platen) tips.push(`<span>${icon("i-glass", 14)}Glass: one page at a time</span>`);
  if (src) tips.push(`<span class="${/Loaded/i.test(adf) ? "good" : ""}">${icon("i-feeder", 14)}${/Loaded/i.test(adf) ? "Pages loaded in the feeder" : `Feeder: up to ${src.capacity || "many"} pages`}</span>`);
  if (sc.scanner) tips.push(`<span>${icon(sc.scanner.connection === "usb" ? "i-usb" : "i-wifi", 14)}${sc.scanner.connection === "usb" ? "Connected by USB" : "Over Wi-Fi"}</span>`);
  $("#scanTips").innerHTML = tips.join("");
  $("#scanEmptyText").textContent = sc.o.source === "feeder"
    ? "Put your pages in the document feeder, face up, and press Scan. Every page is scanned in one go."
    : "Put the page face down on the glass, close the lid, and press Scan.";
}

function renderSaveSection() {
  $("#scanName").value = sc.name;
  const folder = sc.o.folder || sc.defaultFolder;
  $("#folderPath span").textContent = homeShort(folder) || "…";
  $("#folderPath").title = folder;
}

// ------------------------------------------------------------ pages
function renderPages() {
  const grid = $("#scanGrid");
  const n = sc.pages.length;
  const any = n || sc.job;
  $("#scanEmpty").classList.toggle("hidden", !!any);
  grid.classList.toggle("hidden", !any);
  $("#scanHud").classList.toggle("hidden", !n);
  grid.style.setProperty("--thumb", `${sc.thumb}px`);
  $("#scanCount").textContent = `${n} page${n === 1 ? "" : "s"}`;

  grid.innerHTML = sc.pages.map((p, i) => {
    const turned = p.rot % 180 !== 0;
    const ar = turned ? `${p.h} / ${p.w}` : `${p.w} / ${p.h}`;
    // When turned sideways, the image's width has to match the box's height.
    const imgW = turned ? `${(p.w / p.h) * 100}%` : "100%";
    return `<div class="scan-page" draggable="true" data-id="${p.id}">
      <div class="scan-thumb" style="aspect-ratio:${ar}">
        <img src="/api/scanpage/${TOKEN}/${p.id}.jpg" alt="Page ${i + 1}" style="width:${imgW};--rot:${p.rot}deg">
        <span class="num">${i + 1}</span>
      </div>
      <div class="scan-tools">
        <button data-act="left" title="Rotate left">${icon("i-rot-l", 15)}</button>
        <button data-act="right" title="Rotate right">${icon("i-rot-r", 15)}</button>
        <button data-act="del" class="del" title="Remove page">${icon("i-trash", 15)}</button>
      </div>
      <div class="label">Page ${i + 1}</div>
    </div>`;
  }).join("") + (sc.job ? `<div class="scan-page pending"><div class="scan-thumb"><div class="pending-text">
      <span class="spinner"></span><span id="pendingText">${sc.job.state === "starting" ? "Waking up the scanner…" : `Scanning page ${n + 1}…`}</span>
      <button class="btn sm" id="cancelScan">Cancel</button></div></div><div class="label">&nbsp;</div></div>` : "");

  $("#cancelScan")?.addEventListener("click", cancelScan);
  $$(".scan-page[data-id]", grid).forEach((el) => {
    const id = el.dataset.id;
    $(".scan-thumb", el).addEventListener("click", () => lightbox(sc.pages.findIndex((p) => p.id === id)));
    $$(".scan-tools button", el).forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const page = sc.pages.find((p) => p.id === id);
      if (b.dataset.act === "left") page.rot = (page.rot + 270) % 360;
      if (b.dataset.act === "right") page.rot = (page.rot + 90) % 360;
      if (b.dataset.act === "del") return removePages([id]);
      sc.saved = false;
      renderPages();
    }));
    wireDrag(el);
  });
  updateScanFoot();
}

let dragId = null;
function wireDrag(el) {
  el.addEventListener("dragstart", (e) => {
    dragId = el.dataset.id;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/x-lps-page", dragId);
  });
  el.addEventListener("dragend", () => {
    dragId = null;
    $$(".scan-page").forEach((x) => x.classList.remove("dragging", "drop-before", "drop-after"));
  });
  el.addEventListener("dragover", (e) => {
    if (!dragId || dragId === el.dataset.id) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    el.classList.toggle("drop-after", after);
    el.classList.toggle("drop-before", !after);
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
  el.addEventListener("drop", (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const after = el.classList.contains("drop-after");
    const from = sc.pages.findIndex((p) => p.id === dragId);
    const [moved] = sc.pages.splice(from, 1);
    let to = sc.pages.findIndex((p) => p.id === el.dataset.id);
    if (after) to += 1;
    sc.pages.splice(to, 0, moved);
    sc.saved = false;
    renderPages();
  });
}

async function removePages(ids) {
  sc.pages = sc.pages.filter((p) => !ids.includes(p.id));
  if (!sc.pages.length) sc.saved = false;
  renderPages();
  api("/api/scan/discard", { ids }).catch(() => {});
}

function lightbox(index) {
  if (index < 0) return;
  let i = index;
  $("#overlay").innerHTML = `<div class="lightbox" role="dialog">
    <div class="lb-stage"><img alt="">
      <button class="lb-nav prev" title="Previous page">${icon("i-chev-l", 22)}</button>
      <button class="lb-nav next" title="Next page">${icon("i-chev-r", 22)}</button>
      <button class="btn icon lb-close" title="Close" style="background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.14);color:#fff">${icon("i-x")}</button>
    </div>
    <div class="lb-bar">
      <button class="btn sm" data-act="left">${icon("i-rot-l", 15)}Rotate</button>
      <span class="lb-count"></span>
      <button class="btn sm" data-act="right">${icon("i-rot-r", 15)}Rotate</button>
      <button class="btn sm" data-act="del">${icon("i-trash", 15)}Remove</button>
    </div></div>`;
  const box = $("#overlay .lightbox");
  const img = $("img", box);
  const show = () => {
    const p = sc.pages[i];
    if (!p) return closeOverlay();
    img.src = `/api/scanpage/${TOKEN}/${p.id}-full.jpg`;
    img.style.transform = `rotate(${p.rot}deg)`;
    // Rotated sideways, the image's on-screen width is its height: keep it inside the stage.
    const stage = $(".lb-stage", box);
    if (p.rot % 180) { img.style.maxWidth = `${stage.clientHeight - 36}px`; img.style.maxHeight = `${stage.clientWidth - 160}px`; }
    else { img.style.maxWidth = ""; img.style.maxHeight = ""; }
    $(".lb-count", box).textContent = `Page ${i + 1} of ${sc.pages.length}`;
    $(".prev", box).style.visibility = i > 0 ? "" : "hidden";
    $(".next", box).style.visibility = i < sc.pages.length - 1 ? "" : "hidden";
  };
  const go = (d) => { i = Math.max(0, Math.min(sc.pages.length - 1, i + d)); show(); };
  $(".prev", box).onclick = () => go(-1);
  $(".next", box).onclick = () => go(1);
  $(".lb-close", box).onclick = closeOverlay;
  $(".lb-stage", box).addEventListener("click", (e) => { if (e.target === e.currentTarget) closeOverlay(); });
  $$(".lb-bar [data-act]", box).forEach((b) => b.addEventListener("click", () => {
    const p = sc.pages[i];
    if (b.dataset.act === "left") p.rot = (p.rot + 270) % 360;
    if (b.dataset.act === "right") p.rot = (p.rot + 90) % 360;
    if (b.dataset.act === "del") { removePages([p.id]); if (i >= sc.pages.length) i--; }
    sc.saved = false;
    renderPages();
    show();
  }));
  lightbox.go = go;
  show();
}

// ------------------------------------------------------------ scanning
async function startScan() {
  if (!sc.scanner || sc.job) return;
  const settings = { source: sc.o.source, color: sc.o.color, resolution: sc.o.resolution, size: sc.o.size, duplex: sc.o.duplex };
  try {
    const job = await api("/api/scan", { scanner: sc.scanner.id, settings });
    sc.job = job;
    sc.saved = false;
    renderScanner();
    renderPages();
    pollScan();
  } catch (e) {
    toast(e.message, "bad", 6000);
  }
}

async function pollScan() {
  const job = sc.job;
  if (!job) return;
  let res;
  try { res = await api("/api/scan/status?job=" + job.id); }
  catch (e) { res = { state: "error", message: e.message, pages: job.pages || [] }; }
  // Add pages as they arrive (the feeder sends them one by one).
  const known = new Set(sc.pages.map((p) => p.id));
  const fresh = res.pages.filter((p) => !known.has(p.id));
  if (fresh.length) sc.pages.push(...fresh.map((p) => ({ ...p, rot: 0 })));
  const wasStarting = sc.job.state === "starting";
  sc.job = { ...job, state: res.state };
  if (res.state === "starting" || res.state === "scanning") {
    if (fresh.length || (wasStarting && res.state === "scanning")) renderPages();
    setTimeout(pollScan, 700);
    return;
  }
  sc.job = null;
  if (res.state === "error") toast(res.message || "Scanning failed", "bad", 7000);
  else if (res.state === "done") toast(fresh.length > 1 ? `Scanned ${fresh.length} pages` : "Page scanned");
  renderPages();
  renderScanner();
  setTimeout(refreshScannerStatus, 1500);
}

async function cancelScan() {
  if (!sc.job) return;
  $("#pendingText") && ($("#pendingText").textContent = "Cancelling…");
  try { await api("/api/scan/cancel", { job: sc.job.id }); } catch { /* the poll will settle it */ }
}

// ------------------------------------------------------------ save / copy
const pageList = () => sc.pages.map((p) => ({ id: p.id, rot: p.rot }));

async function saveScan() {
  if (!sc.pages.length || sc.job) return;
  const name = $("#scanName").value.trim() || sc.name;
  const btn = $("#saveBtn");
  btn.disabled = true;
  try {
    const r = await api("/api/scan/save", { pages: pageList(), format: sc.o.format, name, folder: sc.o.folder || sc.defaultFolder });
    sc.saved = true;
    const first = r.paths[0];
    const what = r.paths.length > 1 ? `${r.paths.length} images` : first.split("/").pop();
    toast(`Saved ${what} to ${homeShort(first.split("/").slice(0, -1).join("/"))}`, "ok", 7000,
      { label: "Show", run: () => api("/api/show-in-folder", { path: first }).catch((e) => toast(e.message, "bad")) });
    updateScanFoot();
  } catch (e) {
    toast(e.message, "bad", 6000);
  } finally { btn.disabled = false; }
}

async function printCopy() {
  if (!sc.pages.length || sc.job) return;
  busy("Preparing the copy…");
  try {
    const meta = await api("/api/scan/to-print", { pages: pageList(), name: $("#scanName").value.trim() || sc.name });
    setMode("print");
    setDoc(meta);
    toast("Ready to print. Check the preview, then press Print.");
  } catch (e) {
    toast(e.message, "bad");
  } finally { busy(null); }
}

function clearScans() {
  const ids = sc.pages.map((p) => p.id);
  sc.pages = [];
  sc.saved = false;
  sc.name = "";
  api("/api/scan/discard", { ids }).catch(() => {});
  api("/api/scanners").then((d) => { sc.name = d.name; renderSaveSection(); }).catch(() => {});
  renderPages();
}

async function chooseFolder() {
  const current = sc.o.folder || sc.defaultFolder;
  try {
    const r = await api("/api/pick-folder", { start: current });
    if (!r.supported) {  // no native chooser installed: let them type it
      const input = $("#folderInput");
      input.classList.remove("hidden");
      input.value = current;
      input.focus();
      return;
    }
    if (r.folder) { setOpt({ folder: r.folder }); renderSaveSection(); }
  } catch (e) { toast(e.message, "bad"); }
}

function updateScanFoot() {
  const n = sc.pages.length;
  const scanning = !!sc.job;
  const btn = $("#scanBtn");
  btn.disabled = !sc.scanner || scanning;
  $("span", btn).textContent = scanning ? "Scanning…" : n ? (sc.o.source === "feeder" ? "Scan more" : "Scan page") : "Scan";
  $(".foot-row").classList.toggle("two", n > 0);
  $("#saveBtn").classList.toggle("hidden", !n);
  $("#saveBtn").disabled = scanning;
  $("#copyBtn").classList.toggle("hidden", !n);
  $("#copyBtn").disabled = scanning;
  const fmt = { pdf: "PDF", jpg: "JPEG", png: "PNG" }[sc.o.format];
  $("span", $("#saveBtn")).textContent = sc.saved ? "Saved" : `Save ${fmt}`;
  $("#scanSummaryLeft").innerHTML = n ? `<b>${n}</b> page${n === 1 ? "" : "s"} scanned` : "No pages yet";
  $("#scanSummaryRight").textContent = n ? [`${sc.o.resolution} dpi`, sc.o.color === "Grayscale8" ? "Grayscale" : "Color"].join(" · ") : "";
}

// ------------------------------------------------------------ wiring
function wireScan() {
  $$("#modeTabs button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#scannerCard").addEventListener("click", (e) => { e.stopPropagation(); toggleScannerMenu(); });
  document.addEventListener("click", (e) => { if (!$("#scanPickerWrap").contains(e.target)) closeScannerMenu(); });
  $$(".seg[data-scan]").forEach((seg) => $$("button", seg).forEach((b) => b.addEventListener("click", () => {
    if (b.disabled) return;
    setOpt({ [seg.dataset.scan]: b.dataset.v });
    if (seg.dataset.scan === "source") refreshScannerStatus();
  })));
  $("#scanDuplex").onchange = (e) => setOpt({ duplex: e.target.checked });
  $("#scanSize").onchange = (e) => setOpt({ size: e.target.value });
  $("#scanName").addEventListener("input", (e) => { sc.name = e.target.value; sc.saved = false; updateScanFoot(); });
  $("#folderBtn").onclick = chooseFolder;
  $("#folderInput").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    setOpt({ folder: v });
    e.target.classList.add("hidden");
    renderSaveSection();
  });
  $("#scanBtn").onclick = startScan;
  $("#scanEmptyBtn").onclick = startScan;
  $("#saveBtn").onclick = saveScan;
  $("#copyBtn").onclick = printCopy;
  $("#scanZoomIn").onclick = () => { sc.thumb = Math.min(520, Math.round(sc.thumb * 1.2)); store.set("scan.thumb", sc.thumb); renderPages(); };
  $("#scanZoomOut").onclick = () => { sc.thumb = Math.max(120, Math.round(sc.thumb / 1.2)); store.set("scan.thumb", sc.thumb); renderPages(); };
  armed($("#scanClear"), `${icon("i-trash", 15)}Remove all?`, async () => clearScans());

  document.addEventListener("keydown", (e) => {
    if (!document.body.classList.contains("mode-scan")) return;
    const typing = /INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName);
    const lb = $("#overlay .lightbox");
    if (lb && e.key === "ArrowLeft") return lightbox.go(-1);
    if (lb && e.key === "ArrowRight") return lightbox.go(1);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveScan(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); printCopy(); }
    else if (!typing && !lb && e.key === "Enter" && !$("#overlay").children.length) { e.preventDefault(); startScan(); }
  });

  setInterval(() => { if (document.body.classList.contains("mode-scan")) refreshScannerStatus(); }, 5000);
}

window.onAppDataCleared = () => { sc.pages = []; sc.saved = false; renderPages(); };

wireScan();
renderScanOptions();
renderSaveSection();
