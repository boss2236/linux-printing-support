"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const TOKEN = location.hash.slice(1);
const icon = (id, size = 16) => `<svg width="${size}" height="${size}"><use href="#${id}"/></svg>`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const DEFAULTS = {
  pagesMode: "all", pages: "", sides: "one-sided", orientation: "auto", per_sheet: 1, borders: false,
  media: "", scale_mode: "fit", scale: 100, margins: "normal", margin_mm: { top: 10, right: 10, bottom: 10, left: 10 },
  color: "color", quality: "normal", reverse: false, manualDuplex: false, copies: 1, collate: true,
};
const SAVED_KEYS = ["sides", "orientation", "per_sheet", "borders", "scale_mode", "scale", "margins", "margin_mm", "color", "quality", "reverse", "manualDuplex", "collate"];

const state = {
  printers: [], ippUsb: null, printer: null, doc: null, preview: null, zoom: 1, current: 0,
  s: structuredClone(DEFAULTS),
};

// ------------------------------------------------------------ storage (best effort)
const store = {
  get(k, d) { try { const v = localStorage.getItem("lps." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lps." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
Object.assign(state.s, Object.fromEntries(Object.entries(store.get("settings", {})).filter(([k]) => SAVED_KEYS.includes(k))));
state.zoom = store.get("zoom", 1);

// ------------------------------------------------------------ api
async function api(path, body, opts = {}) {
  const init = { headers: { "X-LPS-Token": TOKEN }, ...opts };
  if (body !== undefined && !(body instanceof Blob)) {
    init.method = "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  } else if (body instanceof Blob) {
    init.method = "POST";
    init.body = body;
  }
  const r = await fetch(path, init);
  let data = {};
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

// ------------------------------------------------------------ toasts & overlays
function toast(msg, kind = "ok", ms = 3800) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="t-icon">${icon(kind === "bad" ? "i-alert" : "i-check")}</span><span>${esc(msg)}</span>`;
  $("#toasts").append(el);
  setTimeout(() => { el.classList.add("leave"); setTimeout(() => el.remove(), 300); }, ms);
}

function closeOverlay() { $("#overlay").innerHTML = ""; }
function modal(html, { dismissable = true } = {}) {
  $("#overlay").innerHTML = `<div class="scrim"><div class="modal" role="dialog">${html}</div></div>`;
  const scrim = $("#overlay .scrim");
  if (dismissable) scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) closeOverlay(); });
  return $("#overlay .modal");
}

function busy(text) {
  $("#busy").classList.toggle("hidden", !text);
  if (text) $("#busyText").textContent = text;
}

// ------------------------------------------------------------ printers
const printerByName = (n) => state.printers.find((p) => p.name === n);
const stateText = (p) => {
  if (p.temporary) return "Found automatically";
  if (p.state === "printing") return "Printing…";
  if (p.state === "stopped") return "Stopped";
  if (!p.accepting) return "Not accepting jobs";
  return "Ready";
};

async function loadPrinters(refresh = false) {
  try {
    const data = await api("/api/printers" + (refresh ? "?refresh=1" : ""));
    state.printers = data.printers;
    state.ippUsb = data.ipp_usb;
  } catch (e) {
    toast(e.message, "bad");
    return;
  }
  const wanted = state.printer?.name || store.get("printer", null);
  const pick = printerByName(wanted) || state.printers.find((p) => p.is_default) || state.printers[0] || null;
  setPrinter(pick, false);
}

function setPrinter(p, userChose = true) {
  const changed = state.printer?.name !== p?.name;
  state.printer = p;
  if (p && userChose) store.set("printer", p.name);
  renderPrinter();
  renderMedia();
  applyCapabilities();
  if (changed && state.doc) schedulePreview();
  updateSummary();
}

function renderPrinter() {
  const p = state.printer;
  $("#pName").textContent = p ? (p.info || p.name) : "No printers found";
  $("#pSub").textContent = p ? [stateText(p), p.model].filter(Boolean).join(" · ") : "Add one to get started";
  $("#pDot").className = "status-dot " + (p ? (p.temporary ? "" : p.state) : "stopped");

  $("#ink").innerHTML = (p?.ink || []).map((k) => {
    const lvl = Math.max(0, Math.min(100, k.level));
    const low = k.level >= 0 && k.level <= 15;
    const name = k.name.replace(/\(.*\)/, "").trim();
    return `<div class="ink-bar ${low ? "low" : ""}" title="${esc(k.name)}: ${k.level < 0 ? "unknown" : k.level + "%"}">
      <div class="ink-track"><div class="ink-fill" style="height:${k.level < 0 ? 0 : lvl}%;background:${esc(k.color)}"></div></div>
      <div class="ink-name">${esc(name)}</div></div>`;
  }).join("");

  // Problems worth surfacing, with a one-click fix where we have one.
  let alert = "";
  const usbBad = state.ippUsb?.devices?.find((d) => d.status !== "OK");
  if (!p && state.ippUsb && !state.ippUsb.installed) {
    alert = alertBox("USB printer support is missing", "Install the <b>ipp-usb</b> package, then reopen this app.", "bad");
  } else if (usbBad) {
    alert = alertBox(`${esc(usbBad.model)} isn't responding`, `USB says: ${esc(usbBad.status)}`, "bad", "Fix it", "repair");
  } else if (p && p.state === "stopped") {
    alert = alertBox("This printer is stopped", esc(p.state_message || "It stopped after an error."), "bad", "Fix it", "repair");
  } else if (p && p.temporary) {
    alert = alertBox("Not set up yet", "It can print as is. Set it up to unlock all of its paper sizes and options.", "", "Set up", "setup");
  } else if (p && p.reasons.some((r) => /media-empty|media-needed/.test(r))) {
    alert = alertBox("Out of paper", "Load paper into the printer.", "");
  } else if (p && p.reasons.some((r) => /jam/.test(r))) {
    alert = alertBox("Paper jam", "Clear the jam, then press the printer's resume button.", "bad");
  } else if (p && p.reasons.some((r) => /marker-supply-low|toner-low/.test(r))) {
    alert = alertBox("Ink is running low", "You can keep printing for now.", "");
  }
  $("#printerAlert").innerHTML = alert;
  $("#printerAlert [data-act=repair]")?.addEventListener("click", repair);
  $("#printerAlert [data-act=setup]")?.addEventListener("click", () => setupPrinter(p.name.replace(/_/g, "-"), p.uri));
}

function alertBox(title, body, kind, action, act) {
  return `<div class="alert ${kind}">${icon("i-alert", 18)}<div class="grow"><b>${title}</b>${body}</div>
    ${action ? `<button class="btn sm" data-act="${act}">${action}</button>` : ""}</div>`;
}

function toggleMenu(force) {
  const menu = $("#printerMenu");
  const open = force ?? menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !open);
  $("#printerCard").classList.toggle("open", open);
  if (!open) return;
  const items = state.printers.map((p) => `
    <button class="menu-item ${p.name === state.printer?.name ? "active" : ""}" data-name="${esc(p.name)}">
      <div class="printer-glyph" style="width:32px;height:32px">${icon("i-printer", 17)}<span class="status-dot ${p.temporary ? "" : p.state}"></span></div>
      <div class="grow"><div class="printer-name">${esc(p.info || p.name)}</div><div class="printer-sub">${esc(stateText(p))}${p.model ? " · " + esc(p.model) : ""}</div></div>
      ${p.is_default ? '<span class="tag">Default</span>' : ""}
    </button>`).join("");
  const cur = state.printer;
  menu.innerHTML = `${items || '<div class="empty-note">No printers yet</div>'}
    <div class="menu-sep"></div>
    ${cur && !cur.is_default && !cur.temporary ? `<button class="menu-item subtle" data-act="default">${icon("i-star")}Make “${esc(cur.info || cur.name)}” my default</button>` : ""}
    <button class="menu-item subtle" data-act="add">${icon("i-search")}Add a printer…</button>
    <button class="menu-item subtle" data-act="repair">${icon("i-wrench")}Fix printing problems</button>
    <button class="menu-item subtle" data-act="refresh">${icon("i-refresh")}Refresh</button>`;
  $$(".menu-item[data-name]", menu).forEach((b) => b.addEventListener("click", () => { setPrinter(printerByName(b.dataset.name)); toggleMenu(false); }));
  $$(".menu-item[data-act]", menu).forEach((b) => b.addEventListener("click", async () => {
    toggleMenu(false);
    const act = b.dataset.act;
    if (act === "add") addPrinterDialog();
    if (act === "repair") repair();
    if (act === "refresh") { await loadPrinters(true); toast("Printers refreshed"); }
    if (act === "default") {
      try { await api("/api/default", { name: cur.name }); await loadPrinters(true); toast(`${cur.info || cur.name} is now your default printer`); }
      catch (e) { toast(e.message, "bad"); }
    }
  }));
}

async function repair() {
  busy("Fixing the printer… (enter your password if asked)");
  try {
    await api("/api/repair", {});
    await loadPrinters(true);
    toast("Printer reset — try printing again");
  } catch (e) {
    toast(e.message === "Cancelled" ? "Fix cancelled" : e.message, "bad", 6000);
  } finally { busy(null); }
}

async function addPrinterDialog() {
  const m = modal(`<h2>Add a printer</h2>
    <p>Looking for printers on your network and over USB. Most printers made in the last decade work without installing anything.</p>
    <div id="foundList"><div class="center-note"><span class="spinner"></span>Searching…</div></div>
    <div class="actions"><button class="btn" id="mClose">Close</button></div>`);
  $("#mClose", m).onclick = closeOverlay;
  let found = [];
  try { found = (await api("/api/discover")).found; } catch (e) { toast(e.message, "bad"); }
  const list = $("#foundList", m);
  if (!list) return;
  if (!found.length) {
    list.innerHTML = `<div class="center-note" style="flex-direction:column;text-align:center">No printers found.<br>
      <span style="color:var(--text-3);font-size:13px">Check the printer is on and connected to the same Wi-Fi, or plugged in by USB.</span></div>`;
    return;
  }
  list.innerHTML = `<div class="found">${found.map((f, i) => `
    <div class="found-item">
      <div class="printer-glyph">${icon("i-printer", 20)}</div>
      <div class="grow"><div class="printer-name">${esc(f.model)}</div><div class="uri">${f.usb ? "USB" : "Network"} · ${esc(f.uri)}</div></div>
      ${f.configured ? '<span class="tag" style="font-size:11px;color:var(--ok);font-weight:650">Set up</span>'
        : `<button class="btn sm primary" data-i="${i}">Add</button>`}
    </div>`).join("")}</div>`;
  $$("button[data-i]", list).forEach((b) => b.addEventListener("click", () => {
    const f = found[+b.dataset.i];
    setupPrinter(f.model + (f.usb ? "" : " Network"), f.uri);
  }));
}

async function setupPrinter(name, uri) {
  closeOverlay();
  busy("Setting up printer… (enter your password if asked)");
  try {
    await api("/api/add-printer", { name, uri });
    await loadPrinters(true);
    toast("Printer added");
  } catch (e) {
    toast(e.message === "Cancelled" ? "Setup cancelled" : e.message, "bad", 6000);
  } finally { busy(null); }
}

// ------------------------------------------------------------ capabilities -> controls
function renderMedia() {
  const p = state.printer;
  const media = p?.media?.length ? p.media : [
    { id: "iso_a4_210x297mm", label: "A4 · 210 × 297 mm" }, { id: "na_letter_8.5x11in", label: "Letter · 215.9 × 279.4 mm" },
    { id: "na_legal_8.5x14in", label: "Legal · 215.9 × 355.6 mm" }, { id: "iso_a5_148x210mm", label: "A5 · 148 × 210 mm" },
  ];
  const saved = store.get("media", null);
  const pick = [state.s.media, saved, p?.media_default].find((m) => m && media.some((x) => x.id === m)) || media[0].id;
  state.s.media = pick;
  $("#media").innerHTML = media.map((m) => `<option value="${esc(m.id)}" ${m.id === pick ? "selected" : ""}>${esc(m.label)}</option>`).join("");
}

function applyCapabilities() {
  const p = state.printer;
  const known = p && !p.temporary;
  const colorBtn = $('[data-setting=color] [data-v=color]');
  colorBtn.disabled = known && !p.color;
  if (colorBtn.disabled && state.s.color === "color") state.s.color = "gray";
  for (const q of ["draft", "normal", "high"]) {
    const b = $(`[data-setting=quality] [data-v=${q}]`);
    b.disabled = known && !p.qualities.includes(q);
  }
  if (known && !p.qualities.includes(state.s.quality)) state.s.quality = p.qualities.includes("normal") ? "normal" : p.qualities[0];
  syncControls();
}

const needsManualDuplex = () => state.s.sides !== "one-sided" && (state.s.manualDuplex || (state.printer && !state.printer.temporary && !state.printer.duplex));

// ------------------------------------------------------------ settings UI
function syncControls() {
  const s = state.s;
  $$(".seg[data-setting]").forEach((seg) => {
    const key = seg.dataset.setting;
    $$("button", seg).forEach((b) => b.classList.toggle("on", String(s[key]) === b.dataset.v));
  });
  $("#pageRange").classList.toggle("hidden", s.pagesMode !== "custom");
  $("#copies").value = s.copies;
  $("#collateRow").classList.toggle("hidden", s.copies < 2);
  $("#collate").checked = s.collate;
  $("#borders").checked = s.borders;
  $("#bordersRow").classList.toggle("hidden", s.per_sheet < 2);
  $("#reverse").checked = s.reverse;
  $("#manualDuplex").checked = s.manualDuplex;
  $("#scaleWrap").classList.toggle("hidden", s.scale_mode !== "custom");
  $("#scale").value = s.scale;
  $("#marginGrid").classList.toggle("hidden", s.margins !== "custom");
  $("#marginHint").classList.toggle("hidden", s.margins !== "custom");
  $$("#marginGrid [data-m]").forEach((i) => { i.value = s.margin_mm[i.dataset.m]; });

  // 100% / custom scale only make sense for one page per sheet.
  for (const v of ["actual", "custom"]) $(`[data-setting=scale_mode] [data-v=${v}]`).disabled = s.per_sheet > 1;
  $("#scaleHint").textContent = {
    fit: "Shrinks or enlarges each page to fit inside the margins.",
    fill: "Fills the printable area; edges of the page may be cut off.",
    actual: "Prints at true size. Large pages may be cut off.",
    custom: "Pick any size from 10% to 400%.",
  }[s.per_sheet > 1 && ["actual", "custom"].includes(s.scale_mode) ? "fit" : s.scale_mode];

  const manual = needsManualDuplex();
  const noDuplex = state.printer && !state.printer.temporary && !state.printer.duplex;
  let hint = {
    "one-sided": "Prints on one side of each sheet.",
    "two-sided-long-edge": "Flips like a book. Best for portrait pages.",
    "two-sided-short-edge": "Flips like a notepad. Best for landscape pages.",
  }[s.sides];
  if (manual) hint += noDuplex ? " This printer can't flip paper, so you'll turn the stack over halfway." : " You'll turn the stack over halfway.";
  $("#sidesHint").textContent = hint;
  $("#sidesHint").classList.toggle("warn", manual);

  $$("#perSheet .chip").forEach((c) => c.classList.toggle("on", +c.dataset.v === s.per_sheet));
}

function buildPerSheet() {
  const grids = { 1: [1, 1], 2: [2, 1], 4: [2, 2], 6: [2, 3], 9: [3, 3], 16: [4, 4] };
  $("#perSheet").innerHTML = Object.entries(grids).map(([n, [c, r]]) =>
    `<button class="chip" data-v="${n}"><span class="mini" style="grid-template-columns:repeat(${c},1fr);grid-template-rows:repeat(${r},1fr)">${"<i></i>".repeat(n)}</span>${n}</button>`).join("");
  $$("#perSheet .chip").forEach((c) => c.addEventListener("click", () => update({ per_sheet: +c.dataset.v })));
}

function update(patch, { preview = true } = {}) {
  Object.assign(state.s, patch);
  if (state.s.per_sheet > 1 && ["actual", "custom"].includes(state.s.scale_mode)) state.s.scale_mode = "fit";
  store.set("settings", Object.fromEntries(SAVED_KEYS.map((k) => [k, state.s[k]])));
  if ("media" in patch) store.set("media", patch.media);
  syncControls();
  if (preview) schedulePreview();
  updateSummary();
}

function wireControls() {
  $$(".seg[data-setting]").forEach((seg) => {
    $$("button", seg).forEach((b) => b.addEventListener("click", () => {
      if (b.disabled) return;
      const key = seg.dataset.setting;
      if (key === "pagesMode" && b.dataset.v === "custom") setTimeout(() => $("#pageRange").focus(), 0);
      // Previews are cached server-side, so re-requesting after color/sides changes is cheap
      // and refreshes the grayscale render and front/back labels.
      update({ [key]: b.dataset.v }, { preview: key !== "quality" });
    }));
  });
  $("#pageRange").addEventListener("input", (e) => update({ pages: e.target.value }));
  $("#copies").addEventListener("change", (e) => update({ copies: clampCopies(e.target.value) }, { preview: false }));
  $("#copiesDown").onclick = () => update({ copies: clampCopies(state.s.copies - 1) }, { preview: false });
  $("#copiesUp").onclick = () => update({ copies: clampCopies(state.s.copies + 1) }, { preview: false });
  $("#collate").onchange = (e) => update({ collate: e.target.checked }, { preview: false });
  $("#borders").onchange = (e) => update({ borders: e.target.checked });
  $("#reverse").onchange = (e) => update({ reverse: e.target.checked });
  $("#manualDuplex").onchange = (e) => update({ manualDuplex: e.target.checked }, { preview: false });
  $("#scale").addEventListener("input", (e) => update({ scale: +e.target.value || 100 }));
  $("#media").onchange = (e) => update({ media: e.target.value });
  $$("#marginGrid [data-m]").forEach((i) => i.addEventListener("input", () =>
    update({ margin_mm: { ...state.s.margin_mm, [i.dataset.m]: Math.max(0, +i.value || 0) } })));
  $("#resetBtn").onclick = () => {
    const keep = { media: state.s.media, pages: state.s.pages };
    state.s = { ...structuredClone(DEFAULTS), ...keep };
    update({});
    toast("Settings reset");
  };
}
const clampCopies = (v) => Math.max(1, Math.min(state.printer?.max_copies || 99, Math.round(+v) || 1));

function layoutSettings() {
  const s = state.s;
  return {
    media: s.media, orientation: s.orientation, per_sheet: s.per_sheet, borders: s.borders, reverse: s.reverse,
    scale_mode: s.scale_mode, scale: s.scale, margins: s.margins, margin_mm: s.margin_mm,
    pages: s.pagesMode === "custom" ? s.pages : "", subset: ["odd", "even"].includes(s.pagesMode) ? s.pagesMode : "all",
  };
}

// ------------------------------------------------------------ documents
async function openFile(file) {
  if (!file) return;
  const office = /\.(docx?|odt|rtf|txt|md|html?|xlsx?|ods|csv|pptx?|odp|odg|wpd|pages)$/i.test(file.name);
  busy(office ? "Converting document…" : "Opening file…");
  try {
    const meta = await api("/api/upload", file, { headers: { "X-LPS-Token": TOKEN, "X-Filename": encodeURIComponent(file.name) } });
    setDoc(meta);
  } catch (e) {
    toast(e.message, "bad", 6000);
  } finally { busy(null); }
}

function setDoc(meta) {
  if (state.doc) api("/api/close", { doc_id: state.doc.id }).catch(() => {});
  state.doc = meta;
  state.preview = null;
  state.s.copies = 1;
  state.s.pages = "";
  state.s.pagesMode = "all";
  $("#pageRange").value = "";
  $("#docChip").classList.toggle("hidden", !meta);
  $("#topSpacer").classList.toggle("hidden", !!meta);
  $("#empty").classList.toggle("hidden", !!meta);
  $("#sheets").classList.toggle("hidden", !meta);
  $("#hud").classList.toggle("hidden", !meta);
  $("#printBtn").disabled = !meta;
  $("#sheets").innerHTML = "";
  if (meta) {
    $("#docName").textContent = meta.name;
    $("#docMeta").textContent = `${meta.pages} page${meta.pages === 1 ? "" : "s"}`;
    $("#pagesHint").textContent = `${meta.pages} in document`;
    document.title = `${meta.name} — Linux Printing Support`;
    schedulePreview(0);
  } else {
    $("#pagesHint").textContent = "";
    document.title = "Linux Printing Support";
  }
  syncControls();
  updateSummary();
}

// ------------------------------------------------------------ preview
let previewTimer = 0, previewSeq = 0;
function schedulePreview(delay = 180) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, delay);
}

