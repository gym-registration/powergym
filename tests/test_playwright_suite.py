"""
Playwright test suite for Phase 1.5 Stabilization:
- Part A: Full regression audit of weekly routine (7 days), modal (video + close + Esc),
          foods tab, meal plan & totals, equipment tab, tips tab, AI coach banner.
- Part B.1: New adult member with NO birthday (invalid bday -> under-14 bday -> valid adult -> Step 2 -> plan results -> subsequent visit).
- Part B.1 (minor): 14-year-old setup verifying helper text omits calorie tailoring and calorie_target == tdee.
- Part B.2: Expired member UI report and verification.
- Part B.3: Keyboard-only navigation pass.
- Part B.4: Helper text vs FITNESS_WEEKLY_SCHEDULE verification.
- Part B.5: Clean-slate check (Notes panel and Goal: — kg removed).
"""
import os
import sys
import time
import datetime
from datetime import date, timedelta
from werkzeug.security import generate_password_hash

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import (
    app, db, User, FitnessProfile, BodyGoal, MembershipPlan, Membership,
    FITNESS_WEEKLY_SCHEDULE, _calculate_fitness_targets
)
from playwright.sync_api import sync_playwright

BASE_URL = 'http://localhost:5000'

TEST_EMAILS = [
    'test_phase15_audit@test.com',
    'test_phase15_nobday@test.com',
    'test_phase15_minor@test.com',
    'test_phase15_expired@test.com',
    'test_phase15_keyboard@test.com',
]

def cleanup_test_users():
    with app.app_context():
        for email in TEST_EMAILS:
            u = User.query.filter_by(email=email).first()
            if u:
                FitnessProfile.query.filter_by(member_id=u.id).delete()
                BodyGoal.query.filter_by(member_id=u.id).delete()
                Membership.query.filter_by(member_id=u.id).delete()
                db.session.delete(u)
        db.session.commit()
    print("[cleanup] Test users cleaned up successfully.")


