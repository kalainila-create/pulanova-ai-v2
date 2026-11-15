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
window.PUL_soundTest = { categorize, parseClassMap, basicClassify };   // exposed for tests

(() => {
  let stream = null, ctx = null, processor = null, mute = null, analyser = null;
  let model = null, classNames = null, engine = null;
  let raw = [], rawRate = 16000, timer = null, busy = false, running = false, starting = false;
  const streak = {}, lastFire = {}, frames = [];
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
    const window16 = resample(raw.slice(-need), rawRate, 16000, 15600);
    const rms = Math.sqrt(window16.reduce((s, x) => s + x * x, 0) / window16.length);
    updateLevel(rms);
    if (rms < 0.004) { Object.keys(streak).forEach(k => streak[k] = 0); return; }
    const input = tf.tensor(window16);
    let out;
    try { out = model.predict(input); } finally { input.dispose(); }
    const scoresT = Array.isArray(out) ? out[0] : (out.scores || out);
    const mean = scoresT.rank > 1 ? scoresT.max(0) : scoresT;
    const scores = await mean.data();
    (Array.isArray(out) ? out : [out]).forEach(t => t.dispose?.()); if (mean !== scoresT) mean.dispose();
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
  PUL.sound = { start, stop, get running() { return running; }, get engine() { return engine; } };
  window.addEventListener("pagehide", () => stop({ quiet: true }));

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
      renderPatterns();
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
      if (action === "captions") return PUL.captionsPage?.start();
      if (action === "captions-stop") return PUL.captionsPage?.stop();
    },
    refresh() { renderPatterns(); },
    destroy() { PUL.captionsPage?.stop(); uiCleanup.forEach(fn => fn()); uiCleanup = []; },   // sound alerts keep running
  };
})();
