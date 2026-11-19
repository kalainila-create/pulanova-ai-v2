"""Database layer.

Works with SQLite on your own computer and with PostgreSQL when the DATABASE_URL
environment variable is set (Neon, Supabase, Render Postgres ...). Every row that
belongs to a person carries a user_id, and every query filters by it.
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from datetime import timedelta

from sqlalchemy import (Column, Float, ForeignKey, Index, Integer, MetaData, String, Table,
                        Text, UniqueConstraint, create_engine, event, inspect, text)

# ---------------------------------------------------------------------------
# Default accessibility settings (copied into every new profile).
# Vibration patterns are milliseconds: vibrate, pause, vibrate, pause ...
# ---------------------------------------------------------------------------
DEFAULT_PATTERNS = {
    "doorbell":  [150, 100, 150],
    "horn":      [100, 70, 100, 70, 100],
    "emergency": [450, 120, 450, 120, 450, 120, 450],
    "speech":    [650],
    "knock":     [90, 60, 90, 60, 90, 60, 90],
    "phone":     [250, 150, 250, 150, 250],
    "alarm":     [450, 120, 450, 120, 450, 120, 450],
    "dog":       [120, 80, 320],
    "baby":      [320, 80, 120],
    "ok":        [90, 60, 90],
}

DEFAULT_SETTINGS = {
    "needs": {"vision": False, "hearing": False},
    "language": "en", "fontScale": 100, "contrast": False,
    "voiceFirst": False, "autoAnnounce": False, "speechRate": 1.0,
    "flash": True, "vibrate": True, "beepFallback": True, "brailleMode": False,
    "captionSize": "large", "helpMessage": "I may need assistance.",
    "sounds": {k: True for k in ["doorbell", "horn", "emergency", "speech", "knock", "phone", "dog", "baby"]},
    "patterns": DEFAULT_PATTERNS, "tactileMessages": [],
}


def _preset(name, **changes):
    data = json.loads(json.dumps(DEFAULT_SETTINGS))
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(data.get(key), dict):
            data[key].update(value)
        else:
            data[key] = value
    return name, data


PRESET_PROFILES = [
    _preset("Everyday (default)"),
    _preset("Visually challenged", needs={"vision": True}, voiceFirst=True, autoAnnounce=True,
            fontScale=120, speechRate=0.95),
    _preset("Hearing impaired", needs={"hearing": True}, captionSize="xlarge", fontScale=110),
    _preset("Deafblind", needs={"vision": True, "hearing": True}, brailleMode=True, fontScale=130,
            contrast=True,
            helpMessage="I am deafblind and may need help. Please contact my emergency contact."),
]

# ---------------------------------------------------------------------------
# Tables (portable between SQLite and PostgreSQL)
# ---------------------------------------------------------------------------
metadata = MetaData()
users = Table(
    "users", metadata,
    Column("id", Integer, primary_key=True),
    Column("email", String(255), unique=True, nullable=True),
    Column("display_name", String(80), nullable=False, default=""),
    Column("password_hash", String(255), nullable=True),
    Column("is_guest", Integer, nullable=False, default=1),
    Column("session_epoch", Integer, nullable=False, default=0, server_default="0"),
    Column("created_at", String(19), nullable=False),
)
password_resets = Table(
    "password_resets", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("token_hash", String(64), nullable=False, unique=True),
    Column("expires_at", String(19), nullable=False),
    Column("created_at", String(19), nullable=False),
    Index("ix_resets_user", "user_id"),
)
contacts = Table(
    "contacts", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("name", String(80), nullable=False),
    Column("phone", String(30), nullable=False),
    Column("relationship", String(60), nullable=False, default=""),
    Column("is_primary", Integer, nullable=False, default=0),
    Column("created_at", String(19), nullable=False),
    Index("ix_contacts_user", "user_id"),
)
events = Table(
    "events", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("event_type", String(40), nullable=False),
    Column("message", String(240), nullable=False),
    Column("severity", String(20), nullable=False, default="info"),
    Column("created_at", String(19), nullable=False),
    Index("ix_events_user", "user_id"),
)
custom_sounds = Table(
    "custom_sounds", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("name", String(40), nullable=False),
    Column("emoji", String(8), nullable=False, default="🔊"),
    Column("pattern", Text, nullable=False),
    Column("threshold", Float, nullable=False, default=0.8),
    Column("embeddings", Text, nullable=False),          # numeric sound fingerprints, never audio
    Column("created_at", String(19), nullable=False),
    UniqueConstraint("user_id", "name", name="uq_custom_user_name"),
    Index("ix_custom_user", "user_id"),
)
profiles = Table(
    "profiles", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("name", String(60), nullable=False),
    Column("data", Text, nullable=False),
    Column("is_active", Integer, nullable=False, default=0),
    Column("created_at", String(19), nullable=False),
    UniqueConstraint("user_id", "name", name="uq_profile_user_name"),
    Index("ix_profiles_user", "user_id"),
)

engine = None


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def later(minutes):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")


def database_url(base_dir):
    url = os.environ.get("DATABASE_URL", "").strip()
    if url:
        # Hosts hand out postgres:// or postgresql://; we always use the psycopg2 driver we install.
        for prefix in ("postgres://", "postgresql://"):
            if url.startswith(prefix):
                url = "postgresql+psycopg2://" + url[len(prefix):]
                break
        return url
    path = Path(base_dir) / "instance" / "pulanova_v2.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    return "sqlite:///" + str(path).replace("\\", "/")


def init_app(app, base_dir):
    global engine
    url = database_url(base_dir)
    kwargs = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _fk(dbapi_connection, _record):
            dbapi_connection.execute("PRAGMA foreign_keys = ON")
    metadata.create_all(engine)
    # Upgrade a version-2 database created before password reset existed.
    if "session_epoch" not in {c["name"] for c in inspect(engine).get_columns("users")}:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0"))
    app.config["DB_KIND"] = "sqlite" if url.startswith("sqlite") else "postgresql"


# Small helpers: every call is its own transaction.
def all_rows(sql, **params):
    with engine.begin() as conn:
        return [dict(r._mapping) for r in conn.execute(text(sql), params)]


def one_row(sql, **params):
    rows = all_rows(sql, **params)
    return rows[0] if rows else None


def run(sql, **params):
    with engine.begin() as conn:
        return conn.execute(text(sql), params).rowcount


def insert_returning_id(sql, **params):
    """sql must end with RETURNING id (works on SQLite 3.35+ and PostgreSQL)."""
    with engine.begin() as conn:
        return conn.execute(text(sql), params).scalar()


def seed_profiles(user_id):
    with engine.begin() as conn:
        for index, (name, data) in enumerate(PRESET_PROFILES):
            conn.execute(
                text("INSERT INTO profiles (user_id, name, data, is_active, created_at) "
                     "VALUES (:u, :n, :d, :a, :t)"),
                {"u": user_id, "n": name, "d": json.dumps(data), "a": 1 if index == 0 else 0, "t": now()},
            )


def create_user(email=None, display_name="", password_hash=None, is_guest=True):
    uid = insert_returning_id(
        "INSERT INTO users (email, display_name, password_hash, is_guest, created_at) "
        "VALUES (:e, :n, :p, :g, :t) RETURNING id",
        e=email, n=display_name, p=password_hash, g=1 if is_guest else 0, t=now())
    seed_profiles(uid)
    return uid