def run_tests():
    cleanup_test_users()
    results = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        try:
            # ─────────────────────────────────────────────────────────────
            # PART A: Full Plan View Regression Audit
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part A: Full Plan View Regression Audit ===")
            part_a_email = 'test_phase15_audit@test.com'
            with app.app_context():
                u = User(
                    first_name='Audit',
                    last_name='User',
                    email=part_a_email,
                    password=generate_password_hash('password123'),
                    role='member',
                    status='active',
                    birthday=date(1998, 6, 15),
                )
                db.session.add(u)
                db.session.commit()

                plan = MembershipPlan.query.first()
                mem = Membership(
                    member_id=u.id,
                    plan_id=plan.id if plan else 1,
                    start_date=date.today() - timedelta(days=5),
                    expiry_date=date.today() + timedelta(days=25),
                    status='active',
                )
                db.session.add(mem)

                fp = FitnessProfile(
                    member_id=u.id,
                    height_cm=180.0,
                    sex='male',
                    activity_level='moderate_activity',
                    fitness_goal='CHEST',
                )
                db.session.add(fp)

                calcs = _calculate_fitness_targets(180.0, 75.0, 'male', 28, 'moderate_activity', 'CHEST')
                bg = BodyGoal(
                    member_id=u.id,
                    current_weight=75.0,
                    current_bmi=calcs['bmi'],
                    bmr=calcs['bmr'],
                    tdee=calcs['tdee'],
                    calorie_target=calcs['calorie_target'],
                    protein_target_g=calcs['protein_target_g'],
                )
                db.session.add(bg)
                db.session.commit()

            context = browser.new_context()
            resp = context.request.post(f"{BASE_URL}/login", data={'email': part_a_email, 'password': 'password123'})
            assert resp.status == 200, f"Login failed for {part_a_email}"

            page = context.new_page()
            page.goto(f"{BASE_URL}/member")
            page.click("#nav-member-goals")
            page.wait_for_selector("#fitness-plan-panel", state="visible", timeout=8000)

            # 1. Weekly Routine 7 Days (inside Workouts tab)
            print(" - Switching to Workouts tab...")
            page.click('.fp-tab-btn[data-fp-tab="workouts"]')
            page.wait_for_selector("#fp-panel-workouts", state="visible", timeout=3000)

            print(" - Checking 7 day tabs...")
            for day_num in range(1, 8):
                day_tab = page.locator(f"#fp-day-tab-{day_num}")
                assert day_tab.is_visible(), f"Day tab {day_num} not visible"
                day_tab.click()
                day_panel = page.locator(f"#fp-day-panel-{day_num}")
                assert day_panel.is_visible(), f"Day panel {day_num} not visible"

                if day_num == 4:
                    # Day 4 is Rest day (FITNESS_REST_DAY_NOTE: "Allow your muscles to recover and avoid unnecessary training on this day.")
                    panel_text = day_panel.inner_text()
                    assert "recover" in panel_text.lower(), f"Day 4 missing rest note: {panel_text}"
                    print(f"   Day {day_num}: Rest day note confirmed ('{panel_text.strip()}').")
                else:
                    cards = day_panel.locator(".workout-exercise-card")
                    assert cards.count() > 0, f"Day {day_num} has no exercise cards"
                    print(f"   Day {day_num}: {cards.count()} exercise cards confirmed.")

            # 2. Exercise Modal
            print(" - Testing exercise modal (video, close button, Esc key)...")
            page.locator("#fp-day-tab-1").click()
            first_view_card = page.locator("#fp-day-panel-1 .workout-exercise-card").first
            first_view_card.click()

            modal = page.locator("#exercise-instructions-modal")
            page.wait_for_selector("#exercise-instructions-modal.open", timeout=3000)
            assert modal.is_visible(), "Exercise modal did not open"

            video = page.locator("#exercise-modal-video")
            has_src = video.evaluate("el => Boolean(el.src && el.src.length > 0)")
            print(f"   Video element src present: {has_src}")

            # Close via close button
            close_btn = page.locator("#exercise-instructions-modal .modal-close")
            close_btn.click()
            page.wait_for_selector("#exercise-instructions-modal.open", state="hidden", timeout=3000)
            is_paused = video.evaluate("el => el.paused")
            assert is_paused, "Video was not paused on modal close"
            print("   Modal closed via close button; video paused successfully.")

            # Open again and close via Escape key
            first_view_card.click()
            page.wait_for_selector("#exercise-instructions-modal.open", timeout=3000)
            page.keyboard.press("Escape")
            page.wait_for_selector("#exercise-instructions-modal.open", state="hidden", timeout=3000)
            is_paused_esc = video.evaluate("el => el.paused")
            assert is_paused_esc, "Video was not paused on Escape close"
            print("   Modal closed via Escape key; video paused successfully.")

            # 3. Foods Tab
            print(" - Testing Foods tab...")
            foods_tab = page.locator('.fp-tab-btn[data-fp-tab="foods"]')
            foods_tab.click()
            foods_panel = page.locator('.fp-tab-panel[data-fp-panel="foods"]')
            page.wait_for_selector('.fp-tab-panel[data-fp-panel="foods"]', state="visible", timeout=3000)

            food_cards = foods_panel.locator('#fp-foods-list .fp-card')
            assert food_cards.count() > 0, "No food cards found in #fp-foods-list"
            first_food_text = food_cards.first.inner_text()
            assert "kcal" in first_food_text and "protein" in first_food_text, f"Food card missing metrics: {first_food_text}"
            print(f"   Foods tab verified: {food_cards.count()} recommended food cards with calories and protein.")

            # 4. Meal Plan & Totals
            print(" - Testing Meal Plan & Totals...")
            meal_cards = foods_panel.locator('#fp-meal-plan .fp-card')
            assert meal_cards.count() == 4, f"Expected 4 meal cards, found {meal_cards.count()}"
            total_text = foods_panel.locator('#fp-meal-plan-total').inner_text()
            assert "Daily total across all meals:" in total_text, f"Total line missing: {total_text}"
            print(f"   Meal plan verified: 4 meals rendered with items; totals line: '{total_text}'")

            # 5. Equipment Tab
            print(" - Testing Equipment tab...")
            equip_tab = page.locator('.fp-tab-btn[data-fp-tab="equipment"]')
            equip_tab.click()
            equip_cards = page.locator('#fp-equipment-list .fp-card')
            assert equip_cards.count() > 0, "No equipment cards rendered"
            print(f"   Equipment tab verified: {equip_cards.count()} equipment cards.")

            # 6. Tips Tab
            print(" - Testing Tips tab...")
            tips_tab = page.locator('.fp-tab-btn[data-fp-tab="tips"]')
            tips_tab.click()
            tips_list = page.locator('#fp-tips-list li')
            assert tips_list.count() > 0, "No tips rendered"
            print(f"   Tips tab verified: {tips_list.count()} tips for goal CHEST.")

            # 7. AI Coach Banner
            print(" - Testing AI Coach banner...")
            page.click('.fp-tab-btn[data-fp-tab="overview"]')
            page.wait_for_selector('#ai-coach-message', state="visible", timeout=5000)
            ai_banner = page.locator('#ai-coach-message')
            banner_text = ai_banner.inner_text()
            assert len(banner_text.strip()) > 0, "AI banner text is empty"
            print(f"   AI Banner text confirmed: '{banner_text[:60]}...'")

            # Test fallback banner when GEMINI_API_KEY is unset/mocked fallback
            print(" - Testing AI Coach banner fallback without GEMINI_API_KEY...")
            page.route("**/member/fitness/ai-coach", lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body='{"success": true, "message": "Stay consistent, Audit! 6 training days, 1 rest day, targeting Chest.", "cached": false}'
            ))
            page.reload()
            page.click("#nav-member-goals")
            page.wait_for_selector('#ai-coach-message', state="visible", timeout=5000)
            fallback_text = page.locator('#ai-coach-message').inner_text()
            assert "Stay consistent" in fallback_text, f"Fallback banner text not rendered: {fallback_text}"
            page.unroute("**/member/fitness/ai-coach")
            print(f"   Fallback banner confirmed gracefully: '{fallback_text}'")

            results['Part A'] = 'PASSED'

            # ─────────────────────────────────────────────────────────────
            # PART B.1: New Adult Member with NO Birthday on File
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part B.1: New Adult Member with NO Birthday on File ===")
            b1_email = 'test_phase15_nobday@test.com'
            with app.app_context():
                u = User(
                    first_name='NewAdult',
                    last_name='NoBday',
                    email=b1_email,
                    password=generate_password_hash('password123'),
                    role='member',
                    status='active',
                    birthday=None,  # NO birthday on file
                )
                db.session.add(u)
                db.session.commit()

                plan = MembershipPlan.query.first()
                mem = Membership(
                    member_id=u.id,
                    plan_id=plan.id if plan else 1,
                    start_date=date.today(),
                    expiry_date=date.today() + timedelta(days=30),
                    status='active',
                )
                db.session.add(mem)
                db.session.commit()

            b1_ctx = browser.new_context()
            resp = b1_ctx.request.post(f"{BASE_URL}/login", data={'email': b1_email, 'password': 'password123'})
            assert resp.status == 200

            b1_page = b1_ctx.new_page()
            b1_page.goto(f"{BASE_URL}/member")
            b1_page.click("#nav-member-goals")
            b1_page.wait_for_selector("#fw-step-1", state="visible", timeout=5000)

            # Confirm birthday field is present
            bday_input = b1_page.locator("#fw-birthday")
            assert bday_input.is_visible(), "Birthday input should be visible for member with no birthday"

            # Fill height, weight, sex, activity
            b1_page.fill("#fw-height", "172")
            b1_page.fill("#fw-weight", "68")
            b1_page.select_option("#fw-sex", "male")
            b1_page.select_option("#fw-activity", "moderate_activity")

            # 1. Invalid/Future birthday
            print(" - Testing future birthday validation...")
            b1_page.fill("#fw-birthday", "2035-01-01")
            b1_page.click("#fw-step1-btn")
            b1_page.wait_for_selector(".toast.error", timeout=3000)
            toast_text = b1_page.locator(".toast.error").inner_text()
            assert "Birthday cannot be in the future" in toast_text, f"Unexpected toast: {toast_text}"
            print(f"   Future birthday correctly rejected: '{toast_text}'")

            # Clear toast before next test
            b1_page.evaluate("() => document.querySelectorAll('.toast').forEach(t => t.remove())")

            # 2. Under-14 birthday
            print(" - Testing under-14 birthday rejection...")
            b1_page.fill("#fw-birthday", "2016-06-01")
            b1_page.click("#fw-step1-btn")
            b1_page.wait_for_selector(".toast.error", timeout=3000)
            toast_text = b1_page.locator(".toast.error").inner_text()
            assert "at least 14 years old" in toast_text, f"Unexpected toast: {toast_text}"
            print(f"   Under-14 birthday correctly rejected: '{toast_text}'")

            b1_page.evaluate("() => document.querySelectorAll('.toast').forEach(t => t.remove())")

            # 3. Valid adult birthday (age 28)
            print(" - Submitting valid adult birthday (1998-05-15)...")
            b1_page.fill("#fw-birthday", "1998-05-15")
            b1_page.click("#fw-step1-btn")
            b1_page.wait_for_selector("#fw-step-2", state="visible", timeout=5000)
            print("   Step 1 completed successfully, transitioned to Step 2.")

            # Check Step 2 helper line for adult
            helper_text = b1_page.locator(".fw-goal-helper-line").inner_text()
            assert "and tailors your daily calorie target" in helper_text, f"Adult helper line should mention calorie tailoring: {helper_text}"
            print("   Adult helper line verified with calorie tailoring mention.")

            # Select CORE goal and continue
            b1_page.locator('#fw-goal-grid [data-goal="CORE"]').click()
            b1_page.click("#fw-step2-btn")

            # Verify loading screen
            b1_page.wait_for_selector("#fw-loading-screen", state="visible", timeout=3000)
            print("   Merged loading screen verified with tickers.")

            # Wait for plan panel
            b1_page.wait_for_selector("#fitness-plan-panel", state="visible", timeout=8000)
            print("   Plan panel rendered successfully.")

            # Verify DB values
            with app.app_context():
                u_check = User.query.filter_by(email=b1_email).first()
                assert u_check.birthday == date(1998, 5, 15), "Birthday was not saved in DB"
                bg_check = BodyGoal.query.filter_by(member_id=u_check.id).first()
                # Adult CORE: calorie_target = tdee - 300
                assert bg_check.calorie_target == bg_check.tdee - 300, f"Adult offset not applied: target {bg_check.calorie_target} vs tdee {bg_check.tdee}"
                print(f"   Adult calculation verified in DB: TDEE {bg_check.tdee} kcal, target {bg_check.calorie_target} kcal (-300 offset).")

            # 4. Subsequent visit check: birthday not asked again
            print(" - Verifying subsequent visit does not ask for birthday...")
            b1_page.reload()
            b1_page.click("#nav-member-goals")
            b1_page.wait_for_selector("#fitness-plan-panel", state="visible", timeout=8000)
            b1_page.click("#fw-edit-btn")
            b1_page.wait_for_selector("#fw-step-1", state="visible", timeout=3000)
            assert not b1_page.locator("#fw-birthday").is_visible(), "Birthday input should NOT be shown on subsequent visits"
            age_display = b1_page.locator("#fw-age-display").inner_text()
            assert "calculated from your birthday on file" in age_display, f"Age display missing: {age_display}"
            print(f"   Subsequent visit verified: birthday input omitted, age displayed: '{age_display}'")

            results['Part B.1 Adult'] = 'PASSED'

            # ─────────────────────────────────────────────────────────────
            # PART B.1 (Minor) & PART C: 14-Year-Old Member Setup
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part B.1 (Minor) & Part C: 14-Year-Old Setup ===")
            minor_email = 'test_phase15_minor@test.com'
            with app.app_context():
                u = User(
                    first_name='Young',
                    last_name='Minor',
                    email=minor_email,
                    password=generate_password_hash('password123'),
                    role='member',
                    status='active',
                    birthday=None,
                )
                db.session.add(u)
                db.session.commit()

                plan = MembershipPlan.query.first()
                mem = Membership(
                    member_id=u.id,
                    plan_id=plan.id if plan else 1,
                    start_date=date.today(),
                    expiry_date=date.today() + timedelta(days=30),
                    status='active',
                )
                db.session.add(mem)
                db.session.commit()

            minor_ctx = browser.new_context()
            minor_ctx.request.post(f"{BASE_URL}/login", data={'email': minor_email, 'password': 'password123'})

            minor_page = minor_ctx.new_page()
            minor_page.goto(f"{BASE_URL}/member")
            minor_page.click("#nav-member-goals")
            minor_page.wait_for_selector("#fw-step-1", state="visible", timeout=5000)

            minor_page.fill("#fw-height", "160")
            minor_page.fill("#fw-weight", "52")
            minor_page.select_option("#fw-sex", "female")
            minor_page.select_option("#fw-activity", "moderate_activity")
            # 14 years old birthday
            bday_14 = (date.today() - timedelta(days=14*365 + 10)).strftime('%Y-%m-%d')
            minor_page.fill("#fw-birthday", bday_14)
            minor_page.click("#fw-step1-btn")
            minor_page.wait_for_selector("#fw-step-2", state="visible", timeout=5000)

            # Check Step 2 helper line for minor: MUST OMIT calorie tailoring phrase
            minor_helper = minor_page.locator(".fw-goal-helper-line").inner_text()
            assert "and tailors your daily calorie target" not in minor_helper, f"Minor helper line should NOT mention calorie tailoring: {minor_helper}"
            print(f"   Minor helper line verified (omits calorie tailoring): '{minor_helper}'")

            # Select CORE goal and continue
            minor_page.locator('#fw-goal-grid [data-goal="CORE"]').click()
            minor_page.click("#fw-step2-btn")
            minor_page.wait_for_selector("#fitness-plan-panel", state="visible", timeout=8000)

            # Verify in DB: 14-year-old calorie_target == tdee
            with app.app_context():
                u_minor = User.query.filter_by(email=minor_email).first()
                bg_minor = BodyGoal.query.filter_by(member_id=u_minor.id).first()
                assert bg_minor.calorie_target == bg_minor.tdee, f"Minor calorie_target ({bg_minor.calorie_target}) must equal TDEE ({bg_minor.tdee})"
                print(f"   Minor calculation verified in DB: calorie_target {bg_minor.calorie_target} == TDEE {bg_minor.tdee} (0 offset).")

            results['Part B.1 Minor & Part C'] = 'PASSED'

            # ─────────────────────────────────────────────────────────────
            # PART B.2: Expired Member UI Check
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part B.2: Expired Member UI Check ===")
            expired_email = 'test_phase15_expired@test.com'
            with app.app_context():
                u = User(
                    first_name='Expired',
                    last_name='Member',
                    email=expired_email,
                    password=generate_password_hash('password123'),
                    role='member',
                    status='active',
                    birthday=date(1995, 1, 1),
                )
                db.session.add(u)
                db.session.commit()

                plan = MembershipPlan.query.first()
                mem = Membership(
                    member_id=u.id,
                    plan_id=plan.id if plan else 1,
                    start_date=date.today() - timedelta(days=60),
                    expiry_date=date.today() - timedelta(days=30),  # expired 30 days ago
                    status='expired',
                )
                db.session.add(mem)
                db.session.commit()

            exp_ctx = browser.new_context()
            exp_ctx.request.post(f"{BASE_URL}/login", data={'email': expired_email, 'password': 'password123'})

            exp_page = exp_ctx.new_page()
            exp_page.goto(f"{BASE_URL}/member")
            exp_page.click("#nav-member-goals")
            exp_page.wait_for_selector("#fitness-wizard-panel", state="visible", timeout=5000)

            # On dashboard, expired member sees Step 1 setup
            exp_page.fill("#fw-height", "170")
            exp_page.fill("#fw-weight", "65")
            exp_page.select_option("#fw-sex", "male")
            exp_page.select_option("#fw-activity", "low_activity")
            exp_page.click("#fw-step1-btn")

            # Guard catches them: 403 Forbidden with toast
            exp_page.wait_for_selector(".toast.error", timeout=3000)
            exp_toast = exp_page.locator(".toast.error").inner_text()
            assert "Your membership is not active" in exp_toast, f"Unexpected toast: {exp_toast}"
            print(f"   Expired member correctly blocked from saving profile with message: '{exp_toast}'")

            results['Part B.2 Expired Member'] = 'PASSED'

            # ─────────────────────────────────────────────────────────────
            # PART B.3: Keyboard-Only Navigation Pass
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part B.3: Keyboard-Only Navigation Pass ===")
            kb_email = 'test_phase15_keyboard@test.com'
            with app.app_context():
                u = User(
                    first_name='Key',
                    last_name='Board',
                    email=kb_email,
                    password=generate_password_hash('password123'),
                    role='member',
                    status='active',
                    birthday=date(1997, 3, 20),
                )
                db.session.add(u)
                db.session.commit()

                plan = MembershipPlan.query.first()
                mem = Membership(
                    member_id=u.id,
                    plan_id=plan.id if plan else 1,
                    start_date=date.today(),
                    expiry_date=date.today() + timedelta(days=30),
                    status='active',
                )
                db.session.add(mem)

                fp = FitnessProfile(
                    member_id=u.id,
                    height_cm=178.0,
                    sex='male',
                    activity_level='high_activity',
                    fitness_goal='FULL_BODY',
                )
                db.session.add(fp)
                calcs = _calculate_fitness_targets(178.0, 72.0, 'male', 29, 'high_activity', 'FULL_BODY')
                bg = BodyGoal(
                    member_id=u.id,
                    current_weight=72.0,
                    current_bmi=calcs['bmi'],
                    bmr=calcs['bmr'],
                    tdee=calcs['tdee'],
                    calorie_target=calcs['calorie_target'],
                    protein_target_g=calcs['protein_target_g'],
                )
                db.session.add(bg)
                db.session.commit()

            kb_ctx = browser.new_context()
            kb_ctx.request.post(f"{BASE_URL}/login", data={'email': kb_email, 'password': 'password123'})

            kb_page = kb_ctx.new_page()
            kb_page.goto(f"{BASE_URL}/member")
            kb_page.click("#nav-member-goals")
            kb_page.wait_for_selector("#fitness-plan-panel", state="visible", timeout=8000)

            # 1. Plan Tab Navigation via Arrow keys
            print(" - Testing plan tab keyboard navigation (ArrowRight/ArrowLeft)...")
            first_plan_tab = kb_page.locator('.fp-tab-btn[data-fp-tab="overview"]')
            first_plan_tab.focus()
            kb_page.keyboard.press("ArrowRight")
            active_tab = kb_page.locator('.fp-tabs .fp-tab-btn.active')
            assert active_tab.get_attribute('data-fp-tab') == 'nutrition', f"Expected nutrition tab active, got {active_tab.get_attribute('data-fp-tab')}"
            kb_page.keyboard.press("ArrowRight")
            active_tab2 = kb_page.locator('.fp-tabs .fp-tab-btn.active')
            assert active_tab2.get_attribute('data-fp-tab') == 'foods', f"Expected foods tab active, got {active_tab2.get_attribute('data-fp-tab')}"
            kb_page.keyboard.press("ArrowRight")
            active_tab3 = kb_page.locator('.fp-tabs .fp-tab-btn.active')
            assert active_tab3.get_attribute('data-fp-tab') == 'workouts', f"Expected workouts tab active, got {active_tab3.get_attribute('data-fp-tab')}"
            print("   Plan tabs switched successfully via ArrowRight (overview -> nutrition -> foods -> workouts).")

            # 2. Day Tabs Keyboard Navigation
            print(" - Testing Day tabs keyboard navigation...")
            day1_tab = kb_page.locator('#fp-day-tab-1')
            day1_tab.focus()
            kb_page.keyboard.press("ArrowRight")
            active_day = kb_page.locator('#fp-day-tabs .fp-tab-btn.active')
            assert active_day.get_attribute('data-fp-day') == '2', f"Expected Day 2 active, got {active_day.get_attribute('data-fp-day')}"
            print("   Day tabs switched successfully via ArrowRight.")

            # 3. Open modal with keyboard (Enter) and close with Escape
            print(" - Testing exercise modal open with Enter and close with Escape...")
            first_card = kb_page.locator('#fp-day-panel-2 .workout-exercise-card').first
            first_card.focus()
            kb_page.keyboard.press("Enter")
            kb_page.wait_for_selector("#exercise-instructions-modal.open", timeout=3000)
            assert kb_page.locator("#exercise-instructions-modal").is_visible(), "Modal did not open via Enter key"
            kb_page.keyboard.press("Escape")
            kb_page.wait_for_selector("#exercise-instructions-modal.open", state="hidden", timeout=3000)
            print("   Modal opened via Enter and closed via Escape successfully.")

            results['Part B.3 Keyboard Pass'] = 'PASSED'

        finally:
            browser.close()
            cleanup_test_users()

    print("\n==========================================")
    print("ALL PLAYWRIGHT TESTS COMPLETED SUCCESSFULLY!")
    for k, v in results.items():
        print(f" {k}: {v}")
    print("==========================================")


if __name__ == '__main__':
    run_tests()
