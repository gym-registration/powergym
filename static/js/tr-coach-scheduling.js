/* ═══════════════════════════════════════════════════════════════
   Coach Scheduling — member dashboard
   Everything shown comes from the server (/member/coach-scheduling/*), which
   also enforces every rule (past / booked / unavailable slots, double-booking,
   0 credits). The UI only mirrors those rules so nobody clicks into an error.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const root = document.getElementById('cs-root');
  if (!root) return;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const state = {
    tab: 'book',
    pastFilter: 'upcoming',        // My Bookings segment: upcoming | past | all
    today: null, lastDate: null,   // today 'YYYY-MM-DD' from the server (gym-local time); lastDate null = no booking limit
    date: null,                    // selected booking date
    stripStart: null,              // first day shown in the day strip
    overview: null,                // credits, bookings, upcoming, history
    slots: null,                   // coaches + slot states for state.date
    pick: { from: '', to: '' },    // the member's own start/end ('HH:MM') for the chosen day
    rescheduling: null,            // booking object being moved, if any
    cal: null,                     // { y, m } month shown in Schedule
    calSel: null,                  // selected 'YYYY-MM-DD' in Schedule
    loading: false,
    error: '',
  };

  /* ── tiny helpers ─────────────────────────────────────── */
  const $ = (sel) => root.querySelector(sel);
  const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const fmtLong = (s) => { const d = parseYmd(s); return MONTHS_LONG[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); };
  const fmtShort = (s) => { const d = parseYmd(s); return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); };
  const initials = (name) => (String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();

  function toast(msg, type) {
    // showToast() writes HTML, but long errors open showErrorModal(), which writes plain text:
    // pre-escaping there would print "&#39;" instead of an apostrophe. Send raw text to the modal.
    const t = type || 'success', safe = esc(msg);
    if (t === 'error' && safe.length > 70 && typeof window.showErrorModal === 'function') window.showErrorModal(String(msg));
    else if (typeof window.showToast === 'function') window.showToast(safe, t);
    else window.alert(msg);
  }

  async function api(url, body) {
    try {
      const opts = { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
      const res = await fetch(url, opts);
      let data;
      try { data = await res.json(); } catch (e) { data = { success: false, error: 'Unexpected response from the server.' }; }
      if (res.status === 401) data.error = 'Your session has expired — please sign in again.';
      return data;
    } catch (e) {
      return { success: false, error: 'Could not reach the server. Please try again.' };
    }
  }

  /* ── credits / booking rules mirrored from the server ─── */
  function credits() { return (state.overview && state.overview.credits) || { enabled: false, total: 0, used: 0, left: 0, reserved: 0 }; }
  function creditBlock() {
    if (state.rescheduling) return '';   // moving a booking keeps the credit it already reserves
    const c = credits();
    if (!c.enabled) return 'none_plan';
    if (c.left <= 0) return 'zero';
    if (c.reserved >= c.left) return 'reserved';
    return '';
  }

  /* ── icons ────────────────────────────────────────────── */
  const ICON_CAL = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
  const ICON_USER = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7z"/></svg>';
  const ICON_DUMBBELL = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9v6M6.5 6.5v11M17.5 6.5v11M21 9v6M6.5 12h11"/></svg>';

  /* ── data loading ─────────────────────────────────────── */
  async function loadOverview() {
    const data = await api('/member/coach-scheduling/overview');
    if (!data.success) { state.error = data.error || 'Could not load your coach sessions.'; return false; }
    state.overview = data;
    state.today = data.today;
    state.lastDate = data.last_date;
    if (!state.date) { state.date = data.today; state.stripStart = data.today; }
    if (!state.cal) { const t = parseYmd(data.today); state.cal = { y: t.getFullYear(), m: t.getMonth() }; }
    state.error = '';
    return true;
  }

  async function loadSlots() {
    if (!state.date) return;
    const data = await api('/member/coach-scheduling/slots?date=' + encodeURIComponent(state.date) +
      (state.rescheduling ? '&ignore_booking=' + encodeURIComponent(state.rescheduling.id) : ''));
    if (!data.success) {
      state.slots = null;
      state.error = data.error || 'Could not load coach availability.';
      return;
    }
    state.slots = data;
    state.error = '';
    if (state.overview) state.overview.credits = data.credits;
  }

  async function refresh() {
    state.loading = true;
    render();
    const ok = await loadOverview();
    if (ok) await loadSlots();
    state.loading = false;
    render();
  }

  async function refreshAfterChange() {
    await loadOverview();
    await loadSlots();
    render();
  }

  /* ── confirm dialog (promise) ─────────────────────────── */
  function confirmDialog({ title, rows, note, confirmText, danger }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'cs-modal-overlay';
      wrap.innerHTML =
        '<div class="cs-modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
        '<h3>' + esc(title) + '</h3>' +
        '<dl>' + rows.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '</dl>' +
        (note ? '<p>' + esc(note) + '</p>' : '') +
        '<div class="cs-modal-actions">' +
        '<button type="button" class="cs-btn" data-x="no">Go Back</button>' +
        '<button type="button" class="cs-btn ' + (danger ? 'danger' : 'red') + '" data-x="yes">' + esc(confirmText || 'Confirm') + '</button>' +
        '</div></div>';
      const done = (v) => { document.removeEventListener('keydown', onKey); wrap.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) return done(false);
        const b = e.target.closest('[data-x]');
        if (b) done(b.dataset.x === 'yes');
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(wrap);
      const yes = wrap.querySelector('[data-x="yes"]');
      if (yes) yes.focus();
    });
  }

  /* ── renderers ────────────────────────────────────────── */
  function pill(b) { return '<span class="cs-pill ' + esc(b.status) + '">' + esc(b.status_label) + '</span>'; }

  function dateChip(dateStr) {
    const d = parseYmd(dateStr);
    return '<div class="cs-datechip"><small>' + MONTHS[d.getMonth()] + '</small><b>' + pad(d.getDate()) + '</b></div>';
  }

  function renderCredits() {
    const c = credits();
    const pct = c.total > 0 ? Math.max(0, Math.min(100, Math.round((c.left / c.total) * 100))) : 0;
    let note = '';
    if (!c.enabled) note = 'Coach sessions come with a session-based plan. See My Membership to get one.';
    else if (c.reserved > 0) note = c.reserved + ' reserved for upcoming bookings (deducted only when completed).';
    $('#cs-credits').innerHTML =
      ICON_DUMBBELL +
      '<div class="cs-credits-body">' +
      '<div class="cs-credits-title">Coach Sessions</div>' +
      '<div class="cs-credits-count"><strong>' + c.left + ' / ' + c.total + '</strong> Remaining</div>' +
      '<div class="cs-bar" role="progressbar" aria-valuemin="0" aria-valuemax="' + c.total + '" aria-valuenow="' + c.left + '"><span style="width:' + pct + '%"></span></div>' +
      (note ? '<div class="cs-credits-note">' + esc(note) + '</div>' : '') +
      '</div>';
  }

  function renderUpcoming() {
    const list = (state.overview && state.overview.upcoming) || [];
    $('#cs-upcoming').innerHTML = list.length
      ? list.slice(0, 3).map((b) =>
        '<div class="cs-item">' + dateChip(b.date) +
        '<div class="cs-item-main"><div class="cs-item-title">' + esc(b.coach_name) + '</div>' +
        '<div class="cs-item-sub">' + esc(b.start_label) + ' – ' + esc(b.end_label) + '</div></div>' +
        pill(b) + '<button type="button" class="cs-link cs-chev" data-cs-goto="bookings" aria-label="View booking">›</button></div>').join('')
      : '<div class="cs-empty">No upcoming sessions.</div>';
  }

  function renderHistory() {
    const list = (state.overview && state.overview.history) || [];
    $('#cs-history').innerHTML = list.length
      ? list.slice(0, 3).map((b) =>
        '<div class="cs-item"><div class="cs-item-main">' +
        '<div class="cs-hist-date">' + esc(fmtShort(b.date)) + '</div>' +
        '<div class="cs-hist-sub">' + (b.status === 'completed' ? '-1 session' : 'No charge') + '</div></div>' +
        '<div class="cs-item-main"><div class="cs-item-title">' + esc(b.coach_name) + '</div></div>' +
        pill(b) + '<button type="button" class="cs-link cs-chev" data-cs-goto="bookings-past" aria-label="View booking">›</button></div>').join('')
      : '<div class="cs-empty">No session history yet.</div>';
  }

  function avatar(photo, name) {
    return '<div class="cs-avatar">' + esc(initials(name)) +
      (photo ? '<img src="' + esc(photo) + '" alt="" onerror="this.remove()">' : '') + '</div>';
  }

  /* Book a Coach ------------------------------------------------ */
  function stripHtml() {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const s = addDays(state.stripStart, i);
      const d = parseYmd(s);
      const out = !!state.lastDate && s > state.lastDate;
      days.push(
        '<button type="button" class="cs-daybtn' + (s === state.date ? ' active' : '') + '" data-day="' + s + '"' + (out ? ' disabled' : '') + ' aria-pressed="' + (s === state.date) + '">' +
        '<span>' + DOW[d.getDay()] + '</span><span>' + MONTHS[d.getMonth()] + ' ' + d.getDate() + '</span></button>');
    }
    const prevOff = state.stripStart <= state.today;
    const nextOff = !!state.lastDate && addDays(state.stripStart, 7) > state.lastDate;
    return '<div class="cs-strip">' +
      '<button type="button" class="cs-strip-arrow" data-strip="-1"' + (prevOff ? ' disabled' : '') + ' aria-label="Previous days">‹</button>' +
      '<div class="cs-days">' + days.join('') + '</div>' +
      '<button type="button" class="cs-strip-arrow" data-strip="1"' + (nextOff ? ' disabled' : '') + ' aria-label="Next days">›</button></div>';
  }

  /* The MEMBER decides when the session starts and how long it lasts (no fixed slot lengths). */
  const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const toHHMM = (min) => pad(Math.floor(min / 60)) + ':' + pad(min % 60);
  const label12 = (hhmm) => { const m = toMin(hhmm); if (m == null) return ''; const h = Math.floor(m / 60); return ((h % 12) || 12) + ':' + pad(m % 60) + ' ' + (h < 12 ? 'AM' : 'PM'); };
  const lenText = (min) => { const h = Math.floor(min / 60), m = min % 60; return (h ? h + ' hr' + (h > 1 ? 's' : '') : '') + (h && m ? ' ' : '') + (m ? m + ' min' : ''); };
  const QUICK = [30, 60, 90, 120];

  /** '' when the chosen times are fine, otherwise the reason (mirrors the server's checks).
   *  Order matters: the coach's WORKING HOURS are checked first, so a time outside them says so
   *  instead of a confusing "end must be after start" / "at least 15 minutes" (e.g. 11 PM → 12 AM). */
  function pickProblem(c) {
    const a = toMin(state.pick.from), b = toMin(state.pick.to);
    if (a == null || b == null) return 'Choose a start time and an end time.';
    const w = c.window;
    if (w) {
      const lo = toMin(w.start), hi = toMin(w.end);
      // An end of 12:00 AM is midnight (00:00), which is before any same-day working hours.
      if (a < lo || a >= hi || b <= lo || b > hi) {
        return 'Your coach isn’t available then. Working hours: ' + w.start_label + ' – ' + w.end_label + '.';
      }
    }
    if (b <= a) return 'The end time must be after the start time.';
    if (b - a < (c.min_minutes || 15)) return 'A session must be at least ' + (c.min_minutes || 15) + ' minutes long.';
    const fits = (c.free || []).some((f) => a >= toMin(f.start) && b <= toMin(f.end));
    if (!fits) return 'That time isn’t free. Pick a time inside one of the open stretches above.';
    return '';
  }

  function pickSummaryHtml(c) {
    const a = toMin(state.pick.from), b = toMin(state.pick.to);
    if (a == null || b == null) return 'Choose when you want to start and how long you want to train.';
    const bad = pickProblem(c);
    const range = b > a ? '<b>' + esc(label12(state.pick.from)) + ' – ' + esc(label12(state.pick.to)) + '</b> · ' + esc(lenText(b - a)) : '';
    return bad ? '⚠ ' + esc(bad) + (range ? ' ' + range : '') : '✓ ' + range;
  }

  function coachCardHtml(c, blocked) {
    const free = c.free || [];
    const busy = (c.busy || []).map((x) => esc(x.start_label) + ' – ' + esc(x.end_label) + (x.mine ? ' (you)' : '')).join(', ');
    let body;
    if (!c.window) {
      body = '<div class="cs-noslots">Your coach doesn’t work on this day. Please pick another date.</div>';
    } else if (c.member_has_day_booking && !state.rescheduling) {
      body = '<div class="cs-alert info" style="margin:0;">You already have a session with your coach on this day. Only one session per day is allowed — pick another date.</div>';
    } else if (c.day_held) {
      body = '<div class="cs-alert info" style="margin:0;">Your coach just finished a session. The rest of today opens up again once the gym staff confirm your coach is free.</div>';
    } else if (!free.length) {
      body = '<div class="cs-noslots">Your coach is fully booked for the rest of this day.</div>';
    } else {
      const chips = free.map((f) => '<button type="button" class="cs-chip" data-fillrange="' + esc(f.start) + '|' + esc(f.end) + '"' + (blocked ? ' disabled' : '') + '>' + esc(f.start_label) + ' – ' + esc(f.end_label) + '</button>').join('');
      const quick = QUICK.map((m) => '<button type="button" class="cs-chip" data-dur="' + m + '"' + (blocked ? ' disabled' : '') + '>' + esc(lenText(m)) + '</button>').join('');
      body = '<div class="cs-pick-label">Open times (tap one to use all of it, or set your own below)</div>' +
        '<div class="cs-chips">' + chips + '</div>' +
        '<div class="cs-time-row">' +
        '<label>Start<input type="time" step="900" data-pick="from" value="' + esc(state.pick.from) + '"' + (blocked ? ' disabled' : '') + '></label>' +
        '<label>End<input type="time" step="900" data-pick="to" value="' + esc(state.pick.to) + '"' + (blocked ? ' disabled' : '') + '></label></div>' +
        '<div class="cs-pick-label">Quick length</div><div class="cs-chips">' + quick + '</div>' +
        '<div class="cs-pick-summary" data-pick-summary="' + c.id + '">' + pickSummaryHtml(c) + '</div>';
    }
    const canBook = !blocked && free.length > 0 && !(c.member_has_day_booking && !state.rescheduling) && !c.day_held;
    return '<div class="cs-coach" data-coach-card="' + c.id + '">' +
      '<div class="cs-coach-info">' + avatar(c.photo, c.name) +
      '<div class="cs-coach-text"><div class="cs-coach-name">' + esc(c.name) + '</div>' +
      '<div class="cs-avail' + (c.has_available ? '' : ' none') + '">' + (c.has_available ? 'Available' : (c.window ? 'Not available' : 'Day off')) + '</div>' +
      (c.window ? '<div class="cs-spec">Working hours: ' + esc(c.window.start_label) + ' – ' + esc(c.window.end_label) + '</div>' : '') +
      (c.specialization ? '<div class="cs-spec">' + esc(c.specialization) + '</div>' : '') +
      (c.bio ? '<div class="cs-bio">' + esc(c.bio) + '</div>' : '') + '</div></div>' +
      body +
      (busy ? '<div class="cs-busy">Already booked: ' + busy + '</div>' : '') +
      '<button type="button" class="cs-btn cs-book-btn red" data-book="' + c.id + '"' + (canBook ? '' : ' disabled') + '>' +
      (state.rescheduling ? 'Move Session' : 'Book Session') + '</button></div>';
  }

  function renderBook() {
    const view = $('#cs-view-book');
    if (!state.overview) {
      view.innerHTML = state.error
        ? '<div class="cs-alert warn">' + esc(state.error) + ' <button type="button" class="cs-btn sm" data-cs-retry>Retry</button></div>'
        : '<div class="cs-loading">Loading…</div>';
      return;
    }
    const block = creditBlock();
    if (block === 'none_plan') {
      // Regular (non-session) membership: coach scheduling doesn't apply, so show only this notice.
      view.innerHTML = '<div class="cs-panel"><div class="cs-empty">' +
        '<b>Coach Scheduling is not applicable to your current membership.</b><br>' +
        'It is only available with a coach promo (e.g. 16 Sessions). Avail one from My Membership to start booking coach sessions.' +
        '</div></div>';
      return;
    }
    const blockMsg = {
      none_plan: 'Coach sessions are included with a session-based plan, and you don’t have one active right now. Check My Membership to get one.',
      zero: 'You have no coach sessions left, so booking is turned off. Renew from My Membership to book again.',
      reserved: 'All of your remaining sessions are already reserved by upcoming bookings. Cancel one to book a different time.',
    }[block] || '';
    let html = '';
    const rem = state.overview.reminder;
    if (rem) html += '<div class="cs-alert info"><span>⏰ <b>' + esc(rem.message) + '</b>' + (rem.status === 'pending' ? ' It is still waiting for staff confirmation.' : '') + '</span></div>';
    if (state.rescheduling) {
      const r = state.rescheduling;
      html += '<div class="cs-alert info"><span>Moving your session with <b>' + esc(r.coach_name) + '</b> on ' + esc(fmtShort(r.date)) + ' at ' + esc(r.start_label) +
        '. Pick a new time below.</span><button type="button" class="cs-btn sm" data-resched-cancel>Keep Original</button></div>';
    }
    if (blockMsg) html += '<div class="cs-alert warn">' + esc(blockMsg) + '</div>';

    const min = state.today, max = state.lastDate;
    html += '<div class="cs-panel" style="margin-bottom:20px;">' +
      '<div class="cs-step">' + ICON_CAL + '<span>1. Select Date</span></div>' +
      '<div class="cs-date-row"><label class="cs-date-input"><input type="date" id="cs-date" value="' + esc(state.date) + '" min="' + esc(min) + '"' + (max ? ' max="' + esc(max) + '"' : '') + ' aria-label="Select date"></label>' + stripHtml() + '</div>' +
      '<div class="cs-step">' + ICON_USER + '<span>2. Your Coach</span></div>';

    if (state.error && !state.slots) {
      html += '<div class="cs-alert warn">' + esc(state.error) + '</div>';
    } else if (!state.slots) {
      html += '<div class="cs-loading">Loading coaches…</div>';
    } else if (state.slots.no_coach) {
      html += '<div class="cs-empty">You don’t have a coach yet. Please avail a coach from the promo first (see My Membership) to book coach sessions.</div>';
    } else if (!state.slots.coaches.length) {
      html += '<div class="cs-empty">Your coach is not available right now. Please check back soon.</div>';
    } else {
      html += '<div class="cs-coaches">' + state.slots.coaches.map((c) => coachCardHtml(c, !!block)).join('') + '</div>';
    }
    html += '</div>';
    view.innerHTML = html;
  }

  /* My Bookings ------------------------------------------------- */
  function bookingRow(b) {
    const actions = (b.can_reschedule ? '<button type="button" class="cs-btn sm" data-resched="' + b.id + '">Reschedule</button>' : '') +
      (b.can_cancel ? '<button type="button" class="cs-btn sm danger" data-cancel="' + b.id + '">Cancel</button>' : '');
    return '<div class="cs-row">' + dateChip(b.date) +
      '<div class="cs-item-main"><div class="cs-item-title">' + esc(b.coach_name) + '</div>' +
      '<div class="cs-item-sub">' + esc(fmtLong(b.date)) + ' · ' + esc(b.start_label) + ' – ' + esc(b.end_label) +
      (b.credit_deducted ? ' · 1 session used' : '') + '</div></div>' +
      '<div class="cs-row-actions">' + pill(b) + actions + '</div></div>';
  }

  function renderBookings() {
    const view = $('#cs-view-bookings');
    if (!state.overview) { view.innerHTML = '<div class="cs-loading">Loading…</div>'; return; }
    const all = state.overview.bookings;
    const up = all.filter((b) => b.can_cancel).sort((a, b) => (a.start < b.start ? -1 : 1));
    const past = all.filter((b) => !b.can_cancel);
    const f = state.pastFilter;
    const list = f === 'upcoming' ? up : f === 'past' ? past : up.concat(past);
    const seg = [['upcoming', 'Upcoming'], ['past', 'Past'], ['all', 'All']]
      .map((s) => '<button type="button" data-seg="' + s[0] + '" class="' + (f === s[0] ? 'active' : '') + '">' + s[1] + '</button>').join('');
    view.innerHTML = '<div class="cs-panel"><div class="cs-seg" role="group" aria-label="Filter bookings">' + seg + '</div>' +
      (list.length ? list.map(bookingRow).join('')
        : '<div class="cs-empty">' + (f === 'upcoming' ? 'No upcoming bookings yet. Head to Book a Coach to reserve a session.' : 'Nothing here yet.') + '</div>') +
      '</div>';
  }

  /* Schedule (month view) --------------------------------------- */
  function renderSchedule() {
    const view = $('#cs-view-schedule');
    if (!state.overview) { view.innerHTML = '<div class="cs-loading">Loading…</div>'; return; }
    const { y, m } = state.cal;
    const byDate = {};
    state.overview.bookings.forEach((b) => { if (b.status !== 'cancelled') (byDate[b.date] = byDate[b.date] || []).push(b); });
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    let cells = DOW.map((d) => '<div class="cs-cal-dow">' + d + '</div>').join('');
    for (let i = 0; i < first; i++) cells += '<div class="cs-cal-day empty"></div>';
    for (let d = 1; d <= days; d++) {
      const s = y + '-' + pad(m + 1) + '-' + pad(d);
      const items = byDate[s] || [];
      const dots = items.slice(0, 3).map((b) => '<span class="dot ' + (b.status === 'pending' ? 'pending' : b.status === 'confirmed' ? '' : 'done') + '"></span>').join('');
      cells += '<button type="button" class="cs-cal-day' + (s === state.today ? ' today' : '') + (s === state.calSel ? ' sel' : '') + '" data-cal-day="' + s + '" aria-label="' + esc(fmtLong(s)) + (items.length ? ', ' + items.length + ' session(s)' : '') + '">' + d + '<div class="dots">' + dots + '</div></button>';
    }
    const sel = state.calSel ? (byDate[state.calSel] || []).sort((a, b) => (a.start < b.start ? -1 : 1)) : null;
    let detail = '';
    if (state.calSel) {
      detail = '<div style="margin-top:20px;"><div class="cs-step" style="font-size:17px;margin-bottom:6px;">' + esc(fmtLong(state.calSel)) + '</div>' +
        (sel.length ? sel.map(bookingRow).join('') : '<div class="cs-empty" style="padding:14px;">No sessions on this day.</div>') + '</div>';
    }
    view.innerHTML = '<div class="cs-panel">' +
      '<div class="cs-cal-head"><button type="button" class="cs-btn sm" data-cal-nav="-1" aria-label="Previous month">‹ Prev</button>' +
      '<div class="cs-cal-title">' + MONTHS_LONG[m].toUpperCase() + ' ' + y + '</div>' +
      '<button type="button" class="cs-btn sm" data-cal-nav="1" aria-label="Next month">Next ›</button></div>' +
      '<div class="cs-cal">' + cells + '</div>' +
      '<div class="cs-legend"><span><i></i>Confirmed</span><span><i class="pending"></i>Pending</span><span><i class="done"></i>Completed / No-show</span></div>' +
      detail + '</div>';
  }

  function render() {
    renderCredits();
    renderUpcoming();
    renderHistory();
    ['book', 'bookings', 'schedule'].forEach((t) => {
      const v = $('#cs-view-' + t);
      v.hidden = state.tab !== t;
    });
    root.querySelectorAll('[data-cs-tab]').forEach((b) => {
      const on = b.dataset.csTab === state.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (state.tab === 'book') renderBook();
    else if (state.tab === 'bookings') renderBookings();
    else renderSchedule();
  }

  /* ── actions ──────────────────────────────────────────── */
  function setTab(t) { state.tab = t; render(); }

  async function selectDate(s) {
    if (!s || s < state.today || (state.lastDate && s > state.lastDate)) { toast('Please choose today or a later date.', 'error'); render(); return; }
    state.date = s;
    state.pick = { from: '', to: '' };
    if (s < state.stripStart || s > addDays(state.stripStart, 6)) state.stripStart = s;
    state.slots = null;
    render();
    await loadSlots();
    render();
  }

  async function doBook(coachId) {
    const coach = state.slots && state.slots.coaches.find((c) => c.id === coachId);
    if (!coach) return;
    const problem = pickProblem(coach);
    if (problem) { toast(problem, 'error'); return; }
    const p = state.pick, mins = toMin(p.to) - toMin(p.from);
    const resched = state.rescheduling;
    const ok = await confirmDialog({
      title: resched ? 'Move Session' : 'Confirm Booking',
      rows: [['Coach', coach.name], ['Date', fmtLong(state.date)], ['Time', label12(p.from) + ' – ' + label12(p.to)], ['Length', lenText(mins)]],
      note: resched
        ? 'Your session will be moved to this time and will need to be confirmed again. No session is used until it is completed.'
        : 'Your request will be sent to the gym staff for confirmation, and this time is held for you. 1 session is deducted only after the session is completed.',
      confirmText: resched ? 'Move Session' : 'Book Session',
    });
    if (!ok) return;
    const body = { coach_id: coachId, slot_start: state.date + 'T' + p.from, slot_end: state.date + 'T' + p.to };
    const res = resched
      ? await api('/member/coach-scheduling/reschedule', Object.assign({ booking_id: resched.id }, body))
      : await api('/member/coach-scheduling/book', body);
    if (res.success) {
      toast(res.message || 'Done.', 'success');
      state.pick = { from: '', to: '' };
      state.rescheduling = null;
      await refreshAfterChange();
      setTab('bookings');
    } else {
      toast(res.error || 'Could not complete that.', 'error');
      await refreshAfterChange();      // the open times may have changed under us
    }
  }

  async function doCancel(id) {
    const b = state.overview.bookings.find((x) => x.id === id);
    if (!b) return;
    const ok = await confirmDialog({
      title: 'Cancel Session',
      rows: [['Coach', b.coach_name], ['Date', fmtLong(b.date)], ['Time', b.start_label]],
      note: 'No session will be deducted. The time slot becomes available to others.',
      confirmText: 'Cancel Session', danger: true,
    });
    if (!ok) return;
    const res = await api('/member/coach-scheduling/cancel', { booking_id: id });
    toast(res.success ? (res.message || 'Session cancelled.') : (res.error || 'Could not cancel.'), res.success ? 'success' : 'error');
    await refreshAfterChange();
  }

  function startReschedule(id) {
    const b = state.overview.bookings.find((x) => x.id === id);
    if (!b) return;
    state.rescheduling = b;
    state.pick = { from: '', to: '' };
    state.tab = 'book';
    selectDate(b.date >= state.today ? b.date : state.today);
  }

  /* ── events (delegated) ───────────────────────────────── */
  root.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.csTab) return setTab(d.csTab);
    if (d.csGoto) {
      if (d.csGoto === 'bookings-past') state.pastFilter = 'past'; else state.pastFilter = 'upcoming';
      return setTab('bookings');
    }
    if (d.csRetry !== undefined) return refresh();
    if (d.day) return selectDate(d.day);
    if (d.strip) {
      let s = addDays(state.stripStart, 7 * Number(d.strip));
      if (s < state.today) s = state.today;
      state.stripStart = s;
      return render();
    }
    if (d.fillrange) {
      const [f, t2] = d.fillrange.split('|');
      state.pick = { from: f, to: t2 };
      return render();
    }
    if (d.dur) {
      const coach = state.slots && state.slots.coaches[0];
      let from = toMin(state.pick.from);
      if (from == null && coach && coach.free && coach.free.length) from = toMin(coach.free[0].start);
      if (from == null) return;
      state.pick = { from: toHHMM(from), to: toHHMM(Math.min(from + Number(d.dur), 24 * 60 - 1)) };
      return render();
    }
    if (d.book) return doBook(Number(d.book));
    if (d.reschedCancel !== undefined) { state.rescheduling = null; state.pick = { from: '', to: '' }; return refreshAfterChange(); }
    if (d.resched) return startReschedule(Number(d.resched));
    if (d.cancel) return doCancel(Number(d.cancel));
    if (d.seg) { state.pastFilter = d.seg; return render(); }
    if (d.calNav) {
      let { y, m } = state.cal; m += Number(d.calNav);
      if (m < 0) { m = 11; y -= 1; } else if (m > 11) { m = 0; y += 1; }
      state.cal = { y, m }; state.calSel = null;
      return render();
    }
    if (d.calDay) { state.calSel = d.calDay === state.calSel ? null : d.calDay; return render(); }
  });

  root.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'cs-date') selectDate(e.target.value);
  });

  // Typing a start/end time: update the live summary only (no re-render, so the field keeps focus).
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.matches || !t.matches('[data-pick]')) return;
    state.pick[t.getAttribute('data-pick')] = t.value;
    const coach = state.slots && state.slots.coaches[0];
    const box = coach && root.querySelector('[data-pick-summary="' + coach.id + '"]');
    if (box) box.innerHTML = pickSummaryHtml(coach);
  });

  /* ── hooks: load fresh data whenever the tab is opened ── */
  function isActive() { const p = document.getElementById('member-coach-scheduling'); return !!(p && p.classList.contains('active')); }

  const nav = document.getElementById('nav-member-coach-scheduling');
  if (nav) nav.addEventListener('click', () => { setTimeout(refresh, 0); });

  // Also covers any code that opens the tab through memberTab('coach-scheduling').
  const origTab = window.memberTab;
  if (typeof origTab === 'function') {
    window.memberTab = function (tabName, el) {
      const r = origTab.apply(this, arguments);
      if (tabName === 'coach-scheduling' && !(el && el.id === 'nav-member-coach-scheduling')) refresh();
      return r;
    };
  }

  /* ── 1-hour reminder (shown on any dashboard tab) ─────── */
  const REMIND_KEY = 'cs-reminder-dismissed';
  let dismissed = {};
  try { dismissed = JSON.parse(sessionStorage.getItem(REMIND_KEY) || '{}'); } catch (e) { dismissed = {}; }
  const toasted = {};

  function showReminder(rem) {
    let bar = document.getElementById('cs-reminder-bar');
    if (!rem || dismissed[rem.booking_id]) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'cs-reminder-bar'; bar.setAttribute('role', 'status'); bar.setAttribute('aria-live', 'polite');
      document.body.appendChild(bar);
    }
    bar.innerHTML = '<div class="cs-reminder-icon">⏰</div><div class="cs-reminder-body"><b>Session in ' + esc(rem.minutes) + ' min</b>' +
      '<span>' + esc(rem.coach_name) + ' · ' + esc(rem.start_label) + ' – ' + esc(rem.end_label) + '</span>' +
      (rem.status === 'pending' ? '<small>Waiting for staff confirmation</small>' : '') + '</div>' +
      '<button type="button" class="cs-reminder-x" aria-label="Dismiss reminder">✕</button>';
    bar.querySelector('.cs-reminder-x').onclick = () => {
      dismissed[rem.booking_id] = true;
      try { sessionStorage.setItem(REMIND_KEY, JSON.stringify(dismissed)); } catch (e) { /* ignore */ }
      bar.remove();
    };
    if (!toasted[rem.booking_id]) { toasted[rem.booking_id] = true; toast(rem.message, 'info'); }
  }

  async function checkReminder() {
    const r = await api('/member/coach-scheduling/reminder');
    if (r && r.success) showReminder(r.reminder);
  }
  checkReminder();
  setInterval(() => { if (!document.hidden) checkReminder(); }, 60000);

  /* ── staff cancelled / declined my booking: tell me right away ──
     Polled every few seconds (cheap indexed query) while the dashboard is open, on any tab. */
  const shownNotice = {};
  let noticeBusy = false;
  async function checkNotices() {
    if (noticeBusy) return;
    noticeBusy = true;
    try {
      const r = await api('/member/coach-scheduling/notices');
      const fresh = r && r.success ? (r.notices || []).filter((n) => !shownNotice[n.id]) : [];
      if (!fresh.length) return;
      fresh.forEach((n) => { shownNotice[n.id] = true; });
      await api('/member/coach-scheduling/notices/seen', { ids: fresh.map((n) => n.id) });
      // Update anything the member is looking at: bookings/credits, open times and the 1-hour reminder.
      if (state.overview) refreshAfterChange();
      checkReminder();
      const last = fresh[fresh.length - 1];
      const text = fresh.length > 1 ? fresh.map((n) => n.message).join(' ') : last.message;
      if (typeof window.showErrorModal === 'function') window.showErrorModal(text, String(last.title || 'Coach session update').toUpperCase());
      else window.alert(text);
    } finally { noticeBusy = false; }
  }
  checkNotices();
  setInterval(() => { if (!document.hidden) checkNotices(); }, 10000);

  // Slots change as other members book: re-check when the page regains focus.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkNotices();
    if (document.visibilityState === 'visible') checkReminder();
    if (document.visibilityState === 'visible' && isActive() && state.overview) refreshAfterChange();
  });
})();