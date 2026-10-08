"""Coach Scheduling — member booking of coach sessions.

Registered from app.py with register(app, db, ...). All routes live here so the
existing app.py stays almost untouched; authentication is the app's own session
(`session['user_id']`, `session['role']`) exactly like every other route.

Business rules (all enforced SERVER-SIDE, the UI only mirrors them):
  * Slots come only from the CoachAvailability table (set by staff). Past slots,
    slots a coach doesn't offer, and slots already taken can't be booked.
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
MAX_ADVANCE_DAYS = 30          # how far ahead a member may book
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


def register(app, db, *, User, Membership, Coach, CoachAvailability, CoachBooking,
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

    def _slot_error(coach_id, start, ignore_booking_id=None, member_id=None):
        """Validate that `start` is a real, future, free slot of this coach.
        Returns (coach, availability, end, error_message)."""
        # Lock the coach's row: concurrent requests for the same coach queue up here, so the
        # overlap check below can't be passed by two members/clicks at once (the unique keys
        # only catch identical start times, not partly-overlapping slots).
        coach = Coach.query.filter_by(id=coach_id).with_for_update().first() if coach_id else None
        if coach is None or not coach.is_active:
            return None, None, None, 'That coach is not available.'
        if start is None:
            return coach, None, None, 'Invalid time slot.'
        if start <= _now():
            return coach, None, None, 'That time has already passed.'
        if start.date() > today_manila() + timedelta(days=MAX_ADVANCE_DAYS):
            return coach, None, None, f'You can only book up to {MAX_ADVANCE_DAYS} days ahead.'
        dur = next((d for t, d in _coach_slot_defs(coach, start.weekday()) if t == start.time()), None)
        av = dur
        if dur is None:
            return coach, None, None, 'That time slot is not offered by this coach.'
        end = start + timedelta(minutes=dur)

        def _overlap(q):
            q = q.filter(CoachBooking.status.in_(ACTIVE),
                         CoachBooking.slot_start < end, CoachBooking.slot_end > start)
            if ignore_booking_id:
                q = q.filter(CoachBooking.id != ignore_booking_id)
            return q.first() is not None

        # 1) The member can't hold two sessions at the same time — same coach or another.
        if member_id:
            q = CoachBooking.query.filter(CoachBooking.member_id == member_id,
                                          CoachBooking.status.in_(ACTIVE),
                                          CoachBooking.slot_start < end, CoachBooking.slot_end > start)
            if ignore_booking_id:
                q = q.filter(CoachBooking.id != ignore_booking_id)
            mine = q.first()
            if mine is not None:
                if mine.coach_id == coach.id:
                    return coach, av, end, f'You already booked {coach.name} at this time.'
                other = mine.coach.name if mine.coach else (mine.coach_name or 'another coach')
                return coach, av, end, f'You already have a coach session at this time (with {other}).'
        # 2) The coach can't be booked twice at the same time (by anyone).
        if _overlap(CoachBooking.query.filter(CoachBooking.coach_id == coach.id)):
            return coach, av, end, 'That slot has just been booked. Please pick another time.'
        return coach, av, end, None

    # ── member: read endpoints ─────────────────────────────────────────
    @app.route('/member/coach-scheduling/slots', methods=['GET'])
    def cs_slots():
        user, err = _member_or_error()
        if err:
            return err
        today = today_manila()
        day = _parse_date(request.args.get('date')) or today
        last_day = today + timedelta(days=MAX_ADVANCE_DAYS)
        if day < today or day > last_day:
            return jsonify(success=False, error='Please choose a date within the booking window.'), 400

        day_start = datetime.combine(day, time.min)
        day_end = day_start + timedelta(days=1)
        now = _now()

        taken = {}      # (coach_id, start) -> True for any active booking that day
        mine = []       # this member's active bookings that day (for conflict marking)
        for b in (CoachBooking.query
                  .filter(CoachBooking.status.in_(ACTIVE),
                          CoachBooking.slot_start >= day_start, CoachBooking.slot_start < day_end)):
            taken[(b.coach_id, b.slot_start)] = b
            if b.member_id == user.id:
                mine.append(b)

        coaches_out = []
        # Members only see the coach they chose when availing their promo.
        mine_coach = _assigned_coach(user.id)
        for c in ([mine_coach] if mine_coach else []):
            slots = []
            for st, dur in _coach_slot_defs(c, day.weekday()):
                start = datetime.combine(day, st)
                end = start + timedelta(minutes=dur)
                if start <= now:
                    state = 'past'
                elif any(b.coach_id == c.id and b.slot_start < end and b.slot_end > start for b in mine):
                    state = 'mine'          # the member already booked THIS coach at this time
                elif (c.id, start) in taken or any(
                        b.coach_id == c.id and b.slot_start < end and b.slot_end > start
                        for b in taken.values()):
                    state = 'booked'
                elif any(b.slot_start < end and b.slot_end > start for b in mine):
                    state = 'conflict'      # the member has a session with another coach then
                else:
                    state = 'available'
                slots.append({'start': start.strftime('%Y-%m-%dT%H:%M'),
                              'label': _fmt_time(start), 'state': state})
            coaches_out.append({
                'id': c.id, 'name': c.name, 'photo': _coach_photo(c),
                'specialization': c.specialization or '', 'bio': c.bio or '',
                'has_available': any(s['state'] == 'available' for s in slots),
                'slots': slots,
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
                       upcoming=upcoming, history=history,
                       today=today.strftime('%Y-%m-%d'),
                       last_date=(today + timedelta(days=MAX_ADVANCE_DAYS)).strftime('%Y-%m-%d'))

    # ── member: write endpoints ────────────────────────────────────────
    @app.route('/member/coach-scheduling/book', methods=['POST'])
    def cs_book():
        user, err = _member_or_error()
        if err:
            return err
        data = request.get_json(silent=True) or {}
        start = _parse_slot(data.get('slot_start'))
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

            coach, _av, end, problem = _slot_error(coach_id, start, member_id=user.id)
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

        return jsonify(success=True, message=f'Session requested with {coach.name} — waiting for confirmation.',
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
        start = _parse_slot(data.get('slot_start'))
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
            coach, _av, end, problem = _slot_error(coach_id, start, ignore_booking_id=b.id, member_id=user.id)
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
        return jsonify(success=True, message=f'Session moved to {_fmt_time(start)} — waiting for confirmation.',
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
            if not 0 <= wd <= 6 or not 15 <= dur <= 240:
                return jsonify(success=False, error='Weekday must be 0-6 and duration 15-240 minutes.'), 400
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
        offered = {(wd, t) for wd, t, _dur in parsed}
        affected = sum(1 for b in CoachBooking.query
                       .filter(CoachBooking.coach_id == coach.id, CoachBooking.status.in_(ACTIVE),
                               CoachBooking.slot_start > _now()).all()
                       if (b.slot_start.weekday(), b.slot_start.time()) not in offered)
        db.session.commit()
        msg = f'Saved {len(parsed)} slot(s) for {coach.name}.'
        if affected:
            msg += f' {affected} upcoming booking(s) are outside the new schedule — review them in All Schedules.'
        return jsonify(success=True, message=msg, affected_bookings=affected)