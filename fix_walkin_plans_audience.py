"""
One-time fix: "Daily" (P100 / 1 day) and "Boxing" (P350 / 1 day) are both
walk-in-only plans by design (see MEMBER_HIDDEN_PLAN_NAMES in app.py —
"both recorded by staff from the Walk In tab"), but both currently have
audience='member', which is why they still show up on the public landing
page even though members can't actually request them from My Membership.

This sets audience='walkin' for both, same mechanism used for any other
staff-only plan. It does NOT touch the "Boxing" GymPromo (P4,000) or any
other plan/promo — only these two specific MembershipPlan rows.

If you already ran fix_boxing_audience.py and applied it, this script will
just report Boxing as already fixed and only need to change Daily.

Runs as a DRY RUN by default — it only prints what it *would* change.
Pass --apply to actually save the changes.

Usage:
    python3 fix_walkin_plans_audience.py            # dry run, just prints
    python3 fix_walkin_plans_audience.py --apply    # actually applies the fix
"""

import sys
from app import app, db, MembershipPlan, AUDIENCE_WALKIN, MEMBER_HIDDEN_PLAN_NAMES

APPLY = '--apply' in sys.argv

with app.app_context():
    changed = 0

    for plan_name in sorted(MEMBER_HIDDEN_PLAN_NAMES):
        plan = MembershipPlan.query.filter(
            db.func.lower(MembershipPlan.name) == plan_name
        ).first()

        if plan is None:
            print(f"No MembershipPlan named '{plan_name}' found — skipping.")
            continue

        if plan.audience == AUDIENCE_WALKIN:
            print(f"'{plan.name}' is already audience='{AUDIENCE_WALKIN}' — nothing to do.")
            continue

        print(f"[{'APPLYING' if APPLY else 'WOULD FIX'}] MembershipPlan '{plan.name}' "
              f"(id={plan.id}, price={plan.price}): "
              f"audience='{plan.audience}' -> audience='{AUDIENCE_WALKIN}'")
        if APPLY:
            plan.audience = AUDIENCE_WALKIN
        changed += 1

    if APPLY and changed:
        db.session.commit()
        print(f"\nDone — {changed} plan(s) updated. Daily and Boxing now only "
              f"appear in the staff Walk In tab, not the public landing page.")
    elif changed:
        print(f"\n{changed} plan(s) need fixing. Re-run with --apply to save for real.")
    else:
        print("\nNothing to do — both plans are already walk-in only.")
