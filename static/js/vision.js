"use strict";
/* Visual support: identify surroundings, read text (OCR), find my object, Indian currency. */

const COCO_URL = "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3";
const OCR_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

/* What the user can ask PULANOVA to find. COCO-SSD knows 80 everyday classes. */
const TARGETS = {
  bag:       { en: "Bag", ta: "பை", classes: ["backpack", "handbag", "suitcase"], words: ["bag", "purse", "பை"] },
  backpack:  { en: "Backpack", ta: "முதுகுப்பை", classes: ["backpack"], words: ["backpack", "rucksack", "முதுகுப்பை"] },
  suitcase:  { en: "Suitcase", ta: "பெட்டி", classes: ["suitcase"], words: ["suitcase", "luggage", "பெட்டி"] },
  phone:     { en: "Phone", ta: "கைப்பேசி", classes: ["cell phone"], words: ["phone", "mobile", "cell", "கைப்பேசி", "தொலைபேசி", "போன்"] },
  bottle:    { en: "Bottle", ta: "பாட்டில்", classes: ["bottle"], words: ["bottle", "பாட்டில்"] },
  cup:       { en: "Cup", ta: "கோப்பை", classes: ["cup", "wine glass"], words: ["cup", "mug", "glass", "கோப்பை"] },
  laptop:    { en: "Laptop", ta: "மடிக்கணினி", classes: ["laptop"], words: ["laptop", "computer", "மடிக்கணினி"] },
  book:      { en: "Book", ta: "புத்தகம்", classes: ["book"], words: ["book", "புத்தகம்"] },
  remote:    { en: "Remote", ta: "ரிமோட்", classes: ["remote"], words: ["remote", "ரிமோட்"] },
  umbrella:  { en: "Umbrella", ta: "குடை", classes: ["umbrella"], words: ["umbrella", "குடை"] },
  chair:     { en: "Chair", ta: "நாற்காலி", classes: ["chair"], words: ["chair", "seat", "நாற்காலி"] },
  person:    { en: "Person", ta: "நபர்", classes: ["person"], words: ["person", "someone", "நபர்"] },
};
const CLASS_TA = { person: "நபர்", car: "கார்", bus: "பேருந்து", truck: "லாரி", motorcycle: "மோட்டார் சைக்கிள்", bicycle: "மிதிவண்டி",
  dog: "நாய்", cat: "பூனை", chair: "நாற்காலி", bottle: "பாட்டில்", cup: "கோப்பை", laptop: "மடிக்கணினி", "cell phone": "கைப்பேசி",
  book: "புத்தகம்", backpack: "முதுகுப்பை", handbag: "கைப்பை", suitcase: "பெட்டி", umbrella: "குடை", bench: "இருக்கை",
  "traffic light": "போக்குவரத்து விளக்கு", couch: "சோபா", bed: "படுக்கை", "dining table": "மேசை", tv: "தொலைக்காட்சி", cow: "மாடு" };
const VEHICLES = ["car", "bus", "truck", "motorcycle", "bicycle", "train"];

/* Rupee notes in active circulation (Mahatma Gandhi New series): main colours, as HSV. Colour is only a cross-check:
   older-design notes that are still legal tender (for example the earlier green ₹100) have different colours. */
