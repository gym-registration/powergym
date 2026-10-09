/* ═══════════════════════════════════════════════════════════════
   Coach Schedule — staff + admin dashboards
   Four tabs:
     1. Member Coach Requests — sessions members booked, waiting for staff to
        confirm (save) or decline.
     2. All Schedules          — every booking, filterable, with the full
        confirm / complete / no-show / cancel workflow.
     3. Coach Availability     — set each coach's working hours: one row per day of
        the week (working or day off, From / To). Members pick their own start time
        and session length inside these hours.
     4. Coach Assignments      — which members requested which coach.
   Talks to the endpoints in coach_scheduling.py. The server enforces every
   rule (status transitions, credit deduction on Completed, slot validity);
   this file only presents them.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const root = document.getElementById('csa-root');
  if (!root) return;

  // Only STAFF may act on bookings (confirm / decline / complete / no-show / cancel).
  // Admins get a read-only view. The server enforces this too (coach_scheduling.py).
  const CAN_ACT = (root.getAttribute('data-role') || 'staff') === 'staff';

  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const STATUS_BADGE = {
    pending: 'badge-gold', confirmed: 'badge-green', completed: 'badge-blue',
    cancelled: 'badge-red', no_show: 'badge-muted',
  };

  const state = {
    tab: 'requests',
    bookings: [], pending: 0, holds: [], seenPending: null, coaches: [], assignments: [], assignError: '',
    assignCoach: '',
    loaded: false, loading: false, error: '',
    filters: { status: '', coach: '', date: '' },
    av: { coachId: null, draft: [], snapshot: '[]', loading: false, error: '' },
    busy: false,
  };

  /* ── helpers ─────────────────────────────────────────── */
  const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => (String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (s) => { const d = parseYmd(s); return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); };
  const dowOf = (s) => DAYS[(parseYmd(s).getDay() + 6) % 7];
  const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const toHHMM = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  const label12 = (hhmm) => { const m = toMin(hhmm); if (m == null) return ''; const h = Math.floor(m / 60); return ((h % 12) || 12) + ':' + String(m % 60).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'); };

  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(esc(msg), type || 'success');
    else window.alert(msg);
  }

  async function api(url, body) {
    try {
      const opts = { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
      const res = await fetch(url, opts);
      let data;
      try { data = await res.json(); } catch (e) { data = { success: false, error: 'Unexpected response from the server.' }; }
      if (res.status === 401 || res.status === 403) data.error = 'Your session has expired or you are not allowed to do this — please sign in again.';
      return data;
    } catch (e) {
      return { success: false, error: 'Could not reach the server. Please try again.' };
    }
  }

  /* ── confirm dialog (reuses the app's .modal-overlay look) ── */
  function confirmDialog({ title, message, confirmText, danger }) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay open';
      ov.style.zIndex = 1500;
      ov.innerHTML =
        '<div class="modal" style="max-width:440px;text-align:center;">' +
        '<div class="modal-title" style="margin-bottom:14px;">' + esc(title) + '</div>' +
        '<div style="color:var(--white);line-height:1.6;margin-bottom:22px;font-size:16px;">' + message + '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
        '<button type="button" class="btn btn-outline" data-x="no" style="justify-content:center;">GO BACK</button>' +
        '<button type="button" class="btn btn-red" data-x="yes" style="justify-content:center;' + (danger ? '' : 'background:var(--green);color:#04210f;') + '">' + esc(confirmText || 'CONFIRM') + '</button>' +
        '</div></div>';
      const done = (v) => { document.removeEventListener('keydown', onKey); ov.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      ov.addEventListener('click', (e) => {
        if (e.target === ov) return done(false);
        const b = e.target.closest('[data-x]');
        if (b) done(b.getAttribute('data-x') === 'yes');
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(ov);
      const yes = ov.querySelector('[data-x="yes"]'); if (yes) yes.focus();
    });
  }

  /* ── data loading ────────────────────────────────────── */
  async function loadAll(silent) {
    if (!silent) { state.loading = true; state.error = ''; }
    const [b, c, asg, h] = await Promise.all([api('/staff/coach-bookings'), api('/staff/coach-scheduling/coaches'), api('/staff/coach-assignments'), api('/staff/coach-day-holds')]);
    state.holds = h.success ? (h.holds || []) : [];
    state.assignments = asg.success ? (asg.assignments || []) : [];
    state.assignError = asg.success ? '' : (asg.error || 'Could not load coach assignments.');
    state.loading = false;
    if (!b.success || !c.success) {
      state.error = (!b.success ? b.error : c.error) || 'Could not load the coach schedule.';
    } else {
      state.bookings = b.bookings || [];
      state.pending = b.pending_count || 0;
      notifyNewRequests();
      state.coaches = c.coaches || [];
      state.loaded = true;
      if (state.av.coachId == null && state.coaches.length) state.av.coachId = state.coaches[0].id;
    }
    updateNavBadge();
    if (silent && isEditingAvailability()) renderRequests();   // don't disturb the availability editor while staff type
    else render();
    if (!silent && state.loaded && state.tab === 'availability' && !state.av.draft.length && state.av.coachId != null && !state.av.loading) loadAvailability(state.av.coachId);
  }

  /** Tell staff straight away when a member books a coach (first load just records what is already pending). */
  function notifyNewRequests() {
    const pend = state.bookings.filter((b) => b.status === 'pending' && b.can_cancel);
    const ids = new Set(pend.map((b) => b.id));
    if (state.seenPending) {
      pend.filter((b) => !state.seenPending.has(b.id)).forEach((b) => {
        toast('New coach booking: ' + (b.member_name || 'A member') + ' booked ' + b.coach_name + ' on ' + fmtDate(b.date) + ' at ' + b.start_label + '. That time is now taken.', 'info');
      });
    }
    state.seenPending = ids;
  }
  function isEditingAvailability() { return state.tab === 'availability'; }

  function updateNavBadge() {
    const el = document.getElementById('csa-nav-badge');
    if (!el) return;
    const n = state.pending + state.holds.length;      // new requests + coaches waiting to be re-opened
    el.textContent = n;
    el.hidden = !n;
  }

  async function loadAvailability(coachId) {
    state.av.coachId = coachId; state.av.loading = true; state.av.error = '';
    renderAvailability();
    const r = await api('/staff/coach/' + coachId + '/availability');
    state.av.loading = false;
    if (!r.success) { state.av.error = r.error || 'Could not load this coach\'s schedule.'; state.av.draft = []; state.av.snapshot = '[]'; }
    else {
      // One row per day: earliest start → latest end of whatever is saved for that day.
      state.av.draft = [];
      for (let wd = 0; wd < 7; wd++) {
        const day = (r.slots || []).filter((x) => x.weekday === wd && toMin(x.start) != null);
        if (!day.length) continue;
        const from = Math.min(...day.map((x) => toMin(x.start)));
        const to = Math.min(Math.max(...day.map((x) => toMin(x.start) + x.duration_min)), 24 * 60 - 1);
        state.av.draft.push({ weekday: wd, start: toHHMM(from), duration_min: to - from });
      }
      sortDraft();
      state.av.snapshot = norm(state.av.draft);
    }
    renderAvailability();
  }

  /* ── shell ───────────────────────────────────────────── */
  const ICON_CAL = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
  const ICON_INBOX = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 13l2.6-7.2A2 2 0 0 1 8 4.5h8a2 2 0 0 1 1.9 1.3L20.5 13v5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/><path d="M3.5 13h5l1 2.5h5l1-2.5h5"/></svg>';
  const ICON_LIST = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6.5h12M8 12h12M8 17.5h12"/><circle cx="4" cy="6.5" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="17.5" r="1" fill="currentColor"/></svg>';
  const ICON_USERS = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 13.8c1.8.7 3 2.3 3 5.2"/></svg>';
  const ICON_CLOCK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';

  root.innerHTML =
    '<div class="csa-header"><span class="csa-header-icon">' + ICON_CAL + '</span>' +
    '<div><div class="csa-title">COACH SCHEDULE</div>' +
    '<div class="csa-subtitle">Review sessions members booked with a coach, and manage when each coach can be booked.</div></div></div>' +
    '<div class="csa-tabs" role="tablist" aria-label="Coach schedule">' +
    '<button type="button" class="csa-tab active" role="tab" aria-selected="true" data-tab="requests">' + ICON_INBOX + '<span>Member Coach Requests</span><span class="csa-count" id="csa-tab-count" hidden>0</span></button>' +
    '<button type="button" class="csa-tab" role="tab" aria-selected="false" data-tab="all">' + ICON_LIST + '<span>All Schedules</span></button>' +
    '<button type="button" class="csa-tab" role="tab" aria-selected="false" data-tab="availability">' + ICON_CLOCK + '<span>Coach Availability</span></button>' +
    '<button type="button" class="csa-tab" role="tab" aria-selected="false" data-tab="assignments">' + ICON_USERS + '<span>Coach Assignments</span></button>' +
    '</div>' +
    '<div id="csa-error"></div>' +
    '<div class="csa-view" id="csa-view-requests"></div>' +
    '<div class="csa-view" id="csa-view-all" hidden></div>' +
    '<div class="csa-view" id="csa-view-availability" hidden></div>' +
    '<div class="csa-view" id="csa-view-assignments" hidden></div>';

  const $ = (sel) => root.querySelector(sel);

  function setTab(tab) {
    if (tab === state.tab) return;
    state.tab = tab;
    root.querySelectorAll('.csa-tab').forEach((t) => {
      const on = t.getAttribute('data-tab') === tab;
      t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    ['requests', 'all', 'availability', 'assignments'].forEach((v) => { $('#csa-view-' + v).hidden = v !== tab; });
    render();
    if (tab === 'availability' && state.av.coachId != null && !state.av.draft.length && !state.av.loading) loadAvailability(state.av.coachId);
  }

  /* ── rendering: bookings ─────────────────────────────── */
  function personCell(b) {
    const photo = b.member_photo ? ' style="background-image:url(\'' + esc(b.member_photo) + '\')"' : '';
    return '<div class="csa-person"><span class="csa-avatar"' + photo + '>' + (b.member_photo ? '' : esc(initials(b.member_name))) + '</span>' +
      '<div><div class="csa-name">' + esc(b.member_name || 'Unknown member') + '</div><div class="csa-sub">Member #' + esc(b.member_id) + '</div></div></div>';
  }
  function coachCell(b) {
    const photo = b.coach_photo ? ' style="background-image:url(\'' + esc(b.coach_photo) + '\')"' : '';
    return '<div class="csa-person"><span class="csa-avatar"' + photo + '>' + (b.coach_photo ? '' : esc(initials(b.coach_name))) + '</span>' +
      '<div class="csa-name">' + esc(b.coach_name) + '</div></div>';
  }
  function whenCell(b) {
    return '<div class="csa-when"><div class="csa-name">' + esc(fmtDate(b.date)) + '</div>' +
      '<div class="csa-sub">' + esc(dowOf(b.date)) + ' · ' + esc(b.start_label) + ' – ' + esc(b.end_label) + '</div></div>';
  }
  function statusBadge(b) { return '<span class="badge ' + (STATUS_BADGE[b.status] || 'badge-muted') + '">' + esc(b.status_label) + '</span>'; }

  function actionButtons(b) {
    if (!CAN_ACT) return '<span class="csa-sub" title="Only staff can confirm or change bookings">View only</span>';
    const id = esc(b.id);
    const btn = (act, text, cls) => '<button type="button" class="csa-btn ' + (cls || '') + '" data-act="' + act + '" data-id="' + id + '">' + text + '</button>';
    if (b.status === 'pending') return btn('confirmed', 'Confirm', 'ok') + btn('cancelled', 'Decline', 'danger');
    if (b.status === 'confirmed') {
      // Can't complete / no-show a session that hasn't started yet (server enforces too).
      if (b.can_cancel) return btn('cancelled', 'Cancel', 'danger');
      return btn('completed', 'Mark completed', 'ok') + btn('no_show', 'No-show') + btn('cancelled', 'Cancel', 'danger');
    }
    return '<span class="csa-sub">—</span>';
  }

  function bookingRows(list, withStatus, emptyText) {
    if (!list.length) return '<tr><td colspan="5" class="csa-empty">' + esc(emptyText) + '</td></tr>';
    return list.map((b) =>
      '<tr><td>' + personCell(b) + '</td><td>' + coachCell(b) + '</td><td>' + whenCell(b) + '</td>' +
      '<td>' + (withStatus ? statusBadge(b) : '<span class="csa-sub" style="font-size:14px;">' + esc(b.created_label || '—') + '</span>') + '</td>' +
      '<td><div class="csa-actions">' + actionButtons(b) + '</div></td></tr>').join('');
  }

  /** Coaches who finished a session today and are held back until the coach tells staff they are free. */
  function holdsPanel() {
    if (!state.holds.length) return '';
    const rows = state.holds.map((h) => {
      const photo = h.photo ? ' style="background-image:url(\'' + esc(h.photo) + '\')"' : '';
      return '<tr><td><div class="csa-person"><span class="csa-avatar"' + photo + '>' + (h.photo ? '' : esc(initials(h.coach_name))) + '</span>' +
        '<div class="csa-name">' + esc(h.coach_name) + '</div></div></td>' +
        '<td><div class="csa-name">' + esc(fmtDate(h.date)) + '</div><div class="csa-sub">' + esc(dowOf(h.date)) + ' · session ended ' + esc(h.finished_label) + '</div></td>' +
        '<td><span class="badge badge-gold">Not bookable</span></td>' +
        '<td><div class="csa-actions">' + (CAN_ACT
          ? '<button type="button" class="csa-btn ok" data-release="' + esc(h.coach_id) + '" data-date="' + esc(h.date) + '">Mark available</button>'
          : '<span class="csa-sub">View only</span>') + '</div></td></tr>';
    }).join('');
    return '<div class="csa-panel" style="margin-bottom:18px;border-color:rgba(255,193,7,.45);">' +
      '<div class="csa-toolbar"><div class="csa-panel-title">Coaches waiting to be re-opened <span class="csa-count">' + state.holds.length + '</span></div></div>' +
      '<div class="csa-sub" style="margin:-4px 0 12px;font-size:14px;">After a session the coach is hidden from members for the rest of the day. Once the coach tells you they are free, press <b>Mark available</b> to open their remaining times again (this is done per day).</div>' +
      '<div class="csa-table-wrap"><table class="csa-table"><thead><tr><th>Coach</th><th>Day</th><th>Members see</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  async function releaseCoach(coachId, date) {
    if (state.busy || !CAN_ACT) return;
    const h = state.holds.find((x) => String(x.coach_id) === String(coachId));
    const ok = await confirmDialog({
      title: 'MARK COACH AVAILABLE',
      message: 'Has <strong>' + esc(h ? h.coach_name : 'the coach') + '</strong> told you they are free? Their remaining times on <strong>' + esc(h ? fmtDate(h.date) : date) + '</strong> will open on the members\' dashboards again.',
      confirmText: 'YES, AVAILABLE', danger: false,
    });
    if (!ok) return;
    state.busy = true;
    const r = await api('/staff/coach-day-holds/release', { coach_id: +coachId, date });
    state.busy = false;
    toast(r.success ? (r.message || 'Coach is available again.') : (r.error || 'Could not re-open this coach.'), r.success ? 'success' : 'error');
    await loadAll();
  }

  function renderRequests() {
    const list = state.bookings.filter((b) => b.status === 'pending' && b.can_cancel)
      .sort((a, b) => a.start.localeCompare(b.start));
    $('#csa-view-requests').innerHTML = holdsPanel() +
      '<div class="csa-panel"><div class="csa-toolbar"><div class="csa-panel-title">Scheduled Coach Requests ' +
      '<span class="csa-count"' + (list.length ? '' : ' hidden') + '>' + list.length + '</span></div>' +
      '<button type="button" class="csa-btn" data-refresh>↻ Refresh</button></div>' +
      '<div class="csa-table-wrap"><table class="csa-table"><thead><tr><th>Member</th><th>Coach</th><th>Date &amp; Time</th><th>Requested</th><th>Actions</th></tr></thead><tbody>' +
      bookingRows(list, false, 'No pending requests — new member bookings will show up here.') +
      '</tbody></table></div></div>';
  }

  function filteredAll() {
    const f = state.filters;
    return state.bookings.filter((b) =>
      (!f.status || b.status === f.status) && (!f.coach || String(b.coach_id) === f.coach) && (!f.date || b.date === f.date))
      .sort((a, b) => b.start.localeCompare(a.start));
  }

  function renderAll() {
    const f = state.filters;
    const coachOpts = '<option value="">All coaches</option>' + state.coaches.map((c) => '<option value="' + esc(c.id) + '"' + (String(c.id) === f.coach ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
    const stOpts = [['', 'All status'], ['pending', 'Pending'], ['confirmed', 'Confirmed'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['no_show', 'No-show']]
      .map(([v, l]) => '<option value="' + v + '"' + (v === f.status ? ' selected' : '') + '>' + l + '</option>').join('');
    const list = filteredAll();
    $('#csa-view-all').innerHTML =
      '<div class="csa-panel"><div class="csa-toolbar"><div class="csa-panel-title">All Coach Schedules <span class="csa-sub" style="font-size:14px;font-weight:500;">' + list.length + ' shown</span></div>' +
      '<div class="csa-filters">' +
      '<select class="csa-select" data-filter="status" aria-label="Filter by status">' + stOpts + '</select>' +
      '<select class="csa-select" data-filter="coach" aria-label="Filter by coach">' + coachOpts + '</select>' +
      '<input type="date" class="csa-input" data-filter="date" value="' + esc(f.date) + '" aria-label="Filter by date">' +
      (f.status || f.coach || f.date ? '<button type="button" class="csa-btn" data-clear-filters>Clear</button>' : '') +
      '</div></div>' +
      '<div class="csa-table-wrap"><table class="csa-table"><thead><tr><th>Member</th><th>Coach</th><th>Date &amp; Time</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
      bookingRows(list, true, 'No bookings match these filters.') +
      '</tbody></table></div></div>';
  }

  /* ── rendering: coach assignments ────────────────────── */
  const ASSIGN_BADGE = { verified: ['badge-green', 'Active'], rejected: ['badge-red', 'Rejected'] };
  function renderAssignments() {
    const names = [...new Set(state.assignments.map((a) => a.coach_name))].sort();
    const sel = state.assignCoach;
    const list = state.assignments.filter((a) => !sel || a.coach_name === sel);
    const opts = '<option value="">All coaches</option>' + names.map((n) => '<option value="' + esc(n) + '"' + (n === sel ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
    const rows = list.length ? list.map((a) => {
      const b = ASSIGN_BADGE[a.status] || ['badge-blue', 'Pending'];
      return '<tr><td><div class="csa-name">' + esc(a.member_name) + '</div></td><td>' + esc(a.coach_name) + '</td><td>' + esc(a.plan) + '</td>' +
        '<td><span class="csa-sub" style="font-size:14px;">' + esc(a.date) + '</span></td><td><span class="badge ' + b[0] + '">' + b[1] + '</span></td></tr>';
    }).join('') : '<tr><td colspan="5" class="csa-empty">No coach requests yet.</td></tr>';
    $('#csa-view-assignments').innerHTML =
      (state.assignError ? '<div class="csa-error">' + esc(state.assignError) + '</div>' : '') +
      '<div class="csa-panel"><div class="csa-toolbar"><div class="csa-panel-title">Coach Assignments ' +
      '<span class="csa-sub" style="font-size:14px;font-weight:500;">Members who requested a personal coach · ' + list.length + ' shown</span></div>' +
      '<div class="csa-filters"><select class="csa-select" data-assign-filter aria-label="Filter by coach">' + opts + '</select>' +
      '<button type="button" class="csa-btn" data-refresh>↻ Refresh</button></div></div>' +
      '<div class="csa-table-wrap"><table class="csa-table"><thead><tr><th>Member</th><th>Coach</th><th>Plan</th><th>Requested</th><th>Status</th></tr></thead><tbody>' +
      rows + '</tbody></table></div></div>';
  }

  /* ── rendering: availability editor ──────────────────── */
  // One entry per working day: { weekday, start: 'HH:MM', duration_min }. A day with no entry is a day off.
  const slotCmp = (a, b) => a.weekday - b.weekday;
  function sortDraft() { state.av.draft.sort(slotCmp); }
  const norm = (d) => JSON.stringify([...d].sort(slotCmp));       // order-independent snapshot
  const isDirty = () => norm(state.av.draft) !== state.av.snapshot;
  const entryFor = (wd) => state.av.draft.find((x) => x.weekday === wd);
  const endOf = (e) => toHHMM(Math.min(toMin(e.start) + e.duration_min, 24 * 60 - 1));
  const lenText = (min) => { if (min <= 0) return '—'; const h = Math.floor(min / 60), m = min % 60; return (h ? h + ' hr' + (h > 1 ? 's' : '') : '') + (h && m ? ' ' : '') + (m ? m + ' min' : ''); };

  /** Returns Set of draft indexes with a problem (no start time, or the end isn't at least 15 minutes after the start). */
  function problemIdx() {
    const bad = new Set();
    state.av.draft.forEach((e, i) => { if (toMin(e.start) == null || !(e.duration_min >= 15)) bad.add(i); });
    return bad;
  }

  /** Update row highlights, the hours summary, the unsaved marker and the Save button WITHOUT
   *  rebuilding the rows — so keyboard focus stays where the user is while they edit a time. */
  function refreshFlags() {
    const bad = problemIdx();
    root.querySelectorAll('.csa-wk-row').forEach((row) => {
      const wd = +row.getAttribute('data-wd'); const e = entryFor(wd);
      const i = e ? state.av.draft.indexOf(e) : -1;
      row.classList.toggle('bad', i >= 0 && bad.has(i));
      const len = row.querySelector('[data-len]');
      if (len && e) len.textContent = e.duration_min >= 15 ? lenText(e.duration_min) + ' open' : 'End must be after start';
    });
    const dirty = $('#csa-dirty'); if (dirty) dirty.classList.toggle('show', isDirty());
    const save = $('#csa-save'); if (save) save.disabled = state.busy || !isDirty() || bad.size > 0;
  }

  function renderWeek() {
    const rows = DAYS.map((name, wd) => {
      const e = entryFor(wd);
      const on = !!e;
      return '<div class="csa-wk-row' + (on ? '' : ' off') + '" data-wd="' + wd + '">' +
        '<div class="csa-wk-day">' + name + '</div>' +
        '<div class="csa-wk-state"><button type="button" class="csa-switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" data-toggle="' + wd + '" aria-label="' + name + ' working"><span></span></button>' +
        '<span class="csa-wk-state-text">' + (on ? 'Working' : 'Day off') + '</span></div>' +
        (on
          ? '<div class="csa-wk-times"><input type="time" class="csa-input" step="900" data-wk="from" data-wd="' + wd + '" value="' + esc(e.start) + '" aria-label="' + name + ' opens">' +
            '<span class="csa-sub">to</span>' +
            '<input type="time" class="csa-input" step="900" data-wk="to" data-wd="' + wd + '" value="' + esc(endOf(e)) + '" aria-label="' + name + ' closes"></div>' +
            '<div class="csa-wk-len" data-len>' + esc(lenText(e.duration_min)) + ' open</div>'
          : '<div class="csa-wk-times csa-wk-none">Members can’t book this day</div><div class="csa-wk-len"></div>') +
        '</div>';
    }).join('');
    const w = $('#csa-week'); if (w) w.innerHTML = rows;
    refreshFlags();
  }

  function renderAvailability() {
    const a = state.av;
    if (!state.coaches.length) {
      $('#csa-view-availability').innerHTML = '<div class="csa-panel"><div class="csa-empty" style="padding:30px;">No coaches have been added yet. Add a coach in Settings → Coach Management first.</div></div>';
      return;
    }
    const coachOpts = state.coaches.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === a.coachId ? ' selected' : '') + '>' +
      esc(c.name) + (c.is_active ? '' : ' (inactive)') + ' — ' + c.working_days + ' day' + (c.working_days === 1 ? '' : 's') + '/week</option>').join('');
    $('#csa-view-availability').innerHTML =
      '<div class="csa-panel">' +
      '<div class="csa-av-top"><div class="csa-av-coach"><div class="csa-panel-title">Weekly availability</div>' +
      '<select class="csa-select" id="csa-av-coach" aria-label="Choose coach">' + coachOpts + '</select>' +
      '<span class="csa-dirty" id="csa-dirty">● Unsaved changes</span></div>' +
      (CAN_ACT ? '<div class="csa-av-tools"><span class="csa-sub">Quick set:</span>' +
        '<button type="button" class="csa-btn" data-copy="all">Same hours every day</button>' +
        '<button type="button" class="csa-btn" data-copy="weekdays">Mon–Fri only</button>' +
        '<button type="button" class="csa-btn danger" data-clear-all' + (a.loading ? ' disabled' : '') + '>All days off</button></div>' : '') + '</div>' +
      (a.error ? '<div class="csa-error">' + esc(a.error) + '</div>' : '') +
      '<div class="csa-sub csa-av-note">Set the days and hours this coach works. Members choose their own start time and how long their session lasts inside these hours.</div>' +
      (a.loading ? '<div class="csa-loading">Loading schedule…</div>' : '<div class="csa-wk" id="csa-week"></div>') +
      '<div class="csa-av-foot"><div class="csa-hint">Turn a day off and members can’t book that day. Times are gym-local. Changing hours never cancels existing bookings — review them in All Schedules.</div>' +
      '<div style="display:flex;gap:10px;"><button type="button" class="csa-btn" data-reset>Reset</button>' +
      '<button type="button" class="csa-btn primary" id="csa-save" data-save disabled>Save availability</button></div></div></div>';
    if (!a.loading) renderWeek();
  }

  /* ── master render ───────────────────────────────────── */
  function render() {
    const tc = $('#csa-tab-count');
    if (tc) { tc.textContent = state.pending; tc.hidden = !state.pending; }
    $('#csa-error').innerHTML = state.error ? '<div class="csa-error">' + esc(state.error) + ' <button type="button" class="csa-btn" data-refresh style="margin-left:8px;">Retry</button></div>' : '';
    if (!state.loaded) {
      const msg = '<div class="csa-panel"><div class="csa-loading">' + (state.loading ? 'Loading coach schedule…' : '') + '</div></div>';
      ['requests', 'all'].forEach((v) => { $('#csa-view-' + v).innerHTML = msg; });
      if (state.tab === 'availability' || state.tab === 'assignments') $('#csa-view-' + state.tab).innerHTML = msg;
      return;
    }
    if (state.tab === 'requests') renderRequests();
    else if (state.tab === 'all') renderAll();
    else if (state.tab === 'assignments') renderAssignments();
    else renderAvailability();
  }

  /* ── actions ─────────────────────────────────────────── */
  const CONFIRM_COPY = {
    cancelled: (b, wasPending) => ({
      title: wasPending ? 'DECLINE REQUEST' : 'CANCEL SESSION',
      message: 'Cancel <strong>' + esc(b.member_name) + '</strong>\'s session with <strong>' + esc(b.coach_name) + '</strong> on ' + esc(fmtDate(b.date)) + ' at ' + esc(b.start_label) + '?<br><span style="color:var(--muted);font-size:14px;">The slot becomes available to other members again. No session credit is used.</span>',
      confirmText: wasPending ? 'YES, DECLINE' : 'YES, CANCEL', danger: true,
    }),
    completed: (b) => ({
      title: 'MARK COMPLETED',
      message: 'Mark <strong>' + esc(b.member_name) + '</strong>\'s session with <strong>' + esc(b.coach_name) + '</strong> as completed?<br><span style="color:var(--gold);font-size:14px;">This deducts 1 coach session from the member\'s remaining sessions and can\'t be undone.</span>',
      confirmText: 'YES, COMPLETED', danger: false,
    }),
    no_show: (b) => ({
      title: 'MARK NO-SHOW',
      message: 'Mark <strong>' + esc(b.member_name) + '</strong> as a no-show for this session?<br><span style="color:var(--muted);font-size:14px;">No session credit is deducted.</span>',
      confirmText: 'YES, NO-SHOW', danger: true,
    }),
  };

  async function changeStatus(id, status) {
    if (state.busy || !CAN_ACT) return;
    const b = state.bookings.find((x) => String(x.id) === String(id));
    if (!b) return;
    if (CONFIRM_COPY[status]) {
      const ok = await confirmDialog(CONFIRM_COPY[status](b, b.status === 'pending'));
      if (!ok) return;
    }
    state.busy = true;
    document.querySelectorAll('.csa-actions .csa-btn').forEach((x) => { x.disabled = true; });
    const r = await api('/staff/coach-bookings/' + encodeURIComponent(id) + '/status', { status });
    state.busy = false;
    if (!r.success) toast(r.error || 'Could not update this booking.', 'error');
    else {
      let msg = r.message || 'Booking updated.';
      if (status === 'completed' && r.credits_left != null) msg += ' ' + r.credits_left + ' session(s) left for the member.';
      toast(msg, 'success');
    }
    await loadAll();   // always re-sync — another staff member may have changed it too
  }

  const DEFAULT_OPEN = { start: '08:00', duration_min: 12 * 60 };      // 8:00 AM – 8:00 PM

  function toggleDay(wd) {
    const e = entryFor(wd);
    if (e) state.av.draft.splice(state.av.draft.indexOf(e), 1);
    else state.av.draft.push({ weekday: wd, start: DEFAULT_OPEN.start, duration_min: DEFAULT_OPEN.duration_min });
    sortDraft(); renderWeek();
  }

  /** Staff edited the From / To time of one day. */
  function editHours(wd) {
    const e = entryFor(wd); if (!e) return;
    const from = toMin(root.querySelector('[data-wk="from"][data-wd="' + wd + '"]').value);
    const to = toMin(root.querySelector('[data-wk="to"][data-wd="' + wd + '"]').value);
    if (from == null || to == null) { e.start = ''; e.duration_min = 0; }
    else { e.start = toHHMM(from); e.duration_min = to - from; }
    refreshFlags();
  }

  /** Copy the first working day's hours (or 8 AM – 8 PM) to every day / Mon–Fri. */
  function copyHours(mode) {
    const src = state.av.draft.find((x) => toMin(x.start) != null && x.duration_min >= 15) || DEFAULT_OPEN;
    const days = mode === 'weekdays' ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6];
    state.av.draft = days.map((wd) => ({ weekday: wd, start: src.start, duration_min: src.duration_min }));
    renderWeek();
    toast((mode === 'weekdays' ? 'Mon–Fri' : 'Every day') + ': ' + label12(src.start) + ' – ' + label12(toHHMM(toMin(src.start) + src.duration_min)) + '. Remember to save.', 'success');
  }

  async function saveAvailability() {
    if (state.busy || !isDirty()) return;
    if (problemIdx().size) return toast('Fix the highlighted days first — the closing time must be after the opening time.', 'error');
    sortDraft();
    state.busy = true; renderWeek();
    const r = await api('/staff/coach/' + state.av.coachId + '/availability', { slots: state.av.draft });
    state.busy = false;
    if (!r.success) { toast(r.error || 'Could not save availability.', 'error'); renderWeek(); return; }
    toast(r.message || 'Availability saved.', r.affected_bookings ? 'info' : 'success');
    state.av.snapshot = norm(state.av.draft);
    const c = await api('/staff/coach-scheduling/coaches');           // refresh the "n slots" labels
    if (c.success) state.coaches = c.coaches;
    renderAvailability();
  }

  async function switchCoach(newId) {
    if (isDirty()) {
      const ok = await confirmDialog({ title: 'DISCARD CHANGES?', message: 'You have unsaved availability changes for this coach. Switch coach and discard them?', confirmText: 'YES, DISCARD', danger: true });
      if (!ok) { const sel = $('#csa-av-coach'); if (sel) sel.value = state.av.coachId; return; }
    }
    state.av.draft = []; state.av.snapshot = '[]';
    loadAvailability(newId);
  }

  /* ── events (delegated, survives re-renders) ─────────── */
  root.addEventListener('click', async (e) => {
    const t = e.target;
    const tab = t.closest('[data-tab]'); if (tab) return setTab(tab.getAttribute('data-tab'));
    if (t.closest('[data-refresh]')) return loadAll();
    const rel = t.closest('[data-release]'); if (rel) return releaseCoach(rel.getAttribute('data-release'), rel.getAttribute('data-date'));
    const act = t.closest('[data-act]'); if (act) return changeStatus(act.getAttribute('data-id'), act.getAttribute('data-act'));
    if (t.closest('[data-clear-filters]')) { state.filters = { status: '', coach: '', date: '' }; return renderAll(); }
    const tg = t.closest('[data-toggle]'); if (tg) return toggleDay(+tg.getAttribute('data-toggle'));
    const cp = t.closest('[data-copy]'); if (cp) return copyHours(cp.getAttribute('data-copy'));
    if (t.closest('[data-save]')) return saveAvailability();
    if (t.closest('[data-reset]')) { state.av.draft = JSON.parse(state.av.snapshot); return renderWeek(); }
    if (t.closest('[data-clear-all]')) {
      if (!state.av.draft.length) return;
      const ok = await confirmDialog({ title: 'ALL DAYS OFF', message: 'Set every day off for this coach? Members won\'t be able to book this coach until you turn days back on and save.', confirmText: 'YES, ALL OFF', danger: true });
      if (ok) { state.av.draft = []; renderWeek(); }
    }
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-assign-filter]')) { state.assignCoach = t.value; return renderAssignments(); }
    if (t.matches('[data-filter]')) { state.filters[t.getAttribute('data-filter')] = t.value; return renderAll(); }
    if (t.id === 'csa-av-coach') return switchCoach(+t.value);
    if (t.matches('[data-wk]')) editHours(+t.getAttribute('data-wd'));
  });

  root.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('[data-wk]')) editHours(+e.target.getAttribute('data-wd')); });

  // Warn before closing the tab with unsaved availability edits.
  window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

  /* ── boot: load now (for the sidebar badge) and whenever the nav item is opened ── */
  ['nav-staff-coach-schedule', 'nav-admin-coach-schedule'].forEach((id) => {
    const nav = document.getElementById(id);
    if (nav) nav.addEventListener('click', () => { if (!state.busy) loadAll(); });
  });
  render();
  loadAll();
  // Keep staff informed without a page refresh: new member bookings raise an alert + the sidebar badge,
  // and coaches waiting to be re-opened show up here. Paused while the browser tab is hidden.
  setInterval(() => { if (!document.hidden && !state.busy && !state.loading) loadAll(true); }, 20000);
})();