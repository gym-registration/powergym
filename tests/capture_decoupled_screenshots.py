"""
Capture live screenshots of decoupled Body Goals:
1. live_wizard_decoupled_step2.png: Step 2 showing 4 Primary Objective cards and 7 Workout Focus cards
2. live_hub_decoupled_hero.png: Hub hero showing 'Goal: Cut / Fat Loss • Focus: Chest Workout' with targets and routine
"""
import os
import sys
import time
from datetime import date, timedelta

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import app, db, User, FitnessProfile, BodyGoal, Membership, MembershipPlan, _calculate_fitness_targets
from werkzeug.security import generate_password_hash
from playwright.sync_api import sync_playwright

SCREENSHOTS_DIR = r"C:\Users\Dexter Capili\.gemini\antigravity\brain\5a9cd7ac-e125-40e6-a095-b9f366b5a759"

def capture():
    email = "decoupled_shot_user@test.com"
    with app.app_context():
        u = User.query.filter_by(email=email).first()
        if u:
            FitnessProfile.query.filter_by(member_id=u.id).delete()
            BodyGoal.query.filter_by(member_id=u.id).delete()
            Membership.query.filter_by(member_id=u.id).delete()
            db.session.delete(u)
            db.session.commit()

        u = User(
            email=email,
            first_name="Marcus",
            last_name="Aurelius",
            role="member",
            status="approved",
            password=generate_password_hash("password123"),
            birthday=date(1996, 7, 10)
        )
        db.session.add(u)
        db.session.commit()
        uid = u.id

        plan = MembershipPlan.query.first()
        plan_id = plan.id if plan else 1

        m = Membership(
            member_id=uid,
            plan_id=plan_id,
            start_date=date.today() - timedelta(days=2),
            expiry_date=date.today() + timedelta(days=30),
            status='approved'
        )
        db.session.add(m)
        db.session.commit()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 900})
        # Authenticate via request POST
        context.request.post('http://localhost:5000/login', data={'email': email, 'password': 'password123'})
        page = context.new_page()

        page.goto('http://localhost:5000/member')
        page.wait_for_selector('#member-dashboard-root', timeout=5000)

        # Navigate to Body Goals tab
        page.click('#nav-member-goals')
        page.wait_for_selector('#fw-step-1', state='visible', timeout=5000)
        time.sleep(0.5)

        # Fill Step 1
        page.fill('#fw-height', '180')
        page.fill('#fw-weight', '82')
        page.select_option('#fw-sex', 'male')
        page.select_option('#fw-activity', 'moderate_activity')
        page.click('#fw-step1-btn')
        page.wait_for_selector('#fw-step-2', state='visible', timeout=5000)
        time.sleep(0.5)

        # Select CUT objective and CHEST workout focus
        page.click('.fw-objective-card[data-obj="CUT"]')
        page.click('.workout-goal-card[data-goal="CHEST"]')
        time.sleep(0.5)

        # Take screenshot of Step 2
        step2_path = os.path.join(SCREENSHOTS_DIR, "live_wizard_decoupled_step2.png")
        page.screenshot(path=step2_path)
        print(f"[Captured] {step2_path}")

        # Submit Step 2 to generate plan
        page.click('#fw-step2-btn')
        page.wait_for_selector('#fitness-plan-panel', state='visible', timeout=15000)
        time.sleep(1.0)

        # Take screenshot of Hub Hero card and plan
        hub_path = os.path.join(SCREENSHOTS_DIR, "live_hub_decoupled_hero.png")
        page.screenshot(path=hub_path)
        print(f"[Captured] {hub_path}")

        browser.close()

    # Cleanup
    with app.app_context():
        FitnessProfile.query.filter_by(member_id=uid).delete()
        BodyGoal.query.filter_by(member_id=uid).delete()
        Membership.query.filter_by(member_id=uid).delete()
        u = User.query.get(uid)
        if u:
            db.session.delete(u)
        db.session.commit()
        print("[Cleanup] Finished.")

if __name__ == '__main__':
    capture()
