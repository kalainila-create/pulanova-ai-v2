"use strict";
/* PULANOVA core: helpers, profile, language, announcements, speech output, page router. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

window.PUL = {
  pages: {}, profile: null, pending: null, current: null,
  opts: { flash: true, vibrate: true, beep: true },
};

/* ---------- network ---------- */
async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", "X-PULANOVA": "1", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
async function saveEvent(type, message, severity = "info") {
  try {
    await api("/api/events", { method: "POST", body: JSON.stringify({ event_type: type, message, severity }) });
  } catch (error) { console.warn("Could not save event:", error.message); }
}
PUL.api = api; PUL.saveEvent = saveEvent;

/* ---------- storage (safe) ---------- */
const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (_) { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (_) {} },
  del(key) { try { localStorage.removeItem(key); } catch (_) {} },
};
PUL.store = store;

/* ---------- language ---------- */
PUL.lang = () => ($("#language-select")?.value === "ta" ? "ta" : "en");
PUL.t = (text, vars) => {
  let out = PUL.lang() === "ta" ? (window.PUL_TA[text] || text) : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
};
PUL.applyI18n = (root = document) => {
  const ta = PUL.lang() === "ta";
  const dict = window.PUL_TA;
  $$("[data-t]", root).forEach(el => {
    if (el.dataset.en === undefined) el.dataset.en = el.textContent.trim();
    el.textContent = ta ? (dict[el.dataset.en] || el.dataset.en) : el.dataset.en;
  });
  $$("[data-t-aria]", root).forEach(el => {
    if (el.dataset.enAria === undefined) el.dataset.enAria = el.getAttribute("aria-label") || "";
    el.setAttribute("aria-label", ta ? (dict[el.dataset.enAria] || el.dataset.enAria) : el.dataset.enAria);
  });
  $$("[data-t-ph]", root).forEach(el => {
    if (el.dataset.enPh === undefined) el.dataset.enPh = el.getAttribute("placeholder") || "";
    el.setAttribute("placeholder", ta ? (dict[el.dataset.enPh] || el.dataset.enPh) : el.dataset.enPh);
  });
  document.documentElement.lang = ta ? "ta" : "en";
};
PUL.setLanguage = (lang, { remember = true } = {}) => {
  const select = $("#language-select");
  if (select) select.value = lang;
  if (remember) store.set("pulanova-language", lang);
  PUL.applyI18n();
  PUL.pages[PUL.current]?.refresh?.();
  PUL.renderProfileName?.();
};
PUL.speechLang = () => (PUL.lang() === "ta" ? "ta-IN" : "en-IN");

/* ---------- profile ---------- */
PUL.settings = () => PUL.profile?.settings || {};
PUL.renderProfileName = () => {
  const el = $("#profile-name");
  if (el && PUL.profile) el.textContent = PUL.t(PUL.profile.name);
};
PUL.applyProfile = (profile, { resetLocal = false } = {}) => {
  PUL.profile = profile;
  const s = profile?.settings || {};
  if (resetLocal) { store.del("pulanova-font"); store.del("pulanova-contrast"); store.set("pulanova-language", s.language || "en"); }
  const font = Number(store.get("pulanova-font", s.fontScale || 100));
  document.documentElement.style.fontSize = `${font}%`;
  document.documentElement.dataset.fontScale = String(font);
  const contrast = store.get("pulanova-contrast", null);
  setContrast(contrast === null ? !!s.contrast : contrast === "1");
  document.documentElement.dataset.caption = s.captionSize || "large";
  PUL.opts.flash = s.flash !== false;
  PUL.opts.vibrate = s.vibrate !== false;
  PUL.opts.beep = s.beepFallback !== false;
  $("#braille-bar").hidden = !s.brailleMode;
  document.body.classList.toggle("braille-mode", !!s.brailleMode);
  PUL.setLanguage(store.get("pulanova-language", s.language || "en"), { remember: false });
  PUL.renderProfileName();
};
function setContrast(on) {
  document.body.classList.toggle("high-contrast", on);
  $("#contrast-toggle")?.setAttribute("aria-pressed", String(on));
}

/* ---------- announcements ---------- */
let toastTimer = null;
PUL.toast = (message, level = "info") => {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast"; el.className = "toast"; el.setAttribute("aria-hidden", "true");
    document.body.append(el);
  }
  el.textContent = message;
  el.dataset.level = level;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4500);
};
PUL.announce = (message, { assertive = false, short = null } = {}) => {
  const region = $(assertive ? "#live-assertive" : "#live-polite");
  const text = PUL.settings().brailleMode && short ? short : message;
  if (region) { region.textContent = ""; setTimeout(() => { region.textContent = text; }, 40); }
  const line = $("#braille-line");
  if (line && PUL.settings().brailleMode) line.textContent = (PUL.braille ? PUL.braille.toBraille(text) : text);
};

