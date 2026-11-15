"use strict";
/* Tactile Emergency Assistance: countdown -> SOS vibration/flash/alarm -> location -> help card + SMS draft. */

(() => {
  const SOS_PATTERN = [150, 100, 150, 100, 150, 250, 450, 100, 450, 100, 450, 250, 150, 100, 150, 100, 150]; // ... --- ...
  let cleanup = [], countdownTimer = null, alarmTimer = null, alarmOn = false, contacts = [];

  PUL.emergency = { active: false, start, cancel };

  async function loadContacts() {
    try { contacts = await api("/api/contacts"); } catch (_) { contacts = []; }
    renderContacts();
  }
  function renderContacts() {
    const list = $("#contact-list"); if (!list) return;
    list.replaceChildren();
    if (!contacts.length) { const li = document.createElement("li"); li.textContent = PUL.t("No emergency contacts saved."); list.append(li); return; }
    contacts.forEach(c => {
      const li = document.createElement("li");
      const info = document.createElement("span");
      info.textContent = `${c.name} · ${c.phone}${c.relationship ? " · " + c.relationship : ""}`;
      if (c.is_primary) { const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = PUL.t("Primary"); info.append(badge); }
      li.append(info);
      if (!c.is_primary) {
        const p = document.createElement("button"); p.type = "button"; p.textContent = PUL.t("Make primary");
        p.setAttribute("aria-label", `${PUL.t("Make primary")}: ${c.name}`);
        p.addEventListener("click", async () => { await api(`/api/contacts/${c.id}/primary`, { method: "POST" }); loadContacts(); });
        li.append(p);
      }
      const del = document.createElement("button"); del.type = "button"; del.className = "del"; del.textContent = PUL.t("Delete");
      del.setAttribute("aria-label", `${PUL.t("Delete")} ${c.name}`);
      del.addEventListener("click", async () => {
        try { await api(`/api/contacts/${c.id}`, { method: "DELETE" }); $("#contact-status").textContent = PUL.t("Contact deleted."); loadContacts(); }
        catch (e) { $("#contact-status").textContent = e.message; }
      });
      li.append(del); list.append(li);
    });
  }

  /* simple loud two-tone alarm */
  function startAlarm() {
    if (alarmOn) return; alarmOn = true; let high = false;
    alarmTimer = setInterval(() => { PUL.beep(high ? 880 : 620, 280, 0.5); high = !high; }, 320);
  }
  function stopAlarm() { alarmOn = false; clearInterval(alarmTimer); alarmTimer = null; }

  function start() {
    if (PUL.emergency.active) return;
    PUL.emergency.active = true;
    PUL.audio();
    const box = $("#sos-countdown"), cancelBtn = $("#sos-cancel");
    let n = 5;
    if (box) box.hidden = false; if (cancelBtn) cancelBtn.hidden = false;
    const tick = () => {
      if (box) box.textContent = `${PUL.t("Emergency in")} ${n}`;
      PUL.announce(String(n), { assertive: true, short: String(n) });
      if (n === 5) PUL.speak(`${PUL.t("Emergency in")} 5`, { interrupt: true });
      else PUL.beep(900, 90, 0.4);               // beeps, not speech, so "cancel" can still be heard
      PUL.haptic.play([80], { label: String(n) });
      if (n === 0) { clearInterval(countdownTimer); countdownTimer = null; run(); }
      n--;
    };
    tick(); countdownTimer = setInterval(tick, 1000);
  }

  function cancel() {
    if (!PUL.emergency.active) return;
    clearInterval(countdownTimer); countdownTimer = null; stopAlarm();
    PUL.emergency.active = false;
    PUL.haptic.stop();
    const box = $("#sos-countdown"), cancelBtn = $("#sos-cancel");
    if (box) box.hidden = true; if (cancelBtn) cancelBtn.hidden = true;
    const card = $("#help-card"); if (card) card.hidden = true;
    PUL.tsay("Emergency cancelled.", { assertive: true });
  }

  async function run() {
    const box = $("#sos-countdown"), cancelBtn = $("#sos-cancel");
    if (box) box.hidden = true; if (cancelBtn) cancelBtn.hidden = true;
    PUL.say(PUL.t("Emergency started."), { level: "danger", assertive: true });
    PUL.flash({ red: true });
    if ($("#sos-alarm")?.checked !== false) startAlarm();
    PUL.haptic.play(SOS_PATTERN, { repeat: 2, label: "SOS" });
    PUL.saveEvent("emergency", "Emergency (SOS) started.", "danger");

    PUL.say(PUL.t("Getting your location…"), { silent: true });
    const position = await new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(p => resolve(p), () => resolve(null), { enableHighAccuracy: true, timeout: 10000 });
    });
    if (!PUL.emergency.active) return;           // cancelled while waiting
    let mapUrl = "";
    if (position) {
      mapUrl = `https://maps.google.com/?q=${position.coords.latitude},${position.coords.longitude}`;
      PUL.say(PUL.t("Location found."), { level: "danger" });
      PUL.haptic.play("ok", { label: PUL.t("Location found.") });
    } else PUL.say(PUL.t("Location unavailable. Sending message without it."), { level: "caution" });

    await loadContacts().catch(() => {});
    const note = PUL.settings().helpMessage || "I may need assistance.";
    const body = mapUrl ? `${note} ${PUL.t("My location:")} ${mapUrl}` : note;
    showHelpCard(note, mapUrl, body);

    if ($("#sos-sms")?.checked !== false && contacts.length) {
      const numbers = contacts.map(c => c.phone.replace(/[^+0-9]/g, "")).join(",");
      const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      PUL.say(PUL.t("SMS ready. Review it and press send."), { level: "danger", assertive: true });
      setTimeout(() => PUL.haptic.play([1200], { label: "SMS" }), 1200);
      setTimeout(() => { if (PUL.emergency.active) location.href = `sms:${numbers}${ios ? "&" : "?"}body=${encodeURIComponent(body)}`; }, 2200);
      PUL.saveEvent("emergency", "Emergency SMS draft prepared.", "danger");
    }
  }

  function showHelpCard(note, mapUrl, body) {
    const card = $("#help-card"); if (!card) return;
    $("#help-message").textContent = note;
    $("#help-location").textContent = mapUrl ? `${PUL.t("My location:")} ${mapUrl}` : "";
    const actions = $("#help-actions"); actions.replaceChildren();
    const add = (href, text) => { const a = document.createElement("a"); a.className = "button"; a.href = href; a.textContent = text; actions.append(a); };
    const primary = contacts.find(c => c.is_primary) || contacts[0];
    if (primary) add(`tel:${primary.phone.replace(/[^+0-9]/g, "")}`, `📞 ${PUL.t("Call primary contact")} · ${primary.name}`);
    add("tel:112", `📞 ${PUL.t("Call 112")}`);
    if (contacts.length) add(`sms:${contacts.map(c => c.phone.replace(/[^+0-9]/g, "")).join(",")}?body=${encodeURIComponent(body)}`, `✉️ ${PUL.t("Send SMS to contacts")}`);
    if (mapUrl) add(mapUrl, `📍 ${PUL.t("Open my location")}`);
    card.hidden = false; $("#help-close").focus();
  }

  PUL.pages.emergency = {
    init() {
      cleanup = [];
      const on = (el, ev, fn) => { if (!el) return; el.addEventListener(ev, fn); cleanup.push(() => el.removeEventListener(ev, fn)); };
      loadContacts();
      on($("#sos-button"), "click", start);
      on($("#sos-cancel"), "click", cancel);
      on($("#help-close"), "click", () => { $("#help-card").hidden = true; stopAlarm(); PUL.emergency.active = false; PUL.haptic.stop(); });
      on($("#contact-form"), "submit", async e => {
        e.preventDefault();
        const payload = Object.fromEntries(new FormData(e.currentTarget).entries());
        try { await api("/api/contacts", { method: "POST", body: JSON.stringify(payload) }); e.currentTarget.reset(); $("#contact-status").textContent = PUL.t("Contact saved."); loadContacts(); }
        catch (err) { $("#contact-status").textContent = err.message; }
      });
      const act = PUL.takeAction(); if (act?.name === "sos") start();
    },
    run(action) { if (action === "sos") start(); },
    refresh() { renderContacts(); },
    destroy() { cleanup.forEach(fn => fn()); cleanup = []; clearInterval(countdownTimer); countdownTimer = null; stopAlarm(); PUL.emergency.active = false; },
  };
})();
