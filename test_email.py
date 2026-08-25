"""
Standalone SMTP diagnostic — bypasses Flask entirely and tests your .env
mail settings directly, so we can see the exact real error with nothing
else in the way.

Usage:
    python3 test_email.py
"""
import os
import smtplib
import ssl
from email.mime.text import MIMEText
from dotenv import load_dotenv

load_dotenv()

server_host = os.environ.get('MAIL_SERVER', 'smtp.gmail.com')
port        = int(os.environ.get('MAIL_PORT', 587))
username    = (os.environ.get('MAIL_USERNAME') or '').strip()
password    = (os.environ.get('MAIL_PASSWORD') or '').replace(' ', '').strip()

print("=== Loaded from .env ===")
print(f"MAIL_SERVER   = {server_host}")
print(f"MAIL_PORT     = {port}")
print(f"MAIL_USERNAME = {username!r}")
print(f"MAIL_PASSWORD = {'*' * len(password)}  (length: {len(password)} characters)")
print()

if not username:
    print("PROBLEM: MAIL_USERNAME is empty — .env isn't being loaded, or the key name is wrong.")
    raise SystemExit(1)

if not password:
    print("PROBLEM: MAIL_PASSWORD is empty — .env isn't being loaded, or the key name is wrong.")
    raise SystemExit(1)

if len(password) != 16:
    print(f"WARNING: A Gmail App Password should be exactly 16 characters after removing "
          f"spaces. Yours is {len(password)} characters — double check you copied the whole "
          f"thing and didn't accidentally include quotes or extra characters.")
    print()

to_email = input("Enter an email address to send a real test message to: ").strip()

msg = MIMEText("This is a test email from test_email.py — if you received this, SMTP is working correctly.")
msg['Subject'] = 'Power Gym SMTP Test'
msg['From'] = username
msg['To'] = to_email

print("\nConnecting to Gmail SMTP server...")
try:
    context = ssl.create_default_context()
    with smtplib.SMTP(server_host, port, timeout=15) as server:
        server.set_debuglevel(1)  # prints the raw SMTP conversation
        server.ehlo()
        server.starttls(context=context)
        server.ehlo()
        print("\nLogging in...")
        server.login(username, password)
        print("\nLogin succeeded! Sending test email...")
        server.sendmail(username, [to_email], msg.as_string())
    print(f"\n✅ SUCCESS — test email sent to {to_email}. Check the inbox (and spam folder).")
except smtplib.SMTPAuthenticationError as e:
    print(f"\n❌ AUTHENTICATION FAILED: {e}")
    print("\nThis means Gmail rejected the username/password combination itself.")
    print("Most likely causes:")
    print("  1. The App Password was regenerated/revoked since you copied it")
    print("  2. 2-Step Verification got turned off on this Google account")
    print("  3. There's a typo or extra character in MAIL_USERNAME or MAIL_PASSWORD")
except smtplib.SMTPException as e:
    print(f"\n❌ SMTP ERROR: {type(e).__name__}: {e}")
except (OSError, TimeoutError) as e:
    print(f"\n❌ CONNECTION ERROR: {type(e).__name__}: {e}")
    print("This usually means a network/firewall issue reaching smtp.gmail.com, not a credentials problem.")
except Exception as e:
    print(f"\n❌ UNEXPECTED ERROR: {type(e).__name__}: {e}")
