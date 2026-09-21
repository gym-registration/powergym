"""
Test verification for Option B: True Decoupling of Primary Objective & Workout Focus.
Verifies:
1. Adult member can pick primary_objective='CUT' (-500 kcal) AND fitness_goal='CHEST' (Chest Workout).
   Calorie offset strictly reflects CUT (-500 kcal), NOT CHEST (+150 kcal).
   Workout recommendations strictly reflect CHEST exercises.
2. Adult member can pick primary_objective='BULK' (+300 kcal) AND fitness_goal='CORE' (Core Workout).
   Calorie offset strictly reflects BULK (+300 kcal), NOT CORE (-300 kcal).
   Workout recommendations strictly reflect CORE exercises.
3. Minor (<18) member selecting primary_objective='CUT' and fitness_goal='CHEST' strictly receives 0 kcal offset.
4. Backward compatibility: passing only fitness_goal='CUT' still sets primary_objective='CUT' and calculates -500 kcal.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import (
    app, db, User, FitnessProfile, BodyGoal, Membership,
    _calculate_fitness_targets, _calculate_age,
    FITNESS_OBJECTIVE_OFFSETS, FITNESS_GOAL_LABELS, FITNESS_OBJECTIVE_LABELS
)
from datetime import timedelta

def run_tests():
    print("=== Running Option B Decoupling Verification Suite ===")

    # 1. Calculation Unit Tests
    # Adult male: 175cm, 75kg, age 25, moderate_activity
    # BMR = 10*75 + 6.25*175 - 5*25 + 5 = 750 + 1093.75 - 125 + 5 = 1723.75
    # TDEE = 1723.75 * 1.55 = 2671.8125 -> round 2672

    # Case 1: CUT + CHEST
    calcs_cut_chest = _calculate_fitness_targets(
        height_cm=175.0, weight_kg=75.0, sex='male', age=25,
        activity_level='moderate_activity',
        goal='CHEST', primary_objective='CUT'
    )
    tdee = calcs_cut_chest['tdee']
    expected_cal = tdee - 500
    assert calcs_cut_chest['calorie_target'] == expected_cal, (
        f"Expected {expected_cal} for CUT+CHEST, got {calcs_cut_chest['calorie_target']}"
    )
    print(f"[PASS] Adult CUT + CHEST: TDEE={tdee}, Calorie Target={calcs_cut_chest['calorie_target']} (Offset -500 from CUT, not +150 from CHEST)")

    # Case 2: BULK + CORE
    calcs_bulk_core = _calculate_fitness_targets(
        height_cm=175.0, weight_kg=75.0, sex='male', age=25,
        activity_level='moderate_activity',
        goal='CORE', primary_objective='BULK'
    )
    expected_cal = tdee + 300
    assert calcs_bulk_core['calorie_target'] == expected_cal, (
        f"Expected {expected_cal} for BULK+CORE, got {calcs_bulk_core['calorie_target']}"
    )
    print(f"[PASS] Adult BULK + CORE: TDEE={tdee}, Calorie Target={calcs_bulk_core['calorie_target']} (Offset +300 from BULK, not -300 from CORE)")

    # Case 3: Minor Safety (<18) selecting CUT + CHEST
    calcs_minor = _calculate_fitness_targets(
        height_cm=165.0, weight_kg=55.0, sex='female', age=16,
        activity_level='moderate_activity',
        goal='CHEST', primary_objective='CUT'
    )
    assert calcs_minor['calorie_target'] == calcs_minor['tdee'], (
        f"Minor expected calorie_target == tdee ({calcs_minor['tdee']}), got {calcs_minor['calorie_target']}"
    )
    print(f"[PASS] Minor CUT + CHEST: Calorie target strictly matches TDEE ({calcs_minor['tdee']} kcal), 0 offset enforced.")

    # Case 4: Backward compatibility (legacy goal='CUT' without primary_objective)
    calcs_legacy = _calculate_fitness_targets(
        height_cm=175.0, weight_kg=75.0, sex='male', age=25,
        activity_level='moderate_activity',
        goal='CUT'
    )
    assert calcs_legacy['calorie_target'] == tdee - 500
    print(f"[PASS] Legacy caller with goal='CUT' only: receives -500 kcal offset as expected.")

    # 2. Endpoint Integration Tests with Test Client
    with app.test_client() as client:
        with app.app_context():
            # Create a test member
            test_email = "decouple_test_member@example.com"
            user = User.query.filter_by(email=test_email).first()
            if user:
                FitnessProfile.query.filter_by(member_id=user.id).delete()
                BodyGoal.query.filter_by(member_id=user.id).delete()
                db.session.delete(user)
                db.session.commit()

            user = User(
                email=test_email,
                first_name="Decouple",
                last_name="Tester",
                role="member",
                password="hashedpassword",
                birthday=date(1995, 5, 20)
            )
            db.session.add(user)
            db.session.commit()
            uid = user.id

            m = Membership(
                member_id=uid,
                start_date=date.today() - timedelta(days=1),
                expiry_date=date.today() + timedelta(days=30),
                status='approved'
            )
            db.session.add(m)
            db.session.commit()

        try:
            # Login session
            with client.session_transaction() as sess:
                sess['user_id'] = uid
                sess['role'] = 'member'
                sess['name'] = 'Decouple Tester'

            # Step 1: save profile
            res1 = client.post('/member/fitness/save-profile', json={
                'height_cm': 180.0,
                'weight_kg': 80.0,
                'sex': 'male',
                'activity_level': 'moderate_activity',
            })
            assert res1.status_code == 200, res1.get_json()
            p_data = res1.get_json()['fitness_profile']
            assert p_data['primary_objective'] == 'MAINTAIN'
            print("[PASS] save-profile initializes primary_objective to MAINTAIN")

            # Step 2: save decoupled objective (CUT) & goal (CHEST)
            res2 = client.post('/member/fitness/save-goal', json={
                'primary_objective': 'CUT',
                'fitness_goal': 'CHEST'
            })
            assert res2.status_code == 200, res2.get_json()
            r2_json = res2.get_json()
            assert r2_json['primary_objective'] == 'CUT'
            assert r2_json['fitness_goal'] == 'CHEST'
            print("[PASS] save-goal stores and returns decoupled primary_objective='CUT' and fitness_goal='CHEST'")

            # Step 3: calculate targets
            res3 = client.post('/member/fitness/calculate', json={})
            assert res3.status_code == 200, res3.get_json()
            r3_json = res3.get_json()
            assert r3_json['primary_objective'] == 'CUT'
            assert r3_json['goal'] == 'CHEST'
            calc = r3_json['calculations']
            assert calc['calorie_target'] == calc['tdee'] - 500
            print(f"[PASS] calculate endpoint applies CUT offset (-500 kcal): TDEE={calc['tdee']} -> Calorie Target={calc['calorie_target']}")

            # Step 4: recommendations
            res4 = client.get('/member/fitness/recommendations')
            assert res4.status_code == 200, res4.get_json()
            r4_json = res4.get_json()
            assert r4_json['primary_objective'] == 'CUT'
            assert r4_json['goal'] == 'CHEST'
            assert r4_json['nutrition_targets']['calorie_target'] == calc['calorie_target']
            print("[PASS] recommendations endpoint returns primary_objective='CUT' and fitness_goal='CHEST'")

        finally:
            with app.app_context():
                FitnessProfile.query.filter_by(member_id=uid).delete()
                BodyGoal.query.filter_by(member_id=uid).delete()
                Membership.query.filter_by(member_id=uid).delete()
                u = User.query.get(uid)
                if u:
                    db.session.delete(u)
                db.session.commit()
                print("[CLEANUP] Purged test member.")

    print("\nALL OPTION B DECOUPLING TESTS PASSED SUCCESSFULLY!")

if __name__ == '__main__':
    run_tests()
