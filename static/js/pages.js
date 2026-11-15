"use strict";
/* Home, Dashboard and Profiles pages. */

(() => {
  const textCell = (tr, value) => { const td = document.createElement("td"); td.textContent = value; tr.append(td); return td; };
  const PRESETS = [
    ["Custom", null], ["One short pulse", [180]], ["Two short pulses", [150, 100, 150]],
    ["Three short pulses", [100, 70, 100, 70, 100]], ["One long pulse", [650]],
    ["Urgent repeated", [450, 120, 450, 120, 450, 120, 450]],
  ];

  async function fillStats() {
    try {
      const s = await api("/api/summary");
      const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
      set("#stat-contacts", s.contacts); set("#stat-events", s.events); set("#stat-sounds", s.sound_events); set("#stat-danger", s.danger_events);
      return s;
    } catch (_) { return null; }
  }

  PUL.pages.home = { init() { fillStats(); }, destroy() {} };

  /* ---------- dashboard ---------- */
  async function loadDashboard() {
    const summary = await fillStats();
    const body = $("#event-table"); if (!body) return;
    try {
      const events = await api("/api/events");
      body.replaceChildren();
      if (!events.length) { const tr = document.createElement("tr"); const td = textCell(tr, PUL.t("No events recorded yet.")); td.colSpan = 4; body.append(tr); }
      events.forEach(e => { const tr = document.createElement("tr"); [e.created_at, e.event_type, e.message, e.severity].forEach(v => textCell(tr, v)); body.append(tr); });
    } catch (e) { body.textContent = e.message; }
    const bars = $("#type-bars");
    if (bars && summary) {
      bars.replaceChildren();
      const entries = Object.entries(summary.by_type).sort((a, b) => b[1] - a[1]);
      const max = Math.max(1, ...entries.map(e => e[1]));
      entries.forEach(([type, n]) => {
        const row = document.createElement("div"); row.className = "type-bar";
        const label = document.createElement("span"); label.textContent = type;
        const bar = document.createElement("div"); bar.style.width = `${Math.round(n / max * 100)}%`;
        const count = document.createElement("strong"); count.textContent = n;
        row.append(label, bar, count); bars.append(row);
      });
      if (!entries.length) bars.textContent = PUL.t("No events recorded yet.");
    }
    const dp = $("#dash-profile"); if (dp && PUL.profile) dp.textContent = PUL.t(PUL.profile.name);
  }
  PUL.pages.dashboard = {
    init() {
      loadDashboard();
      $("#refresh-dashboard")?.addEventListener("click", loadDashboard);
      $("#clear-events")?.addEventListener("click", async () => { if (confirm(PUL.t("Clear history") + "?")) { await api("/api/events", { method: "DELETE" }); loadDashboard(); } });
    },
    refresh: loadDashboard, destroy() {},
  };

  /* ---------- profiles ---------- */
  let profiles = [], editing = null;

  async function loadProfiles() {
    try { profiles = await api("/api/profiles"); } catch (e) { $("#profile-status").textContent = e.message; return; }
    const list = $("#profile-list"); if (!list) return;
    list.replaceChildren();
    profiles.forEach(p => {
      const li = document.createElement("li"); if (p.is_active) li.className = "active";
      const name = document.createElement("strong");
      name.textContent = PUL.t(p.name) + (p.is_active ? ` · ${PUL.t("Active")}` : "");
      const needs = document.createElement("small");
      needs.textContent = [p.settings.needs.vision && "👁️", p.settings.needs.hearing && "👂", p.settings.brailleMode && "⠃"].filter(Boolean).join(" ");
      const left = document.createElement("span"); left.append(name, document.createElement("br"), needs);
      const actions = document.createElement("span"); actions.className = "actions";
      const btn = (text, fn, cls = "button button-secondary") => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = PUL.t(text); b.setAttribute("aria-label", `${PUL.t(text)}: ${p.name}`); b.addEventListener("click", fn); actions.append(b); };
      if (!p.is_active) btn("Activate", () => activate(p.id), "button");
      btn("Edit", () => openEditor(p));
      if (profiles.length > 1) btn("Delete", () => remove(p));
      li.append(left, actions); list.append(li);
    });
  }
  async function activate(id) {
    try {
      const profile = await api(`/api/profiles/${id}/activate`, { method: "POST" });
      PUL.applyProfile(profile, { resetLocal: true });
      PUL.say(`${PUL.t("Profile activated:")} ${PUL.t(profile.name)}`);
      loadProfiles();
    } catch (e) { PUL.say(e.message, { level: "danger" }); }
  }
  async function remove(p) {
    if (!confirm(`${PUL.t("Delete")}: ${p.name}?`)) return;
    try { await api(`/api/profiles/${p.id}`, { method: "DELETE" }); $("#profile-status").textContent = PUL.t("Profile deleted."); await loadProfiles(); if (p.is_active) { const act = profiles.find(x => x.is_active); if (act) PUL.applyProfile(act, { resetLocal: true }); } }
    catch (e) { $("#profile-status").textContent = e.message; }
  }

  function openEditor(profile) {
    editing = profile ? { id: profile.id } : { id: null };
    const s = profile ? profile.settings : JSON.parse(JSON.stringify(PUL.settings()));
    $("#editor-panel").hidden = false;
    $("#pf-name").value = profile ? profile.name : "";
    $("#pf-vision").checked = !!s.needs.vision; $("#pf-hearing").checked = !!s.needs.hearing;
    $("#pf-language").value = s.language; $("#pf-font").value = String(s.fontScale >= 135 ? 140 : s.fontScale >= 110 ? 120 : 100);
    $("#pf-caption").value = s.captionSize; $("#pf-rate").value = s.speechRate;
    $("#pf-contrast").checked = !!s.contrast; $("#pf-voicefirst").checked = !!s.voiceFirst;
    $("#pf-announce").checked = !!s.autoAnnounce; $("#pf-braille").checked = !!s.brailleMode;
    $("#pf-flash").checked = !!s.flash; $("#pf-vibrate").checked = !!s.vibrate; $("#pf-beep").checked = !!s.beepFallback;
    $("#pf-help").value = s.helpMessage;
    const sounds = $("#pf-sounds"); sounds.replaceChildren();
    Object.entries(PUL.EVENTS).forEach(([key, info]) => {
      const label = document.createElement("label"); label.className = "toggle-row";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.dataset.sound = key; cb.checked = s.sounds[key] !== false;
      label.append(cb, document.createTextNode(`${info.emoji} ${PUL.t(info.label)}`)); sounds.append(label);
    });
    const pats = $("#pf-patterns"); pats.replaceChildren();
    Object.entries(PUL.EVENTS).forEach(([key, info]) => {
      const row = document.createElement("div"); row.className = "pattern-row";
      const name = document.createElement("label"); name.textContent = `${info.emoji} ${PUL.t(info.label)}`; name.htmlFor = `pat-${key}`;
      const input = document.createElement("input"); input.id = `pat-${key}`; input.dataset.pattern = key; input.value = (s.patterns[key] || []).join(",");
      const box = document.createElement("span"); box.className = "button-row"; box.style.margin = "0";
      const preset = document.createElement("select"); preset.setAttribute("aria-label", `${PUL.t("Pattern")}: ${PUL.t(info.label)}`);
      PRESETS.forEach(([text, value], i) => { const o = document.createElement("option"); o.value = i; o.textContent = PUL.t(text); preset.append(o); });
      preset.addEventListener("change", () => { const v = PRESETS[preset.value][1]; if (v) input.value = v.join(","); });
      const test = document.createElement("button"); test.type = "button"; test.className = "button button-secondary"; test.textContent = PUL.t("Test");
      test.addEventListener("click", () => { const p = parsePattern(input.value); if (p) PUL.haptic.alert(p ? p : key, { label: PUL.t(info.label) }); });
      box.append(preset, test); row.append(name, input, box); pats.append(row);
    });
    $("#editor-title").textContent = profile ? PUL.t("Edit profile") : PUL.t("New profile");
    $("#editor-panel").scrollIntoView({ behavior: "smooth" }); $("#pf-name").focus();
  }
  function parsePattern(text) {
    const nums = text.split(/[,\s]+/).filter(Boolean).map(Number);
    if (!nums.length || nums.length > 24 || nums.some(n => !Number.isFinite(n) || n < 10 || n > 2000)) return null;
    return nums;
  }
  function collect() {
    const base = editing.id ? profiles.find(p => p.id === editing.id).settings : PUL.settings();
    const patterns = {}, sounds = {};
    $$("[data-pattern]").forEach(i => { const p = parsePattern(i.value); if (!p) throw new Error(`${PUL.t("Pattern")}: ${i.value}`); patterns[i.dataset.pattern] = p; });
    $$("[data-sound]").forEach(i => { sounds[i.dataset.sound] = i.checked; });
    return {
      ...base,
      needs: { vision: $("#pf-vision").checked, hearing: $("#pf-hearing").checked },
      language: $("#pf-language").value, fontScale: Number($("#pf-font").value), captionSize: $("#pf-caption").value,
      speechRate: Number($("#pf-rate").value), contrast: $("#pf-contrast").checked, voiceFirst: $("#pf-voicefirst").checked,
      autoAnnounce: $("#pf-announce").checked, brailleMode: $("#pf-braille").checked, flash: $("#pf-flash").checked,
      vibrate: $("#pf-vibrate").checked, beepFallback: $("#pf-beep").checked, helpMessage: $("#pf-help").value,
      sounds, patterns: { ...base.patterns, ...patterns },
    };
  }

  PUL.pages.profiles = {
    init() {
      editing = null; loadProfiles();
      $("#new-profile")?.addEventListener("click", () => openEditor(null));
      $("#pf-cancel")?.addEventListener("click", () => { $("#editor-panel").hidden = true; editing = null; });
      $("#profile-form")?.addEventListener("submit", async e => {
        e.preventDefault();
        try {
          const body = JSON.stringify({ name: $("#pf-name").value, settings: collect() });
          const saved = editing.id ? await api(`/api/profiles/${editing.id}`, { method: "PUT", body }) : await api("/api/profiles", { method: "POST", body });
          $("#editor-panel").hidden = true; editing = null;
          if (saved.id === PUL.profile?.id) PUL.applyProfile(saved, { resetLocal: true });
          $("#profile-status").textContent = PUL.t("Profile saved."); PUL.say(PUL.t("Profile saved."), { silent: true });
          loadProfiles();
        } catch (err) { $("#profile-status").textContent = err.message; PUL.say(err.message, { level: "danger" }); }
      });
    },
    refresh: loadProfiles, destroy() { PUL.haptic.stop(); },
  };

  /* ---------- account ---------- */
  async function loadAccount() {
    let acct; try { acct = await api("/api/account"); } catch (e) { $("#acct-status").textContent = e.message; return; }
    const guest = acct.is_guest;
    $("#acct-status").textContent = guest ? PUL.t("Guest") : (acct.display_name || acct.email);
    $("#acct-note").textContent = guest
      ? PUL.t("You are a guest. Your data is private to this browser. Clearing browser data or using another device will lose it unless you create an account.")
      : acct.email;
    $("#guest-forms").hidden = !guest; $("#logout-btn").hidden = guest; $("#delete-password-row").hidden = guest;
  }
  PUL.pages.account = {
    init() {
      loadAccount();
      const status = msg => { const el = $("#form-status"); if (el) el.textContent = msg; PUL.announce(msg); };
      $("#register-form")?.addEventListener("submit", async e => {
        e.preventDefault();
        try {
          await api("/api/account/register", { method: "POST", body: JSON.stringify({ name: $("#reg-name").value, email: $("#reg-email").value, password: $("#reg-password").value }) });
          location.href = "/account";
        } catch (err) { status(err.message); }
      });
      $("#login-form")?.addEventListener("submit", async e => {
        e.preventDefault();
        try {
          await api("/api/account/login", { method: "POST", body: JSON.stringify({ email: $("#log-email").value, password: $("#log-password").value }) });
          PUL.store.del("pulanova-language"); PUL.store.del("pulanova-font"); PUL.store.del("pulanova-contrast");
          location.href = "/";
        } catch (err) { status(err.message); }
      });
      $("#logout-btn")?.addEventListener("click", async () => { await api("/api/account/logout", { method: "POST" }); location.href = "/"; });
      $("#export-btn")?.addEventListener("click", async () => {
        try {
          const data = await api("/api/account/export");
          const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
          const a = document.createElement("a"); a.href = url; a.download = "pulanova-data.json"; a.click(); URL.revokeObjectURL(url);
        } catch (err) { status(err.message); }
      });
      $("#delete-btn")?.addEventListener("click", async () => {
        if (!confirm(PUL.t("This permanently deletes your contacts, events, profiles and account. It cannot be undone."))) return;
        try {
          await api("/api/account", { method: "DELETE", body: JSON.stringify({ password: $("#del-password")?.value || "" }) });
          PUL.store.del("pulanova-voice"); location.href = "/";
        } catch (err) { status(err.message); }
      });
    },
    refresh: loadAccount, destroy() {},
  };

  /* ---------- forgot / reset password ---------- */
  const forgotInit = () => {
    $("#forgot-form")?.addEventListener("submit", async e => {
      e.preventDefault();
      try {
        const r = await api("/api/account/forgot", { method: "POST", body: JSON.stringify({ email: $("#forgot-email").value }) });
        $("#form-status").textContent = PUL.t(r.message); PUL.announce(PUL.t(r.message));
      } catch (err) { $("#form-status").textContent = err.message; }
    });
  };
  const baseAccountInit = PUL.pages.account.init;
  PUL.pages.account.init = function () { baseAccountInit.call(this); forgotInit(); };

  PUL.pages.reset = {
    init() {
      const token = new URL(location.href).searchParams.get("token") || "";
      const status = msg => { $("#reset-status").textContent = msg; PUL.announce(msg); };
      if (!token) status(PUL.t("This reset link is invalid or has expired. Request a new one."));
      $("#reset-form")?.addEventListener("submit", async e => {
        e.preventDefault();
        const pw = $("#new-password").value;
        if (pw !== $("#new-password2").value) return status(PUL.t("The two passwords do not match."));
        try {
          const r = await api("/api/account/reset", { method: "POST", body: JSON.stringify({ token, password: pw }) });
          status(PUL.t(r.message)); history.replaceState({}, "", "/reset");
          setTimeout(() => { location.href = "/account"; }, 2500);
        } catch (err) { status(err.message); }
      });
    },
    destroy() {},
  };
})();
