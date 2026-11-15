"use strict";
/* Smart Haptic Alert System, Morse, Braille and the Tactile page. */

PUL.EVENTS = {
  doorbell:  { emoji: "🔔", label: "Doorbell", severity: "info" },
  horn:      { emoji: "🚗", label: "Vehicle horn", severity: "caution" },
  emergency: { emoji: "🚨", label: "Emergency sound", severity: "danger" },
  speech:    { emoji: "🗣️", label: "Speech", severity: "info" },
  knock:     { emoji: "🚪", label: "Knock", severity: "info" },
  phone:     { emoji: "📞", label: "Phone ringing", severity: "info" },
  dog:       { emoji: "🐕", label: "Dog bark", severity: "info" },
  baby:      { emoji: "👶", label: "Baby crying", severity: "caution" },
};
const DEFAULT_PATTERNS = {
  doorbell: [150, 100, 150], horn: [100, 70, 100, 70, 100],
  emergency: [450, 120, 450, 120, 450, 120, 450], speech: [650],
  knock: [90, 60, 90, 60, 90, 60, 90], phone: [250, 150, 250, 150, 250],
  alarm: [450, 120, 450, 120, 450, 120, 450], dog: [120, 80, 320], baby: [320, 80, 120], ok: [90, 60, 90],
};
const NAV_SIGNALS = {
  forward: { label: "Forward", pattern: [200] },
  left:    { label: "Turn left", pattern: [120, 100, 120] },
  right:   { label: "Turn right", pattern: [120, 100, 120, 100, 120] },
  stop:    { label: "Stop", pattern: [900] },
  around:  { label: "Turn around", pattern: [400, 150, 120, 150, 400] },
};

PUL.NAV = NAV_SIGNALS;

/* ---------- audio helper (beeps, used when the phone cannot vibrate) ---------- */
let audioCtx = null;
PUL.audio = () => {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (_) { audioCtx = null; }
  return audioCtx;
};
PUL.beep = (freq = 660, ms = 120, volume = 0.18) => {
  const ctx = PUL.audio(); if (!ctx) return;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.frequency.value = freq; osc.type = "sine";
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start(); osc.stop(ctx.currentTime + ms / 1000 + 0.02);
};

/* ---------- screen flash ---------- */
PUL.flash = ({ red = false } = {}) => {
  if (!PUL.opts.flash) return;
  const el = $("#flash-overlay"); if (!el) return;
  el.classList.toggle("red", red);
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1100);
};

/* ---------- haptic engine ---------- */
const isMobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad/i.test(navigator.userAgent);
const canVibrate = "vibrate" in navigator && isMobile;
let hapticToken = 0, hapticTimers = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
PUL.wait = wait;

PUL.haptic = {
  supported: canVibrate,
  pattern(key) { return PUL.settings().patterns?.[key] || DEFAULT_PATTERNS[key] || [200]; },
  /* Plays a pattern (array of ms) or a pattern key. Resolves when finished. */
  async play(patternOrKey, { repeat = 1, gap = 600, label = "" } = {}) {
    const pattern = Array.isArray(patternOrKey) ? patternOrKey : this.pattern(patternOrKey);
    const token = ++hapticToken;
    this._clear();
    const ind = $("#haptic-indicator");
    if (ind) { ind.classList.add("on"); $("#haptic-label").textContent = label || (canVibrate ? PUL.t("Vibration") : PUL.t("Vibration") + " ·"); }
    for (let r = 0; r < repeat; r++) {
      if (token !== hapticToken) return false;
      if (PUL.opts.vibrate && canVibrate) { try { navigator.vibrate(pattern); } catch (_) {} }
      let t = 0;
      pattern.forEach((ms, i) => {
        if (i % 2 === 0) {
          hapticTimers.push(setTimeout(() => { ind?.classList.add("buzz");
            if (!canVibrate && PUL.opts.beep) PUL.beep(520, Math.min(ms, 400)); }, t));
          hapticTimers.push(setTimeout(() => ind?.classList.remove("buzz"), t + ms));
        }
        t += ms;
      });
      await wait(t + (r < repeat - 1 ? gap : 0));
    }
    if (token === hapticToken) { ind?.classList.remove("buzz", "on"); }
    return token === hapticToken;
  },
  _clear() { hapticTimers.forEach(clearTimeout); hapticTimers = []; },
  stop() {
    hapticToken++; this._clear();
    try { navigator.vibrate?.(0); } catch (_) {}
    $("#haptic-indicator")?.classList.remove("buzz", "on");
  },
  /* A full alert: vibration + flash + toast, using the user's own pattern for this event. */
  alert(key, { label, repeat = 1, red = false } = {}) {
    PUL.flash({ red });
    return this.play(key, { repeat, label });
  },
};

