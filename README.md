# PULANOVA AI (புலனோவா)

Voice-first, haptic and visual accessibility assistant. Flask backend (SQLite locally, PostgreSQL when hosted), plain JavaScript front end, private accounts.

## Run (Windows PowerShell)
```powershell
cd PULANOVA
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```
Open http://127.0.0.1:5000 in **Chrome or Edge**. Camera, microphone and location work on `localhost` or HTTPS only.
The database `instance/pulanova_v2.db` is created automatically. Version 2 stores data per person, so data from the older single-user `pulanova.db` is not carried over (it was only test data).

### Use it on an Android phone (needed for real vibration)
Phones need HTTPS for camera/mic. Easiest: `pip install cryptography`, then
`$env:PULANOVA_HTTPS="1"; python app.py` and open `https://<your-pc-ip>:5000` on the phone (accept the certificate warning).
Or tunnel with ngrok / Cloudflare Tunnel.

## Where each feature lives
| Feature | Page | Files |
|---|---|---|
| Voice-first navigation (spoken guidance, commands, confirmations, Alt+V) | every page | `voice.js`, `core.js` |
| Smart Haptic Alert System (own pattern per sound, flash, visual pulse, beep fallback) | Hearing, Tactile | `tactile.js`, `sound.js` |
| Sound Identity (YAMNet; basic fallback) | Hearing | `sound.js` |
| Live captions | Hearing | `bridge.js` |
| Conversation Bridge (speech → captions, typed/tapped replies → speech) | Conversation | `bridge.js` |
| Identify surroundings, danger level | Visual | `vision.js` |
| Read text (Tesseract OCR, English + Tamil) | Visual | `vision.js` |
| Find My Object (directional beeps, speech, vibration) | Visual | `vision.js` |
| Indian currency recognition (colour based) | Visual | `vision.js` |
| Tactile notifications, haptic navigation, custom tactile messages, Morse | Tactile | `tactile.js` |
| Braille output + Braille mode | Tactile | `tactile.js` |
| Tactile Emergency Assistance (countdown, SOS vibration, alarm, location, help card, SMS draft) | Emergency | `emergency.js` |
| Custom accessibility profiles (Visual, Hearing, Deafblind, Everyday + your own) | Profiles | `pages.js`, `app.py` |

## Voice commands (English / தமிழ்)
open home / visual / hearing / tactile / profiles / dashboard · identify surroundings · read text · stop reading ·
find my bag / phone / bottle / cup / laptop / book · check currency · open camera · start sound alerts · start captions ·
conversation · emergency · cancel · go back · repeat · help · switch to deafblind profile · stop voice.
Shortcuts: **Alt+V** voice on/off, **Alt+R** repeat page, **Alt+E** emergency, **Esc** cancels emergency.

## Honest limitations (please read before demonstrating)
- **Vibration**: Android Chrome only. iPhone Safari and desktops do not vibrate; PULANOVA then shows a pulsing indicator and plays beeps. A native/Flutter app is needed for iPhone haptics.
- **Sound Identity** needs internet the first time (TensorFlow.js + YAMNet). If the model cannot load it switches to *Basic mode* (rough "possible doorbell/horn/siren") and says so. Neither mode is a guaranteed safety warning.
- **Currency** uses note colour only. Worn notes, bad light or similar colours can fool it; it says "not sure" when votes disagree. For reliable recognition train an image model.
- **Braille display**: there is no direct driver. Refreshable displays work through the phone's/PC's screen reader (TalkBack, VoiceOver, NVDA, JAWS); PULANOVA sends every alert, caption and result to that screen reader and shows a Braille bar. The Braille preview is English uncontracted Braille.
- **Emergency**: a web page cannot send an SMS or place a call by itself. It opens the SMS draft and call links; the user must press send/call. Always test with your own contacts first.
- **Speech recognition** (Chrome/Edge) sends audio to the browser vendor's service. Only one recogniser can run at a time, so captions and the conversation bridge pause voice commands while listening. Some phones cannot use the microphone for captions and sound alerts at once.
- **Tamil**: all menus, buttons and spoken messages are translated; long help paragraphs may fall back to English. Tamil speech output needs a Tamil voice installed on the device.
- Vibration patterns and AI detection must be tested with real users before anyone relies on them.


## Accounts and privacy (version 2)
- Every browser gets a **private guest account** automatically. Contacts, events and profiles belong to that account and are never shown to anyone else (every database query filters by the account).
- A guest can **create an account** (email + password) on the Account page, keeping the data already saved, and **sign in** from other phones or computers.
- Passwords are stored only as salted hashes. Sign-in and sign-up are rate-limited. Cookies are HttpOnly and SameSite; state-changing API calls need a custom security header.
- People can **download** all their data and **permanently delete** their account from the Account page.
- Camera pictures and microphone sound are analysed inside the browser and are not uploaded or stored by PULANOVA.

## Publish for everyone (GitHub + Render + Neon)
1. Push the project to GitHub (`.gitignore` is included so `venv/` and local databases stay private).
2. Create a free PostgreSQL database at **neon.com** and copy its connection string.
3. On **render.com**: New > Web Service > your repo. Build `pip install -r requirements.txt`, start `gunicorn app:app`, health check path `/healthz`. (`render.yaml` has these values.)
4. Add environment variables (see `.env.example`): `PULANOVA_ENV=production`, `PULANOVA_SECRET=<long random text>`, `PULANOVA_SECURE_COOKIES=1`, `PULANOVA_PROXY=1`, `DATABASE_URL=<Neon string>`, `PULANOVA_BASE_URL=<your https address>`, plus the email and contact variables below.
5. Open the `https://....onrender.com` link on any phone. Android Chrome: menu > Install app. iPhone Safari: Share > Add to Home Screen.

Free-tier notes: Render's free web service sleeps when idle (about a minute to wake). Neon's free database also pauses when idle but keeps your data. Check each provider's current limits before launch.
Production checklist: use a strong `PULANOVA_SECRET`; keep `PULANOVA_ENV=production` (turns debug off); consider a password-reset email flow and a privacy policy page before inviting the public.

## Password reset email and privacy page
- **Forgot password** is on the Account page. The reset link works once, for 30 minutes, and signs the account out on all devices. The same message is shown whether or not the email exists.
- **Sending email**: Render's free web services block normal SMTP ports (25, 465, 587), so use an email provider's web API. The app supports **Brevo** (`BREVO_API_KEY` + `MAIL_FROM`; the sender address must be verified in Brevo; check Brevo's current free limits). Plain SMTP (`SMTP_HOST` ...) works on your own PC.
- Without email set up, local development prints the reset link in the PowerShell window running `python app.py`. In production nothing is sent and an error is logged. `/healthz` shows `email_configured`.
- `PULANOVA_BASE_URL` is **required in production** so reset links cannot be hijacked through a fake Host header.
- The **Privacy policy** is at `/privacy`. Set `PULANOVA_CONTACT_EMAIL` and `PULANOVA_OPERATOR` so it names who to contact. It is a plain-language starting point, not legal advice; have it reviewed for your country's rules before a public launch.

## Updating an existing copy of the project
Back up the folder first. Copy the new files over the old ones (keep your `venv` folder), activate the venv, run `pip install -r requirements.txt`, then `python app.py`. Old data from `pulanova.db` is not migrated; v2 uses `instance/pulanova_v2.db` and upgrades itself automatically.
