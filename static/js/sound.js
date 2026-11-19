"use strict";
/* Sound Identity System.
   Accurate mode : YAMNet (TensorFlow.js) recognises 521 sound classes; we map the ones we care about.
   Basic mode    : if the model cannot load, a simple frequency analysis gives rough "possible ..." alerts. */

const TFJS_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js";
const YAMNET_URLS = [
  { url: "/static/models/yamnet/model.json", hub: false },                       // optional offline copy
  { url: "https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1", hub: true },
  { url: "https://www.kaggle.com/models/google/yamnet/tfJs/tfjs/1", hub: true },
];
const CLASS_MAP_URLS = ["/static/models/yamnet/yamnet_class_map.csv", "https://storage.googleapis.com/audioset/yamnet/yamnet_class_map.csv"];

/* YAMNet display names -> PULANOVA sound categories */
const SOUND_RULES = [
  ["emergency", /^(siren|civil defense siren|ambulance \(siren\)|fire engine, fire truck \(siren\)|police car \(siren\)|emergency vehicle|smoke detector, smoke alarm|fire alarm|screaming)$/],
  ["doorbell",  /^(doorbell|ding-dong)$/],
  ["horn",      /^(vehicle horn, car horn, honking|air horn, truck horn|toot|car alarm)$/],
  ["knock",     /^knock$/],
  ["phone",     /^(telephone bell ringing|ringtone|telephone)$/],
  ["baby",      /^(baby cry, infant cry|crying, sobbing)$/],
  ["dog",       /^(dog|bark|bow-wow|yip|growling)$/],
  ["speech",    /^(speech|conversation|narration, monologue|shout|yell)$/],
];
const BASE_THRESHOLD = { emergency: 0.30, doorbell: 0.40, horn: 0.35, knock: 0.40, phone: 0.40, baby: 0.40, dog: 0.45, speech: 0.55 };
const NEED_HITS = { speech: 2, horn: 2, dog: 2, baby: 2, phone: 2 };
const COOLDOWN = { emergency: 4000, speech: 12000 };
const FACTOR = [1.5, 1.25, 1, 0.8, 0.6];              // sensitivity 1..5
const BASIC_EVENTS = {
  doorbell:  { emoji: "🔔", label: "Possible doorbell", severity: "info", pattern: "doorbell" },
  horn:      { emoji: "🚗", label: "Possible horn", severity: "caution", pattern: "horn" },
  emergency: { emoji: "🚨", label: "Possible siren", severity: "danger", pattern: "emergency" },
  speech:    { emoji: "🗣️", label: "Speech-like sound", severity: "info", pattern: "speech" },
  loud:      { emoji: "🔊", label: "Loud sound", severity: "caution", pattern: "knock" },
};

