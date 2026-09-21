"""
Standalone script to audit and refresh fitness targets for minor members.
DO NOT execute automatically — for review and manual execution by the administrator.

Usage:
  python tests/refresh_minor_targets.py --dry-run
  python tests/refresh_minor_targets.py --execute
"""
import sys
import os
import argparse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import app, db, User, FitnessProfile, BodyGoal, _calculate_age, _calculate_fitness_targets


def audit_and_refresh_minors(execute=False):
    with app.app_context():
        members = User.query.filter_by(role='member').all()
        minors_needing_refresh = []

        for user in members:
            age = _calculate_age(user.birthday)
            if age is None or age >= 18:
                continue

            # Check latest body goal
            bg = (
                BodyGoal.query
                .filter_by(member_id=user.id)
                .order_by(BodyGoal.recorded_at.desc(), BodyGoal.id.desc())
                .first()
            )
            fp = FitnessProfile.query.filter_by(member_id=user.id).first()

            if not bg or bg.calorie_target is None or bg.tdee is None:
                continue

            current_offset = bg.calorie_target - bg.tdee
            if current_offset != 0:
                minors_needing_refresh.append({
                    'user_id': user.id,
                    'name': f"{user.first_name} {user.last_name}",
                    'email': user.email,
                    'birthday': str(user.birthday),
                    'age': age,
                    'goal': fp.fitness_goal if fp else 'Unknown',
                    'height_cm': float(fp.height_cm) if fp and fp.height_cm else None,
                    'weight_kg': float(bg.current_weight) if bg.current_weight else None,
                    'sex': fp.sex if fp else None,
                    'activity_level': fp.activity_level if fp else None,
                    'tdee': int(bg.tdee),
                    'old_calorie_target': int(bg.calorie_target),
                    'old_offset': int(current_offset),
                    'bg_id': bg.id,
                })

        print(f"Found {len(minors_needing_refresh)} minor member(s) with non-zero calorie offsets:")
        for item in minors_needing_refresh:
            print(f" - ID {item['user_id']}: {item['name']} ({item['email']}), Age {item['age']}, Goal {item['goal']}")
            print(f"   TDEE: {item['tdee']} kcal | Old Target: {item['old_calorie_target']} kcal (offset {item['old_offset']:+d} kcal)")

        if not execute:
            print("\n[DRY RUN] No database changes made. Pass --execute to update these rows to offset 0.")
            return

        print("\n[EXECUTE] Updating rows to zero offset...")
        for item in minors_needing_refresh:
            bg = db.session.get(BodyGoal, item['bg_id'])
            if bg and item['height_cm'] and item['weight_kg'] and item['sex'] and item['activity_level']:
                new_calcs = _calculate_fitness_targets(
                    height_cm=item['height_cm'],
                    weight_kg=item['weight_kg'],
                    sex=item['sex'],
                    age=item['age'],
                    activity_level=item['activity_level'],
                    goal=item['goal'],
                )
                bg.calorie_target = new_calcs['calorie_target']
                print(f"   Updated User {item['user_id']} ({item['name']}): calorie_target set to {bg.calorie_target} kcal")
        db.session.commit()
        print("Done. All minor targets refreshed to zero offset.")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Audit and refresh minor members' calorie targets.")
    parser.add_argument('--execute', action='store_true', help="Apply changes to the database.")
    args = parser.parse_args()

    audit_and_refresh_minors(execute=args.execute)
