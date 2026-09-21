"""
Read-only script to compare calculated calorie and protein targets against
generated sample meal plan totals for:
1. One adult male
2. One adult female
3. One minor (under 18)
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import app, _calculate_fitness_targets, _recommend_meal_plan

def compare_targets_and_meal_plans():
    profiles = [
        {
            'label': 'Adult Male',
            'height_cm': 175.0,
            'weight_kg': 75.0,
            'sex': 'male',
            'age': 28,
            'activity_level': 'moderate_activity',
            'fitness_goal': 'CHEST',
        },
        {
            'label': 'Adult Female',
            'height_cm': 162.0,
            'weight_kg': 58.0,
            'sex': 'female',
            'age': 26,
            'activity_level': 'moderate_activity',
            'fitness_goal': 'LEGS',
        },
        {
            'label': 'Minor (15yo Male)',
            'height_cm': 165.0,
            'weight_kg': 55.0,
            'sex': 'male',
            'age': 15,
            'activity_level': 'high_activity',
            'fitness_goal': 'FULL_BODY',
        }
    ]

    print("=========================================================================================")
    print("                     MEAL PLAN VS CALCULATED TARGETS (READ-ONLY)                        ")
    print("=========================================================================================")

    with app.app_context():
        for p in profiles:
            calcs = _calculate_fitness_targets(
                height_cm=p['height_cm'],
                weight_kg=p['weight_kg'],
                sex=p['sex'],
                age=p['age'],
                activity_level=p['activity_level'],
                goal=p['fitness_goal'],
            )

            meal_plan = _recommend_meal_plan(
                calorie_target=calcs['calorie_target'],
                protein_target_g=calcs['protein_target_g'],
            )

            print(f"\n--- {p['label']} ({p['sex'].capitalize()}, Age {p['age']}, {p['height_cm']}cm, {p['weight_kg']}kg, Goal: {p['fitness_goal']}, Activity: {p['activity_level']}) ---")
            print(f"  Calculated Targets:")
            print(f"    - Daily Calorie Target: {calcs['calorie_target']} kcal (BMR: {calcs['bmr']} kcal, TDEE: {calcs['tdee']} kcal)")
            print(f"    - Daily Protein Target: {calcs['protein_target_g']} g")
            print(f"  Sample Meal Plan Totals:")
            print(f"    - Meal Plan Calories:   {meal_plan['total_calories']} kcal ({round(meal_plan['total_calories']/calcs['calorie_target']*100, 1)}% of target)")
            print(f"    - Meal Plan Protein:    {meal_plan['total_protein_g']} g ({round(meal_plan['total_protein_g']/calcs['protein_target_g']*100, 1)}% of target)")
            print(f"  Meals Breakdown:")
            for meal_name, m_data in meal_plan['meals'].items():
                items_summary = ", ".join([f"{it['name']} ({it['calories']}kcal, {it['protein_g']}g prot)" for it in m_data['items']])
                print(f"    * {meal_name.capitalize()}: {m_data['meal_calories']} kcal · {m_data['meal_protein_g']}g protein | {items_summary}")

if __name__ == '__main__':
    compare_targets_and_meal_plans()