/* Draw a vibration pattern as dots and dashes. */
PUL.patternDots = pattern => {
  const wrap = document.createElement("span");
  wrap.className = "dots"; wrap.setAttribute("aria-hidden", "true");
  pattern.forEach((ms, i) => {
    const bar = document.createElement("i");
    bar.style.width = `${Math.max(8, Math.round(ms / 12))}px`;
    if (i % 2) bar.className = "gap";
    wrap.append(bar);
  });
  return wrap;
};
PUL.describePattern = pattern => pattern.join(", ");

/* ---------- save settings to the active profile ---------- */
PUL.saveSettings = async patch => {
  const settings = { ...PUL.settings(), ...patch };
  const profile = await api(`/api/profiles/${PUL.profile.id}`, {
    method: "PUT", body: JSON.stringify({ name: PUL.profile.name, settings }),
  });
  PUL.applyProfile(profile);
  return profile;
};

/* ---------- Morse code ---------- */
const MORSE = {
  A:".-",B:"-...",C:"-.-.",D:"-..",E:".",F:"..-.",G:"--.",H:"....",I:"..",J:".---",K:"-.-",L:".-..",M:"--",
  N:"-.",O:"---",P:".--.",Q:"--.-",R:".-.",S:"...",T:"-",U:"..-",V:"...-",W:".--",X:"-..-",Y:"-.--",Z:"--..",
  0:"-----",1:".----",2:"..---",3:"...--",4:"....-",5:".....",6:"-....",7:"--...",8:"---..",9:"----.",
  ".":".-.-.-",",":"--..--","?":"..--..","!":"-.-.--","/":"-..-."
};
PUL.morse = {
  encode(text) {
    return text.toUpperCase().split(" ").map(word =>
      [...word].map(ch => MORSE[ch]).filter(Boolean).join(" ")).filter(Boolean).join(" / ");
  },
  async play(text) {
    const DOT = 150, DASH = 450, GAP = 150, LETTER = 450, WORD = 1050;
    const token = ++hapticToken + 0.5; // distinct from haptic.play tokens
    const words = text.toUpperCase().trim().split(/\s+/);
    PUL.morse._run = token;
    for (let w = 0; w < words.length; w++) {
      for (const ch of words[w]) {
        const code = MORSE[ch]; if (!code) continue;
        if (PUL.morse._run !== token) return;
        const pattern = [];
        [...code].forEach((sym, i) => { if (i) pattern.push(GAP); pattern.push(sym === "." ? DOT : DASH); });
        // pattern alternates on/off only if we insert gaps between: pattern is [on, gap, on, gap, on]
        await PUL.haptic.play(pattern, { label: ch });
        await wait(LETTER);
      }
      await wait(WORD - LETTER);
    }
  },
  stop() { PUL.morse._run = 0; PUL.haptic.stop(); },
};

