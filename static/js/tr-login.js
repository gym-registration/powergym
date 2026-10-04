/* ═══════════════════════════════════════════════════════════════
   POWER GYM — Login/Register Page JavaScript
   tr-login.js  |  Runs on trmem.html / home.html only

   Requires tr-common.js to be loaded FIRST — it provides Auth,
   Session, Navigation, ContentManager, the toast system, and the
   other shared helpers used below. This file previously duplicated
   ALL of that (re-declaring `const Auth`, `const Session`,
   `const Navigation`, `const ContentManager`, plus a few `let`s),
   which threw a "has already been declared" SyntaxError the moment
   this script loaded after tr-common.js — classic <script> tags
   share one global scope, so redeclaring a top-level const/let is a
   hard error, and it silently killed this ENTIRE file. That's why
   the profile-picture preview (previewProfilePicture) and the real
   multipart completeRegistration() further below never ran, and
   registration silently fell back to tr-common.js's older JSON-only
   completeRegistration(), which doesn't send a picture at all — the
   backend then rejects the request for missing the required file.
   Keep this file limited to code that's genuinely unique to the
   login/register screen; everything shared belongs in tr-common.js.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ════════════════════════════════════════════════
   4. SHARED UTILITIES
   Functions used across multiple modules / pages.
════════════════════════════════════════════════ */

/** Build a full month attendance calendar styled after a classic wall
 *  calendar. Kept in sync with the copy in tr-common.js — see that file
 *  for the full explanation of the parameters. */
function buildAttGrid(elId, presentDays, totalDays = 30, todayDay = null, noPlanDays = [], year = null, month = null) {
  const el = document.getElementById(elId);
  if (!el) return;

  const now = new Date();
  const y = year  || now.getFullYear();
  const m = month || (now.getMonth() + 1); // 1-12
  const firstWeekday = new Date(y, m - 1, 1).getDay(); // 0=Sun .. 6=Sat
  const noPlanSet = new Set(noPlanDays || []);

  const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY',
                  'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const WEEKDAYS = [
    ['SUNDAY', 'SUN'], ['MONDAY', 'MON'], ['TUESDAY', 'TUE'], ['WEDNESDAY', 'WED'],
    ['THURSDAY', 'THU'], ['FRIDAY', 'FRI'], ['SATURDAY', 'SAT'],
  ];
  const LEGEND = [
    ['present',  'Present'],
    ['absent',   'Absent'],
    ['upcoming', 'Upcoming'],
    ['no-plan',  'No Active Plan'],
  ];

  let html = '<div class="att-cal-title">' +
    '<span class="att-cal-month">' + MONTHS[m - 1] + '</span>' +
    '<span class="att-cal-year">' + y + '</span>' +
    '</div>';

  html += '<div class="att-cal-head">' +
    WEEKDAYS.map(([full, short]) =>
      '<div class="att-cal-wd"><span class="wd-full">' + full + '</span><span class="wd-short">' + short + '</span></div>'
    ).join('') +
    '</div><div class="att-cal-body">';

  // Leading blanks so day 1 lands under its real weekday column.
  for (let i = 0; i < firstWeekday; i++) html += '<div class="att-cell att-cell-empty"></div>';

  for (let d = 1; d <= totalDays; d++) {
    // A day with no active membership plan at all stays neutral — there was
    // nothing to check in for, so it shouldn't read as a missed day (red).
    // Otherwise: a day that hasn't happened yet is neither "present" nor
    // "absent" — it just hasn't occurred, so it gets its own neutral state
    // instead of being lumped in with real absences.
    let state;
    if (noPlanSet.has(d)) state = 'no-plan';
    else if (presentDays.includes(d)) state = 'present';
    else if (todayDay && d >= todayDay) state = 'upcoming';
    else state = 'absent';
    const isToday = todayDay && d === todayDay;
    html += '<div class="att-cell ' + state + (isToday ? ' att-today' : '') + '">' +
      '<span class="att-daynum">' + d + '</span>' +
      (state === 'present' ? '<span class="att-caption">Present</span>' : '') +
      '</div>';
  }

  // Trailing blanks so the last row completes a full 7-wide week.
  const trailing = (7 - ((firstWeekday + totalDays) % 7)) % 7;
  for (let i = 0; i < trailing; i++) html += '<div class="att-cell att-cell-empty"></div>';
  html += '</div>';

  html += '<div class="att-legend">' +
    LEGEND.map(([cls, label]) =>
      '<span class="att-legend-item"><i class="att-legend-dot ' + cls + '"></i>' + label + '</span>'
    ).join('') +
    '</div>';

  el.classList.add('att-cal');
  el.innerHTML = html;
}

/** Filter a data table by search string */
function filterTable(input) {
  const val = input.value.toLowerCase();
  document.querySelectorAll('#members-table tbody tr').forEach(r => {
    r.style.display = r.textContent.toLowerCase().includes(val) ? '' : 'none';
  });
}

/** Open a modal overlay */
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

/** Close a modal overlay */
function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  // The Terms & Policy modal can't be dismissed while it's still auto-
  // scrolling through the admin-configured read time — closing early
  // was the one way around the "must finish reading" gate, since the
  // checkbox unlock check only ran *after* the modal was allowed to
  // close. Block the close itself instead, and nudge the member with
  // the same countdown they're already looking at.
  if (id === 'terms-modal' && !_termsGateSatisfied()) {
    _termsUpdateTimerDisplay();
    if (typeof showToast === 'function') {
      showToast(`Please finish reading — ${_termsFormatTime(Math.max(0, termsSecondsLeft || 0))} left.`, 'info');
    }
    return;
  }
  el.classList.remove('open');
}

/** Terms & Policy read-time + auto-scroll gate state. The content
 *  auto-scrolls on its own, driven purely by elapsed time against the
 *  admin-configured duration (data-read-seconds on the modal) — the
 *  member doesn't scroll it themselves; it reaches the bottom exactly
 *  when the timer reaches 0, no sooner. secondsLeft/openedAtMs/
 *  secondsLeftAtOpen track that countdown and persist across multiple
 *  opens/closes in the same page load (so closing and reopening the
 *  modal resumes the scroll from where it left off, instead of letting
 *  someone unlock the checkbox by opening and immediately closing the
 *  modal several times). The "I agree" checkbox unlocks once the
 *  auto-scroll has actually reached the bottom, which can only happen
 *  once the full duration has elapsed. */
let termsSecondsLeft      = null; // whole seconds remaining, for display
let termsTotalSeconds     = null; // admin-configured duration
let termsSecondsLeftAtOpen = null; // snapshot of secondsLeft when this open began
let termsOpenedAtMs       = null; // performance.now() when this open began
let termsHasScrolledToBottom = false;
let termsAutoScrollRAF    = null;
let termsPaused           = false; // true while the member has tapped to pause reading

