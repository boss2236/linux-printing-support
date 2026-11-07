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
function toast(msg, kind = "ok", ms = 3800, action = null) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="t-icon">${icon(kind === "bad" ? "i-alert" : "i-check")}</span><span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement("button");
    b.className = "t-act";
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.append(b);
  }
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
  autoRoute(true);
}

// ------------------------------------------------------------ automatic USB / Wi-Fi switching
// When one printer is set up both ways, print over USB while the cable is connected and over
// Wi-Fi when it isn't. Picking one by hand pauses this until the cable is plugged in or out.
const modelKey = (p) => (p?.model || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function usbOnline(p) {
  const port = (p.uri.match(/:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/) || [])[1];
  const devs = (state.ippUsb?.devices || []).filter((d) => d.status === "OK");
  const key = modelKey(p);
  return devs.some((d) => d.port === port || (key && modelKey({ model: d.model }).includes(key)));
}

function routeGroup(p) {
  if (!p || p.temporary || !modelKey(p)) return null;
  const same = state.printers.filter((x) => !x.temporary && modelKey(x) === modelKey(p));
  const usb = same.find((x) => x.connection === "usb" && /localhost|127\.0\.0\.1|\[::1\]/.test(x.uri));
  const net = same.find((x) => x.connection === "network");
  return usb && net ? { usb, net } : null;
}

const autoSwitchOn = () => store.get("autoSwitch", true);

function autoRoute(quiet = false) {
  const g = routeGroup(state.printer);
  if (!g || !autoSwitchOn()) return;
  const online = usbOnline(g.usb);
  if (state.manualPin && state.manualPin.online === online) return;
  state.manualPin = null;
  const want = online ? g.usb : g.net;
  if (want.name === state.printer.name) return;
  setPrinter(want, false);
  if (!quiet) toast(online ? "Printer cable connected: printing over USB" : "Printer cable unplugged: printing over Wi-Fi", "ok", 5000);
}

async function refreshRoute() {
  if (!routeGroup(state.printer) || !autoSwitchOn()) return;
  try {
    const data = await api("/api/printers");
    state.printers = data.printers;
    state.ippUsb = data.ipp_usb;
    state.printer = printerByName(state.printer.name) || state.printer;
  } catch { return; }
  autoRoute();
}

function setPrinter(p, userChose = true) {
  const changed = state.printer?.name !== p?.name;
  state.printer = p;
  if (userChose) {
    const g = routeGroup(p);
    state.manualPin = g ? { online: usbOnline(g.usb) } : null;
  }
  if (p && userChose) store.set("printer", p.name);
  if (changed) { state.conn = null; loadConnection(); }
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
  renderConnRow();
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
    ${cur && !cur.temporary ? `<button class="menu-item subtle" data-act="wifi">${icon("i-wifi")}Printer &amp; Wi-Fi…</button>` : ""}
    <button class="menu-item subtle" data-act="add">${icon("i-search")}Add a printer…</button>
    <button class="menu-item subtle" data-act="repair">${icon("i-wrench")}Fix printing problems</button>
    <button class="menu-item subtle" data-act="refresh">${icon("i-refresh")}Refresh</button>`;
  $$(".menu-item[data-name]", menu).forEach((b) => b.addEventListener("click", () => { setPrinter(printerByName(b.dataset.name)); toggleMenu(false); }));
  $$(".menu-item[data-act]", menu).forEach((b) => b.addEventListener("click", async () => {
    toggleMenu(false);
    const act = b.dataset.act;
    if (act === "add") addPrinterDialog();
    if (act === "wifi") wifiDialog();
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

async function setupPrinter(name, uri, { info = "", keepOpen = false } = {}) {
  if (!keepOpen) closeOverlay();
  busy("Setting up printer… (enter your password if asked)");
  try {
    await api("/api/add-printer", { name, uri, info });
    await loadPrinters(true);
    toast("Printer added");
    return true;
  } catch (e) {
    toast(e.message === "Cancelled" ? "Setup cancelled" : e.message, "bad", 6000);
    return false;
  } finally { busy(null); }
}

// ------------------------------------------------------------ connection (USB / Wi-Fi)
const signalBars = (pct) => {
  if (pct == null) return "";
  const lit = pct >= 70 ? 4 : pct >= 45 ? 3 : pct >= 20 ? 2 : 1;
  return `<span class="bars ${lit <= 1 ? "weak" : ""}" title="Wi-Fi signal ${pct}%">${[1, 2, 3, 4].map((i) => `<i class="${i <= lit ? "lit" : ""}"></i>`).join("")}</span>`;
};
const signalWord = (pct) => pct == null ? "" : pct >= 70 ? "Strong signal" : pct >= 45 ? "Good signal" : pct >= 20 ? "Fair signal" : "Weak signal";

let connSeq = 0;
async function loadConnection() {
  const p = state.printer;
  if (!p || p.temporary) { state.conn = null; renderConnRow(); return null; }
  const seq = ++connSeq;
  try {
    const c = await api("/api/connection?printer=" + encodeURIComponent(p.name));
    if (seq !== connSeq) return null;
    state.conn = c;
  } catch { if (seq === connSeq) state.conn = null; }
  renderConnRow();
  return state.conn;
}

function renderConnRow() {
  const row = $("#connRow");
  const p = state.printer;
  if (!p || p.temporary || !p.connection) { row.classList.add("hidden"); return; }
  const c = state.conn;
  const cur = c?.current || p.connection;
  const usbOn = cur === "usb", netOn = cur === "network";
  const usbAvail = !!c?.usb, netAvail = !!c?.network;
  const chip = (on, avail, ic, label, extra = "") =>
    `<span class="conn-chip ${on ? "on" : avail ? "avail" : ""}">${icon(ic, 14)}${label}${extra}</span>`;
  const parts = [];
  if (usbOn || usbAvail) parts.push(chip(usbOn, usbAvail, "i-usb", "USB"));
  if (netOn || netAvail) parts.push(chip(netOn, netAvail, "i-wifi", "Wi-Fi", c?.network ? " " + signalBars(c.network.signal) : ""));
  if (!parts.length) parts.push(chip(true, false, cur === "usb" ? "i-usb" : "i-wifi", cur === "usb" ? "USB" : "Network"));
  row.innerHTML = parts.join('<span class="dot-sep"></span>') +
    `<span class="more">${c && !netAvail ? "Connect to Wi-Fi" : "Printer &amp; Wi-Fi"}${icon("i-chev-r", 14)}</span>`;
  row.classList.remove("hidden");
}

async function wifiDialog() {
  const p = state.printer;
  if (!p) return;
  const m = modal(`<div id="wifiBody"><h2>Printer &amp; Wi-Fi</h2><div class="center-note"><span class="spinner"></span>Checking how the printer is connected…</div></div>`);
  m.classList.add("wide");
  let watching = 0, wasOnline = null;
  const stop = () => clearInterval(watching);
  const obs = new MutationObserver(() => { if (!m.isConnected) { stop(); obs.disconnect(); } });
  obs.observe($("#overlay"), { childList: true });

  const draw = (c) => {
    const body = $("#wifiBody", m);
    if (!body) return;
    const net = c.network, usb = c.usb;
    const wifiQueue = c.queues.find((q) => q.kind === "network");
    const usingWifi = state.printer?.name === wifiQueue?.name;
    const card = (live, ic, title, sub, tag) => `
      <div class="conn-card ${live ? "live" : ""}">
        ${tag ? `<span class="cc-tag">${tag}</span>` : ""}
        <div class="cc-icon">${icon(ic, 20)}</div><b>${title}</b><div class="cc-sub">${sub}</div>
      </div>`;
    const comp = c.computer.map((n) => n.type === "wifi" ? `Wi-Fi “${esc(n.name)}”` : "Ethernet").join(" and ");

    let main = "";
    if (net) {
      main = `<div class="conn-section">
        <h3>${icon("i-wifi", 18)}Print without the cable</h3>
        ${wifiQueue
          ? `<p>This printer is set up for Wi-Fi printing as “${esc(wifiQueue.info || wifiQueue.name)}”.</p>
             <div class="row-actions">${usingWifi ? `<span class="ok-note">${icon("i-check", 16)}Printing over Wi-Fi</span>`
               : `<button class="btn sm primary" id="useWifi">${icon("i-wifi", 15)}Print over Wi-Fi</button>`}
               ${c.queues.some((q) => q.kind === "usb") && usingWifi ? `<button class="btn sm" id="useUsb">${icon("i-usb", 15)}Switch back to USB</button>` : ""}</div>
             ${c.queues.some((q) => q.kind === "usb") ? `<div class="row" style="margin-top:14px">
               <div><div class="field-label" style="margin:0">Switch automatically</div>
                 <div class="hint" style="margin:0">USB while the cable is connected, Wi-Fi when it isn't</div></div>
               <label class="switch"><input type="checkbox" id="autoSwitch" ${autoSwitchOn() ? "checked" : ""}><span></span></label></div>` : ""}`
          : `<p>The printer is on your network, so you can print from anywhere in the house with no cable. Set it up once; you'll be asked for your password.</p>
             <div class="row-actions"><button class="btn sm primary" id="addWifi">${icon("i-wifi", 15)}Set up Wi-Fi printing</button></div>`}
      </div>
      <div class="conn-section">
        <h3>${icon("i-scan", 18)}Scan over Wi-Fi</h3>
        <p style="margin:0">Nothing to set up. In <b>Scan</b>, pick the scanner marked Wi-Fi.</p>
      </div>`;
    } else {
      main = `<div class="conn-section">
        <h3>${icon("i-wifi", 18)}Connect this printer to Wi-Fi</h3>
        <p>Once it's on your Wi-Fi, you can print and scan without the cable.</p>
        <ol class="steps">
          ${c.admin ? `<li><b>Use the printer's settings page</b>${usb ? ", which works over the USB cable right now" : ""}. Open <i>LAN settings → Wi-Fi</i> and pick your network.
            If it asks for a password, it's usually the serial number printed on a sticker on the printer.<br>
            <button class="btn sm primary" data-open="${esc(c.admin)}">${icon("i-ext", 15)}Open printer settings</button></li>` : ""}
          <li><b>Or use the WPS button.</b> Press WPS on your router, then within two minutes hold the printer's Wi-Fi button until its light flashes.</li>
          <li>Keep this window open. It notices when the printer joins your network.</li>
        </ol>
        <div class="waiting"><span class="spinner"></span>Waiting for the printer to join your network…</div>
      </div>`;
    }

    body.innerHTML = `<h2>Printer &amp; Wi-Fi</h2>
      <p>${esc(c.model || p.info || p.name)}</p>
      <div class="conn-cards">
        ${card(!!usb, "i-usb", "USB cable", usb ? "Connected" : "Not connected", c.current === "usb" && !usingWifi ? "In use" : "")}
        ${card(!!net, "i-wifi", "Wi-Fi",
          net ? `On your network${net.signal != null ? ` · ${signalWord(net.signal)} ${signalBars(net.signal)}` : ""}<br><span class="cc-mono">${esc(net.addr)}</span>` : "Not on your network",
          c.current === "network" || usingWifi ? "In use" : "")}
      </div>
      ${main}
      ${comp ? `<div class="foot-note">${icon("i-check", 14)}<span>This computer is on ${comp}. The printer needs to be on the same network.</span></div>` : ""}
      <div class="actions split">
        ${c.admin ? `<button class="btn" data-open="${esc(c.admin)}">${icon("i-ext", 15)}Printer settings page</button>` : "<span></span>"}
        <button class="btn primary" id="wDone">Done</button>
      </div>`;

    $("#wDone", body).onclick = closeOverlay;
    $$("[data-open]", body).forEach((b) => b.addEventListener("click", async () => {
      try { await api("/api/open-url", { url: b.dataset.open }); toast("Opened the printer's settings in your browser"); }
      catch (e) { toast(e.message, "bad"); }
    }));
    $("#autoSwitch", body)?.addEventListener("change", (e) => {
      store.set("autoSwitch", e.target.checked);
      state.manualPin = null;
      if (e.target.checked) { autoRoute(); draw(c); }
    });
    $("#useWifi", body)?.addEventListener("click", () => { setPrinter(printerByName(wifiQueue.name)); toast("Now printing over Wi-Fi"); draw(c); });
    $("#useUsb", body)?.addEventListener("click", () => {
      setPrinter(printerByName(c.queues.find((q) => q.kind === "usb").name)); toast("Now printing over USB"); draw(c);
    });
    $("#addWifi", body)?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      const model = c.model || p.info || p.name;
      const ok = await setupPrinter(`${model} WiFi`, net.uri, { info: `${model} (Wi-Fi)`, keepOpen: true });
      if (!ok) { e.currentTarget.disabled = false; return; }
      const fresh = await api("/api/connection?printer=" + encodeURIComponent(p.name)).catch(() => c);
      const q = fresh.queues.find((x) => x.kind === "network");
      if (q && printerByName(q.name)) setPrinter(printerByName(q.name));
      draw(fresh);
    });
    if (wasOnline === false && net) $(".conn-card:nth-child(2)", body)?.classList.add("found-flash");
    if (wasOnline === false && net) toast("The printer is on Wi-Fi now");
    wasOnline = !!net;

    // Not on Wi-Fi yet: keep checking so the dialog updates the moment it joins.
    stop();
    if (!net) watching = setInterval(async () => {
      if (!m.isConnected) return stop();
      try { draw(await api("/api/connection?printer=" + encodeURIComponent(p.name))); } catch { /* keep waiting */ }
    }, 4000);
  };

  try {
    const c = await api("/api/connection?printer=" + encodeURIComponent(p.name));
    if (state.printer?.name === p.name) { state.conn = c; renderConnRow(); }
    draw(c);
  } catch (e) {
    const body = $("#wifiBody", m);
    if (body) body.innerHTML = `<h2>Printer &amp; Wi-Fi</h2><p>${esc(e.message)}</p><div class="actions"><button class="btn" onclick="closeOverlay()">Close</button></div>`;
  }
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
  await refreshRoute();  // the cable may have been unplugged since the last check
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

// ------------------------------------------------------------ queue & history
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

function when(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }) + ` ${time}`;
}

// Two-step confirm on the button itself: first click arms it, second click runs.
function armed(btn, label, run) {
  btn.addEventListener("click", async () => {
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.dataset.label = btn.innerHTML;
      btn.innerHTML = label;
      btn.classList.add("danger");
      setTimeout(() => { if (btn.isConnected && btn.dataset.armed) { delete btn.dataset.armed; btn.innerHTML = btn.dataset.label; btn.classList.remove("danger"); } }, 3500);
      return;
    }
    btn.disabled = true;
    try { await run(); } finally { btn.disabled = false; }
  });
}

function renderQueue(active, recent) {
  const body = $("#overlay .drawer-body");
  if (!body) return;
  const live = (j) => `
    <div class="job">
      <div class="job-icon">${icon("i-printer", 17)}</div>
      <div class="grow"><div class="job-title">${esc(j.title || "Untitled")}</div>
        <div class="job-sub">${esc(j.printer)} · ${esc(j.state === "printing" ? (j.status || "Printing…") : j.state === "held" ? "On hold" : j.state === "stopped" ? "Stopped — printer needs attention" : "Waiting")}</div></div>
      <button class="btn sm" data-cancel="${esc(j.id)}">Cancel</button>
    </div>`;
  const done = (j) => {
    const ok = j.state === "completed";
    const what = ok ? `${j.pages ? `${j.pages} page${j.pages === 1 ? "" : "s"} · ` : ""}${when(j.completed || j.created)}`
      : `${j.state === "cancelled" ? "Cancelled" : "Failed"} · ${when(j.completed || j.created)}`;
    return `
    <div class="job done ${ok ? "" : "failed"}">
      <div class="job-icon">${icon(ok ? "i-check" : "i-ban", 17)}</div>
      <div class="grow"><div class="job-title">${esc(j.title || "Untitled")}</div>
        <div class="job-sub">${esc(j.printer)} · ${esc(what)}</div></div>
      <button class="btn icon ghost job-remove" title="Remove from history" data-remove="${esc(j.id)}">${icon("i-trash", 16)}</button>
    </div>`;
  };
  body.innerHTML = `
    <div class="muted-title" style="margin-top:4px">Printing now</div>
    ${active.length ? active.map(live).join("") : '<div class="empty-note">Nothing printing right now</div>'}
    <div class="history-head"><div class="muted-title">History</div>
      ${recent.length ? `<button class="btn sm ghost" id="clearHistory">${icon("i-trash", 14)}Clear all</button>` : ""}</div>
    ${recent.length ? recent.map(done).join("") : '<div class="empty-note">No past prints</div>'}`;
  $$("[data-cancel]", body).forEach((b) => b.addEventListener("click", async () => {
    try { await api("/api/cancel", { id: b.dataset.cancel }); toast("Job cancelled"); pollJobs(); }
    catch (e) { toast(e.message, "bad"); }
  }));
  $$("[data-remove]", body).forEach((b) => b.addEventListener("click", async () => {
    const row = b.closest(".job");
    row.classList.add("leaving");
    try { await api("/api/history/remove", { ids: [b.dataset.remove] }); setTimeout(pollJobs, 180); }
    catch (e) { row.classList.remove("leaving"); toast(e.message, "bad"); }
  }));
  const clear = $("#clearHistory", body);
  if (clear) armed(clear, `${icon("i-trash", 14)}Clear ${recent.length}?`, async () => {
    try { const r = await api("/api/history/clear", {}); toast(`Removed ${r.removed} print${r.removed === 1 ? "" : "s"} from history`); pollJobs(); }
    catch (e) { toast(e.message, "bad"); }
  });
}

async function openQueue() {
  $("#overlay").innerHTML = `<div class="scrim" style="place-items:stretch"></div>
    <aside class="drawer"><div class="drawer-head"><h2>Print queue</h2><button class="btn icon ghost" id="dClose">${icon("i-x")}</button></div>
    <div class="drawer-body"><div class="center-note"><span class="spinner"></span></div></div>
    <div class="drawer-foot">
      <div><b>App data</b><div class="hint" style="margin:0">Temporary copies of opened files, previews and saved settings</div></div>
      <button class="btn sm" id="clearData">${icon("i-trash", 14)}Clear</button>
    </div></aside>`;
  $("#overlay .scrim").onclick = closeOverlay;
  $("#dClose").onclick = closeOverlay;
  armed($("#clearData"), `${icon("i-trash", 14)}Sure?`, async () => {
    try {
      const r = await api("/api/clear-data", { keep: state.doc?.id });
      window.onAppDataCleared?.();
      try { Object.keys(localStorage).filter((k) => k.startsWith("lps.")).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
      state.s = { ...structuredClone(DEFAULTS), media: state.s.media };
      state.zoom = 1;
      update({});
      const mb = r.freed / 1048576;
      toast(`App data cleared${r.freed ? ` · ${mb >= 1 ? mb.toFixed(1) + " MB" : Math.max(1, Math.round(r.freed / 1024)) + " KB"} freed` : ""}`);
    } catch (e) { toast(e.message, "bad"); }
  });
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
  $("#connRow").onclick = wifiDialog;
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
    if (f) { window.setMode?.("print"); openFile(f); }
  });

  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    const scanning = document.body.classList.contains("mode-scan");
    if (e.key === "Escape") { toggleMenu(false); if (!$("#overlay .modal #mGo")) closeOverlay(); return; }
    if (scanning) return;  // scan.js handles its own keys
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); doPrint(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); pick(); }
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
  // Come back to Scan if that's where the user left off, unless a file was opened with the app.
  if (!state.doc && store.get("mode", "print") === "scan") window.setMode?.("scan");
  pollJobs();
  setInterval(pollJobs, 4000);
  setInterval(async () => {
    const before = state.printer?.name;
    try {
      const data = await api("/api/printers?refresh=1");
      state.printers = data.printers; state.ippUsb = data.ipp_usb;
      const p = printerByName(before);
      if (p) { state.printer = p; renderPrinter(); loadConnection(); }
      autoRoute();
    } catch { /* keep the last known state */ }
  }, 20000);
}

boot();