/* ---------- pure helpers (also unit-tested) ---------- */
function categorize(name) {
  const n = name.toLowerCase();
  const rule = SOUND_RULES.find(([, re]) => re.test(n));
  return rule ? rule[0] : null;
}
function parseClassMap(csv) {
  const names = [];
  csv.split(/\r?\n/).slice(1).forEach(line => {
    const m = line.match(/^(\d+),[^,]*,(.*)$/);
    if (m) names[Number(m[1])] = m[2].replace(/^"|"$/g, "");
  });
  return names;
}
/* frames: [{rms, peak, tonal}] at ~10 per second (oldest first). Returns a basic-mode category or null. */
function basicClassify(frames) {
  if (frames.length < 6) return null;
  const last = n => frames.slice(-n);
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  const f5 = last(5), f15 = last(15);
  const loud = f5.every(f => f.rms > 0.04), tonal5 = f5.every(f => f.tonal > 6);
  if (f15.length >= 15 && f15.every(f => f.rms > 0.03 && f.tonal > 5)) {
    const peaks = f15.map(f => f.peak), m = mean(peaks);
    if (sd(peaks) > 120 && m > 500 && m < 2000) return "emergency";
  }
  if (loud && tonal5) {
    const peaks = f5.map(f => f.peak), m = mean(peaks);
    if (sd(peaks) < 25 && m >= 250 && m <= 700) return "horn";
  }
  const prev = frames.slice(-10, -3), recent = last(3);
  if (prev.length && recent.some(f => f.rms > 0.05 && f.rms > 2.2 * mean(prev.map(p => p.rms) ) ) && recent.every(f => f.tonal > 6)) {
    const peaks = recent.map(f => f.peak);
    if (sd(peaks) < 40 && mean(peaks) > 700 && mean(peaks) < 2500) return "doorbell";
  }
  const f10 = last(10);
  if (f10.length === 10 && f10.filter(f => f.rms > 0.02).length >= 8 && f10.every(f => f.tonal < 6)) {
    const m = mean(f10.map(f => f.rms));
    if (sd(f10.map(f => f.rms)) / m > 0.3) return "speech";
  }
  if (recent.some(f => f.rms > 0.14) && prev.length && mean(prev.map(p => p.rms)) < 0.04) return "loud";
  return null;
}
/* ---- Teach a Sound: nearest-fingerprint matching on YAMNet embeddings (1024 numbers per window) ---- */
const EMB_DIM = 1024;
function l2norm(v) { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, x => x / s); }
function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }       // inputs are unit length
function bestSimilarity(vec, samples) { let m = -1; for (const s of samples) { const c = cosine(vec, s); if (c > m) m = c; } return m; }
/* clips: one array of unit vectors per recorded sample. raw = how well the weakest clip matches the others. */
function calibrate(clips) {
  let raw = 1;
  clips.forEach((clip, i) => {
    const others = clips.filter((_, j) => j !== i).flat();
    const peak = Math.max(...clip.map(v => bestSimilarity(v, others)));
    raw = Math.min(raw, peak);
  });
  return { raw, threshold: Math.max(0.70, Math.min(0.95, raw - 0.04)) };
}
window.PUL_soundTest = { categorize, parseClassMap, basicClassify, l2norm, cosine, bestSimilarity, calibrate };   // exposed for tests

