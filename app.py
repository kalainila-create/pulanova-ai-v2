import copy
import hashlib
import json
import os
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import timedelta
from pathlib import Path

from flask import Flask, abort, g, jsonify, redirect, render_template, request, send_from_directory, session, url_for
from sqlalchemy.exc import IntegrityError
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

import database as db
import mailer
from database import DEFAULT_SETTINGS

BASE_DIR = Path(__file__).resolve().parent
IS_PRODUCTION = os.environ.get("PULANOVA_ENV") == "production"

app = Flask(__name__, instance_relative_config=True)

secret = os.environ.get("PULANOVA_SECRET")
if not secret:
    if IS_PRODUCTION:
        raise RuntimeError("Set the PULANOVA_SECRET environment variable in production.")
    secret = "dev-only-secret-change-me"       # local development only

app.config.update(
    SECRET_KEY=secret,
    MAX_CONTENT_LENGTH=1 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("PULANOVA_SECURE_COOKIES") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=365),
)
if os.environ.get("PULANOVA_PROXY") == "1":     # running behind Render / another proxy
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
db.init_app(app, BASE_DIR)

MAX_CONTACTS, MAX_PROFILES, MAX_EVENTS, MAX_CUSTOM_SOUNDS = 20, 20, 500, 10
EMBEDDING_DIM = 1024
SOUND_EMOJIS = ["🔊", "🍲", "🔔", "🚪", "📱", "⏰", "🐈", "🚂", "💧", "🍳"]
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$")
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
_DUMMY_HASH = generate_password_hash("not-a-real-password")


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
_hits = defaultdict(deque)


def rate_limited(key, limit, seconds):
    """True when `key` has already used up `limit` attempts in the last `seconds`."""
    bucket, cutoff = _hits[key], time.time() - seconds
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= limit:
        return True
    bucket.append(time.time())
    return False


def clean_text(value, limit=120):
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()[:limit]


def uid():
    return g.user["id"]


def public_account(user):
    return {"is_guest": bool(user["is_guest"]), "email": user["email"],
            "display_name": user["display_name"]}


# --------------------------------------------------------------------------
# Who is this? Every browser gets a private guest account on first visit.
# --------------------------------------------------------------------------
@app.before_request
def identify_user():
    if request.endpoint in ("static", "manifest", "healthz"):
        return None
    user = None
    if session.get("uid"):
        user = db.one_row("SELECT id, email, display_name, is_guest, session_epoch FROM users WHERE id = :i",
                          i=session["uid"])
        if user and user["session_epoch"] != session.get("ep", 0):    # password was reset elsewhere
            user = None
    if user is None:
        if rate_limited(f"guest:{request.remote_addr}", 30, 3600):
            return jsonify(error="Too many new visitors from this network. Try again later."), 429
        new_id = db.create_user()
        session.clear()
        session["uid"], session["ep"] = new_id, 0
        session.permanent = True
        user = db.one_row("SELECT id, email, display_name, is_guest, session_epoch FROM users WHERE id = :i", i=new_id)
    g.user = user
    # Cross-site forms cannot add custom headers, so this blocks forged requests.
    if request.path.startswith("/api/") and request.method in UNSAFE \
            and request.headers.get("X-PULANOVA") != "1":
        return jsonify(error="Missing security header."), 403
    return None


@app.after_request
def security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(self)")
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


# --------------------------------------------------------------------------
# Profiles (settings)
# --------------------------------------------------------------------------
def merge_settings(data):
    """Fill missing keys with defaults so older profiles keep working."""
    merged = copy.deepcopy(DEFAULT_SETTINGS)
    if isinstance(data, dict):
        for key, value in data.items():
            if key in ("needs", "sounds", "patterns") and isinstance(value, dict):
                merged[key].update(value)
            else:
                merged[key] = value
    return merged


def profile_to_dict(row):
    try:
        data = json.loads(row["data"])
    except (TypeError, ValueError):
        data = {}
    return {"id": row["id"], "name": row["name"], "is_active": bool(row["is_active"]),
            "settings": merge_settings(data)}


def active_profile_row(user_id):
    return (db.one_row("SELECT * FROM profiles WHERE user_id = :u AND is_active = 1 ORDER BY id LIMIT 1", u=user_id)
            or db.one_row("SELECT * FROM profiles WHERE user_id = :u ORDER BY id LIMIT 1", u=user_id))


