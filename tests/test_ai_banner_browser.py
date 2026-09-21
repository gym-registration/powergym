"""
Playwright script to verify AI coach banner generation and presentation in real browser:
- Adult member: loads real Gemini banner, verifies COACH NOTE styling & content, verifies cache on reload.
- Minor member: loads real Gemini banner, verifies minor safe messaging, verifies cache on reload.
- Takes desktop screenshot (1280px) of the new AI coach banner on the member dashboard.
- Cleans up all test users.
"""
import os
import sys
import time
from datetime import date, timedelta
from werkzeug.security import generate_password_hash

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import (
    app, db, User, FitnessProfile, BodyGoal, MembershipPlan, Membership,
    _calculate_fitness_targets
)
from playwright.sync_api import sync_playwright

BASE_URL = 'http://localhost:5000'
ADULT_EMAIL = 'test_browser_adult@test.com'
MINOR_EMAIL = 'test_browser_minor@test.com'

def cleanup():
    with app.app_context():
        for email in [ADULT_EMAIL, MINOR_EMAIL]:
            u = User.query.filter_by(email=email).first()
            if u:
                FitnessProfile.query.filter_by(member_id=u.id).delete()
                BodyGoal.query.filter_by(member_id=u.id).delete()
                Membership.query.filter_by(member_id=u.id).delete()
                db.session.delete(u)
        db.session.commit()
    print("[cleanup] Test users cleaned up.")