/* ---------- Braille (English uncontracted, Unicode dots) ---------- */
(() => {
  const cell = dots => String.fromCharCode(0x2800 + [...dots].reduce((s, d) => s + (1 << (Number(d) - 1)), 0));
  const letters = { a:"1",b:"12",c:"14",d:"145",e:"15",f:"124",g:"1245",h:"125",i:"24",j:"245",k:"13",l:"123",m:"134",
    n:"1345",o:"135",p:"1234",q:"12345",r:"1235",s:"234",t:"2345",u:"136",v:"1236",w:"2456",x:"1346",y:"13456",z:"1356" };
  const punct = { ",":"2", ";":"23", ":":"25", ".":"256", "!":"235", "?":"236", "-":"36", "'":"3", "(":"2356", ")":"2356", "/":"34", "\"":"236" };
  const digitLetter = "jabcdefghi";            // 0 -> j, 1 -> a ...
  PUL.braille = {
    toBraille(text) {
      let out = "", inNumber = false;
      for (const ch of String(text)) {
        if (/[0-9]/.test(ch)) {
          if (!inNumber) { out += cell("3456"); inNumber = true; }
          out += cell(letters[digitLetter[Number(ch)]]);
          continue;
        }
        inNumber = false;
        const lower = ch.toLowerCase();
        if (letters[lower] && /[a-zA-Z]/.test(ch)) {
          if (ch !== lower) out += cell("6");
          out += cell(letters[lower]);
        } else if (punct[ch]) out += cell(punct[ch]);
        else if (/\s/.test(ch)) out += "\u2800";
        else out += ch;
      }
      return out;
    },
  };
})();