def clean_pattern(value):
    """A vibration pattern: 1-24 integers, 10-2000 ms each."""
    if not isinstance(value, list):
        return None
    out = []
    for item in value[:24]:
        try:
            out.append(max(10, min(2000, int(item))))
        except (TypeError, ValueError):
            return None
    return out or None


def sanitize_settings(raw):
    if not isinstance(raw, dict):
        raise ValueError("Settings must be an object.")
    base = copy.deepcopy(DEFAULT_SETTINGS)
    out = copy.deepcopy(base)
    needs = raw.get("needs") if isinstance(raw.get("needs"), dict) else {}
    out["needs"] = {"vision": bool(needs.get("vision")), "hearing": bool(needs.get("hearing"))}
    out["language"] = "ta" if raw.get("language") == "ta" else "en"
    try:
        out["fontScale"] = max(85, min(160, int(raw.get("fontScale", 100))))
    except (TypeError, ValueError):
        out["fontScale"] = 100
    try:
        out["speechRate"] = max(0.5, min(1.6, float(raw.get("speechRate", 1.0))))
    except (TypeError, ValueError):
        out["speechRate"] = 1.0
    for flag in ("contrast", "voiceFirst", "autoAnnounce", "flash", "vibrate", "beepFallback", "brailleMode"):
        out[flag] = bool(raw.get(flag, base[flag]))
    out["captionSize"] = raw.get("captionSize") if raw.get("captionSize") in ("medium", "large", "xlarge") else "large"
    out["helpMessage"] = clean_text(raw.get("helpMessage"), 200) or base["helpMessage"]
    sounds = raw.get("sounds") if isinstance(raw.get("sounds"), dict) else {}
    out["sounds"] = {k: bool(sounds.get(k, True)) for k in base["sounds"]}
    patterns = raw.get("patterns") if isinstance(raw.get("patterns"), dict) else {}
    out["patterns"] = {k: clean_pattern(patterns.get(k)) or default for k, default in base["patterns"].items()}
    messages = []
    for item in (raw.get("tactileMessages") or [])[:30]:
        if isinstance(item, dict):
            label, pattern = clean_text(item.get("label"), 60), clean_pattern(item.get("pattern"))
            if label and pattern:
                messages.append({"label": label, "pattern": pattern})
    out["tactileMessages"] = messages
    return out


@app.context_processor
def inject_boot():
    user = getattr(g, "user", None)
    if not user:
        return {"boot_profile": None, "account": {"is_guest": True, "email": None, "display_name": ""}}
    row = active_profile_row(user["id"])
    return {"boot_profile": profile_to_dict(row) if row else None, "account": public_account(user)}


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------
def page(template):
    return lambda: render_template(template)


for _route, _endpoint, _template in [
    ("/", "home", "index.html"), ("/visual", "visual", "visual.html"),
    ("/hearing", "hearing", "hearing.html"), ("/bridge", "bridge", "bridge.html"),
    ("/tactile", "tactile", "tactile.html"), ("/emergency", "emergency", "emergency.html"),
    ("/profiles", "profiles_page", "profiles.html"), ("/account", "account_page", "account.html"),
    ("/reset", "reset_page", "reset.html"),
    ("/dashboard", "dashboard", "dashboard.html"), ("/about", "about", "about.html"),
]:
    app.add_url_rule(_route, _endpoint, page(_template))


PRESET_BY_MODE = {"visual": "Visually challenged", "hearing": "Hearing impaired",
                  "deafblind": "Deafblind", "everyday": "Everyday (default)"}


@app.get("/start/<mode>")
def start_mode(mode):
    """One-tap link for a helper: /start/visual switches this browser to the voice-first profile."""
    name = PRESET_BY_MODE.get(mode)
    if name is None:
        abort(404)
    row = db.one_row("SELECT id FROM profiles WHERE user_id = :u AND name = :n", u=uid(), n=name)
    if row:
        with db.engine.begin() as conn:
            conn.execute(db.text("UPDATE profiles SET is_active = 0 WHERE user_id = :u"), {"u": uid()})
            conn.execute(db.text("UPDATE profiles SET is_active = 1 WHERE id = :i AND user_id = :u"), {"i": row["id"], "u": uid()})
    return redirect(url_for("home", setup="done"))


@app.get("/privacy")
def privacy_page():
    return render_template("privacy.html", contact_email=os.environ.get("PULANOVA_CONTACT_EMAIL", ""),
                           operator=os.environ.get("PULANOVA_OPERATOR", ""))