(() => {
  let stream = null, ctx = null, processor = null, mute = null, analyser = null;
  let model = null, classNames = null, engine = null;
  let raw = [], rawRate = 16000, timer = null, busy = false, running = false, starting = false;
  const streak = {}, lastFire = {}, frames = [];
  let customSounds = [], teach = { clips: [], busy: false };
  let uiCleanup = [];

  const sensitivity = () => Number($("#sensitivity")?.value || PUL.store.get("pulanova-sensitivity", 3));
  const setStatus = text => { const el = $("#sound-engine"); if (el) el.textContent = text; };

  /* ---- model ---- */
  async function loadYamnet() {
    await PUL.loadScript(TFJS_URL);
    let loaded = null;
    for (const { url, hub } of YAMNET_URLS) {
      try { loaded = await tf.loadGraphModel(url, { fromTFHub: hub }); break; } catch (_) {}
    }
    if (!loaded) throw new Error("model");
    let csv = null;
    for (const url of CLASS_MAP_URLS) {
      try { const r = await fetch(url); if (r.ok) { csv = await r.text(); break; } } catch (_) {}
    }
    if (!csv) throw new Error("classes");
    const names = parseClassMap(csv);
    if (names.length < 500) throw new Error("classes");
    model = loaded; classNames = names;
  }

  async function classifyYamnet() {
    const need = Math.ceil(rawRate * 0.975);
    if (raw.length < need) return;
    return classifyWindow(resample(raw.slice(-need), rawRate, 16000, 15600));
  }
  async function classifyWindow(window16) {
    const rms = Math.sqrt(window16.reduce((s, x) => s + x * x, 0) / window16.length);
    updateLevel(rms);
    if (rms < 0.004) { Object.keys(streak).forEach(k => streak[k] = 0); customSounds.forEach(c => streak["c" + c.id] = 0); return; }
    const input = tf.tensor(window16);
    let out;
    try { out = model.predict(input); } finally { input.dispose(); }
    const outs = Array.isArray(out) ? out : [out];
    const scoresT = Array.isArray(out) ? out[0] : (out.scores || out);
    const mean = scoresT.rank > 1 ? scoresT.max(0) : scoresT;
    const scores = await mean.data();
    let emb = null;                                            // fingerprint of this moment, only needed for taught sounds
    if (customSounds.length && outs[1]) {
      const m = outs[1].rank > 1 ? outs[1].mean(0) : outs[1];
      const d = await m.data(); if (d.length === EMB_DIM) emb = l2norm(d);
      if (m !== outs[1]) m.dispose();
    }
    outs.forEach(t => t.dispose?.()); if (mean !== scoresT) mean.dispose();
    const best = {};
    for (let i = 0; i < scores.length; i++) {
      const cat = classNames[i] && categorize(classNames[i]);
      if (cat && (best[cat] === undefined || scores[i] > best[cat])) best[cat] = scores[i];
    }
    const factor = FACTOR[sensitivity() - 1] || 1;
    Object.keys(BASE_THRESHOLD).forEach(cat => {
      const hit = (best[cat] || 0) >= BASE_THRESHOLD[cat] * factor;
      streak[cat] = hit ? (streak[cat] || 0) + 1 : 0;
      if (streak[cat] >= (NEED_HITS[cat] || 1)) trigger(cat, best[cat], false);
    });
    if (emb) customSounds.forEach(cs => {
      const sim = bestSimilarity(emb, cs.vectors), key = "c" + cs.id;
      streak[key] = sim >= cs.threshold ? (streak[key] || 0) + 1 : 0;
      if (streak[key] >= 2 || sim >= cs.threshold + 0.05) triggerCustom(cs, sim);   // a very strong match needs only one window
    });
  }
  function triggerCustom(cs, score) {
    const now = Date.now(), key = "c" + cs.id;
    if (now - (lastFire[key] || 0) < 6000) return;
    lastFire[key] = now;
    PUL.haptic.alert(cs.pattern, { label: cs.name });
    PUL.say(`${cs.name} ${PUL.t("detected")}`, { level: "info", short: cs.name });
    PUL.saveEvent("sound_custom", `${cs.name} detected (${Math.round(score * 100)}% match, taught sound).`, "info");
    showCard({ emoji: cs.emoji, severity: "info" }, cs.name, score);
  }

  /* ---- basic mode ---- */
  function classifyBasic() {
    const buf = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
    updateLevel(rms);
    const spec = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(spec);
    const hz = ctx.sampleRate / analyser.fftSize;
    let peakI = 0, peakV = -Infinity, sum = 0, count = 0;
    for (let i = Math.floor(100 / hz); i < Math.min(spec.length, Math.floor(3500 / hz)); i++) {
      const lin = Math.pow(10, spec[i] / 20); sum += lin; count++;
      if (spec[i] > peakV) { peakV = spec[i]; peakI = i; }
    }
    const tonal = count ? Math.pow(10, peakV / 20) / (sum / count) : 0;
    frames.push({ rms, peak: peakI * hz, tonal }); if (frames.length > 40) frames.shift();
    const cat = basicClassify(frames);
    if (cat) trigger(cat, 0.5, true);
  }

  /* ---- raising an alert ---- */
  function trigger(cat, score, basic) {
    const now = Date.now();
    if (now - (lastFire[cat] || 0) < (COOLDOWN[cat] || 6000)) return;
    if (!basic && PUL.settings().sounds?.[cat] === false) return;
    if (basic && cat !== "loud" && PUL.settings().sounds?.[cat] === false) return;
    lastFire[cat] = now;
    const info = basic ? BASIC_EVENTS[cat] : PUL.EVENTS[cat];
    const label = PUL.t(info.label);
    const patternKey = basic ? info.pattern : cat;
    const message = `${label} ${PUL.t("detected")}`;
    PUL.haptic.alert(patternKey, { label, repeat: cat === "emergency" ? 3 : 1, red: cat === "emergency" });
    PUL.say(message, { level: info.severity, assertive: info.severity === "danger", short: label });
    PUL.saveEvent(`sound_${cat}`, `${info.label} detected (${Math.round(score * 100)}%${basic ? ", basic mode" : ""}).`, info.severity);
    showCard(info, label, score);
  }
  function showCard(info, label, score) {
    const box = $("#sound-cards"); if (!box) return;
    const card = document.createElement("div");
    card.className = `sound-card sev-${info.severity}`;
    const emoji = document.createElement("span"); emoji.className = "emoji"; emoji.setAttribute("aria-hidden", "true"); emoji.textContent = info.emoji;
    const text = document.createElement("div");
    const strong = document.createElement("strong"); strong.textContent = label;
    const small = document.createElement("small"); small.textContent = `${new Date().toLocaleTimeString()} · ${Math.round(score * 100)}%`;
    text.append(strong, small); card.append(emoji, text);
    box.prepend(card);
    while (box.children.length > 4) box.lastChild.remove();
    const ind = $("#sound-indicator");
    if (ind) { ind.classList.add("alert"); ind.textContent = `${info.emoji} ${label}`; setTimeout(() => ind.classList.remove("alert"), 2500); }
  }
  function updateLevel(rms) {
    const ind = $("#sound-indicator");
    if (ind && !ind.classList.contains("alert")) ind.textContent = `${PUL.t("Listening for important sounds…")} ${"▮".repeat(Math.min(10, Math.round(rms * 60)))}`;
  }

  function resample(data, from, to, outLen) {
    if (from === to && data.length === outLen) return Float32Array.from(data);
    const out = new Float32Array(outLen), ratio = (data.length - 1) / (outLen - 1);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(data.length - 1, i0 + 1), f = pos - i0;
      out[i] = data[i0] * (1 - f) + data[i1] * f;
    }
    return out;
  }

  /* ---- start / stop ---- */
  async function start() {
    if (running || starting) return;
    starting = true;
    const startBtn = $("#start-sound"), stopBtn = $("#stop-sound");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(PUL.t("Microphone access is unavailable."));
      PUL.audio();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      try { ctx = new AudioContext({ sampleRate: 16000 }); } catch (_) { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      if (ctx.state === "suspended") await ctx.resume();
      rawRate = ctx.sampleRate;
      const source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      if (startBtn) startBtn.disabled = true; if (stopBtn) stopBtn.disabled = false;
      setStatus(PUL.t("Loading sound model…"));
      try { if (!model) await loadYamnet(); engine = "yamnet"; } catch (_) { engine = "basic"; }
      await loadCustom();
      if (engine === "yamnet") {
        processor = ctx.createScriptProcessor(4096, 1, 1);
        mute = ctx.createGain(); mute.gain.value = 0;
        processor.onaudioprocess = e => {
          raw.push(...e.inputBuffer.getChannelData(0));
          const max = Math.ceil(rawRate * 1.5); if (raw.length > max) raw = raw.slice(-max);
        };
        source.connect(processor); processor.connect(mute); mute.connect(ctx.destination);
        timer = setInterval(async () => { if (busy) return; busy = true; try { await classifyYamnet(); } catch (e) { console.warn(e); } busy = false; }, 500);
        setStatus(PUL.t("Accurate sound model is running."));
      } else {
        timer = setInterval(() => { try { classifyBasic(); } catch (e) { console.warn(e); } }, 100);
        setStatus(PUL.t("Basic mode: the sound model could not load, so results are less accurate."));
      }
      running = true;
      PUL.say(PUL.t("Sound alerts started."), { silent: true });
      PUL.saveEvent("sound", `Sound identity started (${engine} mode).`, "info");
    } catch (error) {
      setStatus(error.message);
      stop({ quiet: true });
    }
    starting = false;
  }
  function stop({ quiet = false } = {}) {
    clearInterval(timer); timer = null;
    try { processor?.disconnect(); mute?.disconnect(); } catch (_) {}
    stream?.getTracks().forEach(t => t.stop());
    try { ctx?.close(); } catch (_) {}
    stream = ctx = processor = mute = analyser = null; raw = []; frames.length = 0;
    const was = running; running = false;
    const startBtn = $("#start-sound"), stopBtn = $("#stop-sound");
    if (startBtn) startBtn.disabled = false; if (stopBtn) stopBtn.disabled = true;
    const ind = $("#sound-indicator"); if (ind) ind.textContent = PUL.t("Sound monitoring is off.");
    if (was && !quiet) PUL.say(PUL.t("Sound alerts stopped."), { silent: true });
  }
  PUL.sound = { start, stop, capture: captureSeconds, loadCustom, _classifyWindow: classifyWindow, get running() { return running; }, get engine() { return engine; } };
  window.addEventListener("pagehide", () => stop({ quiet: true }));

  /* ---- Teach a Sound ---- */
  const TEACH_PATTERNS = { single: [180], double: [150, 100, 150], triple: [100, 70, 100, 70, 100], long: [650], urgent: [450, 120, 450, 120, 450] };
  async function ensureModel() {
    if (model) return;
    try { await loadYamnet(); } catch (_) { throw new Error("model"); }     // any failure -> one clear message for the user
  }
  async function loadCustom() {
    try {
      const list = await api("/api/custom-sounds");
      customSounds = list.map(c => ({ ...c, vectors: c.embeddings.map(v => l2norm(v)) }));
    } catch (_) { customSounds = []; }
  }
  /* Records `sec` seconds from the microphone and returns 16 kHz mono samples. */
  async function captureSeconds(sec) {
    const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    let c; try { c = new AudioContext({ sampleRate: 16000 }); } catch (_) { c = new (window.AudioContext || window.webkitAudioContext)(); }
    if (c.state === "suspended") await c.resume();
    const src = c.createMediaStreamSource(media), proc = c.createScriptProcessor(4096, 1, 1), quiet = c.createGain();
    quiet.gain.value = 0; const chunks = [];
    proc.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc); proc.connect(quiet); quiet.connect(c.destination);
    await PUL.wait(sec * 1000);
    proc.disconnect(); quiet.disconnect(); media.getTracks().forEach(t => t.stop());
    const rate = c.sampleRate; c.close();
    const flat = new Float32Array(chunks.reduce((n, a) => n + a.length, 0)); let o = 0;
    chunks.forEach(a => { flat.set(a, o); o += a.length; });
    return resample(flat, rate, 16000, Math.round(flat.length * 16000 / rate));
  }
  async function embedWindow(chunk) {
    const input = tf.tensor(chunk); let out;
    try { out = model.predict(input); } finally { input.dispose(); }
    const outs = Array.isArray(out) ? out : [out];
    if (!outs[1]) { outs.forEach(t => t.dispose?.()); throw new Error(PUL.t("The sound model gave no fingerprint. Try again.")); }
    const m = outs[1].rank > 1 ? outs[1].mean(0) : outs[1];
    const d = await m.data();
    if (m !== outs[1]) m.dispose(); outs.forEach(t => t.dispose?.());
    if (d.length !== EMB_DIM) throw new Error(PUL.t("The sound model gave no fingerprint. Try again."));
    return l2norm(d);
  }
  /* Fingerprints of every loud-enough moment (0.975 s windows, 0.5 s apart). */
  async function embedWaveform(wave) {
    const vectors = [], win = 15600, hop = 7800;
    for (let st = 0; st + win <= wave.length; st += hop) {
      const chunk = wave.subarray(st, st + win);
      const rms = Math.sqrt(chunk.reduce((s, x) => s + x * x, 0) / chunk.length);
      if (rms >= 0.01) vectors.push(await embedWindow(chunk));
    }
    return vectors;
  }
  async function finishTeach(name, say) {
    const cal = calibrate(teach.clips);
    if (cal.raw < 0.65) { teach.clips = []; say(PUL.t("The three samples sounded too different. Try again, making the same sound each time.")); return; }
    const vectors = teach.clips.flat().slice(0, 16);
    await api("/api/custom-sounds", { method: "POST", body: JSON.stringify({
      name, emoji: $("#teach-emoji").value, pattern: TEACH_PATTERNS[$("#teach-pattern").value] || TEACH_PATTERNS.double,
      threshold: Math.round(cal.threshold * 100) / 100, embeddings: vectors.map(v => Array.from(v, x => Math.round(x * 1e4) / 1e4)) }) });
    teach.clips = []; $("#teach-name").value = "";
    await loadCustom(); renderCustom();
    say(PUL.t("Saved. Sound alerts are on. Make the sound to test it."));
    PUL.saveEvent("sound", `Taught a new sound: ${name}.`, "info");
    if (!running) start();
  }
  function renderCustom() {
    const list = $("#custom-list"); if (!list) return;
    list.replaceChildren();
    if (!customSounds.length) { const li = document.createElement("li"); li.textContent = PUL.t("No taught sounds yet."); list.append(li); return; }
    customSounds.forEach(cs => {
      const li = document.createElement("li"); li.className = "custom-row";
      const label = document.createElement("span"); label.textContent = `${cs.emoji} ${cs.name}`;
      const range = document.createElement("input"); range.type = "range"; range.min = 60; range.max = 97; range.value = Math.round(cs.threshold * 100);
      range.setAttribute("aria-label", `${PUL.t("Match strictness")}: ${cs.name}`);
      range.addEventListener("change", async () => {
        try { await api(`/api/custom-sounds/${cs.id}`, { method: "PUT", body: JSON.stringify({ threshold: Number(range.value) / 100 }) }); await loadCustom(); }
        catch (e) { PUL.say(e.message, { level: "danger" }); }
      });
      const test = document.createElement("button"); test.type = "button"; test.textContent = PUL.t("Test");
      test.setAttribute("aria-label", `${PUL.t("Test")}: ${cs.name}`);
      test.addEventListener("click", () => PUL.haptic.alert(cs.pattern, { label: cs.name }));
      const del = document.createElement("button"); del.type = "button"; del.className = "del"; del.textContent = PUL.t("Delete");
      del.setAttribute("aria-label", `${PUL.t("Delete")} ${cs.name}`);
      del.addEventListener("click", async () => { await api(`/api/custom-sounds/${cs.id}`, { method: "DELETE" }); await loadCustom(); renderCustom(); });
      li.append(label, range, test, del); list.append(li);
    });
  }
  function teachInit(on) {
    teach = { clips: [], busy: false };
    const record = $("#teach-record"), dots = $("#teach-dots");
    if (!record) return;
    const say = msg => { const el = $("#teach-status"); if (el) el.textContent = msg; PUL.announce(msg); };
    const paint = () => { dots.textContent = "●".repeat(teach.clips.length) + "○".repeat(3 - teach.clips.length); record.textContent = `${PUL.t("Record sample")} ${Math.min(teach.clips.length + 1, 3)} / 3`; };
    paint(); loadCustom().then(renderCustom);
    on(record, "click", async () => {
      if (teach.busy) return;
      const name = $("#teach-name").value.trim();
      if (!name) { say(PUL.t("Type a name for the sound first.")); $("#teach-name").focus(); return; }
      teach.busy = true; record.disabled = true;
      try {
        say(PUL.t("Loading sound model…")); await ensureModel();
        say(PUL.t("Get ready. Make the sound after the beep.")); PUL.audio(); await PUL.wait(900);
        PUL.beep(880, 150); say(PUL.t("Recording…"));
        const wave = await PUL.sound.capture(2.5);
        PUL.beep(660, 120); setTimeout(() => PUL.beep(660, 120), 200);
        const vecs = await embedWaveform(wave);
        if (!vecs.length) say(PUL.t("I could not hear the sound. Move closer and try again."));
        else {
          teach.clips.push(vecs); paint();
          if (teach.clips.length < 3) say(`${PUL.t("Sample saved. Press the button for the next one.")} ${teach.clips.length} / 3`);
          else await finishTeach(name, say);
        }
      } catch (e) {
        say(e.message === "model" || e.message === "classes" ? PUL.t("Teach a Sound needs the sound model, which could not load. Check your internet and try again.") : e.message);
      }
      teach.busy = false; record.disabled = false; paint();
    });
    on($("#teach-reset"), "click", () => { teach.clips = []; paint(); say(PUL.t("Samples cleared.")); });
  }

  /* ---- hearing page: vibration table, toggles, captions ---- */
  function renderPatterns() {
    const body = $("#pattern-rows"); if (!body) return;
    body.replaceChildren();
    Object.entries(PUL.EVENTS).forEach(([key, info]) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td"); name.textContent = `${info.emoji} ${PUL.t(info.label)}`;
      const dots = document.createElement("td"); dots.append(PUL.patternDots(PUL.haptic.pattern(key)));
      const test = document.createElement("td");
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "button button-secondary"; btn.textContent = PUL.t("Test");
      btn.setAttribute("aria-label", `${PUL.t("Test")}: ${PUL.t(info.label)}`);
      btn.addEventListener("click", () => PUL.haptic.alert(key, { label: PUL.t(info.label), red: key === "emergency" }));
      test.append(btn); tr.append(name, dots, test); body.append(tr);
    });
  }

  PUL.pages.hearing = {
    init() {
      uiCleanup = [];
      const on = (el, ev, fn) => { if (!el) return; el.addEventListener(ev, fn); uiCleanup.push(() => el.removeEventListener(ev, fn)); };
      renderPatterns(); teachInit(on);
      const flash = $("#flash-toggle"), vib = $("#vibrate-toggle"), sens = $("#sensitivity");
      if (flash) flash.checked = PUL.opts.flash; if (vib) vib.checked = PUL.opts.vibrate;
      if (sens) sens.value = PUL.store.get("pulanova-sensitivity", "3");
      on(flash, "change", () => { PUL.opts.flash = flash.checked; });
      on(vib, "change", () => { PUL.opts.vibrate = vib.checked; });
      on(sens, "input", () => PUL.store.set("pulanova-sensitivity", sens.value));
      if (!PUL.haptic.supported) { const s = $("#haptic-status"); if (s) s.textContent = PUL.t("Vibration is not available on this device. PULANOVA shows a visual pulse and plays beeps instead."); }
      on($("#start-sound"), "click", start);
      on($("#stop-sound"), "click", () => stop());
      if (running) { $("#start-sound").disabled = true; $("#stop-sound").disabled = false; setStatus(engine === "yamnet" ? PUL.t("Accurate sound model is running.") : PUL.t("Basic mode: the sound model could not load, so results are less accurate.")); }
      on($("#start-captions"), "click", () => this.run("captions"));
      on($("#stop-captions"), "click", () => this.run("captions-stop"));
      const act = PUL.takeAction(); if (act) this.run(act.name, act.args);
    },
    run(action) {
      if (action === "sound") return start();
      if (action === "sound-stop") return stop();
      if (action === "teach") { const el = $("#teach-name"); el?.scrollIntoView?.({ behavior: "smooth" }); return el?.focus(); }
      if (action === "captions") return PUL.captionsPage?.start();
      if (action === "captions-stop") return PUL.captionsPage?.stop();
    },
    refresh() { renderPatterns(); renderCustom(); },
    destroy() { PUL.captionsPage?.stop(); uiCleanup.forEach(fn => fn()); uiCleanup = []; },   // sound alerts keep running
  };
})();
