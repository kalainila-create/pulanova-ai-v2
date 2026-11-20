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

/* ---- OCR helpers (pure functions, unit-tested) ---- */
function ocrWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) out.push(w);
  return out;
}
const JUNK = /[^\p{L}\p{N}\p{M}\s.,:;\/%₹&()+\-@#!?'"]/gu;
/* Keep only confident words, drop lines that are mostly symbols, remove stray symbols that a speech engine would read aloud. */
function cleanOcrText(data, minConf = 60) {
  let lines = data.lines;
  if (!Array.isArray(lines) || !lines.length) {
    const words = ocrWords(data); lines = words.length ? [{ words }] : [];
  }
  const out = []; let good = 0;
  for (const line of lines) {
    const keep = [];
    for (const w of line.words || []) {
      if ((w.confidence ?? 0) < minConf || !/[\p{L}\p{N}]/u.test(w.text)) continue;
      // a lone letter is usually noise, except 'a', 'I' and units such as the g or l after a number (500 g)
      const prev = keep[keep.length - 1];
      if (w.text.length === 1 && !/\p{N}/u.test(w.text) && !/^[aAiI]$/.test(w.text) && !(prev && /\p{N}/u.test(prev.text) && /^[gGlLmM]$/.test(w.text))) continue;
      keep.push(w);
    }
    if (!keep.length) continue;
    let text = keep.map(w => w.text).join(" ").replace(JUNK, " ").replace(/\s+/g, " ").trim();
    const visible = text.replace(/\s/g, ""), alnum = (visible.match(/[\p{L}\p{N}]/gu) || []).length;
    if (visible.length < 2 || alnum / visible.length < 0.6) continue;
    out.push(text); good += keep.length;
  }
  if (!out.length && typeof data.text === "string") {                 // engines that return only plain text
    const t = data.text.replace(JUNK, " ").replace(/[ \t]+/g, " ").trim();
    return { text: t, good: t.split(/\s+/).filter(w => w.length > 1).length };
  }
  return { text: out.join("\n"), good };
}

const MONTHS = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC";
const D = "[0-9OIL]";                                                  // OCR often reads 0 as O and 1 as I or L
const fixDigits = s => s.replace(/\b[0-9OIL]+\b/g, t => t.replace(/O/g, "0").replace(/[IL]/g, "1"));   // whole digit-like words only, so NOV stays NOV
const DATE_PATTERNS = [
  new RegExp(`(${D}{1,2})[\\/.\\-](${D}{1,2})[\\/.\\-](${D}{4}|${D}{2})(?![0-9])`, "g"),            // 12/11/2026
  new RegExp(`(${D}{1,2})[\\/.\\-\\s]?(${MONTHS})[A-Z]*[\\/.\\-\\s]?(${D}{4}|${D}{2})(?![0-9])`, "g"), // 12 NOV 2026
  new RegExp(`(${MONTHS})[A-Z]*[\\/.\\-\\s]?(${D}{4}|${D}{2})(?![0-9])`, "g"),                        // NOV 2026
  new RegExp(`(${D}{1,2})[\\/.\\-](${D}{4})(?![0-9])`, "g"),                                          // 11/2026
];
const LABELS = [
  [/(EXP(?:IRY)?\.?(?:\s*DATE)?|USE\s*BY|BEST\s*BEFORE|B\/B|BB)\s*[:.\-]?\s*$/, "expiry"],
  [/(MFD?\.?|MFG\.?|MANUFACTURED?|PKD\.?|PACKED(?:\s*ON)?)(?:\s*DATE)?\s*[:.\-]?\s*$/, "made"],
];
/* Finds dates in OCR text and labels them as expiry / made / plain date. */
function parseDates(raw) {
  const text = String(raw).toUpperCase().replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ");
  const found = [], seen = new Set(), spans = [];
  DATE_PATTERNS.forEach(re => {
    re.lastIndex = 0; let m;
    while ((m = re.exec(text))) {
      const s0 = m.index, s1 = m.index + m[0].length;
      if (spans.some(([a, b]) => s0 < b && s1 > a)) continue;           // already covered by a longer date
      const shown = fixDigits(m[0]).trim();
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      let kind = "date";
      for (const [rx, k] of LABELS) if (rx.test(before)) { kind = k; break; }
      // plain numbers like 12.5 or a price are not dates: need a label, a month name, or a 4-digit year
      if (kind === "date" && !new RegExp(MONTHS).test(shown) && !/(?:^|[^0-9])\d{4}(?![0-9])/.test(shown)) continue;
      const key = shown.replace(/\D/g, "") + kind; if (seen.has(key)) continue; seen.add(key); spans.push([s0, s1]);
      found.push({ kind, text: shown, spoken: shown.replace(/[\/.\-]/g, " ").replace(/\s+/g, " ") });
    }
  });
  const life = text.match(/(\d{1,2})\s*(MONTHS?|DAYS?|YEARS?)\s*(?:FROM|OF|AFTER)\s*(?:THE\s*)?(?:DATE\s*OF\s*)?(MFG|MFD|PACKING|MANUFACTURE|PACKAGING)/);
  if (life) found.push({ kind: "shelf", text: life[0], spoken: `${life[1]} ${life[2].toLowerCase()}` });
  const order = { expiry: 0, shelf: 1, made: 2, date: 3 };
  return found.sort((a, b) => order[a.kind] - order[b.kind]);
}

/* Decide what to tell the user about a note. Colour alone is never trusted for the grey 500 note. */
function decideNote({ printed, strong, colour }) {
  if (printed) {
    if (!colour || colour === printed || strong) return { value: printed, basis: "printed", level: "info" };
    return { value: printed, basis: "conflict", colour, level: "caution" };
  }
  if (colour && colour !== 500) return { value: colour, basis: "colour", level: "caution" };
  return { value: null };
}
window.PUL_visionTest = { classifyNote, rgbToHsv, cleanOcrText, parseDates, decideNote };


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
    stopFind, stopCamera, toggleTorch,
  };

  /* ---- camera + model ---- */
  let torchOn = false;
  async function startCamera() {
    if (stream) return true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(PUL.t("Camera access is not available in this browser."));
      setStatus(PUL.t("Requesting camera permission…"));
      // Ask for a sharp picture: small printed numbers and dates need resolution to be read reliably.
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      const video = v(); video.srcObject = stream; video.style.display = "block";
      $("#camera-placeholder").hidden = true;
      await video.play();
      $("#start-camera").disabled = true; $("#stop-camera").disabled = false;
      const track = stream.getVideoTracks()[0], torch = $("#torch-toggle");
      torchOn = false;
      if (torch) { torch.hidden = !(track.getCapabilities?.().torch); torch.setAttribute("aria-pressed", "false"); }
      setStatus("");
      PUL.saveEvent("camera", "Camera started.", "info");
      return true;
    } catch (e) { setStatus(e.message); stopCamera(); return false; }
  }
  async function toggleTorch() {
    const track = stream?.getVideoTracks()[0];
    if (!track?.getCapabilities?.().torch) return narrate(PUL.t("The flashlight is not available on this camera."));
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (_) { torchOn = !torchOn; return; }
    $("#torch-toggle")?.setAttribute("aria-pressed", String(torchOn));
    narrate(PUL.t(torchOn ? "Flashlight on." : "Flashlight off."), { interrupt: true });
  }
  function stopCamera() {
    loopToken++; stopBeeps(); torchOn = false;
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

  /* ---- shared camera/OCR helpers ---- */
  const grab = video => { const c = document.createElement("canvas"); c.width = video.videoWidth; c.height = video.videoHeight; c.getContext("2d").drawImage(video, 0, 0); return c; };
  function small(c, w) { const t = document.createElement("canvas"); t.width = w; t.height = Math.max(1, Math.round(c.height * w / c.width)); const g = t.getContext("2d", { willReadFrequently: true }); g.drawImage(c, 0, 0, t.width, t.height); return { g, w: t.width, h: t.height }; }
  function sharpness(c) {                                      // variance of the Laplacian: higher = sharper picture
    const { g, w, h } = small(c, 160), d = g.getImageData(0, 0, w, h).data, gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
    let s = 0, s2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x, l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]; s += l; s2 += l * l; n++; }
    return n ? s2 / n - (s / n) ** 2 : 0;
  }
  function meanLuma(c) { const { g, w, h } = small(c, 32), d = g.getImageData(0, 0, w, h).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; return s / (d.length / 4); }
  async function bestFrame(video, n = 3, gap = 180) {            // hand shake blurs frames; keep the sharpest of a few
    let best = null, top = -1;
    for (let i = 0; i < n; i++) { const c = grab(video), sc = sharpness(c); if (sc > top) { top = sc; best = c; } if (i < n - 1) await PUL.wait(gap); }
    return best;
  }
  function prepForOcr(src, angle = 0) {                            // grayscale + contrast; gentle upscale only for sharp HD frames
    const turned = angle === 90 || angle === 270, long = Math.max(src.width, src.height);
    const scale = long >= 1000 ? Math.min(1.6, 2000 / long) : 1;
    const w = Math.round(src.width * scale), h = Math.round(src.height * scale), c = document.createElement("canvas");
    c.width = turned ? h : w; c.height = turned ? w : h;
    const g = c.getContext("2d"); g.filter = long >= 1000 ? "grayscale(1) contrast(1.4)" : "grayscale(1) contrast(1.2)";
    g.translate(c.width / 2, c.height / 2); g.rotate(angle * Math.PI / 180); g.drawImage(src, -w / 2, -h / 2, w, h);
    return c;
  }
  const ocrWorkers = {};
  async function getWorker(key, langs) {
    if (!ocrWorkers[key]) { await PUL.loadScript(OCR_URL); ocrWorkers[key] = await Tesseract.createWorker(langs); }
    return ocrWorkers[key];
  }
  window.addEventListener("pagehide", () => Object.values(ocrWorkers).forEach(w => w.terminate?.()));

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
    const token = ++readToken, out = $("#ocr-output"), ta = PUL.lang() === "ta";
    narrate(PUL.t("Reading the text, please wait."), { interrupt: true });
    try {
      setStatus(PUL.t("Loading text reader…"));
      const worker = await getWorker(ta ? "text-ta" : "text-en", ta ? "tam+eng" : "eng");
      const frame = await bestFrame(v());
      if (meanLuma(frame) < 55) narrate(PUL.t("It is dark. Turn on the flashlight or move to a brighter place."), { interrupt: false });
      let best = { text: "", good: -1 };
      for (const psm of ["3", "11"]) {                             // normal layout first, then scattered text
        await worker.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: "" });
        const { data } = await worker.recognize(prepForOcr(frame));
        const r = cleanOcrText(data, ta ? 45 : 60);
        if (r.good > best.good) best = r;
        if (r.good >= 8) break;
      }
      if (token !== readToken) return;
      setStatus("");
      if (out) out.value = best.text;
      if (best.good < 2) { narrate(PUL.t("No text found. Move closer and try again.")); return; }
      PUL.announce(best.text, { short: best.text.slice(0, 40) });
      PUL.saveEvent("ocr", `Read ${best.text.length} characters of text.`, "info");
      await speakLong(best.text.replace(/\n/g, ". "), token);
    } catch (e) { setStatus(e.message); narrate(e.message, { level: "caution" }); }
  }

  /* ---- mode: read the expiry date on a pack ---- */
  const DATE_WHITELIST = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/.-: ";
  const KIND_LABEL = { expiry: "Expiry", made: "Made on", shelf: "Best before", date: "Date" };
  async function readDate() {
    if (!(await startCamera())) return;
    setMode("text");
    const token = ++readToken, out = $("#ocr-output");
    narrate(PUL.t("Looking for the date…"), { interrupt: true });
    try {
      setStatus(PUL.t("Loading text reader…"));
      const worker = await getWorker("date", "eng");
      const frame = await bestFrame(v(), 3, 180);
      if (meanLuma(frame) < 55) narrate(PUL.t("It is dark. Turn on the flashlight or move to a brighter place."), { interrupt: false });
      let all = "", found = [];
      for (const [angle, psm, wl] of [[0, "11", DATE_WHITELIST], [90, "11", DATE_WHITELIST], [270, "11", DATE_WHITELIST], [0, "3", ""]]) {
        await worker.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: wl });
        const { data } = await worker.recognize(prepForOcr(frame, angle));
        all += " " + (data.text || ""); found = parseDates(all);
        if (token !== readToken) return;
        if (found.some(f => f.kind === "expiry")) break;
      }
      setStatus("");
      if (out) out.value = all.replace(/\s+/g, " ").trim();
      if (!found.length) { narrate(PUL.t("I could not find a date. Hold the pack 20 to 30 centimetres away, tilt it to avoid glare, and try again."), { level: "caution" }); return; }
      const message = found.slice(0, 3).map(f => `${PUL.t(KIND_LABEL[f.kind])}: ${f.spoken}`).join(". ");
      narrate(message, { short: found[0].text });
      PUL.saveEvent("ocr", `Read a date on a pack (${found[0].kind}).`, "info");
    } catch (e) { setStatus(e.message); narrate(e.message, { level: "caution" }); }
  }

  /* ---- mode: Indian currency ----
     (1) OCR reads the large printed number (the reliable signal); (2) colour is only a cross-check.
     Colour is never trusted alone for the grey 500 note, because a mixed or washed-out picture always averages to grey. */
  const VALID_NOTES = new Set([10, 20, 50, 100, 200, 500, 2000]);
  const isSkin = (r, g, b) => r > 95 && g > 40 && b > 20 && r > g && r > b && (r - g) > 15 && (Math.max(r, g, b) - Math.min(r, g, b)) > 15;
  const median = a => a.sort((x, y) => x - y)[a.length >> 1];
  async function readDenomination(video) {                        // staged: stop as soon as the number is read clearly
    const worker = await getWorker("digits", "eng");
    await worker.setParameters({ tessedit_pageseg_mode: "11", tessedit_char_whitelist: "0123456789" });
    const counts = {}, leader = () => Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    let tasks = 0;
    for (let round = 0; round < 2; round++) {
      const frame = await bestFrame(video, 3, 160);
      for (const angle of [0, 90, 270]) {                         // notes are often held sideways
        const { data } = await worker.recognize(prepForOcr(frame, angle)); tasks++;
        (data.text.match(/\d+/g) || []).forEach(tok => { const n = Number(tok); if (VALID_NOTES.has(n) && String(n) === tok) counts[n] = (counts[n] || 0) + 1; });
        const top = leader();
        if (top && (top[1] >= 2 || tasks >= 3)) break;
      }
      const top = leader(); if (top && (top[1] >= 2 || round === 1)) break;
    }
    const top = leader();
    return top ? { value: Number(top[0]), hits: top[1], total: Object.values(counts).reduce((a, b) => a + b, 0) } : null;
  }
  function colourVotes(video) {                                    // nine blocks over the middle of the picture
    const votes = [], sw = video.videoWidth * 0.66, sh = video.videoHeight * 0.66;
    const cv = document.createElement("canvas"); cv.width = cv.height = 144;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, 144, 144);
    for (let by = 0; by < 3; by++) for (let bx = 0; bx < 3; bx++) {
      const px = g.getImageData(bx * 48, by * 48, 48, 48).data, R = [], G = [], B = [];
      for (let k = 0; k < px.length; k += 4) {
        const br = (px[k] + px[k + 1] + px[k + 2]) / 3;
        if (br > 35 && br < 245 && !isSkin(px[k], px[k + 1], px[k + 2])) { R.push(px[k]); G.push(px[k + 1]); B.push(px[k + 2]); }
      }
      if (R.length < 500) continue;
      const mr = median(R), mg = median(G), mb = median(B), hsv = rgbToHsv(mr, mg, mb);
      if (hsv.s < 0.18 || hsv.v < 0.25) continue;                  // grey walls, hair and shadows say nothing about a note
      const r = classifyNote(mr, mg, mb);
      if (r.margin >= 0.08) votes.push(r.value);
    }
    return votes;
  }
  async function checkCurrency() {
    if (!(await startCamera())) return;
    setMode("currency");
    const out = $("#currency-result"), video = v();
    narrate(PUL.t("Checking the note. Hold it flat in the middle of the camera."), { interrupt: true });
    const tally = {}; let total = 0;
    for (let i = 0; i < 8 && stream; i++) { await PUL.wait(200); if (video.readyState < 2) continue; colourVotes(video).forEach(c => { tally[c] = (tally[c] || 0) + 1; total++; }); }
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const colour = ranked[0] && ranked[0][1] >= 6 && ranked[0][1] >= 0.45 * total && ranked[0][1] >= 2 * (ranked[1]?.[1] || 0) ? Number(ranked[0][0]) : null;

    narrate(PUL.t("Reading the number on the note…"), { interrupt: true });
    let printed = null, strong = false;
    try { const r = await readDenomination(video); if (r) { printed = r.value; strong = r.hits >= 2 && r.hits === r.total; } } catch (e) { console.warn(e); }

    const d = decideNote({ printed, strong, colour });
    if (!d.value) {
      if (out) out.textContent = "?";
      narrate(PUL.t("I could not read the number. Hold the note flat and close, with the big number facing the camera, in good light."), { level: "caution" }); return;
    }
    let basis = d.basis === "printed" ? PUL.t("by the printed number")
      : d.basis === "conflict" ? `${PUL.t("by the printed number")}. ${PUL.t("The colour suggests")} ${d.colour}. ${PUL.t("Please confirm with another person.")}`
      : `${PUL.t("by colour only")}. ${PUL.t("Please confirm with another person.")}`;
    if (d.value === 2000) basis += `. ${PUL.t("This note was withdrawn from circulation in 2023 but is still legal tender. Banks and RBI offices can exchange it.")}`;
    if (out) out.textContent = `₹${d.value} · ${d.value} ${PUL.t("rupees")} — ${basis}`;
    narrate(`${d.value} ${PUL.t("rupees")}, ${basis}`, { level: d.level, short: `₹${d.value}` });
    const pulses = { 10: 1, 20: 2, 50: 3, 100: 4, 200: 5, 500: 6, 2000: 7 }[d.value] || 1;   // buzzes = denomination rank
    PUL.haptic.play(Array.from({ length: pulses * 2 - 1 }, (_, k) => (k % 2 ? 110 : 160)), { label: `₹${d.value}` });
    PUL.saveEvent("currency", `Note identified as ${d.value} rupees (${d.basis === "colour" ? "colour only" : "printed number"}).`, d.level === "info" ? "info" : "caution");
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
    if (action === "date") return readDate();
    if (action === "torch") return toggleTorch();
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
      on($("#read-text"), "click", readText); on($("#read-date"), "click", readDate); on($("#torch-toggle"), "click", toggleTorch); on($("#stop-reading"), "click", () => PUL.vision.stopReading());
      on($("#start-find"), "click", () => startFind()); on($("#stop-find"), "click", stopFind);
      on($("#check-currency"), "click", checkCurrency);
      const act = PUL.takeAction(); if (act) run(act.name, act.args);
    },
    run, refresh() { fillTargets(); },
    destroy() { readToken++; speechSynthesis?.cancel(); stopCamera(); cleanup.forEach(fn => fn()); cleanup = []; },
  };
  window.addEventListener("pagehide", () => stream?.getTracks().forEach(t => t.stop()));
})();
