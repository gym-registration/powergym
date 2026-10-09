"""Coach Scheduling — member booking of coach sessions.

Registered from app.py with register(app, db, ...). All routes live here so the
existing app.py stays almost untouched; authentication is the app's own session
(`session['user_id']`, `session['role']`) exactly like every other route.

Business rules (all enforced SERVER-SIDE, the UI only mirrors them):
  * Staff set the days and working hours of each coach (CoachAvailability). INSIDE
    those hours the MEMBER decides the session: the start time and how long it
    lasts (minimum 15 minutes, no maximum). The system only refuses times in the
    past, outside the coach's working hours, or overlapping another booking.
    There is NO limit on how far ahead a member may book.
  * One session per member per day: a member with a pending/confirmed/completed
    session on a date can't book another one that same date.
  * After a coach finishes a session the coach is held back for the rest of that
    day until staff press "Mark available" (the coach tells staff they are free).
    The release is per coach per day (CoachDayRelease).
  * Staff are notified of every new booking (pending requests badge + alert).
  * Members get a reminder when their booked session is within an hour (REMINDER_MINUTES).
  * Double-booking is impossible: checked in code AND backed by UNIQUE keys on
    CoachBooking (coach_key / member_key) so a race between two requests fails
    cleanly at the database instead of creating two bookings.
  * A member with 0 session credits can't book. Pending/confirmed bookings are
    "reserved" against the remaining credits, so nobody can book more upcoming
    sessions than they have credits for.
  * A credit is deducted ONLY when staff mark a booking Completed. Booking,
    confirming, cancelling and no-shows never touch credits.

Slot datetimes are naive gym-local (Manila) times; created/completed/cancelled
timestamps are naive UTC like the rest of the app.
"""
from datetime import datetime, timedelta, time, timezone

from flask import jsonify, request, session, url_for
from sqlalchemy.exc import IntegrityError

ACTIVE = ('pending', 'confirmed')
MAX_ADVANCE_DAYS = None        # no limit on how far ahead a member may book
REMINDER_MINUTES = 60          # members are reminded when their session is this close
MIN_SESSION_MINUTES = 15       # the only floor: a session can't be shorter than this
COUNTS_FOR_DAY = ('pending', 'confirmed', 'completed')   # bookings that use up a member's day
STATUS_LABELS = {
    'pending': 'Pending', 'confirmed': 'Confirmed', 'completed': 'Completed',
    'cancelled': 'Cancelled', 'no_show': 'No-show',
}
_WEEKDAYS = {'mon': 0, 'tue': 1, 'wed': 2, 'thu': 3, 'fri': 4, 'sat': 5, 'sun': 6}

# Default bookable hours used for a coach who has "Available Days" set on the Coach
# tab but no custom time slots saved under Coach Schedule > Coach Availability.
DEFAULT_SLOT_START = time(8, 0)
DEFAULT_SLOT_END = time(20, 0)      # last slot must END by this time
DEFAULT_SLOT_MINUTES = 60


