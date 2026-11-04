"use strict";

const MODID = "playintegrityfix";
const PIFCTL = `/data/adb/modules/${MODID}/webroot/pifctl.sh`;
const LIFESPAN_DAYS = 42;        // Canary/Beta prints live about six weeks
const DEVICE_TTL_S = 86400;      // refresh the cached device list daily
const LOG_MAX = 500;
const MARKER = /^__PIFCTL_([A-Z]+)__=(.*)$/;

const state = {
    busy: false,
    tab: "device",
    source: "none",
    parsed: null,                // line model of the config being edited
    devices: [],
    devSrc: "builtin",
    fetchedAt: 0,
    refreshing: false,
    refreshFailed: false,
    selected: null,              // { code, model }
    pending: null,               // { file, map, validity }
    fields: new Map(),           // row id -> { field, type }
    added: 0,                    // rows created by the Add property form
};

/* ==========================================================================
 * Root bridge (KernelSU / APatch / MMRL WebUI)
 * ======================================================================= */

let seq = 0;

function q(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// pifctl reports failures as a marker line on stdout, so prefer that over the
// bare exit code when building the message.
function failure(stdout, stderr, errno) {
    for (const line of String(stdout || "").split("\n")) {
        const m = MARKER.exec(line);
        if (m && m[1] === "ERROR") return m[2];
    }
    return String(stderr || "").trim() || `exit ${errno}`;
}

function exec(command) {
    return new Promise((resolve, reject) => {
        if (typeof ksu === "undefined") { reject(new Error("Root bridge unavailable")); return; }
        const cb = `pif_exec_${++seq}`;
        window[cb] = (errno, stdout, stderr) => {
            delete window[cb];
            if (errno === 0) resolve(stdout);
            else reject(new Error(failure(stdout, stderr, errno)));
        };
        try { ksu.exec(command, "{}", cb); }
        catch (e) { delete window[cb]; reject(e); }
    });
}

function pifctl(...args) {
    return exec(`sh ${q(PIFCTL)} ${args.map(q).join(" ")}`);
}

// Stream pifctl output line by line. The KernelSU bridge emits one stdout line
// per "data" event with the newline already stripped, so every emission is
// treated as complete lines. Buffering until a "\n" shows up would hold all
// output until exit and hide the result markers. Resolves with the exit code.
function spawnLines(args, onLine) {
    return new Promise((resolve, reject) => {
        if (typeof ksu === "undefined") { reject(new Error("Root bridge unavailable")); return; }
        const name = `pif_spawn_${++seq}`;
        const stream = {
            emit(ev, chunk) {
                if (ev !== "data") return;
                const text = String(chunk);
                const lines = text.split("\n");
                if (text.endsWith("\n")) lines.pop();   // "" alone is a blank line
                for (const l of lines) onLine(l.replace(/\r$/, ""));
            },
        };
        const finish = fn => v => { delete window[name]; fn(v); };
        window[name] = {
            stdout: stream,
            stderr: stream,
            emit(ev, v) {
                if (ev === "exit") finish(resolve)(v);
                else if (ev === "error") finish(reject)(v);
            },
        };
        try { ksu.spawn("sh", JSON.stringify([PIFCTL, ...args]), "{}", name); }
        catch (e) { finish(reject)(e); }
    });
}

/* ==========================================================================
 * Small helpers
 * ======================================================================= */

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

let toastTimer = 0;
function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// Log lines are queued and written once per frame so a burst of output from
// autopif4 costs one layout, not one per line.
const logQueue = [];
let logFrame = 0;
let lastStep = "";

function log(text, cls) {
    logQueue.push([text, cls || ""]);
    if (!logFrame) logFrame = requestAnimationFrame(flushLog);
}

function flushLog() {
    logFrame = 0;
    const host = $("#log");
    const stick = host.scrollHeight - host.scrollTop - host.clientHeight < 48;
    const frag = document.createDocumentFragment();
    for (const [text, cls] of logQueue.splice(0)) {
        const d = document.createElement("div");
        if (cls) d.className = cls;
        d.textContent = text;
        frag.appendChild(d);
    }
    host.appendChild(frag);
    while (host.childElementCount > LOG_MAX) host.firstElementChild.remove();
    if (stick) host.scrollTop = host.scrollHeight;
    if (lastStep) $("#gen-step").textContent = lastStep;
}

function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
}

function go(name) {
    for (const p of $$(".panel")) p.hidden = p.id !== "panel-" + name;
    for (const b of $$(".nav-item")) {
        if (b.dataset.go === name) b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
    }
    state.tab = name;
    updateSavebar();
    window.scrollTo(0, 0);
    if (name === "log") { const l = $("#log"); l.scrollTop = l.scrollHeight; }
}

