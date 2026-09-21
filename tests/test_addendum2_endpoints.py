"""
Comprehensive verification test for Addendum 2 and Phase 2.5 close-out items:
1. Fail Closed on Age for all progress endpoints (unknown age & minor -> 403)
2. Goal Weight Validation & Exact Copy (without "healthy")
3. One Weight Log Per Day (Upsert returning "Updated today's weight.", exactly 1 row in DB)
4. Deleting the Only Weigh-In (falls back to calculated_weight, empty chart & progress copy, no update alert)
5. AI Coach Banner Mocked Generation (Adult & Minor mocked, labeled mocks, zero live Gemini calls in automated suite)
6. Security Tests:
   - Cross-member Isolation: Member A cannot delete or read Member B's weigh-in (404, row unchanged).
   - Unauthenticated & Non-Member Guard: All 4 progress endpoints reject requests without a valid member session (401).
   - Active Membership Guard: Expired member rejected on all 4 endpoints (403).
   - Input Robustness: Non-numeric, NaN, Inf, negative, extreme, and missing inputs give clean 400, never 500.
"""
import os
import sys
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch, MagicMock
from werkzeug.security import generate_password_hash

# Ensure project root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app import app, db, User, Membership, FitnessProfile, BodyGoal, WeightLog, MANILA_TZ

class MockCandidate:
    def __init__(self, text):
        self.text = text
        self.finish_reason = 1  # STOP
        self.content = MockContent(text)

class MockContent:
    def __init__(self, text):
        self.parts = [MockPart(text)]

class MockPart:
    def __init__(self, text):
        self.text = text

class MockResponse:
    def __init__(self, text):
        self.text = text
        self.candidates = [MockCandidate(text)]

