from app import app, db, User, Membership, MembershipPlan, _today_manila
from datetime import timedelta

with app.app_context():
    # Find demo member maria
    user = User.query.filter_by(email="maria@email.com").first()
    if not user:
        print("User maria@email.com not found. Running seed...")
        from app import _run_startup_sequence
        _run_startup_sequence()
        user = User.query.filter_by(email="maria@email.com").first()

    plan = MembershipPlan.query.filter_by(name="Monthly").first()
    if not plan:
        plan = MembershipPlan.query.first()

    today = _today_manila()
    expiry = today + timedelta(days=30)

    membership = Membership.query.filter_by(member_id=user.id).first()
    if membership:
        membership.plan_id = plan.id
        membership.start_date = today
        membership.expiry_date = expiry
        membership.status = "active"
    else:
        membership = Membership(
            member_id=user.id,
            plan_id=plan.id,
            start_date=today,
            expiry_date=expiry,
            status="active"
        )
        db.session.add(membership)

    user.status = "active"
    db.session.commit()
    print(f"SUCCESS: {user.email} now has an ACTIVE membership until {expiry}!")