async function renderPreview() {
  if (!state.doc) return;
  const seq = ++previewSeq;
  const slow = setTimeout(() => seq === previewSeq && busy("Updating preview…"), 250);
  try {
    const res = await api("/api/preview", { doc_id: state.doc.id, settings: layoutSettings() });
    if (seq !== previewSeq) return;
    state.preview = res;
    $("#pageRange").classList.remove("err");
    drawSheets();
  } catch (e) {
    if (seq !== previewSeq) return;
    if (state.s.pagesMode === "custom") { $("#pageRange").classList.add("err"); $("#pagesHint").textContent = e.message; }
    else toast(e.message, "bad");
  } finally {
    clearTimeout(slow);
    if (seq === previewSeq) busy(null);
    updateSummary();
  }
}

function drawSheets() {
  const wrap = $("#sheets");
  const { key, sheets } = state.preview;
  const gray = state.s.color === "gray" ? "-g" : "";
  const duplex = state.s.sides !== "one-sided";
  $("#pagesHint").textContent = `${state.doc.pages} in document`;
  // Reuse nodes so the scroll position survives settings changes.
  while (wrap.children.length > sheets.length) wrap.lastChild.remove();
  sheets.forEach((sh, i) => {
    let el = wrap.children[i];
    if (!el) {
      el = document.createElement("div");
      el.className = "sheet";
      el.innerHTML = `<div class="paper"><img alt="" decoding="async"></div><div class="label"></div>`;
      wrap.append(el);
      const img = $("img", el);
      img.addEventListener("load", () => { img.classList.add("loaded"); img.parentElement.classList.add("ready"); });
    }
    const landscape = sh.w > sh.h;
    el.style.setProperty("--sheet-w", `${Math.round((landscape ? 760 : 540) * state.zoom)}px`);
    $(".paper", el).style.aspectRatio = `${sh.w} / ${sh.h}`;
    const img = $("img", el);
    const src = `/api/sheet/${TOKEN}/${key}/${i}${gray}.png`;
    if (img.getAttribute("src") !== src) {
      if (i > 3) img.loading = "lazy";
      img.src = src;
    }
    $(".label", el).textContent = duplex
      ? `Sheet ${Math.floor(i / 2) + 1} · ${i % 2 ? "back" : "front"}`
      : `Sheet ${i + 1}`;
  });
  updateHud();
}

