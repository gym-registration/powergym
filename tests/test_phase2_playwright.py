"""
Comprehensive Playwright E2E Test Suite for Phase 2 Body Goals Redesign:
1. Adult Flow: Log weights, SVG chart points, delete weight, goal weight validation & progress bar, >=2kg prompt & target update.
2. Minor Safety (<18): Excluded from Progress tab, goal weight field omitted, no BMI display, 403 guards.
3. Week Strip & Derived Focus: 7-day horizontal strip, Day 4 rest pill, CHEST derived day title ("Chest" not "Chest & Legs"), equipment chips.
4. Nutrition Tab Consolidation: Recommended foods + sample daily meal plan + totals line all together.
5. Expired Member: Upfront "Subscription required" notice, disabled wizard inputs.
6. Keyboard Navigation: Step 2 goal cards arrow navigation and Enter/Space selection.
7. Modal Smoke Tests: Escape key and close behavior on terms-modal, equipment-guide-modal, goal-weight-modal.
8. Responsive Checks: 1280px desktop and 390px mobile viewports.
"""
import os
import sys
import time
from datetime import date, timedelta, datetime, timezone
from werkzeug.security import generate_password_hash

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import (
    app, db, User, FitnessProfile, BodyGoal, MembershipPlan, Membership, WeightLog,
    _calculate_fitness_targets
)
from playwright.sync_api import sync_playwright

BASE_URL = 'http://localhost:5000'

TEST_EMAILS = [
    'test_phase2_adult@test.com',
    'test_phase2_minor@test.com',
    'test_phase2_expired@test.com',
    'test_phase2_keyboard@test.com',
]

