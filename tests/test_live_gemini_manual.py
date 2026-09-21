"""
Manual Live Verification Test for Gemini AI Coach Banner Generation.
Note: This test connects to the live Gemini API and consumes API quota.
Do NOT include this in automated CI/test suites. Run manually only.
"""
import os
import sys
from datetime import date, timedelta
from werkzeug.security import generate_password_hash

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import app, db, User, FitnessProfile, BodyGoal, MembershipPlan, Membership, Exercise, validate_banner

def run_manual_live_test():
    print("=== Manual Live Gemini Test ===")
    model_name = os.environ.get('GEMINI_MODEL', 'gemini-3.5-flash-lite')
    print(f"Target Gemini Model: {model_name}")

    app.config['TESTING'] = True
    client = app.test_client()

    created_uids = []
    try:
        with app.app_context():
            pw_hash = generate_password_hash('Password123!')
            live_user = User(
                first_name='ManualLiveTest',
                last_name='User',
                email='test_manual_live_gemini@example.com',
                password=pw_hash,
                role='member',
                status='approved',
                birthday=date(1998, 5, 20),
            )
            db.session.add(live_user)
            db.session.commit()
            created_uids.append(live_user.id)

            plan = MembershipPlan.query.first()
            m = Membership(
                member_id=live_user.id,
                plan_id=plan.id if plan else 1,
                start_date=date.today() - timedelta(days=1),
                expiry_date=date.today() + timedelta(days=30),
                status='approved',
            )
            db.session.add(m)

            fp = FitnessProfile(
                member_id=live_user.id,
                height_cm=175.0,
                sex='male',
                activity_level='moderate_activity',
                fitness_goal='CHEST',
                calculated_weight=74.0,
            )
            db.session.add(fp)

            bg = BodyGoal(
                member_id=live_user.id,
                current_weight=74.0,
                goal_weight=70.0,
            )
            db.session.add(bg)
            db.session.commit()
            uid = live_user.id

        with client.session_transaction() as sess:
            sess['user_id'] = uid
            sess['role'] = 'member'

        print("Calling live /member/fitness/ai-coach endpoint...")
        res = client.post('/member/fitness/ai-coach', json={})
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        data = res.get_json()
        assert data.get('success') is True
        msg = data.get('message')
        print(f"\n[LIVE GEMINI BANNER RESULT]:\n\"{msg}\"\n")
        assert not msg.startswith("Hey ManualLiveTest! You've got"), "Must not be deterministic fallback"
        print("[PASS] Successfully generated banner from live Gemini API!")

    finally:
        with app.app_context():
            for uid in created_uids:
                FitnessProfile.query.filter_by(member_id=uid).delete()
                BodyGoal.query.filter_by(member_id=uid).delete()
                Membership.query.filter_by(member_id=uid).delete()
                User.query.filter_by(id=uid).delete()
            db.session.commit()
            print("[CLEANUP] Cleaned up manual live test user.")

if __name__ == '__main__':
    run_manual_live_test()