@app.get("/manifest.webmanifest")
def manifest():
    return send_from_directory(app.static_folder, "manifest.webmanifest", mimetype="application/manifest+json")


@app.get("/healthz")
def healthz():
    return jsonify(status="ok", database=app.config["DB_KIND"], email_configured=mailer.configured())


# --------------------------------------------------------------------------
# Contacts
# --------------------------------------------------------------------------
@app.get("/api/contacts")
def list_contacts():
    return jsonify(db.all_rows(
        "SELECT id, name, phone, relationship, is_primary FROM contacts "
        "WHERE user_id = :u ORDER BY is_primary DESC, id DESC", u=uid()))


@app.post("/api/contacts")
def add_contact():
    data = request.get_json(silent=True) or {}
    name, phone = clean_text(data.get("name"), 80), clean_text(data.get("phone"), 30)
    relationship = clean_text(data.get("relationship"), 60)
    if not name or not phone:
        return jsonify(error="Name and phone number are required."), 400
    if not re.fullmatch(r"[+0-9() .-]{5,30}", phone):
        return jsonify(error="Enter a valid phone number."), 400
    count = db.one_row("SELECT COUNT(*) AS n FROM contacts WHERE user_id = :u", u=uid())["n"]
    if count >= MAX_CONTACTS:
        return jsonify(error=f"You can save up to {MAX_CONTACTS} contacts."), 400
    first = count == 0
    new_id = db.insert_returning_id(
        "INSERT INTO contacts (user_id, name, phone, relationship, is_primary, created_at) "
        "VALUES (:u, :n, :p, :r, :f, :t) RETURNING id",
        u=uid(), n=name, p=phone, r=relationship, f=1 if first else 0, t=db.now())
    return jsonify(id=new_id, name=name, phone=phone, relationship=relationship, is_primary=int(first)), 201


@app.post("/api/contacts/<int:contact_id>/primary")
def make_primary(contact_id):
    if not db.one_row("SELECT 1 AS x FROM contacts WHERE id = :i AND user_id = :u", i=contact_id, u=uid()):
        return jsonify(error="Contact not found."), 404
    with db.engine.begin() as conn:
        conn.execute(db.text("UPDATE contacts SET is_primary = 0 WHERE user_id = :u"), {"u": uid()})
        conn.execute(db.text("UPDATE contacts SET is_primary = 1 WHERE id = :i AND user_id = :u"), {"i": contact_id, "u": uid()})
    return jsonify(message="Primary contact updated.")


@app.delete("/api/contacts/<int:contact_id>")
def delete_contact(contact_id):
    row = db.one_row("SELECT is_primary FROM contacts WHERE id = :i AND user_id = :u", i=contact_id, u=uid())
    if row is None:
        return jsonify(error="Contact not found."), 404
    with db.engine.begin() as conn:
        conn.execute(db.text("DELETE FROM contacts WHERE id = :i AND user_id = :u"), {"i": contact_id, "u": uid()})
        if row["is_primary"]:
            conn.execute(db.text(
                "UPDATE contacts SET is_primary = 1 WHERE id = "
                "(SELECT id FROM contacts WHERE user_id = :u ORDER BY id LIMIT 1)"), {"u": uid()})
    return jsonify(message="Contact deleted.")


# --------------------------------------------------------------------------
# Events
# --------------------------------------------------------------------------
@app.get("/api/events")
def list_events():
    return jsonify(db.all_rows(
        "SELECT id, event_type, message, severity, created_at FROM events "
        "WHERE user_id = :u ORDER BY id DESC LIMIT 100", u=uid()))


@app.post("/api/events")
def add_event():
    data = request.get_json(silent=True) or {}
    event_type, message = clean_text(data.get("event_type"), 40), clean_text(data.get("message"), 240)
    severity = clean_text(data.get("severity", "info"), 20).lower()
    if not event_type or not message:
        return jsonify(error="Event type and message are required."), 400
    if severity not in {"safe", "caution", "danger", "info"}:
        severity = "info"
    new_id = db.insert_returning_id(
        "INSERT INTO events (user_id, event_type, message, severity, created_at) "
        "VALUES (:u, :e, :m, :s, :t) RETURNING id",
        u=uid(), e=event_type, m=message, s=severity, t=db.now())
    db.run("DELETE FROM events WHERE user_id = :u AND id NOT IN "
           "(SELECT id FROM events WHERE user_id = :u ORDER BY id DESC LIMIT :n)", u=uid(), n=MAX_EVENTS)
    return jsonify(id=new_id, message="Event saved."), 201


