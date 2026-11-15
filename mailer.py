"""Sending email (password-reset links).

Render's free web services block the normal SMTP ports, so the preferred route is an
email provider's HTTPS API. Brevo is supported out of the box (BREVO_API_KEY).
Plain SMTP (SMTP_HOST ...) works on your own computer and on hosts that allow it.
With neither configured, nothing is sent; the app logs the link for local testing.
"""
import json
import logging
import os
import smtplib
import threading
import urllib.error
import urllib.request
from email.message import EmailMessage

log = logging.getLogger("pulanova.mail")


def sender():
    return os.environ.get("MAIL_FROM") or os.environ.get("SMTP_USER") or ""


def provider():
    if os.environ.get("BREVO_API_KEY") and sender():
        return "brevo"
    if os.environ.get("SMTP_HOST") and sender():
        return "smtp"
    return None


def configured():
    return provider() is not None


def _send_brevo(to, subject, text):
    payload = {"sender": {"name": os.environ.get("MAIL_FROM_NAME", "PULANOVA AI"), "email": sender()},
               "to": [{"email": to}], "subject": subject, "textContent": text}
    request = urllib.request.Request(
        "https://api.brevo.com/v3/smtp/email", data=json.dumps(payload).encode(), method="POST",
        headers={"api-key": os.environ["BREVO_API_KEY"], "content-type": "application/json", "accept": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read()


def _send_smtp(to, subject, text):
    message = EmailMessage()
    message["From"] = f'{os.environ.get("MAIL_FROM_NAME", "PULANOVA AI")} <{sender()}>'
    message["To"], message["Subject"] = to, subject
    message.set_content(text)
    host, port = os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", "587"))
    client = smtplib.SMTP_SSL(host, port, timeout=10) if port == 465 else smtplib.SMTP(host, port, timeout=10)
    with client:
        if port != 465 and os.environ.get("SMTP_STARTTLS", "1") != "0":
            client.starttls()
        if os.environ.get("SMTP_USER"):
            client.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        client.send_message(message)


def _safe_send(to, subject, text):
    try:
        (_send_brevo if provider() == "brevo" else _send_smtp)(to, subject, text)
        log.info("Reset email sent.")
    except (urllib.error.URLError, smtplib.SMTPException, OSError) as error:
        log.error("Could not send email: %s", error)


def send_async(to, subject, text):
    """Fire and forget, so the request is not slower when the address exists."""
    threading.Thread(target=_safe_send, args=(to, subject, text), daemon=True).start()