function updateHud() {
  const n = state.preview?.sheets.length || 0;
  $("#sheetCount").textContent = n ? `${state.current + 1} / ${n} ${state.s.sides !== "one-sided" ? "sides" : "sheets"}` : "Nothing to print";
}

function trackScroll() {
  const wrap = $("#sheets");
  wrap.addEventListener("scroll", () => {
    const mid = wrap.scrollTop + wrap.clientHeight / 2;
    let best = 0, bestD = Infinity;
    [...wrap.children].forEach((el, i) => {
      const d = Math.abs(el.offsetTop + el.offsetHeight / 2 - mid);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best !== state.current) { state.current = best; updateHud(); }
  }, { passive: true });
}

function goSheet(delta) {
  const wrap = $("#sheets");
  const n = wrap.children.length;
  if (!n) return;
  state.current = Math.max(0, Math.min(n - 1, state.current + delta));
  const el = wrap.children[state.current];
  wrap.scrollTo({ top: el.offsetTop - (wrap.clientHeight - el.offsetHeight) / 2 });
  updateHud();
}

function zoom(f) {
  state.zoom = Math.max(0.5, Math.min(2.2, +(state.zoom * f).toFixed(2)));
  store.set("zoom", state.zoom);
  if (state.preview) drawSheets();
}

// ------------------------------------------------------------ summary & print
function updateSummary() {
  const n = state.preview?.sheets.length || 0;
  if (!state.doc) { $("#summaryLeft").textContent = "No document"; $("#summaryRight").textContent = ""; return; }
  const s = state.s;
  const duplex = s.sides !== "one-sided";
  const paper = (duplex ? Math.ceil(n / 2) : n) * s.copies;
  $("#summaryLeft").innerHTML = `<b>${paper}</b> sheet${paper === 1 ? "" : "s"} of paper`;
  const bits = [duplex ? "Two-sided" : "One-sided", s.color === "gray" ? "B&W" : "Color"];
  if (s.copies > 1) bits.unshift(`${s.copies} copies`);
  $("#summaryRight").textContent = bits.join(" · ");
  $("#printBtn").disabled = !n || !state.printer;
}

async function doPrint() {
  if ($("#printBtn").disabled) return;
  const s = state.s;
  const body = {
    doc_id: state.doc.id, printer: state.printer.name, settings: layoutSettings(), copies: s.copies, collate: s.collate,
    sides: s.sides, color: s.color, quality: s.quality, manual_duplex: needsManualDuplex(),
  };
  $("#printBtn").disabled = true;
  busy("Sending to printer…");
  try {
    const res = await api("/api/print", body);
    if (res.flip) flipDialog(res.ticket);
    else toast(`Sent to ${state.printer.info || state.printer.name}`);
    pollJobs();
  } catch (e) {
    toast(e.message, "bad", 7000);
  } finally {
    busy(null);
    updateSummary();
  }
}

function flipDialog(ticket) {
  const m = modal(`
    <h2>Printing the front sides…</h2>
    <p>When they've all come out, turn the stack over for the back sides.</p>
    <div class="flip-art"><svg width="150" height="70" viewBox="0 0 150 70" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
      <rect x="8" y="12" width="36" height="48" rx="3"/><path d="M16 24h20M16 31h20M16 38h14"/>
      <path d="M58 36c10-18 30-18 40 0" /><path d="M93 30l5 6 6-5"/>
      <rect x="106" y="12" width="36" height="48" rx="3" stroke-dasharray="4 3"/></svg></div>
    <ol class="steps">
      <li>Wait for every front side to finish printing.</li>
      <li>Take the printed stack <b>without changing its order</b>.</li>
      <li>Flip it over and put it back in the paper tray, blank side ready to print.</li>
    </ol>
    <div class="actions"><button class="btn" id="mCancel">Skip back sides</button><button class="btn primary" id="mGo">Print back sides</button></div>`,
  { dismissable: false });
  $("#mCancel", m).onclick = closeOverlay;
  $("#mGo", m).onclick = async () => {
    closeOverlay();
    try { await api("/api/print/continue", { ticket }); toast("Printing the back sides"); pollJobs(); }
    catch (e) { toast(e.message, "bad", 6000); }
  };
}

// ------------------------------------------------------------ queue
let lastActive = 0;
async function pollJobs() {
  try {
    const { active, recent } = await api("/api/jobs");
    $("#queueBadge").textContent = active.length;
    $("#queueBadge").classList.toggle("hidden", !active.length);
    if (lastActive && !active.length) toast("Printing finished");
    lastActive = active.length;
    if ($("#overlay .drawer")) renderQueue(active, recent);
    return { active, recent };
  } catch { return null; }
}

function renderQueue(active, recent) {
  const body = $("#overlay .drawer-body");
  if (!body) return;
  const job = (j, done) => `
    <div class="job ${done ? "done" : ""}">
      <div class="job-icon">${icon(done ? "i-check" : "i-printer", 17)}</div>
      <div class="grow"><div class="job-title">${esc(j.title || "Job " + j.id.split("-").pop())}</div>
        <div class="job-sub">${esc(j.printer)} · ${esc(done ? j.when : (j.status || "Waiting"))}</div></div>
      ${done ? "" : `<button class="btn sm" data-cancel="${esc(j.id)}">Cancel</button>`}
    </div>`;
  body.innerHTML = (active.length ? active.map((j) => job(j, false)).join("") : '<div class="empty-note">Nothing printing right now</div>')
    + (recent.length ? `<div class="muted-title">Recently finished</div>${recent.map((j) => job(j, true)).join("")}` : "");
  $$("[data-cancel]", body).forEach((b) => b.addEventListener("click", async () => {
    try { await api("/api/cancel", { id: b.dataset.cancel }); toast("Job cancelled"); pollJobs(); }
    catch (e) { toast(e.message, "bad"); }
  }));
}

async function openQueue() {
  $("#overlay").innerHTML = `<div class="scrim" style="place-items:stretch"></div>
    <aside class="drawer"><div class="drawer-head"><h2>Print queue</h2><button class="btn icon ghost" id="dClose">${icon("i-x")}</button></div>
    <div class="drawer-body"><div class="center-note"><span class="spinner"></span></div></div></aside>`;
  $("#overlay .scrim").onclick = closeOverlay;
  $("#dClose").onclick = closeOverlay;
  await pollJobs();
}

// ------------------------------------------------------------ boot
function wireGlobal() {
  const input = $("#fileInput");
  const pick = () => input.click();
  $("#openBtn").onclick = pick;
  $("#emptyOpen").onclick = pick;
  input.onchange = () => { openFile(input.files[0]); input.value = ""; };
  $("#closeDoc").onclick = () => setDoc(null);
  $("#queueBtn").onclick = openQueue;
  $("#printBtn").onclick = doPrint;
  $("#printerCard").onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  document.addEventListener("click", (e) => { if (!$("#pickerWrap").contains(e.target)) toggleMenu(false); });
  $("#prevSheet").onclick = () => goSheet(-1);
  $("#nextSheet").onclick = () => goSheet(1);
  $("#zoomIn").onclick = () => zoom(1.15);
  $("#zoomOut").onclick = () => zoom(1 / 1.15);
  trackScroll();

  let depth = 0;
  document.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; document.body.classList.add("dragging"); });
  document.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; document.body.classList.remove("dragging"); } });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; document.body.classList.remove("dragging");
    const f = e.dataTransfer?.files?.[0];
    if (f) openFile(f);
  });

  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); doPrint(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); pick(); }
    else if (e.key === "Escape") { toggleMenu(false); if (!$("#overlay .modal #mGo")) closeOverlay(); }
    else if (!typing && (e.key === "PageDown" || e.key === "j")) { e.preventDefault(); goSheet(1); }
    else if (!typing && (e.key === "PageUp" || e.key === "k")) { e.preventDefault(); goSheet(-1); }
    else if (!typing && (e.key === "+" || e.key === "=")) zoom(1.15);
    else if (!typing && e.key === "-") zoom(1 / 1.15);
  });
}

async function boot() {
  buildPerSheet();
  wireControls();
  wireGlobal();
  syncControls();
  await loadPrinters();
  try {
    const { docs } = await api("/api/initial");
    if (docs.length) setDoc(docs[0]);
  } catch { /* nothing passed on the command line */ }
  pollJobs();
  setInterval(pollJobs, 4000);
  setInterval(async () => {
    const before = state.printer?.name;
    try {
      const data = await api("/api/printers?refresh=1");
      state.printers = data.printers; state.ippUsb = data.ipp_usb;
      const p = printerByName(before);
      if (p) { state.printer = p; renderPrinter(); }
    } catch { /* keep the last known state */ }
  }, 20000);
}

boot();