@app.delete("/api/events")
def clear_events():
    db.run("DELETE FROM events WHERE user_id = :u", u=uid())
    return jsonify(message="History cleared.")


@app.get("/api/summary")
def summary():
    one = lambda sql: db.one_row(sql, u=uid())["n"]
    by_type = {r["event_type"]: r["n"] for r in db.all_rows(
        "SELECT event_type, COUNT(*) AS n FROM events WHERE user_id = :u GROUP BY event_type", u=uid())}
    return jsonify(
        contacts=one("SELECT COUNT(*) AS n FROM contacts WHERE user_id = :u"),
        events=one("SELECT COUNT(*) AS n FROM events WHERE user_id = :u"),
        danger_events=one("SELECT COUNT(*) AS n FROM events WHERE user_id = :u AND severity = 'danger'"),
        sound_events=one("SELECT COUNT(*) AS n FROM events WHERE user_id = :u AND event_type LIKE 'sound%'"),
        by_type=by_type)


# --------------------------------------------------------------------------
# Profiles
# --------------------------------------------------------------------------
def get_profile(profile_id):
    return db.one_row("SELECT * FROM profiles WHERE id = :i AND user_id = :u", i=profile_id, u=uid())


@app.get("/api/profiles")
def list_profiles():
    return jsonify([profile_to_dict(r) for r in db.all_rows(
        "SELECT * FROM profiles WHERE user_id = :u ORDER BY id", u=uid())])


@app.post("/api/profiles")
def create_profile():
    data = request.get_json(silent=True) or {}
    name = clean_text(data.get("name"), 60)
    if not name:
        return jsonify(error="Profile name is required."), 400
    try:
        settings = sanitize_settings(data.get("settings") or {})
    except ValueError as error:
        return jsonify(error=str(error)), 400
    if db.one_row("SELECT COUNT(*) AS n FROM profiles WHERE user_id = :u", u=uid())["n"] >= MAX_PROFILES:
        return jsonify(error=f"You can have up to {MAX_PROFILES} profiles."), 400
    if db.one_row("SELECT 1 AS x FROM profiles WHERE user_id = :u AND name = :n", u=uid(), n=name):
        return jsonify(error="A profile with this name already exists."), 409
    new_id = db.insert_returning_id(
        "INSERT INTO profiles (user_id, name, data, is_active, created_at) "
        "VALUES (:u, :n, :d, 0, :t) RETURNING id", u=uid(), n=name, d=json.dumps(settings), t=db.now())
    return jsonify(profile_to_dict(get_profile(new_id))), 201


@app.put("/api/profiles/<int:profile_id>")
def update_profile(profile_id):
    data = request.get_json(silent=True) or {}
    row = get_profile(profile_id)
    if row is None:
        return jsonify(error="Profile not found."), 404
    name = clean_text(data.get("name"), 60) or row["name"]
    try:
        settings = sanitize_settings(data.get("settings") or {})
    except ValueError as error:
        return jsonify(error=str(error)), 400
    if db.one_row("SELECT 1 AS x FROM profiles WHERE user_id = :u AND name = :n AND id != :i",
                  u=uid(), n=name, i=profile_id):
        return jsonify(error="A profile with this name already exists."), 409
    db.run("UPDATE profiles SET name = :n, data = :d WHERE id = :i AND user_id = :u",
           n=name, d=json.dumps(settings), i=profile_id, u=uid())
    return jsonify(profile_to_dict(get_profile(profile_id)))


@app.post("/api/profiles/<int:profile_id>/activate")
def activate_profile(profile_id):
    if get_profile(profile_id) is None:
        return jsonify(error="Profile not found."), 404
    with db.engine.begin() as conn:
        conn.execute(db.text("UPDATE profiles SET is_active = 0 WHERE user_id = :u"), {"u": uid()})
        conn.execute(db.text("UPDATE profiles SET is_active = 1 WHERE id = :i AND user_id = :u"), {"i": profile_id, "u": uid()})
    return jsonify(profile_to_dict(get_profile(profile_id)))