def run_all_tests():
    print("=== Starting Phase 2.5 & Addendum 2 Endpoint & Security Verification ===")
    app.config['TESTING'] = True
    client = app.test_client()

    created_user_ids = []

    try:
        with app.app_context():
            today = date.today()
            pw_hash = generate_password_hash('TestPass123!')

            user_unknown = User(
                email='test_no_age@example.com',
                first_name='TestUnknown',
                last_name='User',
                password=pw_hash,
                role='member',
                status='approved',
                birthday=None,
            )
            db.session.add(user_unknown)

            user_minor = User(
                email='test_minor@example.com',
                first_name='TestMinor',
                last_name='User',
                password=pw_hash,
                role='member',
                status='approved',
                birthday=today - timedelta(days=15 * 365 + 4),
            )
            db.session.add(user_minor)

            user_adult_a = User(
                email='test_adult_a@example.com',
                first_name='TestAdultA',
                last_name='User',
                password=pw_hash,
                role='member',
                status='approved',
                birthday=today - timedelta(days=25 * 365 + 6),
            )
            db.session.add(user_adult_a)

            user_adult_b = User(
                email='test_adult_b@example.com',
                first_name='TestAdultB',
                last_name='User',
                password=pw_hash,
                role='member',
                status='approved',
                birthday=today - timedelta(days=28 * 365 + 2),
            )
            db.session.add(user_adult_b)

            user_expired = User(
                email='test_expired@example.com',
                first_name='TestExpired',
                last_name='User',
                password=pw_hash,
                role='member',
                status='approved',
                birthday=today - timedelta(days=26 * 365),
            )
            db.session.add(user_expired)

            db.session.commit()
            unknown_id = user_unknown.id
            minor_id = user_minor.id
            adult_a_id = user_adult_a.id
            adult_b_id = user_adult_b.id
            expired_id = user_expired.id
            created_user_ids.extend([unknown_id, minor_id, adult_a_id, adult_b_id, expired_id])

            # Add active memberships for active users
            for uid in [unknown_id, minor_id, adult_a_id, adult_b_id]:
                m = Membership(
                    member_id=uid,
                    start_date=today - timedelta(days=1),
                    expiry_date=today + timedelta(days=30),
                    status='approved',
                )
                db.session.add(m)

            # Add expired membership for expired user
            m_exp = Membership(
                member_id=expired_id,
                start_date=today - timedelta(days=60),
                expiry_date=today - timedelta(days=5),
                status='approved',
            )
            db.session.add(m_exp)

            # Fitness profiles
            prof_unknown = FitnessProfile(
                member_id=unknown_id,
                height_cm=170.0,
                sex='male',
                activity_level='moderate_activity',
                fitness_goal='CHEST',
                calculated_weight=70.0,
            )
            db.session.add(prof_unknown)

            prof_minor = FitnessProfile(
                member_id=minor_id,
                height_cm=165.0,
                sex='female',
                activity_level='high_activity',
                fitness_goal='FULL_BODY',
                calculated_weight=55.0,
            )
            db.session.add(prof_minor)

            prof_adult_a = FitnessProfile(
                member_id=adult_a_id,
                height_cm=170.0,
                sex='male',
                activity_level='moderate_activity',
                fitness_goal='CHEST',
                calculated_weight=75.0,
            )
            db.session.add(prof_adult_a)

            prof_adult_b = FitnessProfile(
                member_id=adult_b_id,
                height_cm=180.0,
                sex='female',
                activity_level='high_activity',
                fitness_goal='LEGS',
                calculated_weight=68.0,
            )
            db.session.add(prof_adult_b)

            prof_exp = FitnessProfile(
                member_id=expired_id,
                height_cm=175.0,
                sex='male',
                activity_level='low_activity',
                fitness_goal='BACK',
                calculated_weight=72.0,
            )
            db.session.add(prof_exp)

            bg_adult_a = BodyGoal(
                member_id=adult_a_id,
                current_weight=75.0,
                goal_weight=68.0,
            )
            db.session.add(bg_adult_a)

            bg_adult_b = BodyGoal(
                member_id=adult_b_id,
                current_weight=68.0,
                goal_weight=65.0,
            )
            db.session.add(bg_adult_b)

            db.session.commit()

            print("[Setup] Created test users: unknown_age, minor, adult_a, adult_b, expired.")

        # -------------------------------------------------------------
        # TEST 1: Fail Closed on Age for Progress Endpoints
        # -------------------------------------------------------------
        print("\n--- TEST 1: Fail Closed on Age ---")
        for u_id, label in [(unknown_id, "unknown age"), (minor_id, "minor")]:
            with client.session_transaction() as sess:
                sess['user_id'] = u_id
                sess['role'] = 'member'

            # 1. log-weight
            res = client.post('/member/fitness/log-weight', json={'weight_kg': 70.0})
            assert res.status_code == 403, f"Expected 403 for {label} on log-weight, got {res.status_code}"
            print(f"[PASS] log-weight returned 403 for {label}")

            # 2. delete-weight
            res = client.delete('/member/fitness/delete-weight/999999')
            assert res.status_code == 403, f"Expected 403 for {label} on delete-weight, got {res.status_code}"
            print(f"[PASS] delete-weight returned 403 for {label}")

            # 3. set-goal-weight
            res = client.post('/member/fitness/set-goal-weight', json={'goal_weight_kg': 65.0})
            assert res.status_code == 403, f"Expected 403 for {label} on set-goal-weight, got {res.status_code}"
            print(f"[PASS] set-goal-weight returned 403 for {label}")

            # 4. progress
            res = client.get('/member/fitness/progress')
            assert res.status_code == 403, f"Expected 403 for {label} on progress, got {res.status_code}"
            print(f"[PASS] progress returned 403 for {label}")

        # -------------------------------------------------------------
        # TEST 2: Goal Weight Validation & Exact Copy (No "healthy")
        # -------------------------------------------------------------
        print("\n--- TEST 2: Goal Weight Validation & Copy ---")
        with client.session_transaction() as sess:
            sess['user_id'] = adult_a_id
            sess['role'] = 'member'

        # Adult height 170cm -> min_safe = 18.5 * 1.7^2 = 53.465 -> 53.5 kg, max_safe = 40.0 * 1.7^2 = 115.6 kg
        bad_res = client.post('/member/fitness/set-goal-weight', json={'goal_weight_kg': 45.0})
        assert bad_res.status_code == 400
        bad_data = bad_res.get_json()
        expected_error = "Goal weight must be between 53.5 and 115.6 kg for your height (BMI 18.5-40)."
        server_error = bad_data.get('error')
        print(f"Server error message: {server_error}")
        assert server_error == expected_error, f"Expected '{expected_error}', got '{server_error}'"
        assert "healthy" not in server_error.lower(), f"Word 'healthy' must NOT appear in error message: '{server_error}'"
        print("[PASS] Goal weight error copy matches exact specification without 'healthy'")

        # Valid goal weight
        good_res = client.post('/member/fitness/set-goal-weight', json={'goal_weight_kg': 68.0})
        assert good_res.status_code == 200
        assert good_res.get_json().get('success') is True
        print("[PASS] Valid goal weight accepted")

        # -------------------------------------------------------------
        # TEST 3: One Weight Log Per Day (Upsert)
        # -------------------------------------------------------------
        print("\n--- TEST 3: One Weight Log Per Day (Upsert) ---")
        # First log today
        log1_res = client.post('/member/fitness/log-weight', json={'weight_kg': 75.5})
        assert log1_res.status_code == 200
        log1_data = log1_res.get_json()
        assert log1_data.get('success') is True
        assert log1_data.get('is_update') is False
        assert log1_data.get('message') == "Weight logged successfully."
        first_log_id = log1_data.get('log_id')
        print(f"[PASS] First log today: id={first_log_id}, message='{log1_data.get('message')}'")

        # Second log on same Manila day: updates in-place
        log2_res = client.post('/member/fitness/log-weight', json={'weight_kg': 76.0})
        assert log2_res.status_code == 200
        log2_data = log2_res.get_json()
        assert log2_data.get('success') is True
        assert log2_data.get('is_update') is True
        assert log2_data.get('message') == "Updated today's weight."
        assert log2_data.get('log_id') == first_log_id, "Upsert must reuse same row ID"
        print(f"[PASS] Second log today replaced first: id={log2_data.get('log_id')}, message='{log2_data.get('message')}', weight=76.0 kg")

        # Check DB row count for user
        with app.app_context():
            user_logs = WeightLog.query.filter_by(member_id=adult_a_id).all()
            assert len(user_logs) == 1, f"Expected exactly 1 log in DB, found {len(user_logs)}"
            assert float(user_logs[0].weight_kg) == 76.0
            print("[PASS] Confirmed exactly 1 log exists in database for member with unique key")

        # -------------------------------------------------------------
        # TEST 4: Deleting the Only Weigh-In
        # -------------------------------------------------------------
        print("\n--- TEST 4: Deleting the Only Weigh-In ---")
        del_res = client.delete(f'/member/fitness/delete-weight/{first_log_id}')
        assert del_res.status_code == 200
        del_data = del_res.get_json()
        assert del_data.get('success') is True
        print("[PASS] Successfully deleted the only weigh-in")

        # Check progress endpoint with zero logs:
        # - current_weight falls back to profile.calculated_weight (75.0)
        # - needs_target_update is False
        # - chart_entries is empty
        prog_res = client.get('/member/fitness/progress')
        assert prog_res.status_code == 200
        prog_data = prog_res.get_json()
        assert prog_data.get('chart_entries') == [], "chart_entries should be empty"
        assert prog_data.get('needs_target_update') is False, "needs_target_update should be False"
        assert prog_data.get('current_weight') == 75.0, f"Expected fallback 75.0, got {prog_data.get('current_weight')}"
        print(f"[PASS] Progress with zero logs: current_weight={prog_data.get('current_weight')}, needs_target_update={prog_data.get('needs_target_update')}, chart_entries={prog_data.get('chart_entries')}")

        # -------------------------------------------------------------
        # TEST 5: Mocked Gemini AI Coach Banner Generation (Adult & Minor)
        # -------------------------------------------------------------
        print("\n--- TEST 5: Mocked AI Coach Banner Generation ---")
        mock_adult_note = "Hey TestAdultA, let's crush your chest workout goals this week across your six training days and one rest day. Focus on keeping your form tight and controlled through every rep, and remember to breathe steadily to keep your energy high."
        mock_minor_note = "Hey TestMinor, great to have you locked in for six training days and one well-earned rest day this week as you tackle your full-body routine. Remember to always work out under the supervision of a coach, and focus on moving with steady control."

        with patch('google.generativeai.GenerativeModel.generate_content') as mock_gen:
            # 1. Adult AI banner
            mock_gen.return_value = MockResponse(mock_adult_note)
            print("   [MOCK - Gemini GenerativeModel: generate_content returned synthetic compliant adult banner]")
            with client.session_transaction() as sess:
                sess['user_id'] = adult_a_id
                sess['role'] = 'member'

            ai_adult_res = client.post('/member/fitness/ai-coach', json={})
            assert ai_adult_res.status_code == 200
            ai_adult_data = ai_adult_res.get_json()
            assert ai_adult_data.get('success') is True
            assert ai_adult_data.get('cached') is False
            adult_msg = ai_adult_data.get('message')
            assert adult_msg == mock_adult_note
            print(f"[PASS] Adult AI banner generated via mock (cached=False):\n   \"{adult_msg}\"")

            # Cached check on second call
            ai_adult_res2 = client.post('/member/fitness/ai-coach', json={})
            ai_adult_data2 = ai_adult_res2.get_json()
            assert ai_adult_data2.get('cached') is True
            assert ai_adult_data2.get('message') == adult_msg
            print("[PASS] Adult AI banner cached on second call (cached=True)")

            # 2. Minor AI banner
            mock_gen.return_value = MockResponse(mock_minor_note)
            print("   [MOCK - Gemini GenerativeModel: generate_content returned synthetic compliant minor banner]")
            with client.session_transaction() as sess:
                sess['user_id'] = minor_id
                sess['role'] = 'member'

            ai_minor_res = client.post('/member/fitness/ai-coach', json={})
            assert ai_minor_res.status_code == 200
            ai_minor_data = ai_minor_res.get_json()
            assert ai_minor_data.get('success') is True
            assert ai_minor_data.get('cached') is False
            minor_msg = ai_minor_data.get('message')
            assert minor_msg == mock_minor_note
            print(f"[PASS] Minor AI banner generated via mock (cached=False):\n   \"{minor_msg}\"")

            # Cached check on minor second call
            ai_minor_res2 = client.post('/member/fitness/ai-coach', json={})
            ai_minor_data2 = ai_minor_res2.get_json()
            assert ai_minor_data2.get('cached') is True
            assert ai_minor_data2.get('message') == minor_msg
            print("[PASS] Minor AI banner cached on second call (cached=True)")

        # -------------------------------------------------------------
        # TEST 6: Security - Cross-Member Isolation
        # -------------------------------------------------------------
        print("\n--- TEST 6: Security - Cross-Member Isolation ---")
        # Adult B logs a weigh-in
        with client.session_transaction() as sess:
            sess['user_id'] = adult_b_id
            sess['role'] = 'member'
        log_b_res = client.post('/member/fitness/log-weight', json={'weight_kg': 68.5})
        assert log_b_res.status_code == 200
        log_b_id = log_b_res.get_json().get('log_id')

        # Now switch to Adult A
        with client.session_transaction() as sess:
            sess['user_id'] = adult_a_id
            sess['role'] = 'member'

        # Adult A tries to delete Adult B's weigh-in
        hack_del_res = client.delete(f'/member/fitness/delete-weight/{log_b_id}')
        assert hack_del_res.status_code == 404, f"Expected 404 on cross-member delete, got {hack_del_res.status_code}"
        print(f"[PASS] Member A cannot delete Member B's log (returned 404 Not Found)")

        # Verify Adult B's log is unchanged in DB
        with app.app_context():
            surviving_b_log = WeightLog.query.get(log_b_id)
            assert surviving_b_log is not None, "Member B's row must not be deleted"
            assert float(surviving_b_log.weight_kg) == 68.5, "Member B's row weight must be unchanged"
            print(f"[PASS] Member B's log (id={log_b_id}) verified completely unchanged in DB")

        # Adult A views progress: Member B's log must NOT be visible
        prog_a_res = client.get('/member/fitness/progress')
        assert prog_a_res.status_code == 200
        prog_a_data = prog_a_res.get_json()
        log_ids_a = [e['id'] for e in prog_a_data.get('chart_entries', [])]
        assert log_b_id not in log_ids_a, "Member B's log must never appear in Member A's progress data"
        print("[PASS] Member A cannot read Member B's weigh-in data")

        # -------------------------------------------------------------
        # TEST 7: Security - Unauthenticated & Non-Member Guard
        # -------------------------------------------------------------
        print("\n--- TEST 7: Security - Unauthenticated & Non-Member Guard ---")
        endpoints = [
            ('POST', '/member/fitness/log-weight', {'weight_kg': 70.0}),
            ('DELETE', f'/member/fitness/delete-weight/{log_b_id}', None),
            ('POST', '/member/fitness/set-goal-weight', {'goal_weight_kg': 65.0}),
            ('GET', '/member/fitness/progress', None),
        ]

        # 1. Completely unauthenticated (no session)
        with client.session_transaction() as sess:
            sess.clear()
        for method, url, body in endpoints:
            if method == 'POST':
                r = client.post(url, json=body or {})
            elif method == 'DELETE':
                r = client.delete(url)
            else:
                r = client.get(url)
            assert r.status_code == 401, f"Expected 401 for unauthenticated request on {url}, got {r.status_code}"
            print(f"[PASS] Unauthenticated {method} {url} returned 401 Unauthorized")

        # 2. Authenticated as non-member role (staff, admin, coach)
        for non_role in ['staff', 'admin', 'coach']:
            with client.session_transaction() as sess:
                sess['user_id'] = adult_a_id
                sess['role'] = non_role

            for method, url, body in endpoints:
                if method == 'POST':
                    r = client.post(url, json=body or {})
                elif method == 'DELETE':
                    r = client.delete(url)
                else:
                    r = client.get(url)
                assert r.status_code == 401, f"Expected 401 for non-member ({non_role}) on {url}, got {r.status_code}"
            print(f"[PASS] Non-member role '{non_role}' rejected with 401 across all 4 progress endpoints")

        # -------------------------------------------------------------
        # TEST 8: Security - Active Membership Guard
        # -------------------------------------------------------------
        print("\n--- TEST 8: Security - Active Membership Guard ---")
        with client.session_transaction() as sess:
            sess['user_id'] = expired_id
            sess['role'] = 'member'

        for method, url, body in endpoints:
            if method == 'POST':
                r = client.post(url, json=body or {})
            elif method == 'DELETE':
                r = client.delete(url)
            else:
                r = client.get(url)
            assert r.status_code == 403, f"Expected 403 for expired member on {url}, got {r.status_code}"
            print(f"[PASS] Expired member {method} {url} rejected with 403 Forbidden")

        # -------------------------------------------------------------
        # TEST 9: Robustness - Invalid Inputs Give Clean 400 (Never 500)
        # -------------------------------------------------------------
        print("\n--- TEST 9: Robustness - Invalid Inputs Handled with Clean 400 ---")
        with client.session_transaction() as sess:
            sess['user_id'] = adult_a_id
            sess['role'] = 'member'

        invalid_inputs_log_weight = [
            ("non-numeric string", {'weight_kg': 'abc'}),
            ("NaN string", {'weight_kg': 'NaN'}),
            ("Positive Infinity string", {'weight_kg': 'inf'}),
            ("Negative Infinity string", {'weight_kg': '-inf'}),
            ("negative number", {'weight_kg': -75.0}),
            ("extreme low (<20 kg)", {'weight_kg': 15.0}),
            ("extreme high (>300 kg)", {'weight_kg': 350.0}),
            ("empty dict", {}),
            ("None value", {'weight_kg': None}),
            ("empty string", {'weight_kg': ''}),
            ("list payload", {'weight_kg': [75.0]}),
        ]

        for label, payload in invalid_inputs_log_weight:
            r = client.post('/member/fitness/log-weight', json=payload)
            assert r.status_code == 400, f"Expected 400 for {label} on log-weight, got {r.status_code}"
            data = r.get_json()
            assert data.get('success') is False
            assert 'error' in data
            print(f"[PASS] log-weight rejected {label} with clean 400: '{data.get('error')}'")

        invalid_inputs_goal_weight = [
            ("non-numeric string", {'goal_weight_kg': 'heavy'}),
            ("NaN string", {'goal_weight_kg': 'NaN'}),
            ("Positive Infinity string", {'goal_weight_kg': 'inf'}),
            ("Negative Infinity string", {'goal_weight_kg': '-inf'}),
            ("negative number", {'goal_weight_kg': -60.0}),
            ("extreme low (<30 kg)", {'goal_weight_kg': 25.0}),
            ("extreme high (>300 kg)", {'goal_weight_kg': 400.0}),
            ("empty dict", {}),
            ("None value", {'goal_weight_kg': None}),
            ("empty string", {'goal_weight_kg': ''}),
        ]

        for label, payload in invalid_inputs_goal_weight:
            r = client.post('/member/fitness/set-goal-weight', json=payload)
            assert r.status_code == 400, f"Expected 400 for {label} on set-goal-weight, got {r.status_code}"
            data = r.get_json()
            assert data.get('success') is False
            assert 'error' in data
            print(f"[PASS] set-goal-weight rejected {label} with clean 400: '{data.get('error')}'")

        print("\nALL ADDENDUM 2 & PHASE 2.5 ENDPOINT AND SECURITY TESTS PASSED!")

    finally:
        # CLEANUP
        print("\n--- Cleaning up test data ---")
        with app.app_context():
            for uid in created_user_ids:
                WeightLog.query.filter_by(member_id=uid).delete()
                BodyGoal.query.filter_by(member_id=uid).delete()
                FitnessProfile.query.filter_by(member_id=uid).delete()
                Membership.query.filter_by(member_id=uid).delete()
                User.query.filter_by(id=uid).delete()
            db.session.commit()
            print("[CLEANUP] Purged all test users and associated rows.")

if __name__ == '__main__':
    run_all_tests()
