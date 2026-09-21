"""
Script to capture 5 high-resolution 1280px desktop screenshots for Phase 2.5:
1. Setup Step 1: screenshot_step1.png
2. Adult Hub: screenshot_adult_hub.png
3. Progress Tab (3+ weigh-ins + goal weight set): screenshot_adult_progress.png
4. Minor Hub: screenshot_minor_hub.png
5. Expired Member Notice: screenshot_expired_notice.png
"""
import os
import sys
import time
from datetime import date, timedelta, datetime, timezone
from werkzeug.security import generate_password_hash
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import (
    app, db, User, FitnessProfile, BodyGoal, MembershipPlan, Membership, WeightLog,
    _calculate_fitness_targets
)

BASE_URL = 'http://localhost:5000'
ARTIFACT_DIR = r"C:\Users\Dexter Capili\.gemini\antigravity\brain\225ac383-38b2-4b58-8079-3d479dbb37f8"

EMAILS = {
    'step1': 'test_ss_step1@example.com',
    'adult': 'test_ss_adult@example.com',
    'minor': 'test_ss_minor@example.com',
    'expired': 'test_ss_expired@example.com',
}

def cleanup():
    with app.app_context():
        for email in EMAILS.values():
            u = User.query.filter_by(email=email).first()
            if u:
                WeightLog.query.filter_by(member_id=u.id).delete()
                FitnessProfile.query.filter_by(member_id=u.id).delete()
                BodyGoal.query.filter_by(member_id=u.id).delete()
                Membership.query.filter_by(member_id=u.id).delete()
                db.session.delete(u)
        db.session.commit()
    print("[cleanup] Test screenshot users cleaned up.")