@app.delete("/api/profiles/<int:profile_id>")
def delete_profile(profile_id):
    row = get_profile(profile_id)
    if row is None:
        return jsonify(error="Profile not found."), 404
    if db.one_row("SELECT COUNT(*) AS n FROM profiles WHERE user_id = :u", u=uid())["n"] <= 1:
        return jsonify(error="At least one profile must remain."), 400
    with db.engine.begin() as conn:
        conn.execute(db.text("DELETE FROM profiles WHERE id = :i AND user_id = :u"), {"i": profile_id, "u": uid()})
        if row["is_active"]:
            conn.execute(db.text(
                "UPDATE profiles SET is_active = 1 WHERE id = "
                "(SELECT id FROM profiles WHERE user_id = :u ORDER BY id LIMIT 1)"), {"u": uid()})
    return jsonify(message="Profile deleted.")


# --------------------------------------------------------------------------
# Teach a Sound: numeric fingerprints (YAMNet embeddings) of sounds the user taught
# --------------------------------------------------------------------------
def clean_embeddings(raw):
    """3-16 vectors of exactly 1024 finite numbers. Only fingerprints are stored, never audio."""
    if not isinstance(raw, list) or not 3 <= len(raw) <= 16:
        return None
    out = []
    for vec in raw:
        if not isinstance(vec, list) or len(vec) != EMBEDDING_DIM:
            return None
        try:
            nums = [round(float(x), 4) for x in vec]
        except (TypeError, ValueError):
            return None
        if any(x != x or abs(x) > 10 for x in nums):
            return None
        out.append(nums)
    return out


def custom_to_dict(row, with_embeddings=True):
    item = {"id": row["id"], "name": row["name"], "emoji": row["emoji"],
            "pattern": json.loads(row["pattern"]), "threshold": row["threshold"]}
    if with_embeddings:
        item["embeddings"] = json.loads(row["embeddings"])
    return item


def clean_threshold(value, default=0.8):
    try:
        return max(0.6, min(0.97, float(value)))
    except (TypeError, ValueError):
        return default


@app.get("/api/custom-sounds")
def list_custom_sounds():
    return jsonify([custom_to_dict(r) for r in db.all_rows(
        "SELECT * FROM custom_sounds WHERE user_id = :u ORDER BY id", u=uid())])


@app.post("/api/custom-sounds")
def add_custom_sound():
    data = request.get_json(silent=True) or {}
    name = clean_text(data.get("name"), 40)
    embeddings = clean_embeddings(data.get("embeddings"))
    if not name:
        return jsonify(error="Give the sound a name."), 400
    if embeddings is None:
        return jsonify(error="The sound samples are not valid. Record them again."), 400
    if db.one_row("SELECT COUNT(*) AS n FROM custom_sounds WHERE user_id = :u", u=uid())["n"] >= MAX_CUSTOM_SOUNDS:
        return jsonify(error=f"You can teach up to {MAX_CUSTOM_SOUNDS} sounds."), 400
    if db.one_row("SELECT 1 AS x FROM custom_sounds WHERE user_id = :u AND name = :n", u=uid(), n=name):
        return jsonify(error="You already taught a sound with this name."), 409
    emoji = data.get("emoji") if data.get("emoji") in SOUND_EMOJIS else "🔊"
    pattern = clean_pattern(data.get("pattern")) or [200, 100, 200]
    new_id = db.insert_returning_id(
        "INSERT INTO custom_sounds (user_id, name, emoji, pattern, threshold, embeddings, created_at) "
        "VALUES (:u, :n, :e, :p, :t, :v, :c) RETURNING id",
        u=uid(), n=name, e=emoji, p=json.dumps(pattern), t=clean_threshold(data.get("threshold")),
        v=json.dumps(embeddings), c=db.now())
    row = db.one_row("SELECT * FROM custom_sounds WHERE id = :i", i=new_id)
    return jsonify(custom_to_dict(row, with_embeddings=False)), 201