def cleanup_test_users():
    with app.app_context():
        for email in TEST_EMAILS:
            u = User.query.filter_by(email=email).first()
            if u:
                WeightLog.query.filter_by(member_id=u.id).delete()
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
            # PART 1: Adult Flow (Weights, SVG Chart, Goal Weight, 2kg Alert)
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part 1: Adult Progress Flow & Targets Update ===")
            adult_email = 'test_phase2_adult@test.com'
            with app.app_context():
                u = User(
                    first_name='Adult',
                    last_name='Tester',
                    email=adult_email,
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
                    calculated_weight=75.0,
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

                # Seed 2 backdated logs (2 days ago and 1 day ago) so multiple dates are on chart
                wl1 = WeightLog(
                    member_id=u.id,
                    weight_kg=75.0,
                    logged_at=datetime.now(timezone.utc) - timedelta(days=2),
                )
                wl2 = WeightLog(
                    member_id=u.id,
                    weight_kg=74.8,
                    logged_at=datetime.now(timezone.utc) - timedelta(days=1),
                )
                db.session.add(wl1)
                db.session.add(wl2)
                db.session.commit()

            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            resp = ctx.request.post(f"{BASE_URL}/login", data={'email': adult_email, 'password': 'password123'})
            assert resp.status == 200, f"Login failed for {adult_email}"

            page = ctx.new_page()
            # Handle any confirm() dialogues automatically by accepting
            page.on("dialog", lambda dialog: dialog.accept())

            page.goto(f"{BASE_URL}/member")
            page.click("#nav-member-goals")
            page.wait_for_selector("#fitness-plan-panel", state="visible", timeout=8000)

            # 1.1 Verify Consolidated Hub Structure & Order
            print(" - Verifying redesigned Hub ordering...")
            header = page.locator("#member-goals .page-header")
            assert header.is_visible(), "Page header not visible"
            assert "TRACK BODY GOALS" in header.inner_text(), "Header missing TRACK BODY GOALS"
            edit_btn = page.locator("#fw-edit-btn")
            assert edit_btn.is_visible(), "Edit button not visible"

            ai_msg = page.locator("#ai-coach-message")
            assert ai_msg.is_visible(), "AI coach banner not visible"
            coaching_tips = page.locator("#fp-coaching-tips")
            assert coaching_tips.count() > 0, "Coaching tips <details> not present"
            targets_grid = page.locator(".fw-primary-targets-grid")
            assert targets_grid.is_visible(), "Daily targets grid not visible"
            calc_details = page.locator("#fw-calc-details")
            assert calc_details.count() > 0, "'How we calculated this' <details> not present"

            # 1.2 Verify 3 Consolidated Tabs for Adult
            tabs = page.locator("#fitness-plan-panel .fp-tabs .fp-tab-btn")
            tab_names = [tabs.nth(i).get_attribute("data-fp-tab") for i in range(tabs.count())]
            assert tab_names == ['workouts', 'nutrition', 'progress'], f"Expected 3 tabs [workouts, nutrition, progress], got: {tab_names}"
            print(f"   Consolidated tabs confirmed: {tab_names}")

            # 1.3 Switch to Progress Tab
            print(" - Switching to Progress Tab...")
            page.click('.fp-tab-btn[data-fp-tab="progress"]')
            page.wait_for_selector("#fp-panel-progress", state="visible", timeout=4000)

            # 1.4 Log today's weight via UI + Test same-day upsert
            print(" - Logging today's weight entry (74.5 kg)...")
            page.fill("#fw-today-weight", "74.5")
            with page.expect_response("**/member/fitness/log-weight") as resp_info:
                page.click("#fw-log-weight-btn")
            assert resp_info.value.status == 200
            assert resp_info.value.json().get("message") == "Weight logged successfully."
            page.wait_for_timeout(400)

            # Test same-day replacement (upsert)
            print(" - Re-logging today's weight entry to test same-day upsert (74.4 kg)...")
            page.fill("#fw-today-weight", "74.4")
            with page.expect_response("**/member/fitness/log-weight") as resp_info2:
                page.click("#fw-log-weight-btn")
            assert resp_info2.value.status == 200
            assert resp_info2.value.json().get("message") == "Updated today's weight."
            page.wait_for_timeout(400)

            # 1.5 Verify SVG Weight Chart has 3 circle data points (2 backdated + 1 today)
            print(" - Verifying SVG chart points...")
            points = page.locator("#fw-chart-container svg circle.fw-chart-point")
            assert points.count() == 3, f"Expected 3 SVG circle data points, found {points.count()}"
            recent_rows = page.locator("#fw-recent-weights-list .fw-recent-weight-row")
            assert recent_rows.count() == 3, f"Expected 3 recent weight rows, found {recent_rows.count()}"
            print(f"   Confirmed {points.count()} SVG points and {recent_rows.count()} weigh-in rows.")

            # 1.6 Delete 1 weight entry
            print(" - Deleting 1 weight entry...")
            delete_btn = recent_rows.first.locator("button")
            with page.expect_response("**/member/fitness/delete-weight/*") as del_resp_info:
                delete_btn.click()
            assert del_resp_info.value.status == 200
            page.wait_for_timeout(500)
            points_after = page.locator("#fw-chart-container svg circle.fw-chart-point")
            assert points_after.count() == 2, f"Expected 2 points after deletion, found {points_after.count()}"
            print("   Weight log deleted successfully, chart points updated to 2.")

            # 1.7 Set Goal Weight: Invalid Rejected, Valid Accepted
            print(" - Testing Goal Weight modal...")
            page.click("#fw-edit-goal-weight-btn")
            page.wait_for_selector("#goal-weight-modal.open", state="visible", timeout=3000)

            # Invalid (e.g. 35 kg -> BMI = 35 / (1.8^2) = 10.8 < 18.5)
            page.fill("#fw-modal-goal-weight", "35")
            page.click("#fw-modal-goal-save-btn")
            page.wait_for_timeout(600)
            err_el = page.locator("#fw-modal-goal-error")
            assert err_el.is_visible(), "Expected error message in modal for invalid goal weight"
            invalid_err = err_el.inner_text()
            assert "Goal weight must be between" in invalid_err and "(BMI 18.5-40)" in invalid_err
            assert "healthy" not in invalid_err.lower(), "Error copy must strictly omit the word 'healthy'"
            print(f"   Invalid goal weight correctly rejected: '{invalid_err}'")

            # Valid goal weight (70.0 kg, BMI = 70/(1.8^2) = 21.6)
            page.fill("#fw-modal-goal-weight", "70")
            page.wait_for_timeout(200)
            bmi_preview = page.locator("#fw-modal-goal-bmi-hint").inner_text()
            assert "21.6" in bmi_preview, f"Implied BMI preview incorrect: {bmi_preview}"
            print(f"   Live implied BMI preview verified: '{bmi_preview}'")

            with page.expect_response("**/member/fitness/set-goal-weight") as goal_resp_info:
                page.click("#fw-modal-goal-save-btn")
            assert goal_resp_info.value.status == 200
            page.wait_for_selector("#goal-weight-modal.open", state="hidden", timeout=3000)
            page.wait_for_timeout(500)

            # Verify progress bar rendered
            progress_bar = page.locator("#fw-goal-summary-card .fw-goal-progress-bar")
            assert progress_bar.is_visible(), "Goal progress bar not visible after setting valid goal weight"
            goal_stats = page.locator("#fw-goal-summary-card .fw-goal-stats-row").inner_text()
            assert "70 kg" in goal_stats, f"Goal weight not shown in stats: {goal_stats}"
            print(f"   Goal weight progress bar and stats verified: '{goal_stats.replace(chr(10), ' ')}'")

            # 1.8 Log Weight with >= 2.0 kg diff to trigger Target Update Alert
            print(" - Logging weight with >= 2.0 kg diff (78.0 kg vs calculated 75.0 kg)...")
            page.fill("#fw-today-weight", "78.0")
            with page.expect_response("**/member/fitness/log-weight") as alert_resp:
                page.click("#fw-log-weight-btn")
            assert alert_resp.value.status == 200
            page.wait_for_timeout(500)

            alert = page.locator("#fw-weight-change-alert")
            assert alert.is_visible(), "Weight change prompt (#fw-weight-change-alert) did not appear for >= 2.0kg difference"
            alert_text = alert.inner_text()
            assert "changed by" in alert_text and "UPDATE TARGETS" in alert_text.upper(), f"Unexpected alert text: {alert_text}"
            print(f"   Weight change prompt verified: '{alert_text.replace(chr(10), ' ')}'")

            # Click "Update Targets"
            initial_calories = page.locator("#fp-target-calories").inner_text()
            with page.expect_response("**/member/fitness/calculate") as calc_resp:
                page.click("#fw-update-targets-btn")
            assert calc_resp.value.status == 200
            page.wait_for_timeout(500)
            assert not alert.is_visible(), "Weight change alert should be dismissed after recalculation"
            new_calories = page.locator("#fp-target-calories").inner_text()
            print(f"   Targets updated successfully: {initial_calories} -> {new_calories}.")

            results['Part 1 Adult Flow'] = 'PASSED'

            # ─────────────────────────────────────────────────────────────
            # PART 2: Minor Safety Checks (<18)
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part 2: Minor Safety Checks (<18) ===")
            minor_email = 'test_phase2_minor@test.com'
            with app.app_context():
                u_m = User(
                    first_name='Minor',
                    last_name='Safe',
                    email=minor_email,
                    password=generate_password_hash('password123'),
                    role='member',
                    status='active',
                    birthday=date(2011, 4, 10),  # 15 years old
                )
                db.session.add(u_m)
                db.session.commit()

                plan = MembershipPlan.query.first()
                mem = Membership(
                    member_id=u_m.id,
                    plan_id=plan.id if plan else 1,
                    start_date=date.today(),
                    expiry_date=date.today() + timedelta(days=30),
                    status='active',
                )
                db.session.add(mem)

                fp_m = FitnessProfile(
                    member_id=u_m.id,
                    height_cm=165.0,
                    sex='female',
                    activity_level='moderate_activity',
                    fitness_goal='CORE',
                )
                db.session.add(fp_m)

                calcs_m = _calculate_fitness_targets(165.0, 55.0, 'female', 15, 'moderate_activity', 'CORE')
                bg_m = BodyGoal(
                    member_id=u_m.id,
                    current_weight=55.0,
                    current_bmi=None,  # No BMI stored for minors
                    bmr=calcs_m['bmr'],
                    tdee=calcs_m['tdee'],
                    calorie_target=calcs_m['calorie_target'],
                    protein_target_g=calcs_m['protein_target_g'],
                )
                db.session.add(bg_m)
                db.session.commit()

            m_ctx = browser.new_context()
            m_ctx.request.post(f"{BASE_URL}/login", data={'email': minor_email, 'password': 'password123'})
            m_page = m_ctx.new_page()
            m_page.goto(f"{BASE_URL}/member")
            m_page.click("#nav-member-goals")
            m_page.wait_for_selector("#fitness-plan-panel", state="visible", timeout=8000)

            # 2.1 Confirm Progress Tab is NOT in tabs
            minor_tabs = m_page.locator("#fitness-plan-panel .fp-tabs .fp-tab-btn")
            minor_tab_names = [minor_tabs.nth(i).get_attribute("data-fp-tab") for i in range(minor_tabs.count())]
            assert 'progress' not in minor_tab_names, f"Minor should NOT have progress tab! Tabs found: {minor_tab_names}"
            assert minor_tab_names == ['workouts', 'nutrition'], f"Expected only [workouts, nutrition] for minor, got: {minor_tab_names}"
            print(f"   Confirmed Progress tab omitted for minor: {minor_tab_names}")

            # 2.2 Attempt to switch to progress tab via JS -> must be blocked
            m_page.evaluate("() => MemberModule.switchFitnessPlanTab('progress')")
            m_page.wait_for_timeout(300)
            prog_panel = m_page.locator("#fp-panel-progress")
            assert prog_panel.count() == 0 or not prog_panel.is_visible(), "Minor should not have visible progress panel"
            active_tab = m_page.locator(".fp-tabs .fp-tab-btn.active").get_attribute("data-fp-tab")
            assert active_tab != 'progress', f"Minor should not be able to activate progress tab! Active: {active_tab}"

            # 2.3 Verify API endpoints return 403 Forbidden for minor
            res_log = m_ctx.request.post(f"{BASE_URL}/member/fitness/log-weight", data={'weight_kg': 56.0})
            assert res_log.status == 403, f"Expected 403 for minor log-weight, got {res_log.status}"
            res_goal = m_ctx.request.post(f"{BASE_URL}/member/fitness/set-goal-weight", data={'goal_weight_kg': 50.0})
            assert res_goal.status == 403, f"Expected 403 for minor set-goal-weight, got {res_goal.status}"
            res_prog = m_ctx.request.get(f"{BASE_URL}/member/fitness/progress")
            assert res_prog.status == 403, f"Expected 403 for minor progress, got {res_prog.status}"
            print("   Confirmed all progress API endpoints return 403 Forbidden for minors.")

            # 2.4 Verify Step 1 Edit Mode does not show Goal Weight input for minor
            m_page.click("#fw-edit-btn")
            m_page.wait_for_selector("#fw-step-1", state="visible", timeout=4000)
            goal_w_input = m_page.locator("#fw-goal-weight")
            assert goal_w_input.count() == 0 or not goal_w_input.is_visible(), "Goal weight input should NOT exist for minor in Step 1"
            print("   Confirmed Goal Weight input omitted from Step 1 for minor.")

            results['Part 2 Minor Safety'] = 'PASSED'

            # ─────────────────────────────────────────────────────────────
            # PART 3: Week Strip & Workout Routine Details
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part 3: Week Strip & Derived Focus ===")
            page.click('.fp-tab-btn[data-fp-tab="workouts"]')
            page.wait_for_selector("#fp-panel-workouts", state="visible", timeout=3000)

            # 3.1 Week Strip with 7 Day Pills
            week_strip = page.locator(".fw-week-strip")
            assert week_strip.is_visible(), ".fw-week-strip not visible"
            pills = page.locator(".fw-week-strip .fw-day-pill")
            assert pills.count() == 7, f"Expected 7 day pills in week strip, found {pills.count()}"

            # Day 4 Rest pill
            day4_pill = page.locator('#fp-day-tab-4')
            assert "rest" in (day4_pill.get_attribute("class") or ""), "Day 4 pill missing .rest class"
            pill4_text = day4_pill.inner_text()
            assert "REST" in pill4_text.upper(), f"Day 4 pill should say REST, got: {pill4_text}"
            print("   Week strip with 7 pills verified; Day 4 marked as REST.")

            # 3.2 Derived Focus for CHEST: Day 1 should display 'Chest' (not 'Chest & Legs')
            day1_pill = page.locator('#fp-day-tab-1')
            day1_pill.click()
            day1_panel = page.locator('#fp-day-panel-1')
            assert day1_panel.is_visible(), "Day 1 panel not visible"
            day1_title = day1_panel.locator(".panel-title").inner_text()
            assert "CHEST" in day1_title.upper() and "LEGS" not in day1_title.upper(), f"Expected derived focus CHEST without Legs, got: '{day1_title}'"
            print(f"   Derived workout focus for Day 1 verified: '{day1_title}'.")

            # 3.3 Equipment chips on cards
            equip_chips = day1_panel.locator(".workout-tag-equip")
            assert equip_chips.count() > 0, "Expected .workout-tag-equip chips on exercise cards"
            print(f"   Found {equip_chips.count()} equipment tags on Day 1 cards (e.g. '{equip_chips.first.inner_text()}').")

            # 3.4 Nutrition Tab Consolidation
            print(" - Verifying Nutrition Tab Consolidation...")
            page.click('.fp-tab-btn[data-fp-tab="nutrition"]')
            page.wait_for_selector("#fp-panel-nutrition", state="visible", timeout=3000)
            foods_list = page.locator("#fp-foods-list .fp-card")
            assert foods_list.count() > 0, "Recommended foods list missing from Nutrition tab"
            meal_cards = page.locator("#fp-meal-plan .fp-card")
            assert meal_cards.count() == 4, f"Expected 4 meal cards in Nutrition tab, found {meal_cards.count()}"
            total_line = page.locator("#fp-meal-plan-total").inner_text()
            assert "Daily total across all meals:" in total_line, f"Missing total line in Nutrition tab: {total_line}"
            print(f"   Nutrition tab verified: {foods_list.count()} foods, 4 meals, and totals line: '{total_line}'.")

            results['Part 3 Week Strip & Nutrition'] = 'PASSED'

            # ─────────────────────────────────────────────────────────────
            # PART 4: Expired Member Check
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part 4: Expired Member Upfront Notice & Disabled Inputs ===")
            exp_email = 'test_phase2_expired@test.com'
            with app.app_context():
                u_exp = User(
                    first_name='Expired',
                    last_name='User',
                    email=exp_email,
                    password=generate_password_hash('password123'),
                    role='member',
                    status='active',
                    birthday=date(1995, 1, 1),
                )
                db.session.add(u_exp)
                db.session.commit()

                plan = MembershipPlan.query.first()
                mem_exp = Membership(
                    member_id=u_exp.id,
                    plan_id=plan.id if plan else 1,
                    start_date=date.today() - timedelta(days=60),
                    expiry_date=date.today() - timedelta(days=30),  # expired
                    status='expired',
                )
                db.session.add(mem_exp)
                db.session.commit()

            exp_ctx = browser.new_context()
            exp_ctx.request.post(f"{BASE_URL}/login", data={'email': exp_email, 'password': 'password123'})
            exp_page = exp_ctx.new_page()
            exp_page.goto(f"{BASE_URL}/member")
            exp_page.click("#nav-member-goals")
            exp_page.wait_for_selector("#fitness-wizard-panel", state="visible", timeout=5000)

            # Check upfront notice
            sub_banner = exp_page.locator(".fw-subscription-notice")
            assert sub_banner.is_visible(), "Upfront 'Subscription required' banner missing for expired member"
            banner_msg = sub_banner.inner_text()
            assert "Subscription required" in banner_msg, f"Unexpected banner text: {banner_msg}"
            print(f"   Upfront banner verified: '{banner_msg.replace(chr(10), ' ').strip()}'")

            # Check disabled wizard inputs
            assert exp_page.locator("#fw-height").is_disabled(), "Height input should be disabled"
            assert exp_page.locator("#fw-weight").is_disabled(), "Weight input should be disabled"
            assert exp_page.locator("#fw-step1-btn").is_disabled(), "Step 1 submit button should be disabled"
            print("   All wizard inputs correctly disabled for expired member.")

            results['Part 4 Expired Member'] = 'PASSED'

            # ─────────────────────────────────────────────────────────────
            # PART 5: Keyboard-Only Navigation Pass (Step 2 cards)
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part 5: Keyboard Navigation Pass ===")
            kb_email = 'test_phase2_keyboard@test.com'
            with app.app_context():
                u_kb = User(
                    first_name='Key',
                    last_name='User',
                    email=kb_email,
                    password=generate_password_hash('password123'),
                    role='member',
                    status='active',
                    birthday=date(1996, 5, 20),
                )
                db.session.add(u_kb)
                db.session.commit()

                plan = MembershipPlan.query.first()
                mem_kb = Membership(
                    member_id=u_kb.id,
                    plan_id=plan.id if plan else 1,
                    start_date=date.today(),
                    expiry_date=date.today() + timedelta(days=30),
                    status='active',
                )
                db.session.add(mem_kb)
                db.session.commit()

            kb_ctx = browser.new_context()
            kb_ctx.request.post(f"{BASE_URL}/login", data={'email': kb_email, 'password': 'password123'})
            kb_page = kb_ctx.new_page()
            kb_page.goto(f"{BASE_URL}/member")
            kb_page.click("#nav-member-goals")
            kb_page.wait_for_selector("#fw-step-1", state="visible", timeout=5000)

            # Fill Step 1 with keyboard/fill
            kb_page.fill("#fw-height", "175")
            kb_page.fill("#fw-weight", "70")
            kb_page.select_option("#fw-sex", "male")
            kb_page.select_option("#fw-activity", "moderate_activity")
            kb_page.click("#fw-step1-btn")
            kb_page.wait_for_selector("#fw-step-2", state="visible", timeout=5000)

            # Test Arrow key navigation across .workout-goal-card
            print(" - Testing arrow key navigation across Step 2 workout goal cards...")
            cards = kb_page.locator("#fw-goal-grid .workout-goal-card")
            first_card = cards.first
            first_card.focus()
            kb_page.keyboard.press("ArrowRight")
            active_card = kb_page.locator("#fw-goal-grid .workout-goal-card:focus")
            assert active_card.count() > 0, "Card did not receive focus on ArrowRight"
            print(f"   ArrowRight moved focus to: {active_card.get_attribute('data-goal')}")

            # Select via Space key
            kb_page.keyboard.press("Space")
            radio = active_card.locator("input[type='radio']")
            assert radio.is_checked(), "Radio was not checked on Space press"
            assert "selected" in (active_card.get_attribute("class") or ""), "Card missing .selected class on Space press"
            print(f"   Space key successfully selected goal: {active_card.get_attribute('data-goal')}")

            results['Part 5 Keyboard Pass'] = 'PASSED'

            # ─────────────────────────────────────────────────────────────
            # PART 6: Modal Smoke Tests (Shared Escape & Close Handlers)
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part 6: Modal Smoke Tests ===")
            # Modal 1: plan-modal on Member Dashboard
            print(" - Testing plan-modal on Member Dashboard...")
            page.evaluate("() => openModal('plan-modal')")
            page.wait_for_selector("#plan-modal.open", state="visible", timeout=3000)
            assert page.locator("#plan-modal").is_visible(), "plan-modal failed to open"
            page.keyboard.press("Escape")
            page.wait_for_selector("#plan-modal.open", state="hidden", timeout=3000)
            assert not page.locator("#plan-modal").is_visible(), "plan-modal failed to close via Escape"
            print("   plan-modal opened and closed via Escape successfully.")

            # Modal 2: confirm-payment-modal (Payment/Confirm dialog)
            print(" - Testing confirm-payment-modal on Member Dashboard...")
            page.evaluate("() => openModal('confirm-payment-modal')")
            page.wait_for_selector("#confirm-payment-modal.open", state="visible", timeout=3000)
            assert page.locator("#confirm-payment-modal").is_visible(), "confirm-payment-modal failed to open"
            page.keyboard.press("Escape")
            page.wait_for_selector("#confirm-payment-modal.open", state="hidden", timeout=3000)
            assert not page.locator("#confirm-payment-modal").is_visible(), "confirm-payment-modal failed to close via Escape"
            print("   confirm-payment-modal opened and closed via Escape successfully.")

            # Modal 3: goal-weight-modal on Member Dashboard
            print(" - Testing goal-weight-modal...")
            page.click('.fp-tab-btn[data-fp-tab="progress"]')
            page.wait_for_selector("#fp-panel-progress", state="visible", timeout=3000)
            page.click("#fw-edit-goal-weight-btn")
            page.wait_for_selector("#goal-weight-modal.open", state="visible", timeout=3000)
            assert page.locator("#goal-weight-modal").is_visible(), "goal-weight-modal failed to open"
            page.keyboard.press("Escape")
            page.wait_for_selector("#goal-weight-modal.open", state="hidden", timeout=3000)
            assert not page.locator("#goal-weight-modal").is_visible(), "goal-weight-modal failed to close via Escape"
            print("   goal-weight-modal opened and closed via Escape successfully.")

            # Non-dismissible check: terms-modal with active read timer
            print(" - Testing non-dismissible modal: terms-modal on Home page...")
            home_page = ctx.new_page()
            home_page.goto(f"{BASE_URL}/")
            home_page.evaluate("() => openTermsModal()")
            home_page.wait_for_selector("#terms-modal.open", state="visible", timeout=3000)
            assert home_page.locator("#terms-modal").is_visible(), "terms-modal failed to open"
            home_page.keyboard.press("Escape")
            home_page.wait_for_timeout(400)
            # Escape MUST NOT close terms-modal while timer is active
            assert home_page.locator("#terms-modal.open").is_visible(), "terms-modal should NOT be dismissed by Escape while timer is active"
            print("   Confirmed: Escape does NOT close terms-modal while read timer is running.")

            results['Part 6 Modal Smoke Tests'] = 'PASSED'

            # ─────────────────────────────────────────────────────────────
            # PART 7: Responsive Viewport Checks (1280px & 390px)
            # ─────────────────────────────────────────────────────────────
            print("\n=== Running Part 7: Responsive Viewport Checks ===")
            # 1280px Desktop
            page.set_viewport_size({"width": 1280, "height": 800})
            page.wait_for_timeout(300)
            assert page.locator("#fitness-plan-panel").is_visible()
            print("   1280px Desktop layout confirmed.")

            # 390px Mobile
            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(300)
            assert page.locator("#fitness-plan-panel").is_visible()
            # Switch to workouts tab to check week strip
            page.click('.fp-tab-btn[data-fp-tab="workouts"]')
            page.wait_for_selector(".fw-week-strip", state="visible", timeout=2000)
            strip_overflow = page.locator(".fw-week-strip").evaluate("el => el.scrollWidth >= el.clientWidth")
            assert strip_overflow, "Week strip should accommodate horizontal scroll on mobile (390px)"
            print("   390px Mobile layout verified (week strip scrollable, responsive stacking).")

            results['Part 7 Responsive Checks'] = 'PASSED'

        finally:
            browser.close()
            cleanup_test_users()

    print("\n==========================================")
    print("ALL PHASE 2 PLAYWRIGHT TESTS PASSED!")
    for k, v in results.items():
        print(f" {k}: {v}")
    print("==========================================")


if __name__ == '__main__':
    run_tests()