def capture_screenshots():
    cleanup()
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    today = date.today()
    pw_hash = generate_password_hash('Pass1234!')

    with app.app_context():
        plan = MembershipPlan.query.first()
        plan_id = plan.id if plan else 1

        # 1. User for Step 1 Wizard (Active membership, no fitness plan)
        u_step1 = User(
            first_name='Alex', last_name='Wizard', email=EMAILS['step1'],
            password=pw_hash, role='member', status='approved',
            birthday=today - timedelta(days=24 * 365),
        )
        db.session.add(u_step1)
        db.session.commit()
        db.session.add(Membership(member_id=u_step1.id, plan_id=plan_id, start_date=today - timedelta(days=2), expiry_date=today + timedelta(days=28), status='approved'))

        # 2. User for Adult Hub & Progress (Active membership, complete plan, 3 weigh-ins, goal weight set)
        u_adult = User(
            first_name='Marcus', last_name='Adult', email=EMAILS['adult'],
            password=pw_hash, role='member', status='approved',
            birthday=today - timedelta(days=27 * 365),
        )
        db.session.add(u_adult)
        db.session.commit()
        db.session.add(Membership(member_id=u_adult.id, plan_id=plan_id, start_date=today - timedelta(days=5), expiry_date=today + timedelta(days=25), status='approved'))
        fp_adult = FitnessProfile(
            member_id=u_adult.id, height_cm=175.0, sex='male', activity_level='moderate_activity',
            fitness_goal='CHEST', calculated_weight=75.0,
            ai_recommendation="Hey Marcus, let's crush your chest workout goals this week across your six training days and one rest day. Focus on keeping your form tight and controlled through every rep, and remember to breathe steadily."
        )
        db.session.add(fp_adult)
        calcs_a = _calculate_fitness_targets(175.0, 75.0, 'male', 27, 'moderate_activity', 'CHEST')
        bg_adult = BodyGoal(
            member_id=u_adult.id, current_weight=74.2, goal_weight=70.0,
            current_bmi=calcs_a['bmi'], bmr=calcs_a['bmr'], tdee=calcs_a['tdee'],
            calorie_target=calcs_a['calorie_target'], protein_target_g=calcs_a['protein_target_g'],
        )
        db.session.add(bg_adult)
        # 3 weigh-ins on different days
        w1 = WeightLog(member_id=u_adult.id, weight_kg=75.0, log_date=today - timedelta(days=4), logged_at=datetime.now(timezone.utc) - timedelta(days=4))
        w2 = WeightLog(member_id=u_adult.id, weight_kg=74.6, log_date=today - timedelta(days=2), logged_at=datetime.now(timezone.utc) - timedelta(days=2))
        w3 = WeightLog(member_id=u_adult.id, weight_kg=74.2, log_date=today, logged_at=datetime.now(timezone.utc))
        db.session.add_all([w1, w2, w3])

        # 3. User for Minor Hub (15yo, active plan, complete intake)
        u_minor = User(
            first_name='Leo', last_name='Minor', email=EMAILS['minor'],
            password=pw_hash, role='member', status='approved',
            birthday=today - timedelta(days=15 * 365 + 4),
        )
        db.session.add(u_minor)
        db.session.commit()
        db.session.add(Membership(member_id=u_minor.id, plan_id=plan_id, start_date=today - timedelta(days=2), expiry_date=today + timedelta(days=28), status='approved'))
        fp_minor = FitnessProfile(
            member_id=u_minor.id, height_cm=165.0, sex='male', activity_level='high_activity',
            fitness_goal='FULL_BODY', calculated_weight=55.0,
            ai_recommendation="Hey Leo, great to have you locked in for six training days and one well-earned rest day this week as you tackle your full-body routine. Remember to always work out under the supervision of a coach, and focus on moving with steady control."
        )
        db.session.add(fp_minor)
        calcs_m = _calculate_fitness_targets(165.0, 55.0, 'male', 15, 'high_activity', 'FULL_BODY')
        bg_minor = BodyGoal(
            member_id=u_minor.id, current_weight=55.0, goal_weight=None,
            current_bmi=None, bmr=calcs_m['bmr'], tdee=calcs_m['tdee'],
            calorie_target=calcs_m['calorie_target'], protein_target_g=calcs_m['protein_target_g'],
        )
        db.session.add(bg_minor)

        # 4. User for Expired Notice (Expired membership, no active plan)
        u_exp = User(
            first_name='Clara', last_name='Expired', email=EMAILS['expired'],
            password=pw_hash, role='member', status='approved',
            birthday=today - timedelta(days=25 * 365),
        )
        db.session.add(u_exp)
        db.session.commit()
        db.session.add(Membership(member_id=u_exp.id, plan_id=plan_id, start_date=today - timedelta(days=60), expiry_date=today - timedelta(days=5), status='approved'))

        db.session.commit()
        print("[setup] Screenshot test accounts created.")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        try:
            # -------------------------------------------------------------
            # Screenshot 1: Setup Step 1
            # -------------------------------------------------------------
            print("Capturing Screenshot 1: Setup Step 1...")
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            ctx.request.post(f"{BASE_URL}/login", data={'email': EMAILS['step1'], 'password': 'Pass1234!'})
            page = ctx.new_page()
            page.goto(f"{BASE_URL}/member")
            page.click("#nav-member-goals")
            page.wait_for_selector("#fitness-wizard-panel", state="visible")
            time.sleep(1)
            ss_path_1 = os.path.join(ARTIFACT_DIR, "screenshot_step1.png")
            page.screenshot(path=ss_path_1)
            print(f"  Saved: {ss_path_1}")
            ctx.close()

            # -------------------------------------------------------------
            # Screenshot 2: Adult Hub (top of page with all tabs)
            # -------------------------------------------------------------
            print("Capturing Screenshot 2: Adult Hub...")
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            ctx.request.post(f"{BASE_URL}/login", data={'email': EMAILS['adult'], 'password': 'Pass1234!'})
            page = ctx.new_page()
            page.goto(f"{BASE_URL}/member")
            page.click("#nav-member-goals")
            page.wait_for_selector("#fitness-plan-panel", state="visible")
            page.wait_for_selector("#ai-coach-message .ai-banner-text", state="visible")
            time.sleep(1)
            ss_path_2 = os.path.join(ARTIFACT_DIR, "screenshot_adult_hub.png")
            page.screenshot(path=ss_path_2)
            print(f"  Saved: {ss_path_2}")

            # -------------------------------------------------------------
            # Screenshot 3: Adult Progress Tab (3+ weigh-ins + goal weight)
            # -------------------------------------------------------------
            print("Capturing Screenshot 3: Adult Progress Tab...")
            page.click('.fp-tab-btn[data-fp-tab="progress"]')
            page.wait_for_selector("#fp-panel-progress", state="visible", timeout=5000)
            page.wait_for_selector("#fw-chart-container svg circle", state="visible", timeout=5000)
            time.sleep(1)
            ss_path_3 = os.path.join(ARTIFACT_DIR, "screenshot_adult_progress.png")
            page.screenshot(path=ss_path_3)
            print(f"  Saved: {ss_path_3}")
            ctx.close()

            # -------------------------------------------------------------
            # Screenshot 4: Minor Hub
            # -------------------------------------------------------------
            print("Capturing Screenshot 4: Minor Hub...")
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            ctx.request.post(f"{BASE_URL}/login", data={'email': EMAILS['minor'], 'password': 'Pass1234!'})
            page = ctx.new_page()
            page.goto(f"{BASE_URL}/member")
            page.click("#nav-member-goals")
            page.wait_for_selector("#fitness-plan-panel", state="visible")
            page.wait_for_selector("#ai-coach-message .ai-banner-text", state="visible")
            time.sleep(1)
            ss_path_4 = os.path.join(ARTIFACT_DIR, "screenshot_minor_hub.png")
            page.screenshot(path=ss_path_4)
            print(f"  Saved: {ss_path_4}")
            ctx.close()

            # -------------------------------------------------------------
            # Screenshot 5: Expired Member Notice
            # -------------------------------------------------------------
            print("Capturing Screenshot 5: Expired Member Notice...")
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            ctx.request.post(f"{BASE_URL}/login", data={'email': EMAILS['expired'], 'password': 'Pass1234!'})
            page = ctx.new_page()
            page.goto(f"{BASE_URL}/member")
            page.click("#nav-member-goals")
            page.wait_for_selector("#fitness-wizard-panel", state="visible")
            page.wait_for_selector(".fw-subscription-notice", state="visible")
            time.sleep(1)
            ss_path_5 = os.path.join(ARTIFACT_DIR, "screenshot_expired_notice.png")
            page.screenshot(path=ss_path_5)
            print(f"  Saved: {ss_path_5}")
            ctx.close()

            print("\nALL 5 SCREENSHOTS CAPTURED SUCCESSFULLY!")

        finally:
            browser.close()
            cleanup()

if __name__ == '__main__':
    capture_screenshots()