/* ---------- speech output ---------- */
let voicesCache = [];
if ("speechSynthesis" in window) {
  const load = () => { voicesCache = speechSynthesis.getVoices(); };
  load(); speechSynthesis.addEventListener?.("voiceschanged", load);
}
PUL.speechOn = () => {
  const needs = PUL.settings().needs || {};
  if (needs.hearing && !needs.vision) return false;   // a deaf user does not need spoken output
  if (needs.hearing && needs.vision) return false;    // deafblind: touch, screen reader and Braille
  return !!(needs.vision || PUL.voice?.active || PUL.settings().voiceFirst);
};
PUL.speak = (text, { lang, rate, interrupt = true, force = false } = {}) => new Promise(resolve => {
  if (!("speechSynthesis" in window) || (!force && !PUL.speechOn())) return resolve(false);
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang || PUL.speechLang();
  u.rate = rate || PUL.settings().speechRate || 1;
  const voice = voicesCache.find(v => v.lang.replace("_", "-").toLowerCase() === u.lang.toLowerCase())
             || voicesCache.find(v => v.lang.toLowerCase().startsWith(u.lang.slice(0, 2).toLowerCase()));
  if (voice) u.voice = voice;
  u.onend = () => resolve(true); u.onerror = () => resolve(false);
  speechSynthesis.speak(u);
});
/* say = visible toast + screen-reader live region + (when appropriate) spoken output */
PUL.say = (message, { level = "info", assertive = false, short = null, silent = false } = {}) => {
  PUL.toast(message, level);
  PUL.announce(message, { assertive, short });
  if (!silent) PUL.speak(message);
};
PUL.tsay = (en, opts = {}) => PUL.say(PUL.t(en), opts);

/* ---------- toolbar ---------- */
function bindToolbar() {
  $$("[data-font]").forEach(button => button.addEventListener("click", () => {
    const current = Number(document.documentElement.dataset.fontScale || 100);
    const next = Math.max(85, Math.min(170, current + (button.dataset.font === "up" ? 10 : -10)));
    document.documentElement.dataset.fontScale = String(next);
    document.documentElement.style.fontSize = `${next}%`;
    store.set("pulanova-font", String(next));
  }));
  $("#contrast-toggle")?.addEventListener("click", () => {
    const on = !document.body.classList.contains("high-contrast");
    setContrast(on); store.set("pulanova-contrast", on ? "1" : "0");
  });
  $("#language-select")?.addEventListener("change", event => PUL.setLanguage(event.target.value));
}

/* ---------- pages & router ---------- */
PUL.pageGuidance = () => {
  const h1 = $("main h1")?.textContent?.trim() || "";
  const p = $("main .page-heading p:last-child, main .hero-copy")?.textContent?.trim() || "";
  return [h1, p].filter(Boolean).join(". ");
};
PUL.announcePage = () => {
  const text = PUL.pageGuidance();
  if (text) PUL.say(text, { short: $("main h1")?.textContent?.trim() });
};
/* One-shot action for the page that is about to open (from ?do=… or a voice command). */
PUL.queue = (name, args = {}) => { PUL.pending = { name, args }; };
PUL.takeAction = () => {
  let action = PUL.pending; PUL.pending = null;
  const url = new URL(location.href);
  const param = url.searchParams.get("do");
  if (!action && param) action = { name: param, args: {} };
  if (param) { url.searchParams.delete("do"); history.replaceState({}, "", url.pathname + url.search + url.hash); }
  return action;
};
PUL.mountPage = ({ announce = false } = {}) => {
  const main = $("#main");
  const name = main?.dataset.page;
  PUL.current = name;
  PUL.applyI18n(main);
  PUL.pages[name]?.init?.(main);
  if (announce && (PUL.settings().autoAnnounce || PUL.voice?.active)) PUL.announcePage();
};
PUL.unmountPage = () => { PUL.pages[PUL.current]?.destroy?.(); };

PUL.go = async (url, { push = true } = {}) => {
  try {
    const target = new URL(url, location.href);
    const response = await fetch(target.href, { headers: { "X-Requested-With": "pulanova" } });
    if (!response.ok) throw new Error("navigation failed");
    const doc = new DOMParser().parseFromString(await response.text(), "text/html");
    const newMain = $("#main", doc);
    if (!newMain) throw new Error("no main");
    PUL.unmountPage();
    const main = $("#main");
    main.innerHTML = newMain.innerHTML;
    main.dataset.page = newMain.dataset.page;
    document.title = doc.title;
    if (push) history.pushState({}, "", target.pathname + target.search);
    $$(".side-nav a").forEach(a => a.classList.toggle("active", new URL(a.href).pathname === target.pathname));
    window.scrollTo(0, 0);
    PUL.mountPage({ announce: true });
    main.focus({ preventScroll: true });
  } catch (error) {
    console.warn("PULANOVA router fallback:", error);
    location.href = url;     // fall back to a normal page load
  }
};
document.addEventListener("click", event => {
  const link = event.target.closest?.("a[data-nav]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  PUL.go(link.href);
});
window.addEventListener("popstate", () => PUL.go(location.href, { push: false }));

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  bindToolbar();
  let profile = null;
  try { profile = JSON.parse($("#pul-boot").textContent); } catch (_) {}
  const savedLang = store.get("pulanova-language", null);
  if (savedLang && $("#language-select")) $("#language-select").value = savedLang;
  PUL.applyProfile(profile);
  PUL.mountPage();
  PUL.voice?.boot?.();
  if (PUL.settings().autoAnnounce) setTimeout(() => PUL.announcePage(), 600);
});

/* Load a script once (TensorFlow.js, models, Tesseract) only when a feature needs it. */
const scriptPromises = {};
PUL.loadScript = url => scriptPromises[url] || (scriptPromises[url] = new Promise((resolve, reject) => {
  const el = document.createElement("script");
  el.src = url; el.async = true;
  el.onload = () => resolve();
  el.onerror = () => { delete scriptPromises[url]; reject(new Error("Could not load " + url + ". Check your internet connection.")); };
  document.head.append(el);
}));
