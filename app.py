import os
import re
import secrets
import string
import calendar
import csv
import io
import tempfile
import time
from collections import OrderedDict
from dotenv import load_dotenv
load_dotenv()  # Reads variables from a .env file in the project root, if present

from flask import Flask, render_template, request, redirect, url_for, session, flash, jsonify, Response
from markupsafe import Markup, escape
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from sqlalchemy.orm import joinedload
from sqlalchemy.exc import OperationalError
from flask_mail import Mail, Message
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from datetime import datetime, timezone, date, timedelta

# ── School ID sanity checks (opencv-python-headless + pytesseract) ──
# Runs fully offline (no external API calls) — flags an uploaded "school ID"
# photo as invalid if it doesn't look like an ID at all, catching obvious
# non-ID uploads (blank images, screenshots, random selfies/photos).
# Three independent, lightweight heuristics, combined below:
#   1. Face check       — a human face is visible.
#   2. Card-shape check — a single large, roughly rectangular, four-cornered
#                         region fills a good chunk of the frame (how an ID
#                         card looks when photographed close-up, vs. a normal
#                         candid photo with open background around the person).
#   3. Text check        — OCR finds printed text on it (name/school/ID no.),
#                          which a random photo won't have.
# None of these are real document verification — they can't confirm the
# card is genuine or matches the person (that would need proper OCR/ID
# classification tooling this app doesn't have) — so staff still does the
# real visual review via "View School ID" before approving. Each check is
# independently optional: if its library isn't installed, or the file isn't
# a readable image (e.g. a PDF), that check is silently skipped (returns
# None) rather than blocking the upload or crashing the app.
#   pip install opencv-python-headless   (face + card-shape checks)
#   pip install pytesseract              (text check — also needs the
#                                          system 'tesseract-ocr' package,
#                                          e.g. apt install tesseract-ocr)
try:
    import cv2
    print(f"[school-id-check] opencv {cv2.__version__} loaded OK")
except Exception as e:
    # Broad except on purpose: a missing OS shared library (e.g. libGL.so.1),
    # which is a very common issue for opencv-python-headless on minimal
    # hosting images, surfaces as an ImportError too — and if that's caught
    # silently, this whole safeguard goes quiet with nobody noticing. Print
    # loudly instead so a broken install shows up in the server logs.
    cv2 = None
    print(f"[school-id-check] opencv NOT available ({type(e).__name__}: {e}) — face/card-shape "
          f"checks AND GCash receipt OCR both DISABLED (both need cv2 to read images)")

# Loading the Haar cascade files is kept separate from the cv2 import above
# on purpose: if this fails (missing/mismatched cascade XML files — seen on
# some opencv-python-headless installs, e.g. Windows), it should only turn
# off the face/card-shape checks below, not cv2 itself. cv2 is also used by
# the (unrelated) GCash receipt OCR reader further down, which only needs
# cv2.imread/cvtColor/resize — no cascades at all — so it must keep working
# even when this block fails.
if cv2 is not None:
    try:
        _FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        _EYE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml')
        if _FACE_CASCADE.empty() or _EYE_CASCADE.empty():
            raise RuntimeError('cascade XML file(s) failed to load (empty classifier)')
        print("[school-id-check] Haar cascades loaded OK — face/card-shape checks ENABLED")
    except Exception as e:
        _FACE_CASCADE = None
        _EYE_CASCADE = None
        print(f"[school-id-check] Haar cascades NOT available ({type(e).__name__}: {e}) — "
              f"face/card-shape checks DISABLED, uploads will only reach staff's manual review "
              f"(GCash receipt OCR is unaffected by this)")
else:
    _FACE_CASCADE = None
    _EYE_CASCADE = None

try:
    import pytesseract

    # On Windows, `pip install pytesseract` only installs the Python
    # wrapper — the actual OCR engine (the 'tesseract-ocr' system package)
    # has no official pip distribution and must be installed separately
    # (see https://github.com/UB-Mannheim/tesseract/wiki), then normally
    # found via PATH. In practice PATH updates are easy to get wrong on
    # Windows (a terminal/IDE opened before the PATH change won't see it,
    # a venv can be launched from a stale shell, etc.), so as a fallback
    # — if the plain PATH lookup below fails — also check the standard
    # install locations directly. Set TESSERACT_CMD in your .env file to
    # override this if you installed it somewhere else.
    _tess_override = os.environ.get('TESSERACT_CMD')
    if _tess_override and os.path.isfile(_tess_override):
        pytesseract.pytesseract.tesseract_cmd = _tess_override

    try:
        pytesseract.get_tesseract_version()  # raises if the pip package is installed but the
                                              # system 'tesseract-ocr' binary itself is missing
    except Exception:
        if not _tess_override:
            _windows_fallback_paths = [
                r'C:\Program Files\Tesseract-OCR\tesseract.exe',
                r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe',
                os.path.expandvars(r'%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe'),
            ]
            for _candidate in _windows_fallback_paths:
                if os.path.isfile(_candidate):
                    pytesseract.pytesseract.tesseract_cmd = _candidate
                    break
        pytesseract.get_tesseract_version()  # try again — raises for real now if still not found

    print(f"[school-id-check] pytesseract + tesseract binary found "
          f"({pytesseract.pytesseract.tesseract_cmd}) — text check ENABLED")
except ImportError as e:
    pytesseract = None
    print(f"[school-id-check] pytesseract NOT installed ({e}) — text check DISABLED")
except Exception as e:
    pytesseract = None
    print(f"[school-id-check] pytesseract installed but the 'tesseract-ocr' system binary "
          f"wasn't found/working ({type(e).__name__}: {e}) — text check DISABLED. "
          f"Install it with: apt install tesseract-ocr (Linux) or the Windows installer at "
          f"https://github.com/UB-Mannheim/tesseract/wiki, then either add it to PATH and "
          f"restart your terminal/IDE, or set TESSERACT_CMD in your .env to its tesseract.exe path.")


def _image_has_face(file_path):
    """Returns True/False, or None if the face check can't be run at all
    (opencv missing, or the file isn't a readable image — e.g. a PDF).
    Cross-checks each candidate face against an eye detector: cluttered,
    high-contrast non-face images (screenshots, code editors, icon grids)
    occasionally trigger a false-positive box from the face cascade alone,
    and a real face reliably has two detectable eye regions inside it."""
    if _FACE_CASCADE is None:
        return None
    img = cv2.imread(file_path)
    if img is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    faces = _FACE_CASCADE.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(60, 60))
    if len(faces) == 0:
        return False
    if _EYE_CASCADE is None or _EYE_CASCADE.empty():
        return True  # can't cross-check; fall back to the raw cascade result
    for (x, y, w, h) in faces:
        roi = gray[y:y + h, x:x + w]
        eyes = _EYE_CASCADE.detectMultiScale(roi, scaleFactor=1.1, minNeighbors=5, minSize=(15, 15))
        if len(eyes) >= 1:
            return True
    return False


def _image_looks_like_a_card(file_path):
    """Returns True/False, or None if the check can't be run (opencv missing,
    or the file isn't a readable image). Looks for a single large, roughly
    rectangular (4-6 corner) contour covering at least a quarter of the
    frame — the visual signature of someone photographing an ID card close
    up. A normal candid/selfie photo usually has no such dominant shape."""
    if cv2 is None:
        return None
    img = cv2.imread(file_path)
    if img is None:
        return None
    h, w = img.shape[:2]
    frame_area = h * w
    if frame_area == 0:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.dilate(cv2.Canny(blurred, 50, 150), None, iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        if cv2.contourArea(contour) < frame_area * 0.25:
            break  # sorted descending, so nothing further is big enough either
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
        if 4 <= len(approx) <= 6:
            return True
    return False


def _image_has_readable_text(file_path, min_chars=8):
    """Returns True/False, or None if the check can't be run (pytesseract/
    tesseract not installed, opencv missing, or the file isn't a readable
    image). A genuine ID card has printed text on it; a random selfie or
    candid photo generally doesn't. `min_chars` is intentionally low — this
    only needs to catch photos with *no* text, not judge OCR quality."""
    if pytesseract is None or cv2 is None:
        return None
    img = cv2.imread(file_path)
    if img is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    try:
        extracted = pytesseract.image_to_string(gray)
    except Exception:
        return None
    alnum_only = ''.join(ch for ch in extracted if ch.isalnum())
    return len(alnum_only) >= min_chars


# ── GCash receipt auto-read (pytesseract) ────────────────────
# Best-effort OCR so the member doesn't have to retype what's already on
# the screenshot they just uploaded. This never blocks submission — if
# OCR is unavailable or a field can't be found, that field just comes
# back None and the member types/confirms it manually. GCash receipts
# aren't a fixed layout across app versions, so the regexes below are
# deliberately loose (several keyword variants, tolerant spacing).
_GCASH_REF_RE    = re.compile(r'(?:ref(?:erence)?\.?\s*(?:no\.?|number)?|txn\s*id)\s*[:\-]?\s*([0-9][0-9 ]{9,17}[0-9])', re.IGNORECASE)
_GCASH_REF_BARE_RE = re.compile(r'\b(\d[\d ]{10,16}\d)\b')  # fallback: any long standalone digit run

# Tried in order, first match wins. The peso sign (₱) is one of the most
# commonly *mis-OCR'd* characters on phone-screenshot receipts — Tesseract
# frequently reads it as a bare "P", "B", or drops it entirely — so unlike
# the currency-anchored approach that failed in practice, these anchor on
# the amount LABEL instead and treat the currency symbol as optional.
# "Total Amount Sent" (the final total, after any transfer fee) is tried
# before a bare "Amount" line, since that's what the member actually paid.
_GCASH_AMOUNT_PATTERNS = [
    re.compile(r'total\s*amount\s*sent\s*[:\-]?\s*(?:php|₱|p|b)?\s*([\d,]+\.\d{2})', re.IGNORECASE),
    re.compile(r'amount\s*sent\s*[:\-]?\s*(?:php|₱|p|b)?\s*([\d,]+\.\d{2})', re.IGNORECASE),
    re.compile(r'\bamount\b\s*[:\-]?\s*(?:php|₱|p|b)?\s*([\d,]+\.\d{2})', re.IGNORECASE),
    re.compile(r'(?:php|₱)\s*([\d,]+\.\d{2})', re.IGNORECASE),  # last resort: bare currency symbol anywhere
]
_GCASH_DATE_RE   = re.compile(
    r'\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}'
    r'|\d{4}-\d{2}-\d{2}'
    r'|\d{1,2}/\d{1,2}/\d{2,4})\b',
    re.IGNORECASE,
)
_GCASH_NAME_RE   = re.compile(r'(?:sent to|sender|from|to)\s*[:\-]?\s*([A-Za-z][A-Za-z.\-\' ]{2,40})', re.IGNORECASE)
_GCASH_TIME_RE   = re.compile(r'\b(\d{1,2}:\d{2}\s?[APap]\.?[Mm]\.?|\d{1,2}:\d{2})\b')

_GCASH_MONTHS = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
}


def _parse_gcash_date(raw):
    """Best-effort conversion of an OCR-matched date string (several
    possible formats — see _GCASH_DATE_RE) into 'YYYY-MM-DD' so it can be
    dropped straight into an <input type="date">. Returns None if the
    format isn't recognized or the date isn't valid."""
    if not raw:
        return None
    raw = raw.strip()

    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', raw)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            return None

    m = re.match(r'^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$', raw)
    if m:
        mo = _GCASH_MONTHS.get(m.group(1)[:3].lower())
        if mo:
            try:
                return date(int(m.group(3)), mo, int(m.group(2))).isoformat()
            except ValueError:
                return None
        return None

    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{2,4})$', raw)
    if m:
        mo, d, y = int(m.group(1)), int(m.group(2)), m.group(3)
        y = int(y) if len(y) == 4 else 2000 + int(y)
        if mo > 12 and d <= 12:
            mo, d = d, mo
        try:
            return date(y, mo, d).isoformat()
        except ValueError:
            return None

    return None


def _parse_gcash_time(raw):
    """Best-effort conversion of an OCR-matched time string ('6:13 PM',
    '18:13', ...) into 24-hour 'HH:MM' for an <input type="time">.
    Returns None if it doesn't look like a valid time."""
    if not raw:
        return None
    cleaned = raw.strip().upper().replace(' ', '').replace('.', '')
    m = re.match(r'^(\d{1,2}):(\d{2})(AM|PM)?$', cleaned)
    if not m:
        return None
    h, mi, ap = int(m.group(1)), int(m.group(2)), m.group(3)
    if mi > 59:
        return None
    if ap == 'PM' and h != 12:
        h += 12
    elif ap == 'AM' and h == 12:
        h = 0
    if h > 23:
        return None
    return f'{h:02d}:{mi:02d}'


def _extract_gcash_receipt_fields(file_path):
    """Best-effort OCR read of a GCash proof-of-payment screenshot.
    Returns a dict with amount/reference/date/time/name keys (each a
    string or None) plus normalized date_iso/time_24h keys ready to drop
    straight into the date/time <input> fields, or None entirely if OCR
    can't run at all (pytesseract or opencv missing, unreadable image)."""
    if pytesseract is None or cv2 is None:
        return None
    img = cv2.imread(file_path)
    if img is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Upscale small screenshots — tesseract reads small phone-screenshot
    # text much more reliably above ~1000px tall.
    h, w = gray.shape[:2]
    if h < 1000:
        scale = 1000 / h
        gray = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)
    try:
        text_out = pytesseract.image_to_string(gray)
    except Exception:
        return None

    result = {
        'amount': None, 'reference': None,
        'date': None, 'date_iso': None,
        'time': None, 'time_24h': None,
        'name': None,
    }

    for _amount_pattern in _GCASH_AMOUNT_PATTERNS:
        m = _amount_pattern.search(text_out)
        if m:
            result['amount'] = m.group(1)
            break

    m = _GCASH_REF_RE.search(text_out)
    if not m:
        m = _GCASH_REF_BARE_RE.search(text_out)
    if m:
        result['reference'] = re.sub(r'\s+', '', m.group(1))

    m = _GCASH_DATE_RE.search(text_out)
    if m:
        result['date'] = m.group(1)
        result['date_iso'] = _parse_gcash_date(m.group(1))

    m = _GCASH_TIME_RE.search(text_out)
    if m:
        result['time'] = m.group(1).strip()
        result['time_24h'] = _parse_gcash_time(m.group(1))

    m = _GCASH_NAME_RE.search(text_out)
    if m:
        # OCR of the "Sent to"/"Sender" line can drag in trailing junk
        # (icons read as stray letters); keep it to a plausible name length.
        candidate = ' '.join(m.group(1).split())
        if 2 <= len(candidate.split()) <= 5:
            result['name'] = candidate

    return result


app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'dev_secret_key')

# ── Static asset caching ─────────────────────────────────────
# By default Flask re-validates every CSS/JS/image request with the browser
# on every page load. Since these files (tr-styles.css, tr-*.js, logo, etc.)
# rarely change, telling the browser to cache them for a week means repeat
# visits to any dashboard skip re-downloading them entirely — a big part of
# what makes navigation feel slow on a fresh load. Set SEND_FILE_MAX_AGE=0
# via env var during active front-end development if you need changes to
# show up immediately without a hard refresh.
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = int(os.environ.get('SEND_FILE_MAX_AGE', 604800))  # 7 days

# Auto cache-busting: append the static file's own last-modified time as a
# ?v= query string to every url_for('static', ...) call, across every
# template, automatically. Combined with the week-long cache above, this
# means updated CSS/JS/images show up immediately for everyone on their very
# next page load — no hard refresh needed — while files that haven't
# changed still get served straight from the browser's cache. Without this,
# a 7-day cache means anyone who visited before an update could keep seeing
# the old file until that cache naturally expires.
@app.url_defaults
def _add_static_file_version(endpoint, values):
    if endpoint == 'static' and 'filename' in values:
        filepath = os.path.join(app.static_folder or '', values['filename'])
        try:
            values['v'] = int(os.stat(filepath).st_mtime)
        except OSError:
            pass

# ── Timezone: the gym operates on Philippines time, but all timestamps are
#    stored in the database as naive UTC. Convert to Manila only for display. ──
MANILA_TZ = timezone(timedelta(hours=8))


def _to_manila(dt):
    """Convert a naive UTC datetime (as stored in the DB) to an aware
    Philippines-time datetime. Returns None if dt is None."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone(MANILA_TZ)


def _now_manila():
    """Current date/time in Philippines time (aware)."""
    return datetime.now(timezone.utc).astimezone(MANILA_TZ)


def _today_manila():
    """Today's calendar date in Philippines time (so date boundaries — e.g.
    'today's attendance' — line up with the actual local day, not UTC's)."""
    return _now_manila().date()


def _add_calendar_month(d, months=1):
    """Add whole calendar month(s) to a date, landing on the same day-of-month
    when possible (e.g. Jan 15 -> Feb 15) and clamping to the last valid day
    when the target month is shorter (e.g. Jan 31 -> Feb 28/29, not Mar 3)."""
    month_index = d.month - 1 + months
    year  = d.year + month_index // 12
    month = month_index % 12 + 1
    last_day = calendar.monthrange(year, month)[1]
    day = min(d.day, last_day)
    return date(year, month, day)


def _is_promo_payment(p):
    """True if a Payment record represents a promo request rather than a
    regular membership plan request — see _payment_display_plan above."""
    return bool(p and p.notes and p.notes.startswith('Promo request:'))


def _member_reported_payment_details(notes):
    """Pulls just the member-typed GCash context (sender/account name, when
    they say they paid, how much they say they paid — see
    /member/submit-payment-method) out of the Payment.notes free-text
    field, for showing to staff/admin during verification. That same
    column can also carry an unrelated 'Promo request: <plan>' marker
    (see _is_promo_payment above), which is filtered out here since it's
    already surfaced elsewhere as its own badge.

    Returns a dict with keys 'sender', 'time', 'amount' (each omitted if
    the member didn't fill in that field), split apart instead of one
    run-on string, so callers can lay each piece out on its own line
    instead of cramming everything into a single '·'-joined sentence.
    Returns None if there's nothing member-reported to show."""
    if not notes:
        return None
    parts = [seg.strip() for seg in notes.split('|')]
    result = {}
    for seg in parts:
        if seg.startswith('GCash sender:'):
            result['sender'] = seg[len('GCash sender:'):].strip()
        elif seg.startswith('Member-reported payment time:'):
            result['time'] = seg[len('Member-reported payment time:'):].strip()
        elif seg.startswith('Member-reported amount paid:'):
            result['amount'] = seg[len('Member-reported amount paid:'):].strip()
    return result or None


def _parse_peso_amount(s):
    """Parses a '₱1,234.56'-style string (or plain '1234.56') into a float.
    Returns None if it isn't parseable, so callers can skip comparisons
    against a member-typed amount that wasn't a clean number."""
    if not s:
        return None
    try:
        return float(s.replace('₱', '').replace(',', '').strip())
    except (TypeError, ValueError):
        return None


def _payment_display_plan(p, fallback='—'):
    """Display label for a payment's plan. Promo requests are recorded
    against an anchor MembershipPlan behind the scenes (see
    /member/submit-payment) purely for expiry-date scheduling, but staff,
    admin, and the member should see the promo they actually asked for —
    not the anchor plan's name. Promo requests are tagged in `notes` as
    'Promo request: <title> — <price>', so pull the title back out of
    there when present; otherwise fall back to the real plan name."""
    if p and p.notes and p.notes.startswith('Promo request:'):
        label = p.notes[len('Promo request:'):].split('—')[0].strip()
        if label:
            return label
    if p and p.plan:
        return p.plan.name
    return fallback


def _plan_expiry(plan, start_date):
    """Compute a plan's expiry date from its start date. Monthly plans track
    real calendar months (28-31 days) instead of a flat 30 days, so 'Feb 1 to
    Mar 1' and 'Jan 1 to Feb 1' both count as one full month."""
    if plan and plan.name == 'Monthly':
        return _add_calendar_month(start_date, 1)
    duration_days = plan.duration_days if plan else 30
    return start_date + timedelta(days=duration_days)


# Per-plan wording for the automated expiry reminder (Send Reminder button
# on the staff 'Members Expiring This Week' panel). Falls back to a generic
# line for any plan name not listed here (promos, future plans, etc.).
_REMINDER_MESSAGES_BY_PLAN = {
    'Daily':   "Hi {first_name}! Your Daily Pass expires on {expiry} ({days_left}). Just grab another pass at the front desk anytime to keep training with us!",
    'Weekly':  "Hi {first_name}! Your Weekly Plan expires on {expiry} ({days_left}). Once it expires, head to My Membership to pick your next plan and keep your access going.",
    'Half Month': "Hi {first_name}! Your Half Month Plan expires on {expiry} ({days_left}). Once it expires, head to My Membership to pick your next plan and keep your access going.",
    'Monthly': "Hi {first_name}! Your Monthly Membership expires on {expiry} ({days_left}). Once it expires, head to My Membership to pick your next plan and stay on track with your fitness goals!",
    'Yearly':  "Hi {first_name}! Your Yearly Membership expires on {expiry} ({days_left}). Once it expires, head to My Membership to pick your next plan and keep your gains going!",
}
_REMINDER_MESSAGE_DEFAULT = "Hi {first_name}! Your {plan} plan expires on {expiry} ({days_left}). Once it expires, head to My Membership to pick your next plan and keep your gym access active."


def _reminder_message(plan_name, expiry_date, first_name, today=None):
    """Build the plan-specific 'your membership is expiring' message shown
    to a member as a bot popup. `days_left` reads as 'today', 'tomorrow',
    or 'in N days' so it still makes sense however close the expiry is."""
    today = today or _today_manila()
    delta = (expiry_date - today).days if expiry_date else None
    if delta is None:
        days_left = ''
    elif delta <= 0:
        days_left = 'today'
    elif delta == 1:
        days_left = 'tomorrow'
    else:
        days_left = f'in {delta} days'

    template = _REMINDER_MESSAGES_BY_PLAN.get(plan_name, _REMINDER_MESSAGE_DEFAULT)
    return template.format(
        first_name=first_name or 'there',
        plan=plan_name or 'membership',
        expiry=expiry_date.strftime('%b %d, %Y') if expiry_date else 'soon',
        days_left=days_left,
    )


# Discounted prices for students with a verified school ID. Daily is not
# discounted (it's not listed in the promo), so it's left out on purpose —
# any plan not in this table just falls back to its normal price.
STUDENT_PLAN_PRICES = {
    'Half Month': 400.0,
    'Monthly':    800.0,
    'Yearly':     6000.0,
}


# Flat coach add-on for a single walk-in visit — separate from the
# per-coach `Coach.fee` used for full memberships, since a walk-in is a
# one-off day pass rather than an ongoing coaching arrangement.
WALKIN_COACH_FEE = 350.0

# Flat price for a walk-in Boxing session — a second walk-in option
# alongside the Daily plan. Unlike Daily, this isn't backed by a
# MembershipPlan row (Boxing here is a per-visit rate, not a plan
# members subscribe to), so it's kept as a simple constant like the
# coach fee above.
WALKIN_BOXING_FEE = 350.0


def _plan_amount(plan, is_student):
    """The amount to actually charge for a plan, applying the student
    discount when applicable. Falls back to the plan's normal price for
    plans with no listed student rate (e.g. Daily) or for non-students."""
    if plan and is_student and plan.name in STUDENT_PLAN_PRICES:
        return STUDENT_PLAN_PRICES[plan.name]
    return plan.price if plan else 0.0


def _coach_fee(coach_name):
    """The coach fee to add on top of the plan price, looked up by name.
    Staff/admin set this per-coach from their dashboards. Returns 0 if no
    coach was requested or the named coach no longer exists."""
    if not coach_name:
        return 0.0
    coach = Coach.query.filter_by(name=coach_name).first()
    return float(coach.fee) if coach else 0.0


def _payment_total(plan, is_student, coach_name=None):
    """Full amount a member owes: the (student-adjusted) plan price plus
    the selected coach's fee, if any. This is the single source of truth
    for what gets charged/displayed everywhere a plan + coach combination
    is priced."""
    return _plan_amount(plan, is_student) + _coach_fee(coach_name)


def _manila_day_bounds_utc(day):
    """Given a Philippines calendar date, return the (start, end) naive UTC
    datetimes bounding that local day — for filtering DB columns that are
    stored in UTC (e.g. Attendance.check_in)."""
    start_manila = datetime.combine(day, datetime.min.time()).replace(tzinfo=MANILA_TZ)
    end_manila   = datetime.combine(day, datetime.max.time()).replace(tzinfo=MANILA_TZ)
    return (
        start_manila.astimezone(timezone.utc).replace(tzinfo=None),
        end_manila.astimezone(timezone.utc).replace(tzinfo=None),
    )


def _get_member_attendance_month(user_id, year, month):
    """Attendance calendar grid + session history for one member, for an
    arbitrary (year, month) — powers both the initial 'My Attendance' page
    load and the back/forward month navigation (see /member/attendance-month).
    If the requested month is the current one, today_day is set so days that
    haven't happened yet render as 'upcoming' rather than 'absent'."""
    today = _today_manila()
    days_in_month = calendar.monthrange(year, month)[1]

    month_start_dt, _ = _manila_day_bounds_utc(date(year, month, 1))
    next_month  = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    month_end_dt, _ = _manila_day_bounds_utc(next_month)

    attendance_rows = (
        Attendance.query
        .filter(Attendance.member_id == user_id,
                Attendance.check_in >= month_start_dt,
                Attendance.check_in < month_end_dt)
        .order_by(Attendance.check_in.desc())
        .all()
    )

    present_days = sorted({_to_manila(a.check_in).day for a in attendance_rows})

    # ── Days the member had no active membership plan at all — these should
    #    stay neutral on the calendar (not red) since there was nothing to
    #    check in for. A day counts as "plan-covered" only if it falls within
    #    the member's current membership start_date..expiry_date range. ──
    membership = Membership.query.filter_by(member_id=user_id).first()
    no_plan_days = []
    for d in range(1, days_in_month + 1):
        day_date = date(year, month, d)
        has_plan = (
            membership is not None
            and membership.start_date is not None
            and membership.expiry_date is not None
            and membership.start_date <= day_date <= membership.expiry_date
        )
        if not has_plan:
            no_plan_days.append(d)

    session_history = []
    for a in attendance_rows[:10]:
        duration_text = '—'
        if a.check_out:
            mins = a.duration_min if a.duration_min is not None else int((a.check_out - a.check_in).total_seconds() // 60)
            h, m = divmod(mins, 60)
            duration_text = f'{h}h {m}m' if h else f'{m}m'
        check_in_manila  = _to_manila(a.check_in)
        check_out_manila = _to_manila(a.check_out)
        session_history.append({
            'date':      check_in_manila.strftime('%b %d, %Y'),
            'check_in':  check_in_manila.strftime('%I:%M %p').lstrip('0'),
            'check_out': check_out_manila.strftime('%I:%M %p').lstrip('0') if check_out_manila else '—',
            'duration':  duration_text,
        })

    is_current_month = (year == today.year and month == today.month)

    return {
        'year': year,
        'month': month,
        'month_label': date(year, month, 1).strftime('%B %Y'),
        'days_in_month': days_in_month,
        'today_day': today.day if is_current_month else None,
        'is_current_month': is_current_month,
        'present_days': present_days,
        'no_plan_days': no_plan_days,
        'session_history': session_history,
    }


@app.route('/member/attendance-month')
def member_attendance_month():
    """AJAX endpoint behind the back/forward arrows on 'My Attendance' —
    returns the calendar + session history for whichever month was requested,
    without a full page reload."""
    if session.get('role') != 'member':
        return jsonify(success=False, error='Unauthorized.'), 403
    user_id = session.get('user_id')

    try:
        year  = int(request.args.get('year'))
        month = int(request.args.get('month'))
    except (TypeError, ValueError):
        return jsonify(success=False, error='Invalid month.'), 400
    if month < 1 or month > 12:
        return jsonify(success=False, error='Invalid month.'), 400

    today = _today_manila()
    if (year, month) > (today.year, today.month):
        return jsonify(success=False, error='Cannot view a future month.'), 400
    if year < 2020:
        return jsonify(success=False, error='Invalid month.'), 400

    return jsonify(success=True, **_get_member_attendance_month(user_id, year, month))


DB_USER = os.environ.get('DB_USER', 'root')
DB_PASSWORD = os.environ.get('DB_PASSWORD', '')
DB_HOST = os.environ.get('DB_HOST', '127.0.0.1')
DB_PORT = os.environ.get('DB_PORT', '3306')
DB_NAME = os.environ.get('DB_NAME', 'gym_db')

app.config['SQLALCHEMY_DATABASE_URI'] = f'mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# Prevent "MySQL server has gone away" errors: ping each connection before
# reuse, and recycle connections before MySQL's own idle timeout closes them.
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'pool_pre_ping': True,
    'pool_recycle': 280,
    # Fail a dead/unreachable connection quickly (10s) instead of hanging
    # on the OS's own TCP timeout (which is what produced the WinError
    # 10060 traceback — a multi-minute wait before finally giving up).
    'connect_args': {'connect_timeout': 10},
}

# ── Payment proof uploads ────────────────────────────────────
PROOF_UPLOAD_FOLDER = os.path.join(app.root_path, 'static', 'uploads', 'payment_proofs')
PROOF_ALLOWED_EXT   = {'png', 'jpg', 'jpeg', 'pdf'}
PROOF_MAX_BYTES     = 10 * 1024 * 1024  # 10MB
os.makedirs(PROOF_UPLOAD_FOLDER, exist_ok=True)

# ── Gym content (plans / services / equipment) picture uploads ─
CONTENT_UPLOAD_FOLDER = os.path.join(app.root_path, 'static', 'uploads', 'content')
CONTENT_ALLOWED_EXT   = {'png', 'jpg', 'jpeg', 'webp'}
CONTENT_MAX_BYTES     = 8 * 1024 * 1024  # 8MB
os.makedirs(CONTENT_UPLOAD_FOLDER, exist_ok=True)

# ── Member profile picture uploads — mandatory at self-registration ──
PROFILE_UPLOAD_FOLDER = os.path.join(app.root_path, 'static', 'uploads', 'profile_pictures')
PROFILE_ALLOWED_EXT   = {'png', 'jpg', 'jpeg', 'webp'}
PROFILE_MAX_BYTES     = 5 * 1024 * 1024  # 5MB
# Members can change their profile picture, but only once every N days —
# stops someone from swapping it back and forth right after a staff member
# reviews it. Counted from profile_picture_updated_at, which is also set
# at self-registration so the very first upload starts the same cooldown.
PROFILE_PICTURE_COOLDOWN_DAYS = 7
os.makedirs(PROFILE_UPLOAD_FOLDER, exist_ok=True)

# ── Flask-Mail configuration ─────────────────────────────────
# Set these as real environment variables (don't hardcode credentials here).
# For Gmail: MAIL_USERNAME is your Gmail address, MAIL_PASSWORD is a 16-char
# "App Password" (not your normal Gmail password) — generate one at
# https://myaccount.google.com/apppasswords (requires 2-Step Verification on).
app.config['MAIL_SERVER']          = os.environ.get('MAIL_SERVER', 'smtp.gmail.com')
app.config['MAIL_PORT']            = int(os.environ.get('MAIL_PORT', 587))
app.config['MAIL_USE_TLS']         = os.environ.get('MAIL_USE_TLS', 'true').lower() == 'true'
app.config['MAIL_USE_SSL']         = os.environ.get('MAIL_USE_SSL', 'false').lower() == 'true'
app.config['MAIL_USERNAME']        = os.environ.get('MAIL_USERNAME')
app.config['MAIL_PASSWORD']        = os.environ.get('MAIL_PASSWORD')
app.config['MAIL_DEFAULT_SENDER']  = os.environ.get('MAIL_DEFAULT_SENDER', app.config['MAIL_USERNAME'])

mail = Mail(app)

db = SQLAlchemy(app)


def _format_full_name(first_name, last_name, middle_initial=None, extension_name=None):
    """Build 'First M.I. Last Ext.' from parts, skipping any that are blank."""
    parts = [first_name]
    if middle_initial:
        mi = middle_initial.strip().rstrip('.')
        if mi:
            parts.append(f'{mi}.')
    parts.append(last_name)
    full = ' '.join(p for p in parts if p)
    if extension_name and extension_name.strip():
        full += f' {extension_name.strip()}'
    return full


def _notif_sender_label(user, fallback='System'):
    """Human-readable 'who sent this' label for a notification-bell entry —
    just the sender's name (e.g. 'Juan Dela Cruz'). Falls back to
    `fallback` when there's no linked account (message was auto-generated,
    or the sender's account was since deleted)."""
    if not user:
        return fallback
    return user.full_name



class User(db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    first_name = db.Column(db.String(80), nullable=False)
    middle_initial = db.Column(db.String(5), nullable=True)
    last_name = db.Column(db.String(80), nullable=False)
    extension_name = db.Column(db.String(10), nullable=True)
    email = db.Column(db.String(120), nullable=False, unique=True, index=True)
    phone = db.Column(db.String(20), nullable=True)
    birthday = db.Column(db.Date, nullable=True)
    password = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(10), nullable=False, default='member')
    status = db.Column(db.String(15), nullable=False, default='pending')
    # Web-relative path under /static — e.g. 'uploads/profile_pictures/xxxx.jpg'.
    # Required at self-registration for members (see /register); nullable here
    # since existing/seeded accounts predate this field.
    profile_picture = db.Column(db.String(255), nullable=True)
    # When the profile picture was last changed — set at self-registration
    # too (the initial upload counts as the first change), so
    # PROFILE_PICTURE_COOLDOWN_DAYS can be enforced from day one instead of
    # treating a brand-new account as eligible for an immediate re-upload.
    profile_picture_updated_at = db.Column(db.DateTime, nullable=True)
    reset_token         = db.Column(db.String(64), nullable=True, unique=True, index=True)
    reset_token_expires = db.Column(db.DateTime, nullable=True)
    reset_otp            = db.Column(db.String(255), nullable=True)
    reset_otp_expires    = db.Column(db.DateTime, nullable=True)
    reset_otp_attempts   = db.Column(db.Integer, nullable=False, default=0)
    reset_otp_locked_until = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc),
                           onupdate=lambda: datetime.now(timezone.utc))
    # Tracks the last time this user's dashboard checked in on announcements,
    # so we know which ones are "new" for them since their last visit.
    last_seen_announcements_at = db.Column(db.DateTime, nullable=True)
    # Tracks the last time this user opened the notification bell, so the
    # badge count reflects announcements/reminders posted since then without
    # affecting the separate "pop up on login" logic above.
    last_seen_notifications_at = db.Column(db.DateTime, nullable=True)

    membership       = db.relationship('Membership', back_populates='member', uselist=False, cascade='all, delete-orphan')
    payments         = db.relationship('Payment', foreign_keys='Payment.member_id', back_populates='member', cascade='all, delete-orphan')
    recorded_payments= db.relationship('Payment', foreign_keys='Payment.recorded_by_id', back_populates='recorded_by')
    attendance       = db.relationship('Attendance', foreign_keys='Attendance.member_id', back_populates='member', cascade='all, delete-orphan')
    body_goals       = db.relationship('BodyGoal', back_populates='member', cascade='all, delete-orphan')
    fitness_profile  = db.relationship('FitnessProfile', back_populates='member', uselist=False, cascade='all, delete-orphan')

    @property
    def full_name(self):
        return _format_full_name(self.first_name, self.last_name, self.middle_initial, self.extension_name)

    def __repr__(self):
        return f"<User {self.id} {self.email} [{self.role}]>"


class MembershipPlan(db.Model):
    __tablename__ = 'membership_plans'
    id            = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name          = db.Column(db.String(50), nullable=False, unique=True)
    duration_days = db.Column(db.Integer, nullable=False)
    price         = db.Column(db.Float, nullable=False)
    is_active     = db.Column(db.Boolean, nullable=False, default=True)
    # ── Public-facing content (editable by staff/admin from the dashboard,
    #    displayed on the home page pricing cards) ──
    description   = db.Column(db.Text, nullable=True)
    image_path    = db.Column(db.String(255), nullable=True)
    inclusions    = db.Column(db.Text, nullable=True)   # one inclusion per line
    sort_order    = db.Column(db.Integer, nullable=False, default=0)

    memberships   = db.relationship('Membership', back_populates='plan')
    payments      = db.relationship('Payment', back_populates='plan')

    @property
    def inclusions_list(self):
        if not self.inclusions:
            return []
        return [line.strip() for line in self.inclusions.splitlines() if line.strip()]

    def __repr__(self):
        return f"<MembershipPlan {self.name} ₱{self.price}>"


class GymPromo(db.Model):
    """A limited-time promo (e.g. '16 Sessions', 'Boxing') — editable by
    staff/admin from Manage Content and shown to members on the My
    Membership tab, right below the regular membership plans. A brand-new
    table like this is created automatically by db.create_all() on next
    startup — no ALTER TABLE / manual migration needed."""
    __tablename__ = 'gym_promos'
    id           = db.Column(db.Integer, primary_key=True, autoincrement=True)
    title        = db.Column(db.String(100), nullable=False)
    price        = db.Column(db.Float, nullable=False)
    period       = db.Column(db.String(100), nullable=True)   # e.g. "Limited-time offer"
    description  = db.Column(db.Text, nullable=True)
    inclusions   = db.Column(db.Text, nullable=True)          # one inclusion per line
    valid_until  = db.Column(db.Date, nullable=True)
    image_path   = db.Column(db.String(255), nullable=True)
    is_active    = db.Column(db.Boolean, nullable=False, default=True)
    sort_order   = db.Column(db.Integer, nullable=False, default=0)
    created_at   = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at   = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc),
                             onupdate=lambda: datetime.now(timezone.utc))

    @property
    def inclusions_list(self):
        if not self.inclusions:
            return []
        return [line.strip() for line in self.inclusions.splitlines() if line.strip()]

    def __repr__(self):
        return f"<GymPromo {self.title} ₱{self.price}>"


class Membership(db.Model):
    __tablename__ = 'memberships'
    id          = db.Column(db.Integer, primary_key=True, autoincrement=True)
    member_id   = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'),
                            nullable=False, unique=True, index=True)
    plan_id     = db.Column(db.Integer, db.ForeignKey('membership_plans.id', ondelete='SET NULL'), nullable=True, index=True)
    start_date  = db.Column(db.Date, nullable=False)
    expiry_date = db.Column(db.Date, nullable=False)
    status      = db.Column(db.String(10), nullable=False, default='pending')
    created_at  = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at  = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc),
                            onupdate=lambda: datetime.now(timezone.utc))

    member = db.relationship('User', back_populates='membership')
    plan   = db.relationship('MembershipPlan', back_populates='memberships')


class Coach(db.Model):
    """A personal coach members can request. Availability (days) and
    capacity (max members) are editable by staff from the Coach tab."""
    __tablename__  = 'coaches'
    id             = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name           = db.Column(db.String(60), nullable=False, unique=True)
    available_days = db.Column(db.String(40), nullable=False, default='')  # e.g. "Mon,Wed,Fri"
    max_members    = db.Column(db.Integer, nullable=False, default=10)
    fee            = db.Column(db.Numeric(10, 2), nullable=False, default=0)  # added on top of the plan price when a member picks this coach
    is_active      = db.Column(db.Boolean, nullable=False, default=True)
    updated_at     = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc),
                               onupdate=lambda: datetime.now(timezone.utc))

    @property
    def available_days_list(self):
        if not self.available_days:
            return []
        return [d.strip() for d in self.available_days.split(',') if d.strip()]

    def __repr__(self):
        return f"<Coach {self.name}>"


class Payment(db.Model):
    __tablename__    = 'payments'
    id               = db.Column(db.Integer, primary_key=True, autoincrement=True)
    member_id        = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    plan_id          = db.Column(db.Integer, db.ForeignKey('membership_plans.id'), nullable=True, index=True)
    amount           = db.Column(db.Numeric(10, 2), nullable=False)
    method           = db.Column(db.String(32), nullable=False)
    reference_number = db.Column(db.String(60), nullable=True)
    proof_image_path = db.Column(db.String(255), nullable=True)
    # Members may attach up to 3 receipt screenshots total (e.g. when a
    # single GCash transfer got split across screenshots) — the primary
    # slot above plus these two optional extra ones. Only the primary slot
    # is ever fed through OCR (see /member/ocr-gcash-proof); slots 2 and 3
    # are for admin's manual review only.
    proof_image_path_2 = db.Column(db.String(255), nullable=True)
    proof_image_path_3 = db.Column(db.String(255), nullable=True)
    is_student            = db.Column(db.Boolean, nullable=False, default=False)
    student_id_image_path = db.Column(db.String(255), nullable=True)
    wants_coach           = db.Column(db.Boolean, nullable=False, default=False)
    coach_name             = db.Column(db.String(60), nullable=True)
    requested_start_date  = db.Column(db.Date, nullable=True)
    status           = db.Column(db.String(10), nullable=False, default='pending', index=True)
    recorded_by_id   = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True, index=True)
    notes            = db.Column(db.Text, nullable=True)
    paid_at          = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc), index=True)
    verified_at      = db.Column(db.DateTime, nullable=True)
    notified         = db.Column(db.Boolean, nullable=False, default=False)
    staff_viewed     = db.Column(db.Boolean, nullable=False, default=False)

    member      = db.relationship('User', foreign_keys=[member_id], back_populates='payments')
    plan        = db.relationship('MembershipPlan', back_populates='payments')
    recorded_by = db.relationship('User', foreign_keys=[recorded_by_id], back_populates='recorded_payments')


class Attendance(db.Model):
    __tablename__ = 'attendance'
    id           = db.Column(db.Integer, primary_key=True, autoincrement=True)
    member_id    = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    check_in     = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc), index=True)
    check_out    = db.Column(db.DateTime, nullable=True)
    duration_min = db.Column(db.Integer, nullable=True)
    logged_by_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)

    member    = db.relationship('User', foreign_keys=[member_id], back_populates='attendance')
    logged_by = db.relationship('User', foreign_keys=[logged_by_id])


class WalkIn(db.Model):
    """A one-off Daily-plan visit for a guest who doesn't have (or doesn't
    want) a full member account — recorded by staff on the spot. Kept
    separate from Payment/Membership since a walk-in isn't a membership
    that renews or expires, just a single paid visit."""
    __tablename__     = 'walk_ins'
    id                = db.Column(db.Integer, primary_key=True, autoincrement=True)
    first_name        = db.Column(db.String(50), nullable=False)
    middle_initial    = db.Column(db.String(5), nullable=True)
    last_name         = db.Column(db.String(50), nullable=False)
    extension_name    = db.Column(db.String(10), nullable=True)
    phone             = db.Column(db.String(15), nullable=True)
    email             = db.Column(db.String(120), nullable=True)
    amount            = db.Column(db.Numeric(10, 2), nullable=False)
    plan_type         = db.Column(db.String(20), nullable=False, default='Daily')
    method            = db.Column(db.String(32), nullable=False, default='Cash')
    wants_coach       = db.Column(db.Boolean, nullable=False, default=False)
    coach_name        = db.Column(db.String(60), nullable=True)
    coach_fee         = db.Column(db.Numeric(10, 2), nullable=False, default=0)
    recorded_by_id    = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True, index=True)
    created_at        = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc), index=True)

    recorded_by = db.relationship('User', foreign_keys=[recorded_by_id])

    @property
    def full_name(self):
        return _format_full_name(self.first_name, self.last_name, self.middle_initial, self.extension_name)


class BodyGoal(db.Model):
    __tablename__    = 'body_goals'
    id               = db.Column(db.Integer, primary_key=True, autoincrement=True)
    member_id        = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    current_weight   = db.Column(db.Numeric(5, 2), nullable=True)
    current_body_fat = db.Column(db.Numeric(5, 2), nullable=True)
    current_muscle   = db.Column(db.Numeric(5, 2), nullable=True)
    current_bmi      = db.Column(db.Numeric(5, 2), nullable=True)
    goal_weight      = db.Column(db.Numeric(5, 2), nullable=True)
    goal_body_fat    = db.Column(db.Numeric(5, 2), nullable=True)
    goal_muscle      = db.Column(db.Numeric(5, 2), nullable=True)
    # ── Stage 3 — AI Fitness Goal & Recommendation feature: deterministic
    #    calculation snapshot (BMI/BMR/TDEE/targets), computed by the app
    #    (never by AI) and stored on this same progress row so historical
    #    entries keep the numbers that were true at that point in time,
    #    rather than being silently recalculated later. current_bmi above
    #    is reused for BMI; these four are new. ──
    bmr               = db.Column(db.Numeric(6, 2), nullable=True)
    tdee              = db.Column(db.Numeric(6, 2), nullable=True)
    calorie_target    = db.Column(db.Integer, nullable=True)
    protein_target_g  = db.Column(db.Integer, nullable=True)
    notes            = db.Column(db.Text, nullable=True)
    recorded_at      = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))

    member = db.relationship('User', back_populates='body_goals')


class FitnessProfile(db.Model):
    """The member's current fitness-intake profile for the AI Fitness Goal
    and Recommendation feature — one row per member, holding the relatively
    stable inputs (height, sex, activity level, chosen goal) that Step 3's
    deterministic BMI/BMR/TDEE calculations and the AI recommendation step
    will read from later. Deliberately kept separate from BodyGoal, which
    is a repeating time-series of individual weigh-ins/measurements, and
    separate from User, which is identity/auth data — mixing either in here
    would either duplicate stable data across every progress entry, or blur
    an auth table with fitness intake. See project chat history / design
    notes for the full rationale.

    fitness_goal starts NULL and is only set once the member completes
    Step 2 (goal selection); Step 1 (this table's other fields) can be
    saved/completed on its own first.
    """
    __tablename__      = 'fitness_profiles'
    id                 = db.Column(db.Integer, primary_key=True, autoincrement=True)
    member_id          = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'),
                                    nullable=False, unique=True, index=True)
    height_cm          = db.Column(db.Numeric(5, 2), nullable=False)
    sex                = db.Column(db.String(10), nullable=False)   # 'male' | 'female'
    activity_level     = db.Column(db.String(20), nullable=False)   # 'low_activity' | 'moderate_activity' | 'high_activity'
    fitness_goal       = db.Column(db.String(10), nullable=True)    # 'CUT' | 'BULK' | 'MAINTAIN' | 'RECOMP' — NULL until Step 2 is completed
    created_at         = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at         = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc),
                                    onupdate=lambda: datetime.now(timezone.utc))

    member = db.relationship('User', back_populates='fitness_profile')

    def __repr__(self):
        return f"<FitnessProfile member_id={self.member_id} goal={self.fitness_goal}>"


class FoodItem(db.Model):
    """Curated food catalog for the AI Fitness Goal & Recommendation
    feature's deterministic meal-plan generator (Stage 4 — see
    _recommend_meal_plan()). Seeded once at startup with a fixed, practical
    dataset (see seed_default_fitness_catalog()) — NOT member- or
    admin-editable in this stage; admin/member management is out of scope
    for now and can be added in a future stage."""
    __tablename__          = 'food_items'
    id                     = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name                   = db.Column(db.String(80), nullable=False)
    category               = db.Column(db.String(20), nullable=False)  # protein | carb | fruit | vegetable | healthy_fat | other
    suitable_meal          = db.Column(db.String(40), nullable=False)  # breakfast | lunch | dinner | snack | any, or a comma-separated combination (e.g. "breakfast,lunch,snack")
    serving_description    = db.Column(db.String(120), nullable=False) # e.g. "150g grilled chicken breast"
    calories_per_serving   = db.Column(db.Integer, nullable=False)
    protein_g_per_serving  = db.Column(db.Integer, nullable=False)
    is_active              = db.Column(db.Boolean, nullable=False, default=True)

    def __repr__(self):
        return f"<FoodItem {self.name}>"


class Exercise(db.Model):
    """Curated exercise catalog for the deterministic workout-recommendation
    generator (Stage 4 — see _recommend_workouts()). equipment_name /
    equipment_note are plain strings on the row itself — a simple,
    controlled exercise-to-equipment mapping with NO relationship to the
    existing GymEquipment table, per explicit instruction (that table stays
    fully untouched and unrelated to this feature). Seeded once at startup
    with a fixed dataset — not admin/member-editable in this stage."""
    __tablename__     = 'exercises'
    id                = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name              = db.Column(db.String(80), nullable=False)
    target_area       = db.Column(db.String(40), nullable=False)   # e.g. "Chest", "Back", "Legs", "Full Body", "Cardio"
    exercise_type     = db.Column(db.String(15), nullable=False)   # resistance | cardio
    goal_tags         = db.Column(db.String(60), nullable=False)   # comma-separated subset of CUT,BULK,MAINTAIN,RECOMP
    default_sets      = db.Column(db.String(10), nullable=True)    # display text, e.g. "3" or "3-4"
    default_reps      = db.Column(db.String(20), nullable=True)    # display text, e.g. "8-12" or "20-30 min"
    purpose           = db.Column(db.String(160), nullable=True)   # short "general purpose" description
    equipment_name    = db.Column(db.String(60), nullable=True)
    equipment_note    = db.Column(db.String(160), nullable=True)
    sub_target        = db.Column(db.String(60), nullable=True)    # finer-grained area within target_area, e.g. "Upper Chest"
    specific_target   = db.Column(db.String(60), nullable=True)    # Level-3 detail within sub_target — currently populated only for Biceps/Triceps (e.g. "Long Head"); NULL elsewhere
    instructions      = db.Column(db.Text, nullable=True)          # rule-based, curated step-by-step instructions (NOT AI-generated)
    is_active         = db.Column(db.Boolean, nullable=False, default=True)

    def __repr__(self):
        return f"<Exercise {self.name}>"


class Announcement(db.Model):
    __tablename__ = 'announcements'
    id           = db.Column(db.Integer, primary_key=True, autoincrement=True)
    title        = db.Column(db.String(120), nullable=False)
    body         = db.Column(db.Text, nullable=False)
    target       = db.Column(db.String(20), nullable=False, default='all')
    posted_by_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    is_active    = db.Column(db.Boolean, nullable=False, default=True)
    created_at   = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at   = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc),
                             onupdate=lambda: datetime.now(timezone.utc))

    posted_by = db.relationship('User', foreign_keys=[posted_by_id])


class MembershipReminder(db.Model):
    """A one-off 'your plan is expiring' notice queued by staff/admin from
    the 'Members Expiring This Week' panel (Send Reminder button). Unlike
    Announcement (broadcast to many members), each row targets exactly one
    member. It pops up as a 'message bot' popup the next time that member
    loads their dashboard, then is marked delivered so it never shows twice.
    A brand-new table like this is created automatically by db.create_all()
    on next startup — no ALTER TABLE / manual migration needed."""
    __tablename__ = 'membership_reminders'
    id           = db.Column(db.Integer, primary_key=True, autoincrement=True)
    member_id    = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    plan_name    = db.Column(db.String(50), nullable=True)
    expiry_date  = db.Column(db.Date, nullable=True)
    message      = db.Column(db.Text, nullable=False)
    sent_by_id   = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    created_at   = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    delivered_at = db.Column(db.DateTime, nullable=True)

    member  = db.relationship('User', foreign_keys=[member_id])
    sent_by = db.relationship('User', foreign_keys=[sent_by_id])


# Many-to-many join table linking a Service to the Equipment/Machines used
# for it, so the member dashboard can show "Equipment Used" per service.
# A brand-new table like this is created automatically by db.create_all()
# on next startup — no ALTER TABLE / manual migration needed.
service_equipment = db.Table(
    'service_equipment',
    db.Column('service_id',   db.Integer, db.ForeignKey('gym_services.id',  ondelete='CASCADE'), primary_key=True),
    db.Column('equipment_id', db.Integer, db.ForeignKey('gym_equipment.id', ondelete='CASCADE'), primary_key=True),
)


class GymService(db.Model):
    """A service offered at the gym (e.g. 'Personal Coaching', 'Locker
    Rental') — editable by staff/admin and shown on the public home page."""
    __tablename__ = 'gym_services'
    id           = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name         = db.Column(db.String(80), nullable=False)
    description  = db.Column(db.Text, nullable=True)
    image_path   = db.Column(db.String(255), nullable=True)
    category     = db.Column(db.String(60), nullable=True)   # e.g. "Boxing", "Coaching"
    icon         = db.Column(db.String(8), nullable=True)    # single emoji shown on chips/cards
    is_active    = db.Column(db.Boolean, nullable=False, default=True)
    sort_order   = db.Column(db.Integer, nullable=False, default=0)
    created_at   = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at   = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc),
                             onupdate=lambda: datetime.now(timezone.utc))
    equipment    = db.relationship('GymEquipment', secondary=service_equipment,
                                    order_by='GymEquipment.sort_order, GymEquipment.id')

    def __repr__(self):
        return f"<GymService {self.name}>"


class GymEquipment(db.Model):
    """A piece of equipment / machine / training area — editable by
    staff/admin and shown on the public home page."""
    __tablename__ = 'gym_equipment'
    id           = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name         = db.Column(db.String(80), nullable=False)
    description  = db.Column(db.Text, nullable=True)
    image_path   = db.Column(db.String(255), nullable=True)
    category     = db.Column(db.String(60), nullable=True)   # e.g. "Boxing", "Strengthening"
    icon         = db.Column(db.String(8), nullable=True)    # single emoji shown on chips/cards
    is_active    = db.Column(db.Boolean, nullable=False, default=True)
    sort_order   = db.Column(db.Integer, nullable=False, default=0)
    # True for the broad facility-zone photos (Weight Area, Cardio Area,
    # Reception, etc.) used on the home page's "Our Facilities" section —
    # they're not real individual machines, so they're hidden from the
    # member dashboard's "Gym Machines and Equipment" list and from the
    # equipment picker on the Services form.
    is_facility  = db.Column(db.Boolean, nullable=False, default=False)
    created_at   = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at   = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc),
                             onupdate=lambda: datetime.now(timezone.utc))

    def __repr__(self):
        return f"<GymEquipment {self.name}>"


class GymSettings(db.Model):
    """Single-row table holding gym-wide settings editable by Admin —
    the GCash account members send payments to, and the Terms & Policy
    text/read-time shown during registration. Always accessed through
    _get_gym_settings(), which gets/creates row id=1."""
    __tablename__ = 'gym_settings'
    id                 = db.Column(db.Integer, primary_key=True, autoincrement=True)
    gcash_number       = db.Column(db.String(20),  nullable=True)
    gcash_account_name = db.Column(db.String(120), nullable=True)
    # Optional QR code image (e.g. InstaPay/GCash "scan to pay" QR) shown to
    # members alongside the number, so they can scan instead of typing it in
    # manually. Nullable — the number/name still work fine on their own if
    # no QR has been uploaded.
    gcash_qr_path      = db.Column(db.String(255), nullable=True)
    # Plain text shown inside the Terms & Policy modal on registration.
    # Admin-editable via Settings → Terms & Policy. Blank lines separate
    # paragraphs; it is escaped and converted to safe HTML at render time
    # (see terms_text_to_html()) — admins never type HTML here.
    terms_content       = db.Column(db.Text, nullable=True)
    # Minimum number of seconds the modal must be open (accumulated across
    # opens) before a new member is allowed to check "I agree" — an
    # estimated-reading-time gate so members can't just tick the box
    # without spending any time on it. Stored in seconds internally; the
    # admin UI shows/collects this as whole minutes.
    terms_read_seconds  = db.Column(db.Integer, nullable=False, default=60)
    updated_at         = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc),
                                    onupdate=lambda: datetime.now(timezone.utc))

    def __repr__(self):
        return f"<GymSettings gcash_number={self.gcash_number}>"


# Default Terms & Policy text (the content that used to be hardcoded into
# trmem.html) — seeded onto the settings row the first time it's created,
# and used as a fallback if an admin ever clears the field entirely.
# Plain text: blank lines become new paragraphs (see terms_text_to_html()).
DEFAULT_TERMS_TEXT = """FITNESS AREA RULES:

- Use facilities and equipment at your own risk.
- Use equipment properly and follow directions carefully.
- Do not lean on the equipment. Keep hands away from moving parts.
- Consult a physician before beginning an exercise program.
- No food or drinks (except water). No smoking.
- Children under 18 must be accompanied by an adult.
- Proper fitness attire is required. No boots, street shoes, sandals or bare feet.
- Report any damaged equipment to management immediately. DO NOT USE.
- Always be courteous and respectful of others.
- Please return all equipment to its place and wipe down machines after use.

ONLINE MEMBERSHIP SYSTEM TERMS:

- You must provide true and accurate personal information when registering, and keep your login credentials confidential. Accounts may not be shared.
- Submitting a payment (GCash reference and proof of payment) does not activate your plan immediately -- it remains pending until verified by staff or admin. Power Gym is not liable for delays in verification.
- Submitting false, altered, or fraudulent proof of payment is grounds for account suspension or termination.
- The system may be temporarily unavailable due to maintenance or technical issues; Power Gym is not liable for inability to access your dashboard or submit payments during downtime.
- Password reset is done via a 6-digit One-Time PIN (OTP) sent to your registered email. You have 3 attempts to enter the correct OTP; after 3 incorrect attempts, you must wait 30 minutes before a new OTP can be sent.
- Personal information, payment references, and uploaded payment screenshots are collected only for account and payment verification, and are accessible only to authorized staff/admin.
- Check-in and check-out times recorded by staff serve as the official attendance record for your account. Report any discrepancies to staff directly.
- Members may not attempt to access staff or admin functions, tamper with the system, or access another member's account. Violations may result in account termination.
- By checking "I agree" and completing registration, you provide valid electronic consent to these Terms & Policy, equivalent to a signed physical agreement.

POLICIES:

- Refund Policy: All membership payments are non-refundable once a plan has been activated or renewed.
- Cancellation/Freeze Policy: Membership freezes or cancellations must be requested in person at the front desk and are subject to management approval.
- Privacy Policy: Personal information and payment proof submitted through this system are used solely for account management and payment verification, and will not be shared with third parties without consent.
- Photography/CCTV Policy: The premises may be monitored by CCTV for security purposes. Members consent to being recorded while on the premises.
- Amendment Policy: Power Gym reserves the right to update these Terms & Policy at any time. Continued use of the membership or system constitutes acceptance of the updated terms."""


def terms_text_to_html(text):
    """Turn the admin's plain-text Terms & Policy into safe HTML for the
    registration modal: escapes everything (so admin-entered text can
    never inject markup/scripts), then treats a blank line as a paragraph
    break and a single line break as <br>. Registered below as the Jinja
    filter `terms_html`."""
    if not text:
        return Markup('')
    normalized = text.replace('\r\n', '\n').strip('\n')
    paragraphs = [p for p in normalized.split('\n\n') if p.strip()]
    rendered = []
    for para in paragraphs:
        escaped = escape(para)
        escaped = Markup('<br>').join(escaped.split('\n'))
        rendered.append(f'<p>{escaped}</p>')
    return Markup(''.join(rendered))


app.jinja_env.filters['terms_html'] = terms_text_to_html


def _get_gym_settings():
    """Fetch the singleton settings row, creating it with sensible
    defaults on first use so callers never have to null-check."""
    settings = GymSettings.query.get(1)
    if settings is None:
        settings = GymSettings(id=1, gcash_number='0945 397 0594', gcash_account_name='LYDIA M. EMATA',
                                gcash_qr_path='images/gcash-qr.jpg',
                                terms_content=DEFAULT_TERMS_TEXT, terms_read_seconds=60)
        db.session.add(settings)
        db.session.commit()
    elif not settings.terms_content:
        # Backfill for rows created before the terms columns existed.
        settings.terms_content = DEFAULT_TERMS_TEXT
        db.session.commit()
    return settings


# ── Content-management (plans / services / equipment) helpers ──────────
def _content_role_ok():
    return session.get('role') in ('staff', 'admin')


def _save_content_image(file_storage, existing_path=None):
    """Save an uploaded content image to CONTENT_UPLOAD_FOLDER and return the
    web-relative path to store on the model. Returns existing_path unchanged
    if no new file was uploaded. Raises ValueError on invalid file."""
    if not file_storage or not file_storage.filename:
        return existing_path
    ext = file_storage.filename.rsplit('.', 1)[-1].lower() if '.' in file_storage.filename else ''
    if ext not in CONTENT_ALLOWED_EXT:
        raise ValueError('Image must be a PNG, JPG, JPEG, or WEBP file.')
    file_storage.seek(0, os.SEEK_END)
    size = file_storage.tell()
    file_storage.seek(0)
    if size > CONTENT_MAX_BYTES:
        raise ValueError('Image must be smaller than 8MB.')
    safe_name = secure_filename(f"{secrets.token_hex(8)}.{ext}")
    file_storage.save(os.path.join(CONTENT_UPLOAD_FOLDER, safe_name))
    return f'uploads/content/{safe_name}'


def _save_profile_picture(file_storage):
    """Save a member's self-registration profile picture to
    PROFILE_UPLOAD_FOLDER and return the web-relative path to store on
    User.profile_picture. Unlike _save_content_image, a file is REQUIRED
    here — callers must check for a non-empty file_storage themselves
    (registration hard-blocks account creation without one) — this
    function only validates the file itself once it's known to be present.
    Raises ValueError on invalid file."""
    ext = file_storage.filename.rsplit('.', 1)[-1].lower() if '.' in file_storage.filename else ''
    if ext not in PROFILE_ALLOWED_EXT:
        raise ValueError('Profile picture must be a PNG, JPG, JPEG, or WEBP file.')
    file_storage.seek(0, os.SEEK_END)
    size = file_storage.tell()
    file_storage.seek(0)
    if size > PROFILE_MAX_BYTES:
        raise ValueError('Profile picture must be smaller than 5MB.')
    safe_name = secure_filename(f"{secrets.token_hex(8)}.{ext}")
    file_storage.save(os.path.join(PROFILE_UPLOAD_FOLDER, safe_name))
    return f'uploads/profile_pictures/{safe_name}'


def _delete_content_image(image_path):
    """Best-effort removal of a previously-uploaded content image from disk."""
    if not image_path:
        return
    full_path = os.path.join(app.root_path, 'static', image_path)
    try:
        if os.path.isfile(full_path):
            os.remove(full_path)
    except OSError:
        pass


def _plan_to_dict(p):
    return {
        'id': p.id, 'name': p.name, 'duration_days': p.duration_days,
        'price': p.price, 'is_active': p.is_active,
        'description': p.description or '', 'image_path': p.image_path or '',
        'inclusions': p.inclusions or '', 'sort_order': p.sort_order,
    }


def _promo_to_dict(p):
    # Uses the generic 'name' key (mapped from title) so the shared
    # Manage Content admin UI (ContentManager in tr-common.js) can treat
    # promos the same as every other content type without special-casing
    # the field name.
    return {
        'id': p.id, 'name': p.title, 'price': p.price, 'period': p.period or '',
        'is_active': p.is_active, 'description': p.description or '',
        'image_path': p.image_path or '', 'inclusions': p.inclusions or '',
        'valid_until': p.valid_until.isoformat() if p.valid_until else '',
        'sort_order': p.sort_order,
    }


DEFAULT_SERVICE_ICON   = '🛎️'
DEFAULT_EQUIPMENT_ICON = '🏋️'
DEFAULT_CATEGORY       = 'General'


def _service_to_dict(s):
    return {
        'id': s.id, 'name': s.name, 'description': s.description or '',
        'image_path': s.image_path or '', 'is_active': s.is_active,
        'category': s.category or DEFAULT_CATEGORY,
        'icon': s.icon or DEFAULT_SERVICE_ICON,
        'sort_order': s.sort_order,
        # Ids only here (admin form pre-checks these boxes); the member
        # dashboard gets fuller name/icon objects via services_data below.
        'equipment_ids': [e.id for e in s.equipment],
    }


def _equipment_to_dict(e):
    return {
        'id': e.id, 'name': e.name, 'description': e.description or '',
        'image_path': e.image_path or '', 'is_active': e.is_active,
        'category': e.category or DEFAULT_CATEGORY,
        'icon': e.icon or DEFAULT_EQUIPMENT_ICON,
        'sort_order': e.sort_order,
        'is_facility': e.is_facility,
    }


CATEGORY_ICONS = {
    'boxing': '🥊', 'strengthening': '💪', 'cardio zone': '🏃', 'weight loss': '🔥',
    'functional training': '🤸', 'coaching': '🧑‍🏫', 'membership perks': '🎁',
    'facilities': '🏢', 'classes': '📅', 'general': '🛎️',
    # Equipment/Machine categories (staff & admin "Category" picker)
    'cardio equipment': '🏃', 'strength machine': '🏋️', 'free weights': '🏋️',
    'strength equipment': '💪', 'body weight equipments': '🤸',
    'fitness accessories': '🪢', 'recovery equipment': '🧘',
}


def _group_content_by_category(items, default_icon='🛎️'):
    """Group a list of GymService/GymEquipment rows into an ordered list of
    (category_name, category_icon, [items]) tuples, preserving each item's
    sort_order and putting categories in first-seen order. Items with no
    category fall into a trailing "General" group. The category header
    icon comes from a small known-category lookup (falling back to the
    first item's own icon, then a generic default) so it reads distinctly
    from each item's individual icon."""
    groups = OrderedDict()
    for item in items:
        cat = (item.category or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
        groups.setdefault(cat, []).append(item)
    result = []
    for cat, cat_items in groups.items():
        cat_icon = CATEGORY_ICONS.get(cat.lower()) or (cat_items[0].icon if cat_items[0].icon else default_icon)
        result.append((cat, cat_icon, cat_items))
    return result


# ── Content-management API: Category picker ─────────────────────────────
@app.route('/api/content/categories', methods=['GET'])
def api_list_categories():
    """Categories currently in use, so the staff/admin form can offer real,
    already-typed values instead of a fixed hardcoded list — keeping a
    service's category (e.g. "Boxing") spelled exactly the same as the
    equipment tagged under it, which is what makes them group together
    correctly on the member dashboard.

    Accepts an optional ?type= filter: 'services', 'machines', or
    'facilities'. Facilities and Machines both live in the GymEquipment
    table (split by is_facility), so without this split a facility-only
    category (e.g. "Cardio Zone" on the Cardio Area facility) would leak
    into the Machines form, and vice versa. With no type given, everything
    is merged (legacy/back-compat behavior)."""
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    content_type = (request.args.get('type') or '').strip().lower()
    used = set()
    if content_type in ('', 'services'):
        for row in GymService.query.with_entities(GymService.category).distinct():
            if row[0] and row[0].strip():
                used.add(row[0].strip())
    if content_type in ('', 'machines'):
        for row in (GymEquipment.query.filter_by(is_facility=False)
                    .with_entities(GymEquipment.category).distinct()):
            if row[0] and row[0].strip():
                used.add(row[0].strip())
    if content_type in ('', 'facilities'):
        for row in (GymEquipment.query.filter_by(is_facility=True)
                    .with_entities(GymEquipment.category).distinct()):
            if row[0] and row[0].strip():
                used.add(row[0].strip())
    return jsonify(success=True, categories=sorted(used, key=str.lower))


def _category_base_query(content_type):
    """Return (model, query) for the GymService/GymEquipment rows that back
    a given category-manager content_type ('services', 'machines', or
    'facilities'). Raises ValueError for any other/missing type — the
    category manager always operates on one specific tab, unlike the
    plain-list endpoint above which also accepts '' to mean "everything"."""
    if content_type == 'services':
        return GymService, GymService.query
    if content_type == 'machines':
        return GymEquipment, GymEquipment.query.filter_by(is_facility=False)
    if content_type == 'facilities':
        return GymEquipment, GymEquipment.query.filter_by(is_facility=True)
    raise ValueError("type must be 'services', 'machines', or 'facilities'.")


@app.route('/api/content/categories/manage', methods=['GET'])
def api_list_categories_manage():
    """Categories for one content type, each with how many items currently
    use it — powers the "Manage Categories" list (rename/delete) in the
    admin/staff dashboards. Unlike /api/content/categories (the plain
    autocomplete list), a specific ?type= is required here since rename/
    delete always act on one table/tab at a time."""
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    content_type = (request.args.get('type') or '').strip().lower()
    try:
        _, query = _category_base_query(content_type)
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400
    counts = OrderedDict()
    for row in query.with_entities(GymService.category if content_type == 'services' else GymEquipment.category).all():
        cat = (row[0] or '').strip()
        if not cat:
            continue
        counts[cat] = counts.get(cat, 0) + 1
    categories = [{'name': name, 'count': counts[name]} for name in sorted(counts, key=str.lower)]
    return jsonify(success=True, categories=categories)


@app.route('/api/content/categories/rename', methods=['POST'])
def api_rename_category():
    """Rename a category across every item of one content type. Renaming to
    a name that's already in use for that type merges the two groups
    (they'll simply share the same category string afterward), which is
    intentional — it's the easiest way to fix a near-duplicate spelling."""
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    data = request.get_json(silent=True) or {}
    content_type = (data.get('type') or '').strip().lower()
    old_name = (data.get('old_name') or '').strip()
    new_name = (data.get('new_name') or '').strip()[:60]
    try:
        model, query = _category_base_query(content_type)
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400
    if not old_name:
        return jsonify(success=False, error='Missing category to rename.'), 400
    if not new_name:
        return jsonify(success=False, error='New category name cannot be empty.'), 400
    items = query.filter(model.category == old_name).all()
    if not items:
        return jsonify(success=False, error='That category is no longer in use.'), 404
    for item in items:
        item.category = new_name
    db.session.commit()
    return jsonify(success=True, message=f'Renamed "{old_name}" to "{new_name}" for {len(items)} item(s).',
                   affected=len(items))


@app.route('/api/content/categories/delete', methods=['POST'])
def api_delete_category():
    """Remove a category from every item of one content type. This does not
    delete the items themselves — it just clears their category, so they
    fall back to the default "General" grouping on the member dashboard."""
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    data = request.get_json(silent=True) or {}
    content_type = (data.get('type') or '').strip().lower()
    name = (data.get('name') or '').strip()
    try:
        model, query = _category_base_query(content_type)
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400
    if not name:
        return jsonify(success=False, error='Missing category to delete.'), 400
    items = query.filter(model.category == name).all()
    if not items:
        return jsonify(success=False, error='That category is no longer in use.'), 404
    for item in items:
        item.category = None
    db.session.commit()
    return jsonify(success=True, message=f'Removed category "{name}" from {len(items)} item(s).',
                   affected=len(items))


# ── Content-management API: Equipment/Facility Name manager ─────────────
# Mirrors the category manager above, but for the item NAME itself (e.g.
# "Treadmill", "Locker Room"). Only applies to machines/facilities — both
# live in GymEquipment, split by is_facility — since Plans and Services
# don't use the shared "pick a name from the list" dropdown.
def _name_base_query(content_type):
    if content_type == 'machines':
        return GymEquipment.query.filter_by(is_facility=False)
    if content_type == 'facilities':
        return GymEquipment.query.filter_by(is_facility=True)
    raise ValueError("type must be 'machines' or 'facilities'.")


@app.route('/api/content/names/manage', methods=['GET'])
def api_list_names_manage():
    """Distinct names for one type, each with how many items use it —
    powers the edit/delete affordances on the Name dropdown."""
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    content_type = (request.args.get('type') or '').strip().lower()
    try:
        query = _name_base_query(content_type)
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400
    counts = OrderedDict()
    for row in query.with_entities(GymEquipment.name).all():
        nm = (row[0] or '').strip()
        if not nm:
            continue
        counts[nm] = counts.get(nm, 0) + 1
    names = [{'name': name, 'count': counts[name]} for name in sorted(counts, key=str.lower)]
    return jsonify(success=True, names=names)


@app.route('/api/content/names/rename', methods=['POST'])
def api_rename_name():
    """Rename every item currently sharing a name (e.g. fix "Treadmil" ->
    "Treadmill" everywhere at once) instead of editing each one by hand."""
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    data = request.get_json(silent=True) or {}
    content_type = (data.get('type') or '').strip().lower()
    old_name = (data.get('old_name') or '').strip()
    new_name = (data.get('new_name') or '').strip()[:80]  # matches GymEquipment.name's column length
    try:
        query = _name_base_query(content_type)
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400
    if not old_name:
        return jsonify(success=False, error='Missing name to rename.'), 400
    if not new_name:
        return jsonify(success=False, error='New name cannot be empty.'), 400
    items = query.filter(GymEquipment.name == old_name).all()
    if not items:
        return jsonify(success=False, error='That name is no longer in use.'), 404
    for item in items:
        item.name = new_name
    db.session.commit()
    return jsonify(success=True, message=f'Renamed "{old_name}" to "{new_name}" for {len(items)} item(s).',
                   affected=len(items))


@app.route('/api/content/names/delete', methods=['POST'])
def api_delete_name():
    """Permanently delete every item sharing a name. Unlike category delete
    (which just clears a field), a name has no safe default to fall back
    to, so this removes the underlying item(s) entirely — including their
    uploaded images and their linkage on any Service that referenced them.
    The frontend is expected to show a strong, count-aware confirmation
    before calling this."""
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    data = request.get_json(silent=True) or {}
    content_type = (data.get('type') or '').strip().lower()
    name = (data.get('name') or '').strip()
    try:
        query = _name_base_query(content_type)
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400
    if not name:
        return jsonify(success=False, error='Missing name to delete.'), 400
    items = query.filter(GymEquipment.name == name).all()
    if not items:
        return jsonify(success=False, error='That name is no longer in use.'), 404
    count = len(items)
    for item in items:
        _delete_content_image(item.image_path)
        db.session.delete(item)
    db.session.commit()
    return jsonify(success=True, message=f'Deleted {count} item(s) named "{name}".', affected=count)


# ── Content-management API: Membership Plans ────────────────────────────
@app.route('/api/content/plans', methods=['GET'])
def api_list_plans():
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    plans = MembershipPlan.query.order_by(MembershipPlan.sort_order, MembershipPlan.id).all()
    return jsonify(success=True, items=[_plan_to_dict(p) for p in plans])


@app.route('/api/content/plans/save', methods=['POST'])
def api_save_plan():
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403

    plan_id = request.form.get('id', '').strip()
    name          = (request.form.get('name') or '').strip()
    duration_days = request.form.get('duration_days', '').strip()
    price         = request.form.get('price', '').strip()
    description   = (request.form.get('description') or '').strip()
    inclusions    = (request.form.get('inclusions') or '').strip()
    sort_order    = request.form.get('sort_order', '0').strip()
    is_active     = request.form.get('is_active', 'true').strip().lower() != 'false'
    remove_image  = request.form.get('remove_image', 'false').strip().lower() == 'true'

    if not name:
        return jsonify(success=False, error='Plan name is required.'), 400
    try:
        duration_days = int(duration_days)
        price = float(price)
        sort_order = int(sort_order or 0)
        if duration_days <= 0 or price < 0:
            raise ValueError()
    except ValueError:
        return jsonify(success=False, error='Duration and price must be valid positive numbers.'), 400

    if plan_id:
        plan = MembershipPlan.query.get(plan_id)
        if not plan:
            return jsonify(success=False, error='Plan not found.'), 404
        dupe = MembershipPlan.query.filter(MembershipPlan.name == name, MembershipPlan.id != plan.id).first()
    else:
        plan = MembershipPlan()
        dupe = MembershipPlan.query.filter_by(name=name).first()

    if dupe:
        return jsonify(success=False, error='A plan with that name already exists.'), 400

    try:
        image_path = plan.image_path if plan_id else None
        if remove_image:
            _delete_content_image(image_path)
            image_path = None
        else:
            new_path = _save_content_image(request.files.get('image'), image_path)
            if new_path != image_path:
                _delete_content_image(image_path)
            image_path = new_path
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400

    plan.name          = name
    plan.duration_days = duration_days
    plan.price         = price
    plan.description   = description or None
    plan.inclusions    = inclusions or None
    plan.image_path    = image_path
    plan.sort_order    = sort_order
    plan.is_active      = is_active

    if not plan_id:
        db.session.add(plan)
    db.session.commit()
    return jsonify(success=True, message='Plan saved.', item=_plan_to_dict(plan))


@app.route('/api/content/plans/<int:plan_id>/delete', methods=['POST'])
def api_delete_plan(plan_id):
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    plan = MembershipPlan.query.get(plan_id)
    if not plan:
        return jsonify(success=False, error='Plan not found.'), 404
    if Membership.query.filter_by(plan_id=plan.id).first():
        # Don't hard-delete a plan members are actively on — deactivate instead.
        plan.is_active = False
        db.session.commit()
        return jsonify(success=True, message='Plan is in use by members, so it was deactivated instead of deleted.', deactivated=True)
    _delete_content_image(plan.image_path)
    db.session.delete(plan)
    db.session.commit()
    return jsonify(success=True, message='Plan deleted.')


# ── Content-management API: Promos ──────────────────────────────────────
@app.route('/api/content/promos', methods=['GET'])
def api_list_promos():
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    promos = GymPromo.query.order_by(GymPromo.sort_order, GymPromo.id).all()
    return jsonify(success=True, items=[_promo_to_dict(p) for p in promos])


@app.route('/api/content/promos/save', methods=['POST'])
def api_save_promo():
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403

    promo_id     = request.form.get('id', '').strip()
    # 'name' is what the shared Manage Content form actually submits (see
    # _promo_to_dict) — it maps onto this model's 'title' column.
    title        = (request.form.get('name') or '').strip()
    price        = request.form.get('price', '').strip()
    period       = (request.form.get('period') or '').strip()
    description  = (request.form.get('description') or '').strip()
    inclusions   = (request.form.get('inclusions') or '').strip()
    valid_until_raw = (request.form.get('valid_until') or '').strip()
    sort_order   = request.form.get('sort_order', '0').strip()
    is_active    = request.form.get('is_active', 'true').strip().lower() != 'false'
    remove_image = request.form.get('remove_image', 'false').strip().lower() == 'true'

    if not title:
        return jsonify(success=False, error='Promo title is required.'), 400
    try:
        price = float(price)
        sort_order = int(sort_order or 0)
        if price < 0:
            raise ValueError()
    except ValueError:
        return jsonify(success=False, error='Price must be a valid positive number.'), 400

    valid_until = None
    if valid_until_raw:
        try:
            valid_until = datetime.strptime(valid_until_raw, '%Y-%m-%d').date()
        except ValueError:
            return jsonify(success=False, error='Valid Until must be a valid date.'), 400

    if promo_id:
        promo = GymPromo.query.get(promo_id)
        if not promo:
            return jsonify(success=False, error='Promo not found.'), 404
    else:
        promo = GymPromo()

    try:
        image_path = promo.image_path if promo_id else None
        if remove_image:
            _delete_content_image(image_path)
            image_path = None
        else:
            new_path = _save_content_image(request.files.get('image'), image_path)
            if new_path != image_path:
                _delete_content_image(image_path)
            image_path = new_path
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400

    promo.title       = title
    promo.price       = price
    promo.period      = period or None
    promo.description = description or None
    promo.inclusions  = inclusions or None
    promo.valid_until = valid_until
    promo.image_path  = image_path
    promo.sort_order  = sort_order
    promo.is_active   = is_active

    if not promo_id:
        db.session.add(promo)
    db.session.commit()
    return jsonify(success=True, message='Promo saved.', item=_promo_to_dict(promo))


@app.route('/api/content/promos/<int:promo_id>/delete', methods=['POST'])
def api_delete_promo(promo_id):
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    promo = GymPromo.query.get(promo_id)
    if not promo:
        return jsonify(success=False, error='Promo not found.'), 404
    # Unlike plans, promos aren't referenced by any Membership/Payment
    # record, so there's nothing that would be left dangling — always a
    # real delete, no "in use, deactivate instead" fallback needed.
    _delete_content_image(promo.image_path)
    db.session.delete(promo)
    db.session.commit()
    return jsonify(success=True, message='Promo deleted.')


# ── Content-management API: Services ─────────────────────────────────────
@app.route('/api/content/services', methods=['GET'])
def api_list_services():
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    items = GymService.query.order_by(GymService.sort_order, GymService.id).all()
    return jsonify(success=True, items=[_service_to_dict(s) for s in items])


@app.route('/api/content/services/save', methods=['POST'])
def api_save_service():
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403

    item_id      = request.form.get('id', '').strip()
    name         = (request.form.get('name') or '').strip()
    description  = (request.form.get('description') or '').strip()
    category     = (request.form.get('category') or '').strip()[:60]
    icon         = (request.form.get('icon') or '').strip()[:8]
    sort_order   = request.form.get('sort_order', '0').strip()
    is_active    = request.form.get('is_active', 'true').strip().lower() != 'false'
    remove_image = request.form.get('remove_image', 'false').strip().lower() == 'true'

    if not name:
        return jsonify(success=False, error='Service name is required.'), 400
    try:
        sort_order = int(sort_order or 0)
    except ValueError:
        sort_order = 0

    if item_id:
        item = GymService.query.get(item_id)
        if not item:
            return jsonify(success=False, error='Service not found.'), 404
    else:
        item = GymService()

    try:
        image_path = item.image_path if item_id else None
        if remove_image:
            _delete_content_image(image_path)
            image_path = None
        else:
            new_path = _save_content_image(request.files.get('image'), image_path)
            if new_path != image_path:
                _delete_content_image(image_path)
            image_path = new_path
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400

    item.name        = name
    item.description = description or None
    item.image_path  = image_path
    item.category    = category or None
    item.icon        = icon or None
    item.sort_order  = sort_order
    item.is_active   = is_active

    # Equipment/machines checked in the form (sent as repeated
    # "equipment_ids" fields). Replacing the whole list on every save keeps
    # this in sync even when boxes are unchecked.
    equipment_ids = [i for i in request.form.getlist('equipment_ids') if i.strip()]
    if equipment_ids:
        item.equipment = GymEquipment.query.filter(GymEquipment.id.in_(equipment_ids)).all()
    else:
        item.equipment = []

    if not item_id:
        db.session.add(item)
    db.session.commit()
    return jsonify(success=True, message='Service saved.', item=_service_to_dict(item))


@app.route('/api/content/services/<int:item_id>/delete', methods=['POST'])
def api_delete_service(item_id):
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    item = GymService.query.get(item_id)
    if not item:
        return jsonify(success=False, error='Service not found.'), 404
    _delete_content_image(item.image_path)
    db.session.delete(item)
    db.session.commit()
    return jsonify(success=True, message='Service deleted.')


# ── Content-management API: Equipment / Machines ─────────────────────────
@app.route('/api/content/equipment', methods=['GET'])
def api_list_equipment():
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    items = GymEquipment.query.order_by(GymEquipment.sort_order, GymEquipment.id).all()
    return jsonify(success=True, items=[_equipment_to_dict(e) for e in items])


@app.route('/api/content/equipment/save', methods=['POST'])
def api_save_equipment():
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403

    item_id      = request.form.get('id', '').strip()
    name         = (request.form.get('name') or '').strip()
    description  = (request.form.get('description') or '').strip()
    category     = (request.form.get('category') or '').strip()[:60]
    icon         = (request.form.get('icon') or '').strip()[:8]
    sort_order   = request.form.get('sort_order', '0').strip()
    is_active    = request.form.get('is_active', 'true').strip().lower() != 'false'
    is_facility  = request.form.get('is_facility', 'false').strip().lower() == 'true'
    remove_image = request.form.get('remove_image', 'false').strip().lower() == 'true'

    if not name:
        return jsonify(success=False, error='Equipment name is required.'), 400
    try:
        sort_order = int(sort_order or 0)
    except ValueError:
        sort_order = 0

    if item_id:
        item = GymEquipment.query.get(item_id)
        if not item:
            return jsonify(success=False, error='Equipment not found.'), 404
    else:
        item = GymEquipment()

    try:
        image_path = item.image_path if item_id else None
        if remove_image:
            _delete_content_image(image_path)
            image_path = None
        else:
            new_path = _save_content_image(request.files.get('image'), image_path)
            if new_path != image_path:
                _delete_content_image(image_path)
            image_path = new_path
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400

    item.name        = name
    item.description = description or None
    item.image_path  = image_path
    item.category    = category or None
    item.icon        = icon or None
    item.sort_order  = sort_order
    item.is_active   = is_active
    item.is_facility = is_facility

    if not item_id:
        db.session.add(item)
    db.session.commit()
    return jsonify(success=True, message='Equipment saved.', item=_equipment_to_dict(item))


@app.route('/api/content/equipment/<int:item_id>/delete', methods=['POST'])
def api_delete_equipment(item_id):
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    item = GymEquipment.query.get(item_id)
    if not item:
        return jsonify(success=False, error='Equipment not found.'), 404
    _delete_content_image(item.image_path)
    db.session.delete(item)
    db.session.commit()
    return jsonify(success=True, message='Equipment deleted.')


# ── Content-management API: Announcements ────────────────────────────────
def _announcement_to_dict(a):
    return {
        'id':         a.id,
        'title':      a.title,
        'body':       a.body,
        'target':     a.target,
        'is_active':  a.is_active,
        'posted_by':  a.posted_by.full_name if a.posted_by else 'Admin',
        'created_at': _to_manila(a.created_at).strftime('%b %d, %Y') if a.created_at else '',
    }


@app.route('/api/announcements', methods=['GET'])
def api_list_announcements():
    if not _content_role_ok():
        return jsonify(success=False, error='Unauthorized.'), 403
    items = Announcement.query.order_by(Announcement.created_at.desc()).all()
    return jsonify(success=True, items=[_announcement_to_dict(a) for a in items])


@app.route('/api/announcements/save', methods=['POST'])
def api_save_announcement():
    if session.get('role') != 'admin':
        return jsonify(success=False, error='Unauthorized.'), 403

    title  = (request.form.get('title') or '').strip()
    body   = (request.form.get('body') or '').strip()
    target = (request.form.get('target') or 'all').strip()
    if target not in ('all', 'active', 'expiring', 'staff'):
        target = 'all'

    if not title:
        return jsonify(success=False, error='Title is required.'), 400
    if not body:
        return jsonify(success=False, error='Message is required.'), 400

    item = Announcement(
        title=title,
        body=body,
        target=target,
        posted_by_id=session.get('user_id'),
        is_active=True,
    )
    db.session.add(item)
    db.session.commit()
    return jsonify(success=True, message='Announcement published.', item=_announcement_to_dict(item))


@app.route('/api/announcements/<int:item_id>/edit', methods=['POST'])
def api_edit_announcement(item_id):
    if session.get('role') != 'admin':
        return jsonify(success=False, error='Unauthorized.'), 403
    item = Announcement.query.get(item_id)
    if not item:
        return jsonify(success=False, error='Announcement not found.'), 404

    title  = (request.form.get('title') or '').strip()
    body   = (request.form.get('body') or '').strip()
    target = (request.form.get('target') or 'all').strip()
    if target not in ('all', 'active', 'expiring', 'staff'):
        target = 'all'

    if not title:
        return jsonify(success=False, error='Title is required.'), 400
    if not body:
        return jsonify(success=False, error='Message is required.'), 400

    item.title  = title
    item.body   = body
    item.target = target
    db.session.commit()
    return jsonify(success=True, message='Announcement updated.', item=_announcement_to_dict(item))


@app.route('/api/announcements/<int:item_id>/toggle', methods=['POST'])
def api_toggle_announcement(item_id):
    if session.get('role') != 'admin':
        return jsonify(success=False, error='Unauthorized.'), 403
    item = Announcement.query.get(item_id)
    if not item:
        return jsonify(success=False, error='Announcement not found.'), 404
    item.is_active = not item.is_active
    db.session.commit()
    return jsonify(success=True, message='Announcement updated.', item=_announcement_to_dict(item))


@app.route('/api/announcements/<int:item_id>/delete', methods=['POST'])
def api_delete_announcement(item_id):
    if session.get('role') != 'admin':
        return jsonify(success=False, error='Unauthorized.'), 403
    item = Announcement.query.get(item_id)
    if not item:
        return jsonify(success=False, error='Announcement not found.'), 404
    db.session.delete(item)
    db.session.commit()
    return jsonify(success=True, message='Announcement deleted.')


# ── Routes ────────────────────────────────────────────────────
def _home_context(open_screen=None):
    """Shared context for the landing page. open_screen ('login' or
    'register') tells home.html which auth overlay, if any, to pop open
    automatically on load — used after a redirect from /login, /register
    links, or a failed sign-in so the visitor lands back on the same
    page instead of a separate screen."""
    plans     = MembershipPlan.query.filter_by(is_active=True).order_by(MembershipPlan.sort_order, MembershipPlan.id).all()
    services  = GymService.query.filter_by(is_active=True).order_by(GymService.sort_order, GymService.id).all()
    # Public landing page only shows facility-zone photos (Weight Area,
    # Cardio Area, etc.) — real machines/equipment are member-only and
    # live on the member dashboard's "Gym Machines and Equipment" list.
    equipment = (GymEquipment.query
                 .filter_by(is_active=True, is_facility=True)
                 .order_by(GymEquipment.sort_order, GymEquipment.id).all())
    return dict(plans=plans, services=services, equipment=equipment,
                gcash_settings=_get_gym_settings(), open_screen=open_screen)


@app.route('/')
@app.route('/home')
def home():
    open_screen = request.args.get('screen') if request.args.get('screen') in ('login', 'register') else None
    return render_template('home.html', **_home_context(open_screen))


@app.route('/trmem')
@app.route('/trmem.html')
def trmem_redirect():
    # The sign-in / register experience now lives directly on the landing
    # page instead of a separate page — send old links there and let the
    # page auto-open the right overlay.
    screen = request.args.get('screen', 'login')
    return redirect(url_for('home', screen=screen))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        # The embedded login form on the landing page submits via fetch
        # (AJAX) so the visitor never leaves the page. We still accept a
        # classic form POST as a no-JS fallback, redirecting back to the
        # landing page with a flashed error instead of rendering a
        # standalone page.
        payload  = request.get_json(silent=True)
        is_ajax  = payload is not None
        data     = payload if is_ajax else request.form
        email    = (data.get('email') or '').strip()
        password = data.get('password') or ''

        def _fail(msg):
            if is_ajax:
                return jsonify(success=False, error=msg), 400
            flash(msg, 'error')
            return redirect(url_for('home', screen='login'))

        if not email or not password:
            return _fail('Please enter both email and password.')

        user = User.query.filter_by(email=email).first()
        if user is None or not check_password_hash(user.password, password):
            return _fail('Invalid credentials.')

        session['user_id'] = user.id
        session['role']    = user.role
        session['email']   = user.email
        session['name']    = user.full_name

        if is_ajax:
            return jsonify(success=True, redirect=url_for(user.role))
        return redirect(url_for(user.role))

    # GET /login — send visitors to the landing page with the login
    # overlay open, instead of a dedicated login page.
    screen = request.args.get('screen', 'login')
    return redirect(url_for('home', screen=screen))


# ── Forgot / Reset Password (OTP-based) ──────────────────────
OTP_LENGTH           = 6
OTP_VALID_MINUTES    = 10
OTP_MAX_ATTEMPTS     = 3
OTP_LOCKOUT_MINUTES  = 30


def _generate_otp():
    return ''.join(secrets.choice(string.digits) for _ in range(OTP_LENGTH))


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _otp_email_html(first_name, otp):
    """Styled HTML version of the password-reset OTP email (POWER GYM branded)."""
    digits_html = ''.join(
        f'<td style="padding:0 6px;"><div style="width:44px;height:52px;background:#f2f3f6;'
        f'border:1px solid #dcdfe6;border-radius:8px;color:#141820;font-family:Arial,Helvetica,sans-serif;'
        f'font-size:26px;font-weight:700;line-height:52px;text-align:center;">{d}</div></td>'
        for d in otp
    )
    return f"""\
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#c6c9d1;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#c6c9d1;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="420" cellpadding="0" cellspacing="0"
               style="max-width:420px;width:100%;background:#ffffff;border:1px solid #e2e4ea;
                      border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;
                      box-shadow:0 4px 18px rgba(0,0,0,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,#e61e25,#b8141c);padding:22px 24px;text-align:center;">
              <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:1px;">POWER GYM</div>
              <div style="color:rgba(255,255,255,0.85);font-size:11px;letter-spacing:2px;margin-top:2px;">ACCOUNT RECOVERY</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px 8px 28px;text-align:center;">
              <div style="width:64px;height:64px;margin:0 auto 18px auto;background:rgba(255,171,64,0.14);
                          border-radius:50%;line-height:64px;font-size:28px;">✉️</div>
              <div style="color:#141820;font-size:18px;font-weight:700;margin-bottom:6px;">Your Verification Code</div>
              <div style="color:#6b7280;font-size:13px;line-height:1.6;margin-bottom:24px;">
                Hi {first_name}, use the code below to reset your<br>POWER GYM account password.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px;text-align:center;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>{digits_html}</tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 28px 6px 28px;text-align:center;">
              <div style="color:#6b7280;font-size:12px;">
                This code expires in <strong style="color:#141820;">{OTP_VALID_MINUTES} minutes</strong>
                and can be entered up to <strong style="color:#141820;">{OTP_MAX_ATTEMPTS} times</strong>.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px 28px;text-align:center;">
              <div style="height:1px;background:#e2e4ea;margin-bottom:16px;"></div>
              <div style="color:#9aa0b0;font-size:11px;line-height:1.6;">
                If you didn't request this code, you can safely ignore this email —
                your password will not be changed.
              </div>
            </td>
          </tr>
        </table>
        <div style="color:#9aa0b0;font-size:11px;margin-top:18px;font-family:Arial,Helvetica,sans-serif;">
          © Power Gym. This is an automated message, please do not reply.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>
"""


def _membership_activated_email_html(first_name, plan_name, start_date):
    """Styled HTML congratulations email sent once a payment is approved and
    the membership is actually activated (POWER GYM branded, mirrors the
    OTP email's look)."""
    start_label = start_date.strftime('%B %d, %Y')
    plan_line = f' on the <strong style="color:#141820;">{plan_name}</strong> plan' if plan_name else ''
    return f"""\
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#c6c9d1;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#c6c9d1;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="420" cellpadding="0" cellspacing="0"
               style="max-width:420px;width:100%;background:#ffffff;border:1px solid #e2e4ea;
                      border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;
                      box-shadow:0 4px 18px rgba(0,0,0,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,#e61e25,#b8141c);padding:22px 24px;text-align:center;">
              <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:1px;">POWER GYM</div>
              <div style="color:rgba(255,255,255,0.85);font-size:11px;letter-spacing:2px;margin-top:2px;">MEMBERSHIP ACTIVATED</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px 8px 28px;text-align:center;">
              <div style="width:64px;height:64px;margin:0 auto 18px auto;background:rgba(27,175,122,0.14);
                          border-radius:50%;line-height:64px;font-size:28px;">🎉</div>
              <div style="color:#141820;font-size:19px;font-weight:800;margin-bottom:10px;">Congratulations, {first_name}!</div>
              <div style="color:#3a3f4b;font-size:14px;line-height:1.7;margin-bottom:6px;">
                Your payment has been verified and you are now officially
                one of the members of <strong style="color:#141820;">Power Gym</strong>{plan_line}.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:10px 28px 4px 28px;text-align:center;">
              <div style="background:#f2f3f6;border:1px solid #dcdfe6;border-radius:10px;padding:16px 18px;">
                <div style="color:#6b7280;font-size:11px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">You can start training on</div>
                <div style="color:#141820;font-size:20px;font-weight:800;">{start_label}</div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 28px 6px 28px;text-align:center;">
              <div style="color:#6b7280;font-size:12px;line-height:1.6;">
                Sign in to your member dashboard anytime to check your plan status,
                attendance, and renewal date.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px 28px;text-align:center;">
              <div style="height:1px;background:#e2e4ea;margin-bottom:16px;"></div>
              <div style="color:#9aa0b0;font-size:11px;line-height:1.6;">
                Questions about your membership? Just ask our front desk staff.
              </div>
            </td>
          </tr>
        </table>
        <div style="color:#9aa0b0;font-size:11px;margin-top:18px;font-family:Arial,Helvetica,sans-serif;">
          © Power Gym. This is an automated message, please do not reply.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>
"""


def _send_membership_activated_email(member, plan, start_date):
    """Best-effort congratulations email once a membership is activated by
    an approved payment. Mirrors the OTP email's dev-mode fallback: if SMTP
    isn't configured, or sending fails, we log it and move on rather than
    blocking the approval itself — the membership is already active either way."""
    if not member or not member.email:
        return
    plan_name = plan.name if plan else ''
    if app.config.get('MAIL_USERNAME') and app.config.get('MAIL_PASSWORD'):
        try:
            msg = Message(
                subject='POWER GYM — Welcome! Your Membership Is Active',
                recipients=[member.email],
                body=(
                    f"Hi {member.first_name},\n\n"
                    f"Congratulations — you are now officially one of the members of Power Gym"
                    f"{f' on the {plan_name} plan' if plan_name else ''}!\n\n"
                    f"You can start your membership on {start_date.strftime('%B %d, %Y')}.\n\n"
                    f"Sign in to your member dashboard anytime to check your plan status, "
                    f"attendance, and renewal date."
                ),
                html=_membership_activated_email_html(member.first_name, plan_name, start_date),
            )
            mail.send(msg)
        except Exception as e:
            print(f"[MAIL ERROR] Could not send membership-activated email to {member.email}: {e}")
    else:
        print(f"[DEV] Email not configured. Membership-activated email would be sent to "
              f"{member.email} — plan={plan_name}, start={start_date}")


@app.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    if request.method == 'POST':
        email = (request.form.get('email') or '').strip().lower()
        user  = User.query.filter_by(email=email).first() if email else None
        now   = _now()

        if user:
            # Still locked out from too many failed OTP attempts — don't send a new code yet.
            if user.reset_otp_locked_until and user.reset_otp_locked_until > now:
                remaining = int((user.reset_otp_locked_until - now).total_seconds() // 60) + 1
                flash(f'Too many incorrect attempts. Please wait {remaining} more minute(s) before requesting a new code.', 'error')
                return render_template('forgot-password.html')

            otp = _generate_otp()
            user.reset_otp              = generate_password_hash(otp)
            user.reset_otp_expires      = now + timedelta(minutes=OTP_VALID_MINUTES)
            user.reset_otp_attempts     = 0
            user.reset_otp_locked_until = None
            db.session.commit()

            session['otp_email'] = email

            if app.config.get('MAIL_USERNAME') and app.config.get('MAIL_PASSWORD'):
                try:
                    msg = Message(
                        subject='POWER GYM — Your Password Reset Code',
                        recipients=[email],
                        body=(
                            f"Hi {user.first_name},\n\n"
                            f"Your POWER GYM password reset code is: {otp}\n\n"
                            f"This code expires in {OTP_VALID_MINUTES} minutes and can be entered up to "
                            f"{OTP_MAX_ATTEMPTS} times before you'll need to request a new one.\n\n"
                            f"If you didn't request this, you can safely ignore this email."
                        ),
                        html=_otp_email_html(user.first_name, otp),
                    )
                    mail.send(msg)
                    flash('A verification code has been sent to your email.', 'success')
                except Exception as e:
                    print(f"[MAIL ERROR] Could not send OTP email to {email}: {e}")
                    flash('Could not send the verification code right now. Please try again shortly.', 'error')
                    return render_template('forgot-password.html')
            else:
                # No MAIL_USERNAME/MAIL_PASSWORD configured — dev fallback so the
                # flow stays testable without SMTP credentials set up yet.
                print(f"[DEV] Email not configured. OTP for {email}: {otp}")
                flash(f'Email is not configured yet — here is your code (dev mode): {otp}', 'success')

            return redirect(url_for('verify_otp'))
        else:
            # Same message whether or not the email exists, so we don't leak
            # which addresses are registered.
            flash('If an account with that email exists, a verification code has been sent.', 'success')

        return render_template('forgot-password.html')

    return render_template('forgot-password.html')


@app.route('/verify-otp', methods=['GET', 'POST'])
def verify_otp():
    email = session.get('otp_email')
    if not email:
        flash('Please request a verification code first.', 'error')
        return redirect(url_for('forgot_password'))

    user = User.query.filter_by(email=email).first()
    now  = _now()

    if not user:
        session.pop('otp_email', None)
        return redirect(url_for('forgot_password'))

    if user.reset_otp_locked_until and user.reset_otp_locked_until > now:
        remaining = int((user.reset_otp_locked_until - now).total_seconds() // 60) + 1
        flash(f'Too many incorrect attempts. Please wait {remaining} more minute(s) and request a new code.', 'error')
        session.pop('otp_email', None)
        return redirect(url_for('forgot_password'))

    if request.method == 'POST':
        code = (request.form.get('otp') or '').strip()

        if not user.reset_otp or not user.reset_otp_expires or user.reset_otp_expires <= now:
            flash('Your verification code has expired. Please request a new one.', 'error')
            session.pop('otp_email', None)
            return redirect(url_for('forgot_password'))

        if check_password_hash(user.reset_otp, code):
            # Correct code — issue a short-lived token for the actual password-change screen.
            token = secrets.token_urlsafe(32)
            user.reset_token            = token
            user.reset_token_expires    = now + timedelta(minutes=15)
            user.reset_otp              = None
            user.reset_otp_expires      = None
            user.reset_otp_attempts     = 0
            user.reset_otp_locked_until = None
            db.session.commit()
            session.pop('otp_email', None)
            return redirect(url_for('reset_password', token=token))

        # Wrong code — count the attempt, lock out after 3 in a row.
        user.reset_otp_attempts = (user.reset_otp_attempts or 0) + 1
        if user.reset_otp_attempts >= OTP_MAX_ATTEMPTS:
            user.reset_otp_locked_until = now + timedelta(minutes=OTP_LOCKOUT_MINUTES)
            user.reset_otp             = None
            user.reset_otp_expires     = None
            db.session.commit()
            session.pop('otp_email', None)
            flash(f'Too many incorrect attempts. Please wait {OTP_LOCKOUT_MINUTES} minutes before requesting a new code.', 'error')
            return redirect(url_for('forgot_password'))

        db.session.commit()
        remaining_attempts = OTP_MAX_ATTEMPTS - user.reset_otp_attempts
        flash(f'Incorrect code. {remaining_attempts} attempt(s) remaining.', 'error')
        return render_template('verify-otp.html', email=email)

    return render_template('verify-otp.html', email=email)


@app.route('/reset-password/<token>', methods=['GET', 'POST'])
def reset_password(token):
    now = _now()
    user = User.query.filter_by(reset_token=token).first()
    token_valid = user is not None and user.reset_token_expires is not None and user.reset_token_expires > now

    if not token_valid:
        flash('This reset link is invalid or has expired. Please request a new code.', 'error')
        return redirect(url_for('forgot_password'))

    if request.method == 'POST':
        password = request.form.get('password') or ''
        confirm  = request.form.get('confirm')  or ''

        if len(password) < 8:
            flash('Password must be at least 8 characters.', 'error')
            return render_template('reset-password.html', token=token)

        if password != confirm:
            flash('Passwords do not match.', 'error')
            return render_template('reset-password.html', token=token)

        user.password             = generate_password_hash(password)
        user.reset_token          = None
        user.reset_token_expires  = None
        db.session.commit()

        flash('Password reset successfully. Please sign in with your new password.', 'success')
        return redirect(url_for('login'))

    return render_template('reset-password.html', token=token)


@app.route('/register', methods=['POST'])
def register():
    # Switched from JSON to multipart/form-data since registration now
    # requires an uploaded profile picture file alongside the text fields.
    data = request.form

    first_name = (data.get('first_name') or '').strip()
    middle_initial = (data.get('middle_initial') or '').strip()
    last_name  = (data.get('last_name')  or '').strip()
    extension_name = (data.get('extension_name') or '').strip()
    email      = (data.get('email')      or '').strip().lower()
    phone      = (data.get('phone')      or '').strip()
    birthday   = (data.get('birthday')   or '').strip()
    password   = data.get('password')    or ''
    profile_picture_file = request.files.get('profile_picture')

    # ── Validation ──
    if not first_name or not last_name or not email or not password:
        return jsonify(success=False, error='Please fill in all required fields.'), 400

    if not profile_picture_file or not profile_picture_file.filename:
        return jsonify(success=False, error='A profile picture is required to create an account.'), 400

    if not _valid_name(first_name, require_capital=True, lowercase_rest=True) or not _valid_name(last_name, require_capital=True, lowercase_rest=True):
        return jsonify(success=False, error='First and last name must start with a capital letter, with the rest in lowercase.'), 400

    if not _valid_name(middle_initial, extra_chars='', require_capital=True):
        return jsonify(success=False, error='Middle initial can only contain letters and must start with a capital letter.'), 400

    if not _valid_name(extension_name, extra_chars=' .'):
        return jsonify(success=False, error='Extension name can only contain letters.'), 400

    if len(password) < 8:
        return jsonify(success=False, error='Password must be at least 8 characters.'), 400

    if not _valid_phone(phone):
        return jsonify(success=False, error='Phone number must start with 09 and be exactly 11 digits.'), 400

    # ── Age gate: members must be 14 or older to join the gym. Birthday is
    # required (not optional) specifically so this can be enforced — never
    # trust a client-side date-input min/max alone. ──
    if not birthday:
        return jsonify(success=False, error='Please enter your birthday.'), 400
    try:
        birthday_date = datetime.strptime(birthday, '%Y-%m-%d').date()
    except ValueError:
        return jsonify(success=False, error='Please enter a valid birthday.'), 400
    if birthday_date > date.today():
        return jsonify(success=False, error='Birthday cannot be in the future.'), 400
    if _calculate_age(birthday_date) < 14:
        return jsonify(success=False, error='You must be at least 14 years old to join Power Gym.'), 400

    if User.query.filter_by(email=email).first() is not None:
        return jsonify(success=False, error='An account with this email already exists.'), 409

    try:
        profile_picture_path = _save_profile_picture(profile_picture_file)
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400

    # ── Create the user ──
    new_user = User(
        first_name=first_name,
        middle_initial=middle_initial or None,
        last_name=last_name,
        extension_name=extension_name or None,
        email=email,
        phone=phone or None,
        birthday=birthday_date,
        password=generate_password_hash(password),
        role='member',
        status='pending',
        profile_picture=profile_picture_path,
        # Starts the change-cooldown from day one (see PROFILE_PICTURE_COOLDOWN_DAYS).
        profile_picture_updated_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.session.add(new_user)
    db.session.commit()

    return jsonify(success=True, message='Account created! Sign in and pick a plan from your dashboard.')


def _generate_temp_password(length=10):
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def _valid_phone(phone):
    """Phone number must be exactly 11 digits and start with '09' (PH mobile format)."""
    return phone.isdigit() and len(phone) == 11 and phone.startswith('09')


def _valid_name(name, extra_chars=" '-", require_capital=False, lowercase_rest=False):
    """Name fields must contain only letters (plus a few allowed punctuation chars) — no digits.
    When require_capital is True, the first character must also be an uppercase letter.
    When lowercase_rest is True, each space-separated word must be in Title Case
    (first letter capitalized, remaining letters in that word lowercase) — e.g. 'Dela Cruz'."""
    if not name:
        return True
    if not all(ch.isalpha() or ch in extra_chars for ch in name):
        return False
    if require_capital and not name[0].isupper():
        return False
    if lowercase_rest:
        for word in name.split():
            if not word[0].isupper():
                return False
            if any(ch.isalpha() and ch.isupper() for ch in word[1:]):
                return False
    return True


# ── Fitness Goal & Recommendation feature — Step 1/2 validation ──
# Reasonable human ranges. Purposefully generous rather than tight (e.g. a
# 240cm outlier shouldn't hard-block a real member), but tight enough to
# catch fat-fingered entries (e.g. "17" meant as "170", or weight typed in
# lbs by mistake) before they reach the deterministic calculations that a
# later step will build on top of these numbers.
FITNESS_HEIGHT_CM_MIN, FITNESS_HEIGHT_CM_MAX = 100.0, 250.0
FITNESS_WEIGHT_KG_MIN, FITNESS_WEIGHT_KG_MAX = 20.0, 300.0
FITNESS_VALID_SEXES           = {'male', 'female'}
FITNESS_VALID_ACTIVITY_LEVELS = {'low_activity', 'moderate_activity', 'high_activity'}
FITNESS_VALID_GOALS           = {'CUT', 'BULK', 'MAINTAIN', 'RECOMP'}


def _valid_fitness_height(height_cm):
    return FITNESS_HEIGHT_CM_MIN <= height_cm <= FITNESS_HEIGHT_CM_MAX


def _valid_fitness_weight(weight_kg):
    return FITNESS_WEIGHT_KG_MIN <= weight_kg <= FITNESS_WEIGHT_KG_MAX


def _calculate_age(birthday):
    """Derive current age from the member's existing User.birthday — no
    separate age column is stored anywhere for the Fitness Goal feature;
    age is always computed on demand, here, from data that already exists."""
    if birthday is None:
        return None
    today = date.today()
    return today.year - birthday.year - ((today.month, today.day) < (birthday.month, birthday.day))


# Exposed to templates as `{{ some_date|age }}` — used by the read-only
# Profile page on each dashboard (admin/staff/member) to show current age
# derived from the stored birthday, without adding a separate DB column.
app.jinja_env.filters['age'] = _calculate_age


# ── Stage 3 — deterministic fitness calculations ──
# Pure arithmetic, no AI. These constants and this function are the ONLY
# place BMI/BMR/TDEE/calorie/protein targets are computed for this feature.
FITNESS_ACTIVITY_MULTIPLIERS = {
    'low_activity':      1.30,  # combines former Sedentary (1.20) + Lightly Active (1.375)
    'moderate_activity': 1.55,  # former Moderately Active, unchanged
    'high_activity':     1.80,  # combines former Very Active (1.725) + Extra Active (1.90)
}
FITNESS_GOAL_CALORIE_OFFSETS = {
    'CUT':      -500,
    'BULK':      300,
    'MAINTAIN':    0,
    'RECOMP':   -200,
}
FITNESS_MIN_CALORIES = {'male': 1500, 'female': 1200}
FITNESS_PROTEIN_G_PER_KG = 1.6


def _calculate_fitness_targets(height_cm, weight_kg, sex, age, activity_level, goal):
    """BMI, BMR (Mifflin-St Jeor), TDEE, goal-based calorie target (with a
    safety-floor minimum), and protein target — general fitness estimates
    for this capstone system, not medical prescriptions. Returns a dict of
    plain floats/ints, rounded as specified, ready to store and to return
    as JSON."""
    height_m = height_cm / 100.0
    bmi = weight_kg / (height_m * height_m)

    if sex == 'male':
        bmr = (10 * weight_kg) + (6.25 * height_cm) - (5 * age) + 5
    else:
        bmr = (10 * weight_kg) + (6.25 * height_cm) - (5 * age) - 161

    multiplier = FITNESS_ACTIVITY_MULTIPLIERS.get(activity_level, 1.20)
    tdee = bmr * multiplier

    offset = FITNESS_GOAL_CALORIE_OFFSETS.get(goal, 0)
    calorie_target = tdee + offset
    min_calories = FITNESS_MIN_CALORIES.get(sex, 1200)
    if calorie_target < min_calories:
        calorie_target = min_calories

    protein_target_g = weight_kg * FITNESS_PROTEIN_G_PER_KG

    return {
        'bmi':              round(bmi, 1),
        'bmr':              round(bmr),
        'tdee':             round(tdee),
        'calorie_target':   round(calorie_target),
        'protein_target_g': round(protein_target_g),
    }


# ── Stage 4 — Personalized Fitness Recommendations (deterministic, no AI) ──
# Everything below reads ONLY values already computed by Stage 3
# (FitnessProfile.fitness_goal/activity_level, BodyGoal.calorie_target/
# protein_target_g) plus the curated FoodItem/Exercise catalogs. Nothing
# here recalculates BMI/BMR/TDEE/targets — those formulas above are the
# only place that happens. Every function takes plain values in and returns
# plain dicts/lists out, so this layer could later be swapped for an
# AI/agent call without changing any caller.

FITNESS_MEAL_SPLIT = {
    'breakfast': 0.25,
    'lunch':     0.35,
    'snack':     0.10,
    'dinner':    0.30,
}

FITNESS_ACTIVITY_FREQUENCY_NOTES = {
    'low_activity':      'Aim for 2–3 sessions per week to start building consistency.',
    'moderate_activity': 'Aim for 3–4 sessions per week.',
    'high_activity':     'Aim for 5–6 sessions per week, with adequate rest between muscle groups.',
}

FITNESS_GOAL_TIPS = {
    'CUT': [
        'Stay in a moderate calorie deficit and keep protein high to help preserve muscle while losing fat.',
        'Combine resistance training with sustainable cardio, like brisk walking, rather than extreme cardio volume.',
        'Prioritize sleep and hydration — both make it easier to stick with a deficit.',
    ],
    'BULK': [
        'Aim to hit your calorie surplus consistently, especially around workout days.',
        'Prioritize protein at every meal and focus on progressive overload in your resistance training.',
        'Recovery and sleep matter as much as time spent training — don\u2019t neglect rest days.',
    ],
    'MAINTAIN': [
        'Keep your intake close to your calculated maintenance level and stay consistent week to week.',
        'A balanced mix of strength and light cardio helps sustain your current fitness level.',
        'Small, sustainable habits are more effective long-term than drastic changes.',
    ],
    'RECOMP': [
        'Prioritize protein intake and resistance training to support muscle growth while in a modest deficit.',
        'Progress may be slower than a dedicated CUT or BULK — track trends over weeks, not days.',
        'Consistency with both training and nutrition matters more than perfection on any single day.',
    ],
}


def _member_plan_active(user):
    """Whether this member currently has an ACTIVE membership. Mirrors the
    exact same plan-status logic already computed inline in the /member
    route (Expired if past expiry_date, Pending if status == 'pending',
    otherwise Active) — reused here, not reimplemented, so there is exactly
    one definition of "active membership" anywhere in the app. No second
    subscription-expiration system."""
    membership = Membership.query.filter_by(member_id=user.id).first()
    if membership is None or membership.status == 'declined':
        return False
    if membership.expiry_date is None or membership.expiry_date < _today_manila():
        return False
    if membership.status == 'pending':
        return False
    return True


def _reset_expired_fitness_plan(user):
    """Called whenever a member with an inactive membership touches their
    Body Goals data. Deletes the member's FitnessProfile row (its height/
    sex/activity_level columns are non-nullable, so there's no valid
    "empty" state for that row short of removing it — this is a data
    reset, not a schema change) and nulls the active-setup fields on the
    member's EXISTING BodyGoal row (current_weight, current_bmi, bmr, tdee,
    calorie_target, protein_target_g) — that row is reused, never deleted
    or duplicated, and fields outside this feature's scope (notes,
    goal_weight, current_body_fat, current_muscle, etc.) are left
    untouched. Idempotent — a no-op if there's nothing to reset. Returns
    True if anything was actually changed."""
    changed = False

    profile = FitnessProfile.query.filter_by(member_id=user.id).first()
    if profile is not None:
        db.session.delete(profile)
        changed = True

    body_goal = (
        BodyGoal.query
        .filter_by(member_id=user.id)
        .order_by(BodyGoal.recorded_at.desc(), BodyGoal.id.desc())
        .first()
    )
    if body_goal is not None and (
        body_goal.current_weight is not None or body_goal.current_bmi is not None or
        body_goal.bmr is not None or body_goal.tdee is not None or
        body_goal.calorie_target is not None or body_goal.protein_target_g is not None
    ):
        body_goal.current_weight   = None
        body_goal.current_bmi      = None
        body_goal.bmr              = None
        body_goal.tdee             = None
        body_goal.calorie_target   = None
        body_goal.protein_target_g = None
        changed = True

    if changed:
        db.session.commit()
    return changed


def _food_fits_meal(item, meal):
    """suitable_meal is either 'any' or a comma-separated subset of
    breakfast/lunch/dinner/snack."""
    return item.suitable_meal == 'any' or meal in item.suitable_meal.split(',')


def _recommend_meal_plan(calorie_target, protein_target_g):
    """Splits the (already-calculated, Stage 3) calorie/protein targets
    across Breakfast/Lunch/Snack/Dinner using a fixed percentage template,
    then, per meal, repeatedly adds the best-fit NOT-YET-CHOSEN FoodItem
    (considering every category each pass, not just one item per category)
    until that meal's running total reaches ~85% of its share of the daily
    target, no distinct candidates remain for that meal, or a practical
    per-meal item cap is hit. This scales the number of recommended items
    with the size of the member's target, instead of capping every meal at
    a fixed, small serving regardless of how high the target is. Still
    picks only from the existing FoodItem catalog, one serving per item,
    never repeating the same item within a meal, and never recalculates
    calorie_target/protein_target_g."""
    category_order = ['protein', 'carb', 'vegetable', 'fruit', 'healthy_fat', 'other']
    all_foods = FoodItem.query.filter_by(is_active=True).all()
    max_items_per_meal = 6

    meals = {}
    total_calories = 0
    total_protein_g = 0

    for meal_name, share in FITNESS_MEAL_SPLIT.items():
        meal_calorie_target = calorie_target * share
        candidates = [f for f in all_foods if _food_fits_meal(f, meal_name)]

        chosen = []
        running_cal = 0
        running_protein = 0

        while running_cal < meal_calorie_target * 0.85 and len(chosen) < max_items_per_meal:
            # Each pass considers every category again and picks whichever
            # not-yet-chosen item (from any category) lands closest to the
            # meal's remaining calorie budget — deterministic, same
            # nearest-fit rule as before, just no longer capped at one
            # item per category.
            best_item = None
            best_diff = None
            for cat in category_order:
                cat_items = [f for f in candidates if f.category == cat and f not in chosen]
                if not cat_items:
                    continue
                item = min(cat_items, key=lambda f: abs((running_cal + f.calories_per_serving) - meal_calorie_target))
                diff = abs((running_cal + item.calories_per_serving) - meal_calorie_target)
                if best_diff is None or diff < best_diff:
                    best_diff = diff
                    best_item = item
            if best_item is None:
                break  # no more distinct candidates left for this meal
            chosen.append(best_item)
            running_cal += best_item.calories_per_serving
            running_protein += best_item.protein_g_per_serving

        meals[meal_name] = {
            'items': [
                {
                    'name':        f.name,
                    'serving':     f.serving_description,
                    'calories':    f.calories_per_serving,
                    'protein_g':   f.protein_g_per_serving,
                }
                for f in chosen
            ],
            'meal_calories':   running_cal,
            'meal_protein_g':  running_protein,
        }
        total_calories += running_cal
        total_protein_g += running_protein

    return {
        'meals':             meals,
        'total_calories':    total_calories,
        'total_protein_g':   total_protein_g,
    }


def _goal_tagged_exercises(goal):
    """All active Exercise rows tagged for this goal, in stable catalog
    order (by id). Single source of truth for "which exercises match a
    goal" — used by both the flat top-N Workouts list and the weekly
    routine generator below, so there is exactly one filtering rule."""
    return [
        e for e in Exercise.query.filter_by(is_active=True).order_by(Exercise.id).all()
        if goal in (e.goal_tags or '').split(',')
    ]


def _select_exercises_for_goal(goal):
    """Filters the Exercise catalog to whichever rows are tagged for this
    goal, preserving a stable, curated order (by id) and capped at a
    reasonable count so the flat list stays practical, not exhaustive."""
    return _goal_tagged_exercises(goal)[:8]


# ── Weekly workout SCHEDULE is now fixed for every member, regardless of
# activity level — a consistent 6-training-day / 1-rest-day week, with Day
# 4 always the rest day and the same Chest&Legs/Back&Arms/Shoulders&Core
# rotation repeating twice. Activity Level no longer affects which days
# train vs rest — see FITNESS_ACTIVITY_SET_TIER below for what it DOES
# still control (set count only).
FITNESS_WEEKLY_SCHEDULE = [
    ('train', 'Chest & Legs',      ['Chest', 'Legs']),
    ('train', 'Back & Arms',       ['Back', 'Arms']),
    ('train', 'Shoulders & Core',  ['Shoulders', 'Core']),
    ('rest',  'Rest / Recovery',   None),
    ('train', 'Chest & Legs',      ['Chest', 'Legs']),
    ('train', 'Back & Arms',       ['Back', 'Arms']),
    ('train', 'Shoulders & Core',  ['Shoulders', 'Core']),
]

# Activity Level now ONLY affects workout INTENSITY (how many sets per
# exercise) — never the schedule above. Reps are never touched here or
# anywhere else; Exercise.default_reps is always used exactly as stored.
FITNESS_ACTIVITY_SET_TIER = {
    'low_activity':      2,  # Tier 1 — Beginner / Light
    'moderate_activity': 3,  # Tier 2 — Moderate
    'high_activity':     4,  # Tier 3 — Higher Activity
}

FITNESS_MIN_EXERCISES_PER_DAY = 3
FITNESS_MAX_EXERCISES_PER_DAY = 5

FITNESS_REST_DAY_NOTE = 'Allow your muscles to recover and avoid unnecessary training on this day.'


def _pick_day_exercises(goal_exercises, primary_areas,
                         min_count=FITNESS_MIN_EXERCISES_PER_DAY,
                         max_count=FITNESS_MAX_EXERCISES_PER_DAY):
    """Selects exercises for one training day, sourced ONLY from the day's
    own primary_areas (e.g. Shoulders & Core -> Shoulders or Core only) —
    never from another Main Area. This is intentional: a training day must
    only ever contain exercises from the Main Areas explicitly assigned to
    it, so an exercise from an unrelated area (e.g. Arms exercises like
    Bicep Curls/Tricep Pushdowns showing up on a Shoulders & Core day) can
    never be selected, regardless of goal or how few matching exercises
    exist for that goal/area combination.

    min_count is intentionally NOT backfilled from any other area. If the
    goal-filtered catalog has fewer than min_count exercises within
    primary_areas, this simply returns whatever valid (in-area) exercises
    are available — a short but correctly-scoped day, rather than padding
    it with exercises from a different Main Area. Capped at max_count so a
    day stays compact, not exhaustive."""
    selected = [e for e in goal_exercises if e.target_area in primary_areas]
    return selected[:max_count]


def _recommend_weekly_routine(goal, activity_level):
    """Builds the 7-day training/rest schedule from the existing Exercise
    catalog only — no new table, no AI. The SCHEDULE itself (which days
    train, which day rests, and each day's muscle-group focus) is now
    fixed and identical for every activity level — see
    FITNESS_WEEKLY_SCHEDULE: Days 1/2/3/5/6/7 train (Chest & Legs / Back &
    Arms / Shoulders & Core, repeating), Day 4 always rests. Which
    exercises appear on a training day still comes from the goal (via
    _goal_tagged_exercises + _pick_day_exercises). _pick_day_exercises now
    selects strictly within each day's own primary focus areas — no
    cross-area fallback — so a day can be short of the usual count but will
    never contain an exercise from an unrelated Main Area. activity_level
    now ONLY controls the displayed set count per exercise (see
    FITNESS_ACTIVITY_SET_TIER) — it never changes the schedule and never
    changes reps (always Exercise.default_reps, verbatim). Returns
    (routine_dict_for_json, all_exercise_objs_actually_used) — the second
    value lets the caller compute equipment from exactly what's in the
    routine, not a separate/stale list."""
    sets_count = FITNESS_ACTIVITY_SET_TIER.get(activity_level, 3)
    goal_exercises = _goal_tagged_exercises(goal)

    days = []
    used_exercises = []

    for day_number, (day_type, focus_name, focus_areas) in enumerate(FITNESS_WEEKLY_SCHEDULE, start=1):
        if day_type == 'rest':
            days.append({
                'day_number': day_number,
                'type':       'rest',
                'focus':      focus_name,
                'note':       FITNESS_REST_DAY_NOTE,
                'exercises':  [],
            })
            continue

        day_exercises = _pick_day_exercises(goal_exercises, focus_areas)
        used_exercises.extend(day_exercises)

        days.append({
            'day_number': day_number,
            'type':       'train',
            'focus':      focus_name,
            'note':       None,
            'exercises': [
                {
                    'id':              e.id,
                    'name':            e.name,
                    'target_area':     e.target_area,
                    'sub_target':      e.sub_target,
                    'specific_target': e.specific_target,
                    'sets':            str(sets_count),
                    'reps':            e.default_reps,
                    'purpose':         e.purpose,
                    'equipment_name':  e.equipment_name,
                    'instructions':    e.instructions,
                }
                for e in day_exercises
            ],
        })

    training_days = sum(1 for day_type, _, _ in FITNESS_WEEKLY_SCHEDULE if day_type == 'train')
    rest_days = sum(1 for day_type, _, _ in FITNESS_WEEKLY_SCHEDULE if day_type == 'rest')

    return {
        'training_days': training_days,
        'rest_days':      rest_days,
        'days':           days,
    }, used_exercises


def _recommend_workouts(goal, activity_level):
    """Selects goal-appropriate exercises and formats them for display.
    activity_level only affects the suggested weekly frequency text — it
    does not change which exercises are selected."""
    exercises = _select_exercises_for_goal(goal)
    return {
        'frequency_note': FITNESS_ACTIVITY_FREQUENCY_NOTES.get(activity_level, ''),
        'exercises': [
            {
                'id':           e.id,
                'name':         e.name,
                'target_area':  e.target_area,
                'sub_target':   e.sub_target,
                'type':         e.exercise_type,
                'sets':         e.default_sets,
                'reps':         e.default_reps,
                'purpose':      e.purpose,
                'instructions': e.instructions,
            }
            for e in exercises
        ],
    }, exercises


def _recommend_equipment(exercises):
    """De-duplicated equipment list drawn directly from the exercises that
    were actually recommended — not a generic catalog dump. No
    relationship to the existing GymEquipment table."""
    seen = {}
    for e in exercises:
        if e.equipment_name and e.equipment_name not in seen:
            seen[e.equipment_name] = e.equipment_note or ''
    return [{'name': name, 'note': note} for name, note in seen.items()]


def _fitness_tips(goal):
    return FITNESS_GOAL_TIPS.get(goal, [])


@app.route('/admin/add-member', methods=['POST'])
def admin_add_member():
    if session.get('role') != 'admin':
        return jsonify(success=False, error='Unauthorized.'), 403

    data = request.get_json(silent=True) or request.form

    first_name = (data.get('first_name') or '').strip()
    middle_initial = (data.get('middle_initial') or '').strip()
    last_name  = (data.get('last_name')  or '').strip()
    extension_name = (data.get('extension_name') or '').strip()
    email      = (data.get('email')      or '').strip().lower()
    phone      = (data.get('phone')      or '').strip()
    plan_name  = (data.get('plan')       or '').strip()

    if not first_name or not last_name or not email:
        return jsonify(success=False, error='Please fill in first name, last name, and email.'), 400

    if not _valid_phone(phone):
        return jsonify(success=False, error='Phone number must start with 09 and be exactly 11 digits.'), 400

    if User.query.filter_by(email=email).first() is not None:
        return jsonify(success=False, error='A user with this email already exists.'), 409

    plan = MembershipPlan.query.filter_by(name=plan_name).first()
    if plan is None:
        return jsonify(success=False, error='Please select a valid membership plan.'), 400

    # Admin-added members are walk-ins who already paid at the desk,
    # so they're activated immediately (unlike self-registration, which is 'pending').
    temp_password = _generate_temp_password()
    new_user = User(
        first_name=first_name,
        middle_initial=middle_initial or None,
        last_name=last_name,
        extension_name=extension_name or None,
        email=email,
        phone=phone or None,
        password=generate_password_hash(temp_password),
        role='member',
        status='active',
    )
    db.session.add(new_user)
    db.session.flush()

    start = _today_manila()
    expiry = _plan_expiry(plan, start)
    new_membership = Membership(
        member_id=new_user.id,
        plan_id=plan.id,
        start_date=start,
        expiry_date=expiry,
        status='active',
    )
    db.session.add(new_membership)
    db.session.commit()

    return jsonify(
        success=True,
        message='Member added successfully.',
        member={
            'id': new_user.id,
            'name': new_user.full_name,
            'first_name': new_user.first_name,
            'middle_initial': new_user.middle_initial or '',
            'last_name': new_user.last_name,
            'extension_name': new_user.extension_name or '',
            'email': email,
            'phone': new_user.phone or '',
            'plan': plan.name,
            'expiry': expiry.strftime('%b %d, %Y'),
            'temp_password': temp_password,
        }
    )


@app.route('/admin/edit-member/<int:member_id>', methods=['POST'])
def admin_edit_member(member_id):
    if session.get('role') != 'admin':
        return jsonify(success=False, error='Unauthorized.'), 403

    user = User.query.filter_by(id=member_id, role='member').first()
    if user is None:
        return jsonify(success=False, error='Member not found.'), 404

    data = request.get_json(silent=True) or request.form

    first_name = (data.get('first_name') or '').strip()
    middle_initial = (data.get('middle_initial') or '').strip()
    last_name  = (data.get('last_name')  or '').strip()
    extension_name = (data.get('extension_name') or '').strip()
    email      = (data.get('email')      or '').strip().lower()
    phone      = (data.get('phone')      or '').strip()
    plan_name  = (data.get('plan')       or '').strip()
    expiry_str = (data.get('expiry')     or '').strip()

    if not first_name or not last_name or not email:
        return jsonify(success=False, error='First name, last name, and email are required.'), 400

    if not _valid_phone(phone):
        return jsonify(success=False, error='Phone number must start with 09 and be exactly 11 digits.'), 400

    # Check email isn't taken by someone else
    existing = User.query.filter(User.email == email, User.id != member_id).first()
    if existing is not None:
        return jsonify(success=False, error='Another account already uses this email.'), 409

    user.first_name = first_name
    user.middle_initial = middle_initial or None
    user.last_name  = last_name
    user.extension_name = extension_name or None
    user.email      = email
    user.phone      = phone or None

    membership = Membership.query.filter_by(member_id=user.id).first()

    plan = MembershipPlan.query.filter_by(name=plan_name).first() if plan_name else None
    expiry_date = None
    if expiry_str:
        try:
            expiry_date = datetime.strptime(expiry_str, '%Y-%m-%d').date()
        except ValueError:
            expiry_date = None

    if membership is None and (plan is not None or expiry_date is not None):
        membership = Membership(
            member_id=user.id,
            plan_id=plan.id if plan else None,
            start_date=_today_manila(),
            expiry_date=expiry_date or _today_manila(),
            status='active',
        )
        db.session.add(membership)
    elif membership is not None:
        if plan is not None:
            membership.plan_id = plan.id
        if expiry_date is not None:
            membership.expiry_date = expiry_date

    db.session.commit()

    plan_display   = membership.plan.name if (membership and membership.plan) else '—'
    expiry_display = membership.expiry_date.strftime('%b %d, %Y') if (membership and membership.expiry_date) else '—'
    expiry_iso     = membership.expiry_date.isoformat() if (membership and membership.expiry_date) else ''

    return jsonify(
        success=True,
        member={
            'name': user.full_name,
            'first_name': user.first_name,
            'middle_initial': user.middle_initial or '',
            'last_name': user.last_name,
            'extension_name': user.extension_name or '',
            'email': email,
            'phone': user.phone or '',
            'plan': plan_display,
            'expiry': expiry_display,
            'expiry_iso': expiry_iso,
        }
    )


@app.route('/admin/delete-member/<int:member_id>', methods=['POST'])
def admin_delete_member(member_id):
    if session.get('role') != 'admin':
        return jsonify(success=False, error='Unauthorized.'), 403

    user = User.query.filter_by(id=member_id, role='member').first()
    if user is None:
        return jsonify(success=False, error='Member not found.'), 404

    db.session.delete(user)
    db.session.commit()

    return jsonify(success=True, message='Member deleted successfully.')


@app.route('/admin/verify-payment/<int:payment_id>', methods=['POST'])
def admin_verify_payment(payment_id):
    if session.get('role') not in ('admin', 'staff'):
        return jsonify(success=False, error='Unauthorized.'), 403

    data = request.get_json(silent=True) or request.form
    action = (data.get('action') or '').strip().lower()
    if action not in ('approve', 'reject'):
        return jsonify(success=False, error='Invalid action.'), 400

    payment = Payment.query.get(payment_id)
    if payment is None:
        return jsonify(success=False, error='Payment not found.'), 404
    if payment.status not in ('pending', 'approved'):
        # Someone else already finished processing this exact request (e.g. two
        # staff/admin tabs had the same card open). Tell the client to just drop
        # the stale card instead of showing a scary error toast. ──
        return jsonify(success=False, error='This request was already processed by someone else.',
                        stale=True), 409

    # ── Stage 1: the plan request itself is awaiting approval — no payment
    #    method has been chosen yet. This is staff's call: approving here
    #    just greenlights the plan so the member can proceed to pay; it does
    #    NOT activate the membership yet. Admin doesn't act at this stage. ──
    if payment.status == 'pending':
        if session.get('role') != 'staff':
            return jsonify(success=False, error='Plan requests are approved by staff, not admin.'), 403

        if action == 'reject':
            payment.status = 'rejected'
            payment.verified_at = datetime.now(timezone.utc)
            payment.notified = False  # let the member see a "request declined" notice
            # Only flip the membership itself to 'declined' if it was sitting
            # there *because of this pending request* (status == 'pending').
            # If the member already has an active plan and this was a renewal
            # request on top of it, leave the active membership untouched —
            # only the renewal attempt was declined, not their current plan.
            membership = Membership.query.filter_by(member_id=payment.member_id).first()
            if membership and membership.status == 'pending':
                membership.status = 'declined'
            db.session.commit()
            return jsonify(success=True, message='Plan request rejected.', status='rejected')

        # Staff reviews the uploaded school ID (if any) at this stage and has
        # the final say on student status — the member's self-reported
        # checkbox at request time is just a starting point. Whatever staff
        # confirms here becomes the amount actually charged.
        if 'is_student' in data:
            confirmed_student = (data.get('is_student') or '').strip().lower() in ('1', 'true', 'yes')
            payment.is_student = confirmed_student
            payment.amount     = _payment_total(payment.plan, confirmed_student, payment.coach_name)

        payment.status = 'approved'
        payment.method = 'Pending — choose payment method'
        payment.notified = False
        db.session.commit()
        return jsonify(success=True, message='Plan approved — the member can now submit payment.', status='approved')

    # ── Stage 2: the plan was already approved by staff; this verifies the
    #    payment the member has since submitted. Who handles it depends on
    #    the payment method the member chose — Cash payments are confirmed
    #    by front-desk staff, GCash payments are verified by admin. ──
    if payment.method.startswith('Pending'):
        return jsonify(success=False, error='This member has not chosen a payment method yet. Ask them to complete payment on their Payment tab before verifying.'), 400

    required_role = 'staff' if payment.method == 'Cash' else 'admin'
    if session.get('role') != required_role:
        # Not this role's card to act on — not an error, just stale for them.
        if required_role == 'staff':
            error = 'This is a Cash payment — it\'s confirmed by front-desk staff, no action needed here.'
        else:
            error = 'This is a GCash payment — it\'s verified by admin, no action needed here.'
        return jsonify(success=False, error=error, stale=True), 409
    if action == 'approve' and payment.method == 'GCash' and not payment.proof_image_path:
        return jsonify(success=False, error='No GCash proof of payment was uploaded for this request.'), 400

    if action == 'reject':
        payment.status = 'rejected'
        payment.verified_at = datetime.now(timezone.utc)
        payment.notified = False  # let the member see a "request declined" notice
        membership = Membership.query.filter_by(member_id=payment.member_id).first()
        if membership and membership.status == 'pending':
            membership.status = 'declined'
        db.session.commit()
        return jsonify(success=True, message='Payment rejected.', status='rejected')

    # ── Approve: activate/extend membership (same logic as staff_record_payment) ──
    payment.status = 'verified'
    payment.verified_at = datetime.now(timezone.utc)
    payment.notified = False  # let the member see a fresh "payment approved!" popup

    member = payment.member
    plan   = payment.plan
    today  = _today_manila()

    membership = Membership.query.filter_by(member_id=member.id).first()

    # Only an already-ACTIVE membership represents real remaining time worth
    # stacking a renewal on top of. A 'pending' membership's expiry_date is
    # just a preview computed when the request was first submitted (before
    # staff/admin ever approved it) — treating that as "existing unexpired
    # time" here would double-count the plan's duration on top of itself.
    was_active_with_time = (
        membership is not None
        and membership.status == 'active'
        and membership.expiry_date is not None
        and membership.expiry_date > today
    )

    if membership is None:
        membership = Membership(
            member_id=member.id,
            plan_id=plan.id if plan else None,
            start_date=today,
            expiry_date=today,
            status='active',
        )
        db.session.add(membership)

    # If the member requested a future start date and doesn't already have
    # unexpired time on an active plan, honor that date instead of "today".
    requested_start = payment.requested_start_date
    if was_active_with_time:
        base_date = membership.expiry_date
    else:
        base_date = requested_start if (requested_start and requested_start > today) else today
        membership.start_date = base_date

    membership.expiry_date = _plan_expiry(plan, base_date)
    if plan is not None:
        membership.plan_id = plan.id
    membership.status = 'active'

    if member.status != 'active':
        member.status = 'active'

    db.session.commit()

    _send_membership_activated_email(member, plan, membership.start_date)

    return jsonify(
        success=True,
        message='Payment approved — membership activated!',
        status='verified',
        expiry=membership.expiry_date.strftime('%b %d, %Y'),
    )


def _payment_stage(p):
    """Classify an in-progress Payment into its approval stage:
       - 'approval'        : the plan request itself, awaiting staff sign-off
                              (no payment method chosen yet)
       - 'awaiting_payment': plan approved, member hasn't chosen Cash/GCash yet
       - 'verify_cash'     : Cash payment, confirmed by front-desk staff
       - 'verify_gcash'    : GCash payment, verified by admin
    """
    if p.status == 'pending':
        return 'approval'
    if p.method.startswith('Pending'):
        return 'awaiting_payment'
    if p.method == 'Cash':
        return 'verify_cash'
    return 'verify_gcash'


def _find_member(identifier):
    """Resolve a member from a name, email, or #id string. Returns (user, error_message)."""
    identifier = (identifier or '').strip()
    if not identifier:
        return None, 'Please enter a member name, ID, or email.'

    # #1001 or plain numeric id
    numeric = identifier.lstrip('#')
    if numeric.isdigit():
        user = User.query.filter_by(id=int(numeric), role='member').first()
        return (user, None) if user else (None, 'No member found with that ID.')

    # email
    if '@' in identifier:
        user = User.query.filter_by(email=identifier.lower(), role='member').first()
        return (user, None) if user else (None, 'No member found with that email.')

    # full name match (case-insensitive)
    matches = User.query.filter(
        db.func.lower(db.func.concat(User.first_name, ' ', User.last_name)) == identifier.lower(),
        User.role == 'member'
    ).all()
    if len(matches) == 1:
        return matches[0], None
    if len(matches) > 1:
        return None, 'Multiple members share that name — please use their ID or email instead.'
    return None, 'No member found with that name.'


@app.route('/member/submit-payment', methods=['POST'])
def member_submit_payment():
    if session.get('role') != 'member':
        return jsonify(success=False, error='Unauthorized.'), 403

    user = User.query.get(session.get('user_id'))
    if user is None:
        return jsonify(success=False, error='Unauthorized.'), 403

    today = _today_manila()

    existing_membership = Membership.query.filter_by(member_id=user.id).first()
    if (existing_membership and existing_membership.status == 'active'
            and existing_membership.expiry_date and existing_membership.expiry_date >= today):
        plan_name = existing_membership.plan.name if existing_membership.plan else 'a plan'
        return jsonify(
            success=False,
            error=f'You are currently registered to the {plan_name} plan (active until '
                  f'{existing_membership.expiry_date.strftime("%b %d, %Y")}). '
                  f'You can request a new plan once it expires.'
        ), 409

    existing_request = (
        Payment.query
        .filter(Payment.member_id == user.id, Payment.status.in_(['pending', 'approved']))
        .first()
    )
    if existing_request is not None:
        if existing_request.status == 'pending':
            return jsonify(success=False, error='You already have a plan request awaiting staff approval.'), 409
        return jsonify(success=False, error='Your plan has already been approved — head to the Payment tab to complete payment.'), 409

    data = request.form
    is_promo    = (data.get('is_promo')    or '').strip().lower() in ('1', 'true', 'yes')
    plan_key    = (data.get('plan')        or '').strip().lower()
    is_student  = (data.get('is_student')  or '').strip().lower() in ('1', 'true', 'yes')
    wants_coach = (data.get('wants_coach') or '').strip().lower() in ('1', 'true', 'yes')
    coach_name  = (data.get('coach_name')  or '').strip()
    start_date_raw = (data.get('start_date') or '').strip()

    if not start_date_raw:
        return jsonify(success=False, error='Please choose a start date for your plan.'), 400
    try:
        requested_start = date.fromisoformat(start_date_raw)
    except ValueError:
        return jsonify(success=False, error='Invalid start date.'), 400
    if requested_start < today:
        return jsonify(success=False, error='Start date cannot be in the past.'), 400

    # ── Promo request: a member picking a promo card sends is_promo=1 +
    #    promo_id instead of a regular plan key. Promos don't carry a
    #    structured duration of their own (they're freeform — "16
    #    sessions", "30 days", etc.) — so the request rides on the Monthly
    #    plan behind the scenes purely for expiry-date scheduling. The
    #    promo's real name/price is tagged in `notes` (and surfaced back
    #    to staff/admin/the member via _payment_display_plan) so nothing
    #    about the promo itself is lost. Student discounts never apply
    #    here, matching the member-side UI which hides that question once
    #    a promo is selected. Unlike the regular-plan path below, a coach
    #    is mandatory (not optional) with every promo. ──
    if is_promo:
        promo_id_raw = (data.get('promo_id') or '').strip()
        try:
            promo_id = int(promo_id_raw)
        except ValueError:
            return jsonify(success=False, error='Please select a promo.'), 400
        promo = GymPromo.query.get(promo_id)
        if promo is None or not promo.is_active:
            return jsonify(success=False, error='Selected promo is no longer available.'), 400

        coach = Coach.query.filter_by(name=coach_name, is_active=True).first()
        if coach is None:
            return jsonify(success=False, error='Please choose a coach.'), 400
        occupancy = _get_coach_occupancy().get(coach.name, 0)
        if occupancy >= coach.max_members:
            return jsonify(success=False, error=f'{coach.name} is currently at full capacity. Please choose another coach.'), 409
        wants_coach = True

        anchor_plan = MembershipPlan.query.filter_by(name='Monthly').first()
        expiry = _plan_expiry(anchor_plan, requested_start) if anchor_plan else requested_start + timedelta(days=30)
        promo_price_text = f'{promo.price:,.0f}' if promo.price == int(promo.price) else f'{promo.price:,.2f}'
        # The coach is bundled into the promo price itself — no separate
        # fee is added on top (unlike the regular-plan path below, where
        # _coach_fee() does get charged).
        promo_total = promo.price
        promo_notes = f'Promo request: {promo.title} — ₱{promo_price_text} + Coach ({coach_name})'

        new_payment = Payment(
            member_id=user.id,
            plan_id=anchor_plan.id if anchor_plan else None,
            amount=promo_total,
            method='Pending — awaiting staff approval',
            reference_number=None,
            proof_image_path=None,
            is_student=False,
            student_id_image_path=None,
            wants_coach=wants_coach,
            coach_name=coach_name,
            requested_start_date=requested_start,
            status='pending',
            notes=promo_notes,
        )
        db.session.add(new_payment)

        membership = Membership.query.filter_by(member_id=user.id).first()
        if membership is None:
            membership = Membership(
                member_id=user.id,
                plan_id=anchor_plan.id if anchor_plan else None,
                start_date=requested_start,
                expiry_date=expiry,
                status='pending',
            )
            db.session.add(membership)
        elif membership.status != 'active':
            membership.plan_id     = anchor_plan.id if anchor_plan else None
            membership.start_date  = requested_start
            membership.expiry_date = expiry
            membership.status      = 'pending'

        db.session.commit()

        return jsonify(success=True, message=f'{promo.title} promo requested to start '
                                              f'{requested_start.strftime("%b %d, %Y")}. '
                                              f'Please wait for staff approval before proceeding to payment.')

    plan_name_map = {
        'daily': 'Daily',
        'half month': 'Half Month',
        'monthly': 'Monthly',
        'yearly': 'Yearly',
    }
    if plan_key not in plan_name_map:
        return jsonify(success=False, error='Please select a membership plan.'), 400

    plan = MembershipPlan.query.filter_by(name=plan_name_map[plan_key]).first()
    if plan is None:
        return jsonify(success=False, error='Selected plan is not available.'), 400

    if wants_coach:
        coach = Coach.query.filter_by(name=coach_name, is_active=True).first()
        if coach is None:
            return jsonify(success=False, error='Please select a coach.'), 400
        occupancy = _get_coach_occupancy().get(coach.name, 0)
        if occupancy >= coach.max_members:
            return jsonify(success=False, error=f'{coach.name} is currently at full capacity. Please choose another coach.'), 409
    else:
        coach_name = None

    payment_amount = _payment_total(plan, is_student, coach_name)

    # ── Student ID proof (required only if the member says they're a student) ──
    student_id_relative_path = None
    if is_student:
        student_id_file = request.files.get('student_id')
        if not student_id_file or not student_id_file.filename:
            return jsonify(success=False, error='Please upload a photo of your school ID.'), 400

        ext = student_id_file.filename.rsplit('.', 1)[-1].lower() if '.' in student_id_file.filename else ''
        if ext not in PROOF_ALLOWED_EXT:
            return jsonify(success=False, error='School ID must be a PNG, JPG, or PDF file.'), 400

        student_id_file.seek(0, os.SEEK_END)
        size = student_id_file.tell()
        student_id_file.seek(0)
        if size > PROOF_MAX_BYTES:
            return jsonify(success=False, error='School ID file is too large (max 10MB).'), 400

        safe_name = secure_filename(f"{secrets.token_hex(8)}_{student_id_file.filename}")
        student_id_full_path = os.path.join(PROOF_UPLOAD_FOLDER, safe_name)
        student_id_file.save(student_id_full_path)

        # ── Reject obvious non-ID uploads. Three offline checks, applied in
        #    order — each is skipped (returns None) for PDFs, or if its
        #    library isn't installed, and those cases still go through to
        #    staff's manual review rather than being blocked here. ──
        if ext != 'pdf':
            # 1) Must have a visible face at all (blank images, scenery, a
            #    plain screenshot of a form, etc. get caught here).
            has_face = _image_has_face(student_id_full_path)
            if has_face is False:
                os.remove(student_id_full_path)
                return jsonify(
                    success=False,
                    error='We couldn\'t detect a face in that photo. Please upload a clear photo of your '
                          'school ID with your photo visible on it.'
                ), 400

            # 2) A face alone isn't enough — a random selfie has one too.
            #    Only reject here if BOTH the card-shape and text checks
            #    come back definitively negative; if either is unavailable
            #    (None) or positive, give the upload the benefit of the
            #    doubt and let staff's manual review make the final call.
            looks_like_card = _image_looks_like_a_card(student_id_full_path)
            has_text = _image_has_readable_text(student_id_full_path)
            if looks_like_card is False and has_text is False:
                os.remove(student_id_full_path)
                return jsonify(
                    success=False,
                    error='That doesn\'t look like a school ID card. Please upload a clear, well-lit photo '
                          'of the ID itself — not a selfie — with your photo and printed details (name, '
                          'school, ID number) visible.'
                ), 400

        student_id_relative_path = f"uploads/payment_proofs/{safe_name}"

    # ── Record the plan request as pending — no payment details are collected
    #    here. Payment method/reference/proof are submitted separately from
    #    the Payment tab (see /member/submit-payment-method below), then
    #    staff/admin verify and approve. ──
    new_payment = Payment(
        member_id=user.id,
        plan_id=plan.id,
        amount=payment_amount,
        method='Pending — awaiting staff approval',
        reference_number=None,
        proof_image_path=None,
        is_student=is_student,
        student_id_image_path=student_id_relative_path,
        wants_coach=wants_coach,
        coach_name=coach_name,
        requested_start_date=requested_start,
        status='pending',
    )
    db.session.add(new_payment)

    # ── Reflect the pending selection on the membership record so admin/staff
    #    can see what's awaiting verification. Don't touch an already-active
    #    membership — that stays active until the renewal is approved.
    membership = Membership.query.filter_by(member_id=user.id).first()
    if membership is None:
        membership = Membership(
            member_id=user.id,
            plan_id=plan.id,
            start_date=requested_start,
            expiry_date=_plan_expiry(plan, requested_start),
            status='pending',
        )
        db.session.add(membership)
    elif membership.status != 'active':
        membership.plan_id     = plan.id
        membership.start_date  = requested_start
        membership.expiry_date = _plan_expiry(plan, requested_start)
        membership.status      = 'pending'

    db.session.commit()

    return jsonify(success=True, message=f'Plan requested to start {requested_start.strftime("%b %d, %Y")}. Please wait for staff approval before proceeding to payment.')


@app.route('/member/cancel-plan-request', methods=['POST'])
def member_cancel_plan_request():
    """Member withdraws their own plan request — but only while it's still
    strictly Pending, i.e. staff hasn't opened/reviewed it yet. Once staff
    has seen it (Processing) or made a decision (Approved/Declined), it's no
    longer cancelable here — it's already in motion.

    Cancelling removes the request from staff's queue entirely (the
    'pending'/'approved' filter used everywhere else naturally excludes
    'cancelled'), and — if this request hadn't been activated yet — clears
    the placeholder membership row so the member can submit a fresh request
    right away."""
    if session.get('role') != 'member':
        return jsonify(success=False, error='Unauthorized.'), 403

    user = User.query.get(session.get('user_id'))
    if user is None:
        return jsonify(success=False, error='Unauthorized.'), 403

    payment = (
        Payment.query
        .filter_by(member_id=user.id, status='pending')
        .order_by(Payment.paid_at.desc())
        .first()
    )
    if payment is None:
        return jsonify(success=False, error='No pending plan request to cancel.'), 404

    if payment.staff_viewed:
        return jsonify(success=False, error='Staff has already started reviewing this request — it can no longer be cancelled.'), 409

    payment.status = 'cancelled'
    payment.verified_at = datetime.now(timezone.utc)
    payment.notified = True  # member cancelled it themselves — no popup needed

    # Only clear the membership if it was 'pending' *because of this request*.
    # An already-active membership (this was a renewal attempt on top of it)
    # stays untouched.
    membership = Membership.query.filter_by(member_id=user.id).first()
    if membership and membership.status == 'pending':
        db.session.delete(membership)

    db.session.commit()

    return jsonify(success=True, message='Plan request cancelled. You can submit a new request anytime.')


@app.route('/member/ocr-gcash-proof', methods=['POST'])
def member_ocr_gcash_proof():
    """Reads the GCash screenshot the member just picked (before they hit
    submit) and tries to auto-detect the amount, reference number, date,
    time, and sender name printed on it, so the member doesn't have to
    retype them. This is a preview-only pass — the file isn't saved here;
    the real save happens in /member/submit-payment-method on final submit."""
    if session.get('role') != 'member':
        return jsonify(success=False, error='Unauthorized.'), 403

    proof_file = request.files.get('gcash_proof')
    if not proof_file or not proof_file.filename:
        return jsonify(success=False, error='No file provided.'), 400

    ext = proof_file.filename.rsplit('.', 1)[-1].lower() if '.' in proof_file.filename else ''
    if ext not in PROOF_ALLOWED_EXT:
        return jsonify(success=False, error='Unsupported file type.'), 400
    if ext == 'pdf':
        # OCR here only handles images (opencv can't read PDFs); a PDF
        # proof just skips straight to manual entry.
        return jsonify(success=True, detected=None, ocr_available=False)

    proof_file.seek(0, os.SEEK_END)
    size = proof_file.tell()
    proof_file.seek(0)
    if size > PROOF_MAX_BYTES:
        return jsonify(success=False, error='File is too large (max 10MB).'), 400

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=f'.{ext}', delete=False) as tmp:
            proof_file.save(tmp.name)
            tmp_path = tmp.name
        detected = _extract_gcash_receipt_fields(tmp_path)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)

    if detected is None:
        # OCR isn't available on this server — tell the frontend so it
        # can quietly fall back to plain manual entry, no error shown.
        return jsonify(success=True, detected=None, ocr_available=False)

    return jsonify(success=True, detected=detected, ocr_available=True)


@app.route('/member/submit-payment-method', methods=['POST'])
def member_submit_payment_method():
    """Called from the Payment tab: attaches the chosen payment method
    (Cash or GCash) — plus reference number and proof screenshot for GCash —
    to the member's current pending plan request."""
    if session.get('role') != 'member':
        return jsonify(success=False, error='Unauthorized.'), 403

    user = User.query.get(session.get('user_id'))
    if user is None:
        return jsonify(success=False, error='Unauthorized.'), 403

    payment = (
        Payment.query
        .filter_by(member_id=user.id, status='approved')
        .order_by(Payment.paid_at.desc())
        .first()
    )
    if payment is None:
        return jsonify(success=False, error='No approved plan found. Please wait for staff to approve your plan request before paying.'), 400
    if not payment.method.startswith('Pending'):
        return jsonify(success=False, error='Payment already submitted for this request.'), 400

    data = request.form
    payment_method  = (data.get('payment_method')  or '').strip().lower()
    gcash_reference = (data.get('gcash_reference') or '').strip()

    if payment_method not in ('cash', 'gcash'):
        return jsonify(success=False, error='Please select a payment method.'), 400

    if payment_method == 'gcash':
        if not gcash_reference:
            return jsonify(success=False, error='Please enter your GCash reference number.'), 400

        gcash_proof_file = request.files.get('gcash_proof')
        if not gcash_proof_file or not gcash_proof_file.filename:
            return jsonify(success=False, error='Please attach a screenshot of your GCash proof of payment.'), 400

        # The member can attach up to 3 receipt screenshots total (e.g. a
        # payment that was split across two or three GCash transfers) — the
        # primary one above is required, these two are optional. Only the
        # primary screenshot is ever run through OCR; these extra ones are
        # for admin's manual review only.
        extra_proof_files = [
            f for f in (request.files.get('gcash_proof_2'), request.files.get('gcash_proof_3'))
            if f and f.filename
        ]

        amount_paid = (data.get('gcash_amount_paid') or '').strip()
        if not amount_paid:
            return jsonify(success=False, error='Please enter the amount you paid.'), 400
        try:
            amount_paid_val = float(amount_paid.replace(',', ''))
        except ValueError:
            return jsonify(success=False, error='Please enter a valid amount paid.'), 400
        if amount_paid_val + 0.01 < float(payment.amount):
            return jsonify(success=False, error=(
                f'The amount paid (₱{amount_paid_val:,.2f}) is less than the ₱{float(payment.amount):,.2f} '
                f'required for this plan/promo. Please attach enough receipts to cover the full amount before submitting.'
            )), 400

        for f in [gcash_proof_file, *extra_proof_files]:
            ext = f.filename.rsplit('.', 1)[-1].lower() if '.' in f.filename else ''
            if ext not in PROOF_ALLOWED_EXT:
                return jsonify(success=False, error='Proof of payment must be a PNG, JPG, or PDF file.'), 400
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(0)
            if size > PROOF_MAX_BYTES:
                return jsonify(success=False, error='Proof of payment file is too large (max 10MB).'), 400

        def _save_proof(f):
            safe_name = secure_filename(f"{secrets.token_hex(8)}_{f.filename}")
            f.save(os.path.join(PROOF_UPLOAD_FOLDER, safe_name))
            return f"uploads/payment_proofs/{safe_name}"

        proof_paths = [_save_proof(gcash_proof_file)] + [_save_proof(f) for f in extra_proof_files]

        payment.method            = 'GCash'
        payment.reference_number  = gcash_reference
        payment.proof_image_path  = proof_paths[0]
        payment.proof_image_path_2 = proof_paths[1] if len(proof_paths) > 1 else None
        payment.proof_image_path_3 = proof_paths[2] if len(proof_paths) > 2 else None

        # Optional context the member filled in on the payment card (sender
        # name and the date/time they say they paid) — not required, but
        # useful for staff/admin cross-checking against the screenshot(s).
        # There's no dedicated column for these, so they ride along in the
        # existing free-text `notes` field.
        sender_name = (data.get('gcash_sender_name') or '').strip()
        paid_date   = (data.get('gcash_paid_date')   or '').strip()
        paid_time   = (data.get('gcash_paid_time')   or '').strip()
        screenshot_amounts = [
            (data.get('gcash_amount_screenshot_1') or '').strip(),
            (data.get('gcash_amount_screenshot_2') or '').strip(),
            (data.get('gcash_amount_screenshot_3') or '').strip(),
        ]
        note_parts = []
        if sender_name:
            note_parts.append(f"GCash sender: {sender_name}")
        if paid_date or paid_time:
            note_parts.append(f"Member-reported payment time: {paid_date} {paid_time}".strip())
        if amount_paid:
            note_parts.append(f"Member-reported amount paid: ₱{amount_paid}")
        breakdown = [f"Screenshot {i+1}: ₱{amt}" for i, amt in enumerate(screenshot_amounts) if amt]
        if len(breakdown) > 1:
            note_parts.append("Per-screenshot breakdown — " + ', '.join(breakdown))
        if note_parts:
            new_notes = ' | '.join(note_parts)
            # `notes` also carries the 'Promo request: <plan>' marker that
            # the admin dashboard's promo badge depends on (see is_promo
            # below) — overwriting it here would silently drop that badge
            # the moment a member submits their GCash details. Append
            # instead of replacing when that marker is already present.
            if payment.notes and payment.notes.startswith('Promo request:'):
                payment.notes = payment.notes + ' | ' + new_notes
            else:
                payment.notes = new_notes
    else:
        payment.method            = 'Cash'
        payment.reference_number  = None
        payment.proof_image_path  = None

    db.session.commit()

    if payment_method == 'gcash':
        message = 'GCash payment submitted! Awaiting verification by admin.'
    else:
        message = 'Got it — please settle your Cash payment at the front desk with staff.'

    return jsonify(success=True, message=message)


@app.route('/staff/record-payment', methods=['POST'])
def staff_record_payment():
    if session.get('role') not in ('staff', 'admin'):
        return jsonify(success=False, error='Unauthorized.'), 403

    data = request.get_json(silent=True) or request.form
    member_identifier = data.get('member_identifier') or ''
    plan_name          = (data.get('plan')      or '').strip()
    method              = (data.get('method')    or '').strip()

    member, error = _find_member(member_identifier)
    if error:
        return jsonify(success=False, error=error), 404

    plan = MembershipPlan.query.filter_by(name=plan_name).first()
    if plan is None:
        return jsonify(success=False, error='Please select a valid membership plan.'), 400

    if not method:
        return jsonify(success=False, error='Please select a payment method.'), 400
    if method != 'Cash':
        # Front-desk entries are Cash only — GCash goes through the member's
        # own submission + Admin verification flow, not this manual form.
        return jsonify(success=False, error='This form only records Cash payments. GCash payments are verified by Admin from the member\'s own submission.'), 400

    # If this member already has an in-progress request (plan request awaiting
    # approval, or a payment awaiting verification), settle that same record
    # instead of leaving it stale — so it disappears from Pending Requests
    # once staff records the payment here.
    existing_request = (
        Payment.query
        .filter(Payment.member_id == member.id, Payment.status.in_(['pending', 'approved']))
        .order_by(Payment.paid_at.desc())
        .first()
    )
    if existing_request is not None:
        existing_request.plan_id = plan.id
        existing_request.amount = _payment_total(plan, existing_request.is_student, existing_request.coach_name)
        existing_request.method = method
        existing_request.status = 'verified'
        existing_request.recorded_by_id = session.get('user_id')
        existing_request.verified_at = datetime.now(timezone.utc)
        existing_request.notified = False  # let the member see a fresh "payment approved!" popup
        new_payment = existing_request
    else:
        new_payment = Payment(
            member_id=member.id,
            plan_id=plan.id,
            amount=plan.price,
            method=method,
            status='verified',
            recorded_by_id=session.get('user_id'),
            verified_at=datetime.now(timezone.utc),
        )
        db.session.add(new_payment)

    # Extend (or create) the member's membership, starting from whichever is later:
    # today, or their current expiry date (so early renewals stack on top of remaining time).
    today = _today_manila()
    membership = Membership.query.filter_by(member_id=member.id).first()

    # Only stack on top of an already-ACTIVE membership's remaining time. A
    # 'pending' membership's expiry_date is just a preview computed when the
    # plan request was first submitted — stacking on that would double-count
    # the plan's duration on top of itself.
    was_active_with_time = (
        membership is not None
        and membership.status == 'active'
        and membership.expiry_date is not None
        and membership.expiry_date > today
    )

    if membership is None:
        membership = Membership(member_id=member.id, plan_id=plan.id, start_date=today,
                                 expiry_date=today, status='active')
        db.session.add(membership)

    base_date = membership.expiry_date if was_active_with_time else today
    membership.plan_id     = plan.id
    membership.expiry_date = _plan_expiry(plan, base_date)
    membership.status      = 'active'
    if member.status != 'active':
        member.status = 'active'

    db.session.commit()

    _send_membership_activated_email(member, plan, membership.start_date)

    return jsonify(
        success=True,
        message='Payment recorded successfully.',
        payment={
            'member_name': member.full_name,
            'plan': plan.name,
            'amount': str(plan.price),
            'expiry': membership.expiry_date.strftime('%b %d, %Y'),
        }
    )


VALID_COACH_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']


@app.route('/staff/coach/update', methods=['POST'])
def staff_update_coach():
    """Staff edits a coach's available days and member capacity so members
    see accurate availability when requesting that coach."""
    if session.get('role') not in ('staff', 'admin'):
        return jsonify(success=False, error='Unauthorized.'), 403

    coach_id = request.form.get('coach_id', type=int)
    coach = Coach.query.get(coach_id) if coach_id else None
    if coach is None:
        return jsonify(success=False, error='Coach not found.'), 404

    days = request.form.getlist('available_days')
    days = [d for d in days if d in VALID_COACH_DAYS]
    # Keep Mon..Sun order regardless of checkbox submission order
    days = [d for d in VALID_COACH_DAYS if d in days]

    max_members = request.form.get('max_members', type=int)
    if max_members is None or max_members < 1:
        return jsonify(success=False, error='Capacity must be at least 1 member.'), 400

    fee = request.form.get('fee', type=float)
    if fee is None or fee < 0:
        return jsonify(success=False, error='Coach fee must be 0 or a positive amount.'), 400

    current_occupancy = _get_coach_occupancy().get(coach.name, 0)
    if max_members < current_occupancy:
        return jsonify(
            success=False,
            error=f'{coach.name} currently has {current_occupancy} active member(s) — '
                  f'capacity cannot be set below that.'
        ), 400

    coach.available_days = ','.join(days)
    coach.max_members = max_members
    coach.fee = fee
    db.session.commit()

    return jsonify(success=True, message=f"{coach.name}'s availability and fee updated.")


@app.route('/staff/coach/add', methods=['POST'])
def staff_add_coach():
    """Staff/admin adds a new coach to the roster from the Coach tab's
    'Add Coach' modal. The new coach starts active immediately so members
    can select them right away."""
    if session.get('role') not in ('staff', 'admin'):
        return jsonify(success=False, error='Unauthorized.'), 403

    data = request.get_json(silent=True) or request.form
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify(success=False, error='Please enter a coach name.'), 400

    if Coach.query.filter(db.func.lower(Coach.name) == name.lower()).first():
        return jsonify(success=False, error=f'A coach named "{name}" already exists.'), 400

    days = data.get('available_days') or []
    if isinstance(days, str):
        days = [d.strip() for d in days.split(',') if d.strip()]
    days = [d for d in VALID_COACH_DAYS if d in days]

    max_members = data.get('max_members', 10)
    try:
        max_members = int(max_members)
    except (TypeError, ValueError):
        max_members = None
    if max_members is None or max_members < 1:
        return jsonify(success=False, error='Capacity must be at least 1 member.'), 400

    fee = data.get('fee', 0)
    try:
        fee = float(fee)
    except (TypeError, ValueError):
        fee = None
    if fee is None or fee < 0:
        return jsonify(success=False, error='Coach fee must be 0 or a positive amount.'), 400

    coach = Coach(
        name=name,
        available_days=','.join(days),
        max_members=max_members,
        fee=fee,
        is_active=True,
    )
    db.session.add(coach)
    db.session.commit()

    return jsonify(success=True, message=f'{coach.name} added to the coach roster.', coach_id=coach.id)


@app.route('/staff/coach/delete', methods=['POST'])
def staff_delete_coach():
    """Staff/admin removes a coach from the roster entirely. Blocked while
    the coach still has active members assigned, so no one's coaching
    arrangement silently disappears — reassign them first."""
    if session.get('role') not in ('staff', 'admin'):
        return jsonify(success=False, error='Unauthorized.'), 403

    data = request.get_json(silent=True) or request.form
    coach_id = data.get('coach_id')
    try:
        coach_id = int(coach_id)
    except (TypeError, ValueError):
        coach_id = None
    coach = Coach.query.get(coach_id) if coach_id else None
    if coach is None:
        return jsonify(success=False, error='Coach not found.'), 404

    occupancy = _get_coach_occupancy().get(coach.name, 0)
    if occupancy > 0:
        return jsonify(
            success=False,
            error=f'Cannot delete {coach.name} — they currently have {occupancy} active '
                  f'member(s). Reassign those members to another coach first.'
        ), 400

    name = coach.name
    db.session.delete(coach)
    db.session.commit()

    return jsonify(success=True, message=f'{name} removed from the coach roster.')


def _member_plan_status(member_id):
    """Status label for one member's current plan — 'No Plan', 'Expired',
    'Declined', 'Pending', or 'Active'. Same rules as _get_members_with_plans(),
    kept as its own lightweight lookup so check-in/out doesn't need to query
    every member just to check one."""
    membership = Membership.query.filter_by(member_id=member_id).first()
    if membership is None or membership.plan_id is None:
        return 'No Plan'
    today = _today_manila()
    if membership.expiry_date and membership.expiry_date < today:
        return 'Expired'
    if membership.status == 'declined':
        return 'Declined'
    if membership.status == 'pending':
        return 'Pending'
    return 'Active'


_PLAN_STATUS_BLOCK_REASON = {
    'No Plan':  'does not have a membership plan',
    'Pending':  "membership plan is still pending approval",
    'Expired':  'membership plan has expired',
    'Declined': 'membership plan request was declined',
}


@app.route('/staff/checkin', methods=['POST'])
def staff_checkin():
    if session.get('role') not in ('staff', 'admin'):
        return jsonify(success=False, error='Unauthorized.'), 403

    data = request.get_json(silent=True) or request.form
    member, error = _find_member(data.get('member_identifier'))
    if error:
        return jsonify(success=False, error=error), 404

    plan_status = _member_plan_status(member.id)
    if plan_status != 'Active':
        reason = _PLAN_STATUS_BLOCK_REASON.get(plan_status, 'membership is not active')
        return jsonify(
            success=False,
            error=f'{member.first_name} {reason} — check-in is unavailable until the plan is active.'
        ), 403

    open_entry = Attendance.query.filter_by(member_id=member.id, check_out=None).first()
    if open_entry is not None:
        return jsonify(success=False, error=f'{member.first_name} is already checked in.'), 409

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    entry = Attendance(member_id=member.id, check_in=now, logged_by_id=session.get('user_id'))
    db.session.add(entry)
    db.session.commit()

    return jsonify(
        success=True,
        message='Check-in recorded.',
        member_name=member.full_name,
        time=_to_manila(now).strftime('%I:%M %p').lstrip('0'),
    )


@app.route('/staff/checkout', methods=['POST'])
def staff_checkout():
    if session.get('role') not in ('staff', 'admin'):
        return jsonify(success=False, error='Unauthorized.'), 403

    data = request.get_json(silent=True) or request.form
    member, error = _find_member(data.get('member_identifier'))
    if error:
        return jsonify(success=False, error=error), 404

    entry = (
        Attendance.query
        .filter_by(member_id=member.id, check_out=None)
        .order_by(Attendance.check_in.desc())
        .first()
    )
    if entry is None:
        # No open session to close. Since check-in is gated on an active
        # plan, the only way to reach a real open entry here is if the
        # plan was active at check-in time — so this is always the
        # legitimate "nothing to check out" case, never a bypass of the
        # check-in gate. We deliberately do NOT re-check plan status
        # once an entry IS open, so a plan that lapses mid-visit doesn't
        # strand the member checked in with no way to close it out.
        return jsonify(success=False, error=f'{member.first_name} has no open check-in to close.'), 409

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    entry.check_out = now
    entry.duration_min = int((now - entry.check_in).total_seconds() // 60)
    db.session.commit()

    h, m = divmod(entry.duration_min, 60)
    duration_text = f'{h}h {m}m' if h else f'{m}m'

    return jsonify(
        success=True,
        message='Check-out recorded.',
        member_name=member.full_name,
        time=_to_manila(now).strftime('%I:%M %p').lstrip('0'),
        duration=duration_text,
    )



@app.route('/staff/send-reminder/<int:member_id>', methods=['POST'])
def staff_send_reminder(member_id):
    """Queue a plan-specific expiry reminder for a member — fired from the
    'Send Reminder' button on the 'Members Expiring This Week' panel. Shows
    up as a bot popup next time that member opens their dashboard."""
    if session.get('role') not in ('staff', 'admin'):
        return jsonify(success=False, error='Unauthorized.'), 403

    member = User.query.get(member_id)
    if member is None or member.role != 'member':
        return jsonify(success=False, error='Member not found.'), 404

    membership = member.membership
    if membership is None or membership.status != 'active':
        return jsonify(success=False, error=f'{member.first_name} does not have an active plan.'), 409

    today = _today_manila()
    days_left = (membership.expiry_date - today).days if membership.expiry_date else None
    if days_left is None or not (0 <= days_left <= 7):
        return jsonify(success=False, error=f"{member.first_name}'s plan isn't expiring within 7 days."), 409

    plan_name = membership.plan.name if membership.plan else None
    message = _reminder_message(plan_name, membership.expiry_date, member.first_name, today=today)

    reminder = MembershipReminder(
        member_id=member.id,
        plan_name=plan_name,
        expiry_date=membership.expiry_date,
        message=message,
        sent_by_id=session.get('user_id'),
    )
    db.session.add(reminder)
    db.session.commit()

    return jsonify(
        success=True,
        message=f'Reminder queued for {member.full_name} — they\'ll see it next time they log in.',
        member_name=member.full_name,
        preview=message,
    )


@app.route('/staff/walkin', methods=['POST'])
def staff_walkin():
    """Record a Daily-plan walk-in guest and the cash amount collected for
    them. Not tied to a member account or membership — just a logged visit
    + payment, shown in the Walk In tab's Recent Walk-Ins list."""
    if session.get('role') not in ('staff', 'admin'):
        return jsonify(success=False, error='Unauthorized.'), 403

    data = request.get_json(silent=True) or request.form

    first_name = (data.get('first_name') or '').strip()
    middle_initial = (data.get('middle_initial') or '').strip()
    last_name = (data.get('last_name') or '').strip()
    extension_name = (data.get('extension_name') or '').strip()
    phone = (data.get('phone') or '').strip()
    email = (data.get('email') or '').strip()
    wants_coach = str(data.get('wants_coach') or '').strip().lower() in ('1', 'true', 'yes', 'on')
    coach_name = (data.get('coach_name') or '').strip()
    plan_type = (data.get('plan_type') or 'Daily').strip()

    if plan_type not in ('Daily', 'Boxing'):
        return jsonify(success=False, error='Please select Daily or Boxing.'), 400

    # Boxing includes a coach in its flat rate — always required (staff
    # picks which coach), but never charged as the separate paid add-on
    # that applies to Daily walk-ins.
    if plan_type == 'Boxing':
        wants_coach = True

    if not first_name or not last_name:
        return jsonify(success=False, error='First and last name are required.'), 400
    if not _valid_name(first_name) or not _valid_name(last_name):
        return jsonify(success=False, error='Names can only contain letters, spaces, apostrophes, and hyphens.'), 400
    if phone and not _valid_phone(phone):
        return jsonify(success=False, error='Phone number must start with 09 and be 11 digits.'), 400

    # A coach must be picked from the active roster — no free-typed names —
    # so the record stays consistent with the Coach tab.
    if wants_coach:
        if not coach_name:
            err = 'Please select a coach for the Boxing session.' if plan_type == 'Boxing' \
                else 'Please select a coach, or turn off "Avail a Coach?".'
            return jsonify(success=False, error=err), 400
        coach = Coach.query.filter_by(name=coach_name, is_active=True).first()
        if coach is None:
            return jsonify(success=False, error='Selected coach is not available. Please choose another.'), 400
    else:
        coach_name = ''

    if plan_type == 'Daily':
        daily_plan = MembershipPlan.query.filter_by(name='Daily').first()
        if daily_plan is None:
            return jsonify(success=False, error='No "Daily" plan is set up yet. Add one from Admin → Plans first.'), 400
        base_amount = float(daily_plan.price)
    else:  # Boxing — flat walk-in rate, not tied to a MembershipPlan row
        base_amount = WALKIN_BOXING_FEE

    # The paid coach add-on only exists for Daily's optional toggle —
    # Boxing's coach is already folded into its flat rate, never billed
    # separately.
    coach_fee = WALKIN_COACH_FEE if (wants_coach and plan_type == 'Daily') else 0.0
    total_amount = base_amount + coach_fee

    walkin = WalkIn(
        first_name=first_name,
        middle_initial=middle_initial or None,
        last_name=last_name,
        extension_name=extension_name or None,
        phone=phone or None,
        email=email or None,
        amount=total_amount,
        plan_type=plan_type,
        method='Cash',
        wants_coach=wants_coach,
        coach_name=coach_name or None,
        coach_fee=coach_fee,
        recorded_by_id=session.get('user_id'),
    )
    db.session.add(walkin)
    db.session.commit()

    return jsonify(
        success=True,
        message='Walk-in recorded.',
        walkin={
            'id': walkin.id,
            'name': walkin.full_name,
            'phone': walkin.phone or '—',
            'plan': walkin.plan_type,
            'amount': f'{float(walkin.amount):,.2f}',
            'coach': walkin.coach_name if walkin.wants_coach else '—',
            'time': _to_manila(walkin.created_at).strftime('%I:%M %p').lstrip('0'),
        }
    )


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


# ── Account Settings (Personal Info + Change Password) ───────
# Shared across all three roles — admin, staff, and member all edit the
# same `users` row, so one pair of routes serves every dashboard's
# Settings tab.

@app.route('/update-profile', methods=['POST'])
def update_profile():
    if 'user_id' not in session:
        return jsonify(success=False, error='Not logged in.'), 401

    user = User.query.get(session['user_id'])
    if user is None:
        session.clear()
        return jsonify(success=False, error='User not found.'), 404

    data = request.get_json(silent=True) or {}
    first_name     = (data.get('first_name') or '').strip()
    middle_initial = (data.get('middle_initial') or '').strip()
    last_name      = (data.get('last_name') or '').strip()
    extension_name = (data.get('extension_name') or '').strip()
    email          = (data.get('email') or '').strip()
    phone          = (data.get('phone') or '').strip()
    birthday_str   = (data.get('birthday') or '').strip()

    if not first_name or not last_name or not email:
        return jsonify(success=False, error='First name, last name, and email are required.'), 400
    if not _valid_name(first_name, require_capital=True, lowercase_rest=True) or not _valid_name(last_name, require_capital=True, lowercase_rest=True):
        return jsonify(success=False, error='Names must start with a capital letter, with the rest in lowercase.'), 400
    if middle_initial and not _valid_name(middle_initial, extra_chars='', require_capital=True):
        return jsonify(success=False, error='Middle initial can only contain letters and must start with a capital letter.'), 400
    if extension_name and not _valid_name(extension_name, extra_chars='. '):
        return jsonify(success=False, error='Extension name can only contain letters.'), 400
    if phone and not _valid_phone(phone):
        return jsonify(success=False, error='Phone number must start with 09 and be exactly 11 digits.'), 400

    existing = User.query.filter(User.email == email, User.id != user.id).first()
    if existing:
        return jsonify(success=False, error='That email is already in use by another account.'), 400

    birthday = user.birthday
    if birthday_str:
        try:
            birthday = datetime.strptime(birthday_str, '%Y-%m-%d').date()
        except ValueError:
            return jsonify(success=False, error='Invalid birthday format.'), 400

    user.first_name     = first_name
    user.middle_initial = middle_initial or None
    user.last_name      = last_name
    user.extension_name = extension_name or None
    user.email          = email
    user.phone          = phone or None
    user.birthday       = birthday
    db.session.commit()

    # Keep the session in sync so the sidebar/header reflect the change
    # immediately without requiring a fresh login.
    session['name']  = user.full_name
    session['email'] = user.email

    initials = (user.first_name[0] + user.last_name[0]).upper() if user.first_name and user.last_name else ''

    return jsonify(success=True, message='Profile updated successfully.', user={
        'name':     user.full_name,
        'email':    user.email,
        'initials': initials,
        'phone':    user.phone or '',
        'birthday': user.birthday.isoformat() if user.birthday else '',
    })


def _profile_picture_cooldown(user):
    """Returns (can_change: bool, available_at: datetime | None) for the
    7-day (PROFILE_PICTURE_COOLDOWN_DAYS) profile-picture change cooldown.
    Falls back to created_at when profile_picture_updated_at hasn't been
    backfilled yet, so older accounts are still gated correctly instead of
    being treated as eligible-immediately."""
    reference = user.profile_picture_updated_at or user.created_at
    if reference is None:
        return True, None
    available_at = reference + timedelta(days=PROFILE_PICTURE_COOLDOWN_DAYS)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return now >= available_at, available_at


@app.route('/update-profile-picture', methods=['POST'])
def update_profile_picture():
    if 'user_id' not in session:
        return jsonify(success=False, error='Not logged in.'), 401

    user = User.query.get(session['user_id'])
    if user is None:
        session.clear()
        return jsonify(success=False, error='User not found.'), 404

    can_change, available_at = _profile_picture_cooldown(user)
    if not can_change:
        return jsonify(
            success=False,
            error=f"You can only change your profile picture once every "
                  f"{PROFILE_PICTURE_COOLDOWN_DAYS} days. You'll be able to "
                  f"change it again on {available_at.strftime('%B %d, %Y')}.",
        ), 400

    new_file = request.files.get('profile_picture')
    if not new_file or not new_file.filename:
        return jsonify(success=False, error='Please choose a picture to upload.'), 400

    try:
        new_path = _save_profile_picture(new_file)
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400

    old_path = user.profile_picture
    user.profile_picture = new_path
    user.profile_picture_updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.session.commit()

    # Best-effort cleanup of the old file now that the new one is saved and
    # committed — a failure here shouldn't undo the successful change.
    if old_path and old_path != new_path:
        _delete_content_image(old_path)

    _, next_available_at = _profile_picture_cooldown(user)

    return jsonify(
        success=True,
        message='Profile picture updated successfully.',
        profile_picture_url=url_for('static', filename=new_path),
        available_at=next_available_at.strftime('%B %d, %Y') if next_available_at else None,
    )


@app.route('/admin/update-gcash-settings', methods=['POST'])
def admin_update_gcash_settings():
    """Admin-only: update the GCash account number/name (and optional QR
    code image) members are shown when submitting a payment. Takes effect
    immediately for every member, since the member dashboard reads this
    same row on each page load.

    Sent as multipart/form-data (not JSON) so the optional QR image file
    can travel alongside the number/name in one request:
      - gcash_number, gcash_account_name: required text fields
      - gcash_qr: optional file (PNG/JPG/JPEG/WEBP, max 8MB) — a new QR
        replaces any existing one
      - remove_qr: optional 'true' to delete the existing QR without
        uploading a replacement
    """
    if session.get('role') != 'admin':
        return jsonify(success=False, error='Unauthorized.'), 403

    gcash_number       = (request.form.get('gcash_number') or '').strip()
    gcash_account_name = (request.form.get('gcash_account_name') or '').strip()
    remove_qr          = (request.form.get('remove_qr') or '').strip().lower() == 'true'
    qr_file             = request.files.get('gcash_qr')

    if not gcash_number or not gcash_account_name:
        return jsonify(success=False, error='GCash number and account name are both required.'), 400
    digits_only = gcash_number.replace(' ', '').replace('-', '')
    if not _valid_phone(digits_only):
        return jsonify(success=False, error='Enter a valid GCash number, e.g. 0917 123 4567.'), 400

    settings = _get_gym_settings()
    old_qr_path = settings.gcash_qr_path

    try:
        if qr_file and qr_file.filename:
            settings.gcash_qr_path = _save_content_image(qr_file, existing_path=old_qr_path)
        elif remove_qr:
            settings.gcash_qr_path = None
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400

    # Store in the same spaced format shown to members: 0917 123 4567
    settings.gcash_number       = f"{digits_only[0:4]} {digits_only[4:7]} {digits_only[7:11]}"
    settings.gcash_account_name = gcash_account_name.upper()
    db.session.commit()

    # Best-effort cleanup of the old QR file now that the change is saved.
    # Only ever deletes admin-uploaded files (under uploads/content) —
    # never the bundled default QR asset shipped with the app.
    if old_qr_path and old_qr_path != settings.gcash_qr_path and old_qr_path.startswith('uploads/content/'):
        _delete_content_image(old_qr_path)

    return jsonify(success=True, message='GCash payment details updated.', settings={
        'gcash_number':       settings.gcash_number,
        'gcash_account_name': settings.gcash_account_name,
        'gcash_qr_url':       url_for('static', filename=settings.gcash_qr_path) if settings.gcash_qr_path else None,
    })


@app.route('/admin/delete-gcash-settings', methods=['POST'])
def admin_delete_gcash_settings():
    """Admin-only: clear the GCash number, account name, and QR code shown
    to members on the Payment tab. Members won't see a usable GCash option
    again until the admin re-enters details via Edit."""
    if session.get('role') != 'admin':
        return jsonify(success=False, error='Unauthorized.'), 403

    settings = _get_gym_settings()
    old_qr_path = settings.gcash_qr_path

    settings.gcash_number = None
    settings.gcash_account_name = None
    settings.gcash_qr_path = None
    db.session.commit()

    # Best-effort cleanup of the QR file — only ever deletes admin-uploaded
    # files (under uploads/content), never a bundled default asset.
    if old_qr_path and old_qr_path.startswith('uploads/content/'):
        _delete_content_image(old_qr_path)

    return jsonify(success=True, message='GCash payment details removed.')


@app.route('/admin/update-terms-settings', methods=['POST'])
def admin_update_terms_settings():
    """Admin-only: update the Terms & Policy text shown to new members
    during registration, and how many minutes they must keep the modal
    open (an estimated-reading-time gate) before they're allowed to
    check "I agree". terms_content is always plain text — it's escaped
    and turned into safe HTML at render time, so admins never write
    markup here. Takes effect immediately for the next registration."""
    if session.get('role') != 'admin':
        return jsonify(success=False, error='Unauthorized.'), 403

    data = request.get_json(silent=True) or {}
    terms_content = (data.get('terms_content') or '').strip()
    read_minutes_raw = data.get('terms_read_minutes')

    if not terms_content:
        return jsonify(success=False, error='Terms & Policy content cannot be empty.'), 400
    try:
        read_minutes = int(read_minutes_raw)
    except (TypeError, ValueError):
        return jsonify(success=False, error='Estimated read time must be a whole number of minutes.'), 400
    if read_minutes < 1 or read_minutes > 10:
        return jsonify(success=False, error='Estimated read time must be between 1 and 10 minutes.'), 400

    settings = _get_gym_settings()
    settings.terms_content      = terms_content
    settings.terms_read_seconds = read_minutes * 60
    db.session.commit()

    return jsonify(success=True, message='Terms & Policy updated.', settings={
        'terms_content':      settings.terms_content,
        'terms_read_seconds': settings.terms_read_seconds,
        'terms_read_minutes': read_minutes,
    })


@app.route('/change-password', methods=['POST'])
def change_password():
    if 'user_id' not in session:
        return jsonify(success=False, error='Not logged in.'), 401

    user = User.query.get(session['user_id'])
    if user is None:
        session.clear()
        return jsonify(success=False, error='User not found.'), 404

    data = request.get_json(silent=True) or {}
    current_password = data.get('current_password', '')
    new_password     = data.get('new_password', '')
    confirm_password = data.get('confirm_password', '')

    if not current_password or not new_password or not confirm_password:
        return jsonify(success=False, error='Please fill in all fields.'), 400
    if not check_password_hash(user.password, current_password):
        return jsonify(success=False, error='Current password is incorrect.'), 400
    if len(new_password) < 8:
        return jsonify(success=False, error='New password must be at least 8 characters.'), 400
    if new_password != confirm_password:
        return jsonify(success=False, error='New password and confirmation do not match.'), 400

    user.password = generate_password_hash(new_password)
    db.session.commit()

    return jsonify(success=True, message='Password changed successfully.')


# ── AI Fitness Goal & Recommendation — Step 1 & 2 ──────────────────────
# These two routes only collect and store deterministic member inputs and
# the member's selected goal. No BMI/BMR/TDEE calculation and no AI call
# happens here — those are later stages, intentionally not implemented yet.

@app.route('/member/fitness/save-profile', methods=['POST'])
def member_fitness_save_profile():
    """Step 1 — Member Fitness Information.
    Creates or updates the logged-in member's FitnessProfile (height, sex,
    activity level), and keeps their most recent BodyGoal row's
    current_weight in sync with the submitted weight — creating that row
    the first time, updating it (never inserting a new one) on every
    resubmission. Full historical progress logging (multiple rows over
    time) is a later stage; at this stage a member has at most one row.
    The member is always taken from the session — never from the request
    body — so a member can only ever write their own data."""
    if 'user_id' not in session or session.get('role') != 'member':
        return jsonify(success=False, error='Not logged in.'), 401

    user = User.query.get(session['user_id'])
    if user is None:
        session.clear()
        return jsonify(success=False, error='User not found.'), 404

    # Subscription-expiration guard — reuses _member_plan_active(), the
    # SAME active-membership definition used everywhere else in the app.
    if not _member_plan_active(user):
        _reset_expired_fitness_plan(user)
        return jsonify(success=False, error='Your membership is not active. Please renew your subscription to access the Body Goals & Fitness Plan feature.'), 403

    data = request.get_json(silent=True) or {}
    height_raw = data.get('height_cm')
    weight_raw = data.get('weight_kg')
    sex             = (data.get('sex') or '').strip().lower()
    activity_level  = (data.get('activity_level') or '').strip().lower()

    if height_raw in (None, '') or weight_raw in (None, ''):
        return jsonify(success=False, error='Height and weight are required.'), 400
    try:
        height_cm = float(height_raw)
        weight_kg = float(weight_raw)
    except (TypeError, ValueError):
        return jsonify(success=False, error='Height and weight must be numbers.'), 400

    if not sex or not activity_level:
        return jsonify(success=False, error='Sex and activity level are required.'), 400
    if not _valid_fitness_height(height_cm):
        return jsonify(success=False, error=f'Height must be between {FITNESS_HEIGHT_CM_MIN:.0f} and {FITNESS_HEIGHT_CM_MAX:.0f} cm.'), 400
    if not _valid_fitness_weight(weight_kg):
        return jsonify(success=False, error=f'Weight must be between {FITNESS_WEIGHT_KG_MIN:.0f} and {FITNESS_WEIGHT_KG_MAX:.0f} kg.'), 400
    if sex not in FITNESS_VALID_SEXES:
        return jsonify(success=False, error='Sex must be Male or Female.'), 400
    if activity_level not in FITNESS_VALID_ACTIVITY_LEVELS:
        return jsonify(success=False, error='Please select a valid activity level.'), 400

    profile = FitnessProfile.query.filter_by(member_id=user.id).first()
    if profile is None:
        profile = FitnessProfile(member_id=user.id)
        db.session.add(profile)

    profile.height_cm      = height_cm
    profile.sex             = sex
    profile.activity_level  = activity_level
    # fitness_goal is untouched here — Step 2 owns it.

    # Keep the member's most recent progress row's current_weight in sync
    # with Step 1 — updates the SAME row on every resubmission, never
    # inserts a new one. Full historical progress logging (multiple rows
    # over time, one per real weigh-in) is a later stage, out of scope here.
    latest_body_goal = (
        BodyGoal.query
        .filter_by(member_id=user.id)
        .order_by(BodyGoal.recorded_at.desc(), BodyGoal.id.desc())
        .first()
    )
    if latest_body_goal is None:
        db.session.add(BodyGoal(member_id=user.id, current_weight=weight_kg))
    else:
        latest_body_goal.current_weight = weight_kg

    db.session.commit()

    return jsonify(success=True, message='Information saved.', fitness_profile={
        'height_cm':      float(profile.height_cm),
        'sex':             profile.sex,
        'activity_level':  profile.activity_level,
        'fitness_goal':    profile.fitness_goal,
    })


@app.route('/member/fitness/save-goal', methods=['POST'])
def member_fitness_save_goal():
    """Step 2 — Fitness Goal Selection.
    Requires Step 1 (FitnessProfile) to already exist. Stores the member's
    chosen goal as one of CUT / BULK / MAINTAIN / RECOMP — no goal-history
    table; this is always just the current active goal, same as how the
    rest of the schema tracks a member's current Membership."""
    if 'user_id' not in session or session.get('role') != 'member':
        return jsonify(success=False, error='Not logged in.'), 401

    user = User.query.get(session['user_id'])
    if user is None:
        session.clear()
        return jsonify(success=False, error='User not found.'), 404

    # Subscription-expiration guard — reuses _member_plan_active(), the
    # SAME active-membership definition used everywhere else in the app.
    if not _member_plan_active(user):
        _reset_expired_fitness_plan(user)
        return jsonify(success=False, error='Your membership is not active. Please renew your subscription to access the Body Goals & Fitness Plan feature.'), 403

    data = request.get_json(silent=True) or {}
    goal = (data.get('fitness_goal') or '').strip().upper()

    if goal not in FITNESS_VALID_GOALS:
        return jsonify(success=False, error='Please select a valid fitness goal.'), 400

    profile = FitnessProfile.query.filter_by(member_id=user.id).first()
    if profile is None:
        return jsonify(success=False, error='Please complete Step 1 first.'), 400

    profile.fitness_goal = goal
    db.session.commit()

    return jsonify(success=True, message=f'Your goal is set to {goal}.', fitness_goal=goal)


@app.route('/member/fitness/calculate', methods=['POST'])
def member_fitness_calculate():
    """Stage 3 — deterministic fitness calculations (BMI/BMR/TDEE/calorie
    target/protein target). Pure server-side calculation via
    _calculate_fitness_targets() — no AI involved anywhere in this route.
    Reads the authenticated member's own FitnessProfile, latest BodyGoal
    (for current_weight), and birthday (for age) — never trusts calculation
    inputs from the request body, and never accepts a member_id from the
    client. Writes the results onto that same BodyGoal row (never inserts
    a new one), so recalculating never creates duplicate/corrupt records."""
    if 'user_id' not in session or session.get('role') != 'member':
        return jsonify(success=False, error='Not logged in.'), 401

    user = User.query.get(session['user_id'])
    if user is None:
        session.clear()
        return jsonify(success=False, error='User not found.'), 404

    # Subscription-expiration guard — reuses _member_plan_active(), the
    # SAME active-membership definition used everywhere else in the app.
    if not _member_plan_active(user):
        _reset_expired_fitness_plan(user)
        return jsonify(success=False, error='Your membership is not active. Please renew your subscription to access the Body Goals & Fitness Plan feature.'), 403

    profile = FitnessProfile.query.filter_by(member_id=user.id).first()
    if profile is None or not profile.height_cm or not profile.sex or not profile.activity_level:
        return jsonify(success=False, error='Please complete Step 1 first.'), 400
    if not profile.fitness_goal:
        return jsonify(success=False, error='Please complete Step 2 first.'), 400

    body_goal = (
        BodyGoal.query
        .filter_by(member_id=user.id)
        .order_by(BodyGoal.recorded_at.desc(), BodyGoal.id.desc())
        .first()
    )
    if body_goal is None or not body_goal.current_weight:
        return jsonify(success=False, error='Please complete Step 1 first.'), 400

    age = _calculate_age(user.birthday)
    if age is None:
        return jsonify(success=False, error='Please add your birthday in Profile Settings so we can calculate your targets.'), 400

    results = _calculate_fitness_targets(
        height_cm=float(profile.height_cm),
        weight_kg=float(body_goal.current_weight),
        sex=profile.sex,
        age=age,
        activity_level=profile.activity_level,
        goal=profile.fitness_goal,
    )

    # Write onto the SAME progress row — updates only, never a new insert.
    body_goal.current_bmi      = results['bmi']
    body_goal.bmr              = results['bmr']
    body_goal.tdee             = results['tdee']
    body_goal.calorie_target   = results['calorie_target']
    body_goal.protein_target_g = results['protein_target_g']
    db.session.commit()

    return jsonify(success=True, calculations=results, goal=profile.fitness_goal)


@app.route('/member/fitness/recommendations', methods=['GET'])
def member_fitness_recommendations():
    """Stage 4 — Personalized Fitness Recommendations. Read-only: never
    writes to FitnessProfile or BodyGoal, never creates a new BodyGoal row.
    Uses only the values already calculated by Stage 3 (calorie_target,
    protein_target_g) plus FitnessProfile.fitness_goal/activity_level — no
    formula from Stage 3 is recalculated or duplicated here. Deterministic/
    rule-based only; no AI/external API involved."""
    if 'user_id' not in session or session.get('role') != 'member':
        return jsonify(success=False, error='Not logged in.'), 401

    user = User.query.get(session['user_id'])
    if user is None:
        session.clear()
        return jsonify(success=False, error='User not found.'), 404

    # Subscription-expiration guard — reuses _member_plan_active(), the
    # SAME active-membership definition used everywhere else in the app.
    if not _member_plan_active(user):
        _reset_expired_fitness_plan(user)
        return jsonify(success=False, error='Your membership is not active. Please renew your subscription to access the Body Goals & Fitness Plan feature.'), 403

    profile = FitnessProfile.query.filter_by(member_id=user.id).first()
    if profile is None or not profile.fitness_goal or not profile.activity_level:
        return jsonify(success=False, error='Please complete Steps 1 and 2 first.'), 400

    body_goal = (
        BodyGoal.query
        .filter_by(member_id=user.id)
        .order_by(BodyGoal.recorded_at.desc(), BodyGoal.id.desc())
        .first()
    )
    if body_goal is None or body_goal.calorie_target is None or body_goal.protein_target_g is None:
        return jsonify(success=False, error='Please complete Step 3 first.'), 400

    meal_plan = _recommend_meal_plan(
        calorie_target=body_goal.calorie_target,
        protein_target_g=body_goal.protein_target_g,
    )
    workouts, _flat_exercise_objs = _recommend_workouts(profile.fitness_goal, profile.activity_level)
    weekly_routine, routine_exercise_objs = _recommend_weekly_routine(profile.fitness_goal, profile.activity_level)
    # Equipment reflects exactly what's in the weekly routine the member
    # actually sees now, not the older flat top-N list.
    equipment = _recommend_equipment(routine_exercise_objs)
    tips = _fitness_tips(profile.fitness_goal)

    return jsonify(
        success=True,
        goal=profile.fitness_goal,
        nutrition_targets={
            'calorie_target':   body_goal.calorie_target,
            'protein_target_g': body_goal.protein_target_g,
        },
        meal_plan=meal_plan,
        workouts=workouts,
        weekly_routine=weekly_routine,
        equipment=equipment,
        tips=tips,
    )


@app.route('/member')
def member():
    if 'role' not in session:
        return redirect(url_for('login'))
    if session.get('role') != 'member':
        return redirect(url_for(session.get('role', 'login')))

    user = User.query.get(session['user_id'])
    if user is None:
        session.clear()
        return redirect(url_for('login'))

    picture_can_change, picture_available_at = _profile_picture_cooldown(user)

    today = _today_manila()

    # ── Current plan / membership ──
    membership = Membership.query.filter_by(member_id=user.id).first()
    plan_obj   = membership.plan if membership else None

    current_plan = None
    declined_plan_info = None
    if membership and plan_obj:
        if membership.status == 'declined':
            # A declined request never actually became a real membership —
            # there's no real start/expiry/days-left to report, so it should
            # NOT populate the "Current Plan" panel (that panel is only for
            # plans that are/were actually in effect). Keep just the plan
            # name so the Upgrade/Renew panel can still show its "request
            # was declined" banner; the Current Plan panel itself falls back
            # to its normal "NO ACTIVE PLAN" state.
            #
            # The membership itself only ever tracks the anchor plan a promo
            # request rode on (see /member/submit-payment), not the promo
            # name — so pull the actual declined request's Payment row to
            # show the promo's real name here instead of "Monthly".
            declined_payment_row = (
                Payment.query
                .filter_by(member_id=user.id, status='rejected')
                .order_by(Payment.paid_at.desc())
                .first()
            )
            declined_plan_info = {
                'name': _payment_display_plan(declined_payment_row, plan_obj.name),
                'is_promo': _is_promo_payment(declined_payment_row),
            }
        else:
            # Count down from whichever is later: today, or the membership's
            # own start date. Without this, a membership that hasn't started
            # yet (start_date in the future) shows a "Days Left" figure
            # counted from today — which can end up LONGER than the plan's
            # own duration (e.g. a Monthly plan showing 63 days left).
            # Clamping to the start date keeps Days Left always inside the
            # plan's real length.
            effective_start = max(membership.start_date, today)
            days_total = max((membership.expiry_date - membership.start_date).days, 1)
            days_left  = max((membership.expiry_date - effective_start).days, 0)
            days_used  = max(min(days_total - days_left, days_total), 0)
            percent_used = int((days_used / days_total) * 100) if days_total else 0

            if membership.expiry_date < today:
                plan_status = 'Expired'
            elif membership.status == 'pending':
                plan_status = 'Pending'
            else:
                plan_status = 'Active'

            # ── Payment status — deliberately kept separate from the plan
            #    status above. "Plan Status" describes whether the membership
            #    itself is currently in effect (Active/Pending/Expired).
            #    "Payment Status" describes where the underlying payment sits
            #    in staff/admin's approval pipeline for this member's most
            #    recent request, so a member isn't left guessing why their
            #    plan says "Pending" (e.g. staff already approved the request
            #    — the plan is just waiting on the member to pay). ──
            latest_payment_row = (
                Payment.query
                .filter_by(member_id=user.id)
                .order_by(Payment.paid_at.desc())
                .first()
            )
            payment_status = 'Verified'
            if latest_payment_row is not None:
                if latest_payment_row.status == 'pending':
                    payment_status = 'Pending Staff Approval'
                elif latest_payment_row.status == 'approved' and latest_payment_row.method.startswith('Pending'):
                    payment_status = 'Approved — Awaiting Payment'
                elif latest_payment_row.status == 'approved' and latest_payment_row.method == 'Cash':
                    payment_status = 'Awaiting Staff Verification (Cash)'
                elif latest_payment_row.status == 'approved':
                    payment_status = 'Awaiting Admin Verification (GCash)'
                elif latest_payment_row.status == 'verified':
                    payment_status = 'Verified'
                elif latest_payment_row.status == 'rejected':
                    payment_status = 'Rejected'
                elif latest_payment_row.status == 'cancelled':
                    payment_status = 'Cancelled'

            # Coach info (if any) comes from this member's most recent payment
            # record — the same source used for payment_status above — so the
            # member sees the exact coach that staff/admin set. For a promo
            # plan the coach is bundled into the promo price at no extra
            # charge, so no separate fee is shown; regular plans still show
            # whatever the coach's fee actually was.
            plan_wants_coach = bool(latest_payment_row and latest_payment_row.wants_coach and latest_payment_row.coach_name)
            plan_coach_name  = latest_payment_row.coach_name if plan_wants_coach else None
            plan_is_promo    = bool(latest_payment_row and _is_promo_payment(latest_payment_row))
            plan_coach_fee   = (0.0 if plan_is_promo else _coach_fee(latest_payment_row.coach_name)) if plan_wants_coach else 0.0

            current_plan = {
                'name': plan_obj.name,
                'price': plan_obj.price,
                'start_date': membership.start_date.strftime('%B %d, %Y'),
                'expiry_date': membership.expiry_date.strftime('%B %d, %Y'),
                'days_left': days_left,
                'days_total': days_total,
                'days_used': days_used,
                'percent_used': percent_used,
                'status': plan_status,
                'payment_status': payment_status,
                'wants_coach': plan_wants_coach,
                'coach_name': plan_coach_name,
                'coach_fee': plan_coach_fee,
            }

    # ── Attendance (current month) ──
    current_month_data = _get_member_attendance_month(user.id, today.year, today.month)
    days_in_month   = current_month_data['days_in_month']
    present_days    = current_month_data['present_days']
    no_plan_days    = current_month_data['no_plan_days']
    session_history = current_month_data['session_history']
    today_day       = current_month_data['today_day']

    days_elapsed    = today.day
    attendance_rate = int((len(present_days) / days_elapsed) * 100) if days_elapsed else 0


    # ── Body goals (most recent entry) ──
    goal = (
        BodyGoal.query
        .filter_by(member_id=user.id)
        .order_by(BodyGoal.recorded_at.desc(), BodyGoal.id.desc())
        .first()
    )

    # ── Fitness profile (AI Fitness Goal & Recommendation feature —
    #    Steps 1/2/3 + Stage 4 recommendations) ──
    fitness_profile = FitnessProfile.query.filter_by(member_id=user.id).first()
    member_age = _calculate_age(user.birthday)

    # ── Subscription-expiration reset — Body Goals & Fitness Plan feature.
    # Reuses the exact same active-membership definition as the rest of
    # this route/app (see _member_plan_active) — no second expiration
    # system. If the membership isn't active and the member still has an
    # active Body Goals setup, it's cleared here so they're treated as
    # never having started, and Step 1 shows again. ──
    if not _member_plan_active(user) and _reset_expired_fitness_plan(user):
        fitness_profile = None

    # ── Payment history (this member's own submissions) ──
    # A row that was declined at the *plan request* stage (status='rejected'
    # while the method is still the placeholder "Pending — ...") never had an
    # actual payment attached — the member was never asked to pay, so it
    # doesn't belong in "Past Payments". Only show declined rows here if a
    # real payment method (Cash/GCash) had actually been submitted and later
    # rejected.
    #
    # A row the member cancelled themselves (status='cancelled', via
    # /member/cancel-plan-request) is excluded entirely — the member
    # withdrew the request before it went anywhere, so it should not be
    # recorded in Past Payments at all.
    payment_rows = (
        Payment.query
        .options(joinedload(Payment.plan))
        .filter_by(member_id=user.id)
        .order_by(Payment.paid_at.desc())
        .all()
    )
    payment_history = [{
        'date':      _to_manila(p.paid_at).strftime('%b %d, %Y'),
        'plan':      _payment_display_plan(p),
        'amount':    f'{float(p.amount):,.2f}',
        'method':    p.method,
        'reference': p.reference_number or '—',
        'status':    p.status,
        'is_student': p.is_student,
    } for p in payment_rows
      if not (p.status == 'rejected' and (p.method or '').startswith('Pending'))
      and p.status != 'cancelled']

    # ── Awaiting approval (plan request submitted, staff/admin hasn't
    #    reviewed it yet — no payment can be made until it's approved) ──
    awaiting_approval_row = (
        Payment.query
        .filter_by(member_id=user.id, status='pending')
        .order_by(Payment.paid_at.desc())
        .first()
    )
    awaiting_approval = None
    if awaiting_approval_row is not None:
        awaiting_approval = {
            'id':          awaiting_approval_row.id,
            'plan_name':  _payment_display_plan(awaiting_approval_row),
            'is_promo':   _is_promo_payment(awaiting_approval_row),
            'amount':     f'{float(awaiting_approval_row.amount):,.2f}',
            'start_date': awaiting_approval_row.requested_start_date.strftime('%b %d, %Y') if awaiting_approval_row.requested_start_date else '—',
            'is_student': awaiting_approval_row.is_student,
            # 'Pending'    — submitted, staff hasn't opened the Request tab yet
            # 'Processing' — staff has opened it, decision not made yet
            'request_status': 'Processing' if awaiting_approval_row.staff_viewed else 'Pending',
        }

    # ── Pending payment (plan already approved by staff/admin — drives the
    #    "Submit Payment" panel on the Payment tab) ──
    pending_payment_row = (
        Payment.query
        .filter_by(member_id=user.id, status='approved')
        .order_by(Payment.paid_at.desc())
        .first()
    )
    pending_payment = None
    if pending_payment_row is not None:
        pending_payment = {
            'plan_name':   _payment_display_plan(pending_payment_row),
            'is_promo':    _is_promo_payment(pending_payment_row),
            'amount':      f'{float(pending_payment_row.amount):,.2f}',
            'start_date':  pending_payment_row.requested_start_date.strftime('%b %d, %Y') if pending_payment_row.requested_start_date else '—',
            'needs_method': pending_payment_row.method.startswith('Pending'),
            'method':      pending_payment_row.method,
            'reference':   pending_payment_row.reference_number,
            'is_student':  pending_payment_row.is_student,
            'request_status': 'Approved',
        }

    # ── Just-approved notice (shown once as a "Congratulations! Proceed to
    #    payment" popup) — fires when staff/admin approves the PLAN, which
    #    is the point at which the member is actually allowed to pay. ──
    just_approved_row = (
        Payment.query
        .filter_by(member_id=user.id, status='approved', notified=False)
        .order_by(Payment.paid_at.desc())
        .first()
    )
    plan_approved_notice = None
    if just_approved_row is not None:
        plan_approved_notice = {
            'plan_name': _payment_display_plan(just_approved_row, 'membership'),
            'is_promo': _is_promo_payment(just_approved_row),
        }
        just_approved_row.notified = True
        db.session.commit()

    # ── Just-verified notice (shown once as a "Congratulations! Payment
    #    approved" popup with the membership start date) — fires when admin
    #    approves the actual PAYMENT (Cash/GCash, or a front-desk payment
    #    recorded directly by staff), which is the point the membership
    #    actually activates. ──
    just_verified_row = (
        Payment.query
        .filter_by(member_id=user.id, status='verified', notified=False)
        .order_by(Payment.paid_at.desc())
        .first()
    )
    payment_verified_notice = None
    if just_verified_row is not None:
        start_date_text = (
            membership.start_date.strftime('%B %d, %Y')
            if membership and membership.start_date
            else (just_verified_row.requested_start_date.strftime('%B %d, %Y')
                  if just_verified_row.requested_start_date else today.strftime('%B %d, %Y'))
        )
        payment_verified_notice = {
            'plan_name':  _payment_display_plan(just_verified_row, 'membership'),
            'is_promo':   _is_promo_payment(just_verified_row),
            'start_date': start_date_text,
        }
        just_verified_row.notified = True
        db.session.commit()

    # ── Just-declined notice (shown once as a "Your request was declined"
    #    popup) — fires when staff/admin rejects either the plan request or
    #    the payment itself, at whichever stage it happened. ──
    just_declined_row = (
        Payment.query
        .filter_by(member_id=user.id, status='rejected', notified=False)
        .order_by(Payment.paid_at.desc())
        .first()
    )
    plan_declined_notice = None
    if just_declined_row is not None:
        plan_declined_notice = {
            'plan_name': _payment_display_plan(just_declined_row, 'membership'),
            'is_promo': _is_promo_payment(just_declined_row),
        }
        just_declined_row.notified = True
        db.session.commit()

    # Members without a paid, active membership only get Overview + My
    # Membership — everything else (attendance history, goals, services) is
    # locked behind an active plan.
    plan_active = bool(current_plan and current_plan['status'] == 'Active')

    # ── Announcements — filtered per member by the admin's chosen target
    #    audience: everyone, active members only, or members expiring
    #    within 30 days of their current plan. ──
    member_days_left = current_plan['days_left'] if current_plan else None
    announcements = [
        a for a in Announcement.query.filter_by(is_active=True).order_by(Announcement.created_at.desc()).all()
        if a.target == 'all'
        or (a.target == 'active' and plan_active)
        or (a.target == 'expiring' and plan_active and member_days_left is not None and member_days_left <= 30)
    ]

    # Announcements posted since this member's last visit pop up as a
    # "Notice from the Admin" message box on this page load, so a new
    # notice doesn't go unnoticed — mirrors the pattern used for
    # plan_approved_notice etc.
    last_seen = user.last_seen_announcements_at
    new_announcements = [
        {'title': a.title, 'body': a.body, 'sender': _notif_sender_label(a.posted_by, fallback='Admin')}
        for a in announcements
        if last_seen is None or (a.created_at and a.created_at > last_seen)
    ]
    user.last_seen_announcements_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.session.commit()

    # Membership expiry reminders queued by staff (Send Reminder button) pop
    # up once, as a "message bot" popup, the next time this member loads
    # their dashboard — then get marked delivered so they never show twice.
    pending_reminders = (
        MembershipReminder.query
        .filter_by(member_id=user.id, delivered_at=None)
        .order_by(MembershipReminder.created_at.asc())
        .all()
    )
    bot_reminders = [r.message for r in pending_reminders]
    if pending_reminders:
        _now = datetime.now(timezone.utc).replace(tzinfo=None)
        for r in pending_reminders:
            r.delivered_at = _now
        db.session.commit()

    # ── Notification bell — a persistent, revisitable history combining
    #    admin announcements and the Gym Bot's expiry reminders, so a
    #    member can check them any time instead of only catching the
    #    one-time popups above.
    #
    #    Unread state is keyed off last_seen_notifications_at, which only
    #    advances when the member actually OPENS the bell (see
    #    /member/notifications/mark-seen) — not just on every page load.
    #    That's what makes "seen once, don't renotify until something
    #    new" hold up across logins: a notice a member never actually
    #    opened stays flagged unread the next time they log in, while one
    #    they did open won't come back just because they revisited. ──
    last_seen_notif = user.last_seen_notifications_at
    reminder_history = (
        MembershipReminder.query
        .filter_by(member_id=user.id)
        .order_by(MembershipReminder.created_at.desc())
        .limit(20)
        .all()
    )
    notification_center = sorted(
        [
            {
                'type': 'announcement',
                'icon': '📢',
                'title': 'Notice',       # generic label shown in the bell list
                'subject': a.title,      # the admin's actual announcement title — shown in the popup
                'body': a.body,
                'sender': _notif_sender_label(a.posted_by, fallback='Admin'),
                'date_sort': a.created_at,
                'date': _to_manila(a.created_at).strftime('%b %d, %Y · %I:%M %p') if a.created_at else '',
            } for a in announcements[:20]
        ] + [
            {
                'type': 'reminder',
                'icon': '🔔',
                'title': 'Membership Reminder',
                'body': r.message,
                'sender': _notif_sender_label(r.sent_by, fallback='Automated System'),
                'date_sort': r.created_at,
                'date': _to_manila(r.created_at).strftime('%b %d, %Y · %I:%M %p') if r.created_at else '',
            } for r in reminder_history
        ],
        key=lambda item: item['date_sort'] or datetime.min,
        reverse=True,
    )
    notification_unread_count = 0
    for item in notification_center:
        is_new = bool(item['date_sort'] and (last_seen_notif is None or item['date_sort'] > last_seen_notif))
        item['is_new'] = is_new
        if is_new:
            notification_unread_count += 1
        del item['date_sort']  # not JSON-safe, only used for sorting/unread checks above

    # ── Public-facing content (membership plans / services / equipment) ──
    # Sourced from the same admin/staff-editable tables that drive the home
    # page, so anything they change in Settings → Manage Content shows up
    # here too instead of being hardcoded per-page.
    # "Daily" is excluded from the member's own plan picker — it's a
    # walk-in-only day pass (recorded by staff from the Walk In tab, never
    # a member's own membership). Half Month, Monthly, and Yearly are meant
    # to be chosen as a member's plan.
    content_plans = [
        p for p in MembershipPlan.query.filter_by(is_active=True).order_by(MembershipPlan.sort_order, MembershipPlan.id).all()
        if p.name != 'Daily'
    ]
    content_services  = GymService.query.filter_by(is_active=True).order_by(GymService.sort_order, GymService.id).all()
    content_equipment = GymEquipment.query.filter_by(is_active=True).order_by(GymEquipment.sort_order, GymEquipment.id).all()
    content_promos    = GymPromo.query.filter_by(is_active=True).order_by(GymPromo.sort_order, GymPromo.id).all()

    # Equipment grouped by category for the "Gym Machines and Equipment"
    # display — each group is (category_name, category_icon, [items]),
    # preserving sort_order within the category and category first-seen
    # order overall. Services are shown as a flat grid (each service acts
    # as its own "category" card, e.g. "Boxing" / "Strengthening"), so no
    # grouping is needed for them. Facility-zone photos (is_facility=True,
    # e.g. "Weight Area", "Reception") are shown on the home page's "Our
    # Facilities" section but are not real individual machines, so they're
    # left out of this member-facing equipment list.
    real_equipment = [e for e in content_equipment if not e.is_facility]
    equipment_by_category = _group_content_by_category(real_equipment, default_icon=DEFAULT_EQUIPMENT_ICON)
    services_by_category  = _group_content_by_category(content_services, default_icon=DEFAULT_SERVICE_ICON)

    # ── Coaches (for the "Choose a Coach" field on the plan request form) —
    #    shows each coach's available days and remaining slots so members
    #    can pick one that's actually open. The one with the most open
    #    slots is flagged as "recommended" so a member who doesn't have a
    #    preference isn't stuck staring at an empty dropdown. ──
    coaches_data = [c for c in _get_coaches_data() if c['is_active']]
    _available_coaches = [c for c in coaches_data if not c['is_full']]
    recommended_coach_name = (
        max(_available_coaches, key=lambda c: c['slots_left'])['name']
        if _available_coaches else None
    )

    plans_data = [{
        'key':            p.name.lower(),
        'name':           p.name,
        'price':          p.price,
        'student_price':  STUDENT_PLAN_PRICES.get(p.name, p.price),
        'duration_days':  p.duration_days,
        'description':    p.description or '',
        'inclusions':     p.inclusions_list,
        'image_path':     url_for('static', filename=p.image_path) if p.image_path else '',
    } for p in content_plans]

    # Real, admin/staff-managed promos (Manage Content → Promos) — replaces
    # what used to be a hardcoded pair of promo cards baked into the
    # template. Empty list here just means "no active promos right now",
    # which the template already renders as a normal empty state.
    promos_data = [{
        'id':          p.id,
        'title':       p.title,
        'price':       p.price,
        'period':      p.period or 'Limited-time offer',
        'description': p.description or '',
        'inclusions':  p.inclusions_list,
        'valid_until': p.valid_until.strftime('%B %d, %Y') if p.valid_until else '',
        'image_path':  url_for('static', filename=p.image_path) if p.image_path else '',
    } for p in content_promos]

    services_data = [{
        'id':          s.id,
        'name':        s.name,
        'description': s.description or '',
        'image_path':  url_for('static', filename=s.image_path) if s.image_path else '',
        'category':    s.category or DEFAULT_CATEGORY,
        'icon':        s.icon or DEFAULT_SERVICE_ICON,
        'equipment':   [{'name': e.name, 'icon': e.icon or DEFAULT_EQUIPMENT_ICON} for e in s.equipment],
    } for s in content_services]

    # Flat lookup data for the "Gym Machines and Equipment" guide modal —
    # lets a member click a machine and see the how-to-use photo the
    # admin/staff uploaded for it (via Manage Content > Equipments and
    # Machines), plus its description. Facility-zone photos are excluded
    # since they're not individual machines (see real_equipment above).
    equipment_data = [{
        'id':          e.id,
        'name':        e.name,
        'description': e.description or '',
        'image_path':  url_for('static', filename=e.image_path) if e.image_path else '',
        'category':    e.category or DEFAULT_CATEGORY,
        'icon':        e.icon or DEFAULT_EQUIPMENT_ICON,
    } for e in real_equipment]

    return render_template(
        'member-dashboard.html',
        member=user,
        plan=current_plan,
        declined_plan=declined_plan_info,
        plan_active=plan_active,
        content_plans=content_plans,
        content_services=content_services,
        content_equipment=content_equipment,
        equipment_by_category=equipment_by_category,
        services_by_category=services_by_category,
        plans_data=plans_data,
        promos=promos_data,
        services_data=services_data,
        equipment_data=equipment_data,
        coaches=coaches_data,
        recommended_coach_name=recommended_coach_name,
        present_days=present_days,
        no_plan_days=no_plan_days,
        days_in_month=days_in_month,
        today_day=today_day,
        month_label=today.strftime('%B %Y'),
        attendance_year=today.year,
        attendance_month=today.month,
        session_history=session_history,
        attendance_rate=attendance_rate,
        goal=goal,
        fitness_profile=fitness_profile,
        member_age=member_age,
        payment_history=payment_history,
        awaiting_approval=awaiting_approval,
        pending_payment=pending_payment,
        plan_approved_notice=plan_approved_notice,
        payment_verified_notice=payment_verified_notice,
        plan_declined_notice=plan_declined_notice,
        announcements=announcements,
        new_announcements=new_announcements,
        bot_reminders=bot_reminders,
        notification_center=notification_center,
        notification_unread_count=notification_unread_count,
        gcash_settings=_get_gym_settings(),
        picture_can_change=picture_can_change,
        picture_available_at=picture_available_at.strftime('%B %d, %Y') if picture_available_at else None,
    )


@app.route('/member/notifications/mark-seen', methods=['POST'])
def member_notifications_mark_seen():
    """Called the moment a member actually opens the notification bell
    panel (not on every page load) — advances last_seen_notifications_at
    so those items stop counting as unread on future visits, while
    anything posted after this moment still shows up as new."""
    if 'user_id' not in session or session.get('role') != 'member':
        return jsonify(success=False, error='Not logged in.'), 401

    user = User.query.get(session['user_id'])
    if user is None:
        session.clear()
        return jsonify(success=False, error='User not found.'), 404

    user.last_seen_notifications_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.session.commit()
    return jsonify(success=True)


def _get_attendance_calendar():
    """Gym-wide attendance for the current month (which days had at least one
    check-in). Used to drive the Admin dashboard's attendance grid."""
    today = _today_manila()
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    month_start_dt, _ = _manila_day_bounds_utc(today.replace(day=1))

    attendance_rows = (
        Attendance.query
        .filter(Attendance.check_in >= month_start_dt)
        .all()
    )
    present_days = sorted({_to_manila(a.check_in).day for a in attendance_rows})

    return {
        'present_days': present_days,
        'days_in_month': days_in_month,
        'today_day': today.day,
        'month_label': today.strftime('%B %Y'),
    }


def _get_attendance_today():
    """Return today's attendance rows (member name, check-in/out, duration, status),
    newest first. Shared by the Staff dashboard and Admin's Attendance tab so both
    show the exact same live data instead of drifting out of sync."""
    today = _today_manila()
    today_start, today_end = _manila_day_bounds_utc(today)

    rows = (
        Attendance.query
        .options(joinedload(Attendance.member))
        .filter(Attendance.check_in >= today_start, Attendance.check_in <= today_end)
        .order_by(Attendance.check_in.desc())
        .all()
    )

    attendance_today = []
    for a in rows:
        duration_text = '—'
        if a.check_out:
            mins = a.duration_min if a.duration_min is not None else int((a.check_out - a.check_in).total_seconds() // 60)
            h, m = divmod(mins, 60)
            duration_text = f'{h}h {m}m' if h else f'{m}m'
        check_in_manila  = _to_manila(a.check_in)
        check_out_manila = _to_manila(a.check_out)
        attendance_today.append({
            'member_name': a.member.full_name,
            'check_in': check_in_manila.strftime('%I:%M %p').lstrip('0'),
            'check_out': check_out_manila.strftime('%I:%M %p').lstrip('0') if check_out_manila else '—',
            'duration': duration_text,
            'status': 'Out' if a.check_out else 'In',
        })
    return attendance_today


def _count_checkins_today():
    """Number of distinct MEMBERS who checked in today, for the
    'Check-ins Today' stat card. If a member checks in, checks out, and
    checks in again the same day, that's still just one person — counted
    once here, even though each visit still shows up as its own row in the
    Recent Check-ins table."""
    today = _today_manila()
    today_start, today_end = _manila_day_bounds_utc(today)
    return (
        db.session.query(Attendance.member_id)
        .filter(Attendance.check_in >= today_start, Attendance.check_in <= today_end)
        .distinct()
        .count()
    )


def _get_members_checkin_status():
    """Members who have a membership plan, with today's check-in status, times,
    and duration — powers the staff Check-in/Out table (one row per member)."""
    today = _today_manila()
    today_start, today_end = _manila_day_bounds_utc(today)

    members = [m for m in _get_members_with_plans() if m['plan'] != '—']
    member_ids = [m['id'] for m in members]

    # Single batched query for everyone's attendance today, instead of one
    # query per member (which used to mean N extra round-trips for N members
    # on every dashboard load — the main reason the staff dashboard felt slow).
    todays_entries_by_member = {}
    if member_ids:
        todays_rows = (
            Attendance.query
            .filter(
                Attendance.member_id.in_(member_ids),
                Attendance.check_in >= today_start,
                Attendance.check_in <= today_end,
            )
            .order_by(Attendance.check_in.desc())
            .all()
        )
        for a in todays_rows:
            todays_entries_by_member.setdefault(a.member_id, []).append(a)

    result = []
    for m in members:
        entries     = todays_entries_by_member.get(m['id'], [])
        latest      = entries[0] if entries else None
        open_entry  = next((e for e in entries if e.check_out is None), None)

        if open_entry is not None:
            checkin_status = 'in'
        elif latest is not None:
            checkin_status = 'out'
        else:
            checkin_status = 'none'

        latest_check_in_manila  = _to_manila(latest.check_in) if latest else None
        latest_check_out_manila = _to_manila(latest.check_out) if latest and latest.check_out else None

        check_in_text  = latest_check_in_manila.strftime('%I:%M %p').lstrip('0') if latest_check_in_manila else '—'
        check_out_text = latest_check_out_manila.strftime('%I:%M %p').lstrip('0') if latest_check_out_manila else '—'

        duration_text = '—'
        if latest and latest.check_out:
            mins = latest.duration_min if latest.duration_min is not None else int((latest.check_out - latest.check_in).total_seconds() // 60)
            h, mnt = divmod(mins, 60)
            duration_text = f'{h}h {mnt}m' if h else f'{mnt}m'
        elif open_entry is not None:
            duration_text = 'Ongoing'

        # check_in is stored as a naive UTC datetime; append 'Z' so the browser
        # parses it as UTC and converts to the staff member's local clock.
        check_in_iso = (open_entry.check_in.isoformat() + 'Z') if open_entry is not None else None

        result.append({
            'id': m['id'],
            'name': m['name'],
            'email': m['email'],
            'plan': m['plan'],
            'plan_status': m['status'],
            'checkin_status': checkin_status,   # 'in' | 'out' | 'none'
            'check_in': check_in_text,
            'check_out': check_out_text,
            'duration': duration_text,
            'check_in_iso': check_in_iso,
        })
    return result


@app.route('/staff')
def staff():
    if 'role' not in session:
        return redirect(url_for('login'))
    if session.get('role') != 'staff':
        return redirect(url_for(session.get('role', 'login')))

    today = _today_manila()
    attendance_today = _get_attendance_today()

    # "No Plan" and "Declined" members aren't relevant to staff's day-to-day
    # (check-in, payment verification, coaching) — the Member Directory only
    # needs to show members who actually have a plan in effect.
    members = [m for m in _get_members_with_plans() if m['status'] not in ('No Plan', 'Declined')]
    active_members       = [m for m in members if m['status'] == 'Active']
    pending_status_members = [m for m in members if m['status'] == 'Pending']
    expiring_soon    = [
        m for m in members
        if m['status'] == 'Active' and m['expiry_date'] and 0 <= (m['expiry_date'] - today).days <= 7
    ]

    # ── Pending plan requests & payments (Request tab). Staff approves the
    #    plan request itself and confirms Cash payments; GCash payments are
    #    verified by admin and shown here for visibility only. ──
    pending_requests_rows = (
        Payment.query
        .options(joinedload(Payment.member), joinedload(Payment.plan))
        .filter(Payment.status.in_(['pending', 'approved']))
        .order_by(Payment.paid_at.desc())
        .all()
    )

    # ── The member-facing "Processing" status fires the moment staff actually
    #    sees a plan request — which is right here, as it's loaded into this
    #    dashboard. Flip the flag for any new-request card that hasn't been
    #    seen yet. ──
    _newly_viewed = False
    for p in pending_requests_rows:
        if p.status == 'pending' and not p.staff_viewed:
            p.staff_viewed = True
            _newly_viewed = True
    if _newly_viewed:
        db.session.commit()

    pending_requests = [{
        'id': p.id,
        'txn': f'TXN-{9000 + p.id}',
        'member_name': p.member.full_name,
        'member_profile_picture': url_for('static', filename=p.member.profile_picture) if p.member.profile_picture else None,
        'plan': _payment_display_plan(p),
        'is_promo': bool(p.notes and p.notes.startswith('Promo request:')),
        'method': p.method,
        'reference': p.reference_number or '—',
        'amount': f'{float(p.amount):,.2f}',
        'proof_image_path': p.proof_image_path,
        'is_student': p.is_student,
        'student_id_image_path': p.student_id_image_path,
        'wants_coach': p.wants_coach,
        'coach_name': p.coach_name,
        'stage': _payment_stage(p),
        'staff_viewed': p.staff_viewed,
    } for p in pending_requests_rows]


    # ── Recently processed requests — approved only. A declined request just
    #    disappears from view here; it only reappears once the member submits
    #    a new request and that one gets approved. (Admin's Payment History
    #    tab still keeps the full approved+declined audit trail.) ──
    processed_requests_rows = (
        Payment.query
        .options(joinedload(Payment.member), joinedload(Payment.plan))
        .filter(Payment.status == 'verified')
        .order_by(Payment.paid_at.desc())
        .limit(20)
        .all()
    )
    processed_requests = [{
        'txn': f'TXN-{9000 + p.id}',
        'member_name': p.member.full_name,
        'plan': _payment_display_plan(p),
        'method': p.method,
        'amount': f'{float(p.amount):,.2f}',
        'date': p.paid_at.strftime('%b %d, %Y'),
        'status': p.status,
    } for p in processed_requests_rows]

    # ── Coach assignments (Coach tab) — every payment where a coach was
    #    requested, newest first ──
    coach_rows = (
        Payment.query
        .options(joinedload(Payment.member), joinedload(Payment.plan))
        .filter(Payment.wants_coach.is_(True))
        .order_by(Payment.paid_at.desc())
        .all()
    )
    coach_assignments = [{
        'member_name': p.member.full_name,
        'coach_name': p.coach_name or '—',
        'plan': _payment_display_plan(p),
        'status': p.status,
        'date': p.paid_at.strftime('%b %d, %Y'),
    } for p in coach_rows]

    coaches_data = _get_coaches_data()

    # ── Walk In tab: the coach with the most open slots is flagged as
    #    "recommended", same hint shown to members on the promo plan-request
    #    form, so staff aren't stuck guessing who to assign a guest to. ──
    _walkin_available_coaches = [c for c in coaches_data if c['is_active'] and not c['is_full']]
    recommended_coach_name = (
        max(_walkin_available_coaches, key=lambda c: c['slots_left'])['name']
        if _walkin_available_coaches else None
    )

    # ── Walk In tab: the Daily plan's current price/duration, plus the
    #    list of walk-ins recorded today (most recent first) ──
    daily_plan = MembershipPlan.query.filter_by(name='Daily').first()
    _walkin_day_start, _walkin_day_end = _manila_day_bounds_utc(today)
    walkins_today_rows = (
        WalkIn.query
        .filter(WalkIn.created_at >= _walkin_day_start, WalkIn.created_at <= _walkin_day_end)
        .order_by(WalkIn.created_at.desc())
        .all()
    )
    walkins_today = [{
        'name': w.full_name,
        'phone': w.phone or '—',
        'plan': w.plan_type,
        'amount': f'{float(w.amount):,.2f}',
        'method': w.method,
        'coach': w.coach_name if w.wants_coach else '—',
        'time': _to_manila(w.created_at).strftime('%I:%M %p').lstrip('0'),
    } for w in walkins_today_rows]
    walkin_total_today = sum(float(w.amount) for w in walkins_today_rows)

    stats = {
        'checkins_today':   _count_checkins_today(),
        'active_members':   len(active_members),
        'pending_payments': len(pending_requests),
        'expiring_soon':    len(expiring_soon),
    }

    # ── Analytics tab: default to "This Month" on first load; the report
    #    generation buttons let staff pick a different range and download
    #    a CSV without needing a page reload. ──
    analytics_start, analytics_end, analytics_range_label = _report_range('this_month')
    analytics = {
        'range_label': analytics_range_label,
        'revenue':     _revenue_report(analytics_start, analytics_end),
        'membership':  _membership_report(),
        'attendance':  _attendance_report(analytics_start, analytics_end),
    }

    # ── Lightweight member list for the Payment Record autocomplete/dropdown.
    #    Keyed by email (unique + always accepted by _find_member), with the
    #    member's current plan so the UI can auto-select the matching Plan
    #    option once a member is chosen. JSON-safe (no date objects). ──
    payment_members = [{
        'id': m['id'],
        'name': m['name'],
        'email': m['email'],
        'plan': m['plan'],
        'status': m['status'],
    } for m in members]

    # Staff only need to see notices actually meant for them — the member-
    # facing "All Members" / "Active Members Only" / "Expiring This Month"
    # announcements belong on the member dashboard, not here.
    announcements = Announcement.query.filter_by(is_active=True, target='staff').order_by(Announcement.created_at.desc()).all()

    # New-since-last-visit announcements pop up as a "Notice from the
    # Admin" message box, same as members.
    staff_user = User.query.get(session['user_id'])
    last_seen = staff_user.last_seen_announcements_at
    new_announcements = [
        {'title': a.title, 'body': a.body} for a in announcements
        if last_seen is None or (a.created_at and a.created_at > last_seen)
    ]
    staff_user.last_seen_announcements_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.session.commit()

    # ── Notification bell — same pattern as the member dashboard: a
    #    persistent, revisitable list of admin announcements so staff can
    #    check them any time instead of only catching a one-time popup.
    #    Unread state is keyed off last_seen_notifications_at, which only
    #    advances when staff actually open the bell (see
    #    /staff/notifications/mark-seen) — not just on every page load. ──
    last_seen_notif = staff_user.last_seen_notifications_at
    notification_center = [
        {
            'type': 'announcement',
            'icon': '📢',
            'title': 'Notice',
            'subject': a.title,
            'body': a.body,
            'sender': _notif_sender_label(a.posted_by, fallback='Admin'),
            'date_sort': a.created_at,
            'date': _to_manila(a.created_at).strftime('%b %d, %Y · %I:%M %p') if a.created_at else '',
        } for a in announcements[:20]
    ]
    notification_unread_count = 0
    for item in notification_center:
        is_new = bool(item['date_sort'] and (last_seen_notif is None or item['date_sort'] > last_seen_notif))
        item['is_new'] = is_new
        if is_new:
            notification_unread_count += 1
        del item['date_sort']

    picture_can_change, picture_available_at = _profile_picture_cooldown(staff_user)

    return render_template(
        'staff-dashboard.html',
        attendance_today=attendance_today,
        members=members,
        members_checkin=_get_members_checkin_status(),
        expiring_soon=expiring_soon,
        stats=stats,
        pending_requests=pending_requests,
        processed_requests=processed_requests,
        coach_assignments=coach_assignments,
        coaches=coaches_data,
        recommended_coach_name=recommended_coach_name,
        coach_days=VALID_COACH_DAYS,
        daily_plan=daily_plan,
        walkins_today=walkins_today,
        walkin_total_today=f'{walkin_total_today:,.2f}',
        WALKIN_COACH_FEE=WALKIN_COACH_FEE,
        WALKIN_BOXING_FEE=WALKIN_BOXING_FEE,
        payment_members=payment_members,
        analytics=analytics,
        report_ranges=REPORT_RANGES,
        announcements=announcements,
        new_announcements=new_announcements,
        notification_center=notification_center,
        notification_unread_count=notification_unread_count,
        current_user=staff_user,
        picture_can_change=picture_can_change,
        picture_available_at=picture_available_at.strftime('%B %d, %Y') if picture_available_at else None,
    )


@app.route('/staff/notifications/mark-seen', methods=['POST'])
def staff_notifications_mark_seen():
    """Called the moment staff actually open the notification bell panel
    (not on every page load) — advances last_seen_notifications_at so
    those items stop counting as unread on future visits, while anything
    posted after this moment still shows up as new."""
    if 'user_id' not in session or session.get('role') != 'staff':
        return jsonify(success=False, error='Not logged in.'), 401

    staff_user = User.query.get(session['user_id'])
    if staff_user is None:
        session.clear()
        return jsonify(success=False, error='User not found.'), 404

    staff_user.last_seen_notifications_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.session.commit()
    return jsonify(success=True)


def _format_currency_short(amount):
    """Compact currency for tight stat-card display, e.g. 86000 -> '86K',
    1250000 -> '1.3M', 950 -> '950'. Full precision is still available
    elsewhere (Analytics tab, CSV exports)."""
    amount = float(amount)
    if abs(amount) >= 1_000_000:
        return f'{amount / 1_000_000:.1f}'.rstrip('0').rstrip('.') + 'M'
    if abs(amount) >= 1_000:
        return f'{amount / 1_000:.1f}'.rstrip('0').rstrip('.') + 'K'
    return f'{amount:,.0f}'


REPORT_RANGES = {
    'today':      'Today',
    'this_month': 'This Month',
    'last_30':    'Last 30 Days',
    'this_year':  'This Year',
    'all_time':   'All Time',
}


def _report_range(range_key):
    """Resolve a report range key into a (start_date, end_date, label) tuple.
    end_date is always today; start_date is None for 'all_time' (no lower bound)."""
    today = _today_manila()
    if range_key == 'today':
        return today, today, REPORT_RANGES['today']
    if range_key == 'last_30':
        return today - timedelta(days=29), today, REPORT_RANGES['last_30']
    if range_key == 'this_year':
        return date(today.year, 1, 1), today, REPORT_RANGES['this_year']
    if range_key == 'all_time':
        return None, today, REPORT_RANGES['all_time']
    return date(today.year, today.month, 1), today, REPORT_RANGES['this_month']


def _resolve_report_window(range_key, from_str=None, to_str=None):
    """Like _report_range, but a valid custom 'from'/'to' pair (YYYY-MM-DD,
    e.g. from a <input type=date> calendar picker) always takes priority over
    the preset range dropdown."""
    if from_str and to_str:
        try:
            start_date = datetime.strptime(from_str, '%Y-%m-%d').date()
            end_date   = datetime.strptime(to_str, '%Y-%m-%d').date()
        except ValueError:
            start_date = end_date = None
        if start_date and end_date:
            if start_date > end_date:
                start_date, end_date = end_date, start_date
            label = f"{start_date.strftime('%b %d, %Y')} \u2013 {end_date.strftime('%b %d, %Y')}"
            return start_date, end_date, label
    return _report_range(range_key)


def _bucket_counts(rows, get_date, start_date, end_date):
    """Bucket rows into a chart-friendly time series across [start_date, end_date].
    Buckets by day when the span is <=31 days (typical for a focused date-range
    lookup), otherwise by month (so a 'This Year' / 'All Time' / long custom
    range still renders a readable handful of bars instead of hundreds)."""
    if start_date is None:
        dates = [get_date(r) for r in rows]
        if not dates:
            return []
        start_date = min(dates)
    if end_date is None:
        end_date = _today_manila()
    if start_date > end_date:
        return []

    span_days = (end_date - start_date).days + 1

    if span_days <= 31:
        buckets = OrderedDict()
        d = start_date
        while d <= end_date:
            buckets[d] = 0
            d += timedelta(days=1)
        for r in rows:
            d = get_date(r)
            if d in buckets:
                buckets[d] += 1
        return [{'label': d.strftime('%b %d'), 'value': v} for d, v in buckets.items()]

    buckets = OrderedDict()
    d = date(start_date.year, start_date.month, 1)
    end_marker = date(end_date.year, end_date.month, 1)
    while d <= end_marker:
        buckets[(d.year, d.month)] = 0
        d = date(d.year + 1, 1, 1) if d.month == 12 else date(d.year, d.month + 1, 1)
    for r in rows:
        rd = get_date(r)
        key = (rd.year, rd.month)
        if key in buckets:
            buckets[key] += 1
    return [{'label': date(y, m, 1).strftime('%b %Y'), 'value': v} for (y, m), v in buckets.items()]


def _revenue_report(start_date, end_date, method=None):
    """Verified payments AND front-desk walk-ins within range: totals, a
    breakdown per plan, a breakdown by payment method (Cash vs GCash —
    every payment verified by staff or admin lands here automatically, no
    manual entry needed), and a breakdown of Cash collected by the staff
    member who recorded it (so front-desk cash — membership payments and
    walk-ins alike — is visible at a glance).
    Pass method='Cash' to restrict the whole report to Cash payments only
    (used by the staff dashboard, which shouldn't see GCash figures). Since
    walk-ins are always paid in Cash, they're included whenever Cash is
    included and skipped entirely when the report is restricted to GCash."""
    q = Payment.query.options(
        joinedload(Payment.member), joinedload(Payment.plan), joinedload(Payment.recorded_by)
    ).filter(Payment.status == 'verified')
    if method is not None:
        q = q.filter(Payment.method == method)
    if start_date is not None:
        q = q.filter(Payment.paid_at >= datetime.combine(start_date, datetime.min.time()))
    q = q.filter(Payment.paid_at < datetime.combine(end_date + timedelta(days=1), datetime.min.time()))
    rows = q.order_by(Payment.paid_at.desc()).all()

    # Walk-ins are one-off guest visits paid in Cash on the spot (see the
    # WalkIn model) — they never create a Payment row, so without this they
    # were silently missing from every revenue figure/report. Filtered over
    # the same date window, and only included when the report isn't
    # restricted to a non-Cash method (e.g. method='GCash').
    if method is None or method == 'Cash':
        wq = WalkIn.query.options(joinedload(WalkIn.recorded_by))
        if start_date is not None:
            wq = wq.filter(WalkIn.created_at >= datetime.combine(start_date, datetime.min.time()))
        wq = wq.filter(WalkIn.created_at < datetime.combine(end_date + timedelta(days=1), datetime.min.time()))
        walkin_rows = wq.order_by(WalkIn.created_at.desc()).all()
    else:
        walkin_rows = []

    total = float(sum((r.amount for r in rows), start=0))
    walkin_total = float(sum((w.amount for w in walkin_rows), start=0))
    total += walkin_total

    by_plan = {}
    for r in rows:
        plan_name = _payment_display_plan(r, 'Unknown')
        by_plan[plan_name] = by_plan.get(plan_name, 0) + float(r.amount)
    for w in walkin_rows:
        label = f'Walk-In ({w.plan_type})'
        by_plan[label] = by_plan.get(label, 0) + float(w.amount)

    # Every verified payment — Cash (staff-recorded) or GCash (admin-verified) —
    # is tallied here automatically straight from the Payment table. Walk-ins
    # are folded into their (always 'Cash') method bucket alongside them.
    by_method = {}
    for r in rows:
        by_method[r.method] = by_method.get(r.method, 0) + float(r.amount)
    for w in walkin_rows:
        by_method[w.method] = by_method.get(w.method, 0) + float(w.amount)

    # Cash collected, grouped by the staff member who recorded it —
    # membership payments and walk-ins both count, since both are physical
    # cash a staff member took in at the front desk.
    cash_by_staff = {}
    cash_total = 0.0
    for r in rows:
        if r.method != 'Cash':
            continue
        cash_total += float(r.amount)
        staff_name = r.recorded_by.full_name if r.recorded_by else 'Unrecorded / Unknown'
        entry = cash_by_staff.setdefault(staff_name, {'total': 0.0, 'count': 0})
        entry['total'] += float(r.amount)
        entry['count'] += 1
    for w in walkin_rows:
        if w.method != 'Cash':
            continue
        cash_total += float(w.amount)
        staff_name = w.recorded_by.full_name if w.recorded_by else 'Unrecorded / Unknown'
        entry = cash_by_staff.setdefault(staff_name, {'total': 0.0, 'count': 0})
        entry['total'] += float(w.amount)
        entry['count'] += 1

    gcash_total = by_method.get('GCash', 0.0)

    # Unified, display-ready transaction list — membership payments and
    # walk-ins merged together and sorted newest-first — so reports/CSVs
    # can show one accurate revenue ledger instead of missing walk-ins.
    transactions = [{
        'txn':         f'TXN-{9000 + p.id}',
        'member':      p.member.full_name if p.member else '—',
        'plan':        _payment_display_plan(p),
        'method':      p.method,
        'amount':      float(p.amount),
        'raw_dt':      p.paid_at,
        'recorded_by': p.recorded_by.full_name if p.recorded_by else '—',
    } for p in rows] + [{
        'txn':         f'WI-{w.id}',
        'member':      w.full_name,
        'plan':        f'Walk-In ({w.plan_type}) + Coach' if w.wants_coach else f'Walk-In ({w.plan_type})',
        'method':      w.method,
        'amount':      float(w.amount),
        'raw_dt':      w.created_at,
        'recorded_by': w.recorded_by.full_name if w.recorded_by else '—',
    } for w in walkin_rows]
    transactions.sort(key=lambda t: t['raw_dt'], reverse=True)

    return {
        'total_revenue':   f'{float(total):,.2f}',
        'transaction_count': len(rows) + len(walkin_rows),
        'by_plan': [{'plan': k, 'total': f'{v:,.2f}'} for k, v in sorted(by_plan.items(), key=lambda kv: -kv[1])],
        'by_method': [{'method': k, 'total': f'{v:,.2f}'} for k, v in sorted(by_method.items(), key=lambda kv: -kv[1])],
        'cash_total': f'{cash_total:,.2f}',
        'gcash_total': f'{gcash_total:,.2f}',
        'walkin_total': f'{walkin_total:,.2f}',
        'walkin_count': len(walkin_rows),
        'cash_by_staff': [
            {'staff': k, 'total': f'{v["total"]:,.2f}', 'count': v['count']}
            for k, v in sorted(cash_by_staff.items(), key=lambda kv: -kv[1]['total'])
        ],
        'rows': rows,
        'walkin_rows': walkin_rows,
        'transactions': transactions,
    }


def _membership_report():
    """Snapshot of every member's current status, plus new signups this month.
    Declined (and cancelled) plan requests never became a real membership,
    so they're excluded here — they'd otherwise inflate member/status counts
    with requests that were never actually granted."""
    all_members = _get_members_with_plans()
    members = [m for m in all_members if m['status'] not in ('Declined', 'Cancelled')]
    counts = {'Active': 0, 'Pending': 0, 'Expired': 0, 'No Plan': 0}
    for m in members:
        counts[m['status']] = counts.get(m['status'], 0) + 1

    today = _today_manila()
    month_start = datetime.combine(date(today.year, today.month, 1), datetime.min.time())
    new_this_month = User.query.filter(User.role == 'member', User.created_at >= month_start).count()

    return {
        'total_members': len(members),
        'counts': counts,
        'new_this_month': new_this_month,
        'members': members,
    }


def _attendance_report(start_date, end_date):
    """Check-ins within range: totals, unique members, and average visit duration."""
    start_dt = datetime.combine(start_date, datetime.min.time()) if start_date else None
    end_dt   = datetime.combine(end_date + timedelta(days=1), datetime.min.time())

    q = Attendance.query.options(joinedload(Attendance.member)).filter(Attendance.check_in < end_dt)
    if start_dt is not None:
        q = q.filter(Attendance.check_in >= start_dt)
    rows = q.order_by(Attendance.check_in.desc()).all()

    unique_members = len({r.member_id for r in rows})
    completed = [r for r in rows if r.check_out is not None]
    avg_minutes = int(sum(
        (r.duration_min if r.duration_min is not None else int((r.check_out - r.check_in).total_seconds() // 60))
        for r in completed
    ) / len(completed)) if completed else 0

    return {
        'total_checkins':  len(rows),
        'unique_members':  unique_members,
        'avg_duration_min': avg_minutes,
        'rows': rows,
    }


def _csv_response(filename, header, row_iter):
    """Build a downloadable CSV Response from a header row and an iterable of rows."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    for row in row_iter:
        writer.writerow(row)
    return Response(
        buf.getvalue(),
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


@app.route('/staff/reports/revenue.csv')
def staff_report_revenue_csv():
    if session.get('role') not in ('staff', 'admin'):
        return redirect(url_for('login'))
    range_key = request.args.get('range', 'this_month')
    start_date, end_date, label = _report_range(range_key)
    # Front-desk staff only ever see Cash — GCash is verified and reported
    # on by Admin. Keep this in lockstep with /api/staff/reports/revenue.
    # Includes walk-ins, since those are Cash too.
    report = _revenue_report(start_date, end_date, method='Cash')

    def rows():
        for t in report['transactions']:
            yield [
                t['txn'],
                t['member'],
                t['plan'],
                t['method'],
                f"{t['amount']:,.2f}",
                _to_manila(t['raw_dt']).strftime('%Y-%m-%d'),
                t['recorded_by'],
            ]

    return _csv_response(
        f'revenue-report-cash-{range_key}.csv',
        ['Txn#', 'Member', 'Plan', 'Method', 'Amount (₱)', 'Date', 'Recorded By'],
        rows(),
    )


@app.route('/staff/reports/membership.csv')
def staff_report_membership_csv():
    if session.get('role') not in ('staff', 'admin'):
        return redirect(url_for('login'))
    report = _membership_report()

    def rows():
        for m in report['members']:
            yield [m['name'], m['email'], m['plan'], m['expiry'], m['status']]

    return _csv_response(
        'membership-report.csv',
        ['Name', 'Email', 'Plan', 'Expiry', 'Status'],
        rows(),
    )


@app.route('/staff/reports/attendance.csv')
def staff_report_attendance_csv():
    if session.get('role') not in ('staff', 'admin'):
        return redirect(url_for('login'))
    range_key = request.args.get('range', 'this_month')
    start_date, end_date, label = _report_range(range_key)
    report = _attendance_report(start_date, end_date)

    def rows():
        for a in report['rows']:
            check_in_m  = _to_manila(a.check_in)
            check_out_m = _to_manila(a.check_out) if a.check_out else None
            duration_text = '—'
            if a.check_out:
                mins = a.duration_min if a.duration_min is not None else int((a.check_out - a.check_in).total_seconds() // 60)
                h, m = divmod(mins, 60)
                duration_text = f'{h}h {m}m' if h else f'{m}m'
            yield [
                a.member.full_name if a.member else '—',
                check_in_m.strftime('%Y-%m-%d'),
                check_in_m.strftime('%I:%M %p').lstrip('0'),
                check_out_m.strftime('%I:%M %p').lstrip('0') if check_out_m else '—',
                duration_text,
            ]

    return _csv_response(
        f'attendance-report-{range_key}.csv',
        ['Member', 'Date', 'Check-in', 'Check-out', 'Duration'],
        rows(),
    )


# ── Admin Analytics tab: live JSON report generator ──────────────────────
# Powers the "Report Generator" panel on the admin dashboard — every verified
# Cash or GCash payment is picked up automatically (no manual entry) since it
# reads straight from the same Payment table that staff/admin verification
# writes to. Accepts either a preset ?range= key or an explicit ?from=&to=
# calendar date range (the latter always wins when both are given).
@app.route('/api/admin/reports/<report_type>')
def api_admin_report(report_type):
    if session.get('role') != 'admin':
        return jsonify(success=False, error='Unauthorized.'), 403

    range_key = request.args.get('range', 'this_month')
    from_str  = request.args.get('from')
    to_str    = request.args.get('to')
    start_date, end_date, range_label = _resolve_report_window(range_key, from_str, to_str)

    if report_type == 'membership':
        report = _membership_report()
        status_order = ['Active', 'Pending', 'Expired', 'No Plan']
        # Membership is always a live current snapshot — it isn't filtered
        # by the From/To pickers (there's no "membership status as of a
        # past date" to look up), so the label must say that plainly
        # instead of echoing back a date range that was never applied.
        payload = {
            'title': 'Membership Report',
            'range_label': f"Current Snapshot \u2014 {_today_manila().strftime('%b %d, %Y')}",
            'stats': [
                {'label': 'Total Members', 'value': str(report['total_members'])},
                {'label': 'Active',        'value': str(report['counts'].get('Active', 0))},
                {'label': 'Pending',       'value': str(report['counts'].get('Pending', 0))},
                {'label': 'Expired',       'value': str(report['counts'].get('Expired', 0))},
                {'label': 'New This Month','value': str(report['new_this_month'])},
            ],
            'headers': ['Member', 'Email', 'Plan', 'Status', 'Expiry'],
            'rows': [[m['name'], m['email'], m['plan'], m['status'], m['expiry']] for m in report['members']],
            'chart_label': 'Membership Status',
            'chart_series': [
                {'label': s, 'value': report['counts'].get(s, 0)}
                for s in status_order if report['counts'].get(s, 0)
            ],
        }

    elif report_type == 'revenue':
        report = _revenue_report(start_date, end_date)
        by_method_map = {row['method']: row['total'] for row in report['by_method']}
        payload = {
            'title': 'Revenue Report',
            'range_label': range_label,
            'stats': [
                {'label': 'Total Revenue',  'value': f"\u20b1{report['total_revenue']}"},
                {'label': 'Transactions',   'value': str(report['transaction_count'])},
                {'label': 'Cash Collected', 'value': f"\u20b1{by_method_map.get('Cash', '0.00')}"},
                {'label': 'GCash Collected','value': f"\u20b1{by_method_map.get('GCash', '0.00')}"},
            ],
            'headers': ['Txn#', 'Member', 'Plan', 'Method', 'Amount (\u20b1)', 'Date', 'Recorded By'],
            'rows': [[
                t['txn'],
                t['member'],
                t['plan'],
                t['method'],
                f"{t['amount']:,.2f}",
                _to_manila(t['raw_dt']).strftime('%b %d, %Y'),
                t['recorded_by'],
            ] for t in report['transactions']],
            'chart_label': 'Revenue by Payment Method',
            'chart_series': [{'label': row['method'], 'value': float(row['total'].replace(',', ''))} for row in report['by_method']],
            'by_plan': report['by_plan'],
            'cash_by_staff': report['cash_by_staff'],
        }

    elif report_type == 'attendance':
        report = _attendance_report(start_date, end_date)
        chart_series = _bucket_counts(
            report['rows'], lambda a: _to_manila(a.check_in).date(), start_date, end_date
        )
        payload = {
            'title': 'Attendance Report',
            'range_label': range_label,
            'stats': [
                {'label': 'Total Check-ins',  'value': str(report['total_checkins'])},
                {'label': 'Unique Members',   'value': str(report['unique_members'])},
                {'label': 'Avg Duration',     'value': f"{report['avg_duration_min']} min"},
            ],
            'headers': ['Member', 'Date', 'Check-in', 'Check-out', 'Duration'],
            'rows': [[
                a.member.full_name if a.member else '\u2014',
                _to_manila(a.check_in).strftime('%b %d, %Y'),
                _to_manila(a.check_in).strftime('%I:%M %p').lstrip('0'),
                _to_manila(a.check_out).strftime('%I:%M %p').lstrip('0') if a.check_out else '\u2014',
                (lambda mins: (f'{mins // 60}h {mins % 60}m' if mins >= 60 else f'{mins}m'))(
                    a.duration_min if a.duration_min is not None else int((a.check_out - a.check_in).total_seconds() // 60)
                ) if a.check_out else '\u2014',
            ] for a in report['rows']],
            'chart_label': 'Check-ins Over Time',
            'chart_series': chart_series,
        }

    else:
        return jsonify(success=False, error='Unknown report type.'), 400

    return jsonify(success=True, report=payload)


# ── Staff Analytics tab: live JSON report generator ──────────────────────
# Same "Report Generator" experience as the admin dashboard — staff can pull
# Membership, Attendance, and Revenue reports. Membership and Attendance are
# full snapshots identical to what Admin sees (they aren't tied to a payment
# method). Revenue is the one exception: it's always restricted to Cash
# payments — GCash is verified and reported on by Admin, not front-desk staff.
@app.route('/api/staff/reports/<report_type>')
def api_staff_report(report_type):
    if session.get('role') not in ('staff', 'admin'):
        return jsonify(success=False, error='Unauthorized.'), 403

    if report_type not in ('revenue', 'membership', 'attendance'):
        return jsonify(success=False, error='Unknown report type.'), 400

    from_str = request.args.get('from')
    to_str   = request.args.get('to')
    start_date, end_date, range_label = _resolve_report_window('this_month', from_str, to_str)

    if report_type == 'membership':
        report = _membership_report()
        status_order = ['Active', 'Pending', 'Expired', 'No Plan']
        payload = {
            'title': 'Membership Report',
            'range_label': f"Current Snapshot \u2014 {_today_manila().strftime('%b %d, %Y')}",
            'stats': [
                {'label': 'Total Members', 'value': str(report['total_members'])},
                {'label': 'Active',        'value': str(report['counts'].get('Active', 0))},
                {'label': 'Pending',       'value': str(report['counts'].get('Pending', 0))},
                {'label': 'Expired',       'value': str(report['counts'].get('Expired', 0))},
                {'label': 'New This Month','value': str(report['new_this_month'])},
            ],
            'headers': ['Member', 'Email', 'Plan', 'Status', 'Expiry'],
            'rows': [[m['name'], m['email'], m['plan'], m['status'], m['expiry']] for m in report['members']],
            'chart_label': 'Membership Status',
            'chart_series': [
                {'label': s, 'value': report['counts'].get(s, 0)}
                for s in status_order if report['counts'].get(s, 0)
            ],
        }

    elif report_type == 'attendance':
        report = _attendance_report(start_date, end_date)
        chart_series = _bucket_counts(
            report['rows'], lambda a: _to_manila(a.check_in).date(), start_date, end_date
        )
        payload = {
            'title': 'Attendance Report',
            'range_label': range_label,
            'stats': [
                {'label': 'Total Check-ins',  'value': str(report['total_checkins'])},
                {'label': 'Unique Members',   'value': str(report['unique_members'])},
                {'label': 'Avg Duration',     'value': f"{report['avg_duration_min']} min"},
            ],
            'headers': ['Member', 'Date', 'Check-in', 'Check-out', 'Duration'],
            'rows': [[
                a.member.full_name if a.member else '\u2014',
                _to_manila(a.check_in).strftime('%b %d, %Y'),
                _to_manila(a.check_in).strftime('%I:%M %p').lstrip('0'),
                _to_manila(a.check_out).strftime('%I:%M %p').lstrip('0') if a.check_out else '\u2014',
                (lambda mins: (f'{mins // 60}h {mins % 60}m' if mins >= 60 else f'{mins}m'))(
                    a.duration_min if a.duration_min is not None else int((a.check_out - a.check_in).total_seconds() // 60)
                ) if a.check_out else '\u2014',
            ] for a in report['rows']],
            'chart_label': 'Check-ins Over Time',
            'chart_series': chart_series,
        }

    else:  # revenue — staff only ever sees Cash
        report = _revenue_report(start_date, end_date, method='Cash')
        payload = {
            'title': 'Revenue Report (Cash)',
            'range_label': range_label,
            'stats': [
                {'label': 'Total Cash Revenue', 'value': f"\u20b1{report['total_revenue']}"},
                {'label': 'Transactions',       'value': str(report['transaction_count'])},
            ],
            'headers': ['Txn#', 'Member', 'Plan', 'Amount (\u20b1)', 'Date', 'Recorded By'],
            'rows': [[
                t['txn'],
                t['member'],
                t['plan'],
                f"{t['amount']:,.2f}",
                _to_manila(t['raw_dt']).strftime('%b %d, %Y'),
                t['recorded_by'],
            ] for t in report['transactions']],
            'chart_label': 'Cash Revenue',
            'chart_series': [{'label': 'Cash', 'value': float(report['total_revenue'].replace(',', ''))}] if report['transaction_count'] else [],
            'by_plan': report['by_plan'],
            'cash_by_staff': report['cash_by_staff'],
        }

    return jsonify(success=True, report=payload)


def _get_coach_occupancy():
    """Return {coach_name: count} of members currently occupying a slot with
    that coach — i.e. members with an active membership whose most recent
    verified payment requested that coach. Renewals without a coach, or
    expired/declined memberships, don't count."""
    active_member_ids = {
        m.member_id for m in Membership.query.filter_by(status='active').all()
    }
    latest_verified_payment = {}
    for p in (Payment.query.filter(Payment.status == 'verified')
              .order_by(Payment.paid_at.asc()).all()):
        latest_verified_payment[p.member_id] = p  # last one wins -> most recent

    occupancy = {}
    for member_id, p in latest_verified_payment.items():
        if member_id in active_member_ids and p.wants_coach and p.coach_name:
            occupancy[p.coach_name] = occupancy.get(p.coach_name, 0) + 1
    return occupancy


def _get_coaches_data():
    """Coaches with computed occupancy/slots-left, for both the staff Coach
    tab (management) and the member plan-request form (availability)."""
    occupancy = _get_coach_occupancy()
    coaches = Coach.query.order_by(Coach.name).all()
    return [{
        'id':             c.id,
        'name':           c.name,
        'available_days': c.available_days_list,
        'max_members':    c.max_members,
        'fee':            float(c.fee),
        'is_active':      c.is_active,
        'current_members': occupancy.get(c.name, 0),
        'slots_left':     max(c.max_members - occupancy.get(c.name, 0), 0),
        'is_full':        occupancy.get(c.name, 0) >= c.max_members,
    } for c in coaches]


def _get_members_with_plans():
    """Return every member with their current plan/expiry/status, newest first."""
    rows = (
        db.session.query(User, Membership, MembershipPlan)
        .outerjoin(Membership, Membership.member_id == User.id)
        .outerjoin(MembershipPlan, MembershipPlan.id == Membership.plan_id)
        .filter(User.role == 'member')
        .order_by(User.id.desc())
        .all()
    )

    today = _today_manila()
    members = []
    for user, membership, plan in rows:
        expiry_date = None
        if membership is None or plan is None:
            plan_name, expiry_text, status_label = '—', '—', 'No Plan'
        else:
            plan_name   = plan.name
            expiry_date = membership.expiry_date
            expiry_text = expiry_date.strftime('%b %d, %Y') if expiry_date else '—'
            if expiry_date and expiry_date < today:
                status_label = 'Expired'
            elif membership.status == 'declined':
                status_label = 'Declined'
            elif membership.status == 'pending':
                status_label = 'Pending'
            else:
                status_label = 'Active'

        members.append({
            'id': user.id,
            'name': user.full_name,
            'first_name': user.first_name,
            'middle_initial': user.middle_initial or '',
            'last_name': user.last_name,
            'extension_name': user.extension_name or '',
            'email': user.email,
            'phone': user.phone or '',
            'plan': plan_name,
            'expiry': expiry_text,
            'expiry_date': expiry_date,
            'status': status_label,
        })
    return members


@app.route('/admin')
def admin():
    if 'role' not in session:
        return redirect(url_for('login'))
    if session.get('role') != 'admin':
        return redirect(url_for(session.get('role', 'login')))

    members = _get_members_with_plans()
    attendance_today = _get_attendance_today()
    attendance_calendar = _get_attendance_calendar()

    # ── Overview stat cards — real counts/totals, not placeholders ──
    month_start, month_end, _ = _report_range('this_month')
    monthly_revenue_report = _revenue_report(month_start, month_end)
    stats = {
        'total_members':   len(members),
        'active_members':  len([m for m in members if m['status'] == 'Active']),
        'checkins_today':  _count_checkins_today(),
        'monthly_revenue': _format_currency_short(monthly_revenue_report['total_revenue'].replace(',', '')),
    }

    # This list spans every in-progress stage: 'approval' (plan request
    # awaiting staff sign-off), 'awaiting_payment' (approved, member hasn't
    # chosen a method yet), 'verify_cash' (Cash — staff's job) and
    # 'verify_gcash' (GCash — admin's job). Admin sees all four for
    # visibility but can only act on 'verify_gcash'.
    pending_payments_rows = (
        Payment.query
        .options(joinedload(Payment.member), joinedload(Payment.plan))
        .filter(Payment.status.in_(['pending', 'approved']))
        .order_by(Payment.paid_at.desc())
        .all()
    )
    def _build_pending_payment(p):
        member_reported = _member_reported_payment_details(p.notes)
        reported_amount_val = _parse_peso_amount(member_reported.get('amount')) if member_reported else None
        amount_mismatch = (
            reported_amount_val is not None
            and abs(reported_amount_val - float(p.amount)) > 0.01
        )
        return {
            'id': p.id,
            'txn': f'TXN-{9000 + p.id}',
            'member_name': p.member.full_name,
            'member_profile_picture': url_for('static', filename=p.member.profile_picture) if p.member.profile_picture else None,
            'plan': _payment_display_plan(p),
            'is_promo': bool(p.notes and p.notes.startswith('Promo request:')),
            'method': p.method,
            'reference': p.reference_number or '—',
            'amount': f'{float(p.amount):,.2f}',
            'proof_image_path': p.proof_image_path,
            'proof_image_path_2': p.proof_image_path_2,
            'proof_image_path_3': p.proof_image_path_3,
            # Structured (not run-on) member-reported context, plus a flag
            # so the template can call out a mismatch between what the
            # member says they paid and the actual amount being charged.
            'member_reported': member_reported,
            'amount_mismatch': amount_mismatch,
            'is_student': p.is_student,
            'student_id_image_path': p.student_id_image_path,
            'wants_coach': p.wants_coach,
            'coach_name': p.coach_name,
            'stage': _payment_stage(p),
            'staff_viewed': p.staff_viewed,
        }

    pending_payments = [_build_pending_payment(p) for p in pending_payments_rows]

    # ── Payment history — approved only, same as staff's Recently Processed.
    #    A declined request just disappears from the list; it only shows up
    #    again once the member submits a new request and that one is approved. ──
    payment_history_rows = (
        Payment.query
        .options(joinedload(Payment.member), joinedload(Payment.plan))
        .filter(Payment.status == 'verified')
        .order_by(Payment.paid_at.desc())
        .limit(50)
        .all()
    )
    payment_history = [{
        'txn': f'TXN-{9000 + p.id}',
        'member_name': p.member.full_name,
        'plan': _payment_display_plan(p),
        'method': p.method,
        'amount': f'{float(p.amount):,.2f}',
        'date': p.paid_at.strftime('%b %d, %Y'),
        'status': p.status,
        'is_student': p.is_student,
        'wants_coach': p.wants_coach,
        'coach_name': p.coach_name,
    } for p in payment_history_rows]

    # Admin sees every announcement (including unpublished ones) so it can
    # manage/unpublish/delete them, not just the ones currently live.
    announcements = Announcement.query.order_by(Announcement.created_at.desc()).all()

    coaches_data = _get_coaches_data()

    admin_user = User.query.get(session['user_id'])
    picture_can_change, picture_available_at = _profile_picture_cooldown(admin_user)

    return render_template(
        'admin-dashboard.html',
        members=members,
        stats=stats,
        pending_payments=pending_payments,
        payment_history=payment_history,
        attendance_today=attendance_today,
        attendance_calendar=attendance_calendar,
        announcements=announcements,
        current_user=admin_user,
        gcash_settings=_get_gym_settings(),
        coaches=coaches_data,
        coach_days=VALID_COACH_DAYS,
        picture_can_change=picture_can_change,
        picture_available_at=picture_available_at.strftime('%B %d, %Y') if picture_available_at else None,
    )


# ── Seed ──────────────────────────────────────────────────────

def seed_default_users():
    defaults = [
        {'first_name': 'Administrator', 'last_name': 'User',   'email': 'admin@powergym.com', 'password': 'admin123',  'role': 'admin'},
        {'first_name': 'Staff',         'last_name': 'Member', 'email': 'staff@powergym.com', 'password': 'staff123',  'role': 'staff'},
        {'first_name': 'Maria',         'last_name': 'Santos', 'email': 'maria@email.com',    'password': 'member123', 'role': 'member'},
    ]
    for u in defaults:
        if User.query.filter_by(email=u['email']).first() is None:
            db.session.add(User(
                first_name=u['first_name'],
                last_name=u['last_name'],
                email=u['email'],
                password=generate_password_hash(u['password']),
                role=u['role'],
                status='active',
            ))
    db.session.commit()


def seed_default_plans():
    # "Weekly" used to be a default plan here — it's been retired. It's
    # deliberately left out of this list (not just deleted from the
    # database) so it never gets silently re-created the next time the app
    # starts, the way seeding used to keep it alive even after deleting it
    # from the dashboard.
    defaults = [
        {'name': 'Daily',   'duration_days': 1,   'price': 100.0,
         'description': 'Perfect for a casual visit — walk in, train, and go, no commitment required.',
         'inclusions': 'Gym Equipment Access\nGym Services', 'sort_order': 1},
        {'name': 'Monthly', 'duration_days': 30,  'price': 900.0,
         'description': 'Our most popular plan — unlimited visits with trainer support to keep you on track.',
         'inclusions': 'Gym Equipment Access\nGym Services', 'sort_order': 3},
        {'name': 'Yearly',  'duration_days': 365, 'price': 7000.0,
         'description': 'Full coaching support — a personal trainer and nutrition plan built around your goals.',
         'inclusions': 'Gym Equipment Access\nGym Services', 'sort_order': 4},
    ]
    for p in defaults:
        existing = MembershipPlan.query.filter_by(name=p['name']).first()
        if existing is None:
            db.session.add(MembershipPlan(
                name=p['name'],
                duration_days=p['duration_days'],
                price=p['price'],
                description=p['description'],
                inclusions=p['inclusions'],
                sort_order=p['sort_order'],
            ))
        else:
            # Keep an already-seeded row in sync if the defaults above change
            # (e.g. a price adjustment). Content fields (description/
            # inclusions/image) are left alone once set, so staff/admin
            # edits made from the dashboard aren't overwritten.
            existing.duration_days = p['duration_days']
            existing.price         = p['price']
            if existing.description is None:
                existing.description = p['description']
            if existing.inclusions is None:
                existing.inclusions = p['inclusions']
            if not existing.sort_order:
                existing.sort_order = p['sort_order']
    db.session.commit()


def seed_default_promos():
    """Seeds the two promos that used to be hardcoded directly into
    member-dashboard.html ('16 Sessions', 'Boxing') so a fresh install
    isn't empty out of the box — but from here on they're just normal
    rows staff/admin can edit or delete from Manage Content → Promos,
    exactly like any other promo they create themselves."""
    defaults = [
        {'title': '16 Sessions', 'price': 3500.0, 'period': 'Limited-time offer',
         'inclusions': '16 gym-access sessions, usable any time before they expire\n'
                        'Full equipment access during each session\n'
                        'No long-term commitment — pay once, use as you go',
         'sort_order': 1},
        {'title': 'Boxing', 'price': 4000.0, 'period': 'Limited-time offer',
         'inclusions': 'Full boxing program access for 30 days\n'
                        'Use of gloves, pads, and boxing equipment\n'
                        'Open access to regular gym facilities during the promo period',
         'sort_order': 2},
    ]
    for p in defaults:
        existing = GymPromo.query.filter_by(title=p['title']).first()
        if existing is None:
            db.session.add(GymPromo(
                title=p['title'],
                price=p['price'],
                period=p['period'],
                inclusions=p['inclusions'],
                sort_order=p['sort_order'],
            ))
    db.session.commit()


def seed_default_coaches():
    defaults = [
        {'name': 'Ronel Samar',        'available_days': 'Mon,Wed,Fri', 'max_members': 10},
        {'name': 'Jonathan Natividad', 'available_days': 'Tue,Thu,Sat', 'max_members': 10},
    ]
    for c in defaults:
        if Coach.query.filter_by(name=c['name']).first() is None:
            db.session.add(Coach(
                name=c['name'],
                available_days=c['available_days'],
                max_members=c['max_members'],
            ))
    db.session.commit()


def seed_default_equipment():
    defaults = [
        {'name': 'Weight Area',          'image_path': 'images/facility-weight.png',      'sort_order': 1, 'category': 'Strengthening', 'icon': '💪'},
        {'name': 'Cardio Area',          'image_path': 'images/facility-cardio.png',      'sort_order': 2, 'category': 'Cardio Zone',    'icon': '🏃'},
        {'name': 'Functional Training',  'image_path': 'images/facility-functional.png',  'sort_order': 3, 'category': 'Functional Training', 'icon': '🤸'},
        {'name': 'Reception',            'image_path': 'images/facility-reception.png',   'sort_order': 4, 'category': 'General',        'icon': '🛎️'},
    ]
    if GymEquipment.query.count() == 0:
        for e in defaults:
            db.session.add(GymEquipment(
                name=e['name'], image_path=e['image_path'], sort_order=e['sort_order'],
                category=e['category'], icon=e['icon'],
                is_facility=True,  # facility-zone photo, not a real machine — see model docstring
            ))
        db.session.commit()


def seed_default_fitness_catalog():
    """One-time curated seed for the Stage 4 recommendation engine's
    FoodItem and Exercise catalogs — fixed, practical example data, not
    admin/member-editable in this stage. Idempotent: only inserts if each
    table is empty, same pattern as the other seed_default_* functions."""
    if FoodItem.query.count() == 0:
        foods = [
            # -- Protein sources --
            {'name': 'Grilled Chicken Breast', 'category': 'protein', 'suitable_meal': 'lunch,dinner',
             'serving_description': '150g grilled chicken breast', 'calories_per_serving': 248, 'protein_g_per_serving': 46},
            {'name': 'Grilled Fish (Tilapia/Bangus)', 'category': 'protein', 'suitable_meal': 'lunch,dinner',
             'serving_description': '150g grilled fish', 'calories_per_serving': 200, 'protein_g_per_serving': 34},
            {'name': 'Tuna (canned in water)', 'category': 'protein', 'suitable_meal': 'lunch,dinner,snack',
             'serving_description': '1 can (150g) tuna in water', 'calories_per_serving': 150, 'protein_g_per_serving': 33},
            {'name': 'Lean Beef (Sirloin)', 'category': 'protein', 'suitable_meal': 'lunch,dinner',
             'serving_description': '120g lean beef sirloin', 'calories_per_serving': 250, 'protein_g_per_serving': 30},
            {'name': 'Whole Eggs', 'category': 'protein', 'suitable_meal': 'breakfast',
             'serving_description': '2 whole eggs', 'calories_per_serving': 180, 'protein_g_per_serving': 12},
            {'name': 'Egg Whites', 'category': 'protein', 'suitable_meal': 'breakfast',
             'serving_description': '4 egg whites', 'calories_per_serving': 70, 'protein_g_per_serving': 15},
            {'name': 'Greek Yogurt', 'category': 'protein', 'suitable_meal': 'breakfast,snack',
             'serving_description': '1 cup (200g) Greek yogurt', 'calories_per_serving': 130, 'protein_g_per_serving': 20},
            {'name': 'Low-Fat Milk', 'category': 'protein', 'suitable_meal': 'breakfast,snack',
             'serving_description': '1 cup (250ml) low-fat milk', 'calories_per_serving': 120, 'protein_g_per_serving': 9},
            {'name': 'Firm Tofu', 'category': 'protein', 'suitable_meal': 'lunch,dinner',
             'serving_description': '150g firm tofu', 'calories_per_serving': 180, 'protein_g_per_serving': 18},
            {'name': 'Cooked Lentils', 'category': 'protein', 'suitable_meal': 'lunch,dinner',
             'serving_description': '1 cup cooked lentils', 'calories_per_serving': 230, 'protein_g_per_serving': 18},
            {'name': 'Whey Protein Shake', 'category': 'protein', 'suitable_meal': 'breakfast,snack',
             'serving_description': '1 scoop whey protein + water', 'calories_per_serving': 120, 'protein_g_per_serving': 24},
            # -- Carbohydrate sources --
            {'name': 'Steamed Rice', 'category': 'carb', 'suitable_meal': 'lunch,dinner',
             'serving_description': '1 cup cooked rice', 'calories_per_serving': 205, 'protein_g_per_serving': 4},
            {'name': 'Brown Rice', 'category': 'carb', 'suitable_meal': 'lunch,dinner',
             'serving_description': '1 cup cooked brown rice', 'calories_per_serving': 216, 'protein_g_per_serving': 5},
            {'name': 'Oatmeal', 'category': 'carb', 'suitable_meal': 'breakfast',
             'serving_description': '1 cup cooked oatmeal', 'calories_per_serving': 150, 'protein_g_per_serving': 5},
            {'name': 'Sweet Potato (Kamote)', 'category': 'carb', 'suitable_meal': 'lunch,dinner,snack',
             'serving_description': '1 medium (150g) sweet potato', 'calories_per_serving': 130, 'protein_g_per_serving': 2},
            {'name': 'Whole Wheat Bread', 'category': 'carb', 'suitable_meal': 'breakfast',
             'serving_description': '2 slices whole wheat bread', 'calories_per_serving': 160, 'protein_g_per_serving': 6},
            {'name': 'Whole-Wheat Pasta', 'category': 'carb', 'suitable_meal': 'lunch,dinner',
             'serving_description': '1 cup cooked whole-wheat pasta', 'calories_per_serving': 175, 'protein_g_per_serving': 7},
            # -- Fruits --
            {'name': 'Banana', 'category': 'fruit', 'suitable_meal': 'breakfast,snack',
             'serving_description': '1 medium banana', 'calories_per_serving': 105, 'protein_g_per_serving': 1},
            {'name': 'Apple', 'category': 'fruit', 'suitable_meal': 'snack',
             'serving_description': '1 medium apple', 'calories_per_serving': 95, 'protein_g_per_serving': 0},
            {'name': 'Mango (sliced)', 'category': 'fruit', 'suitable_meal': 'breakfast,snack',
             'serving_description': '1 cup sliced mango', 'calories_per_serving': 100, 'protein_g_per_serving': 1},
            {'name': 'Orange', 'category': 'fruit', 'suitable_meal': 'snack',
             'serving_description': '1 medium orange', 'calories_per_serving': 62, 'protein_g_per_serving': 1},
            # -- Vegetables --
            {'name': 'Steamed Mixed Vegetables', 'category': 'vegetable', 'suitable_meal': 'lunch,dinner',
             'serving_description': '1 cup steamed mixed vegetables', 'calories_per_serving': 60, 'protein_g_per_serving': 3},
            {'name': 'Sautéed Leafy Greens', 'category': 'vegetable', 'suitable_meal': 'lunch,dinner',
             'serving_description': '1 cup sautéed leafy greens (e.g. kangkong, spinach)', 'calories_per_serving': 50, 'protein_g_per_serving': 3},
            {'name': 'Mixed Salad Greens', 'category': 'vegetable', 'suitable_meal': 'lunch,dinner',
             'serving_description': '2 cups mixed salad greens', 'calories_per_serving': 40, 'protein_g_per_serving': 2},
            # -- Healthy fats --
            {'name': 'Peanut Butter', 'category': 'healthy_fat', 'suitable_meal': 'breakfast,snack',
             'serving_description': '1 tbsp peanut butter', 'calories_per_serving': 95, 'protein_g_per_serving': 4},
            {'name': 'Avocado', 'category': 'healthy_fat', 'suitable_meal': 'breakfast,lunch,snack',
             'serving_description': '1/2 medium avocado', 'calories_per_serving': 120, 'protein_g_per_serving': 1},
            {'name': 'Mixed Nuts / Almonds', 'category': 'healthy_fat', 'suitable_meal': 'snack',
             'serving_description': '1 small handful (28g) almonds', 'calories_per_serving': 165, 'protein_g_per_serving': 6},
            {'name': 'Olive Oil (for cooking)', 'category': 'healthy_fat', 'suitable_meal': 'any',
             'serving_description': '1 tbsp olive oil (for cooking)', 'calories_per_serving': 120, 'protein_g_per_serving': 0},
        ]
        for f in foods:
            db.session.add(FoodItem(**f))
        db.session.commit()

    if Exercise.query.count() == 0:
        exercises = [
            {'name': 'Squats', 'target_area': 'Legs', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3-4', 'default_reps': '8-12',
             'purpose': 'Builds lower-body strength and overall muscle mass.',
             'equipment_name': 'Squat Rack', 'equipment_note': 'Used to safely load and perform barbell squats.',
             'sub_target': 'Quadriceps',
             'instructions': '1. Set the bar on the squat rack at upper-chest height.\n2. Step under the bar and rest it across your upper back/traps.\n3. Unrack the bar and step back into a shoulder-width stance.\n4. Bend your knees and hips to lower until your thighs are about parallel to the floor, keeping your chest up and back straight.\n5. Push through your heels to return to standing.\n6. Re-rack the bar after your final rep.'},
            {'name': 'Bench Press', 'target_area': 'Chest', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3-4', 'default_reps': '6-10',
             'purpose': 'Builds chest, shoulder, and triceps strength.',
             'equipment_name': 'Barbells', 'equipment_note': 'Useful for presses, rows, and other loaded barbell exercises.',
             'sub_target': 'Middle Chest',
             'instructions': '1. Lie flat on the bench with your eyes under the bar.\n2. Grip the bar slightly wider than shoulder-width.\n3. Unrack the bar and lower it under control to your mid-chest.\n4. Press the bar back up until your arms are extended.\n5. Keep your feet flat on the floor and shoulder blades pulled together throughout.'},
            {'name': 'Incline Bench Press', 'target_area': 'Chest', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '8-12',
             'purpose': 'Emphasizes the upper chest and front shoulders.',
             'equipment_name': 'Barbells', 'equipment_note': 'Useful for presses, rows, and other loaded barbell exercises.',
             'sub_target': 'Upper Chest',
             'instructions': '1. Set the bench to a 30-45 degree incline.\n2. Lie back and grip the bar slightly wider than shoulder-width.\n3. Unrack the bar and lower it under control to your upper chest.\n4. Press the bar back up until your arms are extended.\n5. Keep your core braced and avoid arching your lower back excessively.'},
            {'name': 'Decline Bench Press', 'target_area': 'Chest', 'exercise_type': 'resistance',
             'goal_tags': 'BULK,RECOMP', 'default_sets': '3', 'default_reps': '8-12',
             'purpose': 'Emphasizes the lower chest.',
             'equipment_name': 'Barbells', 'equipment_note': 'Useful for presses, rows, and other loaded barbell exercises.',
             'sub_target': 'Lower Chest',
             'instructions': '1. Secure your legs on the decline bench and lie back.\n2. Grip the bar slightly wider than shoulder-width.\n3. Unrack the bar and lower it under control to your lower chest.\n4. Press the bar back up until your arms are extended.\n5. Move with control in both directions — avoid bouncing the bar off your chest.'},
            {'name': 'Lat Pulldown', 'target_area': 'Back', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-12',
             'purpose': 'Builds upper-back and lat width, supports posture.',
             'equipment_name': 'Lat Pulldown Machine', 'equipment_note': 'Provides controlled resistance for pulling movements.',
             'sub_target': 'Lats',
             'instructions': '1. Sit at the machine and secure your knees under the pad.\n2. Grip the bar wider than shoulder-width.\n3. Pull the bar down to your upper chest, leading with your elbows.\n4. Squeeze your shoulder blades together at the bottom.\n5. Slowly return the bar to the starting position with control.'},
            {'name': 'Seated Row', 'target_area': 'Back', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,BULK,RECOMP', 'default_sets': '3', 'default_reps': '10-12',
             'purpose': 'Strengthens the mid-back and improves pulling strength.',
             'equipment_name': 'Cable Machine', 'equipment_note': 'Useful for controlled resistance exercises for different muscle groups.',
             'sub_target': 'Middle Back',
             'instructions': '1. Sit at the cable row station with knees slightly bent and feet braced.\n2. Grip the handle and sit up tall with a straight back.\n3. Pull the handle toward your torso, driving your elbows back.\n4. Squeeze your shoulder blades together at the end of the pull.\n5. Extend your arms back out with control to the starting position.'},
            {'name': 'Shoulder Press', 'target_area': 'Shoulders', 'exercise_type': 'resistance',
             'goal_tags': 'BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '8-12',
             'purpose': 'Builds shoulder strength and stability.',
             'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
             'sub_target': 'Front Deltoids',
             'instructions': '1. Sit or stand holding a dumbbell in each hand at shoulder height.\n2. Brace your core and keep your back straight.\n3. Press both dumbbells overhead until your arms are extended.\n4. Pause briefly at the top.\n5. Lower the dumbbells back to shoulder height with control.'},
            {'name': 'Lateral Raises', 'target_area': 'Shoulders', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
             'purpose': 'Isolates the side deltoids for shoulder width.',
             'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
             'sub_target': 'Side Deltoids',
             'instructions': '1. Stand holding a light dumbbell in each hand at your sides.\n2. Keep a slight bend in your elbows.\n3. Raise both arms out to the sides until they reach shoulder height.\n4. Pause briefly at the top.\n5. Lower the dumbbells back down with control.'},
            {'name': 'Rear Delt Fly', 'target_area': 'Shoulders', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
             'purpose': 'Isolates the rear deltoids and supports shoulder balance/posture.',
             'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
             'sub_target': 'Rear Deltoids',
             'instructions': '1. Hinge forward at the hips with a slight bend in your knees, holding a light dumbbell in each hand.\n2. Let your arms hang straight down with a slight elbow bend.\n3. Raise both arms out to the sides, squeezing your shoulder blades together.\n4. Pause briefly at the top.\n5. Lower the dumbbells back down with control.'},
            {'name': 'Lunges', 'target_area': 'Legs', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-12 per leg',
             'purpose': 'Builds leg strength and balance.',
             'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
             'sub_target': 'Glutes',
             'instructions': '1. Stand tall holding a dumbbell in each hand at your sides.\n2. Step forward with one leg.\n3. Lower your hips until both knees are bent at about 90 degrees.\n4. Push through your front heel to return to standing.\n5. Repeat, alternating legs.'},
            {'name': 'Leg Press', 'target_area': 'Legs', 'exercise_type': 'resistance',
             'goal_tags': 'BULK,RECOMP', 'default_sets': '3-4', 'default_reps': '10-12',
             'purpose': 'Builds lower-body strength with reduced spinal load compared to squats.',
             'equipment_name': 'Leg Press Machine', 'equipment_note': 'Machine-guided resistance for the legs.',
             'sub_target': 'Quadriceps',
             'instructions': '1. Sit in the leg press machine with feet shoulder-width apart on the platform.\n2. Release the safety catches.\n3. Lower the platform by bending your knees toward your chest, under control.\n4. Push through your heels to extend your legs without locking your knees.\n5. Re-engage the safety catches after your final rep.'},
            {'name': 'Bicep Curls', 'target_area': 'Arms', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-12',
             'purpose': 'Isolates and strengthens the biceps.',
             'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
             'sub_target': 'Biceps', 'specific_target': 'Long & Short Head (Overall Biceps)',
             'instructions': '1. Stand holding a dumbbell in each hand with arms fully extended.\n2. Keep your elbows tucked close to your sides.\n3. Curl the dumbbells up toward your shoulders.\n4. Squeeze your biceps briefly at the top.\n5. Lower the dumbbells back down with control.'},
            {'name': 'Tricep Pushdowns', 'target_area': 'Arms', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-12',
             'purpose': 'Isolates and strengthens the triceps.',
             'equipment_name': 'Cable Machine', 'equipment_note': 'Useful for controlled resistance exercises for different muscle groups.',
             'sub_target': 'Triceps', 'specific_target': 'Lateral Head',
             'instructions': '1. Stand facing a cable machine with a bar or rope attachment set high.\n2. Grip the attachment with elbows tucked at your sides.\n3. Push the attachment down until your arms are fully extended.\n4. Squeeze your triceps briefly at the bottom.\n5. Let the attachment rise back up with control.'},
            {'name': 'Planks', 'target_area': 'Core', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '30-60 sec',
             'purpose': 'Builds core stability and endurance.',
             'equipment_name': 'Exercise Mat', 'equipment_note': 'Provides a comfortable, non-slip surface for floor-based exercises.',
             'sub_target': 'Full Core',
             'instructions': '1. Lie face down and prop yourself up on your forearms and toes.\n2. Keep your elbows directly under your shoulders.\n3. Raise your hips so your body forms a straight line from head to heels.\n4. Brace your core and hold the position without sagging or piking your hips.\n5. Breathe steadily for the target duration.'},
            {'name': 'Crunches', 'target_area': 'Core', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '15-20',
             'purpose': 'Targets the upper abdominal muscles.',
             'equipment_name': 'Exercise Mat', 'equipment_note': 'Provides a comfortable, non-slip surface for floor-based exercises.',
             'sub_target': 'Upper Core',
             'instructions': '1. Lie on your back with knees bent and feet flat on the floor.\n2. Place your hands lightly behind your head or crossed on your chest.\n3. Curl your shoulders up off the floor by contracting your abs.\n4. Pause briefly at the top.\n5. Lower back down with control.'},
            {'name': 'Leg Raises', 'target_area': 'Core', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
             'purpose': 'Targets the lower abdominal muscles.',
             'equipment_name': 'Exercise Mat', 'equipment_note': 'Provides a comfortable, non-slip surface for floor-based exercises.',
             'sub_target': 'Lower Core',
             'instructions': '1. Lie flat on your back with legs extended and hands at your sides or under your hips.\n2. Keep your legs straight (or slightly bent, if needed).\n3. Raise your legs until they point toward the ceiling.\n4. Lower them back down slowly without letting them touch the floor.\n5. Repeat while keeping your lower back pressed toward the mat.'},
            {'name': 'Brisk Walking', 'target_area': 'Full Body', 'exercise_type': 'cardio',
             'goal_tags': 'CUT,MAINTAIN', 'default_sets': '1', 'default_reps': '20-30 min',
             'purpose': 'Low-impact cardio that supports fat loss and general fitness.',
             'equipment_name': 'Treadmill', 'equipment_note': 'Useful for walking or cardio sessions.',
             'sub_target': 'Cardiovascular',
             'instructions': '1. Set the treadmill to a brisk, comfortable walking pace.\n2. Stand tall with a natural arm swing.\n3. Walk continuously for the target duration.\n4. Adjust incline/speed slightly if you want more challenge.\n5. Cool down with a slower pace for the last 2-3 minutes.'},
            {'name': 'Treadmill Jogging', 'target_area': 'Full Body', 'exercise_type': 'cardio',
             'goal_tags': 'CUT,RECOMP', 'default_sets': '1', 'default_reps': '15-25 min',
             'purpose': 'Moderate-intensity cardio to support calorie expenditure.',
             'equipment_name': 'Treadmill', 'equipment_note': 'Useful for walking or cardio sessions.',
             'sub_target': 'Cardiovascular',
             'instructions': '1. Warm up with a brisk walk for 2-3 minutes.\n2. Gradually increase the treadmill speed to a light jog.\n3. Maintain a steady jogging pace for the target duration.\n4. Keep your posture upright and breathing steady.\n5. Cool down with a slower walking pace for the last 2-3 minutes.'},
            {'name': 'Stationary Cycling', 'target_area': 'Full Body', 'exercise_type': 'cardio',
             'goal_tags': 'MAINTAIN,RECOMP', 'default_sets': '1', 'default_reps': '15-25 min',
             'purpose': 'Low-impact cardio that supports cardiovascular fitness.',
             'equipment_name': 'Exercise Bike', 'equipment_note': 'Useful for low-impact cardio sessions.',
             'sub_target': 'Cardiovascular',
             'instructions': '1. Adjust the seat height so your knee is slightly bent at full pedal extension.\n2. Start pedaling at a light resistance to warm up.\n3. Increase resistance to a moderate, steady level.\n4. Maintain a consistent pace for the target duration.\n5. Cool down by lowering resistance and pace for the last 2-3 minutes.'},
            {'name': 'Resistance Band Rows', 'target_area': 'Back', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,MAINTAIN', 'default_sets': '3', 'default_reps': '12-15',
             'purpose': 'A beginner-friendly alternative for building back strength.',
             'equipment_name': 'Resistance Bands', 'equipment_note': 'Portable resistance useful for beginner-friendly strength exercises.',
             'sub_target': 'Middle Back',
             'instructions': '1. Anchor the resistance band at chest height in front of you.\n2. Hold an end in each hand and step back until there is tension in the band.\n3. Pull both handles toward your torso, driving your elbows back.\n4. Squeeze your shoulder blades together at the end of the pull.\n5. Extend your arms back out with control.'},
            # ── Stage B — added to complete Legs (Hamstrings, Calves) and
            #    Back (Upper Back, Lower Back) sub-target coverage. See the
            #    matching idempotent insert-migration below for how these
            #    same four rows reach databases that were seeded before
            #    this stage. ──
            {'name': 'Leg Curl', 'target_area': 'Legs', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-12',
             'purpose': 'Isolates the hamstrings for balanced lower-body strength.',
             'equipment_name': 'Leg Curl Machine', 'equipment_note': 'Machine-guided resistance isolating the hamstrings.',
             'sub_target': 'Hamstrings',
             'instructions': '1. Lie face down on the leg curl machine with the pad positioned just above your heels.\n2. Grip the handles and keep your hips pressed into the bench.\n3. Curl your legs up by bringing your heels toward your glutes.\n4. Squeeze your hamstrings briefly at the top.\n5. Lower back down with control to the starting position.'},
            {'name': 'Calf Raises', 'target_area': 'Legs', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '15-20',
             'purpose': 'Isolates and strengthens the calves.',
             'equipment_name': 'Calf Raise Machine', 'equipment_note': 'Provides adjustable resistance for standing calf raises.',
             'sub_target': 'Calves',
             'instructions': '1. Position your shoulders under the pads with the balls of your feet on the platform, heels hanging off the edge.\n2. Lower your heels below the platform to feel a stretch in your calves.\n3. Push through the balls of your feet to raise your heels as high as possible.\n4. Pause briefly at the top and squeeze your calves.\n5. Lower back down with control and repeat.'},
            {'name': 'Face Pull', 'target_area': 'Back', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
             'purpose': 'Strengthens the upper back and supports shoulder posture.',
             'equipment_name': 'Cable Machine', 'equipment_note': 'Useful for controlled resistance exercises for different muscle groups.',
             'sub_target': 'Upper Back',
             'instructions': '1. Set a rope attachment on a cable machine to upper-chest/face height.\n2. Grip the rope with both hands, palms facing each other.\n3. Pull the rope toward your face, leading with your elbows and flaring them out wide.\n4. Squeeze your upper back and shoulder blades together at the end of the pull.\n5. Return to the starting position with control.'},
            {'name': 'Back Extension', 'target_area': 'Back', 'exercise_type': 'resistance',
             'goal_tags': 'CUT,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
             'purpose': 'Strengthens the lower back (erector spinae) and supports overall spinal stability.',
             'equipment_name': 'Back Extension Bench', 'equipment_note': 'Supports a controlled hip-hinge movement that targets the lower back.',
             'sub_target': 'Lower Back',
             'instructions': '1. Position your hips on the pad of the back extension bench with your feet secured under the footpads.\n2. Cross your arms over your chest and start with your body bent forward at the hips.\n3. Raise your torso up until your body forms a straight line from head to heels.\n4. Squeeze your lower back briefly at the top without hyperextending.\n5. Lower back down with control to the starting position.'},
        ]
        for e in exercises:
            db.session.add(Exercise(**e))
        db.session.commit()

    # ── Stage B — idempotent insert-migration for the four exercises above,
    #    for databases that were already seeded (Exercise.query.count() > 0)
    #    before this stage existed, so the "if Exercise.query.count() == 0"
    #    block above never runs again for them. Matched by exact name, same
    #    pattern as the sub_target backfill/correction migrations below — a
    #    safe no-op once each row exists (including on a fresh install,
    #    where the block above already created them). Runs every startup. ──
    stage_b_new_exercises = [
        {'name': 'Leg Curl', 'target_area': 'Legs', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-12',
         'purpose': 'Isolates the hamstrings for balanced lower-body strength.',
         'equipment_name': 'Leg Curl Machine', 'equipment_note': 'Machine-guided resistance isolating the hamstrings.',
         'sub_target': 'Hamstrings',
         'instructions': '1. Lie face down on the leg curl machine with the pad positioned just above your heels.\n2. Grip the handles and keep your hips pressed into the bench.\n3. Curl your legs up by bringing your heels toward your glutes.\n4. Squeeze your hamstrings briefly at the top.\n5. Lower back down with control to the starting position.'},
        {'name': 'Calf Raises', 'target_area': 'Legs', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '15-20',
         'purpose': 'Isolates and strengthens the calves.',
         'equipment_name': 'Calf Raise Machine', 'equipment_note': 'Provides adjustable resistance for standing calf raises.',
         'sub_target': 'Calves',
         'instructions': '1. Position your shoulders under the pads with the balls of your feet on the platform, heels hanging off the edge.\n2. Lower your heels below the platform to feel a stretch in your calves.\n3. Push through the balls of your feet to raise your heels as high as possible.\n4. Pause briefly at the top and squeeze your calves.\n5. Lower back down with control and repeat.'},
        {'name': 'Face Pull', 'target_area': 'Back', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
         'purpose': 'Strengthens the upper back and supports shoulder posture.',
         'equipment_name': 'Cable Machine', 'equipment_note': 'Useful for controlled resistance exercises for different muscle groups.',
         'sub_target': 'Upper Back',
         'instructions': '1. Set a rope attachment on a cable machine to upper-chest/face height.\n2. Grip the rope with both hands, palms facing each other.\n3. Pull the rope toward your face, leading with your elbows and flaring them out wide.\n4. Squeeze your upper back and shoulder blades together at the end of the pull.\n5. Return to the starting position with control.'},
        {'name': 'Back Extension', 'target_area': 'Back', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
         'purpose': 'Strengthens the lower back (erector spinae) and supports overall spinal stability.',
         'equipment_name': 'Back Extension Bench', 'equipment_note': 'Supports a controlled hip-hinge movement that targets the lower back.',
         'sub_target': 'Lower Back',
         'instructions': '1. Position your hips on the pad of the back extension bench with your feet secured under the footpads.\n2. Cross your arms over your chest and start with your body bent forward at the hips.\n3. Raise your torso up until your body forms a straight line from head to heels.\n4. Squeeze your lower back briefly at the top without hyperextending.\n5. Lower back down with control to the starting position.'},
    ]
    stage_b_added = 0
    for e in stage_b_new_exercises:
        if Exercise.query.filter_by(name=e['name']).first() is None:
            db.session.add(Exercise(**e))
            stage_b_added += 1
    if stage_b_added:
        db.session.commit()
        print(f"Migration: added {stage_b_added} new exercise row(s) for Stage B Legs/Back sub-target coverage")

    # ── Stage C — catalog expansion to close remaining Main Area × Goal and
    #    sub-target gaps left after the strict, no-cross-area-fallback
    #    _pick_day_exercises() fix. Same idempotent per-name pattern as
    #    Stage B: only inserts rows that don't already exist by name, safe
    #    to run every startup, never touches or duplicates existing rows. ──
    stage_c_new_exercises = [
        # -- CHEST --
        {'name': 'Push-Up', 'target_area': 'Chest', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-15',
         'purpose': 'Bodyweight chest, shoulder, and triceps strength with no equipment required.',
         'equipment_name': 'Exercise Mat', 'equipment_note': 'Provides a comfortable, non-slip surface for floor-based exercises.',
         'sub_target': 'Middle Chest',
         'instructions': '1. Start in a plank position with hands slightly wider than shoulder-width.\n2. Keep your body in a straight line from head to heels.\n3. Lower your chest toward the floor by bending your elbows.\n4. Stop just above the floor, keeping your core braced.\n5. Push through your palms to return to the starting position.'},
        {'name': 'Incline Dumbbell Press', 'target_area': 'Chest', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3-4', 'default_reps': '8-12',
         'purpose': 'Emphasizes the upper chest using an incline pressing angle.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Upper Chest',
         'instructions': '1. Set an adjustable bench to a 30-45 degree incline.\n2. Lie back with a dumbbell in each hand at shoulder level.\n3. Press the dumbbells up and slightly inward until your arms are extended.\n4. Pause briefly at the top.\n5. Lower the dumbbells back to shoulder level with control.'},
        {'name': 'Low-to-High Cable Fly', 'target_area': 'Chest', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-15',
         'purpose': 'Isolates the upper chest through an upward fly motion.',
         'equipment_name': 'Cable Machine', 'equipment_note': 'Useful for controlled resistance exercises for different muscle groups.',
         'sub_target': 'Upper Chest',
         'instructions': '1. Set both cable pulleys to the lowest position and grab a handle in each hand.\n2. Stand centered between the pulleys with a slight forward lean.\n3. With a slight bend in your elbows, sweep your hands up and together in front of your upper chest.\n4. Squeeze your chest briefly at the top.\n5. Return with control to the starting position.'},
        {'name': 'Flat Dumbbell Fly', 'target_area': 'Chest', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-12',
         'purpose': 'Isolates the middle chest through a wide arcing motion.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Middle Chest',
         'instructions': '1. Lie flat on a bench holding a dumbbell in each hand above your chest, palms facing in.\n2. With a slight bend in your elbows, lower the dumbbells out to the sides in a wide arc.\n3. Lower until you feel a stretch across your chest.\n4. Bring the dumbbells back up and together over your chest.\n5. Squeeze your chest briefly at the top.'},
        {'name': 'Chest Dip', 'target_area': 'Chest', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '8-12',
         'purpose': 'Targets the lower chest and triceps using bodyweight on parallel bars.',
         'equipment_name': 'Dip Station', 'equipment_note': 'Parallel bars used for bodyweight dips targeting chest and triceps.',
         'sub_target': 'Lower Chest',
         'instructions': '1. Grip the parallel bars and support your body with arms extended.\n2. Lean your torso slightly forward to emphasize the chest.\n3. Lower your body by bending your elbows until you feel a stretch in your chest.\n4. Keep your elbows from flaring out excessively.\n5. Push back up to the starting position.'},
        {'name': 'Decline Push-Up', 'target_area': 'Chest', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '8-15',
         'purpose': 'A bodyweight push-up variation that emphasizes the lower chest.',
         'equipment_name': 'Bench', 'equipment_note': 'A flat/adjustable bench used for pressing and support exercises.',
         'sub_target': 'Lower Chest',
         'instructions': '1. Place your feet on a bench and hands on the floor slightly wider than shoulder-width.\n2. Keep your body in a straight line from head to heels.\n3. Lower your chest toward the floor by bending your elbows.\n4. Stop just above the floor, keeping your core braced.\n5. Push through your palms to return to the starting position.'},
        # -- BACK --
        {'name': 'Pull-Up', 'target_area': 'Back', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '6-10',
         'purpose': 'Builds lat width and overall pulling strength using bodyweight.',
         'equipment_name': 'Pull-Up Bar', 'equipment_note': 'An overhead bar used for bodyweight pulling exercises.',
         'sub_target': 'Lats',
         'instructions': '1. Grip the bar slightly wider than shoulder-width, palms facing away from you.\n2. Hang with your arms fully extended.\n3. Pull your body up by driving your elbows down and back until your chin clears the bar.\n4. Squeeze your lats briefly at the top.\n5. Lower back down with control to a full hang.'},
        {'name': 'Straight-Arm Pulldown', 'target_area': 'Back', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-15',
         'purpose': 'Isolates the lats using a straight-arm pulling motion.',
         'equipment_name': 'Cable Machine', 'equipment_note': 'Useful for controlled resistance exercises for different muscle groups.',
         'sub_target': 'Lats',
         'instructions': '1. Attach a straight or rope bar to a high cable pulley.\n2. Grip the bar with arms extended in front of you at shoulder height.\n3. Keeping your arms straight, pull the bar down toward your thighs.\n4. Squeeze your lats briefly at the bottom.\n5. Return with control to the starting position.'},
        {'name': 'Single-Arm Dumbbell Row', 'target_area': 'Back', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '8-12 per arm',
         'purpose': 'Builds mid-back thickness and unilateral pulling strength.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Middle Back',
         'instructions': '1. Place one knee and hand on a bench for support, holding a dumbbell in the other hand.\n2. Keep your back flat and core braced.\n3. Pull the dumbbell up toward your hip, leading with your elbow.\n4. Squeeze your shoulder blade briefly at the top.\n5. Lower the dumbbell back down with control and repeat, then switch sides.'},
        {'name': 'T-Bar Row', 'target_area': 'Back', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3-4', 'default_reps': '8-12',
         'purpose': 'Builds mid-back thickness using a loaded, supported rowing motion.',
         'equipment_name': 'T-Bar Row Machine', 'equipment_note': 'A landmine or machine setup used for supported barbell rows.',
         'sub_target': 'Middle Back',
         'instructions': '1. Straddle the T-bar row setup and grip the handles with a neutral grip.\n2. Hinge forward at the hips with a flat back.\n3. Pull the handles up toward your torso, leading with your elbows.\n4. Squeeze your shoulder blades together at the top.\n5. Lower back down with control to the starting position.'},
        {'name': 'Reverse Fly', 'target_area': 'Back', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
         'purpose': 'Isolates the upper back and rear shoulders through a reverse flying motion.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Upper Back',
         'instructions': '1. Hinge forward at the hips holding a light dumbbell in each hand, arms hanging down.\n2. Keep a slight bend in your elbows.\n3. Raise your arms out to the sides until they are in line with your shoulders.\n4. Squeeze your upper back briefly at the top.\n5. Lower back down with control.'},
        {'name': 'Band Pull-Apart', 'target_area': 'Back', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '15-20',
         'purpose': 'A beginner-friendly upper-back and posture exercise using a resistance band.',
         'equipment_name': 'Resistance Bands', 'equipment_note': 'Portable resistance useful for beginner-friendly strength exercises.',
         'sub_target': 'Upper Back',
         'instructions': '1. Hold a resistance band with both hands, arms extended in front of you at shoulder height.\n2. Keep your arms straight throughout the movement.\n3. Pull the band apart by moving your hands out to the sides.\n4. Squeeze your shoulder blades together at full stretch.\n5. Return with control to the starting position.'},
        {'name': 'Weighted Back Extension', 'target_area': 'Back', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-15',
         'purpose': 'Strengthens the lower back with added resistance for extra load.',
         'equipment_name': 'Back Extension Bench', 'equipment_note': 'Supports a controlled hip-hinge movement that targets the lower back.',
         'sub_target': 'Lower Back',
         'instructions': '1. Position your hips on the pad of the back extension bench, holding a weight plate against your chest.\n2. Cross your arms over the weight and start bent forward at the hips.\n3. Raise your torso up until your body forms a straight line from head to heels.\n4. Squeeze your lower back briefly at the top without hyperextending.\n5. Lower back down with control to the starting position.'},
        {'name': 'Bird Dog', 'target_area': 'Back', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-12 per side',
         'purpose': 'A beginner-friendly core and lower-back stability exercise.',
         'equipment_name': 'Exercise Mat', 'equipment_note': 'Provides a comfortable, non-slip surface for floor-based exercises.',
         'sub_target': 'Lower Back',
         'instructions': '1. Start on your hands and knees with a neutral spine.\n2. Brace your core and extend one arm forward while extending the opposite leg back.\n3. Keep your hips level and avoid twisting your torso.\n4. Hold briefly, then return to the starting position.\n5. Repeat on the opposite side.'},
        # -- SHOULDERS --
        {'name': 'Arnold Press', 'target_area': 'Shoulders', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '8-12',
         'purpose': 'Builds front shoulder strength through a rotating pressing motion.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Front Deltoids',
         'instructions': '1. Sit or stand holding a dumbbell in each hand at shoulder height, palms facing you.\n2. Press the dumbbells overhead while rotating your palms to face forward.\n3. Fully extend your arms at the top.\n4. Reverse the rotation as you lower the dumbbells back to the starting position.\n5. Repeat for the desired number of reps.'},
        {'name': 'Front Raise', 'target_area': 'Shoulders', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-15',
         'purpose': 'Isolates the front deltoids through a forward raising motion.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Front Deltoids',
         'instructions': '1. Stand holding a dumbbell in each hand in front of your thighs.\n2. Keeping a slight bend in your elbows, raise one or both arms forward to shoulder height.\n3. Pause briefly at the top.\n4. Lower back down with control.\n5. Repeat for the desired number of reps.'},
        {'name': 'Cable Lateral Raise', 'target_area': 'Shoulders', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15 per arm',
         'purpose': 'Isolates the side deltoids with constant cable tension.',
         'equipment_name': 'Cable Machine', 'equipment_note': 'Useful for controlled resistance exercises for different muscle groups.',
         'sub_target': 'Side Deltoids',
         'instructions': '1. Stand sideways to a low cable pulley and grip the handle with the far hand.\n2. Keep a slight bend in your elbow.\n3. Raise your arm out to the side until it reaches shoulder height.\n4. Pause briefly at the top.\n5. Lower back down with control, then switch sides.'},
        {'name': 'Incline Rear Delt Raise', 'target_area': 'Shoulders', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
         'purpose': 'Isolates the rear deltoids using chest-supported positioning.',
         'equipment_name': 'Bench', 'equipment_note': 'A flat/adjustable bench used for pressing and support exercises.',
         'sub_target': 'Rear Deltoids',
         'instructions': '1. Lie face-down on an incline bench holding a dumbbell in each hand.\n2. Let your arms hang straight down with a slight bend in the elbows.\n3. Raise your arms out to the sides until they are in line with your shoulders.\n4. Squeeze your rear shoulders briefly at the top.\n5. Lower back down with control.'},
        {'name': 'Cable Rear Delt Fly', 'target_area': 'Shoulders', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
         'purpose': 'Isolates the rear deltoids with constant cable tension.',
         'equipment_name': 'Cable Machine', 'equipment_note': 'Useful for controlled resistance exercises for different muscle groups.',
         'sub_target': 'Rear Deltoids',
         'instructions': '1. Set two cable pulleys to shoulder height and cross the handles to opposite hands.\n2. Stand centered between the pulleys with arms extended forward.\n3. Pull your arms out and back in a wide arc, leading with your hands.\n4. Squeeze your rear shoulders briefly at the end of the motion.\n5. Return with control to the starting position.'},
        {'name': 'Cable Y-Raise', 'target_area': 'Shoulders', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
         'purpose': 'Targets the rear deltoids and scapular stabilizers through an overhead "Y" raising motion.',
         'equipment_name': 'Cable Machine', 'equipment_note': 'Useful for controlled resistance exercises for different muscle groups.',
         'sub_target': 'Rear Deltoids',
         'instructions': '1. Set a low cable pulley and grip the handle with one hand.\n2. Stand facing away from the machine with a slight forward lean.\n3. Raise your arm diagonally overhead to form a "Y" shape with your body.\n4. Pause briefly at the top, squeezing your rear shoulder and upper back.\n5. Lower back down with control, then switch sides.'},
        # -- ARMS --
        {'name': 'Hammer Curl', 'target_area': 'Arms', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-12',
         'purpose': 'Builds bicep and forearm strength using a neutral grip.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Biceps', 'specific_target': 'Brachialis (Biceps Thickness)',
         'instructions': '1. Stand holding a dumbbell in each hand at your sides, palms facing your body.\n2. Keep your elbows close to your torso.\n3. Curl the dumbbells up toward your shoulders, keeping your palms facing in.\n4. Squeeze your biceps briefly at the top.\n5. Lower back down with control.'},
        {'name': 'Concentration Curl', 'target_area': 'Arms', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-12 per arm',
         'purpose': 'Isolates the biceps using a seated, braced position.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Biceps', 'specific_target': 'Short Head (Biceps Peak)',
         'instructions': '1. Sit on a bench with your legs spread and hold a dumbbell in one hand.\n2. Rest your elbow against the inside of your thigh.\n3. Curl the dumbbell up toward your shoulder.\n4. Squeeze your bicep briefly at the top.\n5. Lower back down with control, then switch sides.'},
        {'name': 'Overhead Triceps Extension', 'target_area': 'Arms', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-12',
         'purpose': 'Isolates the triceps using an overhead extension motion.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Triceps', 'specific_target': 'Long Head',
         'instructions': '1. Stand or sit holding one dumbbell with both hands overhead.\n2. Keep your upper arms close to your head and elbows pointed forward.\n3. Lower the dumbbell behind your head by bending your elbows.\n4. Extend your arms back up to the starting position.\n5. Squeeze your triceps briefly at the top.'},
        {'name': 'Triceps Bench Dip', 'target_area': 'Arms', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-15',
         'purpose': 'A bodyweight exercise that isolates the triceps using a bench.',
         'equipment_name': 'Bench', 'equipment_note': 'A flat/adjustable bench used for pressing and support exercises.',
         'sub_target': 'Triceps', 'specific_target': 'Lateral & Medial Head',
         'instructions': '1. Sit on the edge of a bench with your hands gripping the edge beside your hips.\n2. Walk your feet forward and lower your hips off the bench.\n3. Bend your elbows to lower your body toward the floor.\n4. Keep your elbows pointing backward, not flaring out.\n5. Push through your palms to return to the starting position.'},
        {'name': 'Wrist Curl', 'target_area': 'Arms', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '15-20',
         'purpose': 'Isolates the forearm flexors for grip and forearm strength.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Forearms',
         'instructions': '1. Sit and rest your forearms on your thighs, holding a dumbbell in each hand, palms facing up.\n2. Let your wrists hang off your knees.\n3. Curl your wrists upward as far as comfortable.\n4. Squeeze your forearms briefly at the top.\n5. Lower back down with control.'},
        {'name': 'Reverse Wrist Curl', 'target_area': 'Arms', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '15-20',
         'purpose': 'Isolates the forearm extensors for balanced forearm development.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Forearms',
         'instructions': '1. Sit and rest your forearms on your thighs, holding a dumbbell in each hand, palms facing down.\n2. Let your wrists hang off your knees.\n3. Extend your wrists upward as far as comfortable.\n4. Squeeze your forearms briefly at the top.\n5. Lower back down with control.'},
        {'name': 'Wrist Roller', 'target_area': 'Arms', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '1-2 full rolls',
         'purpose': 'Builds grip and forearm endurance through a rolling motion.',
         'equipment_name': 'Wrist Roller', 'equipment_note': 'A handle-and-cord tool with a hanging weight used to build forearm and grip strength.',
         'sub_target': 'Forearms',
         'instructions': '1. Hold the wrist roller handle with both hands in front of you, arms extended.\n2. Rotate your wrists to wind the cord, lifting the attached weight.\n3. Continue rolling until the weight reaches the top.\n4. Slowly reverse the motion to lower the weight back down with control.\n5. Rest briefly and repeat.'},
        # -- LEGS --
        {'name': 'Romanian Deadlift', 'target_area': 'Legs', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3-4', 'default_reps': '8-12',
         'purpose': 'Builds hamstring and glute strength through a hip-hinge motion.',
         'equipment_name': 'Barbells', 'equipment_note': 'Useful for presses, rows, and other loaded barbell exercises.',
         'sub_target': 'Hamstrings',
         'instructions': '1. Stand holding a barbell in front of your thighs, feet shoulder-width apart.\n2. Keeping a slight bend in your knees, hinge forward at the hips.\n3. Lower the bar along your legs until you feel a stretch in your hamstrings.\n4. Keep your back flat throughout the movement.\n5. Drive your hips forward to return to standing.'},
        {'name': 'Single-Leg Romanian Deadlift', 'target_area': 'Legs', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '8-10 per leg',
         'purpose': 'Builds hamstring strength and balance using a single-leg stance.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Hamstrings',
         'instructions': '1. Stand on one leg holding a dumbbell in the opposite hand.\n2. Hinge forward at the hips while extending your free leg straight back.\n3. Lower the dumbbell toward the floor, keeping your back flat.\n4. Keep a slight bend in your standing knee.\n5. Drive your hips forward to return to standing, then switch sides.'},
        {'name': 'Glute Bridge', 'target_area': 'Legs', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
         'purpose': 'A beginner-friendly bodyweight exercise that isolates the glutes.',
         'equipment_name': 'Exercise Mat', 'equipment_note': 'Provides a comfortable, non-slip surface for floor-based exercises.',
         'sub_target': 'Glutes',
         'instructions': '1. Lie on your back with your knees bent and feet flat on the floor.\n2. Brace your core and squeeze your glutes.\n3. Lift your hips off the floor until your body forms a straight line from shoulders to knees.\n4. Pause briefly at the top.\n5. Lower back down with control.'},
        {'name': 'Hip Thrust', 'target_area': 'Legs', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3-4', 'default_reps': '8-12',
         'purpose': 'Builds glute strength using a loaded, supported hip-extension motion.',
         'equipment_name': 'Bench', 'equipment_note': 'A flat/adjustable bench used for pressing and support exercises.',
         'sub_target': 'Glutes',
         'instructions': '1. Sit on the floor with your upper back resting against a bench, a barbell or weight across your hips.\n2. Plant your feet flat on the floor, knees bent.\n3. Drive through your heels to lift your hips up until your body forms a straight line from shoulders to knees.\n4. Squeeze your glutes briefly at the top.\n5. Lower back down with control.'},
        {'name': 'Bulgarian Split Squat', 'target_area': 'Legs', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '8-12 per leg',
         'purpose': 'Builds single-leg quad and glute strength using a rear-foot-elevated stance.',
         'equipment_name': 'Dumbbells', 'equipment_note': 'Useful for presses, curls, rows, lunges, and other resistance exercises.',
         'sub_target': 'Quadriceps',
         'instructions': '1. Stand a couple of feet in front of a bench, holding a dumbbell in each hand.\n2. Rest the top of one foot on the bench behind you.\n3. Lower your body by bending your front knee until your thigh is roughly parallel to the floor.\n4. Keep your torso upright throughout.\n5. Push through your front foot to return to standing, then switch sides.'},
        {'name': 'Leg Extension', 'target_area': 'Legs', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-15',
         'purpose': 'Isolates the quadriceps using machine-guided resistance.',
         'equipment_name': 'Leg Extension Machine', 'equipment_note': 'Machine-guided resistance isolating the quadriceps.',
         'sub_target': 'Quadriceps',
         'instructions': '1. Sit on the leg extension machine with the pad resting on the front of your lower legs.\n2. Grip the side handles for stability.\n3. Extend your legs until they are straight.\n4. Squeeze your quadriceps briefly at the top.\n5. Lower back down with control.'},
        {'name': 'Seated Calf Raise', 'target_area': 'Legs', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '15-20',
         'purpose': 'Isolates the calves using a seated position.',
         'equipment_name': 'Calf Raise Machine', 'equipment_note': 'Provides adjustable resistance for standing calf raises.',
         'sub_target': 'Calves',
         'instructions': '1. Sit on the seated calf raise machine with the pads resting on your lower thighs.\n2. Place the balls of your feet on the platform, heels hanging off the edge.\n3. Lower your heels below the platform to feel a stretch.\n4. Push through the balls of your feet to raise your heels as high as possible.\n5. Lower back down with control and repeat.'},
        {'name': 'Single-Leg Calf Raise', 'target_area': 'Legs', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15 per leg',
         'purpose': 'A bodyweight calf exercise using a single-leg stance for added intensity.',
         'equipment_name': 'Exercise Mat', 'equipment_note': 'Provides a comfortable, non-slip surface for floor-based exercises.',
         'sub_target': 'Calves',
         'instructions': '1. Stand on one leg on a raised platform or step, holding on for balance.\n2. Lower your heel below the platform to feel a stretch in your calf.\n3. Push through the ball of your foot to raise your heel as high as possible.\n4. Pause briefly at the top.\n5. Lower back down with control, then switch legs.'},
        # -- CORE --
        {'name': 'Weighted Plank', 'target_area': 'Core', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '30-45 sec',
         'purpose': 'Builds core stability and endurance with added resistance.',
         'equipment_name': 'Exercise Mat', 'equipment_note': 'Provides a comfortable, non-slip surface for floor-based exercises.',
         'sub_target': 'Full Core',
         'instructions': '1. Get into a forearm plank position with a weight plate placed on your upper back.\n2. Keep your body in a straight line from head to heels.\n3. Brace your core and avoid letting your hips sag or rise.\n4. Hold the position for the target time.\n5. Lower down and remove the weight to finish.'},
        {'name': 'Cable Crunch', 'target_area': 'Core', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
         'purpose': 'Isolates the upper abs using loaded cable resistance.',
         'equipment_name': 'Cable Machine', 'equipment_note': 'Useful for controlled resistance exercises for different muscle groups.',
         'sub_target': 'Upper Core',
         'instructions': '1. Kneel below a high cable pulley holding a rope attachment beside your head.\n2. Brace your core.\n3. Curl your torso downward, bringing your elbows toward your knees.\n4. Squeeze your abs briefly at the bottom.\n5. Return with control to the starting position.'},
        {'name': 'Hanging Leg Raise', 'target_area': 'Core', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '10-15',
         'purpose': 'Isolates the lower abs using a hanging leg-raising motion.',
         'equipment_name': 'Pull-Up Bar', 'equipment_note': 'An overhead bar used for bodyweight pulling exercises.',
         'sub_target': 'Lower Core',
         'instructions': '1. Hang from a pull-up bar with your arms fully extended.\n2. Brace your core and avoid swinging.\n3. Raise your legs up in front of you, keeping them as straight as comfortable.\n4. Pause briefly at the top.\n5. Lower back down with control to the starting position.'},
        {'name': 'Russian Twist', 'target_area': 'Core', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '15-20 per side',
         'purpose': 'Builds rotational core strength through a twisting motion.',
         'equipment_name': 'Exercise Mat', 'equipment_note': 'Provides a comfortable, non-slip surface for floor-based exercises.',
         'sub_target': 'Full Core',
         'instructions': '1. Sit on the floor with your knees bent and lean back slightly to engage your core.\n2. Lift your feet off the floor if comfortable, or keep them planted.\n3. Rotate your torso to one side, then the other, in a controlled twisting motion.\n4. Keep your core braced throughout.\n5. Continue alternating sides for the target reps.'},
        {'name': 'Ab Wheel Rollout', 'target_area': 'Core', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '8-12',
         'purpose': 'Builds full core strength and stability through a rolling extension motion.',
         'equipment_name': 'Ab Wheel', 'equipment_note': 'A wheel with handles used for rolling core-extension exercises.',
         'sub_target': 'Full Core',
         'instructions': '1. Kneel on a mat holding the ab wheel handles, wheel positioned in front of your knees.\n2. Brace your core.\n3. Slowly roll the wheel forward, extending your body as far as you can control.\n4. Keep your back flat and avoid sagging your hips.\n5. Roll back to the starting position using your core.'},
        {'name': 'Sit-Up', 'target_area': 'Core', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '15-20',
         'purpose': 'A classic bodyweight exercise that targets the upper abs.',
         'equipment_name': 'Exercise Mat', 'equipment_note': 'Provides a comfortable, non-slip surface for floor-based exercises.',
         'sub_target': 'Upper Core',
         'instructions': '1. Lie on your back with your knees bent and feet flat on the floor.\n2. Cross your arms over your chest or place your hands behind your head.\n3. Curl your torso up until your chest is near your knees.\n4. Squeeze your abs briefly at the top.\n5. Lower back down with control to the starting position.'},
        {'name': 'Reverse Crunch', 'target_area': 'Core', 'exercise_type': 'resistance',
         'goal_tags': 'CUT,BULK,MAINTAIN,RECOMP', 'default_sets': '3', 'default_reps': '12-15',
         'purpose': 'Isolates the lower abs using a reverse curling motion.',
         'equipment_name': 'Exercise Mat', 'equipment_note': 'Provides a comfortable, non-slip surface for floor-based exercises.',
         'sub_target': 'Lower Core',
         'instructions': '1. Lie on your back with your knees bent and raised toward your chest.\n2. Place your hands flat on the floor beside you for stability.\n3. Curl your hips off the floor, bringing your knees toward your chest.\n4. Squeeze your lower abs briefly at the top.\n5. Lower back down with control to the starting position.'},
    ]
    stage_c_added = 0
    for e in stage_c_new_exercises:
        if Exercise.query.filter_by(name=e['name']).first() is None:
            db.session.add(Exercise(**e))
            stage_c_added += 1
    if stage_c_added:
        db.session.commit()
        print(f"Migration: added {stage_c_added} new exercise row(s) for Stage C catalog expansion")

    # ── Stage C goal_tags correction — Bicep Curls and Tricep Pushdowns were
    #    originally BULK-only; widened to all four goals so Arms has enough
    #    CUT/MAINTAIN/RECOMP coverage. Idempotent: only updates if the
    #    stored value doesn't already match. ──
    for name in ('Bicep Curls', 'Tricep Pushdowns'):
        ex = Exercise.query.filter_by(name=name).first()
        if ex is not None and ex.goal_tags != 'CUT,BULK,MAINTAIN,RECOMP':
            ex.goal_tags = 'CUT,BULK,MAINTAIN,RECOMP'
            db.session.commit()
            print(f"Migration: widened {name}.goal_tags to CUT,BULK,MAINTAIN,RECOMP")

    # ── Stage D — Level-3 specific_target backfill, scoped to Biceps and
    #    Triceps only for now (standard anatomical head/emphasis split).
    #    Every other exercise's specific_target stays NULL — this is a new,
    #    additive detail layer on top of the existing sub_target field, not
    #    a replacement for it. Idempotent: only sets the value if it isn't
    #    already correct, so this is safe to run on every startup and never
    #    overwrites a value an admin might set differently later. ──
    FITNESS_SPECIFIC_TARGET_BACKFILL = {
        'Bicep Curls':        'Long & Short Head (Overall Biceps)',
        'Hammer Curl':        'Brachialis (Biceps Thickness)',
        'Concentration Curl': 'Short Head (Biceps Peak)',
        'Tricep Pushdowns':            'Lateral Head',
        'Overhead Triceps Extension':  'Long Head',
        'Triceps Bench Dip':           'Lateral & Medial Head',
    }
    for name, specific_target_value in FITNESS_SPECIFIC_TARGET_BACKFILL.items():
        ex = Exercise.query.filter_by(name=name).first()
        if ex is not None and ex.specific_target != specific_target_value:
            ex.specific_target = specific_target_value
            db.session.commit()
            print(f"Migration: set {name}.specific_target = '{specific_target_value}'")


def _run_startup_migrations():
    """db.create_all() only creates brand-new tables — it won't add columns
    to a table that already exists from a previous run. This adds any
    columns introduced after the database was first created, so existing
    installs don't need a manual ALTER TABLE."""
    migrations = [
        ('payments', 'requested_start_date', "ALTER TABLE payments ADD COLUMN requested_start_date DATE NULL"),
        ('payments', 'notified', "ALTER TABLE payments ADD COLUMN notified TINYINT(1) NOT NULL DEFAULT 0"),
        ('payments', 'staff_viewed', "ALTER TABLE payments ADD COLUMN staff_viewed TINYINT(1) NOT NULL DEFAULT 0"),
        ('membership_plans', 'description', "ALTER TABLE membership_plans ADD COLUMN description TEXT NULL"),
        ('membership_plans', 'image_path',  "ALTER TABLE membership_plans ADD COLUMN image_path VARCHAR(255) NULL"),
        ('membership_plans', 'inclusions',  "ALTER TABLE membership_plans ADD COLUMN inclusions TEXT NULL"),
        ('membership_plans', 'sort_order',  "ALTER TABLE membership_plans ADD COLUMN sort_order INT NOT NULL DEFAULT 0"),
        ('gym_services',   'category', "ALTER TABLE gym_services ADD COLUMN category VARCHAR(60) NULL"),
        ('gym_services',   'icon',     "ALTER TABLE gym_services ADD COLUMN icon VARCHAR(8) NULL"),
        ('gym_equipment',  'category', "ALTER TABLE gym_equipment ADD COLUMN category VARCHAR(60) NULL"),
        ('gym_equipment',  'icon',     "ALTER TABLE gym_equipment ADD COLUMN icon VARCHAR(8) NULL"),
        ('gym_equipment',  'is_facility', "ALTER TABLE gym_equipment ADD COLUMN is_facility TINYINT(1) NOT NULL DEFAULT 0"),
        ('users', 'last_seen_announcements_at', "ALTER TABLE users ADD COLUMN last_seen_announcements_at DATETIME NULL"),
        ('coaches', 'fee', "ALTER TABLE coaches ADD COLUMN fee DECIMAL(10,2) NOT NULL DEFAULT 0"),
        # ── Walk-in guests optionally availing a coach for their visit ──
        ('walk_ins', 'wants_coach', "ALTER TABLE walk_ins ADD COLUMN wants_coach TINYINT(1) NOT NULL DEFAULT 0"),
        ('walk_ins', 'coach_name',  "ALTER TABLE walk_ins ADD COLUMN coach_name VARCHAR(60) NULL"),
        ('walk_ins', 'coach_fee',   "ALTER TABLE walk_ins ADD COLUMN coach_fee DECIMAL(10,2) NOT NULL DEFAULT 0"),
        # ── Boxing added as a second walk-in option alongside Daily ──
        ('walk_ins', 'plan_type',   "ALTER TABLE walk_ins ADD COLUMN plan_type VARCHAR(20) NOT NULL DEFAULT 'Daily'"),
        # ── Stage 3 — AI Fitness Goal & Recommendation feature ──
        ('body_goals', 'bmr',              "ALTER TABLE body_goals ADD COLUMN bmr DECIMAL(6,2) NULL"),
        ('body_goals', 'tdee',             "ALTER TABLE body_goals ADD COLUMN tdee DECIMAL(6,2) NULL"),
        ('body_goals', 'calorie_target',   "ALTER TABLE body_goals ADD COLUMN calorie_target INT NULL"),
        ('body_goals', 'protein_target_g', "ALTER TABLE body_goals ADD COLUMN protein_target_g INT NULL"),
        # ── Stage 8 — Workout sub-target + instructions detail ──
        ('exercises', 'sub_target',      "ALTER TABLE exercises ADD COLUMN sub_target VARCHAR(60) NULL"),
        ('exercises', 'specific_target', "ALTER TABLE exercises ADD COLUMN specific_target VARCHAR(60) NULL"),
        ('exercises', 'instructions',    "ALTER TABLE exercises ADD COLUMN instructions TEXT NULL"),
        ('gym_settings', 'terms_content',      "ALTER TABLE gym_settings ADD COLUMN terms_content TEXT NULL"),
        ('gym_settings', 'terms_read_seconds', "ALTER TABLE gym_settings ADD COLUMN terms_read_seconds INT NOT NULL DEFAULT 30"),
        # ── Mandatory profile picture at member self-registration ──
        ('users', 'profile_picture', "ALTER TABLE users ADD COLUMN profile_picture VARCHAR(255) NULL"),
        # ── 7-day cooldown on changing the profile picture ──
        ('users', 'profile_picture_updated_at', "ALTER TABLE users ADD COLUMN profile_picture_updated_at DATETIME NULL"),
        # ── Optional "scan to pay" QR code shown alongside the GCash number ──
        ('gym_settings', 'gcash_qr_path', "ALTER TABLE gym_settings ADD COLUMN gcash_qr_path VARCHAR(255) NULL"),
        # ── Notification bell (announcements + membership reminders) ──
        ('users', 'last_seen_notifications_at', "ALTER TABLE users ADD COLUMN last_seen_notifications_at DATETIME NULL"),
        # ── Up to 3 GCash receipt screenshots per payment (was 1) ──
        ('payments', 'proof_image_path_2', "ALTER TABLE payments ADD COLUMN proof_image_path_2 VARCHAR(255) NULL"),
        ('payments', 'proof_image_path_3', "ALTER TABLE payments ADD COLUMN proof_image_path_3 VARCHAR(255) NULL"),
    ]
    with db.engine.connect() as conn:
        for table, column, ddl in migrations:
            result = conn.execute(text(f"SHOW COLUMNS FROM {table} LIKE '{column}'"))
            if result.fetchone() is None:
                conn.execute(text(ddl))
                conn.commit()
                print(f"Migration: added {table}.{column}")
                if table == 'gym_settings' and column == 'gcash_qr_path':
                    # One-time backfill only, right after the column is
                    # created — so existing installs show a QR immediately
                    # without an admin having to upload one first. This
                    # never runs again on later restarts, so an admin who
                    # later clears the QR (removes it on purpose) won't
                    # have it silently reappear.
                    conn.execute(text(
                        "UPDATE gym_settings SET gcash_qr_path = 'images/gcash-qr.jpg' "
                        "WHERE gcash_qr_path IS NULL"
                    ))
                    conn.commit()
                    print("Migration: seeded default gcash_qr_path for existing settings row(s)")

        # ── Widen food_items.suitable_meal if it's still the original,
        #    too-narrow VARCHAR(20) from an earlier version of this
        #    feature. VARCHAR(20) was too short for combined values like
        #    "breakfast,lunch,snack" (21 chars) — causing a MySQL "Data
        #    too long" error during seeding. This is a metadata-only
        #    MODIFY COLUMN (widening a VARCHAR never touches existing row
        #    data), and is safe to run on every startup: it only ALTERs
        #    when the column is still narrower than needed, so a database
        #    that's already been widened is left alone. ──
        result = conn.execute(text("SHOW COLUMNS FROM food_items LIKE 'suitable_meal'"))
        row = result.fetchone()
        if row is not None:
            type_str = row[1]  # e.g. "varchar(20)"
            current_length = 0
            if '(' in type_str and ')' in type_str:
                try:
                    current_length = int(type_str.split('(')[1].split(')')[0])
                except (ValueError, IndexError):
                    current_length = 0
            if current_length < 40:
                conn.execute(text("ALTER TABLE food_items MODIFY COLUMN suitable_meal VARCHAR(40) NOT NULL"))
                conn.commit()
                print("Migration: widened food_items.suitable_meal to VARCHAR(40)")

        # ── Normalize fitness_profiles.activity_level from the original
        #    5-value vocabulary (sedentary/lightly_active/moderately_active/
        #    very_active/extra_active) to the current 3-tier vocabulary
        #    (low_activity/moderate_activity/high_activity). This is a data
        #    UPDATE, not a schema change — the column was always a plain
        #    VARCHAR, never a MySQL ENUM, so no ALTER TABLE is needed here.
        #    Each UPDATE only touches rows still holding an old value, so
        #    running this on every startup is a safe no-op once every row
        #    has already been normalized — no member needs to redo Step 1,
        #    and no existing data is lost. ──
        r1 = conn.execute(text(
            "UPDATE fitness_profiles SET activity_level = 'low_activity' "
            "WHERE activity_level IN ('sedentary', 'lightly_active')"
        ))
        r2 = conn.execute(text(
            "UPDATE fitness_profiles SET activity_level = 'moderate_activity' "
            "WHERE activity_level = 'moderately_active'"
        ))
        r3 = conn.execute(text(
            "UPDATE fitness_profiles SET activity_level = 'high_activity' "
            "WHERE activity_level IN ('very_active', 'extra_active')"
        ))
        total_normalized = r1.rowcount + r2.rowcount + r3.rowcount
        if total_normalized > 0:
            conn.commit()
            print(f"Migration: normalized {total_normalized} fitness_profiles.activity_level row(s) to the 3-tier vocabulary")

        # ── Indexes on columns that are filtered/sorted/joined on constantly
        #    (payment status, plan lookups, attendance date-range queries).
        #    Missing indexes here were forcing full table scans on every
        #    dashboard load as the amount of data grew — this is what was
        #    making the system feel slower and slower over time. ──
        index_migrations = [
            ('payments',   'idx_payments_plan_id',        'payments',   'plan_id'),
            ('payments',   'idx_payments_status',          'payments',   'status'),
            ('payments',   'idx_payments_recorded_by_id',  'payments',   'recorded_by_id'),
            ('payments',   'idx_payments_paid_at',         'payments',   'paid_at'),
            ('memberships','idx_memberships_plan_id',      'memberships','plan_id'),
            ('attendance', 'idx_attendance_check_in',      'attendance', 'check_in'),
        ]
        for table, index_name, idx_table, column in index_migrations:
            result = conn.execute(text(f"SHOW INDEX FROM {table} WHERE Key_name = '{index_name}'"))
            if result.fetchone() is None:
                conn.execute(text(f"CREATE INDEX {index_name} ON {idx_table} ({column})"))
                conn.commit()
                print(f"Migration: added index {index_name} on {table}.{column}")

    # ── Backfill exercises.sub_target / exercises.instructions on any
    #    exercise row that already existed before this stage (i.e. the
    #    catalog was seeded by an earlier version of the app, so the
    #    ADD COLUMN above left these fields NULL on those rows). Matched
    #    by exercise name against the same curated values used in
    #    seed_default_fitness_catalog() — a plain data UPDATE, not a
    #    schema change, and a no-op once every row is filled in, so it's
    #    safe to run on every startup. ──
    exercise_detail_backfill = {
        'Squats':                {'sub_target': 'Quadriceps',
            'instructions': '1. Set the bar on the squat rack at upper-chest height.\n2. Step under the bar and rest it across your upper back/traps.\n3. Unrack the bar and step back into a shoulder-width stance.\n4. Bend your knees and hips to lower until your thighs are about parallel to the floor, keeping your chest up and back straight.\n5. Push through your heels to return to standing.\n6. Re-rack the bar after your final rep.'},
        'Bench Press':            {'sub_target': 'Middle Chest',
            'instructions': '1. Lie flat on the bench with your eyes under the bar.\n2. Grip the bar slightly wider than shoulder-width.\n3. Unrack the bar and lower it under control to your mid-chest.\n4. Press the bar back up until your arms are extended.\n5. Keep your feet flat on the floor and shoulder blades pulled together throughout.'},
        'Lat Pulldown':           {'sub_target': 'Lats',
            'instructions': '1. Sit at the machine and secure your knees under the pad.\n2. Grip the bar wider than shoulder-width.\n3. Pull the bar down to your upper chest, leading with your elbows.\n4. Squeeze your shoulder blades together at the bottom.\n5. Slowly return the bar to the starting position with control.'},
        'Seated Row':             {'sub_target': 'Middle Back',
            'instructions': '1. Sit at the cable row station with knees slightly bent and feet braced.\n2. Grip the handle and sit up tall with a straight back.\n3. Pull the handle toward your torso, driving your elbows back.\n4. Squeeze your shoulder blades together at the end of the pull.\n5. Extend your arms back out with control to the starting position.'},
        'Shoulder Press':         {'sub_target': 'Front Deltoids',
            'instructions': '1. Sit or stand holding a dumbbell in each hand at shoulder height.\n2. Brace your core and keep your back straight.\n3. Press both dumbbells overhead until your arms are extended.\n4. Pause briefly at the top.\n5. Lower the dumbbells back to shoulder height with control.'},
        'Lunges':                 {'sub_target': 'Glutes',
            'instructions': '1. Stand tall holding a dumbbell in each hand at your sides.\n2. Step forward with one leg.\n3. Lower your hips until both knees are bent at about 90 degrees.\n4. Push through your front heel to return to standing.\n5. Repeat, alternating legs.'},
        'Leg Press':              {'sub_target': 'Quadriceps',
            'instructions': '1. Sit in the leg press machine with feet shoulder-width apart on the platform.\n2. Release the safety catches.\n3. Lower the platform by bending your knees toward your chest, under control.\n4. Push through your heels to extend your legs without locking your knees.\n5. Re-engage the safety catches after your final rep.'},
        'Bicep Curls':            {'sub_target': 'Biceps',
            'instructions': '1. Stand holding a dumbbell in each hand with arms fully extended.\n2. Keep your elbows tucked close to your sides.\n3. Curl the dumbbells up toward your shoulders.\n4. Squeeze your biceps briefly at the top.\n5. Lower the dumbbells back down with control.'},
        'Tricep Pushdowns':       {'sub_target': 'Triceps',
            'instructions': '1. Stand facing a cable machine with a bar or rope attachment set high.\n2. Grip the attachment with elbows tucked at your sides.\n3. Push the attachment down until your arms are fully extended.\n4. Squeeze your triceps briefly at the bottom.\n5. Let the attachment rise back up with control.'},
        'Planks':                 {'sub_target': 'Full Core',
            'instructions': '1. Lie face down and prop yourself up on your forearms and toes.\n2. Keep your elbows directly under your shoulders.\n3. Raise your hips so your body forms a straight line from head to heels.\n4. Brace your core and hold the position without sagging or piking your hips.\n5. Breathe steadily for the target duration.'},
        'Brisk Walking':          {'sub_target': 'Cardiovascular',
            'instructions': '1. Set the treadmill to a brisk, comfortable walking pace.\n2. Stand tall with a natural arm swing.\n3. Walk continuously for the target duration.\n4. Adjust incline/speed slightly if you want more challenge.\n5. Cool down with a slower pace for the last 2-3 minutes.'},
        'Treadmill Jogging':      {'sub_target': 'Cardiovascular',
            'instructions': '1. Warm up with a brisk walk for 2-3 minutes.\n2. Gradually increase the treadmill speed to a light jog.\n3. Maintain a steady jogging pace for the target duration.\n4. Keep your posture upright and breathing steady.\n5. Cool down with a slower walking pace for the last 2-3 minutes.'},
        'Stationary Cycling':     {'sub_target': 'Cardiovascular',
            'instructions': '1. Adjust the seat height so your knee is slightly bent at full pedal extension.\n2. Start pedaling at a light resistance to warm up.\n3. Increase resistance to a moderate, steady level.\n4. Maintain a consistent pace for the target duration.\n5. Cool down by lowering resistance and pace for the last 2-3 minutes.'},
        'Resistance Band Rows':   {'sub_target': 'Middle Back',
            'instructions': '1. Anchor the resistance band at chest height in front of you.\n2. Hold an end in each hand and step back until there is tension in the band.\n3. Pull both handles toward your torso, driving your elbows back.\n4. Squeeze your shoulder blades together at the end of the pull.\n5. Extend your arms back out with control.'},
    }
    backfilled = 0
    for name, detail in exercise_detail_backfill.items():
        row = Exercise.query.filter_by(name=name).first()
        if row is not None and (row.sub_target is None or row.instructions is None):
            row.sub_target = detail['sub_target']
            row.instructions = detail['instructions']
            backfilled += 1
    if backfilled:
        db.session.commit()
        print(f"Migration: backfilled sub_target/instructions on {backfilled} existing exercise row(s)")

    # ── Correct sub_target values that were seeded/backfilled by an earlier
    #    version of this feature with an overly broad or inconsistently
    #    named value (e.g. "Quadriceps & Glutes", "Mid Back"). Matched by
    #    exact current value, so this only touches rows still holding the
    #    old value and is a safe no-op once every row has already been
    #    corrected — same pattern as the activity_level normalization
    #    above. Does not touch instructions text. ──
    sub_target_corrections = [
        ('Squats',                 'Quadriceps & Glutes', 'Quadriceps'),
        ('Lunges',                 'Quadriceps & Glutes', 'Glutes'),
        ('Seated Row',             'Mid Back',             'Middle Back'),
        ('Resistance Band Rows',   'Mid Back',             'Middle Back'),
    ]
    corrected = 0
    for name, old_value, new_value in sub_target_corrections:
        row = Exercise.query.filter_by(name=name, sub_target=old_value).first()
        if row is not None:
            row.sub_target = new_value
            corrected += 1
    if corrected:
        db.session.commit()
        print(f"Migration: corrected sub_target on {corrected} existing exercise row(s)")


def _run_startup_sequence():
    """Everything that must happen against the DB before the app can serve
    requests: create tables, run one-off migrations, and seed default data.
    Runs inside its own retry wrapper (see _startup_with_retries) so a
    transient connection blip (dropped Wi-Fi/VPN, a remote DB briefly not
    responding, etc.) doesn't crash the whole app on startup."""
    db.create_all()
    _run_startup_migrations()
    seed_default_plans()
    seed_default_promos()
    seed_default_coaches()
    seed_default_equipment()
    seed_default_fitness_catalog()
    seed_default_users()
    _get_gym_settings()  # ensures the GCash settings row exists on first boot
    print("Tables created, plans and demo users seeded!")


def _startup_with_retries(attempts=5, base_delay=2):
    """Run _run_startup_sequence(), retrying with exponential backoff on
    connection-level failures (dropped/unreachable MySQL — the
    OperationalError/TimeoutError combo behind errors like WinError 10060)
    instead of letting one blip kill the whole app at boot. Anything that
    isn't a connection problem (bad SQL, bad credentials the DB itself
    rejects, etc.) is not this kind of transient issue, so it's raised
    immediately instead of being retried."""
    for attempt in range(1, attempts + 1):
        try:
            _run_startup_sequence()
            return
        except OperationalError as e:
            db.session.rollback()
            if attempt == attempts:
                print(f"Startup DB sequence failed after {attempts} attempts — giving up.")
                raise
            delay = base_delay * (2 ** (attempt - 1))
            print(f"Startup DB sequence failed (attempt {attempt}/{attempts}): {e}\n"
                  f"Retrying in {delay}s — check that MySQL is running and reachable "
                  f"(DB_HOST={DB_HOST}) if this keeps happening...")
            time.sleep(delay)


if __name__ == '__main__':
    with app.app_context():
        _startup_with_retries()
    # threaded=True lets the dev server handle multiple requests at once
    # instead of one at a time. Without it, every asset a page needs (CSS,
    # JS, fonts, images) gets served sequentially even though the browser
    # requests them all in parallel — which is what was making a simple
    # page refresh feel slow. Not related to debug mode; safe to keep on
    # even after you turn debug off for a real deployment.
    app.run(debug=True, threaded=True)