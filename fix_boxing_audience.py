"""
One-time fix: the "Boxing" MembershipPlan (P350 / 1 day) is currently
audience='member', so it shows on the public landing page and the
member's My Membership request flow. It should be walk-in only, handled
by staff at the front desk, not something members request themselves.

This switches its audience to 'walkin' — same mechanism already used for
other staff-only plans (see AUDIENCE_WALKIN in app.py). It does NOT touch
the separate "Boxing" GymPromo (P4,000) — that's a different table and is
untouched by this script.

Runs as a DRY RUN by default — it only prints what it *would* change.
Pass --apply to actually save the change.

Usage:
    python3 fix_boxing_audience.py            # dry run, just prints
    python3 fix_boxing_audience.py --apply    # actually applies the fix
"""

import sys
from app import app, db, MembershipPlan, AUDIENCE_WALKIN

APPLY = '--apply' in sys.argv

with app.app_context():
    plan = MembershipPlan.query.filter_by(name='Boxing').first()

    if plan is None:
        print("No MembershipPlan named 'Boxing' found — nothing to do.")
    elif plan.audience == AUDIENCE_WALKIN:
        print(f"'Boxing' plan is already audience='{AUDIENCE_WALKIN}' — nothing to do.")
    else:
        print(f"[{'APPLYING' if APPLY else 'WOULD FIX'}] MembershipPlan 'Boxing' "
              f"(id={plan.id}, price={plan.price}): "
              f"audience='{plan.audience}' -> audience='{AUDIENCE_WALKIN}'")
        if APPLY:
            plan.audience = AUDIENCE_WALKIN
            db.session.commit()
            print("\nDone — 'Boxing' now only appears in the staff Walk In tab.")
        else:
            print("\nRe-run with --apply to save this change for real.")
