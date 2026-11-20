"use strict";
/* Voice-first navigation. Recognition keeps running across page changes because
   pages are swapped in place (see PUL.go in core.js). */

const PAGE_URL = { home: "/", visual: "/visual", hearing: "/hearing", bridge: "/bridge",
  tactile: "/tactile", emergency: "/emergency", profiles: "/profiles", dashboard: "/dashboard", about: "/about" };

(() => {
  let recognition = null, paused = false, held = false, restarting = false, lastUnknown = 0;
  const SpeechCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  PUL.speechSupported = !!SpeechCtor;
  PUL.recognizer = (lang) => { const r = new SpeechCtor(); r.lang = lang; return r; };

  /* Run a feature on a page; if we are elsewhere, open the page first and run it there. */
  PUL.request = (page, action, args = {}) => {
    if (PUL.current === page && PUL.pages[page]?.run) return PUL.pages[page].run(action, args);
    PUL.queue(action, args);
    PUL.quietNav = true;                 // the command already confirmed what is happening; do not read the page out again
    return PUL.go(PAGE_URL[page]);
  };
  const openPage = (name, msg) => { PUL.tsay(msg); if (PUL.current !== name) { PUL.quietNav = true; PUL.go(PAGE_URL[name]); } };

  /* ---- command table: phrases are matched with String.includes on normalised text ---- */
  const C = [];
  const cmd = (en, ta, run) => C.push({ en, ta, run });

  cmd(["stop voice", "stop listening", "voice off", "turn off voice"], ["குரலை நிறுத்து", "கேட்பதை நிறுத்து"], () => PUL.voice.stop());
  cmd(["cancel", "never mind"], ["ரத்து", "வேண்டாம்"], () => {
    if (PUL.emergency?.active) PUL.emergency.cancel(); else PUL.tsay("Emergency cancelled.", { silent: true });
  });
  cmd(["stop reading", "be quiet", "stop talking", "silence"], ["வாசிப்பதை நிறுத்து", "நிறுத்து படிப்பதை"], () => { PUL.vision?.stopReading(); speechSynthesis?.cancel(); PUL.tsay("Reading stopped.", { silent: true }); });
  cmd(["open emergency", "emergency page"], ["அவசரப் பக்கம்"], () => openPage("emergency", "Opening emergency page."));
  cmd(["emergency", "help me", "sos", "i need help"], ["அவசரம்", "உதவி தேவை", "காப்பாற்று"], () => {
    PUL.tsay("Starting emergency. Say cancel to stop.", { assertive: true });
    PUL.request("emergency", "sos");
  });
  cmd(["expiry date", "expiry", "expire", "best before", "read date", "read the date", "use by"], ["காலாவதி தேதி", "காலாவதி"], () => { PUL.tsay("Looking for the date…"); PUL.request("visual", "date"); });
  cmd(["flashlight", "torch", "turn on the light"], ["டார்ச்", "விளக்கு"], () => PUL.request("visual", "torch"));
  cmd(["read text", "read this", "read the text", "read it"], ["உரையைப் படி", "உரையை படி", "படி"], () => { PUL.tsay("Reading text. Hold the page steady."); PUL.request("visual", "text"); });
  cmd(["identify surroundings", "describe surroundings", "what is around", "what's around", "identify objects", "what is in front"],
      ["சுற்றுப்புறத்தை அடையாளம்", "சுற்றுப்புறம்", "பொருட்களை அடையாளம்"], () => { PUL.tsay("Starting object identification."); PUL.request("visual", "identify"); });
  cmd(["currency", "check note", "identify note", "check money", "rupee note", "how much is this"], ["நாணயம்", "நோட்டு", "ரூபாய்"],
      () => { PUL.tsay("Checking the note. Hold it flat in the middle of the camera."); PUL.request("visual", "currency"); });
  cmd(["stop finding", "stop search"], ["தேடலை நிறுத்து"], () => PUL.vision?.stopFind());
  cmd(["stop camera", "close camera"], ["கேமராவை நிறுத்து", "கேமராவை மூடு"], () => PUL.vision?.stopCamera());
  cmd(["open camera", "start camera"], ["கேமராவைத் திற", "கேமராவைத் தொடங்கு", "கேமரா திற"], () => { PUL.tsay("Starting camera."); PUL.request("visual", "camera"); });
  cmd(["teach a sound", "teach sound", "learn a sound", "teach new sound"], ["ஒலியைக் கற்றுக்கொடு"], () => { PUL.tsay("Opening Teach a Sound."); PUL.request("hearing", "teach"); });
  cmd(["stop sound", "stop alerts"], ["ஒலி எச்சரிக்கையை நிறுத்து"], () => PUL.request("hearing", "sound-stop"));
  cmd(["start sound", "sound alerts", "listen for sounds", "sound identity"], ["ஒலி எச்சரிக்கை", "ஒலி அடையாளம்"], () => { PUL.tsay("Sound alerts started."); PUL.request("hearing", "sound"); });
  cmd(["stop captions"], ["வசனங்களை நிறுத்து"], () => PUL.request("hearing", "captions-stop"));
  cmd(["start captions", "captions", "subtitles"], ["வசனங்கள்", "வசனம்"], () => { PUL.tsay("Captions started."); PUL.request("hearing", "captions"); });
  cmd(["conversation", "talk to someone", "talk with someone"], ["உரையாடல்"], () => { PUL.tsay("Opening conversation bridge."); PUL.request("bridge", "listen"); });
  cmd(["open home", "go home", "home page", "home"], ["முகப்பு"], () => openPage("home", "Opening home."));
  cmd(["open visual", "visual support", "visual"], ["பார்வை ஆதரவு", "பார்வை"], () => openPage("visual", "Opening visual support."));
  cmd(["open hearing", "hearing support", "hearing"], ["கேள்வி ஆதரவு", "கேள்வி"], () => openPage("hearing", "Opening hearing support."));
  cmd(["open tactile", "tactile tools", "tactile"], ["தொடு கருவிகள்", "தொடு"], () => openPage("tactile", "Opening tactile tools."));
  cmd(["open profiles", "my profiles", "profiles", "profile"], ["சுயவிவரங்கள்", "சுயவிவரம்"], () => openPage("profiles", "Opening profiles."));
  cmd(["open dashboard", "dashboard"], ["கட்டுப்பாட்டுப் பலகை", "பலகை"], () => openPage("dashboard", "Opening dashboard."));
  cmd(["open about", "about page", "about"], ["திட்டம் பற்றி"], () => openPage("about", "Opening about page."));
  cmd(["go back", "back"], ["பின்செல்", "திரும்பிச் செல்", "பின்னால்"], () => { PUL.tsay("Going back."); history.length > 1 ? history.back() : PUL.go("/"); });
  cmd(["repeat", "say again", "where am i"], ["மீண்டும் கூறு", "மீண்டும்"], () => PUL.announcePage({ full: true }));
  cmd(["help", "what can i say", "commands"], ["உதவி", "கட்டளைகள்"], () => PUL.tsay("Say open home, visual, hearing, conversation, tactile, emergency, profiles or dashboard. Say identify surroundings, read text, stop reading, find my bag, check currency, start sound alerts, start captions, go back, repeat, or emergency."));

  const normalise = s => s.toLowerCase().replace(/[.,!?'’"]/g, " ").replace(/\s+/g, " ").trim();

  async function switchProfile(name) {
    try {
      const list = await api("/api/profiles");
      const wanted = name.toLowerCase();
      const hit = list.find(p => p.name.toLowerCase().includes(wanted));
      if (!hit) return PUL.tsay("I did not recognise that command. Say help for the command list.");
      const profile = await api(`/api/profiles/${hit.id}/activate`, { method: "POST" });
      PUL.applyProfile(profile, { resetLocal: true });
      PUL.say(`${PUL.t("Profile activated:")} ${PUL.t(profile.name)}`);
    } catch (e) { PUL.say(e.message, { level: "danger" }); }
  }

  function handle(raw) {
    const text = normalise(raw);
    if (!text) return;
    PUL.toast(`🎙️ ${raw}`);
    // "find my bag" / "என் பையைக் கண்டுபிடி"
    let m = text.match(/^(?:please )?find (?:my |the |a |an )?(.+)$/);
    if (!m) { const t = raw.trim().match(/^(.+?)\s*(?:கண்டுபிடி|தேடு)/); if (t) m = [null, t[1]]; }
    if (m) {
      const target = PUL.vision?.resolveTarget(m[1]);
      if (!target) return PUL.tsay("That object cannot be found by the camera. Try bag, phone, bottle, cup, laptop or book.");
      PUL.tsay("Looking for"); PUL.request("visual", "find", { target });
      return;
    }
    m = text.match(/^(?:switch to|use|activate) (.+?)(?: profile)?$/);
    if (m) return switchProfile(m[1]);

    const ta = PUL.lang() === "ta";
    const hit = C.find(c => [...c.en, ...c.ta].some(p => text.includes(p.toLowerCase())) || (ta && c.ta.some(p => raw.includes(p))));
    if (hit) return hit.run(text);
    if (text.split(" ").length <= 4 && Date.now() - lastUnknown > 15000) {
      lastUnknown = Date.now();
      PUL.tsay("I did not recognise that command. Say help for the command list.");
    }
  }

  /* ---- recognition lifecycle ---- */
  function setButtons(on) {
    const start = $("#global-voice-start"), stop = $("#global-voice-stop");
    if (start) { start.setAttribute("aria-pressed", String(on)); start.classList.toggle("listening", on); }
    if (stop) stop.disabled = !on;
  }
  function begin() {
    recognition = new SpeechCtor();
    const r = recognition;
    r.lang = PUL.speechLang(); r.continuous = true; r.interimResults = false;
    r.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) handle(e.results[i][0].transcript); };
    r.onerror = e => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { PUL.voice.stop({ quiet: true }); PUL.say("Microphone permission is needed for voice commands.", { level: "caution" }); return; }
      PUL.toast(`Voice: ${e.error}`, "caution");
    };
    r.onend = () => {
      if (!PUL.voice.active || recognition !== r || paused || held || restarting) return;
      restarting = true;
      setTimeout(() => { restarting = false; if (PUL.voice.active && recognition === r && !paused && !held) { try { r.start(); } catch (_) {} } }, 350);
    };
    r.start();
  }

  PUL.voice = {
    active: false,
    start({ quiet = false } = {}) {
      if (!SpeechCtor) { PUL.say(PUL.t("Voice navigation is not supported in this browser."), { level: "caution" }); return false; }
      if (this.active) return true;
      try { begin(); } catch (e) { PUL.say(e.message, { level: "danger" }); return false; }
      this.active = true; setButtons(true);
      PUL.store.set("pulanova-voice", "1");
      if (!quiet) PUL.say(PUL.t("Voice navigation started. Say help to hear the commands."));
      return true;
    },
    stop({ quiet = false } = {}) {
      const was = this.active;
      this.active = false; paused = false; setButtons(false);
      try { recognition?.stop(); } catch (_) {}
      recognition = null;
      PUL.store.del("pulanova-voice");
      if (was && !quiet) PUL.say(PUL.t("Voice navigation stopped."), { silent: true });
    },
    toggle() { this.active ? this.stop() : this.start(); },
    /* Browsers allow one speech recogniser at a time: captions and the conversation bridge
       hold voice navigation while they listen, then release it. */
    hold() { if (!this.active || held) return; held = true; try { recognition?.stop(); } catch (_) {} },
    release() {
      if (!held) return; held = false;
      setTimeout(() => { if (this.active && !held && recognition) { try { recognition.start(); } catch (_) {} } }, 400);
    },
    boot() {
      $("#global-voice-start")?.addEventListener("click", () => PUL.voice.start());
      $("#global-voice-stop")?.addEventListener("click", () => PUL.voice.stop());
      $("#repeat-guidance")?.addEventListener("click", () => PUL.announcePage({ full: true }));
      $("#language-select")?.addEventListener("change", () => { if (this.active) { this.stop({ quiet: true }); setTimeout(() => this.start({ quiet: true }), 300); } });
      window.addEventListener("keydown", e => {
        if (e.altKey && e.code === "KeyV") { e.preventDefault(); this.toggle(); }
        else if (e.altKey && e.code === "KeyR") { e.preventDefault(); PUL.announcePage({ full: true }); }
        else if (e.altKey && e.code === "KeyE") { e.preventDefault(); handle("emergency"); }
        else if (e.key === "Escape" && PUL.emergency?.active) PUL.emergency.cancel();
      });
      window.addEventListener("pagehide", () => { recognition?.abort?.(); speechSynthesis?.cancel(); });
      $("#hero-voice")?.addEventListener("click", () => PUL.voice.start());

      // Voice-first gate: browsers need one tap/Enter before speech can start.
      const gate = $("#voice-gate");
      const done = () => { gate.hidden = true; sessionStorage.setItem("pulanova-gate", "1"); $("#main")?.focus(); };
      $("#gate-start")?.addEventListener("click", () => { done(); this.start({ quiet: true }); PUL.say(PUL.t("Voice assistant ready. Say help to hear the commands."), { silent: false }); });
      $("#gate-skip")?.addEventListener("click", done);
      gate?.addEventListener("keydown", e => { if (e.key === "Escape") done(); });
      let seen = false; try { seen = sessionStorage.getItem("pulanova-gate") === "1"; } catch (_) {}
      if (PUL.settings().voiceFirst && !seen && gate) { gate.hidden = false; $("#gate-start")?.focus(); PUL.speak(PUL.t("Welcome to PULANOVA") + ". " + PUL.t("Press Enter or tap the big button to start the voice assistant. Press Escape to skip."), { force: true }); }
      else if (PUL.store.get("pulanova-voice") === "1" && SpeechCtor) this.start({ quiet: true });  // after a full reload
    },
  };

  /* Pause the microphone while PULANOVA speaks, so it does not hear itself. */
  const baseSpeak = PUL.speak;
  PUL.speak = async (text, opts = {}) => {
    const willSpeak = PUL.voice.active && recognition && (opts.force || PUL.speechOn());
    if (willSpeak) { paused = true; try { recognition.stop(); } catch (_) {} }
    const result = await baseSpeak(text, opts);
    if (willSpeak) {
      paused = false;
      setTimeout(() => { if (PUL.voice.active && !paused && !held && recognition) { try { recognition.start(); } catch (_) {} } }, 250);
    }
    return result;
  };
})();