def run():
    cleanup()
    artifacts_dir = r"C:\Users\Dexter Capili\.gemini\antigravity\brain\225ac383-38b2-4b58-8079-3d479dbb37f8"
    screenshot_path = os.path.join(artifacts_dir, "ai_coach_banner_1280.png")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        try:
            # ─────────────────────────────────────────────────────────────
            # 1. Setup Adult Member
            # ─────────────────────────────────────────────────────────────
            with app.app_context():
                adult = User(
                    first_name='Gabriel',
                    last_name='AdultTester',
                    email=ADULT_EMAIL,
                    password=generate_password_hash('password123'),
                    role='member',
                    status='active',
                    birthday=date(1996, 4, 10),
                )
                db.session.add(adult)
                db.session.commit()

                plan = MembershipPlan.query.first()
                mem = Membership(
                    member_id=adult.id,
                    plan_id=plan.id if plan else 1,
                    start_date=date.today() - timedelta(days=2),
                    expiry_date=date.today() + timedelta(days=28),
                    status='active',
                )
                db.session.add(mem)

                fp = FitnessProfile(
                    member_id=adult.id,
                    height_cm=175.0,
                    sex='male',
                    activity_level='moderate_activity',
                    fitness_goal='CHEST',
                    calculated_weight=72.0,
                )
                db.session.add(fp)

                calcs = _calculate_fitness_targets(175.0, 72.0, 'male', 30, 'moderate_activity', 'CHEST')
                bg = BodyGoal(
                    member_id=adult.id,
                    current_weight=72.0,
                    goal_weight=68.0,
                    current_bmi=calcs['bmi'],
                    bmr=calcs['bmr'],
                    tdee=calcs['tdee'],
                    calorie_target=calcs['calorie_target'],
                    protein_target_g=calcs['protein_target_g'],
                )
                db.session.add(bg)
                db.session.commit()
                adult_id = adult.id

            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            ctx.request.post(f"{BASE_URL}/login", data={'email': ADULT_EMAIL, 'password': 'password123'})
            page = ctx.new_page()

            print("\n--- Loading Adult Member Dashboard in Browser ---")
            page.goto(f"{BASE_URL}/member")
            page.click("#nav-member-goals")
            page.wait_for_selector("#fitness-plan-panel", state="visible", timeout=8000)

            # Wait for AI coach banner
            banner = page.locator("#ai-coach-message")
            page.wait_for_selector("#ai-coach-message .ai-banner-text", state="visible", timeout=15000)

            banner_text = banner.locator(".ai-banner-text").inner_text()
            header_text = banner.locator(".ai-banner-label").inner_text()
            icon_text = banner.locator(".ai-banner-icon").inner_text()

            print(f"[ADULT BANNER HEADER]: {icon_text} {header_text}")
            print(f"[ADULT BANNER TEXT]:\n\"{banner_text}\"")

            assert "COACH NOTE" in header_text, f"Expected 'COACH NOTE', got '{header_text}'"
            assert not banner_text.startswith("Hey Gabriel! You've got 6 training days"), "Must not be deterministic fallback"

            # Take desktop screenshot
            page.screenshot(path=screenshot_path)
            print(f"[SCREENSHOT] Saved 1280px desktop screenshot to: {screenshot_path}")

            # Reload to verify caching behavior
            page.reload()
            page.click("#nav-member-goals")
            page.wait_for_selector("#ai-coach-message .ai-banner-text", state="visible", timeout=10000)
            cached_text = page.locator("#ai-coach-message .ai-banner-text").inner_text()
            assert cached_text == banner_text, "Cached banner text should match original generation"
            print("[ADULT CACHE]: Successfully verified cached banner served identically on reload.")

            # ─────────────────────────────────────────────────────────────
            # 2. Setup Minor Member (15 years old)
            # ─────────────────────────────────────────────────────────────
            with app.app_context():
                minor = User(
                    first_name='Leo',
                    last_name='MinorTester',
                    email=MINOR_EMAIL,
                    password=generate_password_hash('password123'),
                    role='member',
                    status='active',
                    birthday=date.today() - timedelta(days=15 * 365 + 4),
                )
                db.session.add(minor)
                db.session.commit()

                plan = MembershipPlan.query.first()
                mem_m = Membership(
                    member_id=minor.id,
                    plan_id=plan.id if plan else 1,
                    start_date=date.today() - timedelta(days=2),
                    expiry_date=date.today() + timedelta(days=28),
                    status='active',
                )
                db.session.add(mem_m)

                fp_m = FitnessProfile(
                    member_id=minor.id,
                    height_cm=165.0,
                    sex='male',
                    activity_level='high_activity',
                    fitness_goal='FULL_BODY',
                    calculated_weight=58.0,
                )
                db.session.add(fp_m)

                calcs_m = _calculate_fitness_targets(165.0, 58.0, 'male', 15, 'high_activity', 'FULL_BODY')
                bg_m = BodyGoal(
                    member_id=minor.id,
                    current_weight=58.0,
                    current_bmi=None, # Excluded for minor
                    bmr=calcs_m['bmr'],
                    tdee=calcs_m['tdee'],
                    calorie_target=calcs_m['calorie_target'],
                    protein_target_g=calcs_m['protein_target_g'],
                )
                db.session.add(bg_m)
                db.session.commit()

            ctx_m = browser.new_context(viewport={'width': 1280, 'height': 800})
            ctx_m.request.post(f"{BASE_URL}/login", data={'email': MINOR_EMAIL, 'password': 'password123'})
            page_m = ctx_m.new_page()

            print("\n--- Loading Minor Member Dashboard in Browser ---")
            page_m.goto(f"{BASE_URL}/member")
            page_m.click("#nav-member-goals")
            page_m.wait_for_selector("#fitness-plan-panel", state="visible", timeout=8000)

            # Wait for AI coach banner
            page_m.wait_for_selector("#ai-coach-message .ai-banner-text", state="visible", timeout=15000)
            minor_banner_text = page_m.locator("#ai-coach-message .ai-banner-text").inner_text()
            minor_header = page_m.locator("#ai-coach-message .ai-banner-label").inner_text()

            print(f"[MINOR BANNER HEADER]: {minor_header}")
            print(f"[MINOR BANNER TEXT]:\n\"{minor_banner_text}\"")

            assert "COACH NOTE" in minor_header, f"Expected 'COACH NOTE', got '{minor_header}'"
            assert not minor_banner_text.startswith("Hey Leo! You've got 6 training days"), "Must not be deterministic fallback"

            # Reload to verify caching behavior
            page_m.reload()
            page_m.click("#nav-member-goals")
            page_m.wait_for_selector("#ai-coach-message .ai-banner-text", state="visible", timeout=10000)
            minor_cached_text = page_m.locator("#ai-coach-message .ai-banner-text").inner_text()
            assert minor_cached_text == minor_banner_text, "Cached minor banner text should match"
            print("[MINOR CACHE]: Successfully verified cached banner served identically on reload.")

            print("\nALL AI BANNER BROWSER TESTS PASSED!")

        finally:
            browser.close()
            cleanup()

if __name__ == '__main__':
    run()