/* ---------- Tactile page ---------- */
(() => {
  let cleanup = [];
  const on = (el, ev, fn, opts) => { if (!el) return; el.addEventListener(ev, fn, opts); cleanup.push(() => el.removeEventListener(ev, fn, opts)); };

  const makeTile = (emoji, label, pattern, onclick) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tile";
    const icon = document.createElement("span"); icon.className = "tile-icon"; icon.setAttribute("aria-hidden", "true"); icon.textContent = emoji;
    const strong = document.createElement("strong"); strong.textContent = label;
    b.append(icon, strong, PUL.patternDots(pattern));
    b.setAttribute("aria-label", `${label}. ${PUL.t("Test")}`);
    on(b, "click", onclick);
    return b;
  };

  function renderTiles() {
    const box = $("#tactile-buttons"); if (!box) return;
    box.replaceChildren();
    ["doorbell", "horn", "emergency", "speech", "knock", "phone"].forEach(key => {
      const info = PUL.EVENTS[key], label = PUL.t(info.label), pattern = PUL.haptic.pattern(key);
      box.append(makeTile(info.emoji, label, pattern, () => { PUL.haptic.alert(key, { label, red: key === "emergency" }); $("#tactile-status").textContent = `${label}: ${PUL.describePattern(pattern)}`; }));
    });
    (PUL.settings().tactileMessages || []).forEach(m =>
      box.append(makeTile("💬", m.label, m.pattern, () => PUL.haptic.play(m.pattern, { label: m.label }))));
    const nav = $("#nav-buttons"); nav.replaceChildren();
    const legend = $("#nav-legend"); legend.replaceChildren();
    const icons = { forward: "⬆️", left: "⬅️", right: "➡️", stop: "✋", around: "🔄" };
    Object.entries(NAV_SIGNALS).forEach(([key, sig]) => {
      const label = PUL.t(sig.label);
      nav.append(makeTile(icons[key], label, sig.pattern, () => { PUL.haptic.play(sig.pattern, { label }); PUL.announce(label); }));
      const li = document.createElement("li"); li.textContent = `${label}: ${PUL.describePattern(sig.pattern)}`; legend.append(li);
    });
    renderSaved();
  }

  function renderSaved() {
    const list = $("#tactile-list"); if (!list) return;
    list.replaceChildren();
    (PUL.settings().tactileMessages || []).forEach((m, index) => {
      const li = document.createElement("li");
      const span = document.createElement("span"); span.textContent = `${m.label} · ${PUL.describePattern(m.pattern)}`;
      const del = document.createElement("button"); del.type = "button"; del.className = "del"; del.textContent = PUL.t("Delete");
      del.setAttribute("aria-label", `${PUL.t("Delete")} ${m.label}`);
      del.addEventListener("click", async () => {
        const msgs = (PUL.settings().tactileMessages || []).filter((_, i) => i !== index);
        await PUL.saveSettings({ tactileMessages: msgs }); renderTiles();
      });
      li.append(span, del); list.append(li);
    });
  }

  /* tap-rhythm recorder */
  let tapPattern = [], downAt = 0, upAt = 0;
  function setupTapPad() {
    const pad = $("#tap-pad"); if (!pad) return;
    const readout = $("#tap-readout");
    const show = () => { readout.textContent = tapPattern.length ? `${PUL.t("Pattern")}: ${PUL.describePattern(tapPattern)}` : ""; };
    on(pad, "pointerdown", e => {
      e.preventDefault(); pad.setPointerCapture?.(e.pointerId);
      const now = performance.now();
      if (upAt && tapPattern.length < 23) tapPattern.push(Math.max(60, Math.min(1000, Math.round(now - upAt))));
      downAt = now; pad.classList.add("down");
    });
    on(pad, "pointerup", () => {
      if (!downAt) return;
      const now = performance.now();
      if (tapPattern.length < 24) tapPattern.push(Math.max(60, Math.min(1500, Math.round(now - downAt))));
      upAt = now; downAt = 0; pad.classList.remove("down"); show();
    });
    on(pad, "pointercancel", () => { downAt = 0; pad.classList.remove("down"); });
    on(pad, "keydown", e => { if (e.key === "Enter" || e.key === " ") {   // keyboard users: a fixed short tap
      e.preventDefault(); if (tapPattern.length && tapPattern.length % 2 === 1) tapPattern.push(150);
      if (tapPattern.length < 24) tapPattern.push(150); show(); } });
    on($("#tap-play"), "click", () => tapPattern.length ? PUL.haptic.play(tapPattern, { label: PUL.t("Play rhythm") }) : PUL.say(PUL.t("Tap a rhythm first."), { silent: true }));
    on($("#tap-reset"), "click", () => { tapPattern = []; downAt = upAt = 0; show(); });
    on($("#tactile-form"), "submit", async e => {
      e.preventDefault();
      if (!tapPattern.length) { PUL.say(PUL.t("Tap a rhythm first."), { silent: true }); return; }
      const label = $("#tactile-label").value.trim(); if (!label) return;
      let pattern = tapPattern.slice(); if (pattern.length % 2 === 0) pattern.pop(); // end on a vibration
      const msgs = [...(PUL.settings().tactileMessages || []), { label, pattern }];
      try {
        await PUL.saveSettings({ tactileMessages: msgs });
        PUL.say(PUL.t("Tactile message saved."), { silent: false });
        tapPattern = []; upAt = 0; show(); e.target.reset(); renderTiles();
      } catch (err) { PUL.say(err.message, { level: "danger" }); }
    });
  }

  function setupMorse() {
    const input = $("#morse-text"), view = $("#morse-view");
    const refresh = () => { view.textContent = PUL.morse.encode(input.value); };
    on(input, "input", refresh); refresh();
    on($("#morse-play"), "click", () => PUL.morse.play(input.value));
    on($("#morse-stop"), "click", () => PUL.morse.stop());
  }

  function setupBraille() {
    const input = $("#braille-in"), out = $("#braille-out");
    const refresh = () => { out.textContent = PUL.braille.toBraille(input.value); };
    on(input, "input", refresh); refresh();
    on($("#braille-copy"), "click", async () => {
      try { await navigator.clipboard.writeText(out.textContent); PUL.say(PUL.t("Braille copied."), { silent: true }); } catch (_) {}
    });
    const mode = $("#braille-mode"); mode.checked = !!PUL.settings().brailleMode;
    on(mode, "change", async () => { try { await PUL.saveSettings({ brailleMode: mode.checked }); } catch (e) { PUL.say(e.message, { level: "danger" }); } });
  }

  PUL.pages.tactile = {
    init() { cleanup = []; renderTiles(); setupTapPad(); setupMorse(); setupBraille(); },
    refresh() { renderTiles(); },
    destroy() { PUL.morse.stop(); PUL.haptic.stop(); cleanup.forEach(fn => fn()); cleanup = []; },
  };
})();