const NOTES = [
  { value: 10,   h: 25,  s: 0.55, v: 0.50 },   // chocolate brown
  { value: 20,   h: 70,  s: 0.60, v: 0.75 },   // greenish yellow
  { value: 50,   h: 190, s: 0.60, v: 0.80 },   // fluorescent blue
  { value: 100,  h: 270, s: 0.30, v: 0.75 },   // lavender
  { value: 200,  h: 42,  s: 0.80, v: 0.95 },   // bright yellow
  { value: 500,  h: 45,  s: 0.08, v: 0.60 },   // stone grey
];   // The withdrawn ₹2000 note is not in this colour list (see VALID_NOTES: it is still read by its printed number).
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return { h, s: max ? d / max : 0, v: max };
}
function classifyNote(r, g, b) {
  const c = rgbToHsv(r, g, b);
  const scored = NOTES.map(n => {
    const dh = Math.min(Math.abs(c.h - n.h), 360 - Math.abs(c.h - n.h)) / 180;
    const sat = (c.s + n.s) / 2;
    return { value: n.value, d: 2 * dh * Math.min(1, sat * 2) + Math.abs(c.s - n.s) + 0.7 * Math.abs(c.v - n.v) };
  }).sort((a, b2) => a.d - b2.d);
  return { value: scored[0].value, margin: scored[1].d - scored[0].d };
}
window.PUL_visionTest = { classifyNote, rgbToHsv };

