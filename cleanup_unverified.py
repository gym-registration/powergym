"""Deletes self-registered members who never verified their email within 24 hours.

For production (gunicorn etc.) schedule this with cron / Task Scheduler, e.g. hourly:
    0 * * * *  cd /path/to/BACKUPGYM && python cleanup_unverified.py
(The dev server also runs this sweep itself every hour.)
"""
from app import app, _cleanup_unverified_accounts

if __name__ == '__main__':
    with app.app_context():
        removed = _cleanup_unverified_accounts()
        print(f"Removed {removed} unverified account(s).")
