"""
Unit test suite for Phase 2 Body Goals backend changes and Addendum requirements.
Cleans up all test users and records upon completion.
"""
import sys
import os
import unittest
from datetime import date, datetime, timezone, timedelta

# Add project root to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app import (
    app, db, User, Membership, MembershipPlan, FitnessProfile, BodyGoal,
    WeightLog, _reset_expired_fitness_plan, _calculate_age, _recommend_weekly_routine
)


class Phase2BackendTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.config['TESTING'] = True
        app.config['WTF_CSRF_ENABLED'] = False
        cls.client = app.test_client()

    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        self.created_user_ids = []

    def tearDown(self):
        for uid in self.created_user_ids:
            u = User.query.get(uid)
            if u:
                # Cascade deletes body_goals, weight_logs, fitness_profile, membership
                db.session.delete(u)
        db.session.commit()
        self.ctx.pop()

    def _create_test_member(self, email, birthday, active_membership=True):
        u = User.query.filter_by(email=email).first()
        if u:
            db.session.delete(u)
            db.session.commit()

        u = User(
            email=email,
            password='hashed_password_placeholder',
            first_name='Test',
            last_name='User',
            role='member',
            birthday=birthday,
        )
        db.session.add(u)
        db.session.flush()
        self.created_user_ids.append(u.id)

        if active_membership:
            plan = MembershipPlan.query.first()
            if not plan:
                plan = MembershipPlan(name='Monthly Test', price=1000.0, duration_months=1)
                db.session.add(plan)
                db.session.flush()

            m = Membership(
                member_id=u.id,
                plan_id=plan.id,
                start_date=date.today() - timedelta(days=5),
                expiry_date=date.today() + timedelta(days=25),
                status='active'
            )
            db.session.add(m)

        db.session.commit()
        return u

    def test_derived_day_focus_for_chest(self):
        """Confirm derived routine title for CHEST Day 1 is 'Chest', not 'Chest & Legs'."""
        routine, _ = _recommend_weekly_routine('CHEST', 'moderate_activity')
        day1 = routine['days'][0]
        self.assertEqual(day1['day_number'], 1)
        self.assertEqual(day1['focus'], 'Chest', f"Expected 'Chest', got {day1['focus']}")

    def test_under_14_birthday_error_string(self):
        """Confirm error string for under 14 is 'Body Goals is available for members aged 14 and older.'"""
        u = self._create_test_member('test_under14@example.com', birthday=None, active_membership=True)
        under14_bday = (date.today() - timedelta(days=365 * 13)).strftime('%Y-%m-%d')

        with self.client.session_transaction() as sess:
            sess['user_id'] = u.id
            sess['role'] = 'member'

        res = self.client.post('/member/fitness/save-profile', json={
            'height_cm': 160,
            'weight_kg': 50,
            'sex': 'female',
            'activity_level': 'low_activity',
            'birthday': under14_bday
        })
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertEqual(
            data.get('error'),
            'Body Goals is available for members aged 14 and older.',
            f"Got: {data.get('error')}"
        )

    def test_reset_expired_plan_preserves_weight_logs(self):
        """Addendum 1: _reset_expired_fitness_plan must NOT delete weight_logs."""
        adult_bday = date.today() - timedelta(days=365 * 25)
        u = self._create_test_member('test_expired_logs@example.com', birthday=adult_bday, active_membership=False)

        # Manually create profile, goal, and weight logs
        profile = FitnessProfile(member_id=u.id, height_cm=175, sex='male', activity_level='moderate_activity', fitness_goal='CHEST')
        db.session.add(profile)
        body_goal = BodyGoal(member_id=u.id, current_weight=75.0, calorie_target=2500, protein_target_g=140)
        db.session.add(body_goal)
        w1 = WeightLog(member_id=u.id, weight_kg=76.0, logged_at=datetime.now(timezone.utc) - timedelta(days=3))
        w2 = WeightLog(member_id=u.id, weight_kg=75.0, logged_at=datetime.now(timezone.utc))
        db.session.add_all([w1, w2])
        db.session.commit()

        # Run reset
        changed = _reset_expired_fitness_plan(u)
        self.assertTrue(changed)

        # Verify FitnessProfile deleted and targets cleared
        prof_after = FitnessProfile.query.filter_by(member_id=u.id).first()
        self.assertIsNone(prof_after)
        goal_after = BodyGoal.query.filter_by(member_id=u.id).first()
        self.assertIsNotNone(goal_after)
        self.assertIsNone(goal_after.calorie_target)
        self.assertIsNone(goal_after.current_weight)

        # Crucial check: weight_logs survived!
        logs_after = WeightLog.query.filter_by(member_id=u.id).all()
        self.assertEqual(len(logs_after), 2, "Weight logs should survive membership reset")
        self.assertEqual(float(logs_after[0].weight_kg), 76.0)
        self.assertEqual(float(logs_after[1].weight_kg), 75.0)

    def test_log_weight_adult_flow_and_recalc_prompt(self):
        """Test logging weights, diff calculation >= 2.0 kg, and delete weight entry."""
        adult_bday = date.today() - timedelta(days=365 * 25)
        u = self._create_test_member('test_adult_log@example.com', birthday=adult_bday, active_membership=True)

        with self.client.session_transaction() as sess:
            sess['user_id'] = u.id
            sess['role'] = 'member'

        # Step 1 & 2 setup
        res = self.client.post('/member/fitness/save-profile', json={
            'height_cm': 175,
            'weight_kg': 75.0,
            'sex': 'male',
            'activity_level': 'moderate_activity',
        })
        self.assertEqual(res.status_code, 200)

        res = self.client.post('/member/fitness/save-goal', json={'fitness_goal': 'CHEST'})
        self.assertEqual(res.status_code, 200)

        # Calculate targets (sets calculated_weight = 75.0)
        res = self.client.post('/member/fitness/calculate')
        self.assertEqual(res.status_code, 200)

        prof = FitnessProfile.query.filter_by(member_id=u.id).first()
        self.assertIsNotNone(prof.calculated_weight)
        self.assertEqual(float(prof.calculated_weight), 75.0)

        # Log weight 75.5 (diff = 0.5 < 2.0 -> needs_target_update = False)
        res = self.client.post('/member/fitness/log-weight', json={'weight_kg': 75.5})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertFalse(data['needs_target_update'])
        self.assertEqual(data['weight_diff'], 0.5)
        log1_id = data['log_id']

        # Backdate log 1 to yesterday so today's log becomes a second entry
        wl1 = WeightLog.query.get(log1_id)
        wl1.log_date = date.today() - timedelta(days=1)
        wl1.logged_at = datetime.now(timezone.utc) - timedelta(days=1)
        db.session.commit()

        # Log weight 77.5 today (diff = 2.5 >= 2.0 -> needs_target_update = True)
        res = self.client.post('/member/fitness/log-weight', json={'weight_kg': 77.5})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data['needs_target_update'])
        self.assertEqual(data['weight_diff'], 2.5)
        log2_id = data['log_id']

        # Verify progress endpoint
        res = self.client.get('/member/fitness/progress')
        self.assertEqual(res.status_code, 200)
        prog_data = res.get_json()
        self.assertEqual(len(prog_data['chart_entries']), 2)
        self.assertEqual(prog_data['current_weight'], 77.5)
        self.assertTrue(prog_data['needs_target_update'])

        # Delete latest log
        res = self.client.delete(f'/member/fitness/delete-weight/{log2_id}')
        self.assertEqual(res.status_code, 200)

        # Current weight should sync back to remaining log (75.5)
        bg = BodyGoal.query.filter_by(member_id=u.id).first()
        self.assertEqual(float(bg.current_weight), 75.5)

    def test_goal_weight_validation(self):
        """Test goal weight validation (implied BMI 18.5 - 40.0) for adult."""
        adult_bday = date.today() - timedelta(days=365 * 25)
        u = self._create_test_member('test_goal_w@example.com', birthday=adult_bday, active_membership=True)

        with self.client.session_transaction() as sess:
            sess['user_id'] = u.id
            sess['role'] = 'member'

        # Height = 175cm -> safe weight range: 18.5*(1.75^2) = 56.7kg to 40*(1.75^2) = 122.5kg
        self.client.post('/member/fitness/save-profile', json={
            'height_cm': 175,
            'weight_kg': 80.0,
            'sex': 'male',
            'activity_level': 'moderate_activity',
        })

        # Underweight goal (45kg -> BMI 14.7 < 18.5)
        res = self.client.post('/member/fitness/set-goal-weight', json={'goal_weight_kg': 45.0})
        self.assertEqual(res.status_code, 400)
        self.assertIn('Goal weight must be between', res.get_json()['error'])
        self.assertNotIn('healthy', res.get_json()['error'].lower())

        # Severely obese goal (150kg -> BMI 49.0 > 40.0)
        res = self.client.post('/member/fitness/set-goal-weight', json={'goal_weight_kg': 150.0})
        self.assertEqual(res.status_code, 400)
        self.assertIn('Goal weight must be between', res.get_json()['error'])
        self.assertNotIn('healthy', res.get_json()['error'].lower())

        # Valid goal (72kg -> BMI 23.5)
        res = self.client.post('/member/fitness/set-goal-weight', json={'goal_weight_kg': 72.0})
        self.assertEqual(res.status_code, 200)
        bg = BodyGoal.query.filter_by(member_id=u.id).first()
        self.assertEqual(float(bg.goal_weight), 72.0)

    def test_minor_rejected_from_progress_endpoints(self):
        """Minors (<18) must be rejected from log-weight, set-goal-weight, and progress."""
        minor_bday = date.today() - timedelta(days=365 * 16)
        u = self._create_test_member('test_minor_safety@example.com', birthday=minor_bday, active_membership=True)

        with self.client.session_transaction() as sess:
            sess['user_id'] = u.id
            sess['role'] = 'member'

        self.client.post('/member/fitness/save-profile', json={
            'height_cm': 165,
            'weight_kg': 55.0,
            'sex': 'female',
            'activity_level': 'moderate_activity',
        })

        # Try log-weight
        res = self.client.post('/member/fitness/log-weight', json={'weight_kg': 56.0})
        self.assertEqual(res.status_code, 403)
        self.assertIn('adult members only', res.get_json()['error'])

        # Try set-goal-weight
        res = self.client.post('/member/fitness/set-goal-weight', json={'goal_weight_kg': 52.0})
        self.assertEqual(res.status_code, 403)
        self.assertIn('adult members only', res.get_json()['error'])

        # Try progress
        res = self.client.get('/member/fitness/progress')
        self.assertEqual(res.status_code, 403)
        self.assertIn('adult members only', res.get_json()['error'])


if __name__ == '__main__':
    unittest.main()
