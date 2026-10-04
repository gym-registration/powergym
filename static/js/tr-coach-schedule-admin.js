/* ═══════════════════════════════════════════════════════════════
   Coach Schedule — staff + admin dashboards
   Four tabs:
     1. Member Coach Requests — sessions members booked, waiting for staff to
        confirm (save) or decline.
     2. All Schedules          — every booking, filterable, with the full
        confirm / complete / no-show / cancel workflow.
     3. Coach Availability     — set each coach's hours for every day of the week
        (From / To / slot length per day) and fine-tune individual slots.
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
  const DURATIONS = [30, 45, 60, 90, 120];
  const STATUS_BADGE = {
    pending: 'badge-gold', confirmed: 'badge-green', completed: 'badge-blue',
    cancelled: 'badge-red', no_show: 'badge-muted',
  };

  const state = {
    tab: 'requests',
    bookings: [], pending: 0, coaches: [], assignments: [], assignError: '',
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
  async function loadAll() {
    state.loading = true; state.error = '';
    const [b, c, asg] = await Promise.all([api('/staff/coach-bookings'), api('/staff/coach-scheduling/coaches'), api('/staff/coach-assignments')]);
    state.assignments = asg.success ? (asg.assignments || []) : [];
    state.assignError = asg.success ? '' : (asg.error || 'Could not load coach assignments.');
    state.loading = false;
    if (!b.success || !c.success) {
      state.error = (!b.success ? b.error : c.error) || 'Could not load the coach schedule.';
    } else {
      state.bookings = b.bookings || [];
      state.pending = b.pending_count || 0;
      state.coaches = c.coaches || [];
      state.loaded = true;
      if (state.av.coachId == null && state.coaches.length) state.av.coachId = state.coaches[0].id;
    }
    updateNavBadge();
    render();
    if (state.loaded && state.tab === 'availability' && !state.av.draft.length && state.av.coachId != null && !state.av.loading) loadAvailability(state.av.coachId);
  }

  function updateNavBadge() {
    const el = document.getElementById('csa-nav-badge');
    if (!el) return;
    el.textContent = state.pending;
    el.hidden = !state.pending;
  }

  async function loadAvailability(coachId) {
    state.av.coachId = coachId; state.av.loading = true; state.av.error = '';
    renderAvailability();
    const r = await api('/staff/coach/' + coachId + '/availability');
    state.av.loading = false;
    if (!r.success) { state.av.error = r.error || 'Could not load this coach\'s schedule.'; state.av.draft = []; state.av.snapshot = '[]'; }
    else {
      state.av.draft = (r.slots || []).map((s) => ({ weekday: s.weekday, start: s.start, duration_min: s.duration_min }));
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

  function renderRequests() {
    const list = state.bookings.filter((b) => b.status === 'pending' && b.can_cancel)
      .sort((a, b) => a.start.localeCompare(b.start));
    $('#csa-view-requests').innerHTML =
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
  const slotCmp = (a, b) => a.weekday - b.weekday || (toMin(a.start) ?? 0) - (toMin(b.start) ?? 0);
  function sortDraft() { state.av.draft.sort(slotCmp); }
  const norm = (d) => JSON.stringify([...d].sort(slotCmp));       // order-independent snapshot
  const isDirty = () => norm(state.av.draft) !== state.av.snapshot;

  /** Returns Set of draft indexes that clash (same start, empty time, or overlap on the same day). */
  function problemIdx() {
    const bad = new Set(); const d = state.av.draft;
    d.forEach((s, i) => {
      const a = toMin(s.start); if (a == null) { bad.add(i); return; }
      for (let j = i + 1; j < d.length; j++) {
        if (d[j].weekday !== s.weekday) continue;
        const b = toMin(d[j].start); if (b == null) continue;
        if (a < b + d[j].duration_min && b < a + s.duration_min) { bad.add(i); bad.add(j); }
      }
    });
    return bad;
  }

  /** Update problem highlights, the unsaved marker and the Save button WITHOUT rebuilding the
   *  rows — so keyboard focus stays where the user is while they edit a slot's time/length. */
  function refreshFlags() {
    const bad = problemIdx();
    root.querySelectorAll('.csa-slot').forEach((el) => {
      const inp = el.querySelector('[data-slot]'); if (!inp) return;
      const isBad = bad.has(+inp.getAttribute('data-slot'));
      el.classList.toggle('dup', isBad);
      el.title = isBad ? 'This slot is empty or overlaps another slot' : '';
    });
    const dirty = $('#csa-dirty'); if (dirty) dirty.classList.toggle('show', isDirty());
    const save = $('#csa-save'); if (save) save.disabled = state.busy || !isDirty();
  }

  function renderWeek() {
    const bad = problemIdx();
    const rows = DAYS.map((name, wd) => {
      const slots = state.av.draft.map((s, i) => ({ s, i })).filter((x) => x.s.weekday === wd);
      const chips = slots.length ? slots.map(({ s, i }) => {
        const durs = DURATIONS.includes(s.duration_min) ? DURATIONS : DURATIONS.concat([s.duration_min]).sort((a, b) => a - b);
        return '<span class="csa-slot' + (bad.has(i) ? ' dup' : '') + '" title="' + (bad.has(i) ? 'This slot is empty or overlaps another slot' : '') + '">' +
          '<input type="time" value="' + esc(s.start) + '" data-slot="' + i + '" data-field="start" aria-label="' + name + ' start time">' +
          '<select data-slot="' + i + '" data-field="duration_min" aria-label="' + name + ' duration">' +
          durs.map((m) => '<option value="' + m + '"' + (m === s.duration_min ? ' selected' : '') + '>' + m + ' min</option>').join('') + '</select>' +
          '<button type="button" class="csa-slot-x" data-del="' + i + '" aria-label="Remove slot" title="Remove slot">×</button></span>';
      }).join('') : '<span class="csa-none">Not available</span>';
      // Per-day hours: prefilled from what is saved for this day so staff edit it in place.
      const mins = slots.map((x) => toMin(x.s.start)).filter((m) => m != null);
      const ends = slots.filter((x) => toMin(x.s.start) != null).map((x) => toMin(x.s.start) + x.s.duration_min);
      const hFrom = mins.length ? toHHMM(Math.min(...mins)) : '09:00';
      const hTo = ends.length ? toHHMM(Math.min(Math.max(...ends), 24 * 60 - 1)) : '17:00';
      const hLen = slots.length ? slots[0].s.duration_min : 60;
      const lens = DURATIONS.includes(hLen) ? DURATIONS : DURATIONS.concat([hLen]).sort((a, b) => a - b);
      const hours = '<div class="csa-hours"><span class="csa-hours-label">Hours</span>' +
        '<input type="time" class="csa-input" data-hfrom="' + wd + '" value="' + hFrom + '" aria-label="' + name + ' available from">' +
        '<span class="csa-sub">to</span>' +
        '<input type="time" class="csa-input" data-hto="' + wd + '" value="' + hTo + '" aria-label="' + name + ' available until">' +
        '<select class="csa-select" data-hlen="' + wd + '" aria-label="' + name + ' slot length">' +
        lens.map((m) => '<option value="' + m + '"' + (m === hLen ? ' selected' : '') + '>' + m + ' min each</option>').join('') + '</select>' +
        '<button type="button" class="csa-btn ok" data-apply-hours="' + wd + '">Set ' + DAYS_SHORT[wd] + ' hours</button>' +
        '<button type="button" class="csa-btn" data-apply-hours-all="' + wd + '" title="Use these hours on every day of the week">All days</button>' +
        (slots.length ? '<button type="button" class="csa-btn danger" data-day-off="' + wd + '">Day off</button>' : '') + '</div>';
      return '<div class="csa-day"><div class="csa-day-name">' + name + '<small>' + slots.length + ' slot' + (slots.length === 1 ? '' : 's') + '</small></div>' +
        '<div class="csa-day-main"><div class="csa-slots">' + chips + '</div>' + hours + '</div>' +
        '<button type="button" class="csa-btn" data-add="' + wd + '">+ Add slot</button></div>';
    }).join('');
    const w = $('#csa-week'); if (w) w.innerHTML = rows;
    const dirty = $('#csa-dirty'); if (dirty) dirty.classList.toggle('show', isDirty());
    const save = $('#csa-save'); if (save) save.disabled = state.busy || !isDirty();
  }

  function renderAvailability() {
    const a = state.av;
    if (!state.coaches.length) {
      $('#csa-view-availability').innerHTML = '<div class="csa-panel"><div class="csa-empty" style="padding:30px;">No coaches have been added yet. Add a coach in Settings → Coach Management first.</div></div>';
      return;
    }
    const coachOpts = state.coaches.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === a.coachId ? ' selected' : '') + '>' +
      esc(c.name) + (c.is_active ? '' : ' (inactive)') + ' — ' + c.slot_count + ' slot' + (c.slot_count === 1 ? '' : 's') + '</option>').join('');
    const dayChips = DAYS_SHORT.map((d, i) => '<label class="csa-daychip"><input type="checkbox" data-qday="' + i + '"><span>' + d + '</span></label>').join('');
    $('#csa-view-availability').innerHTML =
      '<div class="csa-panel">' +
      '<div class="csa-av-top"><div class="csa-av-coach"><div class="csa-panel-title">Weekly availability</div>' +
      '<select class="csa-select" id="csa-av-coach" aria-label="Choose coach">' + coachOpts + '</select>' +
      '<span class="csa-dirty" id="csa-dirty">● Unsaved changes</span></div>' +
      '<button type="button" class="csa-btn danger" data-clear-all' + (a.loading ? ' disabled' : '') + '>Clear all slots</button></div>' +
      (a.error ? '<div class="csa-error">' + esc(a.error) + '</div>' : '') +
      '<div class="csa-quick"><div class="csa-quick-label">Quick add</div><div class="csa-quick-row">' +
      '<div class="csa-daychips">' + dayChips +
      '<button type="button" class="csa-btn" data-qpreset="all">All days</button>' +
      '<button type="button" class="csa-btn" data-qpreset="weekdays">Mon–Fri</button>' +
      '<button type="button" class="csa-btn" data-qpreset="none">Clear</button></div>' +
      '<input type="time" class="csa-input" id="csa-q-from" value="09:00" aria-label="First slot starts">' +
      '<span class="csa-sub">to</span>' +
      '<input type="time" class="csa-input" id="csa-q-to" value="12:00" aria-label="Last slot ends by">' +
      '<select class="csa-select" id="csa-q-min" aria-label="Slot length">' + DURATIONS.map((m) => '<option value="' + m + '"' + (m === 60 ? ' selected' : '') + '>' + m + ' min each</option>').join('') + '</select>' +
      '<button type="button" class="csa-btn" data-quick-add>Add slots</button></div></div>' +
      (a.loading ? '<div class="csa-loading">Loading schedule…</div>' : '<div class="csa-week" id="csa-week"></div>') +
      '<div class="csa-av-foot"><div class="csa-hint">Set the hours this coach can be booked on each day — members can only book the slots listed here, and a day with no slots shows as Not available. Times are gym-local. Changing availability never cancels existing bookings — any that fall outside the new schedule will be flagged so you can review them in All Schedules.</div>' +
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

  function addSlot(wd) {
    const mine = state.av.draft.filter((s) => s.weekday === wd).sort((a, b) => toMin(a.start) - toMin(b.start));
    let start = 9 * 60;
    if (mine.length) { const last = mine[mine.length - 1]; start = (toMin(last.start) ?? 540) + last.duration_min; }
    if (start + 60 > 24 * 60) start = 8 * 60;
    state.av.draft.push({ weekday: wd, start: toHHMM(start), duration_min: 60 });
    sortDraft(); renderWeek();
  }

  /** Replace a day's slots with back-to-back slots filling From → To (staff edit each day's hours). */
  function applyHours(wd, allDays) {
    const from = toMin(root.querySelector('[data-hfrom="' + wd + '"]').value);
    const to = toMin(root.querySelector('[data-hto="' + wd + '"]').value);
    const dur = +root.querySelector('[data-hlen="' + wd + '"]').value;
    if (from == null || to == null || to <= from) return toast('Choose a start time that is earlier than the end time.', 'error');
    if (from + dur > to) return toast('That time range is shorter than one slot.', 'error');
    const days = allDays ? [0, 1, 2, 3, 4, 5, 6] : [wd];
    state.av.draft = state.av.draft.filter((s) => !days.includes(s.weekday));
    let n = 0;
    days.forEach((d) => { for (let t = from; t + dur <= to; t += dur) { state.av.draft.push({ weekday: d, start: toHHMM(t), duration_min: dur }); n++; } });
    sortDraft(); renderWeek();
    toast((allDays ? 'All days' : DAYS[wd]) + ': ' + label12(toHHMM(from)) + ' – ' + label12(toHHMM(to)) + ' (' + n + ' slot' + (n === 1 ? '' : 's') + '). Remember to save.', 'success');
  }

  function quickAdd() {
    const days = [...root.querySelectorAll('[data-qday]:checked')].map((c) => +c.getAttribute('data-qday'));
    const from = toMin($('#csa-q-from').value), to = toMin($('#csa-q-to').value), dur = +$('#csa-q-min').value;
    if (!days.length) return toast('Pick at least one day first.', 'error');
    if (from == null || to == null || to <= from) return toast('Choose a start time that is earlier than the end time.', 'error');
    if (from + dur > to) return toast('That time range is shorter than one slot.', 'error');
    let added = 0;
    days.forEach((wd) => {
      for (let t = from; t + dur <= to; t += dur) {
        const start = toHHMM(t);
        if (!state.av.draft.some((s) => s.weekday === wd && s.start === start)) { state.av.draft.push({ weekday: wd, start, duration_min: dur }); added++; }
      }
    });
    sortDraft(); renderWeek();
    toast(added ? 'Added ' + added + ' slot(s) — remember to save.' : 'Those slots already exist.', added ? 'success' : 'info');
  }

  async function saveAvailability() {
    if (state.busy || !isDirty()) return;
    if (problemIdx().size) return toast('Fix the highlighted slots first — they are empty or overlap another slot.', 'error');
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
    const act = t.closest('[data-act]'); if (act) return changeStatus(act.getAttribute('data-id'), act.getAttribute('data-act'));
    if (t.closest('[data-clear-filters]')) { state.filters = { status: '', coach: '', date: '' }; return renderAll(); }
    const ah = t.closest('[data-apply-hours]'); if (ah) return applyHours(+ah.getAttribute('data-apply-hours'), false);
    const aha = t.closest('[data-apply-hours-all]'); if (aha) return applyHours(+aha.getAttribute('data-apply-hours-all'), true);
    const off = t.closest('[data-day-off]');
    if (off) { const wd = +off.getAttribute('data-day-off'); state.av.draft = state.av.draft.filter((s) => s.weekday !== wd); return renderWeek(); }
    const add = t.closest('[data-add]'); if (add) return addSlot(+add.getAttribute('data-add'));
    const del = t.closest('[data-del]'); if (del) { state.av.draft.splice(+del.getAttribute('data-del'), 1); return renderWeek(); }
    const preset = t.closest('[data-qpreset]');
    if (preset) {
      const mode = preset.getAttribute('data-qpreset');
      root.querySelectorAll('[data-qday]').forEach((c) => {
        const i = +c.getAttribute('data-qday');
        c.checked = mode === 'all' ? true : mode === 'weekdays' ? i <= 4 : false;
      });
      return;
    }
    if (t.closest('[data-quick-add]')) return quickAdd();
    if (t.closest('[data-save]')) return saveAvailability();
    if (t.closest('[data-reset]')) { state.av.draft = JSON.parse(state.av.snapshot); return renderWeek(); }
    if (t.closest('[data-clear-all]')) {
      if (!state.av.draft.length) return;
      const ok = await confirmDialog({ title: 'CLEAR ALL SLOTS', message: 'Remove every weekly slot for this coach? Members won\'t be able to book them until you add slots again and save.', confirmText: 'YES, CLEAR', danger: true });
      if (ok) { state.av.draft = []; renderWeek(); }
    }
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-assign-filter]')) { state.assignCoach = t.value; return renderAssignments(); }
    if (t.matches('[data-filter]')) { state.filters[t.getAttribute('data-filter')] = t.value; return renderAll(); }
    if (t.id === 'csa-av-coach') return switchCoach(+t.value);
    if (t.matches('[data-slot]')) {
      const s = state.av.draft[+t.getAttribute('data-slot')]; if (!s) return;
      const f = t.getAttribute('data-field');
      s[f] = f === 'duration_min' ? +t.value : t.value;
      refreshFlags();          // no re-render: keeps focus; rows re-sort on the next add/remove/save
    }
  });

  // Warn before closing the tab with unsaved availability edits.
  window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

  /* ── boot: load now (for the sidebar badge) and whenever the nav item is opened ── */
  ['nav-staff-coach-schedule', 'nav-admin-coach-schedule'].forEach((id) => {
    const nav = document.getElementById(id);
    if (nav) nav.addEventListener('click', () => { if (!state.busy) loadAll(); });
  });
  render();
  loadAll();
})();