@app.put("/api/custom-sounds/<int:sound_id>")
def update_custom_sound(sound_id):
    data = request.get_json(silent=True) or {}
    row = db.one_row("SELECT * FROM custom_sounds WHERE id = :i AND user_id = :u", i=sound_id, u=uid())
    if row is None:
        return jsonify(error="Sound not found."), 404
    name = clean_text(data.get("name"), 40) or row["name"]
    if db.one_row("SELECT 1 AS x FROM custom_sounds WHERE user_id = :u AND name = :n AND id != :i", u=uid(), n=name, i=sound_id):
        return jsonify(error="You already taught a sound with this name."), 409
    pattern = clean_pattern(data.get("pattern")) or json.loads(row["pattern"])
    db.run("UPDATE custom_sounds SET name = :n, pattern = :p, threshold = :t WHERE id = :i AND user_id = :u",
           n=name, p=json.dumps(pattern), t=clean_threshold(data.get("threshold"), row["threshold"]), i=sound_id, u=uid())
    return jsonify(custom_to_dict(db.one_row("SELECT * FROM custom_sounds WHERE id = :i", i=sound_id), with_embeddings=False))


@app.delete("/api/custom-sounds/<int:sound_id>")
def delete_custom_sound(sound_id):
    if not db.run("DELETE FROM custom_sounds WHERE id = :i AND user_id = :u", i=sound_id, u=uid()):
        return jsonify(error="Sound not found."), 404
    return jsonify(message="Sound deleted.")


# --------------------------------------------------------------------------
# Account: guest -> registered, login, logout, export, delete
# --------------------------------------------------------------------------
@app.get("/api/account")
def account_info():
    return jsonify(public_account(g.user))


@app.post("/api/account/register")
def register():
    if rate_limited(f"register:{request.remote_addr}", 10, 3600):
        return jsonify(error="Too many attempts. Try again later."), 429
    if not g.user["is_guest"]:
        return jsonify(error="You already have an account."), 400
    data = request.get_json(silent=True) or {}
    email = clean_text(data.get("email"), 255).lower()
    name = clean_text(data.get("name"), 80)
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    if not EMAIL_RE.match(email):
        return jsonify(error="Enter a valid email address."), 400
    if not 8 <= len(password) <= 128:
        return jsonify(error="Password must be 8 to 128 characters."), 400
    try:
        db.run("UPDATE users SET email = :e, display_name = :n, password_hash = :p, is_guest = 0 WHERE id = :i",
               e=email, n=name, p=generate_password_hash(password), i=uid())
    except IntegrityError:
        return jsonify(error="An account with this email already exists."), 409
    user = db.one_row("SELECT id, email, display_name, is_guest FROM users WHERE id = :i", i=uid())
    return jsonify(public_account(user)), 201


@app.post("/api/account/login")
def login():
    data = request.get_json(silent=True) or {}
    email = clean_text(data.get("email"), 255).lower()
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    if rate_limited(f"login:{request.remote_addr}:{email}", 8, 900):
        return jsonify(error="Too many attempts. Please wait 15 minutes."), 429
    row = db.one_row("SELECT id, email, display_name, is_guest, password_hash, session_epoch FROM users WHERE email = :e", e=email)
    ok = check_password_hash(row["password_hash"] if row and row["password_hash"] else _DUMMY_HASH, password)
    if not (row and row["password_hash"] and ok):
        return jsonify(error="Wrong email or password."), 401
    session.clear()
    session["uid"], session["ep"] = row["id"], row["session_epoch"]
    session.permanent = True
    return jsonify(public_account(row))


@app.post("/api/account/logout")
def logout():
    session.clear()
    return jsonify(message="Signed out.")


RESET_MINUTES = 30
_FORGOT_MESSAGE = "If that email has an account, we have sent a reset link. It works for 30 minutes."


def _reset_base_url():
    base = os.environ.get("PULANOVA_BASE_URL", "").rstrip("/")
    if base:
        return base
    return None if IS_PRODUCTION else request.url_root.rstrip("/")   # never trust the Host header in production


