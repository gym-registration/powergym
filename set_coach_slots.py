"""Publish a coach's weekly bookable time slots for Coach Scheduling.

Members can only book slots that exist in the coach_availability table, so each
coach needs a schedule before anything shows up under "Book a Coach".

Examples (run from the project folder, same environment/.env as the app):

  python set_coach_slots.py --coach "Coach Name" --days Mon,Wed,Fri --from 09:00 --to 12:00
  python set_coach_slots.py --coach "Coach Name" --days Tue,Thu --from 13:00 --to 16:00 --minutes 45 --add
  python set_coach_slots.py --coach "Coach Name" --show

By default the coach's schedule is REPLACED by what you pass; use --add to keep
the slots they already have. Existing bookings are never touched.
(The same thing is available over HTTP: POST /staff/coach/<id>/availability.)
"""
import argparse
import sys
from datetime import datetime, timedelta

DAYS = {'mon': 0, 'tue': 1, 'wed': 2, 'thu': 3, 'fri': 4, 'sat': 5, 'sun': 6}
DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--coach', required=True, help='Coach name exactly as it appears in the coach list')
    ap.add_argument('--days', help='Comma-separated weekdays, e.g. Mon,Wed,Fri')
    ap.add_argument('--from', dest='start', help='First slot start, HH:MM (24h)')
    ap.add_argument('--to', dest='end', help='Last slot must END by this time, HH:MM (24h)')
    ap.add_argument('--minutes', type=int, default=60, help='Slot length in minutes (default 60)')
    ap.add_argument('--add', action='store_true', help='Keep existing slots instead of replacing them')
    ap.add_argument('--show', action='store_true', help='Only print the coach\'s current slots')
    args = ap.parse_args()

    from app import app, db, Coach, CoachAvailability   # importing does NOT start the server

    with app.app_context():
        db.create_all()    # no-op if the tables already exist
        coach = Coach.query.filter(db.func.lower(Coach.name) == args.coach.strip().lower()).first()
        if coach is None:
            names = ', '.join(c.name for c in Coach.query.order_by(Coach.name))
            sys.exit(f'No coach named "{args.coach}". Coaches: {names or "(none)"}')

        if args.show:
            rows = (CoachAvailability.query.filter_by(coach_id=coach.id)
                    .order_by(CoachAvailability.weekday, CoachAvailability.start_time).all())
            if not rows:
                print(f'{coach.name} has no published slots yet.')
            for r in rows:
                print(f'{DAY_NAMES[r.weekday]}  {r.start_time.strftime("%H:%M")}  ({r.duration_min} min)')
            return

        if not (args.days and args.start and args.end):
            sys.exit('--days, --from and --to are required (or use --show).')
        try:
            weekdays = sorted({DAYS[d.strip().lower()[:3]] for d in args.days.split(',') if d.strip()})
            t0 = datetime.strptime(args.start, '%H:%M')
            t1 = datetime.strptime(args.end, '%H:%M')
        except (KeyError, ValueError):
            sys.exit('Could not read --days (use Mon,Tue,...) or the times (use HH:MM, 24-hour).')
        if not 15 <= args.minutes <= 240 or t1 <= t0:
            sys.exit('--minutes must be 15-240 and --to must be later than --from.')

        starts = []
        cur = t0
        while cur + timedelta(minutes=args.minutes) <= t1:
            starts.append(cur.time())
            cur += timedelta(minutes=args.minutes)
        if not starts:
            sys.exit('That window is shorter than one slot.')

        if not args.add:
            CoachAvailability.query.filter_by(coach_id=coach.id).delete()
        have = {(r.weekday, r.start_time) for r in CoachAvailability.query.filter_by(coach_id=coach.id)}
        added = 0
        for wd in weekdays:
            for st in starts:
                if (wd, st) not in have:
                    db.session.add(CoachAvailability(coach_id=coach.id, weekday=wd, start_time=st,
                                                     duration_min=args.minutes, is_active=True))
                    added += 1
        db.session.commit()
        print(f'{coach.name}: saved {added} slot(s) '
              f'({", ".join(DAY_NAMES[w] for w in weekdays)} · {len(starts)} per day).')


if __name__ == '__main__':
    main()
