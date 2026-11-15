"use strict";
/* Live captions (hearing page) and the Conversation Bridge. */

/* A small wrapper around SpeechRecognition used by both pages. */
PUL.captioner = ({ lang, onInterim, onFinal, onState }) => {
  let rec = null, active = false;
  const start = () => {
    if (!PUL.speechSupported) { onState?.("unsupported"); return false; }
    if (active) return true;
    PUL.voice?.hold();                       // only one recogniser may run at a time
    rec = PUL.recognizer(typeof lang === "function" ? lang() : lang);
    rec.continuous = true; rec.interimResults = true;
    rec.onresult = e => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript;
        if (e.results[i].isFinal) onFinal?.(text.trim()); else interim += text;
      }
      onInterim?.(interim);
    };
    rec.onerror = e => { if (e.error !== "no-speech" && e.error !== "aborted") onState?.("error:" + e.error); };
    rec.onend = () => { if (active) { try { rec.start(); } catch (_) {} } };   // keep listening
    try { rec.start(); active = true; onState?.("listening"); return true; }
    catch (e) { onState?.("error:" + e.message); PUL.voice?.release(); return false; }
  };
  const stop = () => {
    const was = active; active = false;
    try { rec?.stop(); } catch (_) {} rec = null;
    if (was) { PUL.voice?.release(); onState?.("stopped"); }
  };
  return { start, stop, get active() { return active; } };
};

/* ---------- Hearing page captions ---------- */
(() => {
  let cap = null, finalText = "";
  PUL.captionsPage = {
    start() {
      const out = $("#caption-output"), status = $("#caption-status");
      if (!out) return;
      finalText = "";
      cap = cap || PUL.captioner({
        lang: () => PUL.speechLang(),
        onInterim: text => { out.textContent = (finalText + " " + text).trim().slice(-600) || PUL.t("Listening…"); },
        onFinal: text => {
          finalText = (finalText + " " + text).trim().slice(-600); out.textContent = finalText;
          if ($("#vibrate-toggle")?.checked !== false && PUL.opts.vibrate) PUL.haptic.play("speech", { label: PUL.t("Speech") });
        },
        onState: s => {
          if (!status) return;
          if (s === "listening") { status.textContent = PUL.t("Listening…"); $("#start-captions").disabled = true; $("#stop-captions").disabled = false; }
          else if (s === "stopped") { status.textContent = PUL.t("Captions are stopped."); $("#start-captions").disabled = false; $("#stop-captions").disabled = true; }
          else status.textContent = s === "unsupported" ? PUL.t("Speech recognition is not supported in this browser.") : s;
        },
      });
      cap.start();
    },
    stop() { cap?.stop(); },
  };
})();

/* ---------- Conversation Bridge ---------- */
(() => {
  let cap = null, cleanup = [], log = [];
  const QUICK = ["Yes", "No", "Please repeat", "Please speak slowly", "Thank you", "I am deaf. Please type or write.", "Please wait", "Help me please"];

  function addMessage(who, text) {
    if (!text) return;
    log.push({ who, text, time: new Date().toLocaleTimeString() });
    const box = $("#chat-log"); if (!box) return;
    const div = document.createElement("div");
    div.className = `chat-msg ${who}`;
    const label = document.createElement("small"); label.textContent = who === "them" ? PUL.t("Them") : PUL.t("Me");
    div.append(label, document.createTextNode(text));
    box.append(div); box.scrollTop = box.scrollHeight;
  }
  async function sayReply(text) {
    addMessage("me", text);
    PUL.announce(text, { short: text });
    await PUL.speak(text, { lang: $("#reply-lang").value, force: true, rate: 0.95 });
  }

  function listen() {
    const status = $("#bridge-status");
    cap = cap || PUL.captioner({
      lang: () => $("#bridge-lang").value,
      onInterim: text => { const el = $("#interim"); if (el) el.textContent = text; },
      onFinal: text => {
        const el = $("#interim"); if (el) el.textContent = "";
        addMessage("them", text);
        PUL.announce(text, { short: text });
        if ($("#bridge-vibrate")?.checked) PUL.haptic.play("speech", { label: PUL.t("Speech") });
      },
      onState: s => {
        if (!status) return;
        if (s === "listening") { status.textContent = PUL.t("Listening…"); $("#bridge-start").disabled = true; $("#bridge-stop").disabled = false; }
        else if (s === "stopped") { status.textContent = PUL.t("Not listening."); $("#bridge-start").disabled = false; $("#bridge-stop").disabled = true; }
        else status.textContent = s === "unsupported" ? PUL.t("Speech recognition is not supported in this browser.") : s;
      },
    });
    cap.start();
  }

  PUL.pages.bridge = {
    init() {
      cleanup = [];
      const on = (el, ev, fn) => { if (!el) return; el.addEventListener(ev, fn); cleanup.push(() => el.removeEventListener(ev, fn)); };
      const speakLang = PUL.lang() === "ta" ? "ta-IN" : "en-IN";
      $("#bridge-lang").value = speakLang; $("#reply-lang").value = speakLang;
      renderQuick();
      log = []; $("#chat-log").replaceChildren();
      on($("#reply-form"), "submit", e => { e.preventDefault(); const input = $("#reply-text"); const text = input.value.trim(); input.value = ""; if (text) sayReply(text); });
      on($("#bridge-start"), "click", listen);
      on($("#bridge-stop"), "click", () => cap?.stop());
      on($("#bridge-lang"), "change", () => { if (cap?.active) { cap.stop(); setTimeout(listen, 300); } });
      on($("#clear-chat"), "click", () => { log = []; $("#chat-log").replaceChildren(); });
      on($("#copy-chat"), "click", async () => {
        const text = log.map(m => `[${m.time}] ${m.who === "them" ? PUL.t("Them") : PUL.t("Me")}: ${m.text}`).join("\n");
        try { await navigator.clipboard.writeText(text); PUL.say(PUL.t("Conversation copied."), { silent: true }); } catch (_) {}
      });
      const act = PUL.takeAction(); if (act?.name === "listen") listen();
    },
    run(action) { if (action === "listen") listen(); },
    refresh() { renderQuick(); },
    destroy() { cap?.stop(); cap = null; speechSynthesis?.cancel(); cleanup.forEach(fn => fn()); cleanup = []; },
  };

  function renderQuick() {
    const box = $("#quick-phrases"); if (!box) return;
    box.replaceChildren();
    QUICK.forEach(phrase => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = PUL.t(phrase);
      b.addEventListener("click", () => sayReply(PUL.t(phrase)));
      box.append(b);
    });
  }
})();