def register(app, db, *, User, Membership, Coach, CoachAvailability, CoachBooking, CoachDayRelease,
             now_manila, today_manila, sessions_info, sync_session_expiry, Payment):

    # ── helpers ────────────────────────────────────────────────────────
    def _now():
        """Current gym-local time as a NAIVE datetime (slot times are naive)."""
        return now_manila().replace(tzinfo=None, microsecond=0)

    def _utcnow():
        return datetime.now(timezone.utc).replace(tzinfo=None)

    def _fmt_time(dt):
        return dt.strftime('%I:%M %p').lstrip('0')

    def _parse_date(raw):
        try:
            return datetime.strptime((raw or '').strip(), '%Y-%m-%d').date()
        except ValueError:
            return None

    def _parse_slot(raw):
        try:
            return datetime.strptime((raw or '').strip(), '%Y-%m-%dT%H:%M')
        except ValueError:
            return None

    def _keys(coach_id, member_id, start):
        stamp = start.strftime('%Y%m%d%H%M')
        return f'c{coach_id}:{stamp}', f'm{member_id}:{stamp}'

    def _member_or_error():
        if 'user_id' not in session or session.get('role') != 'member':
            return None, (jsonify(success=False, error='Not logged in.'), 401)
        user = User.query.get(session['user_id'])
        if user is None:
            session.clear()
            return None, (jsonify(success=False, error='User not found.'), 404)
        return user, None

    def _staff_or_error():
        if session.get('role') not in ('staff', 'admin'):
            return jsonify(success=False, error='Unauthorized.'), 403
        return None

    def _staff_only_or_error():
        """Confirming / declining / completing bookings is STAFF only; admins are view-only."""
        if session.get('role') != 'staff':
            return jsonify(success=False, error='Only staff can confirm or change coach bookings. Admins have view-only access.'), 403
        return None

    def _credits(member_id, lock=False):
        """Session credits for the member (same pool as the session-based
        promo). Not enabled → the member has no coach sessions to book with."""
        q = Membership.query.filter_by(member_id=member_id)
        if lock:
            q = q.with_for_update()
        m = q.first()
        info = None
        if m is not None and m.status == 'active':
            info = sessions_info(m)     # None for a normal time-based plan
        reserved = (CoachBooking.query
                    .filter(CoachBooking.member_id == member_id,
                            CoachBooking.status.in_(ACTIVE)).count())
        if info is None:
            return m, {'enabled': False, 'total': 0, 'used': 0, 'left': 0, 'reserved': reserved}
        return m, {'enabled': True, 'total': info['total'], 'used': info['used'],
                   'left': info['left'], 'reserved': reserved}

    def _assigned_coach(member_id):
        """The coach this member chose when they availed their plan/promo — taken from
        their most recent payment record (same source the My Membership page uses).
        None when they never picked a coach."""
        p = (Payment.query
             .filter(Payment.member_id == member_id,
                     Payment.status.notin_(('rejected', 'cancelled')))
             .order_by(Payment.paid_at.desc()).first())
        if p is None or not p.wants_coach or not p.coach_name:
            return None
        return Coach.query.filter_by(name=p.coach_name, is_active=True).first()

    def _coach_photo(c):
        return url_for('static', filename=c.photo_path) if c.photo_path else ''

    def _booking_json(b, now=None):
        now = now or _now()
        active = b.status in ACTIVE
        future = b.slot_start > now
        return {
            'id': b.id,
            'coach_id': b.coach_id,
            'coach_name': b.coach.name if b.coach else (b.coach_name or 'Coach (removed)'),
            'coach_photo': _coach_photo(b.coach) if b.coach else '',
            'date': b.slot_start.strftime('%Y-%m-%d'),
            'start': b.slot_start.strftime('%Y-%m-%dT%H:%M'),
            'start_label': _fmt_time(b.slot_start),
            'end_label': _fmt_time(b.slot_end),
            'status': b.status,
            'status_label': STATUS_LABELS.get(b.status, b.status.title()),
            'can_cancel': active and future,
            'can_reschedule': active and future,
            'credit_deducted': b.status == 'completed',
        }

    def _coach_weekdays(coach):
        """Weekdays (0=Mon..6=Sun) from the coach's 'Available Days' on the Coach tab."""
        return {_WEEKDAYS[d.strip().lower()[:3]] for d in coach.available_days_list
                if d.strip().lower()[:3] in _WEEKDAYS}

    def _coach_slot_defs(coach, weekday):
        """Bookable (start_time, duration_min) slots for this coach on a weekday.

        The Coach tab's Available Days is the single source of truth for WHICH days
        a coach works. If staff also saved custom time slots (Coach Availability),
        those decide the hours for that day; otherwise default hourly slots are used. This keeps
        the member, staff and admin views consistent."""
        if weekday not in _coach_weekdays(coach):
            return []
        rows = (CoachAvailability.query
                .filter_by(coach_id=coach.id, weekday=weekday, is_active=True)
                .order_by(CoachAvailability.start_time).all())
        if rows:    # custom hours saved for this specific day
            return [(r.start_time, r.duration_min) for r in rows]
        defs, cur = [], datetime.combine(datetime.today().date(), DEFAULT_SLOT_START)
        stop = datetime.combine(cur.date(), DEFAULT_SLOT_END)
        while cur + timedelta(minutes=DEFAULT_SLOT_MINUTES) <= stop:
            defs.append((cur.time(), DEFAULT_SLOT_MINUTES))
            cur += timedelta(minutes=DEFAULT_SLOT_MINUTES)
        return defs

    def _day_bounds(day):
        d0 = datetime.combine(day, time.min)
        return d0, d0 + timedelta(days=1)

    def _day_hold(coach_id, day, now=None):
        """(held, last_end) — is this coach held back for the rest of `day`?

        A coach is held once one of their sessions that day has ENDED, until staff
        press "Mark available" (a CoachDayRelease at/after that session's end).
        Only today can be held: future days have no finished sessions yet."""
        now = now or _now()
        if day != now.date():
            return False, None
        d0, d1 = _day_bounds(day)
        last_end = (db.session.query(db.func.max(CoachBooking.slot_end))
                    .filter(CoachBooking.coach_id == coach_id,
                            CoachBooking.status.in_(COUNTS_FOR_DAY),
                            CoachBooking.slot_start >= d0, CoachBooking.slot_start < d1,
                            CoachBooking.slot_end <= now).scalar())
        if last_end is None:
            return False, None
        rel = CoachDayRelease.query.filter_by(coach_id=coach_id, day=day).first()
        if rel is not None and rel.released_at >= last_end:
            return False, last_end
        return True, last_end

    def _member_day_booking(member_id, day, ignore_booking_id=None):
        """The member's pending/confirmed/completed booking on `day`, if any."""
        d0, d1 = _day_bounds(day)
        q = CoachBooking.query.filter(CoachBooking.member_id == member_id,
                                      CoachBooking.status.in_(COUNTS_FOR_DAY),
                                      CoachBooking.slot_start >= d0, CoachBooking.slot_start < d1)
        if ignore_booking_id:
            q = q.filter(CoachBooking.id != ignore_booking_id)
        return q.first()

    def _coach_window(coach, day):
        """(open, close) datetimes of the coach's working hours on `day`, or None when
        the coach doesn't work that day. Staff define these hours; the member chooses
        their own start time and length inside them."""
        defs = _coach_slot_defs(coach, day.weekday())
        if not defs:
            return None
        opens = min(datetime.combine(day, t) for t, _d in defs)
        closes = max(datetime.combine(day, t) + timedelta(minutes=d) for t, d in defs)
        return opens, min(closes, datetime.combine(day, time(23, 59)))

    def _parse_range(data):
        """Start + end the MEMBER chose. Accepts slot_end, or duration_min as a shortcut."""
        start = _parse_slot(data.get('slot_start'))
        end = _parse_slot(data.get('slot_end'))
        if end is None and start is not None:
            try:
                end = start + timedelta(minutes=int(data.get('duration_min')))
            except (TypeError, ValueError):
                end = None
        return start, end

    def _slot_error(coach_id, start, end, ignore_booking_id=None, member_id=None):
        """Validate the member's chosen start/end for this coach.
        Returns (coach, end, error_message). There is no maximum length."""
        # Lock the coach's row: concurrent requests for the same coach queue up here, so the
        # overlap check below can't be passed by two members/clicks at once.
        coach = Coach.query.filter_by(id=coach_id).with_for_update().first() if coach_id else None
        if coach is None or not coach.is_active:
            return None, None, 'That coach is not available.'
        if start is None or end is None:
            return coach, None, 'Please choose a start time and an end time.'
        if end.date() != start.date():
            return coach, end, 'A session has to start and end on the same day.'
        if (end - start) < timedelta(minutes=MIN_SESSION_MINUTES):
            return coach, end, f'A session must be at least {MIN_SESSION_MINUTES} minutes long.'
        if start <= _now():
            return coach, end, 'That time has already passed.'
        window = _coach_window(coach, start.date())
        if window is None:
            return coach, end, f'{coach.name} does not work on that day.'
        if start < window[0] or end > window[1]:
            return coach, end, (f'{coach.name} works {_fmt_time(window[0])} – {_fmt_time(window[1])} that day. '
                                'Please choose a time inside those hours.')

        # 0a) One coach session per member per day.
        if member_id:
            same_day = _member_day_booking(member_id, start.date(), ignore_booking_id)
            if same_day is not None:
                return coach, end, ('You already have a coach session on this day. '
                                    'Only one session per day is allowed — please pick another date.')
        # 0b) The coach just finished a session and staff haven't re-opened them yet.
        if _day_hold(coach.id, start.date())[0]:
            return coach, end, ('This coach is finishing a session and will be available again '
                                'once staff confirm. Please try again later or pick another date.')

        def _overlap(q):
            q = q.filter(CoachBooking.status.in_(ACTIVE),
                         CoachBooking.slot_start < end, CoachBooking.slot_end > start)
            if ignore_booking_id:
                q = q.filter(CoachBooking.id != ignore_booking_id)
            return q.first()

        # 1) The coach can't be booked twice at the same time (by anyone).
        clash = _overlap(CoachBooking.query.filter(CoachBooking.coach_id == coach.id))
        if clash is not None:
            return coach, end, (f'{coach.name} is already booked {_fmt_time(clash.slot_start)} – '
                                f'{_fmt_time(clash.slot_end)}. Please choose a time that doesn\'t overlap.')
        return coach, end, None

    def _reminder_for(member_id, now=None):
        """The member's next pending/confirmed session if it starts within REMINDER_MINUTES, else None."""
        now = now or _now()
        b = (CoachBooking.query
             .filter(CoachBooking.member_id == member_id, CoachBooking.status.in_(ACTIVE),
                     CoachBooking.slot_start > now,
                     CoachBooking.slot_start <= now + timedelta(minutes=REMINDER_MINUTES))
             .order_by(CoachBooking.slot_start).first())
        if b is None:
            return None
        mins = max(1, -(-int((b.slot_start - now).total_seconds()) // 60))     # round up to whole minutes
        return {
            'booking_id': b.id,
            'coach_name': b.coach.name if b.coach else (b.coach_name or 'your coach'),
            'start_label': _fmt_time(b.slot_start), 'end_label': _fmt_time(b.slot_end),
            'minutes': mins, 'status': b.status,
            'message': (f'Reminder: your session with {b.coach.name if b.coach else (b.coach_name or "your coach")} starts in '
                        f'{mins} minute{"s" if mins != 1 else ""} ({_fmt_time(b.slot_start)} – {_fmt_time(b.slot_end)}).'),
        }

    # ── member: read endpoints ─────────────────────────────────────────
    @app.route('/member/coach-scheduling/reminder', methods=['GET'])
    def cs_reminder():
        """Polled by the dashboard so a member is told when a booked session is an hour away."""
        user, err = _member_or_error()
        if err:
            return err
        return jsonify(success=True, reminder=_reminder_for(user.id))

    @app.route('/member/coach-scheduling/slots', methods=['GET'])
    def cs_slots():
        """For the chosen day: the coach's working hours and the stretches still free.
        The member picks any start/end inside a free stretch (no fixed slot lengths)."""
        user, err = _member_or_error()
        if err:
            return err
        today = today_manila()
        day = _parse_date(request.args.get('date')) or today
        if day < today:
            return jsonify(success=False, error='Please choose today or a later date.'), 400
        try:
            ignore_id = int(request.args.get('ignore_booking') or 0) or None   # the booking being moved
        except ValueError:
            ignore_id = None

        d0, d1 = _day_bounds(day)
        now = _now()
        busy_rows = (CoachBooking.query
                     .filter(CoachBooking.status.in_(ACTIVE),
                             CoachBooking.slot_start >= d0, CoachBooking.slot_start < d1)
                     .order_by(CoachBooking.slot_start).all())
        if ignore_id:
            busy_rows = [b for b in busy_rows if b.id != ignore_id]

        def _hhmm(dt):
            return dt.strftime('%H:%M')

        coaches_out = []
        mine_coach = _assigned_coach(user.id)      # members only see the coach they chose
        member_day = _member_day_booking(user.id, day, ignore_id)
        for c in ([mine_coach] if mine_coach else []):
            held, _since = _day_hold(c.id, day, now)
            window = _coach_window(c, day)
            mine_busy = [b for b in busy_rows if b.coach_id == c.id]
            free, window_out = [], None
            if window is not None:
                lo, hi = window
                if day == now.date():       # can't start in the past: round up to the next quarter hour
                    mins = now.hour * 60 + now.minute + (1 if (now.second or now.microsecond) else 0)
                    lo = max(lo, datetime.combine(day, time.min) + timedelta(minutes=-(-mins // 15) * 15))
                window_out = {'start': _hhmm(window[0]), 'end': _hhmm(window[1]),
                              'start_label': _fmt_time(window[0]), 'end_label': _fmt_time(window[1])}
                cur = lo
                for b in mine_busy:
                    if b.slot_end <= cur:
                        continue
                    if b.slot_start > cur and (min(b.slot_start, hi) - cur) >= timedelta(minutes=MIN_SESSION_MINUTES):
                        free.append((cur, min(b.slot_start, hi)))
                    cur = max(cur, b.slot_end)
                if hi - cur >= timedelta(minutes=MIN_SESSION_MINUTES):
                    free.append((cur, hi))
                if member_day is not None or held:
                    free = []        # nothing to pick: one session a day / coach on hold
            coaches_out.append({
                'id': c.id, 'name': c.name, 'photo': _coach_photo(c),
                'specialization': c.specialization or '', 'bio': c.bio or '',
                'window': window_out,
                'free': [{'start': _hhmm(a_), 'end': _hhmm(b_), 'start_label': _fmt_time(a_), 'end_label': _fmt_time(b_)}
                         for a_, b_ in free],
                'busy': [{'start_label': _fmt_time(b.slot_start), 'end_label': _fmt_time(b.slot_end),
                          'mine': b.member_id == user.id} for b in mine_busy],
                'has_available': bool(free),
                'day_held': held,
                'member_has_day_booking': member_day is not None,
                'min_minutes': MIN_SESSION_MINUTES,
            })
        _, credits = _credits(user.id)
        return jsonify(success=True, date=day.strftime('%Y-%m-%d'), coaches=coaches_out, credits=credits,
                       no_coach=mine_coach is None)

    @app.route('/member/coach-scheduling/overview', methods=['GET'])
    def cs_overview():
        """Everything the page needs apart from slots: credits, every booking
        (My Bookings + Schedule tabs), plus the Upcoming and History lists."""
        user, err = _member_or_error()
        if err:
            return err
        now = _now()
        rows = (CoachBooking.query.filter_by(member_id=user.id)
                .order_by(CoachBooking.slot_start.desc()).limit(300).all())
        bookings = [_booking_json(b, now) for b in rows]
        upcoming = sorted([x for x, b in zip(bookings, rows) if b.status in ACTIVE and b.slot_start > now],
                          key=lambda x: x['start'])
        history = [x for x, b in zip(bookings, rows)
                   if b.status in ('completed', 'cancelled', 'no_show')][:20]
        _, credits = _credits(user.id)
        today = today_manila()
        return jsonify(success=True, credits=credits, bookings=bookings,
                       upcoming=upcoming, history=history, reminder=_reminder_for(user.id, now),
                       today=today.strftime('%Y-%m-%d'),
                       last_date=None)       # no limit on how far ahead a member may book

    # ── member: write endpoints ────────────────────────────────────────
    @app.route('/member/coach-scheduling/book', methods=['POST'])
    def cs_book():
        user, err = _member_or_error()
        if err:
            return err
        data = request.get_json(silent=True) or {}
        start, end = _parse_range(data)
        try:
            coach_id = int(data.get('coach_id'))
        except (TypeError, ValueError):
            coach_id = None

        assigned = _assigned_coach(user.id)
        if assigned is None:
            return jsonify(success=False, code='no_coach',
                           error='You need to avail a coach from the promo first before you can book a session.'), 403
        if coach_id != assigned.id:
            return jsonify(success=False, error='You can only book your chosen coach.'), 403

        try:
            # Lock the membership row so two quick requests can't both pass the credit check.
            _, credits = _credits(user.id, lock=True)
            if not credits['enabled']:
                db.session.rollback()
                return jsonify(success=False, code='no_credits',
                               error='You need an active session plan with coach sessions to book a coach.'), 403
            if credits['left'] <= 0:
                db.session.rollback()
                return jsonify(success=False, code='no_credits',
                               error='You have no coach sessions left.'), 403
            if credits['reserved'] >= credits['left']:
                db.session.rollback()
                return jsonify(success=False, code='all_reserved',
                               error='Your remaining sessions are already reserved by upcoming bookings.'), 409

            coach, end, problem = _slot_error(coach_id, start, end, member_id=user.id)
            if problem:
                db.session.rollback()
                return jsonify(success=False, error=problem), 409

            ckey, mkey = _keys(coach.id, user.id, start)
            booking = CoachBooking(member_id=user.id, coach_id=coach.id, coach_name=coach.name, slot_start=start,
                                   slot_end=end, status='pending', coach_key=ckey, member_key=mkey)
            db.session.add(booking)
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            return jsonify(success=False, error='That slot has just been booked. Please pick another time.'), 409

        return jsonify(success=True, message=f'Session requested with {coach.name}, {_fmt_time(start)} – {_fmt_time(end)} — waiting for confirmation.',
                       booking=_booking_json(booking))

    def _own_active_booking(user, booking_id):
        try:
            booking_id = int(booking_id)
        except (TypeError, ValueError):
            booking_id = None
        b = CoachBooking.query.filter_by(id=booking_id, member_id=user.id).with_for_update().first() \
            if booking_id else None
        if b is None:
            return None, (jsonify(success=False, error='Booking not found.'), 404)
        if b.status not in ACTIVE:
            return None, (jsonify(success=False, error=f'This booking is already {STATUS_LABELS.get(b.status, b.status).lower()}.'), 409)
        if b.slot_start <= _now():
            return None, (jsonify(success=False, error='This session has already started, so it can no longer be changed.'), 409)
        return b, None

    @app.route('/member/coach-scheduling/cancel', methods=['POST'])
    def cs_cancel():
        user, err = _member_or_error()
        if err:
            return err
        data = request.get_json(silent=True) or {}
        b, problem = _own_active_booking(user, data.get('booking_id'))
        if problem:
            db.session.rollback()
            return problem
        b.status = 'cancelled'
        b.coach_key = None
        b.member_key = None
        b.cancelled_at = _utcnow()
        db.session.commit()          # no credit was ever deducted, so nothing to give back
        return jsonify(success=True, message='Session cancelled.', booking=_booking_json(b))

    @app.route('/member/coach-scheduling/reschedule', methods=['POST'])
    def cs_reschedule():
        user, err = _member_or_error()
        if err:
            return err
        data = request.get_json(silent=True) or {}
        start, end = _parse_range(data)
        try:
            coach_id = int(data.get('coach_id'))
        except (TypeError, ValueError):
            coach_id = None
        assigned = _assigned_coach(user.id)
        if assigned is None or coach_id != assigned.id:
            return jsonify(success=False, error='You can only book your chosen coach.'), 403
        try:
            b, problem = _own_active_booking(user, data.get('booking_id'))
            if problem:
                db.session.rollback()
                return problem
            coach, end, problem = _slot_error(coach_id, start, end, ignore_booking_id=b.id, member_id=user.id)
            if problem:
                db.session.rollback()
                return jsonify(success=False, error=problem), 409
            ckey, mkey = _keys(coach.id, user.id, start)
            b.coach_id, b.coach_name, b.slot_start, b.slot_end = coach.id, coach.name, start, end
            b.coach_key, b.member_key = ckey, mkey
            b.status = 'pending'     # a moved session needs confirming again
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            return jsonify(success=False, error='That slot has just been booked. Please pick another time.'), 409
        return jsonify(success=True, message=f'Session moved to {_fmt_time(start)} – {_fmt_time(end)} — waiting for confirmation.',
                       booking=_booking_json(b))

    # ── staff / admin: status changes (this is where a credit is deducted) ──
    _TRANSITIONS = {
        'confirmed': ('pending',),
        'cancelled': ('pending', 'confirmed'),
        'completed': ('confirmed',),
        'no_show':   ('confirmed',),
    }

    @app.route('/staff/coach-bookings', methods=['GET'])
    def cs_staff_list():
        err = _staff_or_error()
        if err:
            return err
        q = CoachBooking.query
        status = (request.args.get('status') or '').strip()
        if status:
            q = q.filter(CoachBooking.status == status)
        day = _parse_date(request.args.get('date'))
        if day:
            q = q.filter(CoachBooking.slot_start >= datetime.combine(day, time.min),
                         CoachBooking.slot_start < datetime.combine(day + timedelta(days=1), time.min))
        try:
            coach_filter = int(request.args.get('coach_id') or 0)
        except ValueError:
            coach_filter = 0
        if coach_filter:
            q = q.filter(CoachBooking.coach_id == coach_filter)
        now = _now()
        out = []
        for b in q.order_by(CoachBooking.slot_start.desc()).limit(300).all():
            j = _booking_json(b, now)
            j['member_id'] = b.member_id
            j['member_name'] = b.member.full_name if b.member else ''
            j['member_photo'] = (url_for('static', filename=b.member.profile_picture)
                                 if b.member and getattr(b.member, 'profile_picture', None) else '')
            j['created_label'] = b.created_at.strftime('%b %d, %Y') if b.created_at else ''
            out.append(j)
        # Requests still waiting for staff (future ones only) — drives the tab badge.
        pending_count = (CoachBooking.query
                         .filter(CoachBooking.status == 'pending', CoachBooking.slot_start > now).count())
        return jsonify(success=True, bookings=out, pending_count=pending_count)

    @app.route('/staff/coach-scheduling/coaches', methods=['GET'])
    def cs_staff_coaches():
        """Coach picker for the Coach Schedule screen: every coach plus how many
        weekly slots they currently offer."""
        err = _staff_or_error()
        if err:
            return err
        counts = dict(db.session.query(CoachAvailability.coach_id, db.func.count(CoachAvailability.id))
                      .filter(CoachAvailability.is_active.is_(True))
                      .group_by(CoachAvailability.coach_id).all())
        return jsonify(success=True, coaches=[{
            'id': c.id, 'name': c.name, 'photo': _coach_photo(c),
            'specialization': c.specialization or '', 'is_active': bool(c.is_active),
            'working_days': sum(1 for wd in range(7) if _coach_slot_defs(c, wd)),
            'slot_count': int(counts.get(c.id, 0)) or sum(len(_coach_slot_defs(c, wd)) for wd in range(7)),
        } for c in Coach.query.order_by(Coach.name).all()])

    @app.route('/staff/coach-bookings/<int:booking_id>/status', methods=['POST'])
    def cs_staff_status(booking_id):
        err = _staff_only_or_error()
        if err:
            return err
        data = request.get_json(silent=True) or request.form
        new_status = (data.get('status') or '').strip().lower()
        if new_status not in _TRANSITIONS:
            return jsonify(success=False, error='Status must be confirmed, completed, cancelled or no_show.'), 400

        b = CoachBooking.query.filter_by(id=booking_id).with_for_update().first()
        if b is None:
            db.session.rollback()
            return jsonify(success=False, error='Booking not found.'), 404
        if b.status not in _TRANSITIONS[new_status]:
            db.session.rollback()
            return jsonify(success=False,
                           error=f'A {STATUS_LABELS.get(b.status, b.status).lower()} booking can\'t be marked {STATUS_LABELS[new_status].lower()}.'), 409
        if new_status in ('completed', 'no_show') and b.slot_start > _now():
            db.session.rollback()
            return jsonify(success=False, error='This session hasn\'t started yet.'), 409

        credits_left = None
        if new_status == 'completed':
            membership, credits = _credits(b.member_id, lock=True)
            if credits['enabled'] and credits['left'] <= 0:
                db.session.rollback()
                return jsonify(success=False, error='This member has no coach sessions left to deduct.'), 409
            b.status = 'completed'
            b.completed_at = _utcnow()
            b.coach_key = b.member_key = None
            db.session.flush()       # credits are COUNTED from completed bookings, so flush before syncing
            if membership is not None:
                sync_session_expiry(membership)
            credits_left = _credits(b.member_id)[1]['left']
        else:
            b.status = new_status
            if new_status != 'confirmed':
                b.coach_key = b.member_key = None
                if new_status == 'cancelled':
                    b.cancelled_at = _utcnow()
        db.session.commit()
        return jsonify(success=True, message=f'Booking marked {STATUS_LABELS[new_status].lower()}.',
                       booking=_booking_json(b), credits_left=credits_left)

    # ── staff / admin: coach slot schedule ─────────────────────────────
    @app.route('/staff/coach/<int:coach_id>/availability', methods=['GET', 'POST'])
    def cs_staff_availability(coach_id):
        err = _staff_or_error()
        if err:
            return err
        coach = Coach.query.get(coach_id)
        if coach is None:
            return jsonify(success=False, error='Coach not found.'), 404

        if request.method == 'GET':
            # Always return what members actually get: saved slots, default hours on days
            # without any, and nothing on days the coach doesn't work.
            return jsonify(success=True, slots=[
                {'weekday': wd, 'start': t.strftime('%H:%M'), 'duration_min': d, 'is_active': True}
                for wd in range(7) for t, d in _coach_slot_defs(coach, wd)])

        data = request.get_json(silent=True) or {}
        parsed, seen = [], set()
        for s in data.get('slots') or []:
            try:
                wd = int(s['weekday'])
                t = datetime.strptime(str(s['start']), '%H:%M').time()
                dur = int(s.get('duration_min', 60))
            except (KeyError, TypeError, ValueError):
                return jsonify(success=False, error='Each slot needs weekday (0-6), start (HH:MM) and duration_min.'), 400
            if not 0 <= wd <= 6 or not 15 <= dur <= 24 * 60 - 1:
                return jsonify(success=False, error='Weekday must be 0-6 and the open time must be at least 15 minutes.'), 400
            if (wd, t) not in seen:
                seen.add((wd, t))
                parsed.append((wd, t, dur))
        # Replace the schedule. Existing bookings are untouched (they keep their own times).
        CoachAvailability.query.filter_by(coach_id=coach.id).delete()
        for wd, t, dur in parsed:
            db.session.add(CoachAvailability(coach_id=coach.id, weekday=wd, start_time=t,
                                             duration_min=dur, is_active=True))
        # Keep the Coach tab's "Available Days" in step with the saved schedule, so the
        # coach card, the member booking page and this editor always agree.
        _names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        coach.available_days = ','.join(_names[w] for w in sorted({wd for wd, _t, _d in parsed}))
        # Upcoming pending/confirmed bookings that no longer sit on an offered slot.
        # They are NOT cancelled — staff decide — but we tell the UI so it can warn.
        # (Members choose their own times, so a booking is "outside" only if it isn't fully
        # inside that weekday's new working hours.)
        hours = {}
        for wd, t, dur in parsed:
            lo = t.hour * 60 + t.minute
            a_, b_ = hours.get(wd, (lo, lo + dur))
            hours[wd] = (min(a_, lo), max(b_, lo + dur))

        def _inside(b):
            w = hours.get(b.slot_start.weekday())
            if w is None:
                return False
            s_ = b.slot_start.hour * 60 + b.slot_start.minute
            e_ = b.slot_end.hour * 60 + b.slot_end.minute if b.slot_end.date() == b.slot_start.date() else 24 * 60
            return w[0] <= s_ and e_ <= w[1]

        affected = sum(1 for b in CoachBooking.query
                       .filter(CoachBooking.coach_id == coach.id, CoachBooking.status.in_(ACTIVE),
                               CoachBooking.slot_start > _now()).all()
                       if not _inside(b))
        db.session.commit()
        msg = f'Saved {len(parsed)} slot(s) for {coach.name}.'
        if affected:
            msg += f' {affected} upcoming booking(s) are outside the new schedule — review them in All Schedules.'
        return jsonify(success=True, message=msg, affected_bookings=affected)

    # ── staff / admin: coach availability by day ───────────────────────
    # After a coach finishes a session the coach is held back for the rest of that day.
    # The coach tells staff they are free, and staff press "Mark available" — per coach,
    # per day — which re-opens the coach's remaining slots on the members' dashboards.
    @app.route('/staff/coach-day-holds', methods=['GET'])
    def cs_staff_day_holds():
        err = _staff_or_error()
        if err:
            return err
        now = _now()
        today = now.date()
        out = []
        for c in Coach.query.filter_by(is_active=True).order_by(Coach.name).all():
            held, last_end = _day_hold(c.id, today, now)
            if not held:
                continue
            out.append({
                'coach_id': c.id, 'coach_name': c.name, 'photo': _coach_photo(c),
                'date': today.strftime('%Y-%m-%d'),
                'finished_label': _fmt_time(last_end),
            })
        return jsonify(success=True, holds=out)

    @app.route('/staff/coach-day-holds/release', methods=['POST'])
    def cs_staff_day_release():
        err = _staff_only_or_error()
        if err:
            return err
        data = request.get_json(silent=True) or {}
        try:
            coach_id = int(data.get('coach_id'))
        except (TypeError, ValueError):
            coach_id = None
        day = _parse_date(data.get('date'))
        coach = Coach.query.get(coach_id) if coach_id else None
        if coach is None:
            return jsonify(success=False, error='Coach not found.'), 404
        now = _now()
        if day != now.date():
            return jsonify(success=False, error='A coach can only be re-opened for today.'), 400
        held, _ = _day_hold(coach.id, day, now)
        if not held:
            return jsonify(success=False, error=f'{coach.name} is already available today.'), 409
        rel = CoachDayRelease.query.filter_by(coach_id=coach.id, day=day).first()
        if rel is None:
            rel = CoachDayRelease(coach_id=coach.id, day=day, released_at=now, released_by=session.get('user_id'))
            db.session.add(rel)
        else:
            rel.released_at, rel.released_by = now, session.get('user_id')
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            rel = CoachDayRelease.query.filter_by(coach_id=coach.id, day=day).first()
            if rel is not None:
                rel.released_at, rel.released_by = now, session.get('user_id')
                db.session.commit()
        return jsonify(success=True, message=f'{coach.name} is available again for today.')