/** Eases the scroll so it isn't a constant mechanical creep — slower at
 *  the start and the end (where the member is most likely reading
 *  closely), a little quicker through the middle. Still reaches ratio 1
 *  at t=1 exactly like a linear ramp would, so the total read time and
 *  the "reaches bottom exactly when the timer ends" guarantee are
 *  unaffected — only the pacing along the way changes. */
function _termsEase(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** True once the countdown has fully elapsed AND the auto-scroll has
 *  actually reached the bottom — the same condition the "I agree"
 *  checkbox already waits for, reused here to gate closing the modal
 *  itself. */
function _termsGateSatisfied() {
  return termsSecondsLeft !== null && termsSecondsLeft <= 0 && termsHasScrolledToBottom;
}

/** Show/hide the modal's ✕ button to match the gate state — hidden
 *  while still reading, so there's no visible way to dismiss the
 *  modal early, and restored once the read time is up. */
function _termsUpdateCloseButton() {
  const btn = document.getElementById('terms-modal-close');
  if (!btn) return;
  btn.style.visibility = _termsGateSatisfied() ? 'visible' : 'hidden';
}

function _termsFormatTime(s) {
  // Under a minute: "30s". A minute or more: m:ss — e.g. 90 seconds → "1:30".
  if (s >= 60) {
    const m = Math.floor(s / 60), r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }
  return `${s}s`;
}

function _termsUpdateTimerDisplay() {
  _termsUpdateCloseButton();
  const timerEl = document.getElementById('terms-timer');
  if (!timerEl) return;
  if (termsSecondsLeft > 0) {
    timerEl.textContent = termsPaused
      ? `Paused — ${_termsFormatTime(termsSecondsLeft)} left. Tap anywhere to resume.`
      : `Reading automatically — please wait ${_termsFormatTime(termsSecondsLeft)} before you can close this and agree. (Tap anywhere to pause.)`;
  } else {
    timerEl.textContent = "You've reached the end of the Terms & Policy — you may close this and check \u201cI agree.\u201d";
  }
}

/** Drives the auto-scroll every animation frame while the modal is
 *  open: computes elapsed time since this open began (added to
 *  whatever was already used up in earlier opens), maps that onto a
 *  0..1 ratio of the admin's total duration, and sets scrollTop to that
 *  same ratio of the scrollable content. Reaching ratio 1 — which can
 *  only happen once the full duration has elapsed — satisfies both the
 *  timer and the "reached the bottom" requirement together. */
function _termsAutoScrollTick(bodyEl) {
  const elapsedThisOpen = (performance.now() - termsOpenedAtMs) / 1000;
  const effectiveSecondsLeft = Math.max(0, termsSecondsLeftAtOpen - elapsedThisOpen);
  const shownSecondsLeft = Math.ceil(effectiveSecondsLeft);
  if (shownSecondsLeft !== termsSecondsLeft) {
    termsSecondsLeft = shownSecondsLeft;
    _termsUpdateTimerDisplay();
  }

  const total = termsTotalSeconds || 1;
  const linearRatio = Math.min(1, Math.max(0, 1 - effectiveSecondsLeft / total));
  const ratio = _termsEase(linearRatio);
  const maxScrollable = Math.max(0, bodyEl.scrollHeight - bodyEl.clientHeight);
  bodyEl.scrollTop = ratio * maxScrollable;

  if (effectiveSecondsLeft <= 0) {
    termsSecondsLeft = 0;
    termsHasScrolledToBottom = true;
    _termsUpdateTimerDisplay();
    termsAutoScrollRAF = null;
    return;
  }

  termsAutoScrollRAF = requestAnimationFrame(() => _termsAutoScrollTick(bodyEl));
}

/** Freeze the auto-scroll and countdown exactly where they are — used
 *  when the member taps anywhere on screen to pause their reading. */
function _termsPauseAutoScroll() {
  if (termsAutoScrollRAF) { cancelAnimationFrame(termsAutoScrollRAF); termsAutoScrollRAF = null; }
  termsPaused = true;
  _termsUpdateTimerDisplay();
}

/** Pick the auto-scroll back up from wherever it was paused. Reuses the
 *  same "snapshot secondsLeft, restart the clock from now" trick used
 *  when reopening the modal after a previous close. */
function _termsResumeAutoScroll() {
  if (!termsPaused || termsSecondsLeft <= 0) return;
  const body = document.getElementById('terms-modal-body');
  if (!body) return;
  termsPaused = false;
  termsSecondsLeftAtOpen = termsSecondsLeft;
  termsOpenedAtMs = performance.now();
  _termsAutoScrollTick(body);
}

/** Tap-anywhere-on-screen handler — toggles pause/resume while the
 *  countdown is still running. No-op once the read gate is already
 *  satisfied, since there's nothing left to pause. */
function _termsToggleAutoScrollPause() {
  if (termsSecondsLeft === null || termsSecondsLeft <= 0) return;
  if (termsPaused) _termsResumeAutoScroll();
  else _termsPauseAutoScroll();
}

/** Open the Terms & Policy modal from registration. The content
 *  auto-scrolls itself over the admin-configured read time (accumulated
 *  across opens/closes) and the "I agree" checkbox only unlocks once
 *  that auto-scroll has actually reached the bottom — then the member
 *  closes the modal (✕ button or backdrop click) — so there's no way to
 *  reach "agree" without the full duration having elapsed. */
function openTermsModal() {
  openModal('terms-modal');
  const modal = document.getElementById('terms-modal');
  const body = document.getElementById('terms-modal-body');
  const checkbox = document.getElementById('reg-terms-check');
  const hint = document.getElementById('reg-terms-hint');
  if (!modal) return;

  if (termsSecondsLeft === null) {
    const configured = parseInt(modal.dataset.readSeconds, 10);
    // 30 seconds is the enforced minimum, even if an older/lower value is stored.
    termsSecondsLeft = termsTotalSeconds = Math.max(30, Number.isFinite(configured) && configured > 0 ? configured : 30);
  }
  _termsUpdateTimerDisplay();

  if (body && termsSecondsLeft > 0) {
    // The member isn't driving this scroll, so don't let stray wheel/
    // touch/keyboard input fight the auto-scroll while it's running.
    body.style.overflowY = 'hidden';
    termsSecondsLeftAtOpen = termsSecondsLeft;
    // Deferred a frame so scrollHeight/clientHeight reflect real
    // post-layout geometry instead of racing the modal's
    // display:none -> display:flex switch.
    requestAnimationFrame(() => {
      termsOpenedAtMs = performance.now();
      if (termsAutoScrollRAF) cancelAnimationFrame(termsAutoScrollRAF);
      _termsAutoScrollTick(body);
    });
  } else if (body) {
    // Time's already up from an earlier open — let the member freely
    // scroll back through the content to re-read it.
    body.style.overflowY = 'auto';
  }

  // Let the member tap/click anywhere on screen — the overlay spans the
  // full viewport while open — to pause and resume their reading, bound
  // once and reused across every open of this same modal instance.
  if (!modal.dataset.pauseBound) {
    modal.dataset.pauseBound = '1';
    modal.addEventListener('click', e => {
      if (e.target.closest('#terms-modal-close')) return;
      _termsToggleAutoScrollPause();
    });
  }

  const observer = new MutationObserver(() => {
    if (!modal.classList.contains('open')) {
      if (termsAutoScrollRAF) { cancelAnimationFrame(termsAutoScrollRAF); termsAutoScrollRAF = null; }
      termsPaused = false;
      if (body) body.style.overflowY = 'auto';
      if (termsSecondsLeft <= 0 && termsHasScrolledToBottom) {
        if (checkbox) checkbox.disabled = false;
        if (hint) hint.style.display = 'none';
      } else if (hint) {
        hint.textContent = `Please reopen and let it finish reading — ${_termsFormatTime(termsSecondsLeft)} left — before you can agree.`;
        hint.style.display = 'block';
      }
      observer.disconnect();
    }
  });
  observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
}

/** Hard safety net for the Terms & Policy gate, wired up once on page
 *  load. Two problems this guards against, on top of the modal-close
 *  check above:
 *   1. A stale "checked + enabled" checkbox restored by the browser's
 *      back/forward cache after a real reload — the disabled attribute
 *      in the HTML resets, but a prior enable/check from JS can survive
 *      in a frozen page state.
 *   2. Any other path (devtools, extensions, a future bug) that flips
 *      the checkbox on before the gate is actually satisfied.
 *  It force-resets the checkbox to disabled+unchecked on load, and on
 *  every change event re-verifies the real gate state (elapsed time +
 *  scrolled-to-bottom) before allowing the check to stand — instantly
 *  reverting it otherwise. */
function _initTermsGateGuard() {
  const checkbox = document.getElementById('reg-terms-check');
  if (!checkbox) return;

  checkbox.disabled = true;
  checkbox.checked = false;

  checkbox.addEventListener('change', () => {
    const satisfied = termsSecondsLeft !== null && termsSecondsLeft <= 0 && termsHasScrolledToBottom;
    if (checkbox.checked && !satisfied) {
      checkbox.checked = false;
      checkbox.disabled = true;
      const hint = document.getElementById('reg-terms-hint');
      if (hint) {
        hint.textContent = 'Please open and read the Terms & Policy before agreeing.';
        hint.style.display = 'block';
      }
    }
  });
}

/** Show the "please wait, submitting..." overlay while a slow request
 *  (plan request, payment submission, etc.) is in flight, so a slow
 *  connection doesn't make the page look frozen. Call hideLoadingOverlay()
 *  once the request settles (success or error) — always in a .finally()
 *  or in both the success and error branches, so it never gets stuck open. */
function showLoadingOverlay(message) {
  const el = document.getElementById('loading-overlay');
  const textEl = document.getElementById('loading-overlay-text');
  if (textEl) textEl.textContent = message || 'Please wait...';
  if (el) el.classList.add('open');
}

/** Hide the "please wait..." overlay opened by showLoadingOverlay(). */
function hideLoadingOverlay() {
  const el = document.getElementById('loading-overlay');
  if (el) el.classList.remove('open');
}

/** Payment verification (used by admin) — calls the real backend endpoint */
function verifyPayment(btn, action) {
  const card = btn.closest('.verify-card');
  if (!card) return;

  const paymentId = card.dataset.paymentId;
  if (!paymentId) { showToast('Missing payment reference — cannot verify.', 'error'); return; }

  const buttons = card.querySelectorAll('button');
  buttons.forEach(b => b.disabled = true);

  // If this card has a staff-facing "confirm student discount" checkbox
  // (shown for Half Month/Monthly/Yearly plan requests awaiting plan approval),
  // send its checked state so the backend can (re)apply the discount based
  // on what staff actually confirmed, not just the member's self-report.
  const studentCheck = card.querySelector('.verify-student-check');
  const body = { action };
  if (studentCheck) body.is_student = studentCheck.checked ? '1' : '0';

  fetch(`/admin/verify-payment/${paymentId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (!ok || !data.success) {
        if (data.stale) {
          // This card is out of date (already handled by someone else, or
          // already moved on to the next stage) — just remove it quietly
          // rather than leaving disabled buttons and a scary red toast.
          showToast(data.error || 'This request has already moved on.', 'info');
          card.style.transition = 'opacity 0.25s ease';
          card.style.opacity = '0';
          setTimeout(() => card.remove(), 250);
          return;
        }
        showToast(data.error || 'Failed to process payment.', 'error');
        buttons.forEach(b => b.disabled = false);
        return;
      }

      const badge = card.querySelector('.badge');
      if (badge) {
        if (data.status === 'verified') {
          badge.className   = 'badge badge-green';
          badge.textContent = 'Approved ✓';
        } else if (data.status === 'approved') {
          badge.className   = 'badge badge-gold';
          badge.textContent = 'Plan Approved — Awaiting Payment';
        } else {
          badge.className   = 'badge badge-red';
          badge.textContent = 'Rejected ✗';
        }
      }
      buttons.forEach(b => b.remove());
      showToast(data.message, data.status === 'rejected' ? 'error' : 'success');
      // Reload so the card moves out of Pending Verifications and the
      // newly-verified payment appears in Payment History below.
      setTimeout(() => window.location.reload(), 900);
    })
    .catch(() => {
      showToast('Could not reach the server. Please try again.', 'error');
      buttons.forEach(b => b.disabled = false);
    });
}

/** Change password (used by admin/staff/member sidebars) — calls the real backend endpoint */
function submitChangePassword() {
  const currentEl = document.getElementById('cp-current');
  const newEl     = document.getElementById('cp-new');
  const confirmEl = document.getElementById('cp-confirm');

  const current_password = currentEl?.value || '';
  const new_password     = newEl?.value     || '';
  const confirm_password = confirmEl?.value || '';

  if (!current_password || !new_password || !confirm_password) {
    showToast('Please fill in all fields.', 'error');
    return;
  }
  if (new_password.length < 8) {
    showToast('New password must be at least 8 characters.', 'error');
    return;
  }
  if (new_password !== confirm_password) {
    showToast('New password and confirmation do not match.', 'error');
    return;
  }

  const btn = document.getElementById('cp-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'SAVING...'; }

  fetch('/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password, new_password, confirm_password })
  })
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (btn) { btn.disabled = false; btn.textContent = 'SAVE PASSWORD'; }
      if (!ok || !data.success) {
        showToast(data.error || 'Failed to change password.', 'error');
        return;
      }
      [currentEl, newEl, confirmEl].forEach(el => { if (el) el.value = ''; });
      showToast(data.message || 'Password changed successfully.', 'success');
    })
    .catch(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'SAVE PASSWORD'; }
      showToast('Could not reach the server. Please try again.', 'error');
    });
}

/** Update personal information (used by the Settings tab on admin/staff/member dashboards)
 *  — calls the real backend endpoint and refreshes the sidebar on success. */
function submitProfileUpdate() {
  const first_name     = _val('pi-fname');
  const middle_initial = _val('pi-mi');
  const last_name      = _val('pi-lname');
  const extension_name = _val('pi-ext');
  const email          = _val('pi-email');
  const phone          = _val('pi-phone');
  const birthday       = document.getElementById('pi-bday')?.value || '';

  if (!first_name || !last_name || !email) {
    showToast('First name, last name, and email are required.', 'error');
    return;
  }
  if (!/^[A-Za-z\s'-]+$/.test(first_name) || !/^[A-Za-z\s'-]+$/.test(last_name)) {
    showToast('Names can only contain letters — no numbers.', 'error');
    return;
  }
  if (phone && !/^09\d{9}$/.test(phone)) {
    showToast('Phone number must start with 09 and be exactly 11 digits.', 'error');
    return;
  }

  const btn = document.querySelector('#pi-fname')?.closest('.panel')?.querySelector('.btn-red');
  if (btn) { btn.disabled = true; btn.textContent = 'SAVING...'; }

  fetch('/update-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name, middle_initial, last_name, extension_name, email, phone, birthday })
  })
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (btn) { btn.disabled = false; btn.textContent = 'SAVE CHANGES'; }
      if (!ok || !data.success) {
        showToast(data.error || 'Failed to update profile.', 'error');
        return;
      }

      const nameEl   = document.getElementById('sidebar-user-name');
      const emailEl  = document.getElementById('sidebar-user-email');
      const avatarEl = document.getElementById('sidebar-user-avatar');
      if (nameEl)   nameEl.textContent   = data.user.name;
      if (emailEl)  emailEl.textContent  = data.user.email;
      if (avatarEl) avatarEl.textContent = data.user.initials;

      showToast(data.message || 'Profile updated successfully.', 'success');
    })
    .catch(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'SAVE CHANGES'; }
      showToast('Could not reach the server. Please try again.', 'error');
    });
}

/** Submit the login form (used by the "ACCESS SYSTEM" button on the
 *  landing page's login overlay) via fetch instead of a normal form
 *  POST, so a wrong password just shows a toast and the visitor never
 *  leaves the landing page. Falls back gracefully: if this never runs
 *  (JS disabled), the form's normal action/method still posts to
 *  /login and the server redirects back to the landing page. */
/** Show an error inline inside the login card's flash box — the same
 *  red bordered message the server-rendered flash uses — instead of
 *  (or in addition to) a floating toast, so a failed sign-in looks
 *  exactly like the rest of the form's validation states. */
function _showLoginError(msg) {
  const box = document.getElementById('login-flash');
  if (!box) { showToast(msg, 'error'); return; }
  const div = document.createElement('div');
  div.className = 'flash error';
  div.textContent = msg;
  box.innerHTML = '';
  box.appendChild(div);
}
function _clearLoginError() {
  const box = document.getElementById('login-flash');
  if (box) box.innerHTML = '';
}

function completeLogin() {
  const email    = _val('login-email');
  const password = document.getElementById('login-pass')?.value || '';

  _clearLoginError();

  if (!email || !password) {
    _showLoginError('Please enter both email and password.');
    return;
  }

  const btn = document.querySelector('#screen-login .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'SIGNING IN...'; }

  fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ email, password })
  })
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (!ok || !data.success) {
        if (btn) { btn.disabled = false; btn.textContent = 'ACCESS SYSTEM'; }
        if (data.needs_verification) {
          // Right password, but the email was never verified — send them to the
          // code screen and make sure a valid code is on its way.
          showVerifyScreen({ email: data.email || email, masked: data.email_masked });
          resendVerifyOtp(true);
          return;
        }
        _showLoginError(data.error || 'An error occurred. Please try again.');
        return;
      }
      // Full navigation on success is expected — it's leaving the
      // landing page for the member/staff/admin dashboard.
      window.location.href = data.redirect;
    })
    .catch(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'ACCESS SYSTEM'; }
      _showLoginError('An error occurred. Please try again.');
    });
}

/** Close whichever auth overlay (login/register) is open on the landing
 *  page and return to the marketing content underneath. */
function closeAuthScreen() {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
}

/** The cropped profile-picture Blob awaiting submission, set by
 *  previewProfilePicture() below once the member confirms their crop.
 *  completeRegistration() sends this in place of the raw file. */
let _regProfilePictureBlob = null;
let _regProfilePictureName = null;

/** Live preview + client-side validation for the mandatory registration
 *  profile picture (reg-profile-picture). Opens the crop step so the
 *  member can reposition/zoom before it's saved, then swaps the camera
 *  icon for the cropped result and flags the circle as filled. */
function previewProfilePicture(input) {
  const file = input.files && input.files[0];
  const circle   = document.getElementById('pfp-upload-circle');
  const icon     = document.getElementById('pfp-upload-icon');
  const preview  = document.getElementById('pfp-upload-preview');
  const filename = document.getElementById('pfp-upload-filename');
  if (!file) return;

  const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    showToast('Profile picture must be a PNG, JPG, JPEG, or WEBP file.', 'error');
    input.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('Profile picture must be smaller than 5MB.', 'error');
    input.value = '';
    return;
  }

  openImageCropper(file, (blob, blobName) => {
    _regProfilePictureBlob = blob;
    _regProfilePictureName = blobName;
    const previewUrl = URL.createObjectURL(blob);
    if (preview) { preview.src = previewUrl; preview.style.display = 'block'; }
    if (icon) icon.style.display = 'none';
    if (circle) circle.classList.add('has-image');
    if (filename) filename.textContent = file.name;
  }, () => {
    // Cancelled the crop — treat it as if nothing was ever picked.
    input.value = '';
  });
}

/** Single source of truth for what makes a birthday acceptable — shared
 *  by the live field validation below and the submit-time check in
 *  completeRegistration(), so the rules can never drift apart. Returns
 *  an error string, or null if the birthday is fine.
 *  Members must be at least MIN_REGISTRATION_AGE (15) — this mirrors the
 *  server-side /register check. */
const MIN_REGISTRATION_AGE = 15;

/** Latest birthday (YYYY-MM-DD) that still makes someone 15 today. */
function _latestAllowedBirthday() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - MIN_REGISTRATION_AGE);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function _birthdayErrorMessage(birthdayStr) {
  if (!birthdayStr) return 'Please enter your birthday.';
  const bday = new Date(birthdayStr + 'T00:00:00');
  if (isNaN(bday.getTime())) return 'Please enter a valid birthday.';
  if (bday > new Date()) return 'Birthday cannot be in the future.';
  if (birthdayStr > _latestAllowedBirthday()) {
    return 'You must be at least ' + MIN_REGISTRATION_AGE + ' years old to create an account.';
  }
  return null;
}

/** Runs live as the member types/picks a birthday (not just on submit) —
 *  typing a date directly into a date input bypasses the browser's native
 *  min/max picker restrictions, so this is what actually catches that. */
function validateBirthdayField() {
  const input = document.getElementById('reg-bday');
  const hint  = document.getElementById('reg-bday-hint');
  const submitBtn = document.getElementById('reg-submit-btn');
  if (!input) return true;
  input.max = _latestAllowedBirthday(); // date picker won't offer under-15 dates

  const error = _birthdayErrorMessage(input.value);
  if (error) {
    input.classList.add('field-error');
    if (hint) { hint.textContent = error; hint.style.color = 'var(--red)'; }
    if (submitBtn) submitBtn.disabled = true;
    return false;
  }
  input.classList.remove('field-error');
  if (hint) { hint.textContent = ''; }
  if (submitBtn) submitBtn.disabled = false;
  return true;
}

/** Submit the member self-registration form (used by trmem.html's
 *  "SUBMIT REGISTRATION" button) — validates client-side, posts to the
 *  real /register endpoint, then drops the member back on the login
 *  screen with their email pre-filled. */
function completeRegistration() {
  const first_name     = _val('reg-fname');
  const middle_initial = _val('reg-mi');
  const last_name      = _val('reg-lname');
  const extension_name = document.getElementById('reg-ext')?.value || '';
  const email          = _val('reg-email');
  const phone          = _val('reg-phone');
  const birthday       = document.getElementById('reg-bday')?.value || '';
  const emergencyNumber = _val('reg-emergency-phone');
  const emergencyRel    = _emergencyRelationship();
  const password       = document.getElementById('reg-pass')?.value || '';
  const confirm        = document.getElementById('reg-confirm')?.value || '';
  const termsChecked   = document.getElementById('reg-terms-check')?.checked;

  if (!_regProfilePictureBlob) {
    showToast('Please upload a profile picture to create your account.', 'error');
    return;
  }
  if (!first_name || !last_name || !email || !password) {
    showToast('Please fill in all required fields.', 'error');
    return;
  }
  if (!birthday) {
    showToast('Please enter your birthday.', 'error');
    return;
  }
  const birthdayError = _birthdayErrorMessage(birthday);
  if (birthdayError) {
    showToast(birthdayError, 'error');
    validateBirthdayField();
    return;
  }
  if (phone && !/^09\d{9}$/.test(phone)) {
    showToast('Phone number must start with 09 and be exactly 11 digits.', 'error');
    return;
  }
  if (!emergencyNumber || !emergencyRel) {
    showToast(_val('reg-emergency-rel') === 'Other' && !emergencyRel
      ? 'Please specify the emergency contact relationship.'
      : 'Please enter an emergency contact number and relationship.', 'error');
    return;
  }
  if (!/^09\d{9}$/.test(emergencyNumber)) {
    showToast('Emergency contact number must start with 09 and be exactly 11 digits.', 'error');
    return;
  }
  if (password.length < 8) {
    showToast('Password must be at least 8 characters.', 'error');
    return;
  }
  if (password !== confirm) {
    showToast('Passwords do not match.', 'error');
    return;
  }
  if (!termsChecked) {
    showToast('Please open and agree to the Terms & Policy before registering.', 'error');
    return;
  }

  const btn = document.getElementById('reg-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'SUBMITTING...'; }

  // multipart/form-data — required since a profile picture file now rides
  // along with the text fields. Don't set a Content-Type header manually;
  // the browser fills in the correct multipart boundary itself.
  const formData = new FormData();
  formData.append('first_name', first_name);
  formData.append('middle_initial', middle_initial);
  formData.append('last_name', last_name);
  formData.append('extension_name', extension_name);
  formData.append('email', email);
  formData.append('phone', phone);
  formData.append('birthday', birthday);
  formData.append('emergency_contact_number', emergencyNumber);
  formData.append('emergency_contact_relationship', emergencyRel);
  formData.append('password', password);
  formData.append('profile_picture', _regProfilePictureBlob, _regProfilePictureName);

  fetch('/register', {
    method: 'POST',
    body: formData
  })
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (btn) { btn.disabled = false; btn.textContent = 'SUBMIT REGISTRATION'; }
      if (!ok || !data.success) {
        showToast(data.error || 'Registration failed. Please try again.', 'error');
        return;
      }
      // Account is created but NOT active yet — the member must enter the code we
      // just emailed. (The form keeps its values so "Change email" can edit them.)
      if (data.needs_verification) {
        showToast('We sent a 6-digit code to ' + (data.email_masked || email) + '.', 'success');
        showVerifyScreen({ email: data.email || email, masked: data.email_masked,
                           expiresIn: data.expires_in, resendIn: data.resend_in });
        return;
      }
      showToast(data.message || 'Account created! Sign in to continue.', 'success');
      _regProfilePictureBlob = null;
      _regProfilePictureName = null;
      if (window.TrRegDraft) window.TrRegDraft.clear();
      const loginEmail = document.getElementById('login-email');
      if (loginEmail) loginEmail.value = email;
      goTo('login');
    })
    .catch(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'SUBMIT REGISTRATION'; }
      showToast('Could not reach the server. Please try again.', 'error');
    });
}

/** Plan card selection (generic — used on register page and member renewal) */
function selectPlan(card, plan) {
  // Scope to the nearest plan-grid parent to avoid cross-section conflicts
  const grid = card.closest('.plan-grid');
  if (grid) grid.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');
}

/** Live role hint as the visitor types their email on the login overlay.
 *  Asks the server (/api/detect-role) which role the email really belongs to,
 *  so real admin/staff accounts from the database are recognised. (The old
 *  client-side guess only knew two hardcoded demo emails and labelled every
 *  other address as a member.) Debounced, and stale responses are ignored so
 *  a slow reply for an earlier keystroke can't overwrite the latest one. */
let _roleHintTimer = null;
let _roleHintSeq   = 0;
function detectRoleHint() {
  const email = _val('login-email');
  clearTimeout(_roleHintTimer);
  const seq = ++_roleHintSeq;

  // Not a plausible email yet — reset to the neutral default straight away.
  if (!email || !email.includes('@') || email.length < 4) {
    Navigation.showRoleHint(null);
    return;
  }

  _roleHintTimer = setTimeout(() => {
    fetch('/api/detect-role?email=' + encodeURIComponent(email))
      .then(res => res.json())
      .then(data => {
        if (seq !== _roleHintSeq) return;   // a newer keystroke superseded this
        Navigation.showRoleHint(data && data.role ? data.role : null);
      })
      .catch(() => {
        if (seq === _roleHintSeq) Navigation.showRoleHint(null);
      });
  }, 250);
}

/** Toggle a password input between hidden (••••) and visible (plain text).
 *  Expects the button to live inside a .password-field wrapper alongside the input. */
function togglePasswordVisibility(btn) {
  const wrapper = btn.closest('.password-field');
  if (!wrapper) return;
  const input = wrapper.querySelector('input');
  if (!input) return;

  const willShow = input.type === 'password';
  input.type = willShow ? 'text' : 'password';
  wrapper.classList.toggle('revealed', willShow);
  btn.setAttribute('aria-label', willShow ? 'Hide password' : 'Show password');
}
function doLogout() {
  window.location.href = '/logout';
}

// ── Private shared helpers (not exported globally) ──
function _injectSidebarUser(session) {
  if (!session) return;
  const nameEl   = document.getElementById('sidebar-user-name');
  const emailEl  = document.getElementById('sidebar-user-email');
  const avatarEl = document.getElementById('sidebar-user-avatar');

  if (nameEl)   nameEl.textContent   = session.name;
  if (emailEl)  emailEl.textContent  = session.email;
  if (avatarEl) avatarEl.textContent = session.initials;
}

function _bindModalBackdrops() {
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });
}

function _val(id) {
  return document.getElementById(id)?.value.trim() || '';
}

/** Shows the "Please specify" box only when the member picks "Other" as
 *  their emergency-contact relationship. */
function toggleRelationshipOther() {
  const sel   = document.getElementById('reg-emergency-rel');
  const other = document.getElementById('reg-emergency-rel-other');
  if (!sel || !other) return;
  const isOther = sel.value === 'Other';
  other.style.display = isOther ? '' : 'none';
  if (isOther) other.focus(); else other.value = '';
}
window.toggleRelationshipOther = toggleRelationshipOther;

/** The relationship to send: the dropdown choice, or the typed text when
 *  "Other" is selected. */
function _emergencyRelationship() {
  const sel = _val('reg-emergency-rel');
  return sel === 'Other' ? _val('reg-emergency-rel-other') : sel;
}


/* ════════════════════════════════════════════════
   4b. CONTENT MANAGER — Manage Gym Content
   NOTE: This is dashboard-only functionality (staff/admin manage
   plans, services, equipment) and isn't used on the login/register
   screen at all. The real ContentManager already lives in
   tr-common.js — it used to be duplicated here too, which is what
   caused the "Identifier 'ContentManager' has already been declared"
   SyntaxError that broke this whole file. Removed.
════════════════════════════════════════════════ */


/* ════════════════════════════════════════════════
   5. TOAST SYSTEM
   showToast() and the announcement-notice functions below reuse the
   `_announcementNoticeQueue` / `_announcementNoticeTotal` state that
   tr-common.js already declares with `let` — deliberately NOT
   redeclared here, since that's exactly what caused this file to
   fail to load in the first place (see header comment).
════════════════════════════════════════════════ */
function showNewAnnouncementNotices(items) {
  if (!items || !items.length) return;
  _announcementNoticeQueue = items.slice();
  _announcementNoticeTotal = items.length;
  _renderAnnouncementNotice();
}

function _renderAnnouncementNotice() {
  if (!_announcementNoticeQueue.length) return;
  const item = _announcementNoticeQueue[0];
  const idx  = _announcementNoticeTotal - _announcementNoticeQueue.length + 1;

  const titleEl   = document.getElementById('announcement-notice-title');
  const bodyEl    = document.getElementById('announcement-notice-body');
  const counterEl = document.getElementById('announcement-notice-counter');
  const btnEl     = document.getElementById('announcement-notice-btn');

  if (titleEl)   titleEl.textContent   = item.title;
  if (bodyEl)    bodyEl.textContent    = item.body;
  if (counterEl) counterEl.textContent = _announcementNoticeTotal > 1 ? `Notice ${idx} of ${_announcementNoticeTotal}` : '';
  if (btnEl)     btnEl.textContent     = _announcementNoticeQueue.length > 1 ? 'NEXT' : 'OK';

  openModal('announcement-notice-modal');
}

/** "OK" / "NEXT" / "✕" on the notice popup — advance to the next queued
 *  notice, or close once they've all been shown. */
function closeAnnouncementNoticeModal() {
  _announcementNoticeQueue.shift();
  if (_announcementNoticeQueue.length) {
    _renderAnnouncementNotice();
  } else {
    closeModal('announcement-notice-modal');
  }
}


/* ════════════════════════════════════════════════
   6. COMMON INIT — always-available globals
   Page-specific scripts (tr-login.js / tr-admin.js /
   tr-staff.js / tr-member.js) add their own
   DOMContentLoaded listeners on top of this one.
════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  _initTermsGateGuard();
  window.openModal     = openModal;
  window.closeModal    = closeModal;
  window.openTermsModal = openTermsModal;
  window.showToast     = showToast;
  window.showNewAnnouncementNotices = showNewAnnouncementNotices;
  window.closeAnnouncementNoticeModal = closeAnnouncementNoticeModal;
  window.buildAttGrid  = buildAttGrid;
  window.doLogout      = doLogout;
  window.verifyPayment = verifyPayment;
  window.submitChangePassword = submitChangePassword;
  window.submitProfileUpdate  = submitProfileUpdate;
  window.completeRegistration = completeRegistration;
  window.validateBirthdayField = validateBirthdayField;
  window.previewProfilePicture = previewProfilePicture;
  window.completeLogin  = completeLogin;
  window.closeAuthScreen = closeAuthScreen;
  window.detectRoleHint = detectRoleHint;
  window.filterTable   = filterTable;
  window.togglePasswordVisibility = togglePasswordVisibility;
  window.ContentManager = ContentManager;
  window.goTo          = (screen) => Navigation.goToScreen(screen);
  // selectPlan is re-assigned per page (login/member) where relevant; keep a fallback
  if (!window.selectPlan) window.selectPlan = selectPlan;
});


/* ════════════════════════════════════════════════
   7. REGISTRATION REFRESH-PERSISTENCE
   Refreshing used to throw the member back to the Member Login screen
   and wipe everything typed into "Personal Information". This keeps, for
   the current browser tab only (sessionStorage — gone when the tab is
   closed): which screen is open, the typed fields, and the cropped
   profile picture. Passwords and the Terms & Policy checkbox are
   deliberately NEVER stored — the member re-enters passwords and
   re-reads the terms (the read-timer gate) after a refresh.
════════════════════════════════════════════════ */
(function () {
  const KEY    = 'tr_reg_draft_v1';
  const FIELDS = ['reg-fname', 'reg-mi', 'reg-lname', 'reg-ext', 'reg-email', 'reg-phone', 'reg-bday', 'reg-emergency-phone', 'reg-emergency-rel', 'reg-emergency-rel-other'];

  function _read() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null') || {}; }
    catch (e) { return {}; }
  }
  function _write(patch) {
    try { sessionStorage.setItem(KEY, JSON.stringify(Object.assign(_read(), patch))); }
    catch (e) { /* storage full/unavailable — skip silently */ }
  }
  function _clear() {
    try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }
  window.TrRegDraft = { clear: _clear };

  function _activeScreen() {
    const el = document.querySelector('.screen.active');
    return el && el.id ? el.id.replace(/^screen-/, '') : null;
  }

  function _snapshotFields() {
    const vals = {};
    FIELDS.forEach(id => { const el = document.getElementById(id); vals[id] = el ? el.value : ''; });
    return vals;
  }

  function _showScreen(name) {
    if (typeof window.showAuthScreen === 'function') window.showAuthScreen(name);   // landing page overlay
    else if (typeof Navigation !== 'undefined') Navigation.goToScreen(name);         // trmem.html
  }

  /* ── profile picture <-> data URL ── */
  function _blobToDataUrl(blob, cb) {
    const r = new FileReader();
    r.onload = () => cb(r.result);
    r.onerror = () => cb(null);
    r.readAsDataURL(blob);
  }
  function _dataUrlToBlob(url) {
    const [head, b64] = url.split(',');
    const mime = (head.match(/data:(.*?);base64/) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  let _restoringPicture = false;

  function _restorePicture(pfp) {
    try {
      if (!pfp || !pfp.data) return;
      const blob = _dataUrlToBlob(pfp.data);
      _regProfilePictureBlob = blob;
      _regProfilePictureName = pfp.name || 'profile.jpg';
      const preview  = document.getElementById('pfp-upload-preview');
      const icon     = document.getElementById('pfp-upload-icon');
      const circle   = document.getElementById('pfp-upload-circle');
      const filename = document.getElementById('pfp-upload-filename');
      _restoringPicture = true;
      if (preview) { preview.src = URL.createObjectURL(blob); preview.style.display = 'block'; }
      if (icon) icon.style.display = 'none';
      if (circle) circle.classList.add('has-image');
      if (filename) filename.textContent = pfp.filename || '';
      setTimeout(() => { _restoringPicture = false; }, 0);
    } catch (e) { /* bad data — ignore, member just re-uploads */ }
  }

  function _restore() {
    const d = _read();
    if (d.screen !== 'register' || !document.getElementById('screen-register')) return;

    _showScreen('register');
    const vals = d.fields || {};
    FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (el && typeof vals[id] === 'string') el.value = vals[id];
    });
    const bday = document.getElementById('reg-bday');
    if (bday) bday.dispatchEvent(new Event('input', { bubbles: true })); // re-run birthday note
    const relSel = document.getElementById('reg-emergency-rel');
    const relOther = document.getElementById('reg-emergency-rel-other');
    if (relSel && relOther) relOther.style.display = relSel.value === 'Other' ? '' : 'none';
    _restorePicture(d.pfp);
  }

  function _track() {
    // typed fields
    FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      ['input', 'change'].forEach(evt => el.addEventListener(evt, () => _write({ fields: _snapshotFields() })));
    });

    // which screen is showing (covers goTo, Create account, Back to Login, close, etc.)
    const obs = new MutationObserver(() => _write({ screen: _activeScreen() }));
    document.querySelectorAll('.screen').forEach(el => obs.observe(el, { attributes: true, attributeFilter: ['class'] }));

    // profile picture: the cropper sets the preview <img> src when confirmed
    const preview = document.getElementById('pfp-upload-preview');
    if (preview) {
      new MutationObserver(() => {
        if (_restoringPicture || typeof _regProfilePictureBlob === 'undefined' || !_regProfilePictureBlob) return;
        const fn = document.getElementById('pfp-upload-filename');
        _blobToDataUrl(_regProfilePictureBlob, url => {
          if (url) _write({ pfp: { data: url, name: _regProfilePictureName, filename: fn ? fn.textContent : '' } });
        });
      }).observe(preview, { attributes: true, attributeFilter: ['src'] });
    }
  }

  // Refreshing the page starts registration over: nothing typed, picked or
  // uploaded is kept, and no draft is saved or restored. 'load' fires after
  // every DOMContentLoaded handler and inline script (and after the browser
  // has restored any form values it remembers), so this runs last and wins.
  const ALL_FIELDS = FIELDS.concat(['reg-pass', 'reg-confirm']);

  function _resetRegistrationForm() {
    _clear();
    ALL_FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.tagName === 'SELECT') el.selectedIndex = 0; else el.value = '';
    });
    const terms = document.getElementById('reg-terms-check');
    if (terms) terms.checked = false;
    const relOther = document.getElementById('reg-emergency-rel-other');
    if (relOther) relOther.style.display = 'none';

    // profile picture back to the empty circle
    _regProfilePictureBlob = null;
    _regProfilePictureName = null;
    const picInput = document.getElementById('reg-profile-picture');
    if (picInput) picInput.value = '';
    const preview  = document.getElementById('pfp-upload-preview');
    const icon     = document.getElementById('pfp-upload-icon');
    const circle   = document.getElementById('pfp-upload-circle');
    const filename = document.getElementById('pfp-upload-filename');
    if (preview) { preview.removeAttribute('src'); preview.style.display = 'none'; }
    if (icon) icon.style.display = '';
    if (circle) circle.classList.remove('has-image');
    if (filename) filename.textContent = '';
  }

  window.TrRegReset = _resetRegistrationForm;   // used after email verification succeeds

  window.addEventListener('load', () => {
    if (!document.getElementById('screen-register')) return;
    _resetRegistrationForm();
  });
  // Back/forward navigation can bring the page back from the browser's
  // cache with the old values still in it — wipe those too.
  window.addEventListener('pageshow', e => {
    if (e.persisted && document.getElementById('screen-register')) _resetRegistrationForm();
  });
})();

/* ════════════════════════════════════════════════
   EMAIL OTP VERIFICATION ("Verify Your Email" screen)
   Reached after registering, or when an unverified member tries to sign in.
════════════════════════════════════════════════ */
const _verify = { email: '', expiresAt: 0, resendAt: 0, timer: null, busy: false };

function _otpBoxes() { return Array.from(document.querySelectorAll('#otp-inputs .otp-box')); }
function _otpValue() { return _otpBoxes().map(b => b.value).join(''); }

function _otpClear(focus) {
  _otpBoxes().forEach(b => { b.value = ''; b.classList.remove('filled'); });
  const row = document.getElementById('otp-inputs');
  if (row) row.classList.remove('error');
  if (focus) { const first = _otpBoxes()[0]; if (first) first.focus(); }
}

function _verifyMessage(text, ok) {
  const el = document.getElementById('verify-msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function _verifyShowError(text) {
  _verifyMessage(text, false);
  const row = document.getElementById('otp-inputs');
  if (row) { row.classList.remove('error'); void row.offsetWidth; row.classList.add('error'); }
}

function _fmtClock(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/** Ticks once a second: expiry countdown + resend cooldown label. */
function _verifyTick() {
  const now = Date.now();
  const expiryEl  = document.getElementById('verify-expiry');
  const expiryRow = document.getElementById('verify-expiry-row');
  const verifyBtn = document.getElementById('verify-btn');
  const resendBtn = document.getElementById('verify-resend-btn');
  if (!expiryEl || !resendBtn) return;

  if (_verify.expiresAt) {
    const left = Math.max(0, Math.ceil((_verify.expiresAt - now) / 1000));
    expiryEl.textContent = left > 0 ? _fmtClock(left) : '00:00';
    const expired = left === 0;
    expiryRow.classList.toggle('expired', expired);
    if (expired && !_verify.expiredShown) {
      _verify.expiredShown = true;
      _verifyShowError('Code expired. Please request a new one.');
    }
    if (verifyBtn && !_verify.busy) verifyBtn.disabled = expired;
  } else {
    expiryEl.textContent = '--:--';
  }

  const wait = Math.max(0, Math.ceil((_verify.resendAt - now) / 1000));
  resendBtn.disabled = wait > 0 || _verify.busy;
  resendBtn.textContent = wait > 0 ? 'Resend code (' + wait + 's)' : 'Resend code';
}

function _verifyApplyTimers(expiresIn, resendIn) {
  const now = Date.now();
  if (typeof expiresIn === 'number') {
    _verify.expiresAt = expiresIn > 0 ? now + expiresIn * 1000 : 0;
    _verify.expiredShown = false;
  }
  if (typeof resendIn === 'number') _verify.resendAt = now + resendIn * 1000;
  _verifyTick();
}

/** Open the Verify Your Email screen for this address. */
function showVerifyScreen(opts) {
  _verify.email = opts.email;
  _verify.expiresAt = 0;
  _verify.resendAt = 0;
  _verify.expiredShown = false;
  _verify.busy = false;

  const masked = document.getElementById('verify-email-masked');
  if (masked) masked.textContent = opts.masked || opts.email;
  _otpClear(false);
  _verifyMessage('');
  const vb = document.getElementById('verify-btn');
  if (vb) { vb.disabled = false; vb.textContent = 'VERIFY'; }

  if (typeof window.showAuthScreen === 'function') window.showAuthScreen('verify');
  else if (typeof goTo === 'function') goTo('verify');

  _verifyApplyTimers(opts.expiresIn, opts.resendIn);
  clearInterval(_verify.timer);
  _verify.timer = setInterval(_verifyTick, 1000);
  setTimeout(() => { const f = _otpBoxes()[0]; if (f) f.focus(); }, 50);
}

function _verifyStopTimer() { clearInterval(_verify.timer); _verify.timer = null; }

function submitVerifyOtp() {
  if (_verify.busy) return;
  const code = _otpValue();
  if (code.length !== 6) { _verifyShowError('Please enter the 6-digit code.'); return; }

  const btn = document.getElementById('verify-btn');
  _verify.busy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'VERIFYING...'; }
  _verifyMessage('');

  fetch('/api/register/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: _verify.email, code })
  })
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      _verify.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = 'VERIFY'; }
      if (ok && data.success) {
        _verifyStopTimer();
        const email = _verify.email;
        _verifyMessage(data.message || 'Email verified!', true);
        showToast(data.message || 'Email verified! You can now sign in.', 'success');
        if (typeof window.TrRegReset === 'function') window.TrRegReset();
        setTimeout(() => {
          const loginEmail = document.getElementById('login-email');
          if (loginEmail) loginEmail.value = email;
          if (typeof window.showAuthScreen === 'function') window.showAuthScreen('login');
          else if (typeof goTo === 'function') goTo('login');
        }, 1200);
        return;
      }
      _verifyShowError(data.error || 'Invalid code.');
      if (data.code === 'invalid') {
        _otpClear(true);
        _verifyMessage(data.error || 'Invalid code.', false);
        const row = document.getElementById('otp-inputs'); if (row) row.classList.add('error');
      } else if (data.code === 'expired' || data.code === 'locked' || data.code === 'no_code') {
        if (btn) btn.disabled = true;     // needs a fresh code — Resend becomes the way forward
        if (data.code !== 'expired') _verify.expiresAt = 0;
        _verifyTick();
      }
    })
    .catch(() => {
      _verify.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = 'VERIFY'; }
      _verifyShowError('Could not reach the server. Please try again.');
    });
}

/** silent = true when called automatically after a blocked sign-in. */
function resendVerifyOtp(silent) {
  if (_verify.busy) return;
  const resendBtn = document.getElementById('verify-resend-btn');
  if (!silent && resendBtn && resendBtn.disabled) return;
  _verify.busy = true;
  if (resendBtn) resendBtn.disabled = true;

  fetch('/api/register/resend-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: _verify.email })
  })
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      _verify.busy = false;
      const vb = document.getElementById('verify-btn');
      if (ok && data.success) {
        _otpClear(true);
        _verifyApplyTimers(data.expires_in, data.resend_in);
        if (vb) vb.disabled = false;
        _verifyMessage('A new code was sent to your email.', true);
        return;
      }
      if (data.code === 'cooldown') {
        // A code was sent moments ago — just show the real timers.
        _verifyApplyTimers(data.expires_in, data.resend_in);
        if (vb) vb.disabled = !data.expires_in;
        if (!silent) _verifyShowError(data.error);
        else _verifyMessage('We already sent a code to your email.', true);
        return;
      }
      _verifyShowError(data.error || 'Could not resend the code.');
      _verifyTick();
    })
    .catch(() => {
      _verify.busy = false;
      _verifyShowError('Could not reach the server. Please try again.');
      _verifyTick();
    });
}

/** "Change email" — back to the registration form to fix the address (the
 *  form keeps what they typed; resubmitting refreshes the pending account). */
function changeVerifyEmail() {
  _verifyStopTimer();
  if (typeof window.showAuthScreen === 'function') window.showAuthScreen('register');
  else if (typeof goTo === 'function') goTo('register');
}

/** Auto-focus / auto-advance / backspace / arrows / paste, digits only. */
(function _initOtpBoxes() {
  function setup() {
    const boxes = _otpBoxes();
    if (!boxes.length) return;
    const sync = b => b.classList.toggle('filled', !!b.value);

    function fillFrom(startIdx, digits) {
      let i = startIdx;
      for (const d of digits) { if (i > 5) break; boxes[i].value = d; sync(boxes[i]); i++; }
      boxes[Math.min(i, 5)].focus();
    }

    boxes.forEach((box, idx) => {
      box.addEventListener('input', () => {
        const digits = box.value.replace(/\D/g, '');
        box.value = '';
        if (!digits) { sync(box); return; }
        fillFrom(idx, digits);          // handles typing, autofill and multi-digit input
        const row = document.getElementById('otp-inputs'); if (row) row.classList.remove('error');
        _verifyMessage('');
      });
      box.addEventListener('keydown', e => {
        if (e.key === 'Backspace') {
          if (box.value) { box.value = ''; sync(box); }
          else if (idx > 0) { boxes[idx - 1].value = ''; sync(boxes[idx - 1]); boxes[idx - 1].focus(); }
          e.preventDefault();
        } else if (e.key === 'ArrowLeft' && idx > 0) { boxes[idx - 1].focus(); e.preventDefault(); }
        else if (e.key === 'ArrowRight' && idx < 5) { boxes[idx + 1].focus(); e.preventDefault(); }
        else if (e.key === 'Enter') { submitVerifyOtp(); e.preventDefault(); }
        else if (e.key.length === 1 && !/\d/.test(e.key) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); }
      });
      box.addEventListener('paste', e => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
        if (!text) return;
        fillFrom(text.length === 6 ? 0 : idx, text);
      });
      box.addEventListener('focus', () => box.select());
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();