function setBusy(v) {
    state.busy = v;
    syncControls();
}

function syncControls() {
    const none = !state.devices.length;
    $("#device-row").disabled = state.busy || none;
    $("#btn-generate").disabled = state.busy || !state.selected;
    $("#btn-random").disabled = state.busy;
    for (const b of $$("[data-lock]")) b.disabled = state.busy;
    updateSavebar();
}

/* ==========================================================================
 * Config parsing (line preserving, so unknown lines survive a save)
 * ======================================================================= */

function stripInline(raw) {
    const h = raw.indexOf("#");
    if (h === -1) return { value: raw.trim(), hint: "" };
    return { value: raw.slice(0, h).trim(), hint: raw.slice(h + 1).trim() };
}

function parseConfig(body) {
    const model = [];
    const meta = {};
    let fid = 0;
    for (const raw of body.replace(/\r/g, "").split("\n")) {
        const t = raw.trim();
        if (t === "") { model.push({ kind: "blank", raw: "" }); continue; }

        let m = t.match(/^#\s*(Canary Released|Estimated Expiry)\s*:\s*(.*)$/i);
        if (m) {
            meta[/expiry/i.test(m[1]) ? "expiry" : "released"] = m[2].trim();
            model.push({ kind: "meta", raw });
            continue;
        }
        m = t.match(/^#\s*([A-Za-z0-9_.]+)\s*=(.*)$/);
        if (m) {
            const v = stripInline(m[2]);
            model.push({ kind: "field", raw, id: "f" + fid++, key: m[1], value: v.value, inlineHint: v.hint, commented: true });
            continue;
        }
        if (t.startsWith("#")) { model.push({ kind: "comment", raw, label: t.replace(/^#+\s*/, "").trim() }); continue; }
        m = raw.match(/^([A-Za-z0-9_.]+)\s*=(.*)$/);
        if (m) {
            const v = stripInline(m[2]);
            model.push({ kind: "field", raw, id: "f" + fid++, key: m[1], value: v.value, inlineHint: v.hint, commented: false });
            continue;
        }
        model.push({ kind: "comment", raw, label: t });
    }
    return { model, meta };
}

function toMap(model) {
    const map = {};
    for (const ln of model) {
        if (ln.kind === "field" && !ln.commented && !(ln.key in map)) map[ln.key] = ln.value;
    }
    return map;
}

// A comment is a section header if it is a known title, or any short comment
// directly followed by a field. That keeps sections added upstream grouped
// without a code change.
const KNOWN_SECTIONS = /^(Build Fields|System Properties|Advanced Settings)$/i;

function isSectionHeader(model, i) {
    const label = model[i].label || "";
    if (KNOWN_SECTIONS.test(label)) return true;
    if (!label || label.length > 40 || /[.:!?]$/.test(label)) return false;
    for (let j = i + 1; j < model.length; j++) {
        if (model[j].kind === "blank") continue;
        return model[j].kind === "field";
    }
    return false;
}

function groupFields(model) {
    const groups = [];
    let cur = null;
    for (let i = 0; i < model.length; i++) {
        const ln = model[i];
        if (ln.kind === "comment" && isSectionHeader(model, i)) {
            cur = { title: ln.label, fields: [] };
            groups.push(cur);
        } else if (ln.kind === "field") {
            if (!cur) { cur = { title: "Options", fields: [] }; groups.push(cur); }
            cur.fields.push(ln);
        }
    }
    return groups;
}

/* ==========================================================================
 * Fingerprint validity
 * ======================================================================= */

function dateFromBuildId(s) {
    const m = String(s || "").match(/(?:^|\.)(\d{2})(\d{2})(\d{2})(?:\.|$)/);
    if (!m) return null;
    const mm = +m[2], dd = +m[3];
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `20${m[1]}-${m[2]}-${m[3]}`;
}

const utc = s => new Date(s + "T00:00:00Z");
const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

function addDays(s, n) {
    const d = utc(s);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
    return Math.round((utc(b) - utc(a)) / 86400000);
}

function computeValidity(map, meta) {
    const fp = map.FINGERPRINT || map["ro.build.fingerprint"] || "";
    const id = map.ID || map["ro.build.id"] || "";
    const patch = map.SECURITY_PATCH || map["ro.build.version.security_patch"] || "";
    const release = map.RELEASE || "";

    let type = "Stable";
    if (/:CANARY\//i.test(fp) || /canary/i.test(release) || /canary/i.test(id)) type = "Canary";
    else if (/beta/i.test(release) || /beta/i.test(fp) || /^bp\d/i.test(id)) type = "Beta";
    const limited = type !== "Stable";

    let released = isoDate(meta.released) ? meta.released : null;
    if (!released) released = dateFromBuildId(id) || dateFromBuildId(map.INCREMENTAL) || (isoDate(patch) ? patch : null);

    let expires = null;
    if (limited) expires = isoDate(meta.expiry) ? meta.expiry : (released ? addDays(released, LIFESPAN_DAYS) : null);

    let text, status = "ok", fraction = 1;
    if (!limited) {
        text = "No fixed expiry";
    } else if (!expires) {
        text = "Expiry unknown";
        status = "warn";
    } else {
        const left = daysBetween(new Date().toISOString().slice(0, 10), expires);
        const span = released ? Math.max(1, daysBetween(released, expires)) : LIFESPAN_DAYS;
        fraction = Math.min(1, Math.max(0, left / span));
        if (left < 0) { text = `Expired ${-left} day${left === -1 ? "" : "s"} ago`; status = "danger"; }
        else if (left === 0) { text = "Expires today"; status = "danger"; }
        else if (left <= 7) { text = `${left} day${left === 1 ? "" : "s"} left`; status = "warn"; }
        else text = `${left} days left`;
    }
    return { type, released, expires, text, status, fraction, limited };
}

/* ==========================================================================
 * Device and fingerprint cards
 * ======================================================================= */

function validityHtml(v) {
    const meter = v.limited
        ? `<div class="meter"><i data-v="${v.fraction.toFixed(3)}"></i></div>
           <div class="validity"><span>Released <b>${esc(v.released || "unknown")}</b></span><span>Expires <b>${esc(v.expires || "unknown")}</b></span></div>`
        : `<p class="caption" style="margin-top:10px">Stable prints stay valid until Google revokes them.</p>`;
    return `<div class="${v.status}">${meter}</div>`;
}

function factsHtml(map, extra) {
    const rows = [
        ["Fingerprint", `<span class="mono">${esc(map.FINGERPRINT || map["ro.build.fingerprint"] || "-")}</span>`],
        ["Security patch", esc(map.SECURITY_PATCH || map["ro.build.version.security_patch"] || "-")],
        ["First API level", esc(map.DEVICE_INITIAL_SDK_INT || map["ro.product.first_api_level"] || "-")],
        ...(extra || []),
    ];
    return `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

function printCard(map, v, head, extra) {
    const name = map.MODEL || map.DEVICE || "Unnamed device";
    const sub = [map.DEVICE, map.ID].filter(Boolean).join(", ");
    return `<div class="card-top">${head}<span class="chip">${esc(v.type)}</span><span class="chip ${v.status}">${esc(v.text)}</span></div>
        <p class="hero">${esc(name)}</p>
        <p class="hero-sub">${esc(sub)}</p>
        ${validityHtml(v)}
        ${factsHtml(map, extra)}`;
}

// Meters start empty and grow on the next frame so the fill animates in.
function animateMeters(root) {
    requestAnimationFrame(() => {
        for (const el of root.querySelectorAll("[data-v]")) el.style.setProperty("--v", el.dataset.v);
    });
}

function renderActive() {
    const host = $("#active");
    const parsed = state.parsed || { model: [], meta: {} };
    const map = toMap(parsed.model);
    const hasPrint = map.FINGERPRINT || map["ro.build.fingerprint"];
    const src = state.source === "none" ? "No config" : state.source;

    if (!hasPrint) {
        host.innerHTML = `<div class="card-top"><span class="tag">${esc(src)}</span></div>
            <p class="hero">No fingerprint yet</p>
            <p class="empty">The config has no FINGERPRINT. Choose a device below to generate one.</p>`;
    } else {
        const v = computeValidity(map, parsed.meta);
        host.innerHTML = printCard(map, v, `<span class="tag">Active</span>`, [["Source", esc(src)]]) +
            `<div class="actions"><button class="btn tonal" data-act="killpi" data-lock>Restart GMS</button></div>`;
        animateMeters(host);
    }
    syncControls();
}

function renderPending() {
    const host = $("#pending");
    const p = state.pending;
    host.hidden = !p;
    if (!p) { host.innerHTML = ""; return; }
    host.innerHTML = printCard(p.map, p.validity, `<span class="tag">Ready to apply</span>`) +
        `<div class="actions">
            <button class="btn filled" data-act="apply" data-lock>Apply and restart GMS</button>
            <button class="btn text" data-act="discard" data-lock>Discard</button>
        </div>`;
    animateMeters(host);
    syncControls();
}

/* ==========================================================================
 * Settings (built from whatever the config file contains)
 * ======================================================================= */

function firstSentence(t) {
    const re = /[.!?](?=\s|$)/g;
    let m;
    while ((m = re.exec(t))) {
        const tail = t.slice(Math.max(0, m.index - 3), m.index + 1).toLowerCase();
        if (tail === "e.g." || tail === "i.e.") continue;
        return t.slice(0, m.index + 1);
    }
    return t;
}

function hintFor(f) {
    if (f.inlineHint) return f.inlineHint;
    const h = window.PIF_HINTS && (window.PIF_HINTS[f.key] || window.PIF_HINTS[f.key.toLowerCase()]);
    return h ? h.desc : "No description available for this option yet.";
}

// "level" is a switch plus a 1 to 100 slider, for options like verboseLogs
// that are off at 0 and otherwise carry a number. A value outside that range
// stays a text field so it can still be corrected by hand.
function controlType(f, title) {
    if (!/advanced/i.test(title || "")) return "text";
    if (f.key === "verboseLogs" && /^\d{1,3}$/.test(f.value) && +f.value <= 100) return "level";
    return f.value === "0" || f.value === "1" ? "toggle" : "text";
}

function rowHtml(f, title) {
    const type = controlType(f, title);
    const hint = hintFor(f);
    const short = firstSentence(hint);
    const more = hint.length > short.length;
    state.fields.set(f.id, { field: f, type });

    // Toggles carry their value in the switch. Text options keep an "include
    // this line" switch inside the details so the list is not a wall of switches.
    const info = `<button class="info" data-info aria-expanded="false" aria-label="About ${esc(f.key)}"><svg class="ic"><use href="#i-info"/></svg></button>`;
    const isText = type === "text";
    const isLevel = type === "level";
    const level = Math.min(100, Math.max(1, +f.value || 1));
    const levelOn = isLevel && +f.value > 0;
    const valueSwitch = `<label class="switch"><input type="checkbox" data-role="${isLevel ? "enabled" : "value"}" aria-label="${esc(f.key)}"${(isLevel ? levelOn : f.value === "1") ? " checked" : ""}><span></span></label>`;
    const slider = isLevel
        ? `<div class="level"${levelOn ? "" : " hidden"}><input type="range" min="1" max="100" step="1" value="${level}" data-role="level" aria-label="${esc(f.key)} level"><output>${level}</output></div>`
        : "";
    const onSwitch = `<div class="more-row"><span>Use this line</span><label class="switch"><input type="checkbox" data-role="on" aria-label="Use ${esc(f.key)}"${f.commented ? "" : " checked"}><span></span></label></div>`;
    const rows = Math.min(4, Math.max(1, Math.ceil(f.value.length / 34)));
    const field = isText
        ? `<textarea class="field" data-role="value" rows="${rows}" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="${esc(f.key)} value">${esc(f.value)}</textarea>`
        : "";
    const hasMore = more || isText;

    return `<div class="srow" data-id="${f.id}"${f.commented && isText ? " data-off" : ""}>
        <div class="srow-head"><div class="srow-title"><span class="key">${esc(f.key)}</span><span class="tag off">Off</span>${hasMore ? info : ""}</div>${isText ? "" : valueSwitch}</div>
        <p class="srow-sub">${esc(short)}</p>
        ${hasMore ? `<div class="srow-more">${more ? `<p>${esc(hint.slice(short.length).trim())}</p>` : ""}${isText ? onSwitch : ""}</div>` : ""}
        ${slider}
        ${field}
        <p class="srow-err" hidden></p>
    </div>`;
}
function renderSettings() {
    const host = $("#settings-form");
    state.fields.clear();
    const note = $("#settings-note");
    const notes = {
        "example.pif.prop": "Showing the module template. Saving creates custom.pif.prop.",
        "custom.pif.json": "Your config is the legacy JSON format. Generate a print to switch to custom.pif.prop.",
        none: "No config file was found.",
    };
    note.hidden = !notes[state.source];
    note.textContent = notes[state.source] || "";

    const groups = state.parsed && state.source !== "custom.pif.json" ? groupFields(state.parsed.model) : [];
    host.innerHTML = groups.length
        ? groups.map(g => `<h2 class="label">${esc(g.title)}</h2><div class="group">${g.fields.map(f => rowHtml(f, g.title)).join("")}${SYSTEM_PROPS.test(g.title) && g.fields.length ? addPropHtml(g.title) : ""}</div>`).join("")
        : "";
    updateSavebar();
}

// Properties are the one kind of line a print does not fully define, and some
// setups need extras (ro.product.brand, init.svc.adbd), so only this group
// gets a way to create a line instead of just editing existing ones.
const SYSTEM_PROPS = /^system properties$/i;

function addPropHtml(title) {
    const input = (role, hint) => `<input class="field" data-role="${role}" placeholder="${hint}" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="${hint}">`;
    return `<div class="add-prop" data-group="${esc(title)}">
        ${input("add-key", "Property name, e.g. ro.product.brand")}
        ${input("add-value", "Value")}
        <button class="btn tonal" data-add>Add property</button>
        <p class="srow-err" hidden></p>
    </div>`;
}

function validateNewProp(key, value) {
    if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(key)) return "Use a dotted property name, for example ro.product.brand.";
    if (state.parsed.model.some(l => l.kind === "field" && l.key === key)) return "Already in the config. Edit that line instead.";
    if (!value) return "Enter a value.";
    return validateValue(key, value);
}

// Appends one row and one model line without re-rendering, so unsaved edits in
// the other rows survive.
function addProperty(box) {
    const key = box.querySelector('[data-role="add-key"]').value.trim();
    const value = box.querySelector('[data-role="add-value"]').value.trim();
    const err = validateNewProp(key, value);
    const msg = box.querySelector(".srow-err");
    msg.hidden = !err;
    msg.textContent = err;
    if (err) return;

    const rows = box.parentElement.querySelectorAll(".srow");
    const model = state.parsed.model;
    const f = { kind: "field", raw: "", id: "n" + ++state.added, key, value, inlineHint: "", commented: false, isNew: true };
    model.splice(model.findIndex(l => l.id === rows[rows.length - 1].dataset.id) + 1, 0, f);
    box.insertAdjacentHTML("beforebegin", rowHtml(f, box.dataset.group));
    onRowChange(box.previousElementSibling);
    for (const el of box.querySelectorAll("input")) el.value = "";
}

function discardEdits() {
    state.parsed.model = state.parsed.model.filter(l => !l.isNew);
    renderSettings();
}

function rowState(row) {
    const meta = state.fields.get(row.dataset.id);
    const onEl = row.querySelector('[data-role="on"]');
    const on = onEl ? onEl.checked : true;
    let value;
    if (meta.type === "level") {
        value = row.querySelector('[data-role="enabled"]').checked ? row.querySelector('[data-role="level"]').value : "0";
    } else {
        const el = row.querySelector('[data-role="value"]');
        value = meta.type === "toggle" ? (el.checked ? "1" : "0") : el.value.replace(/[\r\n]+/g, "").trim();
    }
    return { meta, on, value };
}

function validateValue(key, value) {
    if (value.includes("#")) return "A # starts a comment. Remove it.";
    if (key === "verboseLogs" && !(/^\d{1,3}$/.test(value) && +value <= 100)) return "Use a whole number from 0 to 100.";
    return "";
}

function onRowChange(row) {
    const { meta, on, value } = rowState(row);
    const f = meta.field;
    const err = meta.type !== "text" || !on ? "" : validateValue(f.key, value);
    const before = f.commented || f.isNew ? null : f.value;
    const after = on ? value : null;

    if (meta.type === "level") {
        const level = row.querySelector(".level");
        level.hidden = value === "0";
        level.querySelector("output").textContent = level.querySelector("input").value;
    }
    row.toggleAttribute("data-off", meta.type === "text" && !on);
    row.toggleAttribute("data-dirty", before !== after);
    row.toggleAttribute("data-invalid", !!err);
    const msg = row.querySelector(".srow-err");
    msg.hidden = !err;
    msg.textContent = err;
    const input = row.querySelector("textarea");
    if (input) input.setAttribute("aria-invalid", err ? "true" : "false");
    updateSavebar();
}

function updateSavebar() {
    const dirty = $$("#settings-form [data-dirty]").length;
    const bad = $$("#settings-form [data-invalid]").length;
    const bar = $("#savebar");
    const show = state.tab === "settings" && (dirty > 0 || bad > 0);
    bar.classList.toggle("show", show);
    bar.setAttribute("aria-hidden", String(!show));
    $("#dirty-text").textContent = bad ? `Fix ${bad} invalid value${bad === 1 ? "" : "s"}` : `${dirty} unsaved change${dirty === 1 ? "" : "s"}`;
    $("#btn-save").disabled = state.busy || bad > 0 || dirty === 0;
    $("#btn-revert").disabled = state.busy;
}

// Unchanged lines are written back byte for byte; only edited ones are rebuilt.
function buildConfigText() {
    const out = [];
    for (const ln of state.parsed.model) {
        if (ln.kind !== "field") { out.push(ln.raw); continue; }
        const row = $(`#settings-form [data-id="${ln.id}"]`);
        if (!row || !row.hasAttribute("data-dirty")) { if (!ln.isNew) out.push(ln.raw); continue; }
        const { on, value } = rowState(row);
        out.push((on ? "" : "#") + ln.key + "=" + value + (ln.inlineHint ? "  # " + ln.inlineHint : ""));
    }
    return out.join("\n").replace(/\n*$/, "\n");
}

function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

/* ==========================================================================
 * Device list
 * ======================================================================= */

function parseDeviceLine(l) {
    const tab = l.indexOf("\t");
    if (tab < 1) return null;
    const code = l.slice(0, tab).trim();
    const model = l.slice(tab + 1).trim();
    return code && model ? { code, model } : null;
}

function normalizeDevices(list) {
    const seen = new Map();
    for (const d of list) if (!seen.has(d.code)) seen.set(d.code, d);
    return [...seen.values()].sort((a, b) => a.model.localeCompare(b.model, undefined, { numeric: true }) || a.code.localeCompare(b.code));
}

function setDevices(list, src, fetchedAt) {
    state.devices = normalizeDevices(list);
    state.devSrc = src;
    state.fetchedAt = fetchedAt;
    renderDeviceNote();
    if ($("#sheet").classList.contains("open")) renderDeviceList();
    syncControls();
}

function renderDeviceNote() {
    const n = state.devices.length;
    let s = !n ? "No devices available"
        : state.devSrc === "builtin" ? `${n} devices from the module's built-in list`
        : `${n} devices, updated ${ago(Date.now() - state.fetchedAt)}`;
    if (state.refreshing) s += ", checking Google";
    else if (state.refreshFailed) s += ", could not reach Google";
    $("#device-note").textContent = s;
    $("#sheet-note").textContent = s;
    $("#device-refresh").classList.toggle("spin", state.refreshing);
    $("#device-value").textContent = state.selected ? `${state.selected.model} (${state.selected.code})` : (n ? "Choose a device" : "None available");
}

function renderDeviceList() {
    const f = $("#device-search").value.trim().toLowerCase();
    const sel = state.selected && state.selected.code;
    const items = state.devices.filter(d => !f || d.model.toLowerCase().includes(f) || d.code.includes(f));
    $("#device-list").innerHTML = items.length
        ? items.map(d => `<li><button role="option" data-code="${esc(d.code)}" data-model="${esc(d.model)}" aria-selected="${d.code === sel}">
              <span class="name">${esc(d.model)}</span><span class="code">${esc(d.code)}</span><svg class="ic"><use href="#i-check"/></svg></button></li>`).join("")
        : `<li class="none">No device matches "${esc(f)}".</li>`;
}

function openSheet() {
    $("#device-search").value = "";
    renderDeviceList();
    const s = $("#sheet");
    s.classList.add("open");
    s.setAttribute("aria-hidden", "false");
}

function closeSheet() {
    const s = $("#sheet");
    s.classList.remove("open");
    s.setAttribute("aria-hidden", "true");
}

async function refreshDevices() {
    if (state.refreshing) return;
    state.refreshing = true;
    state.refreshFailed = false;
    renderDeviceNote();
    try {
        const lines = (await pifctl("devices")).replace(/\r/g, "").split("\n");
        const live = lines.some(l => l === "__PIFCTL_DEVSRC__=live");
        const rows = lines.map(parseDeviceLine).filter(Boolean);
        if (live && rows.length) setDevices(rows, "live", Date.now());
        else state.refreshFailed = true;
    } catch {
        state.refreshFailed = true;
    }
    state.refreshing = false;
    renderDeviceNote();
}

/* ==========================================================================
 * Generation and actions
 * ======================================================================= */

function showGenError(msg) {
    const el = $("#gen-error");
    el.hidden = !msg;
    el.textContent = msg || "";
}

async function generate(args, label) {
    if (state.busy) return;
    setBusy(true);
    showGenError("");
    state.pending = null;
    renderPending();
    lastStep = "";
    $("#gen-label").textContent = label;
    $("#gen-step").textContent = "Starting";
    $("#gen-progress").hidden = false;
    log(`> ${label}`, "dim");

    let result = "", file = "", gap = true;
    try {
        await spawnLines(args, line => {
            const m = MARKER.exec(line);
            if (m) {
                if (m[1] === "RESULT") result = m[2];
                else if (m[1] === "PRINT") file = m[2];
                else if (m[1] === "ERROR") { log(m[2], "err"); showGenError(m[2]); }
                return;
            }
            // Keep autopif4's blank separators between sections, but never two in a row.
            if (!line.trim()) { if (!gap) { log(""); gap = true; } return; }
            gap = false;
            log(line);
            lastStep = line.trim();
        });
        if (result === "OK" && file) {
            const body = await exec(`cat ${q(file)}`);
            const parsed = parseConfig(body);
            const map = toMap(parsed.model);
            state.pending = { file, map, validity: computeValidity(map, parsed.meta) };
            log("Done. Review the new print, then apply it.", "dim");
        } else if (result.startsWith("MISMATCH")) {
            const wanted = args[1] ? `${args[2] || args[1]}` : "That device";
            showGenError(`${wanted} is not in Google's current Canary or Beta program, so a fresh print cannot be generated for it.`);
        } else if (!$("#gen-error").textContent) {
            showGenError("Generation failed. Check the log for details.");
        }
    } catch (e) {
        log(e.message, "err");
        showGenError("Could not run the generator: " + e.message);
    }
    $("#gen-progress").hidden = true;
    setBusy(false);
    renderPending();
    if (state.pending) $("#pending").scrollIntoView({ block: "nearest" });
}

async function applyPending() {
    if (!state.pending || state.busy) return;
    setBusy(true);
    try {
        await pifctl("apply", state.pending.file);
        state.pending = null;
        toast("Applied. GMS restarted.");
        await reloadConfig();
    } catch (e) { toast("Apply failed: " + e.message); log("Apply failed: " + e.message, "err"); }
    setBusy(false);
    renderPending();
}

async function killpi() {
    if (state.busy) return;
    setBusy(true);
    try { await pifctl("killpi"); toast("GMS restarted"); }
    catch (e) { toast("Restart failed: " + e.message); log(e.message, "err"); }
    setBusy(false);
}

async function saveSettings() {
    if (state.busy || $$("#settings-form [data-invalid]").length) return;
    setBusy(true);
    try {
        const b64 = toBase64(buildConfigText());
        await exec(`sh ${q(PIFCTL)} save ${q(b64)} && sh ${q(PIFCTL)} killpi`);
        toast("Saved. GMS restarted.");
        await reloadConfig();
    } catch (e) { toast("Save failed: " + e.message); log("Save failed: " + e.message, "err"); }
    setBusy(false);
}

/* ==========================================================================
 * Loading
 * ======================================================================= */

function applyConfig(source, body) {
    state.source = source || "none";
    state.parsed = parseConfig(body || "");
    renderActive();
    renderSettings();
}

function splitConfig(lines, from) {
    let source = "", body = "";
    for (let i = from; i < lines.length; i++) {
        if (lines[i].startsWith("SOURCE=")) source = lines[i].slice(7);
        else if (lines[i] === "__PIFCTL_BODY__") { body = lines.slice(i + 1).join("\n"); break; }
    }
    return { source, body };
}

async function reloadConfig() {
    const { source, body } = splitConfig((await pifctl("read")).replace(/\r/g, "").split("\n"), 0);
    applyConfig(source, body);
}

// Runs first and tolerates a missing data file, so a packaging slip cannot
// stop the rest of the UI from starting.
function renderCheatsheet() {
    const data = window.PIF_CHEATSHEET;
    if (!data) { $('[data-go="cheatsheet"]').hidden = true; return; }
    const card = s => {
        const rows = (s.rows || []).map(r => `<div class="cs-row">
            <div class="cs-head"><span class="cs-key">${esc(r.key)}</span><span class="cs-val">${esc(r.value)}</span><span class="tag${r.src === "Tested" ? " tested" : ""}">${esc(r.src)}</span></div>
            <p class="caption">${esc(r.note)}</p></div>`).join("");
        const cmd = s.cmd ? `<pre class="cs-cmd">${esc(s.cmd)}</pre>${s.cmdNote ? `<p class="caption">${esc(s.cmdNote)}</p>` : ""}` : "";
        const bullets = (s.bullets || []).length ? `<ul class="cs-list">${s.bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>` : "";
        return `<section class="card"><h2 class="cs-title">${esc(s.title)}</h2>${s.lead ? `<p class="cs-lead">${esc(s.lead)}</p>` : ""}${cmd}${rows}${bullets}</section>`;
    };
    $("#panel-cheatsheet").innerHTML = data.sections.map(card).join("") + `<p class="caption pad">${esc(data.note || "")}</p>`;
}

async function init() {
    renderCheatsheet();
    wire();
    try {
        const lines = (await pifctl("init")).replace(/\r/g, "").split("\n");
        let src = "builtin", age = -1;
        const rows = [];
        let bodyAt = lines.length;
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (l === "__PIFCTL_BODY__" || l.startsWith("SOURCE=")) { bodyAt = i; break; }
            const m = MARKER.exec(l);
            if (m) {
                if (m[1] === "VERSION") $("#version").textContent = m[2];
                else if (m[1] === "DEVSRC") src = m[2];
                else if (m[1] === "AGE") age = parseInt(m[2], 10);
                continue;
            }
            const d = parseDeviceLine(l);
            if (d) rows.push(d);
        }
        setDevices(rows, src, age >= 0 ? Date.now() - age * 1000 : 0);
        const { source, body } = splitConfig(lines, bodyAt);
        applyConfig(source, body);

        // A fresh cache costs nothing; otherwise refresh once the UI is idle.
        if (src !== "cache" || age < 0 || age > DEVICE_TTL_S) setTimeout(refreshDevices, 500);
    } catch (e) {
        $("#active").innerHTML = `<p class="hero">Cannot read the module</p><p class="empty">${esc(e.message)}. Open this page from a root manager WebUI with the module installed.</p>`;
        $("#settings-form").innerHTML = "";
        $("#device-value").textContent = "Unavailable";
        log(e.message, "err");
    }
}

/* ==========================================================================
 * Events
 * ======================================================================= */

function wire() {
    document.addEventListener("click", e => {
        const t = e.target;
        const nav = t.closest("[data-go]");
        if (nav) { go(nav.dataset.go); return; }
        const act = t.closest("[data-act]");
        if (act) {
            ({ apply: applyPending, killpi, discard: () => { state.pending = null; renderPending(); } })[act.dataset.act]();
            return;
        }
        if (t.closest("[data-close]")) closeSheet();
    });

    document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

    $("#device-row").addEventListener("click", openSheet);
    $("#device-search").addEventListener("input", renderDeviceList);
    $("#device-refresh").addEventListener("click", refreshDevices);
    $("#device-list").addEventListener("click", e => {
        const b = e.target.closest("[data-code]");
        if (!b) return;
        state.selected = { code: b.dataset.code, model: b.dataset.model };
        showGenError("");
        renderDeviceNote();
        syncControls();
        closeSheet();
    });

    $("#btn-generate").addEventListener("click", () => {
        const s = state.selected;
        if (s) generate(["generate", s.code], `Generating for ${s.model}`);
    });
    $("#btn-random").addEventListener("click", () => generate(["generate-random"], "Generating a random Canary print"));

    const form = $("#settings-form");
    form.addEventListener("input", e => {
        const row = e.target.closest(".srow");
        if (!row) return;
        if (e.target.tagName === "TEXTAREA" && /[\r\n]/.test(e.target.value)) e.target.value = e.target.value.replace(/[\r\n]+/g, "");
        onRowChange(row);
    });
    form.addEventListener("change", e => { const row = e.target.closest(".srow"); if (row) onRowChange(row); });
    form.addEventListener("keydown", e => {
        if (e.key !== "Enter") return;
        const box = e.target.closest(".add-prop");
        if (box) { e.preventDefault(); addProperty(box); }
        else if (e.target.tagName === "TEXTAREA") e.preventDefault();
    });
    form.addEventListener("click", e => {
        const add = e.target.closest("[data-add]");
        if (add) { addProperty(add.closest(".add-prop")); return; }
        const b = e.target.closest("[data-info]");
        if (!b) return;
        const row = b.closest(".srow");
        const open = row.toggleAttribute("data-open");
        b.setAttribute("aria-expanded", String(open));
    });

    $("#btn-save").addEventListener("click", saveSettings);
    $("#btn-revert").addEventListener("click", discardEdits);

    $("#btn-clear").addEventListener("click", () => { $("#log").textContent = ""; });
    $("#btn-copy").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText($("#log").innerText); toast("Log copied"); }
        catch { toast("Copy is not available here"); }
    });

    window.addEventListener("error", e => log(`[ui] ${e.message}`, "err"));
    try {
        if (typeof ksu !== "undefined" && ksu.mmrl && window["$" + MODID]) {
            window["$" + MODID].setLightStatusBars(!matchMedia("(prefers-color-scheme: dark)").matches);
        }
    } catch { /* host without MMRL helpers */ }
}

document.addEventListener("DOMContentLoaded", init);
