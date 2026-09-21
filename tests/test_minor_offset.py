"""
Unit test for adolescent calorie offset safety:
Minors (age < 18) must receive an offset of 0 regardless of fitness goal,
so that calorie_target equals TDEE (subject to nutritional safety floors).
Adults (age >= 18) receive the standard goal-based caloric deficit or surplus.
"""
import unittest
from app import _calculate_fitness_targets, FITNESS_GOAL_CALORIE_OFFSETS


class TestMinorCalorieOffset(unittest.TestCase):
    def test_14_year_old_core_vs_adult_core(self):
        # Setup identical body metrics except age
        height_cm = 165.0
        weight_kg = 55.0
        sex = 'female'
        activity_level = 'moderate_activity'
        goal = 'CORE'

        # Minor: 14 years old
        minor_res = _calculate_fitness_targets(
            height_cm=height_cm,
            weight_kg=weight_kg,
            sex=sex,
            age=14,
            activity_level=activity_level,
            goal=goal,
        )

        # Adult: 25 years old
        adult_res = _calculate_fitness_targets(
            height_cm=height_cm,
            weight_kg=weight_kg,
            sex=sex,
            age=25,
            activity_level=activity_level,
            goal=goal,
        )

        # Minor check: calorie_target must equal TDEE (0 offset)
        self.assertEqual(
            minor_res['calorie_target'],
            minor_res['tdee'],
            f"Expected minor calorie target ({minor_res['calorie_target']}) to equal TDEE ({minor_res['tdee']}) with 0 offset."
        )

        # Adult check: calorie_target must reflect the goal's offset (-300 for CORE)
        expected_adult_offset = FITNESS_GOAL_CALORIE_OFFSETS['CORE']  # -300
        self.assertEqual(
            adult_res['calorie_target'],
            adult_res['tdee'] + expected_adult_offset,
            f"Expected adult calorie target ({adult_res['calorie_target']}) to equal TDEE + {expected_adult_offset} ({adult_res['tdee'] + expected_adult_offset})."
        )

    def test_all_goals_zero_offset_for_minors(self):
        height_cm = 175.0
        weight_kg = 65.0
        sex = 'male'
        age = 15
        activity_level = 'high_activity'

        for goal in ['CORE', 'CHEST', 'BACK', 'ARMS', 'LEGS', 'FULL_BODY', 'CUT', 'BULK']:
            res = _calculate_fitness_targets(
                height_cm=height_cm,
                weight_kg=weight_kg,
                sex=sex,
                age=age,
                activity_level=activity_level,
                goal=goal,
            )
            self.assertEqual(
                res['calorie_target'],
                res['tdee'],
                f"Minor (age 15) goal '{goal}' should have offset 0, got calorie_target={res['calorie_target']} vs tdee={res['tdee']}"
            )


if __name__ == '__main__':
    unittest.main()
