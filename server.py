from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote_plus, unquote, urlencode, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "booking.db"
SESSION_COOKIE_NAME = "studio_session"
SESSION_DURATION_DAYS = 7

SERVICES = [
    "Restructuration des sourcils",
    "Epilation au henne",
    "Extensions de cils",
    "Micropigmentation",
    "Rehaussement des sourcils",
]

LOCATIONS = ["RDV ORLEANS", "RDV MILLAU"]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    return utc_now().isoformat()


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def transaction() -> Any:
    conn = db_connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    use_salt = salt or secrets.token_bytes(16)
    hashed = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), use_salt, 240_000)
    return base64.b64encode(use_salt).decode("ascii"), base64.b64encode(hashed).decode("ascii")


def verify_password(password: str, salt_b64: str, hash_b64: str) -> bool:
    salt = base64.b64decode(salt_b64.encode("ascii"))
    _, candidate_hash = hash_password(password, salt)
    return hmac.compare_digest(candidate_hash, hash_b64)


def init_db() -> None:
    ensure_data_dir()
    with db_connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL CHECK (role IN ('client', 'admin')),
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                phone TEXT,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS slots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'booked')),
                note TEXT DEFAULT '',
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(date, time)
            );

            CREATE TABLE IF NOT EXISTS appointments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
                client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                service TEXT NOT NULL,
                location TEXT NOT NULL,
                phone TEXT NOT NULL,
                notes TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
                whatsapp_status TEXT DEFAULT 'pending',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_active_appointment_slot
            ON appointments(slot_id) WHERE status = 'confirmed';
            """
        )

    seed_admin_account()


def seed_admin_account() -> None:
    admin_email = os.environ.get("BOOKING_ADMIN_EMAIL", "admin@studio.local")
    admin_password = os.environ.get("BOOKING_ADMIN_PASSWORD", "Admin123!")
    admin_name = os.environ.get("BOOKING_ADMIN_NAME", "Studio Admin")

    with db_connect() as conn:
        existing = conn.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1").fetchone()
        if existing:
            return

        salt, password_hash = hash_password(admin_password)
        conn.execute(
            """
            INSERT INTO users (role, name, email, phone, password_salt, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("admin", admin_name, admin_email, "", salt, password_hash, utc_now_iso()),
        )
        conn.commit()

    print(
        f"[studio-booking] Admin initial cree: {admin_email} / {admin_password}",
        file=sys.stderr,
    )


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


def clean_expired_sessions() -> None:
    now_iso = utc_now_iso()
    with db_connect() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_iso,))
        conn.commit()


def create_session(user_id: int) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    expires_at = (utc_now() + timedelta(days=SESSION_DURATION_DAYS)).isoformat()
    with db_connect() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (token, user_id, expires_at, utc_now_iso()),
        )
        conn.commit()
    return token, expires_at