@app.post("/api/account/forgot")
def forgot_password():
    data = request.get_json(silent=True) or {}
    email = clean_text(data.get("email"), 255).lower()
    if rate_limited(f"forgot-ip:{request.remote_addr}", 5, 3600):
        return jsonify(error="Too many requests. Try again later."), 429
    # Same answer whether or not the address exists, so nobody can probe for accounts.
    if not EMAIL_RE.match(email) or rate_limited(f"forgot-mail:{email}", 3, 3600):
        return jsonify(message=_FORGOT_MESSAGE)
    user = db.one_row("SELECT id FROM users WHERE email = :e AND password_hash IS NOT NULL", e=email)
    if user:
        base = _reset_base_url()
        if base is None:
            app.logger.error("Set PULANOVA_BASE_URL (for example https://your-app.onrender.com) to send reset links.")
        else:
            token = secrets.token_urlsafe(32)
            with db.engine.begin() as conn:
                conn.execute(db.text("DELETE FROM password_resets WHERE user_id = :u OR expires_at < :n"), {"u": user["id"], "n": db.now()})
                conn.execute(db.text("INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (:u, :h, :x, :t)"),
                             {"u": user["id"], "h": hashlib.sha256(token.encode()).hexdigest(), "x": db.later(RESET_MINUTES), "t": db.now()})
            link = f"{base}/reset?token={token}"
            body = ("Hello,\n\nSomeone asked to reset the password for your PULANOVA AI account. "
                    f"Open this link within {RESET_MINUTES} minutes to choose a new password:\n\n{link}\n\n"
                    "If this was not you, ignore this email. Your password stays the same.\n")
            if mailer.configured():
                mailer.send_async(email, "Reset your PULANOVA AI password", body)
            elif not IS_PRODUCTION:
                app.logger.warning("Email is not configured. Password reset link for %s: %s", email, link)
            else:
                app.logger.error("Email is not configured (set BREVO_API_KEY and MAIL_FROM). Reset email not sent.")
    return jsonify(message=_FORGOT_MESSAGE)


@app.post("/api/account/reset")
def reset_password():
    data = request.get_json(silent=True) or {}
    token = data.get("token") if isinstance(data.get("token"), str) else ""
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    if rate_limited(f"reset:{request.remote_addr}", 10, 900):
        return jsonify(error="Too many attempts. Try again later."), 429
    if not 8 <= len(password) <= 128:
        return jsonify(error="Password must be 8 to 128 characters."), 400
    row = db.one_row("SELECT user_id FROM password_resets WHERE token_hash = :h AND expires_at >= :n",
                     h=hashlib.sha256(token.encode()).hexdigest(), n=db.now())
    if row is None:
        return jsonify(error="This reset link is invalid or has expired. Request a new one."), 400
    with db.engine.begin() as conn:
        conn.execute(db.text("UPDATE users SET password_hash = :p, session_epoch = session_epoch + 1 WHERE id = :u"),
                     {"p": generate_password_hash(password), "u": row["user_id"]})
        conn.execute(db.text("DELETE FROM password_resets WHERE user_id = :u"), {"u": row["user_id"]})
    session.clear()      # every device is signed out; sign in again with the new password
    return jsonify(message="Password changed. Please sign in with your new password.")


@app.get("/api/account/export")
def export_data():
    return jsonify(
        account=public_account(g.user),
        profiles=[profile_to_dict(r) for r in db.all_rows("SELECT * FROM profiles WHERE user_id = :u ORDER BY id", u=uid())],
        contacts=db.all_rows("SELECT name, phone, relationship, is_primary FROM contacts WHERE user_id = :u ORDER BY id", u=uid()),
        events=db.all_rows("SELECT event_type, message, severity, created_at FROM events WHERE user_id = :u ORDER BY id", u=uid()),
        custom_sounds=db.all_rows("SELECT name, emoji, threshold, created_at FROM custom_sounds WHERE user_id = :u ORDER BY id", u=uid()))


@app.delete("/api/account")
def delete_account():
    data = request.get_json(silent=True) or {}
    if not g.user["is_guest"]:
        row = db.one_row("SELECT password_hash FROM users WHERE id = :i", i=uid())
        if not check_password_hash(row["password_hash"], data.get("password") if isinstance(data.get("password"), str) else ""):
            return jsonify(error="Wrong password."), 401
    with db.engine.begin() as conn:
        for table in ("events", "contacts", "profiles", "password_resets", "custom_sounds"):
            conn.execute(db.text(f"DELETE FROM {table} WHERE user_id = :u"), {"u": uid()})
        conn.execute(db.text("DELETE FROM users WHERE id = :u"), {"u": uid()})
    session.clear()
    return jsonify(message="Account and all data deleted.")


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="Request is too large."), 413


if __name__ == "__main__":
    # Local development: http://127.0.0.1:5000
    # Phone testing needs HTTPS for camera/microphone:
    #   PowerShell:  $env:PULANOVA_HTTPS="1"; python app.py   (pip install cryptography)
    use_https = os.environ.get("PULANOVA_HTTPS") == "1"
    app.run(host="0.0.0.0" if use_https else "127.0.0.1", port=int(os.environ.get("PORT", "5000")),
            debug=not IS_PRODUCTION, ssl_context="adhoc" if use_https else None)