(() => {
  let stream = null, model = null, mode = null, loopToken = 0, cleanup = [];
  let readToken = 0, lastSpoken = "", lastSpokenAt = 0, lastEventAt = 0, lastSeenAt = 0, findKey = "", beepTimer = null;
  const v = () => $("#camera-video");
  const speakOk = () => !(PUL.settings().needs?.hearing);
  const narrate = (text, opts = {}) => {
    PUL.toast(text, opts.level || "info"); PUL.announce(text, { assertive: opts.assertive, short: opts.short });
    if (speakOk()) return PUL.speak(text, { force: true, interrupt: opts.interrupt !== false });
  };
  const setStatus = t => { const el = $("#model-status"); if (el) el.textContent = t; };

  PUL.vision = {
    resolveTarget(text) {
      const t = text.toLowerCase().trim();
      const hit = Object.entries(TARGETS).find(([, x]) => x.words.some(w => t.includes(w.toLowerCase())));
      return hit ? hit[0] : null;
    },
    stopReading() { readToken++; speechSynthesis?.cancel(); },
    stopFind, stopCamera,
  };

  /* ---- camera + model ---- */
  async function startCamera() {
    if (stream) return true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(PUL.t("Camera access is not available in this browser."));
      setStatus(PUL.t("Requesting camera permission…"));
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      const video = v(); video.srcObject = stream; video.style.display = "block";
      $("#camera-placeholder").hidden = true;
      await video.play();
      $("#start-camera").disabled = true; $("#stop-camera").disabled = false;
      setStatus("");
      PUL.saveEvent("camera", "Camera started.", "info");
      return true;
    } catch (e) { setStatus(e.message); stopCamera(); return false; }
  }
  function stopCamera() {
    loopToken++; stopBeeps();
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    const video = v();
    if (video) { video.pause(); video.srcObject = null; video.style.display = "none"; }
    if ($("#camera-placeholder")) $("#camera-placeholder").hidden = false;
    if ($("#start-camera")) { $("#start-camera").disabled = false; $("#stop-camera").disabled = true; }
    clearOverlay(); setStatus(PUL.t("Camera stopped."));
  }
  async function ensureModel() {
    if (model) return model;
    setStatus(PUL.t("Loading object detection model…"));
    await PUL.loadScript(TFJS_URL); await PUL.loadScript(COCO_URL);
    model = await cocoSsd.load();
    setStatus(PUL.t("Camera and model are ready."));
    return model;
  }

  /* ---- geometry helpers ---- */
  function describe(p, video) {
    const [x, y, w, h] = p.bbox;
    const cx = (x + w / 2) / video.videoWidth;
    const ratio = (w * h) / (video.videoWidth * video.videoHeight);
    const dir = cx < 0.35 ? "on your left" : cx > 0.65 ? "on your right" : "ahead";
    const dist = ratio > 0.30 ? "very close" : ratio > 0.10 ? "near" : "far";
    return { dir, dist, ratio, cx };
  }
  const className = c => (PUL.lang() === "ta" && CLASS_TA[c]) || c;
  function clearOverlay() { const c = $("#overlay-canvas"); c?.getContext?.("2d")?.clearRect(0, 0, c.width, c.height); }
  function drawBoxes(preds, video) {
    const canvas = $("#overlay-canvas"); if (!canvas || !video.videoWidth) return;
    canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
    const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const ox = (canvas.width - video.videoWidth * scale) / 2, oy = (canvas.height - video.videoHeight * scale) / 2;
    const g = canvas.getContext("2d"); g.clearRect(0, 0, canvas.width, canvas.height);
    g.lineWidth = 3; g.font = "bold 16px sans-serif";
    preds.forEach(p => {
      const [x, y, w, h] = p.bbox; g.strokeStyle = "#ffd400"; g.fillStyle = "#ffd400";
      g.strokeRect(ox + x * scale, oy + y * scale, w * scale, h * scale);
      g.fillText(`${p.class} ${Math.round(p.score * 100)}%`, ox + x * scale + 4, oy + y * scale + 18);
    });
  }
  const loop = (fn, ms) => {
    const token = ++loopToken;
    (async function tick() {
      if (token !== loopToken || !stream) return;
      try { await fn(); } catch (e) { console.warn(e); }
      if (token === loopToken) setTimeout(tick, ms);
    })();
  };

  /* ---- mode: identify surroundings ---- */
  function setDanger(level) {
    const box = $("#danger-level"); if (!box) return;
    box.className = `danger-level level-${level}`;
    $("#danger-label").textContent = PUL.t(level === "safe" ? "Safe" : level === "caution" ? "Caution" : "Danger");
  }
  async function startIdentify() {
    if (!(await startCamera())) return;
    setMode("identify"); await ensureModel();
    loop(async () => {
      const video = v(); if (!video || video.readyState < 2) return;
      const preds = (await model.detect(video)).filter(p => p.score >= 0.5);
      drawBoxes(preds, video);
      const items = preds.map(p => ({ p, ...describe(p, video) })).sort((a, b) => b.ratio - a.ratio).slice(0, 4);
      if (!items.length) { $("#detection-result").textContent = PUL.t("Nothing recognised in view."); setDanger("safe"); return; }
      let level = "safe";
      items.forEach(i => {
        const vehicle = VEHICLES.includes(i.p.class);
        if ((vehicle && i.ratio > 0.30) ) level = "danger";
        else if ((i.ratio > 0.30 || (vehicle && i.ratio > 0.08)) && level !== "danger") level = "caution";
      });
      setDanger(level);
      const text = items.map(i => `${className(i.p.class)} ${PUL.t(i.dir)}, ${PUL.t(i.dist)}`).join(". ");
      $("#detection-result").textContent = text;
      const now = Date.now(), signature = items.map(i => `${i.p.class}|${i.dir}|${i.dist}`).join(",");
      if (signature !== lastSpoken && now - lastSpokenAt > 3500) {
        lastSpoken = signature; lastSpokenAt = now;
        narrate(text, { level: level === "safe" ? "info" : level, assertive: level === "danger", short: className(items[0].p.class) });
        if (level !== "safe") PUL.haptic.play(level === "danger" ? "emergency" : [200, 100, 200], { label: PUL.t(level === "danger" ? "Danger" : "Caution") });
      }
      if (level !== "safe" && now - lastEventAt > 15000) { lastEventAt = now; PUL.saveEvent("visual_detection", `${level}: ${text}`.slice(0, 230), level); }
    }, 1400);
  }

  /* ---- mode: find my object ---- */
  const stopBeeps = () => { clearTimeout(beepTimer); beepTimer = null; };
  function panBeep(freq, pan) {
    const ctx = PUL.audio(); if (!ctx) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = freq; gain.gain.value = 0.2;
    let node = gain;
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; gain.connect(p); node = p; }
    osc.connect(gain); node.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.1);
  }
  function scheduleBeeps(getState) {
    stopBeeps();
    (function next() {
      const s = getState(); if (!s) return;
      if (s.visible) panBeep(s.dist === "very close" ? 1000 : 700, s.dir === "on your left" ? -1 : s.dir === "on your right" ? 1 : 0);
      beepTimer = setTimeout(next, s.dist === "very close" ? 220 : s.dist === "near" ? 550 : 1100);
    })();
  }
  async function startFind(key) {
    key = key || $("#find-target")?.value || "bag";
    const target = TARGETS[key]; if (!target) return;
    if ($("#find-target")) $("#find-target").value = key;
    if (!(await startCamera())) return;
    setMode("find"); await ensureModel();
    const label = PUL.lang() === "ta" ? target.ta : target.en;
    narrate(`${PUL.t("Looking for")} ${label}`);
    let state = null; findKey = ""; lastSeenAt = Date.now(); let lastHint = 0;
    scheduleBeeps(() => state);
    loop(async () => {
      const video = v(); if (!video || video.readyState < 2) return;
      const preds = (await model.detect(video)).filter(p => target.classes.includes(p.class) && p.score >= 0.35);
      drawBoxes(preds, video);
      const now = Date.now();
      if (!preds.length) {
        state = null;
        if (now - lastSeenAt > 6000 && now - lastHint > 8000) { lastHint = now; narrate(PUL.t("Not found yet. Turn the phone slowly left and right.")); }
        return;
      }
      lastSeenAt = now;
      const best = preds.sort((a, b) => b.score - a.score)[0];
      const d = describe(best, video);
      state = { visible: true, dir: d.dir, dist: d.dist };
      const k = `${d.dir}|${d.dist}`;
      $("#detection-result").textContent = `${label}: ${PUL.t(d.dir)}, ${PUL.t(d.dist)}`;
      if (k !== findKey) {
        findKey = k;
        if (d.dist === "very close") { narrate(`${label}. ${PUL.t("Within reach.")}`, { level: "info" }); PUL.haptic.play([700], { label: PUL.t("Within reach.") }); }
        else { narrate(`${label} ${PUL.t(d.dir)}, ${PUL.t(d.dist)}`, { interrupt: true }); PUL.haptic.play(d.dir === "on your left" ? PUL.NAV.left.pattern : d.dir === "on your right" ? PUL.NAV.right.pattern : PUL.NAV.forward.pattern, { label: PUL.t(d.dir) }); }
      }
    }, 700);
  }
  function stopFind() { loopToken++; stopBeeps(); clearOverlay(); narrate(PUL.t("Finding stopped."), { interrupt: true }); }

  /* ---- mode: read text ---- */
  async function speakLong(text, token) {
    const chunks = text.replace(/\s+/g, " ").match(/[^.!?।]+[.!?।]?/g) || [text];
    for (let i = 0; i < chunks.length; i++) {
      if (token !== readToken) return;
      await PUL.speak(chunks[i].trim(), { force: true, interrupt: i === 0, lang: PUL.speechLang() });
    }
  }
  async function readText() {
    if (!(await startCamera())) return;
    setMode("text");
    const token = ++readToken, out = $("#ocr-output");
    narrate(PUL.t("Reading the text, please wait."), { interrupt: true });
    try {
      setStatus(PUL.t("Loading text reader…")); await PUL.loadScript(OCR_URL);
      const video = v(), canvas = document.createElement("canvas");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      const { data } = await Tesseract.recognize(canvas, PUL.lang() === "ta" ? "tam+eng" : "eng");
      if (token !== readToken) return;
      const text = (data.text || "").replace(/[ \t]+/g, " ").trim();
      setStatus("");
      if (out) out.value = text;
      if (!text || text.length < 3) { narrate(PUL.t("No text found. Move closer and try again.")); return; }
      PUL.announce(text, { short: text.slice(0, 40) });
      PUL.saveEvent("ocr", `Read ${text.length} characters of text.`, "info");
      await speakLong(text, token);
    } catch (e) { setStatus(e.message); narrate(e.message, { level: "caution" }); }
  }

  /* ---- mode: Indian currency ----
     Two checks: (1) OCR reads the large printed number (10/20/50/100/200/500/2000), which is the reliable signal;
     (2) the note colour is only a cross-check, because room light and a coloured wall change what the camera sees. */
  const VALID_NOTES = new Set([10, 20, 50, 100, 200, 500, 2000]);
  function frameCanvas(video, angle) {
    const c = document.createElement("canvas"), turned = angle === 90 || angle === 270;
    c.width = turned ? video.videoHeight : video.videoWidth; c.height = turned ? video.videoWidth : video.videoHeight;
    const g = c.getContext("2d");
    g.filter = "grayscale(1) contrast(1.5)";
    g.translate(c.width / 2, c.height / 2); g.rotate(angle * Math.PI / 180);
    g.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
    return c;
  }
  async function ocrDenomination(video) {
    await PUL.loadScript(OCR_URL);
    const worker = await Tesseract.createWorker("eng");
    const counts = {};
    try {
      await worker.setParameters({ tessedit_char_whitelist: "0123456789", tessedit_pageseg_mode: Tesseract.PSM?.SPARSE_TEXT ?? "11" });
      for (const angle of [0, 90, 270]) {          // notes are often held sideways; the side numeral is vertical
        const { data } = await worker.recognize(frameCanvas(video, angle));
        (data.text.match(/\d+/g) || []).forEach(tok => { const n = Number(tok); if (VALID_NOTES.has(n) && String(n) === tok) counts[n] = (counts[n] || 0) + 1; });
      }
    } finally { await worker.terminate(); }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top ? { value: Number(top[0]), hits: top[1], total: Object.values(counts).reduce((a, b) => a + b, 0) } : null;
  }
  const isSkin = (r, g, b) => r > 95 && g > 40 && b > 20 && r > g && r > b && (r - g) > 15 && (Math.max(r, g, b) - Math.min(r, g, b)) > 15;

  async function checkCurrency() {
    if (!(await startCamera())) return;
    setMode("currency");
    const out = $("#currency-result"), video = v();
    narrate(PUL.t("Checking the note. Hold it flat in the middle of the camera."), { interrupt: true });
    const tiny = document.createElement("canvas"); tiny.width = tiny.height = 40;
    const g = tiny.getContext("2d", { willReadFrequently: true });
    const votes = {}; let n = 0, margins = 0;
    for (let i = 0; i < 10 && stream; i++) {
      await PUL.wait(250);
      if (video.readyState < 2) continue;
      const sw = video.videoWidth * 0.4, sh = video.videoHeight * 0.3;
      g.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, 40, 40);
      const px = g.getImageData(0, 0, 40, 40).data, R = [], G = [], B = [];
      for (let k = 0; k < px.length; k += 4) {
        const br = (px[k] + px[k + 1] + px[k + 2]) / 3;
        if (br > 35 && br < 245 && !isSkin(px[k], px[k + 1], px[k + 2])) { R.push(px[k]); G.push(px[k + 1]); B.push(px[k + 2]); }
      }
      if (R.length < 200) continue;
      const med = a => a.sort((x, y) => x - y)[a.length >> 1];
      const r = classifyNote(med(R), med(G), med(B));
      votes[r.value] = (votes[r.value] || 0) + 1; margins += r.margin; n++;
    }
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    const colour = best && n >= 6 && best[1] / n >= 0.7 && margins / n >= 0.15 ? Number(best[0]) : null;   // strict

    narrate(PUL.t("Reading the number on the note…"), { interrupt: true });
    let printed = null, strong = false;
    try {
      const r = await ocrDenomination(video);
      if (r) { printed = r.value; strong = r.hits >= 2 && r.hits === r.total; }   // read at least twice, never contradicted
    } catch (e) { console.warn(e); }

    let value = null, basis = "", level = "info";
    if (printed && (!colour || colour === printed || strong)) { value = printed; basis = PUL.t("by the printed number"); }
    else if (printed && colour && colour !== printed) {
      value = printed; level = "caution";
      basis = `${PUL.t("by the printed number")}. ${PUL.t("The colour suggests")} ${colour}. ${PUL.t("Please confirm with another person.")}`;
    } else if (colour) { value = colour; level = "caution"; basis = `${PUL.t("by colour only")}. ${PUL.t("Please confirm with another person.")}`; }

    if (value === 2000) basis += `. ${PUL.t("This note was withdrawn from circulation in 2023 but is still legal tender. Banks and RBI offices can exchange it.")}`;
    if (!value) {
      if (out) out.textContent = "?";
      narrate(PUL.t("I am not sure. Hold the note flat in good light."), { level: "caution" }); return;
    }
    if (out) out.textContent = `₹${value} · ${value} ${PUL.t("rupees")} — ${basis}`;
    narrate(`${value} ${PUL.t("rupees")}, ${basis}`, { level, short: `₹${value}` });
    const pulses = { 10: 1, 20: 2, 50: 3, 100: 4, 200: 5, 500: 6, 2000: 7 }[value] || 1;   // buzzes = denomination rank
    PUL.haptic.play(Array.from({ length: pulses * 2 - 1 }, (_, k) => (k % 2 ? 110 : 160)), { label: `₹${value}` });
    PUL.saveEvent("currency", `Note identified as ${value} rupees (${printed ? "printed number" : "colour only"}).`, level === "info" ? "info" : "caution");
  }

  /* ---- page wiring ---- */
  function setMode(m) {
    mode = m;
    $$(".mode-btn").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
    $$(".mode-pane").forEach(p => { p.hidden = p.dataset.pane !== m; });
    if (m !== "identify" && m !== "find") { if (m) loopToken++; stopBeeps(); }
    if (m !== "identify" && $("#danger-level")) setDanger("safe");
  }
  function fillTargets() {
    const sel = $("#find-target"); if (!sel) return;
    const keep = sel.value; sel.replaceChildren();
    Object.entries(TARGETS).forEach(([k, t]) => { const o = document.createElement("option"); o.value = k; o.textContent = PUL.lang() === "ta" ? t.ta : t.en; sel.append(o); });
    if (keep) sel.value = keep;
  }
  const run = async (action, args = {}) => {
    if (action === "camera") return startCamera();
    if (action === "identify") return startIdentify();
    if (action === "text") return readText();
    if (action === "find") return startFind(args.target);
    if (action === "currency") return checkCurrency();
  };

  PUL.pages.visual = {
    init() {
      cleanup = []; mode = null;
      const on = (el, ev, fn) => { if (!el) return; el.addEventListener(ev, fn); cleanup.push(() => el.removeEventListener(ev, fn)); };
      fillTargets();
      on($("#start-camera"), "click", startCamera); on($("#stop-camera"), "click", stopCamera);
      $$(".mode-btn").forEach(b => on(b, "click", () => {
        const m = b.dataset.mode; setMode(m);
        if (m === "identify") startIdentify();
      }));
      on($("#read-text"), "click", readText); on($("#stop-reading"), "click", () => PUL.vision.stopReading());
      on($("#start-find"), "click", () => startFind()); on($("#stop-find"), "click", stopFind);
      on($("#check-currency"), "click", checkCurrency);
      const act = PUL.takeAction(); if (act) run(act.name, act.args);
    },
    run, refresh() { fillTargets(); },
    destroy() { readToken++; speechSynthesis?.cancel(); stopCamera(); cleanup.forEach(fn => fn()); cleanup = []; },
  };
  window.addEventListener("pagehide", () => stream?.getTracks().forEach(t => t.stop()));
})();
