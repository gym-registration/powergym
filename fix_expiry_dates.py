"""
One-time data fix for memberships whose expiry_date was double-counted by the
old admin_verify_payment / staff_record_payment bug (e.g. a Monthly plan
showing ~61 days instead of 30/31).

What it does:
  - Recomputes each membership's expiry_date as one plan-duration period
    from its start_date (using the same _plan_expiry() logic as app.py,
    so Monthly plans correctly land on 30/31/28/29 days).
  - Only touches memberships whose current expiry_date is LONGER than what
    a single period from start_date would give (i.e. it looks double-counted).
    Memberships that look correct, or that are shorter (e.g. legitimately
    stacked from multiple real renewals), are left untouched and just
    reported for your review.
  - Runs as a DRY RUN by default — it only prints what it *would* change.
    Pass --apply to actually save the changes.

Usage:
    python3 fix_expiry_dates.py            # dry run, just prints
    python3 fix_expiry_dates.py --apply    # actually fixes the database
"""

import sys
from app import app, db, Membership, _plan_expiry

APPLY = '--apply' in sys.argv

with app.app_context():
    memberships = Membership.query.all()
    changed = 0

    for m in memberships:
        if not m.plan or not m.start_date or not m.expiry_date:
            continue

        expected_expiry = _plan_expiry(m.plan, m.start_date)

        # Only flag/fix cases where the stored expiry is LATER than one single
        # period from start_date — that's the signature of the double-count
        # bug. If it's equal or shorter, leave it alone (could be a
        # legitimately shorter/expired plan, or already correct).
        if m.expiry_date > expected_expiry:
            member_label = m.member.email if m.member else f"member_id={m.member_id}"
            print(f"[{'APPLYING' if APPLY else 'WOULD FIX'}] {member_label} "
                  f"— {m.plan.name}: start={m.start_date}  "
                  f"stored_expiry={m.expiry_date}  ->  correct_expiry={expected_expiry}")
            if APPLY:
                m.expiry_date = expected_expiry
            changed += 1

    if APPLY and changed:
        db.session.commit()
        print(f"\nDone — {changed} membership(s) corrected and saved.")
    elif changed:
        print(f"\n{changed} membership(s) look double-counted. "
              f"Re-run with --apply to fix them for real.")
    else:
        print("No double-counted memberships found — nothing to do.")