def get_user_from_session(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None

    clean_expired_sessions()

    with db_connect() as conn:
        row = conn.execute(
            """
            SELECT users.id, users.role, users.name, users.email, users.phone, users.created_at
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token = ?
            """,
            (token,),
        ).fetchone()
        return row_to_dict(row)


def delete_session(token: str | None) -> None:
    if not token:
        return
    with db_connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()


def register_account(name: str, email: str, phone: str, password: str) -> tuple[dict[str, Any], str, str]:
    clean_name = str(name).strip()
    clean_email = str(email).strip().lower()
    clean_phone = str(phone).strip()
    clean_password = str(password)

    if len(clean_name) < 2 or "@" not in clean_email or len(clean_password) < 8:
        raise ValueError(
            "Veuillez fournir un nom, un email valide et un mot de passe d'au moins 8 caracteres."
        )

    salt, password_hash = hash_password(clean_password)

    try:
        with db_connect() as conn:
            conn.execute(
                """
                INSERT INTO users (role, name, email, phone, password_salt, password_hash, created_at)
                VALUES ('client', ?, ?, ?, ?, ?, ?)
                """,
                (clean_name, clean_email, clean_phone, salt, password_hash, utc_now_iso()),
            )
            user_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            conn.commit()
    except sqlite3.IntegrityError as exc:
        raise sqlite3.IntegrityError("Un compte existe deja avec cet email.") from exc

    token, expires_at = create_session(int(user_id))
    user = get_user_from_session(token)
    return user or {}, token, expires_at


def login_account(email: str, password: str) -> tuple[dict[str, Any], str, str]:
    clean_email = str(email).strip().lower()
    clean_password = str(password)

    with db_connect() as conn:
        row = conn.execute(
            "SELECT id, password_salt, password_hash FROM users WHERE email = ?",
            (clean_email,),
        ).fetchone()

    if row is None or not verify_password(clean_password, row["password_salt"], row["password_hash"]):
        raise PermissionError("Identifiants invalides.")

    token, expires_at = create_session(int(row["id"]))
    user = get_user_from_session(token)
    return user or {}, token, expires_at


def format_whatsapp_message(appointment: dict[str, Any]) -> str:
    return (
        "Bonjour, votre rendez-vous est confirme.\n\n"
        f"Service: {appointment['service']}\n"
        f"Lieu: {appointment['location']}\n"
        f"Date: {appointment['date']}\n"
        f"Heure: {appointment['time']}\n"
        f"Cliente: {appointment['client_name']}"
    )


def current_whatsapp_provider() -> str:
    if os.environ.get("META_WHATSAPP_TOKEN") and os.environ.get("META_WHATSAPP_PHONE_NUMBER_ID"):
        return "meta"
    if (
        os.environ.get("TWILIO_ACCOUNT_SID")
        and os.environ.get("TWILIO_AUTH_TOKEN")
        and os.environ.get("TWILIO_WHATSAPP_FROM")
    ):
        return "twilio"
    return "none"


def send_meta_whatsapp_message(phone: str, appointment: dict[str, Any], body: str) -> str:
    token = os.environ.get("META_WHATSAPP_TOKEN")
    phone_number_id = os.environ.get("META_WHATSAPP_PHONE_NUMBER_ID")
    api_version = os.environ.get("META_WHATSAPP_API_VERSION", "v17.0")
    template_name = os.environ.get("META_WHATSAPP_TEMPLATE_NAME", "").strip()
    template_language = os.environ.get("META_WHATSAPP_TEMPLATE_LANG", "fr")

    if not (token and phone_number_id):
        return "skipped"

    if template_name:
        payload: dict[str, Any] = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": phone,
            "type": "template",
            "template": {
                "name": template_name,
                "language": {"code": template_language},
                "components": [
                    {
                        "type": "body",
                        "parameters": [
                            {"type": "text", "text": appointment["date"]},
                            {"type": "text", "text": appointment["time"]},
                            {"type": "text", "text": appointment["service"]},
                            {"type": "text", "text": appointment["location"]},
                        ],
                    }
                ],
            },
        }
    else:
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": phone,
            "type": "text",
            "text": {
                "preview_url": False,
                "body": body,
            },
        }

    request = Request(
        f"https://graph.facebook.com/{api_version}/{phone_number_id}/messages",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urlopen(request, timeout=10) as response:
            if 200 <= response.status < 300:
                return "sent"
    except Exception:
        return "failed"

    return "failed"


def send_twilio_whatsapp_message(phone: str, body: str) -> str:
    account_sid = os.environ.get("TWILIO_ACCOUNT_SID")
    auth_token = os.environ.get("TWILIO_AUTH_TOKEN")
    from_number = os.environ.get("TWILIO_WHATSAPP_FROM")

    if not (account_sid and auth_token and from_number):
        return "skipped"

    payload = urlencode(
        {
            "To": f"whatsapp:{phone}",
            "From": f"whatsapp:{from_number}",
            "Body": body,
        }
    ).encode("utf-8")

    request = Request(
        f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json",
        data=payload,
        method="POST",
        headers={
            "Authorization": "Basic "
            + base64.b64encode(f"{account_sid}:{auth_token}".encode("utf-8")).decode("ascii"),
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )

    try:
        with urlopen(request, timeout=10) as response:
            if 200 <= response.status < 300:
                return "sent"
    except Exception:
        return "failed"

    return "failed"


def send_whatsapp_message(phone: str, appointment: dict[str, Any]) -> str:
    body = format_whatsapp_message(appointment)
    provider = current_whatsapp_provider()

    if provider == "meta":
        return send_meta_whatsapp_message(phone, appointment, body)
    if provider == "twilio":
        return send_twilio_whatsapp_message(phone, body)
    return "skipped"


def fetch_appointment_snapshot(conn: sqlite3.Connection, appointment_id: int) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT
            appointments.id,
            appointments.service,
            appointments.location,
            appointments.phone,
            appointments.notes,
            appointments.status,
            appointments.whatsapp_status,
            appointments.created_at,
            appointments.updated_at,
            users.name AS client_name,
            users.email AS client_email,
            slots.date,
            slots.time,
            slots.id AS slot_id
        FROM appointments
        JOIN users ON users.id = appointments.client_id
        JOIN slots ON slots.id = appointments.slot_id
        WHERE appointments.id = ?
        """,
        (appointment_id,),
    ).fetchone()
    if row is None:
        raise ValueError("Appointment not found")
    return row_to_dict(row) or {}


def parse_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length) if length else b"{}"
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def parse_form_data(handler: BaseHTTPRequestHandler) -> dict[str, str]:
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length) if length else b""
    if not raw:
        return {}
    parsed = parse_qs(raw.decode("utf-8"), keep_blank_values=True)
    return {key: values[-1] if values else "" for key, values in parsed.items()}


def is_valid_date(date_value: str) -> bool:
    try:
        datetime.strptime(date_value, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def is_valid_time(time_value: str) -> bool:
    try:
        datetime.strptime(time_value, "%H:%M")
        return True
    except ValueError:
        return False


def load_cookie_token(handler: BaseHTTPRequestHandler) -> str | None:
    raw_cookie = handler.headers.get("Cookie")
    if not raw_cookie:
        return None
    cookie = SimpleCookie()
    cookie.load(raw_cookie)
    morsel = cookie.get(SESSION_COOKIE_NAME)
    return morsel.value if morsel else None


class AppHandler(BaseHTTPRequestHandler):
    server_version = "StudioBooking/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, payload: dict[str, Any], status: int = 200, extra_headers: dict[str, str] | None = None) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"ok": False, "error": message}, status=status)

    def send_redirect(
        self,
        location: str,
        extra_headers: dict[str, str] | None = None,
        status: int = HTTPStatus.SEE_OTHER,
    ) -> None:
        self.send_response(status)
        self.send_header("Location", location)
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()

    def current_user(self) -> dict[str, Any] | None:
        return get_user_from_session(load_cookie_token(self))

    def require_user(self) -> dict[str, Any] | None:
        user = self.current_user()
        if not user:
            self.send_error_json(HTTPStatus.UNAUTHORIZED, "Authentification requise.")
            return None
        return user

    def require_admin(self) -> dict[str, Any] | None:
        user = self.require_user()
        if not user:
            return None
        if user["role"] != "admin":
            self.send_error_json(HTTPStatus.FORBIDDEN, "Acces administrateur requis.")
            return None
        return user

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self.send_json({"ok": True, "status": "healthy"})
            return

        if path == "/api/config":
            self.send_json(
                {
                    "ok": True,
                    "services": SERVICES,
                    "locations": LOCATIONS,
                    "whatsappConfigured": current_whatsapp_provider() != "none",
                    "whatsappProvider": current_whatsapp_provider(),
                }
            )
            return

        if path == "/api/auth/me":
            user = self.current_user()
            if not user:
                self.send_json({"ok": True, "user": None})
                return
            self.send_json({"ok": True, "user": user})
            return

        if path == "/api/slots":
            user = self.require_user()
            if not user:
                return
            self.handle_get_slots(parsed)
            return

        if path == "/api/appointments":
            user = self.require_user()
            if not user:
                return
            self.handle_get_appointments(user)
            return

        if path == "/api/admin/slots":
            user = self.require_admin()
            if not user:
                return
            self.handle_get_admin_slots()
            return

        self.serve_static(path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/auth/register":
            self.handle_register()
            return

        if path == "/api/auth/login":
            self.handle_login()
            return

        if path == "/auth/login-form":
            self.handle_login_form()
            return

        if path == "/auth/register-form":
            self.handle_register_form()
            return

        if path == "/api/auth/logout":
            self.handle_logout()
            return

        if path == "/api/appointments":
            user = self.require_user()
            if not user:
                return
            self.handle_create_appointment(user)
            return

        if path == "/api/admin/slots":
            user = self.require_admin()
            if not user:
                return
            self.handle_create_slots(user)
            return

        self.send_error_json(HTTPStatus.NOT_FOUND, "Endpoint introuvable.")

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/appointments/"):
            user = self.require_user()
            if not user:
                return
            self.handle_client_appointment_action(user, path)
            return

        if path.startswith("/api/admin/slots/"):
            user = self.require_admin()
            if not user:
                return
            self.handle_update_slot(path)
            return

        if path.startswith("/api/admin/appointments/"):
            user = self.require_admin()
            if not user:
                return
            self.handle_admin_appointment_action(path)
            return

        self.send_error_json(HTTPStatus.NOT_FOUND, "Endpoint introuvable.")

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/admin/slots/"):
            user = self.require_admin()
            if not user:
                return
            self.handle_delete_slot(path)
            return

        self.send_error_json(HTTPStatus.NOT_FOUND, "Endpoint introuvable.")

    def serve_static(self, path: str) -> None:
        relative = "index.html" if path == "/" else unquote(path.lstrip("/"))
        target = (ROOT / relative).resolve()
        if ROOT not in target.parents and target != ROOT:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Fichier introuvable.")
            return

        if not target.exists() or not target.is_file():
            self.send_error_json(HTTPStatus.NOT_FOUND, "Fichier introuvable.")
            return

        content = target.read_bytes()
        mime, _ = mimetypes.guess_type(str(target))
        self.send_response(200)
        self.send_header("Content-Type", f"{mime or 'application/octet-stream'}")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def handle_register(self) -> None:
        try:
            payload = parse_json(self)
        except json.JSONDecodeError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "JSON invalide.")
            return

        try:
            user, token, expires_at = register_account(
                str(payload.get("name", "")),
                str(payload.get("email", "")),
                str(payload.get("phone", "")),
                str(payload.get("password", "")),
            )
        except ValueError as exc:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
            return
        except sqlite3.IntegrityError as exc:
            self.send_error_json(HTTPStatus.CONFLICT, str(exc))
            return

        headers = {
            "Set-Cookie": (
                f"{SESSION_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; "
                f"Max-Age={SESSION_DURATION_DAYS * 24 * 60 * 60}"
            )
        }
        self.send_json({"ok": True, "user": user, "expiresAt": expires_at}, extra_headers=headers)

    def handle_login(self) -> None:
        try:
            payload = parse_json(self)
        except json.JSONDecodeError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "JSON invalide.")
            return
        try:
            user, token, expires_at = login_account(
                str(payload.get("email", "")),
                str(payload.get("password", "")),
            )
        except PermissionError as exc:
            self.send_error_json(HTTPStatus.UNAUTHORIZED, str(exc))
            return

        headers = {
            "Set-Cookie": (
                f"{SESSION_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; "
                f"Max-Age={SESSION_DURATION_DAYS * 24 * 60 * 60}"
            )
        }
        self.send_json({"ok": True, "user": user, "expiresAt": expires_at}, extra_headers=headers)

    def handle_login_form(self) -> None:
        payload = parse_form_data(self)
        try:
            _, token, _ = login_account(
                payload.get("email", ""),
                payload.get("password", ""),
            )
        except PermissionError:
            self.send_redirect("/?authError=Identifiants%20invalides.&authMode=login")
            return

        headers = {
            "Set-Cookie": (
                f"{SESSION_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; "
                f"Max-Age={SESSION_DURATION_DAYS * 24 * 60 * 60}"
            )
        }
        self.send_redirect("/portal.html", extra_headers=headers)

    def handle_register_form(self) -> None:
        payload = parse_form_data(self)
        try:
            _, token, _ = register_account(
                payload.get("name", ""),
                payload.get("email", ""),
                payload.get("phone", ""),
                payload.get("password", ""),
            )
        except ValueError as exc:
            self.send_redirect(f"/?authError={quote_plus(str(exc))}&authMode=register")
            return
        except sqlite3.IntegrityError:
            self.send_redirect(
                "/?authError=Ce%20compte%20existe%20deja.%20Utilisez%20l%27onglet%20Login.&authMode=register"
            )
            return

        headers = {
            "Set-Cookie": (
                f"{SESSION_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; "
                f"Max-Age={SESSION_DURATION_DAYS * 24 * 60 * 60}"
            )
        }
        self.send_redirect("/portal.html", extra_headers=headers)

    def handle_logout(self) -> None:
        token = load_cookie_token(self)
        delete_session(token)
        self.send_json(
            {"ok": True},
            extra_headers={
                "Set-Cookie": f"{SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax"
            },
        )

    def handle_get_slots(self, parsed: Any) -> None:
        query = parse_qs(parsed.query)
        date_from = query.get("dateFrom", [utc_now().date().isoformat()])[0]

        with db_connect() as conn:
            rows = conn.execute(
                """
                SELECT id, date, time, status, note, created_at, updated_at
                FROM slots
                WHERE date >= ?
                ORDER BY date ASC, time ASC
                """,
                (date_from,),
            ).fetchall()

        slots = [row_to_dict(row) for row in rows]
        self.send_json({"ok": True, "slots": slots})

    def handle_get_appointments(self, user: dict[str, Any]) -> None:
        with db_connect() as conn:
            if user["role"] == "admin":
                rows = conn.execute(
                    """
                    SELECT
                        appointments.id,
                        appointments.service,
                        appointments.location,
                        appointments.phone,
                        appointments.notes,
                        appointments.status,
                        appointments.whatsapp_status,
                        appointments.created_at,
                        appointments.updated_at,
                        users.name AS client_name,
                        users.email AS client_email,
                        slots.date,
                        slots.time,
                        slots.id AS slot_id
                    FROM appointments
                    JOIN users ON users.id = appointments.client_id
                    JOIN slots ON slots.id = appointments.slot_id
                    ORDER BY slots.date ASC, slots.time ASC
                    """
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT
                        appointments.id,
                        appointments.service,
                        appointments.location,
                        appointments.phone,
                        appointments.notes,
                        appointments.status,
                        appointments.whatsapp_status,
                        appointments.created_at,
                        appointments.updated_at,
                        slots.date,
                        slots.time,
                        slots.id AS slot_id
                    FROM appointments
                    JOIN slots ON slots.id = appointments.slot_id
                    WHERE appointments.client_id = ?
                    ORDER BY slots.date ASC, slots.time ASC
                    """,
                    (user["id"],),
                ).fetchall()

        self.send_json({"ok": True, "appointments": [row_to_dict(row) for row in rows]})

    def handle_get_admin_slots(self) -> None:
        with db_connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    slots.id,
                    slots.date,
                    slots.time,
                    slots.status,
                    slots.note,
                    slots.created_at,
                    slots.updated_at,
                    appointments.id AS appointment_id,
                    appointments.status AS appointment_status,
                    appointments.service AS appointment_service
                FROM slots
                LEFT JOIN appointments
                  ON appointments.slot_id = slots.id
                 AND appointments.status = 'confirmed'
                ORDER BY slots.date ASC, slots.time ASC
                """
            ).fetchall()

        self.send_json({"ok": True, "slots": [row_to_dict(row) for row in rows]})

    def handle_create_slots(self, user: dict[str, Any]) -> None:
        try:
            payload = parse_json(self)
        except json.JSONDecodeError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "JSON invalide.")
            return

        date_value = str(payload.get("date", "")).strip()
        times = payload.get("times") or []
        note = str(payload.get("note", "")).strip()

        if not is_valid_date(date_value) or not isinstance(times, list) or not times:
            self.send_error_json(
                HTTPStatus.BAD_REQUEST,
                "Veuillez fournir une date valide et au moins un horaire.",
            )
            return

        normalized_times = sorted({time for time in times if is_valid_time(str(time))})
        if not normalized_times:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Aucun horaire valide fourni.")
            return

        created_slots = []
        duplicates = []
        with db_connect() as conn:
            for time_value in normalized_times:
                try:
                    conn.execute(
                        """
                        INSERT INTO slots (date, time, status, note, created_by, created_at, updated_at)
                        VALUES (?, ?, 'available', ?, ?, ?, ?)
                        """,
                        (date_value, time_value, note, user["id"], utc_now_iso(), utc_now_iso()),
                    )
                    created_slots.append({"date": date_value, "time": time_value})
                except sqlite3.IntegrityError:
                    duplicates.append(time_value)
            conn.commit()

        self.send_json({"ok": True, "created": created_slots, "duplicates": duplicates})

    def handle_create_appointment(self, user: dict[str, Any]) -> None:
        try:
            payload = parse_json(self)
        except json.JSONDecodeError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "JSON invalide.")
            return

        slot_id = int(payload.get("slotId", 0) or 0)
        service = str(payload.get("service", "")).strip()
        location = str(payload.get("location", "")).strip()
        phone = str(payload.get("phone", "")).strip() or str(user.get("phone", "")).strip()
        notes = str(payload.get("notes", "")).strip()

        if slot_id <= 0 or service not in SERVICES or location not in LOCATIONS or len(phone) < 6:
            self.send_error_json(
                HTTPStatus.BAD_REQUEST,
                "Veuillez selectionner un creneau, une prestation, un lieu et un numero WhatsApp valides.",
            )
            return

        try:
            with transaction() as conn:
                slot = conn.execute(
                    "SELECT id, date, time, status FROM slots WHERE id = ?",
                    (slot_id,),
                ).fetchone()
                if slot is None:
                    self.send_error_json(HTTPStatus.NOT_FOUND, "Creneau introuvable.")
                    return
                if slot["status"] != "available":
                    self.send_error_json(HTTPStatus.CONFLICT, "Ce creneau n'est plus disponible.")
                    return

                conn.execute(
                    """
                    INSERT INTO appointments (
                        slot_id, client_id, service, location, phone, notes, status,
                        whatsapp_status, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'pending', ?, ?)
                    """,
                    (slot_id, user["id"], service, location, phone, notes, utc_now_iso(), utc_now_iso()),
                )
                appointment_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                conn.execute(
                    "UPDATE slots SET status = 'booked', updated_at = ? WHERE id = ?",
                    (utc_now_iso(), slot_id),
                )
                appointment = fetch_appointment_snapshot(conn, int(appointment_id))
        except sqlite3.IntegrityError:
            self.send_error_json(HTTPStatus.CONFLICT, "Ce creneau est deja reserve.")
            return

        whatsapp_status = send_whatsapp_message(phone, appointment)
        with db_connect() as conn:
            conn.execute(
                "UPDATE appointments SET whatsapp_status = ?, updated_at = ? WHERE id = ?",
                (whatsapp_status, utc_now_iso(), appointment["id"]),
            )
            conn.commit()

        appointment["whatsapp_status"] = whatsapp_status
        self.send_json({"ok": True, "appointment": appointment}, status=HTTPStatus.CREATED)

    def handle_client_appointment_action(self, user: dict[str, Any], path: str) -> None:
        path_parts = path.strip("/").split("/")
        if len(path_parts) != 4 or path_parts[3] != "cancel":
            self.send_error_json(HTTPStatus.NOT_FOUND, "Action introuvable.")
            return

        appointment_id = int(path_parts[2])
        with transaction() as conn:
            appointment = conn.execute(
                """
                SELECT id, slot_id, client_id, status
                FROM appointments
                WHERE id = ?
                """,
                (appointment_id,),
            ).fetchone()
            if appointment is None:
                self.send_error_json(HTTPStatus.NOT_FOUND, "Rendez-vous introuvable.")
                return
            if user["role"] != "admin" and appointment["client_id"] != user["id"]:
                self.send_error_json(HTTPStatus.FORBIDDEN, "Action non autorisee.")
                return
            if appointment["status"] == "cancelled":
                self.send_json({"ok": True})
                return

            conn.execute(
                "UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?",
                (utc_now_iso(), appointment_id),
            )
            conn.execute(
                "UPDATE slots SET status = 'available', updated_at = ? WHERE id = ?",
                (utc_now_iso(), appointment["slot_id"]),
            )

        self.send_json({"ok": True})

    def handle_update_slot(self, path: str) -> None:
        slot_id = int(path.rsplit("/", 1)[-1])
        try:
            payload = parse_json(self)
        except json.JSONDecodeError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "JSON invalide.")
            return

        date_value = str(payload.get("date", "")).strip()
        time_value = str(payload.get("time", "")).strip()
        note = str(payload.get("note", "")).strip()

        if not is_valid_date(date_value) or not is_valid_time(time_value):
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Date ou horaire invalide.")
            return

        try:
            with transaction() as conn:
                existing = conn.execute(
                    "SELECT id, status FROM slots WHERE id = ?",
                    (slot_id,),
                ).fetchone()
                if existing is None:
                    self.send_error_json(HTTPStatus.NOT_FOUND, "Creneau introuvable.")
                    return
                if existing["status"] == "booked":
                    self.send_error_json(
                        HTTPStatus.CONFLICT,
                        "Un creneau reserve doit etre reprogramme depuis les rendez-vous.",
                    )
                    return

                conn.execute(
                    """
                    UPDATE slots
                    SET date = ?, time = ?, note = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (date_value, time_value, note, utc_now_iso(), slot_id),
                )
        except sqlite3.IntegrityError:
            self.send_error_json(HTTPStatus.CONFLICT, "Un autre creneau existe deja a cette date et heure.")
            return

        self.send_json({"ok": True})

    def handle_delete_slot(self, path: str) -> None:
        slot_id = int(path.rsplit("/", 1)[-1])
        with transaction() as conn:
            slot = conn.execute("SELECT id, status FROM slots WHERE id = ?", (slot_id,)).fetchone()
            if slot is None:
                self.send_error_json(HTTPStatus.NOT_FOUND, "Creneau introuvable.")
                return
            if slot["status"] == "booked":
                self.send_error_json(HTTPStatus.CONFLICT, "Impossible de supprimer un creneau reserve.")
                return
            conn.execute("DELETE FROM slots WHERE id = ?", (slot_id,))

        self.send_json({"ok": True})

    def handle_admin_appointment_action(self, path: str) -> None:
        path_parts = path.strip("/").split("/")
        if len(path_parts) != 5:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Action introuvable.")
            return

        appointment_id = int(path_parts[3])
        action = path_parts[4]

        if action == "cancel":
            self.handle_admin_cancel_appointment(appointment_id)
            return
        if action == "update":
            self.handle_admin_update_appointment(appointment_id)
            return
        if action == "reschedule":
            self.handle_admin_reschedule_appointment(appointment_id)
            return

        self.send_error_json(HTTPStatus.NOT_FOUND, "Action introuvable.")

    def handle_admin_cancel_appointment(self, appointment_id: int) -> None:
        with transaction() as conn:
            appointment = conn.execute(
                "SELECT id, slot_id, status FROM appointments WHERE id = ?",
                (appointment_id,),
            ).fetchone()
            if appointment is None:
                self.send_error_json(HTTPStatus.NOT_FOUND, "Rendez-vous introuvable.")
                return
            if appointment["status"] == "cancelled":
                self.send_json({"ok": True})
                return

            conn.execute(
                "UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?",
                (utc_now_iso(), appointment_id),
            )
            conn.execute(
                "UPDATE slots SET status = 'available', updated_at = ? WHERE id = ?",
                (utc_now_iso(), appointment["slot_id"]),
            )

        self.send_json({"ok": True})

    def handle_admin_update_appointment(self, appointment_id: int) -> None:
        try:
            payload = parse_json(self)
        except json.JSONDecodeError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "JSON invalide.")
            return

        service = str(payload.get("service", "")).strip()
        location = str(payload.get("location", "")).strip()
        notes = str(payload.get("notes", "")).strip()

        if service not in SERVICES or location not in LOCATIONS:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Prestation ou lieu invalide.")
            return

        with db_connect() as conn:
            result = conn.execute(
                """
                UPDATE appointments
                SET service = ?, location = ?, notes = ?, updated_at = ?
                WHERE id = ?
                """,
                (service, location, notes, utc_now_iso(), appointment_id),
            )
            conn.commit()

        if result.rowcount == 0:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Rendez-vous introuvable.")
            return

        self.send_json({"ok": True})

    def handle_admin_reschedule_appointment(self, appointment_id: int) -> None:
        try:
            payload = parse_json(self)
        except json.JSONDecodeError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "JSON invalide.")
            return

        new_slot_id = int(payload.get("slotId", 0) or 0)
        if new_slot_id <= 0:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Nouveau creneau invalide.")
            return

        try:
            with transaction() as conn:
                appointment = conn.execute(
                    "SELECT id, slot_id, status FROM appointments WHERE id = ?",
                    (appointment_id,),
                ).fetchone()
                if appointment is None:
                    self.send_error_json(HTTPStatus.NOT_FOUND, "Rendez-vous introuvable.")
                    return
                if appointment["status"] != "confirmed":
                    self.send_error_json(HTTPStatus.CONFLICT, "Seul un rendez-vous confirme peut etre reprogramme.")
                    return

                new_slot = conn.execute(
                    "SELECT id, status FROM slots WHERE id = ?",
                    (new_slot_id,),
                ).fetchone()
                if new_slot is None:
                    self.send_error_json(HTTPStatus.NOT_FOUND, "Nouveau creneau introuvable.")
                    return
                if new_slot["status"] != "available":
                    self.send_error_json(HTTPStatus.CONFLICT, "Le nouveau creneau n'est pas disponible.")
                    return

                conn.execute(
                    "UPDATE slots SET status = 'available', updated_at = ? WHERE id = ?",
                    (utc_now_iso(), appointment["slot_id"]),
                )
                conn.execute(
                    "UPDATE slots SET status = 'booked', updated_at = ? WHERE id = ?",
                    (utc_now_iso(), new_slot_id),
                )
                conn.execute(
                    "UPDATE appointments SET slot_id = ?, updated_at = ? WHERE id = ?",
                    (new_slot_id, utc_now_iso(), appointment_id),
                )
        except sqlite3.IntegrityError:
            self.send_error_json(HTTPStatus.CONFLICT, "Conflit detecte avec le nouveau creneau.")
            return

        self.send_json({"ok": True})


def main() -> None:
    init_db()
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), AppHandler)
    print(f"Studio booking running on http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
