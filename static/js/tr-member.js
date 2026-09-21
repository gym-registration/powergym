/* ═══════════════════════════════════════════════════════════════
   POWER GYM — Member Dashboard
   tr-member.js  |  Runs on member-dashboard.html only

   Requires tr-common.js to be loaded first (Session, Navigation,
   showToast, showLoadingOverlay/hideLoadingOverlay, openModal/closeModal,
   _injectSidebarUser, _bindModalBackdrops, _val, buildAttGrid,
   showNewAnnouncementNotices).

   Rebuilt from scratch on 2026-09-03 after the deployed copy of this
   file was found to actually contain trmem.html's markup instead of
   JavaScript (see chat history) — every onclick/onchange handler
   referenced by member-dashboard.html is wired here, matching the
   real request/response shapes used by app.py.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const MemberModule = (() => {

  // ── State ──
  let _plansByKey     = {};   // key -> {key,name,price,duration_days,description,inclusions,image_path}
  let _promosList     = [];   // index-ordered list of {title,price,period,description,inclusions,valid_until}
  let _servicesById   = {};   // id  -> {id,name,description,image_path,category,icon,equipment:[{name,icon}]}
  let _equipmentById  = {};   // id  -> {id,name,description,image_path,category,icon} — used by the machine "how-to-use" guide modal
  let _exercisesById  = {};   // id  -> exercise object (populated when the weekly routine renders)

  let _selectedPlanKey   = null;
  let _selectedPromoIndex = null; // index into _promosList of the currently-availed promo, or null
  let _promoSelected      = false; // true while a promo card is availed — student discount question hides while this is true
  let _pendingPlanRequest = null; // { formData } staged between submitRenewalPayment() and confirmPlanRequest()
  let _pendingPaymentMethod = null; // { formData } staged between submitPaymentMethod() and confirmSubmitPayment()
  let _withdrawPaymentId = null;


  // Post-membership feedback wizard (#feedback-modal) staged state — held
  // here rather than read fresh off the DOM at submit time so a star pick
  // on step 1 survives navigating to step 2 and back.
  let _feedbackRating = 0;
  let _feedbackRecommend = null; // true | false | null (not answered yet)

  // Reference number OCR reads off each attached GCash screenshot (slot 1/2/3
  // -> string or null), kept purely so a newly-picked screenshot can be
  // compared against the others already attached. Lets the member know
  // right away if they picked the same receipt twice, instead of only
  // finding out after they hit Submit. See _checkGcashDuplicateScreenshot().
  let _gcashSlotReference = { 1: null, 2: null, 3: null };

  // The member's picked school-ID photos. Tracked here (not just read off
  // the <input>) because choosing a file clears whatever was already in a
  // native <input type="file">, so re-selecting to add/redo just one side
  // would otherwise wipe the other. See previewStudentId() below.
  let _studentIdFrontFile = null;
  let _studentIdBackFile  = null;

  let _fitnessGoal = null; // currently-selected goal in the Step 2 grid ('CUT'|'BULK'|'MAINTAIN'|'RECOMP')


  let _primaryObjective   = 'MAINTAIN'; // 'CUT' | 'BULK' | 'MAINTAIN' | 'RECOMP'


  // Attendance calendar month navigation state
  let _attYear = null;
  let _attMonth = null;
  let _attCurrentYear = null;  // the real "today" month — never navigate past this
  let _attCurrentMonth = null;

  const OBJECTIVE_LABELS = {
    CUT:      'Cut / Fat Loss',
    BULK:     'Bulk / Muscle Mass',
    MAINTAIN: 'Maintain & Tone',
    RECOMP:   'Body Recomposition',
  };

  const ACTIVITY_LABELS = {
    low_activity:      'Low Activity',
    moderate_activity:  'Moderate Activity',
    high_activity:      'High Activity',
  };

  const GOAL_LABELS = {
    FULL_BODY: 'Full Body Workout',
    CHEST:     'Chest Workout',
    BACK:      'Back Workout',
    ARMS:      'Arm Workout',
    LEGS:      'Lower Body Workout',
    SHOULDERS: 'Shoulders Workout',
    CORE:      'Abs & Core Workout',
    // Legacy fallback
    CUT:       'Cut',
    BULK:      'Bulk',
    MAINTAIN:  'Maintain',
    RECOMP:    'Body Recomposition',
  };

  /* ── "When do you want to start?" date guard ──────────────
     Mirrors the birthday guard on registration: bounds the native date
     picker so it can't offer, or silently accept, a bogus year (e.g. a
     stray extra digit typed into the year segment — "20026" instead of
     "2026"). Range is today .. +2 years: wide enough for any real future
     start date, narrow enough to catch that kind of typo. */
  function _todayStr() {
    return new Date().toISOString().split('T')[0];
  }

  function _startDateMaxStr() {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 2);
    return d.toISOString().split('T')[0];
  }

  function _setupStartDateGuard() {
    const input = document.getElementById('member-renew-start');
    if (!input) return;
    input.min = _todayStr();
    input.max = _startDateMaxStr();
    validateStartDateField();
  }

  function isStartDateValid() {
    const input = document.getElementById('member-renew-start');
    if (!input || !input.value) return true; // emptiness is checked separately at submit time
    return input.value >= _todayStr() && input.value <= _startDateMaxStr();
  }

  /** Renders the inline error note under the start-date field as the
   *  member types/picks a value — same pattern as the registration
   *  birthday field's renderBirthdayNote(). */
  function validateStartDateField() {
    const input = document.getElementById('member-renew-start');
    const errNote = document.getElementById('member-renew-start-error');
    if (!input) return;
    const failedCheck = !!input.value && !isStartDateValid();
    if (errNote) errNote.style.display = failedCheck ? 'block' : 'none';
    input.style.borderColor = failedCheck ? '#ff4d4d' : '';
  }

  /* ── Init ─────────────────────────────────────────────── */
  function init() {
    const session = Session.guardDashboard();
    if (!session) return;

    _injectSidebarUser(session);
    document.body.classList.add('role-member');
    _bindModalBackdrops();
    Navigation.activateTab('member', 'overview', document.getElementById('nav-member-overview'));

    _setupStartDateGuard();

    // Live-validate the Amount Paid field (red = short, green = meets the
    // required amount) as the member types, not just right after OCR fills it.
    const _gcashAmountInput = document.getElementById('payment-gcash-amount');
    if (_gcashAmountInput) {
      _gcashAmountInput.addEventListener('input', _validateGcashAmountPaid);
    }
    const _gcashReferenceInput = document.getElementById('payment-gcash-reference');
    if (_gcashReferenceInput) {
      _gcashReferenceInput.addEventListener('input', _updatePaymentSubmitState);
    }
    // Auto-capitalize the Sender/Account Name once the member finishes
    // typing (blur), e.g. "juan m dela cruz" -> "Juan M. Dela Cruz".
    const _gcashSenderInput = document.getElementById('payment-gcash-sender');
    if (_gcashSenderInput) {
      _gcashSenderInput.addEventListener('input', _liveCapitalizeSenderNameStart);
      _gcashSenderInput.addEventListener('input', _updatePaymentSubmitState);
      _gcashSenderInput.addEventListener('blur', _formatSenderNameField);
    }
    _updatePaymentSubmitState();
    _updateGcashSlotVisibility();

    const dashData = _parseJSON('member-dashboard-data');

    // Attendance calendar (initial render uses the server-provided current month)
    _attYear = _attCurrentYear = dashData.year;
    _attMonth = _attCurrentMonth = dashData.month;
    if (typeof buildAttGrid === 'function') {
      buildAttGrid('att-grid-member', dashData.present_days || [], dashData.days_in_month || 30,
        dashData.today_day, dashData.no_plan_days || [], dashData.year, dashData.month);
    }
    _updateAttNavButtons();

    // One-time popups (order matters least — each is independent)
    if (dashData.plan_approved_notice) {
      const n = dashData.plan_approved_notice;
      const msg = document.getElementById('plan-approved-message');
      if (msg) {
        msg.textContent = n.is_promo
          ? `Congratulations! Your ${n.plan_name} promo has been approved. Please proceed to payment.`
          : `Congratulations! Your ${n.plan_name} plan has been approved. Please proceed to payment.`;
      }
      openModal('plan-approved-modal');
    }
    if (dashData.payment_verified_notice) {
      const n = dashData.payment_verified_notice;
      const msg = document.getElementById('payment-approved-message');
      if (msg) {
        msg.textContent = n.is_promo
          ? `You have successfully paid for your ${n.plan_name} promo! Active since ${n.start_date}.`
          : `You have successfully paid your ${n.plan_name} plan! Active since ${n.start_date}.`;
      }
      openModal('payment-approved-modal');
    }
    if (dashData.plan_declined_notice) {
      const n = dashData.plan_declined_notice;
      const msg = document.getElementById('plan-declined-message');
      const title = document.getElementById('plan-declined-title');
      const kind = n.is_promo ? 'promo' : 'plan';
      // A payment-stage decline only rejects the payment itself — the plan
      // stays approved and the payment step re-opens, so the member is told
      // to pay again rather than to request the whole plan over again.
      if (n.stage === 'payment') {
        if (title) title.textContent = 'PAYMENT DECLINED';
        if (msg) {
          msg.textContent = `Your ${n.method || ''} payment for the ${n.plan_name} ${kind} was declined. `
            + `Your ${kind} is still approved — you don't need to request it again. `
            + `Please check with staff or admin, then submit your payment again on the Payment tab.`;
        }
      } else {
        if (title) title.textContent = 'REQUEST DECLINED';
        if (msg) {
          msg.textContent = `Your ${n.plan_name} ${kind} request was declined. `
            + `Please check with staff or admin, then feel free to submit a new request.`;
        }
      }
      openModal('plan-declined-modal');
    }
    if (dashData.feedback_prompt) {
      _openFeedbackPrompt(dashData.feedback_prompt);
    }
    // Neither admin announcements nor Gym Bot membership-expiry reminders
    // pop up automatically on load anymore — both wait quietly in the
    // notification bell (see _initNotificationBell / openNotifItem below)
    // and only pop up once the member opens the bell and taps the specific
    // message they want to read.

    // Plans / services lookup tables (used by the plan/service detail modals)
    (_parseJSON('member-plans-data') || []).forEach(p => { _plansByKey[p.key] = p; });
    _promosList = _parseJSON('member-promos-data') || [];
    (_parseJSON('member-services-data') || []).forEach(s => { _servicesById[s.id] = s; });
    (_parseJSON('member-equipment-data') || []).forEach(e => { _equipmentById[e.id] = e; });

    _initNotificationBell(dashData.notification_center || [], dashData.notification_unread_count || 0);

    _initFitnessWizard();
    _initProgressBars();
  }

  function tab(tabName, navEl) {
    Navigation.activateTab('member', tabName, navEl);
  }

  /** Quick Stats progress bars are rendered with a data-width="<0-100>"
   *  attribute (set server-side by member-dashboard.html) but the CSS
   *  never actually reads it — .progress-fill has no width rule, so every
   *  bar fills 100% of its track no matter what the real value is (e.g. an
   *  8/365-day membership shows a full-length bar). This applies the real
   *  percentage as the bar's width on load. */
  function _initProgressBars() {
    document.querySelectorAll('.progress-fill[data-width]').forEach(el => {
      let pct = parseFloat(el.getAttribute('data-width'));
      if (isNaN(pct)) pct = 0;
      pct = Math.max(0, Math.min(100, pct));
      el.style.width = pct + '%';
    });
  }

  /* ── Helpers ──────────────────────────────────────────── */
  function _parseJSON(elId) {
    const el = document.getElementById(elId);
    if (!el) return null;
    try { return JSON.parse(el.textContent || el.innerText || 'null'); }
    catch (e) { return null; }
  }

  function _esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function _peso(n) {
    const num = Number(n) || 0;
    return '₱' + num.toLocaleString(undefined, { minimumFractionDigits: num % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }

  /* ── Notification bell — combines admin announcements and the Gym
     Bot's expiry reminders into one revisitable list. `items` comes
     from the server's notification_center (already sorted newest
     first); `unreadCount` is how many were new on this page load. ── */
  let _notifItems = []; // kept around so a click on a list entry can re-open it as its own popup

  function _initNotificationBell(items, unreadCount) {
    const badge = document.getElementById('notif-bell-badge');
    if (badge) {
      if (unreadCount > 0) {
        badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }

    _notifItems = items || [];

    const listEl = document.getElementById('notif-panel-list');
    if (!listEl) return;
    if (!items || !items.length) {
      listEl.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
      return;
    }
    listEl.innerHTML = items.map((item, idx) => `
      <div class="notif-item${item.is_new ? ' notif-item-new' : ''}" onclick="MemberModule.openNotifItem(${idx})" style="cursor:pointer;">
        <div class="notif-item-top">
          <span class="notif-item-icon">${_esc(item.icon || '🔔')}</span>
          <span class="notif-item-title">${_esc(item.title)}</span>
          ${item.is_new ? '<span class="notif-item-new-dot" title="New" style="width:8px;height:8px;border-radius:50%;background:#ff4d4d;display:inline-block;margin-left:6px;"></span>' : ''}
        </div>
        ${item.sender ? `<div class="notif-item-sender">From: ${_esc(item.sender)}</div>` : ''}
        <div class="notif-item-body">${_esc(item.body)}</div>
        <div class="notif-item-date">${_esc(item.date)}</div>
        <div class="notif-item-hint">Tap to view full message</div>
      </div>
    `).join('');
  }

  /** Tapping a notification in the bell panel is what actually pops the
   *  full-size popup for that one item — Gym Bot reminders no longer show
   *  themselves automatically on page load, so this is the only way they
   *  (and, for consistency, past announcements) get opened as a popup. */
  function openNotifItem(idx) {
    const item = _notifItems[idx];
    if (!item) return;

    // Close the panel so it doesn't sit open behind the popup.
    const panel = document.getElementById('notif-panel');
    if (panel) panel.classList.remove('open');

    if (item.type === 'reminder') {
      showBotReminders([{ message: item.body, sender: item.sender }]);
    } else {
      // item.title is the generic bell-list label ("Notice"); item.subject
      // is the admin's actual announcement title, shown as the popup's
      // gold heading above the message body.
      showNewAnnouncementNotices([{ title: item.subject, body: item.body, sender: item.sender }]);
    }
  }

  function toggleNotificationPanel() {
    const panel = document.getElementById('notif-panel');
    if (!panel) return;
    const opening = !panel.classList.contains('open');
    panel.classList.toggle('open', opening);

    if (opening) {
      // Clear the unread badge the moment they actually check the list —
      // it's just been reviewed, so it shouldn't keep counting as unread.
      const badge = document.getElementById('notif-bell-badge');
      if (badge) badge.style.display = 'none';

      // Persist that this was actually seen, so already-viewed notices
      // don't come back as "unread" the next time this member logs in —
      // only genuinely new ones (posted after this moment) will.
      fetch('/member/notifications/mark-seen', { method: 'POST' }).catch(() => {});

      // Close on an outside click / Escape, one-shot listeners.
      const onOutsideClick = (e) => {
        const wrap = document.querySelector('.notif-bell-wrap');
        if (wrap && !wrap.contains(e.target)) {
          panel.classList.remove('open');
          document.removeEventListener('click', onOutsideClick);
          document.removeEventListener('keydown', onEscape);
        }
      };
      const onEscape = (e) => {
        if (e.key === 'Escape') {
          panel.classList.remove('open');
          document.removeEventListener('click', onOutsideClick);
          document.removeEventListener('keydown', onEscape);
        }
      };
      // Deferred so the click that opened the panel doesn't immediately close it.
      setTimeout(() => {
        document.addEventListener('click', onOutsideClick);
        document.addEventListener('keydown', onEscape);
      }, 0);
    }
  }

  /** Best-effort client-side preview of a plan's expiry date, mirroring
   *  app.py's _plan_expiry(): Monthly plans add one real calendar month,
   *  everything else adds duration_days flat. Purely cosmetic — the
   *  server always computes the authoritative value on submit. */
  function _previewExpiry(plan, startDate) {
    const d = new Date(startDate + 'T00:00:00');
    if (isNaN(d.getTime())) return '—';
    if (plan && plan.name === 'Monthly') {
      d.setMonth(d.getMonth() + 1);
    } else {
      d.setDate(d.getDate() + (plan ? plan.duration_days : 30));
    }
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function _apiForm(url, formData) {
    return fetch(url, { method: 'POST', body: formData })
      .then(res => res.json().then(data => ({ ok: res.ok, data })));
  }

  function _apiJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(res => res.json().then(data => ({ ok: res.ok, data })));
  }

  /* ════════════════════════════════════════════════
     MY MEMBERSHIP — plan selection + plan request
  ════════════════════════════════════════════════ */

  /** Member-specific plan-card selection — same visual behavior as the
   *  shared selectPlan() in tr-common.js, but also remembers which plan
   *  key is selected so submitRenewalPayment() knows what to submit. */
  function selectPlan(card, key) {
    const grid = card.closest('.plan-grid');
    if (grid) grid.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    _selectedPlanKey = key;

    // Picking a regular plan supersedes any availed promo — student
    // discounts are relevant again once a real plan is in play.
    if (_promoSelected) {
      _promoSelected = false;
      // Use _paintPromoSelected (not a bare classList.remove) — promo
      // cards carry their selected look as inline styles + an injected
      // checkmark div (see _paintPromoSelected below), so just stripping
      // the .selected class leaves that inline highlight on screen.
      document.querySelectorAll('#member-membership-promo .plan-card.selected')
        .forEach(c => _paintPromoSelected(c, false));
      _selectedPromoIndex = null;
    }
    _applyStudentFieldVisibility();
    _applyCoachFieldVisibility();
    _applySubmitButtonLabel();
  }

  /** Toggle-selects a promo card. Availing a promo hides the "Are you a
   *  student?" question below, since promo pricing doesn't stack with the
   *  student discount. Selecting a promo also clears any chosen plan card,
   *  since a member is availing the promo instead of a regular plan.
   *
   *  The selected look (border, glow, checkmark) is painted with inline
   *  styles here rather than left entirely to CSS classes, so it renders
   *  correctly even if the page's stylesheet is stale/cached — only this
   *  JS file needs to be current for the highlight to show up. */
  function selectPromo(card) {
    const grid = card.closest('.plan-grid');
    const wasSelected = card.classList.contains('selected');
    if (grid) grid.querySelectorAll('.plan-card').forEach(c => _paintPromoSelected(c, false));

    if (wasSelected) {
      _promoSelected = false;
      _selectedPromoIndex = null;
    } else {
      _paintPromoSelected(card, true);
      _promoSelected = true;
      _selectedPlanKey = null;
      _selectedPromoIndex = Number(card.dataset.promoIndex);
      // Scoped to #choose-plan-grid specifically (not the whole panel) —
      // #choose-plan-panel also contains this promo grid, so a panel-wide
      // selector here would immediately strip the .selected class we just
      // added to this very card, leaving its highlight orphaned from state
      // and letting a plan get selected alongside it later.
      document.querySelectorAll('#choose-plan-grid .plan-card.selected')
        .forEach(c => c.classList.remove('selected'));
    }
    _applyStudentFieldVisibility();
    _applyCoachFieldVisibility();
    _applySubmitButtonLabel();
  }

  /** Swaps the submit button's label — and color — between the plan look
   *  ("REQUEST MEMBERSHIP PLAN", red) and the promo look ("REQUEST A
   *  PROMO", gold), depending on whether a promo card is currently
   *  availed, so the button always reflects what's actually being
   *  submitted. */
  function _applySubmitButtonLabel() {
    const btn = document.getElementById('member-renew-submit-btn');
    if (!btn) return;
    btn.textContent = _promoSelected ? 'REQUEST A PROMO' : 'REQUEST MEMBERSHIP PLAN';
    btn.classList.toggle('btn-gold', _promoSelected);
    btn.classList.toggle('btn-red', !_promoSelected);
  }

  /** Applies (or clears) the selected-promo look. The gold "voucher" look
   *  itself (dashed border, ticket notches, "SELECTED" ribbon) lives in
   *  #member-membership-promo .plan-card.selected in the stylesheet, so
   *  this just toggles the class — kept as its own function since other
   *  code calls it directly to clear the look when a plan is chosen instead. */
  function _paintPromoSelected(card, on) {
    card.classList.toggle('selected', on);
  }

  /** Shows/hides the "Are you a student?" question (and resets it) based
   *  on whether a promo is currently availed. */
  function _applyStudentFieldVisibility() {
    const studentGroup = document.getElementById('member-renew-student-group');
    const studentSelect = document.getElementById('member-renew-student');
    if (!studentGroup) return;

    if (_promoSelected) {
      studentGroup.style.display = 'none';
      if (studentSelect) studentSelect.value = 'no';
      const idGroup = document.getElementById('member-student-id-group');
      if (idGroup) idGroup.style.display = 'none';
    } else {
      studentGroup.style.display = '';
    }
  }

  /** Shows the "Choose Your Coach" field only while a promo is availed
   *  (the reverse of the student question above) — a coach is mandatory
   *  with every promo, so no separate yes/no toggle is needed, just the
   *  select itself. Resets it to the blank placeholder when hidden so a
   *  stale choice doesn't linger on a regular plan — the member always
   *  has to actively pick, even though one option is marked
   *  "Recommended" as a hint. */
  function _applyCoachFieldVisibility() {
    const selectGroup = document.getElementById('member-renew-coach-select-group');
    if (!selectGroup) return;

    if (_promoSelected) {
      selectGroup.style.display = '';
      updateCoachAvailabilityNote();
    } else {
      selectGroup.style.display = 'none';
      const coachSelect = document.getElementById('member-renew-coach-name');
      if (coachSelect) coachSelect.value = '';
    }
  }

  const _WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /** Checks the currently-selected coach's available days against the
   *  chosen start date and shows a friendly heads-up if they don't line
   *  up — e.g. picking a Tuesday start for a Mon/Wed/Fri-only coach.
   *  Purely informational (staff still confirms availability when
   *  reviewing the request), so it never blocks submission. */
  function updateCoachAvailabilityNote() {
    const note = document.getElementById('member-coach-availability-note');
    const coachSelect = document.getElementById('member-renew-coach-name');
    const startInput = document.getElementById('member-renew-start');
    if (!note || !coachSelect) return;

    const coachName = coachSelect.value;
    const startDate = startInput?.value || '';
    if (!coachName) {
      note.textContent = '';
      return;
    }

    const option = Array.from(coachSelect.options).find(o => o.value === coachName);
    const daysAttr = option?.dataset.days || '';
    const availableDays = daysAttr.split(',').map(d => d.trim()).filter(Boolean);

    if (!startDate) {
      if (availableDays.length) {
        note.style.color = '#c7c7cf';
        note.textContent = `${coachName} is available: ${availableDays.join(', ')}.`;
      } else {
        note.style.color = '#c7c7cf';
        note.textContent = `${coachName}'s available days aren't set yet — staff will confirm.`;
      }
      return;
    }

    const weekday = _WEEKDAY_ABBR[new Date(startDate + 'T00:00:00').getDay()];
    const isAvailable = availableDays.includes(weekday);
    const fullDayName = new Date(startDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' });

    if (!availableDays.length) {
      note.style.color = '#c7c7cf';
      note.textContent = `${coachName}'s available days aren't set yet — staff will confirm.`;
    } else if (isAvailable) {
      note.style.color = 'var(--green, #2ecc71)';
      note.textContent = `✓ ${coachName} is available on ${fullDayName}s.`;
    } else {
      note.style.color = 'var(--gold, #e6b800)';
      note.textContent = `⚠ ${coachName} isn't usually in on ${fullDayName}s (available: ${availableDays.join(', ')}). Staff will confirm or suggest another coach.`;
    }
  }

  function openPlanModal(key) {
    const plan = _plansByKey[key];
    if (!plan) {
      console.warn(`openPlanModal: no plan data found for key "${key}". ` +
        `_plansByKey currently has: ${Object.keys(_plansByKey).join(', ') || '(empty)'}`);
      if (typeof showToast === 'function') {
        showToast('Could not load plan details. Please refresh the page and try again.', 'error');
      }
      return;
    }

    document.getElementById('plan-modal-title').textContent = plan.name.toUpperCase();
    document.getElementById('plan-modal-price').textContent = _peso(plan.price);
    document.getElementById('plan-modal-subtitle').textContent =
      plan.description || `${plan.duration_days} day${plan.duration_days == 1 ? '' : 's'} of full access`;

    const list = document.getElementById('plan-modal-list');
    if (list) {
      // plan.inclusions can arrive as either an array (server sends
      // p.inclusions_list, already split per line) or a raw newline-
      // separated string (older data shape) — normalize to an array
      // before rendering so neither shape throws.
      const raw = plan.inclusions;
      const lines = (Array.isArray(raw) ? raw : (raw || '').split('\n'))
        .map(l => (l || '').trim()).filter(Boolean);
      list.innerHTML = lines.length
        ? lines.map(l => `<li>${_esc(l)}</li>`).join('')
        : '<li>Full gym access for the plan duration.</li>';
    }

    const modal = document.getElementById('plan-modal');
    modal.dataset.mode = 'plan';
    modal.dataset.planKey = key;
    delete modal.dataset.promoIndex;
    modal.classList.remove('modal-gold');
    const priceEl = document.getElementById('plan-modal-price');
    if (priceEl) priceEl.style.color = '';
    const selectBtn = document.getElementById('plan-modal-select-btn');
    if (selectBtn) {
      selectBtn.textContent = 'SELECT THIS PLAN';
      selectBtn.classList.remove('btn-gold');
      selectBtn.classList.add('btn-red');
    }
    openModal('plan-modal');
  }

  /** Opens the same inclusions modal used for regular plans, but populated
   *  from a promo's data instead — so members can see exactly what a promo
   *  includes before availing it. `index` matches a promo's position in
   *  #member-promos-data / its card's data-promo-index. */
  function openPromoModal(index) {
    const promo = _promosList[index];
    if (!promo) {
      console.warn(`openPromoModal: no promo data found at index ${index}. ` +
        `_promosList currently has ${_promosList.length} entrie(s).`);
      if (typeof showToast === 'function') {
        showToast('Could not load promo details. Please refresh the page and try again.', 'error');
      }
      return;
    }

    document.getElementById('plan-modal-title').textContent = (promo.title || 'PROMO').toUpperCase();
    document.getElementById('plan-modal-price').textContent = _peso(promo.price);
    document.getElementById('plan-modal-subtitle').textContent =
      promo.description || promo.period || 'Limited-time offer';

    const list = document.getElementById('plan-modal-list');
    if (list) {
      const raw = promo.inclusions;
      const lines = (Array.isArray(raw) ? raw : (raw || '').split('\n'))
        .map(l => (l || '').trim()).filter(Boolean);
      list.innerHTML = lines.length
        ? lines.map(l => `<li>${_esc(l)}</li>`).join('')
        : (promo.session_limit
            ? `<li>${promo.session_limit} coach-guided sessions — no expiration.</li>`
            : '<li>Full gym access for the promo duration.</li>');
      if (promo.session_limit && lines.length) {
        // Spell out the counting rule right in the inclusions so nobody is surprised later.
        list.insertAdjacentHTML('beforeend',
          '<li><strong>How sessions are counted:</strong> a visit counts as 1 session only when your coach guides you. ' +
          'Using the machines and equipment on your own is free and is not counted.</li>');
      }
    }

    const modal = document.getElementById('plan-modal');
    modal.dataset.mode = 'promo';
    modal.dataset.promoIndex = String(index);
    delete modal.dataset.planKey;
    modal.classList.add('modal-gold');
    const priceEl = document.getElementById('plan-modal-price');
    if (priceEl) priceEl.style.color = 'var(--promo-gold)';
    const selectBtn = document.getElementById('plan-modal-select-btn');
    if (selectBtn) {
      selectBtn.textContent = 'SELECT THIS PROMO';
      selectBtn.classList.remove('btn-red');
      selectBtn.classList.add('btn-gold');
    }
    openModal('plan-modal');
  }

  function selectPlanFromModal() {
    const modal = document.getElementById('plan-modal');
    const mode = modal.dataset.mode || 'plan';
    closeModal('plan-modal');

    if (mode === 'promo') {
      const index = modal.dataset.promoIndex;
      if (index === undefined) return;
      const card = document.querySelector(`.plan-grid .plan-card[data-promo-index="${index}"]`);
      if (card && !card.classList.contains('selected')) selectPromo(card);
      return;
    }

    const key = modal.dataset.planKey;
    if (!key) return;

    const card = Array.from(document.querySelectorAll('.plan-grid .plan-card'))
      .find(c => (c.querySelector('.plan-name')?.textContent || '').trim().toLowerCase() === key);
    if (card) selectPlan(card, key);
  }

  /** Renders whatever's currently in _studentIdFrontFile / _studentIdBackFile
   *  into the two previews. Single source of truth for what's on screen —
   *  called after every add or remove instead of reading the native
   *  <input> (which only ever reflects the most recent file dialog). */
  function _renderStudentIdPreviews() {
    const renderSlot = (file, previewId, removeBtnId) => {
      const preview = document.getElementById(previewId);
      const removeBtn = document.getElementById(removeBtnId);
      if (!file) {
        if (preview) { preview.src = ''; preview.style.display = 'none'; }
        if (removeBtn) removeBtn.style.display = 'none';
        return;
      }
      const reader = new FileReader();
      reader.onload = e => {
        if (preview) { preview.src = e.target.result; preview.style.display = 'block'; }
      };
      reader.readAsDataURL(file);
      if (removeBtn) removeBtn.style.display = 'inline-block';
    };
    renderSlot(_studentIdFrontFile, 'member-student-id-front-preview', 'member-student-id-front-remove');
    renderSlot(_studentIdBackFile, 'member-student-id-back-preview', 'member-student-id-back-remove');
  }

  function toggleStudentIdField(selectEl) {
    const group = document.getElementById('member-student-id-group');
    if (group) group.style.display = selectEl.value === 'yes' ? '' : 'none';
  }

  /** Adds/replaces the photo for one specific side ('front' or 'back').
   *  Each side has its own file picker now, so there's no more guessing
   *  which slot an incoming file belongs in — picking a new photo for a
   *  side always just fills/replaces that side, leaving the other side
   *  untouched. The native input is cleared after each pick so choosing
   *  the same filename again still fires a change event. */
  function previewStudentId(input, side) {
    const file = (input.files || [])[0];
    if (!file) return;

    if (side === 'back') {
      _studentIdBackFile = file;
    } else {
      _studentIdFrontFile = file;
    }

    input.value = '';
    _renderStudentIdPreviews();
  }

  /** Clears one side (front or back) of the school ID selection so the
   *  member can re-pick just that one, without disturbing the other. */
  function removeStudentId(side) {
    if (side === 'back') {
      _studentIdBackFile = null;
    } else {
      _studentIdFrontFile = null;
    }
    _renderStudentIdPreviews();
  }

  /** Validates the plan (or promo) request form, then shows the invoice
   *  confirmation modal — the actual submit happens in confirmPlanRequest().
   *  A promo card being availed takes over entirely: no regular plan needs
   *  to be picked, since a promo is what's actually being requested. */
  function submitRenewalPayment() {
    if (_promoSelected) {
      _submitPromoRequest();
      return;
    }

    if (!_selectedPlanKey || !_plansByKey[_selectedPlanKey]) {
      showToast('Please select a membership plan.', 'error');
      return;
    }
    const plan = _plansByKey[_selectedPlanKey];

    // Reset the confirmation modal's labels back to the regular-plan
    // wording in case a promo request last set them to their promo
    // variants (see _submitPromoRequest below).
    const priceLabel = document.getElementById('confirm-plan-price-label');
    if (priceLabel) priceLabel.textContent = 'Regular Price';
    const expiryLabel = document.getElementById('confirm-plan-expiry-label');
    if (expiryLabel) expiryLabel.textContent = 'Expires';

    const startDate = document.getElementById('member-renew-start')?.value || '';
    if (!startDate) {
      showToast('Please choose a start date for your plan.', 'error');
      return;
    }
    if (!isStartDateValid()) {
      showToast('Please pick a valid start date — today or within the next 2 years.', 'error');
      validateStartDateField();
      return;
    }

    const isStudent = document.getElementById('member-renew-student')?.value === 'yes';
    if (isStudent && !_studentIdFrontFile) {
      showToast('Please upload the FRONT photo of your school ID.', 'error');
      return;
    }
    if (isStudent && !_studentIdBackFile) {
      showToast('Please upload the BACK photo of your school ID.', 'error');
      return;
    }

    const termsChecked = document.getElementById('reg-terms-check')?.checked;
    // Note: the Terms & Policy checkbox lives on registration, not here —
    // the plan request form itself has no separate terms gate, so nothing
    // to check beyond the fields above.

    const formData = new FormData();
    formData.append('plan', _selectedPlanKey);
    formData.append('start_date', startDate);
    formData.append('is_student', isStudent ? '1' : '0');
    formData.append('wants_coach', '0');
    if (isStudent && _studentIdFrontFile) formData.append('student_id_front', _studentIdFrontFile);
    if (isStudent && _studentIdBackFile) formData.append('student_id_back', _studentIdBackFile);
    _pendingPlanRequest = { formData };

    // Populate the invoice confirmation modal — mirrors the server's
    // _payment_total()/STUDENT_PLAN_PRICES logic so the preview the member
    // sees here matches what staff/admin will actually charge. Every plan
    // gets this treatment automatically, since plan.student_price comes
    // straight from the same table the server uses (falls back to the
    // regular price for any plan with no student rate configured).
    const regularPrice = plan.price;
    const studentPrice = (plan.student_price != null) ? plan.student_price : plan.price;
    const discountAmount = isStudent ? Math.max(0, regularPrice - studentPrice) : 0;
    const total = isStudent ? studentPrice : regularPrice;

    document.getElementById('confirm-plan-name').textContent = plan.name.toUpperCase();
    document.getElementById('confirm-plan-regular-price').textContent = _peso(regularPrice);
    if (discountAmount > 0) {
      document.getElementById('confirm-plan-discount-row').style.display = 'flex';
      document.getElementById('confirm-plan-discount-amount').textContent = '−' + _peso(discountAmount);
    } else {
      document.getElementById('confirm-plan-discount-row').style.display = 'none';
    }
    document.getElementById('confirm-plan-coach-row').style.display = 'none';
    document.getElementById('confirm-plan-coach-fee-row').style.display = 'none';
    document.getElementById('confirm-plan-date').textContent =
      new Date(startDate + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    document.getElementById('confirm-plan-end-date').textContent = _previewExpiry(plan, startDate);
    document.getElementById('confirm-plan-total').textContent = _peso(total);

    openModal('confirm-plan-modal');
  }

  /** Promo counterpart to submitRenewalPayment() above — skips plan
   *  selection and the student question entirely (neither applies once a
   *  promo is availed). A coach is mandatory with every promo, included
   *  in the promo price at no extra cost (see _applyCoachFieldVisibility
   *  above) — this validates that a coach was actually picked, then
   *  populates the same invoice confirmation modal from the promo's own
   *  data. */
  function _submitPromoRequest() {
    const promo = (_selectedPromoIndex != null) ? _promosList[_selectedPromoIndex] : null;
    if (!promo) {
      showToast('Please select a promo.', 'error');
      return;
    }

    const startDate = document.getElementById('member-renew-start')?.value || '';
    if (!startDate) {
      showToast('Please choose a start date for your plan.', 'error');
      return;
    }
    if (!isStartDateValid()) {
      showToast('Please pick a valid start date — today or within the next 2 years.', 'error');
      validateStartDateField();
      return;
    }

    const coachSelect = document.getElementById('member-renew-coach-name');
    const coachName = coachSelect ? coachSelect.value : '';
    if (!coachName) {
      showToast('Please choose a coach.', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('is_promo', '1');
    formData.append('promo_id', promo.id);
    formData.append('start_date', startDate);
    formData.append('wants_coach', '1');
    formData.append('coach_name', coachName);
    _pendingPlanRequest = { formData };

    document.getElementById('confirm-plan-name').textContent = (promo.title || 'PROMO').toUpperCase();

    const priceLabel = document.getElementById('confirm-plan-price-label');
    if (priceLabel) priceLabel.textContent = 'Promo Price';
    document.getElementById('confirm-plan-regular-price').textContent = _peso(promo.price);
    document.getElementById('confirm-plan-discount-row').style.display = 'none';

    document.getElementById('confirm-plan-coach-row').style.display = 'flex';
    document.getElementById('confirm-plan-coach-name').textContent = coachName;
    document.getElementById('confirm-plan-coach-fee-row').style.display = 'none';

    document.getElementById('confirm-plan-date').textContent =
      new Date(startDate + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

    const expiryLabel = document.getElementById('confirm-plan-expiry-label');
    if (expiryLabel) expiryLabel.textContent = 'Duration';
    document.getElementById('confirm-plan-end-date').textContent = promo.session_limit
      ? `No expiration · ${promo.session_limit} coach-guided sessions`
      : (promo.period || 'See promo details');

    document.getElementById('confirm-plan-total').textContent = _peso(promo.price);

    openModal('confirm-plan-modal');
  }

  function cancelPlanRequest() {
    closeModal('confirm-plan-modal');
  }

  function confirmPlanRequest() {
    if (!_pendingPlanRequest) { closeModal('confirm-plan-modal'); return; }

    showLoadingOverlay('Submitting your plan request...');
    _apiForm('/member/submit-payment', _pendingPlanRequest.formData)
      .then(({ ok, data }) => {
        hideLoadingOverlay();
        closeModal('confirm-plan-modal');
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to submit plan request.', 'error');
          return;
        }
        _pendingPlanRequest = null;
        const msg = document.getElementById('plan-success-message');
        if (msg) msg.textContent = data.message || 'You successfully requested your plan.';
        openModal('plan-success-modal');
      })
      .catch(() => {
        hideLoadingOverlay();
        closeModal('confirm-plan-modal');
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  function closePlanSuccessModal() {
    closeModal('plan-success-modal');
    window.location.reload();
  }

  function closePlanApprovedModal() {
    closeModal('plan-approved-modal');
  }

  function goToPaymentFromApproval() {
    closeModal('plan-approved-modal');
    tab('payment', document.getElementById('nav-member-payment'));
  }

  function closePaymentApprovedModal() {
    closeModal('payment-approved-modal');
  }

  function closePlanDeclinedModal() {
    closeModal('plan-declined-modal');
  }

  /* ════════════════════════════════════════════════
     POST-MEMBERSHIP RATING & FEEDBACK (#feedback-modal)
     Opens automatically on load when the server says this expiry cycle
     hasn't been rated yet (see dashData.feedback_prompt in init()).
  ════════════════════════════════════════════════ */

  function _openFeedbackPrompt(prompt) {
    const introEl = document.getElementById('fb-intro');
    if (introEl) {
      introEl.innerHTML = 'Your <strong id="fb-plan-name" style="color:var(--white);">'
        + _esc(prompt.plan_name || 'membership') + '</strong> plan has ended — we\'d love to hear how it went.';
    }
    _resetFeedbackWizard();
    openModal('feedback-modal');
  }

  /** Lets a member open the rating/feedback wizard on their own, any time —
   *  bound to the floating "Rate & Feedback" launcher (#fb-launcher) in
   *  member-dashboard.html. Reuses the exact same modal and submit endpoint
   *  as the automatic post-expiry prompt above; only the intro wording
   *  differs, since there's no specific expired plan to reference here.
   *  Reads the plan name already on screen (.card-plan) rather than
   *  calling the server, since that value is already loaded for this page. */
  function openFeedbackOnDemand() {
    const introEl = document.getElementById('fb-intro');
    if (introEl) {
      const planNameEl = document.querySelector('.card-plan');
      const planName = planNameEl ? planNameEl.textContent.trim() : '';
      introEl.innerHTML = (planName && planName !== 'No Active Plan')
        ? 'How has your time on the <strong style="color:var(--white);">' + _esc(planName) + '</strong> plan been so far? We\'d love to hear from you.'
        : 'We\'d love to hear about your experience at Power Gym so far.';
    }
    _resetFeedbackWizard();
    openModal('feedback-modal');
  }

  /** Shared reset for #feedback-modal, used both by the automatic
   *  post-expiry prompt and the on-demand launcher above, so the wizard
   *  always opens on a clean step 1 — even if a previous visit this
   *  session got partway through and hit "Maybe Later". */
  function _resetFeedbackWizard() {
    _feedbackRating = 0;
    _feedbackRecommend = null;
    document.querySelectorAll('#fb-stars .fb-star').forEach(s => s.classList.remove('filled'));
    const commentEl = document.getElementById('fb-comment');
    if (commentEl) commentEl.value = '';
    const improvementEl = document.getElementById('fb-improvement');
    if (improvementEl) improvementEl.value = '';
    document.querySelectorAll('.fb-recommend-btn').forEach(b => b.classList.remove('selected'));
    const step1Btn = document.getElementById('fb-step1-btn');
    if (step1Btn) step1Btn.disabled = true;
    _showFeedbackStep(1);
    _setupFeedbackStars();
  }

  /** Wires click/hover on the 5 star glyphs — done once per modal open
   *  rather than in init() so it works even though the modal (and its
   *  stars) only exist once member-dashboard.html has fully rendered. */
  function _setupFeedbackStars() {
    const stars = Array.from(document.querySelectorAll('#fb-stars .fb-star'));
    stars.forEach(star => {
      star.onclick = () => {
        _feedbackRating = parseInt(star.getAttribute('data-star'), 10) || 0;
        _renderFeedbackStars(_feedbackRating);
        const step1Btn = document.getElementById('fb-step1-btn');
        if (step1Btn) step1Btn.disabled = _feedbackRating < 1;
      };
    });
  }

  function _renderFeedbackStars(rating) {
    document.querySelectorAll('#fb-stars .fb-star').forEach(s => {
      const val = parseInt(s.getAttribute('data-star'), 10) || 0;
      s.classList.toggle('filled', val <= rating);
    });
  }

  function _showFeedbackStep(step) {
    document.getElementById('fb-step-1').style.display = step === 1 ? '' : 'none';
    document.getElementById('fb-step-2').style.display = step === 2 ? '' : 'none';
    document.getElementById('fb-thanks').style.display  = 'none';

    const dot1 = document.getElementById('fb-dot-1');
    const dot2 = document.getElementById('fb-dot-2');
    if (dot1 && dot2) {
      dot1.classList.toggle('active', step === 1);
      dot1.classList.toggle('complete', step === 2);
      dot2.classList.toggle('active', step === 2);
      dot2.classList.remove('complete');
    }
  }

  function feedbackWizardNext() {
    if (_feedbackRating < 1) {
      showToast('Please pick a star rating first.', 'error');
      return;
    }
    _showFeedbackStep(2);
  }

  function feedbackWizardBack() {
    _showFeedbackStep(1);
  }

  function selectFeedbackRecommend(value) {
    _feedbackRecommend = value;
    const yesBtn = document.getElementById('fb-recommend-yes');
    const noBtn  = document.getElementById('fb-recommend-no');
    if (yesBtn) yesBtn.classList.toggle('selected', value === true);
    if (noBtn)  noBtn.classList.toggle('selected', value === false);
  }

  /** Closes the modal without submitting anything. Since the server only
   *  clears feedback_prompt once real feedback is on file, this is a
   *  "not right now" — the prompt will simply appear again on the next
   *  login for as long as this expiry cycle goes unrated. */
  function dismissFeedbackModal() {
    closeModal('feedback-modal');
  }

  function submitMemberFeedback() {
    if (_feedbackRating < 1) {
      showToast('Please pick a star rating first.', 'error');
      _showFeedbackStep(1);
      return;
    }

    const comment = _val('fb-comment');
    const improvement = _val('fb-improvement');

    showLoadingOverlay('Submitting your feedback...');
    _apiJson('/member/submit-feedback', {
      rating: _feedbackRating,
      comment,
      improvement,
      would_recommend: _feedbackRecommend,
    })
      .then(({ ok, data }) => {
        hideLoadingOverlay();
        if (!ok || !data.success) {
          showToast((data && data.error) || 'Could not submit your feedback. Please try again.', 'error');
          return;
        }
        document.getElementById('fb-step-1').style.display = 'none';
        document.getElementById('fb-step-2').style.display = 'none';
        document.getElementById('fb-thanks').style.display = '';
        const dot1 = document.getElementById('fb-dot-1');
        const dot2 = document.getElementById('fb-dot-2');
        if (dot1) { dot1.classList.remove('active'); dot1.classList.add('complete'); }
        if (dot2) { dot2.classList.remove('active'); dot2.classList.add('complete'); }
      })
      .catch(() => {
        hideLoadingOverlay();
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  function withdrawPlanRequest(paymentId) {
    _withdrawPaymentId = paymentId;
    openModal('withdraw-request-modal');
  }

  function cancelWithdrawRequest() {
    closeModal('withdraw-request-modal');
  }

  function confirmWithdrawRequest() {
    if (!_withdrawPaymentId) { closeModal('withdraw-request-modal'); return; }

    showLoadingOverlay('Cancelling your plan request...');
    _apiJson('/member/cancel-plan-request', {})
      .then(({ ok, data }) => {
        hideLoadingOverlay();
        closeModal('withdraw-request-modal');
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to cancel plan request.', 'error');
          return;
        }
        showToast(data.message || 'Plan request cancelled.', 'success');
        setTimeout(() => window.location.reload(), 700);
      })
      .catch(() => {
        hideLoadingOverlay();
        closeModal('withdraw-request-modal');
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  /* ════════════════════════════════════════════════
     PAYMENT — Cash / GCash submission
  ════════════════════════════════════════════════ */

  function togglePaymentProofField(selectEl) {
    const gcashFields = document.getElementById('payment-gcash-fields');
    const cashNote = document.getElementById('payment-cash-note');
    const isGcash = selectEl.value === 'gcash';
    if (gcashFields) gcashFields.style.display = isGcash ? '' : 'none';
    if (cashNote) cashNote.style.display = isGcash ? 'none' : '';

    const submitBtn = document.getElementById('payment-submit-btn');
    if (submitBtn) submitBtn.textContent = isGcash ? 'SUBMIT PAYMENT' : 'PROCEED TO FRONT DESK';
    _updatePaymentSubmitState();
  }

  /** Gates the payment submit button: Cash never needs gating (it's just
   *  settled in person at the front desk), but GCash requires the primary
   *  receipt screenshot, a reference number, and an Amount Paid that meets
   *  or exceeds what's required for the plan/promo before it becomes
   *  clickable — otherwise staff/admin would be stuck verifying a payment
   *  that's visibly short. */
  function _updatePaymentSubmitState() {
    const submitBtn = document.getElementById('payment-submit-btn');
    if (!submitBtn) return;
    const select = document.getElementById('payment-method-select');
    const method = select ? select.value : 'cash';

    if (method !== 'gcash') {
      submitBtn.disabled = false;
      submitBtn.title = '';
      return;
    }

    const proofInput = document.getElementById('payment-gcash-proof');
    const hasProof = !!(proofInput && proofInput.files && proofInput.files[0]);
    const reference = document.getElementById('payment-gcash-reference')?.value.trim() || '';
    // The sender/account name is what admin cross-checks the receipt against
    // — without it an unnamed screenshot can't be tied to this member, so
    // it's required before the button unlocks.
    const sender = document.getElementById('payment-gcash-sender')?.value.trim() || '';

    const amountInput = document.getElementById('payment-gcash-amount');
    const raw = amountInput ? amountInput.value.trim() : '';
    const required = amountInput ? parseFloat((amountInput.dataset.required || '').replace(/,/g, '')) : NaN;
    const paid = raw ? parseFloat(raw.replace(/,/g, '')) : NaN;
    const amountIsEnough = !isNaN(required) && !isNaN(paid) && (paid + 0.01 >= required);

    const ready = hasProof && !!sender && !!reference && amountIsEnough;
    submitBtn.disabled = !ready;
    submitBtn.title = ready
      ? ''
      : 'Attach your receipt screenshot, and fill in the sender/account name, GCash reference number, and an amount that covers the required payment before submitting.';
  }

  /** Copies the gym's GCash number to the clipboard when the member taps
   *  the small copy icon next to it on the payment card. */
  function copyGcashNumber(btn) {
    const number = btn?.dataset?.copy || '';
    if (!number) return;
    const done = () => showToast('GCash number copied.', 'success');
    const fail = () => showToast('Could not copy — please copy it manually.', 'error');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(number).then(done).catch(fail);
    } else {
      fail();
    }
  }

  /** Formats a typed name into "Juan M. Dela Cruz" style casing: first
   *  letter of each name part capitalized, rest lowercased, and any
   *  single-letter part (a middle initial) uppercased with a trailing
   *  period. Hyphens and apostrophes inside a part (e.g. "Dela-Cruz",
   *  "O'Brien") each get their own capitalized segment. Collapses stray
   *  extra spaces along the way. */
  function _formatSenderName(raw) {
    if (!raw) return raw;
    return raw
      .trim()
      .replace(/\s+/g, ' ')
      .split(' ')
      .map(word => {
        const bare = word.replace(/\.$/, '');
        if (bare.length === 1) return bare.toUpperCase() + '.'; // middle initial
        return word
          .split(/([-'])/)
          .map(seg => (seg === '-' || seg === "'" || !seg)
            ? seg
            : seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
          .join('');
      })
      .join(' ');
  }

  /** Applies _formatSenderName() to the Sender/Account Name field in place,
   *  called on blur/submit as the full corrective pass (lowercases the rest
   *  of each word, adds the middle-initial period, collapses spacing) —
   *  the kind of cleanup that's disruptive to run on every keystroke. */
  function _formatSenderNameField() {
    const input = document.getElementById('payment-gcash-sender');
    if (!input) return;
    const formatted = _formatSenderName(input.value);
    if (formatted !== input.value) input.value = formatted;
  }

  /** Lighter-touch live version, run on every keystroke: as soon as the
   *  member types the first letter of a new word (start of the field, or
   *  right after a space), that one letter is capitalized immediately.
   *  Nothing else in the field is touched — no forced lowercasing, no
   *  middle-initial periods — so it never fights normal typing, deleting,
   *  or pasting. The full cleanup in _formatSenderNameField() still runs on
   *  blur/submit to catch everything this lighter pass intentionally
   *  leaves alone (e.g. someone typing in ALL CAPS or pasting a name in). */
  function _liveCapitalizeSenderNameStart(e) {
    if (e.inputType !== 'insertText' || !e.data) return; // only a normal typed character
    const input = e.target;
    const pos = input.selectionStart;
    if (!pos) return;
    const val = input.value;
    const typedChar = val[pos - 1];
    const isWordStart = pos === 1 || /\s/.test(val[pos - 2]);
    const upper = typedChar.toUpperCase();
    if (isWordStart && typedChar !== upper) {
      input.value = val.slice(0, pos - 1) + upper + val.slice(pos);
      input.setSelectionRange(pos, pos);
    }
  }

  /** "I'll pay later" — clears out the GCash sub-fields and drops the
   *  method selector back to its default so the member isn't left mid-form.
   *  The Submit Payment panel itself stays put; they can come back to it
   *  any time from the Payment tab. */
  function deferPaymentMethod() {
    const select = document.getElementById('payment-method-select');
    removeGcashProof(1);
    removeGcashProof(2);
    removeGcashProof(3);
    ['payment-gcash-sender', 'payment-gcash-date', 'payment-gcash-time', 'payment-gcash-reference'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    _recomputeGcashTotalAmount(); // clears the computed total and resets the red/green styling too
    if (select) {
      select.value = 'cash';
      togglePaymentProofField(select);
    }
    showToast("No problem — come back to the Payment tab whenever you're ready.", 'success');
  }

  /** slot is 1, 2, or 3 — 1 is the required/primary screenshot (ids have
   *  no suffix for the file/preview elements), 2 and 3 are the optional
   *  extra ones (ids end in "-2"/"-3"). Every attached screenshot gets
   *  auto-read for its own Amount (that field is read-only — the member
   *  never types it), but Date/Time/Reference Number are only ever taken
   *  from screenshot 1, even when more are attached. */
  function previewGcashProof(input, slot) {
    slot = slot || 1;
    const suffix = slot === 1 ? '' : '-' + slot;
    const preview = document.getElementById('payment-gcash-proof-preview' + suffix);
    const removeBtn = document.getElementById('payment-gcash-proof-remove' + suffix);
    const tapHint = document.getElementById('payment-gcash-proof-tap-hint' + suffix);
    const filenameLabel = document.getElementById('payment-gcash-filename' + suffix);
    const file = input.files && input.files[0];
    if (!file) return;
    if (filenameLabel) filenameLabel.textContent = file.name;
    if (preview) {
      const reader = new FileReader();
      reader.onload = e => {
        preview.src = e.target.result;
        preview.style.display = 'block';
        if (removeBtn) removeBtn.style.display = 'inline-block';
        if (tapHint) tapHint.style.display = 'block';
      };
      reader.readAsDataURL(file);
    }

    _runGcashReceiptOCR(file, slot);
    _updatePaymentSubmitState();
  }

  /** Opens the just-uploaded receipt in a bigger modal view — same "tap
   *  to enlarge" idea as the GCash QR code thumbnail. The image itself
   *  is whatever the member picked (a data: URL from previewGcashProof
   *  above), so it's copied over to the modal's <img> right here rather
   *  than being known ahead of time like the QR code's fixed file path. */
  function openGcashProofPreview(slot) {
    slot = slot || 1;
    const suffix = slot === 1 ? '' : '-' + slot;
    const preview = document.getElementById('payment-gcash-proof-preview' + suffix);
    const modalImg = document.getElementById('gcash-proof-view-img');
    if (!preview || !preview.src || !modalImg) return;
    modalImg.src = preview.src;
    openModal('gcash-proof-view-modal');
  }

  /** Sends the just-picked GCash screenshot to the server to auto-read
   *  the amount, reference number, date, and time off it, then silently
   *  fills in the matching form fields (Payment Date, Payment Time,
   *  Reference Number) from screenshot 1 only, plus the Amount field for
   *  *whichever* screenshot was just uploaded (1, 2, or 3) — every
   *  attached screenshot gets its own amount auto-read since that field is
   *  read-only and never typed by the member. Sender/Account Name is
   *  always typed by the member by hand — never auto-filled, even if OCR
   *  happens to read a name off the receipt. Never blocks the flow — on
   *  any failure it just leaves the amount field showing that it couldn't
   *  be read, and the member can remove/re-upload that screenshot. */
  function _runGcashReceiptOCR(file, slot) {
    slot = slot || 1;
    const amountInput = document.getElementById('payment-gcash-amount-' + slot);
    if (amountInput) amountInput.placeholder = 'Reading receipt…';
    _gcashSlotReference[slot] = null; // cleared until this OCR pass (re)confirms it

    // Older builds showed a "Detected from your receipt" summary box here;
    // keep it permanently hidden now that fields are filled silently.
    const box = document.getElementById('payment-gcash-ocr-box');
    if (box) box.style.display = 'none';

    const formData = new FormData();
    formData.append('gcash_proof', file);

    _apiForm('/member/ocr-gcash-proof', formData)
      .then(({ ok, data }) => {
        if (!ok || !data.success || !data.ocr_available || !data.detected) {
          if (amountInput) amountInput.placeholder = 'Could not auto-read — not counted yet';
          _recomputeGcashTotalAmount();
          return;
        }
        const d = data.detected;
        _gcashSlotReference[slot] = d.reference || null;

        // If this exact reference number already funded a past payment
        // (this member's own earlier submission, or anyone else's), reject
        // this screenshot right away rather than letting the member fill in
        // the rest of the form first. The server repeats this check
        // independently at final submit as the real gate.
        if (data.reference_already_used) {
          showToast(
            'This screenshot\'s reference number has already been used for another payment. ' +
            'Please attach a different transaction.',
            'error'
          );
          removeGcashProof(slot);
          return;
        }

        // Date/Time/Reference Number are only ever taken from screenshot 1 —
        // the system deliberately reads just one receipt for those fields
        // even when 2 or 3 are attached. Auto-fill each, but only if the
        // member hasn't already typed something in — never stomp on a
        // manual edit. (Sender/Account Name is intentionally excluded —
        // the member always types that one themselves.)
        if (slot === 1) {
          const refInput = document.getElementById('payment-gcash-reference');
          if (refInput && d.reference && !refInput.value.trim()) {
            refInput.value = d.reference;
          }
          const dateInput = document.getElementById('payment-gcash-date');
          if (dateInput && d.date_iso && !dateInput.value) {
            dateInput.value = d.date_iso;
          }
          const timeInput = document.getElementById('payment-gcash-time');
          if (timeInput && d.time_24h && !timeInput.value) {
            timeInput.value = d.time_24h;
          }
        }

        // Amount is auto-read onto *this screenshot's own* field — the
        // member can never type it — and the computed total (see
        // _recomputeGcashTotalAmount below) is the sum of every attached
        // screenshot's auto-read amount.
        if (amountInput) {
          if (d.amount) {
            amountInput.value = d.amount;
            amountInput.placeholder = '0.00';
          } else {
            amountInput.placeholder = 'Could not auto-read — not counted yet';
          }
        }
        _recomputeGcashTotalAmount();
        _checkGcashDuplicateScreenshot(slot);
      })
      .catch(() => {
        if (amountInput) amountInput.placeholder = 'Could not auto-read — not counted yet';
        _recomputeGcashTotalAmount();
      });
  }

  /** Compares this slot's just-OCR'd reference number against whatever was
   *  already read off the other currently-attached screenshot(s). Catches
   *  the same real GCash transaction being picked twice (e.g. to make it
   *  look like the total covers more than what was actually paid) right as
   *  it's attached, instead of only at final submit. Best-effort: a slot
   *  OCR couldn't read a reference number for is simply never compared —
   *  it doesn't block anything, admin still reviews it manually. On a
   *  match, the newly-picked screenshot is the one rejected and cleared,
   *  since it's the one that just tried to reuse an already-attached
   *  receipt; the server repeats this check independently at submit time
   *  as the real gate, so this is purely a faster heads-up for the member. */
  function _checkGcashDuplicateScreenshot(slot) {
    const ref = _gcashSlotReference[slot];
    if (!ref) return;
    const normalized = ref.replace(/\s+/g, '').toLowerCase();
    for (const otherSlot of [1, 2, 3]) {
      if (otherSlot === slot) continue;
      const otherRef = _gcashSlotReference[otherSlot];
      if (!otherRef) continue;
      if (otherRef.replace(/\s+/g, '').toLowerCase() === normalized) {
        showToast(
          `Screenshot ${slot} looks like the same GCash receipt as Screenshot ${otherSlot} ` +
          `(same reference number). Please upload a different transaction.`,
          'error'
        );
        removeGcashProof(slot);
        return;
      }
    }
  }


  /** The Amount Paid (Total) field is never typed directly — it's the sum
   *  of whichever per-screenshot "Amount on This Screenshot" fields are
   *  currently in play (screenshot 1 is always counted; 2 and 3 only count
   *  while their slot is actually open, so removing a screenshot also
   *  drops its amount from the total). Recomputing re-triggers the
   *  red/green required-amount check and the submit-button gate. */
  function _recomputeGcashTotalAmount() {
    const slotAmountIds = ['payment-gcash-amount-1', 'payment-gcash-amount-2', 'payment-gcash-amount-3'];
    let sum = 0;
    let anyEntered = false;
    slotAmountIds.forEach((id, idx) => {
      const slotNum = idx + 1;
      if (slotNum > 1) {
        const box = document.getElementById('payment-gcash-slot-' + slotNum);
        if (!box || box.style.display === 'none') return; // slot not attached — don't count it
      }
      const el = document.getElementById(id);
      const raw = el ? el.value.trim() : '';
      if (!raw) return;
      const val = parseFloat(raw.replace(/,/g, ''));
      if (!isNaN(val)) { sum += val; anyEntered = true; }
    });

    const totalInput = document.getElementById('payment-gcash-amount');
    if (totalInput) totalInput.value = anyEntered ? sum.toFixed(2) : '';
    _validateGcashAmountPaid();
    _updateGcashSlotVisibility();
  }

  /** Screenshot 2 and 3 stay hidden until they're actually needed. Slot 2
   *  only appears once screenshot 1 is attached and the amount read so far
   *  still falls short of what's required for this payment (e.g. the
   *  member split a large payment across multiple GCash transfers); slot 3
   *  only appears the same way once slot 2 is in play and the total is
   *  still short. If a screenshot alone already covers the required
   *  amount, the extra slot(s) simply never show. A slot that already has
   *  a file in it is kept visible even if a later edit makes the total
   *  sufficient again, or another slot gets removed/replaced in the
   *  meantime — a slot's own visibility never depends on another slot
   *  being mid-replace, so clicking "Remove & replace" on one screenshot
   *  never makes an untouched screenshot disappear. Called after every
   *  recompute of the total, so it reacts to OCR fills, manual removes,
   *  and new uploads alike. */
  function _updateGcashSlotVisibility() {
    const slot1Input = document.getElementById('payment-gcash-proof');
    const slot2Input = document.getElementById('payment-gcash-proof-2');
    const slot3Input = document.getElementById('payment-gcash-proof-3');
    const slot2Box = document.getElementById('payment-gcash-slot-2');
    const slot3Box = document.getElementById('payment-gcash-slot-3');
    const totalInput = document.getElementById('payment-gcash-amount');

    const hasSlot1 = !!(slot1Input && slot1Input.files && slot1Input.files[0]);
    const hasSlot2File = !!(slot2Input && slot2Input.files && slot2Input.files[0]);
    const hasSlot3File = !!(slot3Input && slot3Input.files && slot3Input.files[0]);

    const required = parseFloat((totalInput?.dataset.required || '').replace(/,/g, ''));
    const paidRaw = totalInput ? totalInput.value.trim() : '';
    const paid = paidRaw ? parseFloat(paidRaw.replace(/,/g, '')) : NaN;
    // Treat "couldn't be read yet" the same as "not enough" — the member
    // still needs a way to add backup proof if OCR came up empty.
    const insufficient = isNaN(required) || isNaN(paid) || (paid + 0.01 < required);

    // A slot that already holds its own file stays visible no matter what —
    // it only ever needs "prompted into view" (the hasSlot1 && insufficient
    // part) while it's still empty.
    const showSlot2 = hasSlot2File || (hasSlot1 && insufficient);
    if (slot2Box) slot2Box.style.display = showSlot2 ? '' : 'none';

    const showSlot3 = hasSlot3File || (showSlot2 && insufficient);
    if (slot3Box) slot3Box.style.display = showSlot3 ? '' : 'none';
  }


  /** Colors the Amount Paid field and its helper note red when what's
   *  typed/detected is less than the plan's required amount, green when
   *  it meets or exceeds it, and back to neutral when the field is
   *  empty. Called on every keystroke in that field and right after OCR
   *  auto-fills it. */
  function _validateGcashAmountPaid() {
    const amountInput = document.getElementById('payment-gcash-amount');
    const status = document.getElementById('payment-gcash-amount-status');
    const prefix = document.getElementById('payment-gcash-amount-prefix');
    if (!amountInput) return;

    amountInput.classList.remove('gcash-amount-input-insufficient', 'gcash-amount-input-match');
    if (status) {
      status.classList.remove('status-insufficient', 'status-match');
      status.textContent = '';
    }
    if (prefix) prefix.classList.remove('status-insufficient', 'status-match');

    const raw = amountInput.value.trim();
    if (!raw) { _updatePaymentSubmitState(); return; } // nothing typed yet — stay neutral

    const required = parseFloat((amountInput.dataset.required || '').replace(/,/g, ''));
    const paid = parseFloat(raw.replace(/,/g, ''));
    if (isNaN(required) || isNaN(paid)) { _updatePaymentSubmitState(); return; }

    if (paid + 0.01 < required) {
      amountInput.classList.add('gcash-amount-input-insufficient');
      if (prefix) prefix.classList.add('status-insufficient');
      if (status) {
        status.classList.add('status-insufficient');
        status.textContent = `⚠ This is less than the ₱${required.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} required.`;
      }
    } else {
      amountInput.classList.add('gcash-amount-input-match');
      if (prefix) prefix.classList.add('status-match');
      if (status) {
        status.classList.add('status-match');
        status.textContent = '✓ Amount meets what\'s required.';
      }
    }

    _updatePaymentSubmitState();
  }

  function _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Clears a wrongly-picked GCash proof file so the member can choose again.
   *  slot 1 (default) is the required/primary screenshot — clearing it also
   *  wipes every field OCR may have auto-filled from it (Date, Time,
   *  Reference No., Amount Paid), since those values only make sense
   *  paired with that specific receipt. Sender/Account Name is left alone:
   *  the member always types that by hand, so it's not tied to any
   *  particular upload. Slots 2 and 3 are the optional extra screenshots —
   *  clearing one just collapses that slot back down so it can be
   *  re-added via "+ Add another screenshot". */
  function removeGcashProof(slot) {
    slot = slot || 1;
    _gcashSlotReference[slot] = null;
    const suffix = slot === 1 ? '' : '-' + slot;
    const input = document.getElementById('payment-gcash-proof' + suffix);
    const preview = document.getElementById('payment-gcash-proof-preview' + suffix);
    const removeBtn = document.getElementById('payment-gcash-proof-remove' + suffix);
    const filenameLabel = document.getElementById('payment-gcash-filename' + suffix);
    if (input) input.value = '';
    if (preview) { preview.src = ''; preview.style.display = 'none'; }
    if (removeBtn) removeBtn.style.display = 'none';
    if (filenameLabel) filenameLabel.textContent = 'No file selected';

    if (slot === 1) {
      const tapHint = document.getElementById('payment-gcash-proof-tap-hint');
      const ocrBox = document.getElementById('payment-gcash-ocr-box');
      if (tapHint) tapHint.style.display = 'none';
      if (ocrBox) { ocrBox.style.display = 'none'; ocrBox.innerHTML = ''; }

      ['payment-gcash-date', 'payment-gcash-time', 'payment-gcash-reference'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const amountEl1 = document.getElementById('payment-gcash-amount-1');
      if (amountEl1) { amountEl1.value = ''; amountEl1.placeholder = '0.00'; }
      _recomputeGcashTotalAmount(); // clears/updates the computed total too, cascades to the submit gate
    } else {
      const tapHint = document.getElementById('payment-gcash-proof-tap-hint-' + slot);
      if (tapHint) tapHint.style.display = 'none';

      const amountEl = document.getElementById('payment-gcash-amount-' + slot);
      if (amountEl) { amountEl.value = ''; amountEl.placeholder = '0.00'; }
      _recomputeGcashTotalAmount();
      _updatePaymentSubmitState();
    }
  }

  /* ════════════════════════════════════════════════
     PROFILE — change profile picture (7-day cooldown,
     enforced server-side; the button here is also
     disabled client-side while ineligible)
  ════════════════════════════════════════════════ */
  function changeProfilePicture(input) {
    const file = input.files && input.files[0];
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

    // Let the member reposition/zoom before it's uploaded, rather than
    // saving whatever framing the raw file happened to have.
    openImageCropper(file, (blob, blobName) => {
      _uploadProfilePicture(blob, blobName, input);
    }, () => {
      input.value = '';
    });
  }

  function _uploadProfilePicture(blob, blobName, input) {
    const formData = new FormData();
    formData.append('profile_picture', blob, blobName);

    showLoadingOverlay('Uploading your new photo...');
    _apiForm('/update-profile-picture', formData)
      .then(({ ok, data }) => {
        hideLoadingOverlay();
        input.value = '';
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to update profile picture.', 'error');
          return;
        }

        // Swap every avatar on the page that shows the current picture —
        // the Profile tab's big avatar, the Settings tab's big avatar,
        // and the sidebar's small one.
        [document.getElementById('profile-picture-avatar'),
         document.getElementById('settings-profile-picture-avatar'),
         document.getElementById('sidebar-user-avatar')]
          .forEach(el => {
            if (!el) return;
            el.style.backgroundImage = `url('${data.profile_picture_url}')`;
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.style.color = 'transparent';
          });

        // Lock the edit button back down until the next cooldown ends —
        // on both the Profile tab and the Settings tab.
        [document.getElementById('profile-picture-btn'),
         document.getElementById('settings-profile-picture-btn')]
          .forEach(btn => {
            if (btn && data.available_at) {
              btn.disabled = true;
              btn.title = `You can change your photo again on ${data.available_at}.`;
            }
          });
        [document.getElementById('profile-picture-hint'),
         document.getElementById('settings-profile-picture-hint')]
          .forEach(hint => {
            if (hint && data.available_at) {
              hint.innerHTML = `You can change your profile picture again on <strong>${data.available_at}</strong>.`;
            }
          });

        showToast(data.message || 'Profile picture updated successfully.', 'success');
      })
      .catch(() => {
        hideLoadingOverlay();
        input.value = '';
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  function submitPaymentMethod() {
    const method = document.getElementById('payment-method-select')?.value || 'cash';
    const formData = new FormData();
    formData.append('payment_method', method);

    let confirmText = 'Are you sure you want to settle this payment as Cash at the front desk?';
    if (method === 'gcash') {
      const reference = document.getElementById('payment-gcash-reference')?.value.trim() || '';
      const proofInput = document.getElementById('payment-gcash-proof');
      const proofFile = proofInput?.files?.[0] || null;

      if (!reference) {
        showToast('Please enter your GCash reference number.', 'error');
        return;
      }
      if (!proofFile) {
        showToast('Please attach a screenshot of your GCash proof of payment.', 'error');
        return;
      }
      formData.append('gcash_reference', reference);
      formData.append('gcash_proof', proofFile);

      // Up to 2 more optional screenshots (e.g. a payment split across
      // transfers) — neither is required, and neither is OCR'd.
      const proof2 = document.getElementById('payment-gcash-proof-2')?.files?.[0] || null;
      const proof3 = document.getElementById('payment-gcash-proof-3')?.files?.[0] || null;
      if (proof2) formData.append('gcash_proof_2', proof2);
      if (proof3) formData.append('gcash_proof_3', proof3);

      // Sender/account name is required (see _updatePaymentSubmitState); the
      // date/time fields below it are still optional context for admin.
      _formatSenderNameField(); // safety net in case blur never fired (e.g. browser autofill)
      const sender = document.getElementById('payment-gcash-sender')?.value.trim() || '';
      if (!sender) {
        showToast('Please enter the sender / account name shown on your GCash receipt.', 'error');
        document.getElementById('payment-gcash-sender')?.focus();
        return;
      }
      const payDate = document.getElementById('payment-gcash-date')?.value || '';
      const payTime = document.getElementById('payment-gcash-time')?.value || '';
      const amountPaid = document.getElementById('payment-gcash-amount')?.value.trim() || '';
      if (sender)     formData.append('gcash_sender_name', sender);
      if (payDate)    formData.append('gcash_paid_date', payDate);
      if (payTime)    formData.append('gcash_paid_time', payTime);
      if (amountPaid) formData.append('gcash_amount_paid', amountPaid);

      // Per-screenshot amounts (whichever slots are actually attached) so
      // admin can see how the computed total breaks down across receipts.
      const amount1 = document.getElementById('payment-gcash-amount-1')?.value.trim() || '';
      if (amount1) formData.append('gcash_amount_screenshot_1', amount1);
      if (proof2) {
        const amount2 = document.getElementById('payment-gcash-amount-2')?.value.trim() || '';
        if (amount2) formData.append('gcash_amount_screenshot_2', amount2);
      }
      if (proof3) {
        const amount3 = document.getElementById('payment-gcash-amount-3')?.value.trim() || '';
        if (amount3) formData.append('gcash_amount_screenshot_3', amount3);
      }

      // Belt-and-suspenders: the Submit button is already disabled client-side
      // until the amount covers the required total (see _updatePaymentSubmitState),
      // but re-check here in case state got stale.
      const requiredAmount = parseFloat((document.getElementById('payment-gcash-amount')?.dataset.required || '').replace(/,/g, ''));
      const paidAmount = parseFloat(amountPaid.replace(/,/g, ''));
      if (!amountPaid || isNaN(paidAmount) || (!isNaN(requiredAmount) && paidAmount + 0.01 < requiredAmount)) {
        showToast('The amount paid must cover the full amount required for this plan/promo before you can submit.', 'error');
        return;
      }

      confirmText = 'Are you sure you want to submit this GCash payment for verification?';
    }

    _pendingPaymentMethod = { formData };
    document.getElementById('confirm-payment-text').textContent = confirmText;
    openModal('confirm-payment-modal');
  }

  function cancelSubmitPayment() {
    closeModal('confirm-payment-modal');
  }

  function confirmSubmitPayment() {
    if (!_pendingPaymentMethod) { closeModal('confirm-payment-modal'); return; }

    showLoadingOverlay('Submitting your payment...');
    _apiForm('/member/submit-payment-method', _pendingPaymentMethod.formData)
      .then(({ ok, data }) => {
        hideLoadingOverlay();
        closeModal('confirm-payment-modal');
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to submit payment.', 'error');
          return;
        }
        _pendingPaymentMethod = null;
        const msg = document.getElementById('payment-submit-success-message');
        if (msg) msg.textContent = data.message || 'You have successfully submitted your payment. Please wait for admin\'s approval.';
        openModal('payment-submit-success-modal');
      })
      .catch(() => {
        hideLoadingOverlay();
        closeModal('confirm-payment-modal');
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  function closePaymentSubmitSuccessModal() {
    closeModal('payment-submit-success-modal');
    window.location.reload();
  }

  /* ════════════════════════════════════════════════
     MY ATTENDANCE — month navigation
  ════════════════════════════════════════════════ */

  function _updateAttNavButtons() {
    const nextBtn = document.getElementById('attendance-next-month');
    if (nextBtn) {
      const atCurrent = (_attYear === _attCurrentYear && _attMonth === _attCurrentMonth);
      nextBtn.disabled = atCurrent;
    }
  }

  function changeAttendanceMonth(delta) {
    let year = _attYear, month = _attMonth + delta;
    if (month < 1) { month = 12; year -= 1; }
    if (month > 12) { month = 1; year += 1; }

    // Never navigate past the real current month.
    if (year > _attCurrentYear || (year === _attCurrentYear && month > _attCurrentMonth)) return;

    fetch(`/member/attendance-month?year=${year}&month=${month}`)
      .then(res => res.json())
      .then(data => {
        if (!data.success) {
          showToast(data.error || 'Could not load that month.', 'error');
          return;
        }
        _attYear = data.year;
        _attMonth = data.month;

        const label = document.getElementById('attendance-month-label');
        if (label) label.textContent = data.month_label;

        if (typeof buildAttGrid === 'function') {
          buildAttGrid('att-grid-member', data.present_days || [], data.days_in_month || 30,
            data.today_day, data.no_plan_days || [], data.year, data.month);
        }

        const body = document.getElementById('attendance-session-history-body');
        if (body) {
          const rows = data.session_history || [];
          // On a session-based promo an extra column shows which visits were
          // coach-guided (counted as a session) and which were free open-gym use.
          const withType = !!data.sessions_enabled;
          const typeCell = s => withType
            ? '<td>' + (s.coach_guided
                ? '<span class="badge badge-green">COACH SESSION</span>'
                : '<span class="badge badge-blue">OPEN GYM · FREE</span>') + '</td>'
            : '';
          body.innerHTML = rows.length
            ? rows.map(s => `<tr><td>${_esc(s.date)}</td><td>${_esc(s.check_in)}</td><td>${_esc(s.check_out)}</td><td>${_esc(s.duration)}</td>${typeCell(s)}</tr>`).join('')
            : `<tr><td colspan="${withType ? 5 : 4}" style="text-align:center;color:var(--muted);">No sessions logged this month yet.</td></tr>`;
          const typeTh = document.getElementById('attendance-type-th');
          if (typeTh) typeTh.style.display = withType ? '' : 'none';
        }

        _updateAttNavButtons();
      })
      .catch(() => showToast('Could not reach the server. Please try again.', 'error'));
  }

  /* ════════════════════════════════════════════════
     GYM SERVICES — service detail modal
  ════════════════════════════════════════════════ */

  function openServiceModal(id) {
    const svc = _servicesById[id];
    if (!svc) return;

    document.getElementById('service-modal-icon').textContent = svc.icon || '🛎️';
    document.getElementById('service-modal-title').textContent = (svc.name || 'SERVICE').toUpperCase();
    document.getElementById('service-modal-subtitle').textContent = svc.description || '';

    const list = document.getElementById('service-modal-list');
    if (list) {
      const items = svc.equipment || [];
      list.innerHTML = items.length
        ? items.map(e => `<li>${e.icon || '🏋️'} ${_esc(e.name)}</li>`).join('')
        : '<li>No specific equipment required.</li>';
    }

    openModal('service-modal');
  }

  /* ════════════════════════════════════════════════
     GYM MACHINES/EQUIPMENT — how-to-use guide modal
  ════════════════════════════════════════════════ */

  function openEquipmentModal(id) {
    const eq = _equipmentById[id];
    if (!eq) return;

    const imgWrap = document.getElementById('equipment-modal-image-wrap');
    const img     = document.getElementById('equipment-modal-image');
    const iconEl  = document.getElementById('equipment-modal-icon');

    if (eq.image_path) {
      img.src = eq.image_path;
      img.alt = eq.name || 'Equipment guide photo';
      imgWrap.style.display = '';
      iconEl.style.display = 'none';
    } else {
      imgWrap.style.display = 'none';
      iconEl.textContent = eq.icon || '🏋️';
      iconEl.style.display = '';
    }

    document.getElementById('equipment-modal-title').textContent = (eq.name || 'EQUIPMENT').toUpperCase();
    document.getElementById('equipment-modal-category').textContent = eq.category || '';

    const descEl = document.getElementById('equipment-modal-description');
    if (descEl) {
      descEl.textContent = eq.description
        ? eq.description
        : 'No usage guide has been added for this equipment yet.';
    }

    openModal('equipment-guide-modal');
  }

  function openExerciseInstructionsModal(exerciseId) {
    const ex = _exercisesById[exerciseId];
    if (!ex) return;

    document.getElementById('exercise-instructions-modal-title').textContent = (ex.name || 'EXERCISE').toUpperCase();
    const subParts = [ex.target_area, ex.sub_target].filter(Boolean);
    document.getElementById('exercise-instructions-modal-subtitle').textContent = subParts.join(' · ');

    const videoEl = document.getElementById('exercise-modal-video');
    const imageEl = document.getElementById('exercise-modal-image');
    const mediaUrl = (ex.media_url && typeof ex.media_url === 'string') ? ex.media_url.trim() : '';

    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.style.display = 'none';
    }
    if (imageEl) {
      imageEl.removeAttribute('src');
      imageEl.style.display = 'none';
    }

    if (mediaUrl) {
      const isVideo = /\.(mp4|webm)$/i.test(mediaUrl);
      const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(mediaUrl);
      if (isVideo && videoEl) {
        videoEl.src = mediaUrl;
        videoEl.style.display = 'block';
        videoEl.play().catch(() => {});
      } else if (isImage && imageEl) {
        imageEl.src = mediaUrl;
        imageEl.style.display = 'block';
      }
    }

    const list = document.getElementById('exercise-instructions-modal-steps');
    if (list) {
      const steps = (ex.instructions || '').split('\n').map(s => s.trim()).filter(Boolean);
      list.innerHTML = steps.length
        ? steps.map(s => `<li>${_esc(s.replace(/^(\d+[\.\)\-]\s*)+/, ''))}</li>`).join('')
        : '<li>No detailed instructions available for this exercise yet.</li>';
    }

    openModal('exercise-instructions-modal');
  }

  /* ════════════════════════════════════════════════
     BODY GOALS — Fitness Goal Setup wizard (2 Steps)
     + Personalized Fitness Plan (Stage 4)
  ════════════════════════════════════════════════ */

  let _step1Completed = false;
  let _step2Completed = false;
  let _isMinor = false;

  function updateActivityHelperText() {
    const sel = document.getElementById('fw-activity');
    const helper = document.getElementById('fw-activity-helper');
    if (!helper) return;
    const val = sel ? sel.value : '';
    const descMap = {
      low_activity: 'Little to no exercise, or light activity 1–3 days/week.',
      moderate_activity: 'Regular exercise 3–5 days/week.',
      high_activity: 'Frequent, intense exercise or physically demanding work 6–7 days/week.',
    };
    helper.textContent = descMap[val] || 'Select your typical weekly activity level.';
  }

  function _setWizardStep(step) {
    const p1 = document.getElementById('fw-step-1');
    const p2 = document.getElementById('fw-step-2');
    const pLoad = document.getElementById('fw-loading-screen');
    const wizardPanel = document.getElementById('fitness-wizard-panel');

    if (wizardPanel) wizardPanel.style.display = '';

    if (p1) p1.style.display = (step === 1 ? '' : 'none');
    if (p2) p2.style.display = (step === 2 ? '' : 'none');
    if (pLoad) pLoad.style.display = (step === 'loading' ? '' : 'none');

    const dot1 = document.getElementById('fw-dot-1');
    const dot2 = document.getElementById('fw-dot-2');
    const line1 = document.getElementById('fw-line-1');

    if (step === 1) {
      if (dot1) {
        dot1.classList.add('active');
        dot1.setAttribute('aria-current', 'step');
      }
      if (dot2) {
        dot2.classList.remove('active');
        dot2.removeAttribute('aria-current');
      }
      if (line1) {
        line1.classList.toggle('active', _step1Completed);
      }
    } else if (step === 2) {
      if (dot1) {
        dot1.classList.remove('active');
        dot1.classList.add('complete', 'completed');
        dot1.disabled = false;
        dot1.removeAttribute('aria-current');
      }
      if (dot2) {
        dot2.classList.add('active');
        dot2.disabled = false;
        dot2.setAttribute('aria-current', 'step');
      }
      if (line1) {
        line1.classList.add('active');
      }
      const helperLine = document.querySelector('.fw-goal-helper-line');
      if (helperLine) {
        if (_isMinor) {
          helperLine.textContent = 'Your focus prioritizes exercises for that muscle group onto your training days (e.g. Chest packs your Chest & Legs days with pressing movements, while Abs & Core fills your Shoulders & Core days with core work).';
        } else {
          helperLine.textContent = 'Your focus prioritizes exercises for that muscle group onto your training days (e.g. Chest packs your Chest & Legs days with pressing movements, while Abs & Core fills your Shoulders & Core days with core work), and tailors your daily calorie target.';
        }
      }
    } else if (step === 'loading') {
      if (dot1) dot1.classList.remove('active');
      if (dot2) dot2.classList.remove('active');
    }
  }

  function goToFitnessStep(step) {
    if (step === 1) {
      _setWizardStep(1);
    } else if (step === 2 && _step1Completed) {
      _setWizardStep(2);
    }
  }

  function _initFitnessWizard() {
    const data = _parseJSON('member-fitness-data') || {};
    _isMinor = Boolean(data.is_minor) || (!data.age || data.age < 18);

    if (data.primary_objective) {
      _primaryObjective = data.primary_objective;
    } else {
      _primaryObjective = 'MAINTAIN';
    }

    // Set initial selection on primary objective cards
    document.querySelectorAll('.fw-objective-card').forEach(objCard => {
      const isMatch = objCard.getAttribute('data-obj') === _primaryObjective;
      objCard.classList.toggle('selected', isMatch);
      objCard.setAttribute('aria-checked', isMatch ? 'true' : 'false');
    });

    if (data.fitness_goal) {
      _fitnessGoal = data.fitness_goal;
      const radio = document.querySelector(`input[name="fitness_goal"][value="${data.fitness_goal}"]`);
      if (radio) radio.checked = true;
      const card = document.querySelector(`#fw-goal-grid [data-goal="${data.fitness_goal}"]`);
      if (card) {
        card.classList.add('selected');
        const ind = card.querySelector('.workout-select-indicator');
        if (ind) ind.textContent = '✓';
      }
    }

    const btn = document.getElementById('fw-step2-btn');
    if (btn) btn.disabled = !(_primaryObjective && _fitnessGoal);

    if (data.height_cm && data.weight_kg && data.sex && data.activity_level) {
      _step1Completed = true;
      const dot2 = document.getElementById('fw-dot-2');
      if (dot2) dot2.disabled = false;
    }

    updateActivityHelperText();

    // Bind tab bar arrow key navigation for accessible tabs
    _bindTabListKeyboard(document.querySelector('.fp-tabs'), '.fp-tab-btn');
    _bindGoalGridKeyboard();
    _bindObjectiveGridKeyboard();

    if (data.fitness_goal && data.calculations) {
      _step2Completed = true;
      _renderFitnessResults(data.calculations, data.fitness_goal, _isMinor, data.primary_objective || _primaryObjective);
      const wizardPanel = document.getElementById('fitness-wizard-panel');
      if (wizardPanel) wizardPanel.style.display = 'none';
      const planPanel = document.getElementById('fitness-plan-panel');
      if (planPanel) planPanel.style.display = '';
      const editBtn = document.getElementById('fw-edit-btn');
      if (editBtn) editBtn.style.display = '';
      _loadFitnessPlan();
    } else {
      _setWizardStep(1);
    }
  }

  function submitFitnessStep1() {
    const height = document.getElementById('fw-height')?.value;
    const weight = document.getElementById('fw-weight')?.value;
    const sex = document.getElementById('fw-sex')?.value;
    const activity = document.getElementById('fw-activity')?.value;
    const bdayInput = document.getElementById('fw-birthday');
    const birthday = bdayInput ? bdayInput.value : '';
    const goalWeightInput = document.getElementById('fw-goal-weight');
    const goalWeight = goalWeightInput ? parseFloat(goalWeightInput.value) : null;

    if (!height || !weight) { showToast('Please enter your height and weight.', 'error'); return; }
    if (!sex) { showToast('Please select your sex.', 'error'); return; }
    if (!activity) { showToast('Please select your activity level.', 'error'); return; }
    if (bdayInput && !birthday) {
      showToast('Please enter your birthday.', 'error');
      bdayInput.focus();
      return;
    }

    const btn = document.getElementById('fw-step1-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'SAVING...'; }

    const payload = {
      height_cm: height,
      weight_kg: weight,
      sex,
      activity_level: activity,
    };
    if (birthday) {
      payload.birthday = birthday;
    }
    if (goalWeight && !isNaN(goalWeight)) {
      payload.goal_weight_kg = goalWeight;
    }

    _apiJson('/member/fitness/save-profile', payload).then(({ ok, data }) => {
      if (btn) { btn.disabled = false; btn.textContent = 'CONTINUE'; }
      if (!ok || !data.success) {
        showToast(data.error || 'Failed to save your information.', 'error');
        return;
      }
      _step1Completed = true;
      if (data.fitness_profile && data.fitness_profile.is_minor !== undefined) {
        _isMinor = Boolean(data.fitness_profile.is_minor);
      }
      const dot2 = document.getElementById('fw-dot-2');
      if (dot2) dot2.disabled = false;
      _setWizardStep(2);
    }).catch(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'CONTINUE'; }
      showToast('Could not reach the server. Please try again.', 'error');
    });
  }

  function selectPrimaryObjective(code, el) {
    if (!code) return;
    _primaryObjective = code;
    document.querySelectorAll('.fw-objective-card').forEach(c => {
      const isMatch = c.getAttribute('data-obj') === code;
      c.classList.toggle('selected', isMatch);
      c.setAttribute('aria-checked', isMatch ? 'true' : 'false');
    });

    const btn = document.getElementById('fw-step2-btn');
    if (btn) btn.disabled = !(_primaryObjective && _fitnessGoal);
  }

  function onFitnessGoalRadioChange(radio) {
    if (!radio) return;
    _fitnessGoal = radio.value;
    document.querySelectorAll('#fw-goal-grid .workout-goal-card').forEach(c => {
      c.classList.remove('selected');
      c.setAttribute('tabindex', '-1');
      const ind = c.querySelector('.workout-select-indicator');
      if (ind) ind.textContent = '➔';
    });
    const card = radio.closest('.workout-goal-card');
    if (card) {
      card.classList.add('selected');
      card.setAttribute('tabindex', '0');
      const ind = card.querySelector('.workout-select-indicator');
      if (ind) ind.textContent = '✓';
    }

    const btn = document.getElementById('fw-step2-btn');
    if (btn) btn.disabled = !(_primaryObjective && _fitnessGoal);
  }

  function selectFitnessGoal(card) {
    if (!card) return;
    const radio = card.querySelector('input[type="radio"]');
    if (radio) {
      radio.checked = true;
      onFitnessGoalRadioChange(radio);
    }
  }

  function selectFitnessGoalByCode(goalCode) {
    const card = document.querySelector(`#fw-goal-grid [data-goal="${goalCode}"]`);
    if (card) {
      selectFitnessGoal(card);
      try {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (_) {}
    }
  }

  function selectObjectiveCard(code, el) {
    // Backward compatibility wrapper
    if (['CUT', 'BULK', 'MAINTAIN', 'RECOMP'].includes(code)) {
      selectPrimaryObjective(code, el);
    } else {
      selectFitnessGoalByCode(code);
    }
  }

  function _bindObjectiveGridKeyboard() {
    const cards = Array.from(document.querySelectorAll('.fw-objective-card'));
    if (!cards.length) return;
    cards.forEach((card, idx) => {
      card.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault();
          const nextIdx = (idx + 1) % cards.length;
          cards[nextIdx].focus();
          selectPrimaryObjective(cards[nextIdx].getAttribute('data-obj'), cards[nextIdx]);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const prevIdx = (idx - 1 + cards.length) % cards.length;
          cards[prevIdx].focus();
          selectPrimaryObjective(cards[prevIdx].getAttribute('data-obj'), cards[prevIdx]);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectPrimaryObjective(card.getAttribute('data-obj'), card);
        }
      });
    });
  }

  function _bindGoalGridKeyboard() {
    const grid = document.getElementById('fw-goal-grid');
    if (!grid) return;

    const cards = Array.from(grid.querySelectorAll('.workout-goal-card'));
    cards.forEach((card, idx) => {
      card.setAttribute('tabindex', card.classList.contains('selected') ? '0' : (idx === 0 ? '0' : '-1'));

      card.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault();
          const nextIdx = (idx + 1) % cards.length;
          cards.forEach(c => c.setAttribute('tabindex', '-1'));
          cards[nextIdx].setAttribute('tabindex', '0');
          cards[nextIdx].focus();
          selectFitnessGoal(cards[nextIdx]);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const prevIdx = (idx - 1 + cards.length) % cards.length;
          cards.forEach(c => c.setAttribute('tabindex', '-1'));
          cards[prevIdx].setAttribute('tabindex', '0');
          cards[prevIdx].focus();
          selectFitnessGoal(cards[prevIdx]);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectFitnessGoal(card);
        }
      });
    });
  }

  function fitnessWizardBack() {
    _setWizardStep(1);
  }

  function submitFitnessStep2() {
    if (!_primaryObjective) { showToast('Please select your primary objective.', 'error'); return; }
    if (!_fitnessGoal) { showToast('Please select your workout focus.', 'error'); return; }
    _startPlanBuildingSequence();
  }

  function _setTickerState(idx, state, text) {
    const item = document.getElementById(`fw-ticker-${idx}`);
    if (!item) return;
    item.classList.remove('active', 'pending', 'complete');
    item.classList.add(state);
    const icon = item.querySelector('.fw-ticker-icon');
    const label = item.querySelector('.fw-ticker-text');
    if (text && label) label.textContent = text;
    if (icon) {
      if (state === 'complete') icon.textContent = '✓';
      else if (state === 'active') icon.textContent = '⏳';
      else icon.textContent = '⏳';
    }
  }

  function _startPlanBuildingSequence() {
    _setWizardStep('loading');
    const errEl = document.getElementById('fw-loading-error');
    const retryBtn = document.getElementById('fw-loading-retry-btn');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (retryBtn) retryBtn.style.display = 'none';

    _setTickerState(1, 'active', 'Saving your focus...');
    _setTickerState(2, 'pending', 'Calculating your targets');
    _setTickerState(3, 'pending', 'Loading your plan');

    // 1. Save focus & objective
    _apiJson('/member/fitness/save-goal', {
      fitness_goal: _fitnessGoal,
      primary_objective: _primaryObjective
    })
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          throw new Error(data.error || 'Failed to save your focus.');
        }
        _setTickerState(1, 'complete', 'Saved your focus');
        _setTickerState(2, 'active', 'Calculating your targets...');

        // 2. Calculate targets
        return _apiJson('/member/fitness/calculate', {});
      })
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          throw new Error(data.error || 'Could not calculate your targets.');
        }

        // Update local script tag cache
        const fitScript = document.getElementById('member-fitness-data');
        if (fitScript) {
          try {
            const fd = JSON.parse(fitScript.textContent);
            fd.primary_objective = data.primary_objective || _primaryObjective;
            fd.fitness_goal = data.goal || _fitnessGoal;
            fd.calculations = data.calculations;
            fitScript.textContent = JSON.stringify(fd);
          } catch (e) {}
        }

        _renderFitnessResults(data.calculations, data.goal, _isMinor, data.primary_objective || _primaryObjective);
        _setTickerState(2, 'complete', 'Calculated your targets');
        _setTickerState(3, 'active', 'Loading your plan...');

        // 3. Load plan recommendations
        return fetch('/member/fitness/recommendations').then(res => res.json());
      })
      .then(recData => {
        if (!recData || !recData.success) {
          throw new Error((recData && recData.error) || 'Could not load your plan recommendations.');
        }
        _renderFitnessPlan(recData);
        _setTickerState(3, 'complete', 'Loaded your plan');

        _step2Completed = true;
        setTimeout(() => {
          const wizardPanel = document.getElementById('fitness-wizard-panel');
          if (wizardPanel) wizardPanel.style.display = 'none';
          const planPanel = document.getElementById('fitness-plan-panel');
          if (planPanel) planPanel.style.display = '';
          const editBtn = document.getElementById('fw-edit-btn');
          if (editBtn) editBtn.style.display = '';
          _loadAiCoachMessage();
        }, 350);
      })
      .catch(err => {
        const msg = err.message || 'An error occurred while building your plan.';
        if (errEl) {
          errEl.textContent = msg;
          errEl.style.display = 'block';
        }
        if (retryBtn) retryBtn.style.display = 'inline-block';
      });
  }

  function retryFitnessSetup() {
    _startPlanBuildingSequence();
  }

  function editFitnessProfileAndFocus() {
    const wizardPanel = document.getElementById('fitness-wizard-panel');
    const planPanel = document.getElementById('fitness-plan-panel');
    const editBtn = document.getElementById('fw-edit-btn');

    if (planPanel) planPanel.style.display = 'none';
    if (wizardPanel) wizardPanel.style.display = '';
    if (editBtn) editBtn.style.display = 'none';

    // Show cancel button only when editing an existing plan (not first-time setup)
    const cancelBtn = document.getElementById('fw-cancel-edit-btn');
    if (cancelBtn) cancelBtn.style.display = _step2Completed ? '' : 'none';

    _setWizardStep(1);
  }

  function cancelFitnessEdit() {
    const wizardPanel = document.getElementById('fitness-wizard-panel');
    const planPanel   = document.getElementById('fitness-plan-panel');
    const editBtn     = document.getElementById('fw-edit-btn');
    const cancelBtn   = document.getElementById('fw-cancel-edit-btn');

    if (wizardPanel) wizardPanel.style.display = 'none';
    if (planPanel)   planPanel.style.display   = '';
    if (editBtn)     editBtn.style.display      = '';
    if (cancelBtn)   cancelBtn.style.display    = 'none';
  }

  function _updateMilestoneBar(startW, curW, goalW) {
    const milestoneRow = document.getElementById('fw-hub-milestone-row');
    if (!milestoneRow) return;
    if (goalW != null && curW != null && startW != null) {
      milestoneRow.style.display = '';
      const totalChange = parseFloat(goalW) - parseFloat(startW);
      let pct = 0;
      if (Math.abs(totalChange) < 0.1) {
        pct = 100;
      } else {
        const actualChange = parseFloat(curW) - parseFloat(startW);
        const ratio = actualChange / totalChange;
        pct = Math.round(ratio * 100);
        pct = Math.max(0, Math.min(100, pct));
      }
      const fill = document.getElementById('fw-hub-milestone-fill');
      if (fill) fill.style.width = `${pct}%`;
      _setText('fw-hub-start-label', `Start: ${startW} kg`);
      _setText('fw-hub-goal-label', `Goal: ${goalW} kg`);
      _setText('fw-hub-progress-label', `${pct}% to goal`);
    } else {
      milestoneRow.style.display = 'none';
    }
  }

  function _renderFitnessResults(calc, goal, isMinor, primaryObjective) {
    const fitData = _parseJSON('member-fitness-data') || {};
    const obj = primaryObjective || fitData.primary_objective || _primaryObjective || 'MAINTAIN';
    const objLabel = OBJECTIVE_LABELS[obj] || obj;
    const goalLabel = GOAL_LABELS[goal] || goal;

    _setText('fp-target-calories', calc.calorie_target != null ? `${calc.calorie_target} kcal` : '—');
    _setText('fp-target-protein', calc.protein_target_g != null ? `${calc.protein_target_g} g` : '—');
    _setText('fp-daily-obj-label', objLabel);
    _setText('fp-daily-goal-label', goalLabel);

    _setText('fw-hub-obj-badge', objLabel);
    _setText('fw-hub-focus-badge', goalLabel);

    const act = fitData.activity_level;
    _setText('fp-daily-activity-label', ACTIVITY_LABELS[act] || 'Active');

    // How we calculated this section (native details)
    const bmiRow = document.getElementById('fw-calc-bmi-row');
    if (isMinor) {
      if (bmiRow) bmiRow.style.display = 'none';
    } else {
      if (bmiRow) bmiRow.style.display = '';
      const calcBmiEl = document.getElementById('fw-calc-bmi');
      if (calcBmiEl && calc.bmi != null) {
        calcBmiEl.textContent = calc.bmi;
        const bVal = parseFloat(calc.bmi);
        calcBmiEl.style.color = (!isNaN(bVal) && bVal >= 18.5 && bVal <= 24.9) ? 'var(--green)' : 'var(--white)';
      }
    }
    _setText('fw-calc-bmr', calc.bmr != null ? `${calc.bmr} kcal` : '—');
    _setText('fw-calc-tdee', calc.tdee != null ? `${calc.tdee} kcal` : '—');

    // Current Measurements panel
    const weightEl = document.getElementById('meas-weight');
    if (weightEl) {
      const w = fitData.weight_kg || document.getElementById('fw-weight')?.value;
      weightEl.textContent = w ? `${w} kg` : '— kg';
    }
    const measBmiItem = document.getElementById('meas-bmi-item');
    if (measBmiItem) {
      if (isMinor) {
        measBmiItem.style.display = 'none';
      } else {
        measBmiItem.style.display = '';
        const measBmiVal = document.getElementById('meas-bmi');
        if (measBmiVal && calc.bmi != null) {
          measBmiVal.textContent = calc.bmi;
          const bVal = parseFloat(calc.bmi);
          measBmiVal.style.color = (!isNaN(bVal) && bVal >= 18.5 && bVal <= 24.9) ? 'var(--green)' : 'var(--white)';
        }
      }
    }

    // Nutrition tab
    _setText('fp-nutrition-calorie', calc.calorie_target != null ? `${calc.calorie_target} kcal` : '—');
    _setText('fp-nutrition-protein', calc.protein_target_g != null ? `${calc.protein_target_g} g` : '—');
    _updateMacroSplit(calc.calorie_target, calc.protein_target_g);

    // ── Hub Header metric chips ──
    const curW = fitData.weight_kg || document.getElementById('fw-weight')?.value;
    _setText('fw-hub-weight', curW ? `${curW} kg` : '—');
    _setText('fw-hub-calories', calc.calorie_target != null ? `${calc.calorie_target} kcal` : '—');
    _setText('fw-hub-protein', calc.protein_target_g != null ? `${calc.protein_target_g} g` : '—');

    const bmiChip = document.getElementById('fw-hub-bmi-chip');
    if (bmiChip) {
      if (!isMinor && calc.bmi != null) {
        bmiChip.style.display = '';
        const bmiVal = parseFloat(calc.bmi);
        let bmiLabel = 'BMI';
        let isHealthy = false;
        if (!isNaN(bmiVal)) {
          if (bmiVal >= 18.5 && bmiVal <= 24.9) {
            bmiLabel = 'BMI (Healthy)';
            isHealthy = true;
          } else if (bmiVal < 18.5) {
            bmiLabel = 'BMI (Under)';
          } else if (bmiVal <= 29.9) {
            bmiLabel = 'BMI (Over)';
          } else {
            bmiLabel = 'BMI (High)';
          }
        }
        const valEl = document.getElementById('fw-hub-bmi');
        if (valEl) {
          valEl.textContent = calc.bmi;
          valEl.style.color = isHealthy ? 'var(--green)' : 'var(--white)';
        }
        const lblEl = bmiChip.querySelector('.fw-metric-lbl');
        if (lblEl) {
          lblEl.textContent = bmiLabel;
          lblEl.style.color = isHealthy ? 'var(--green)' : '';
        }
      } else {
        bmiChip.style.display = 'none';
      }
    }

    // ── Hub Header milestone bar (only shown when goal weight is set) ──
    const goalW = fitData.goal_weight;
    const startW = fitData.calculated_weight || curW;
    _updateMilestoneBar(startW, curW, goalW);

    const contentEl = document.getElementById('fp-plan-content');
    if (contentEl) contentEl.style.display = '';
  }

  function _loadAiCoachMessage() {
    const banner = document.getElementById('ai-coach-message');
    if (!banner) return;

    banner.classList.add('loading');
    banner.style.display = 'block';
    banner.innerHTML = `
      <div class="ai-banner-skeleton">
        <div class="ai-skeleton-line"></div>
        <div class="ai-skeleton-line short"></div>
      </div>`;

    fetch('/member/fitness/ai-coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(res => res.json())
      .then(data => {
        banner.classList.remove('loading');
        if (!data || !data.success || !data.message) {
          banner.style.display = 'none';
          banner.innerHTML = '';
          return;
        }
        banner.style.display = 'block';
        banner.innerHTML = `
          <div class="ai-banner-header">
            <span class="ai-banner-icon" aria-hidden="true">🏋️</span>
            <span class="ai-banner-label">COACH NOTE</span>
          </div>
          <div class="ai-banner-text">${_esc(data.message)}</div>
        `;
      })
      .catch(() => {
        banner.classList.remove('loading');
        banner.style.display = 'none';
        banner.innerHTML = '';
      });
  }

  function _loadFitnessPlan() {
    const panel = document.getElementById('fitness-plan-panel');
    const statusEl = document.getElementById('fp-status-message');
    const contentEl = document.getElementById('fp-plan-content');
    if (!panel) return;

    panel.style.display = '';
    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Loading your personalized plan...'; }
    if (contentEl) contentEl.style.display = 'none';

    fetch('/member/fitness/recommendations')
      .then(res => res.json())
      .then(data => {
        if (!data || !data.success) {
          if (statusEl) statusEl.textContent = (data && data.error) || 'Your plan could not be loaded right now.';
          return;
        }
        _renderFitnessPlan(data);
        if (statusEl) statusEl.style.display = 'none';
        if (contentEl) contentEl.style.display = '';
        _loadAiCoachMessage();
      })
      .catch(() => {
        if (statusEl) statusEl.textContent = 'Could not reach the server. Please try again.';
      });
  }

  function _renderFitnessPlan(data) {
    const contentEl = document.getElementById('fp-plan-content');
    if (contentEl) contentEl.style.display = '';

    if (data.nutrition_targets) {
      _setText('fp-nutrition-calorie', data.nutrition_targets.calorie_target ? `${data.nutrition_targets.calorie_target} kcal` : '—');
      _setText('fp-nutrition-protein', data.nutrition_targets.protein_target_g ? `${data.nutrition_targets.protein_target_g} g` : '—');
    }

    // Foods & Meals
    _renderMealPlan(data.meal_plan);

    // Workouts (day-by-day)
    _renderWeeklyRoutine(data.weekly_routine, data.workouts);

    // Equipment
    const eqList = document.getElementById('fp-equipment-list');
    if (eqList) {
      const eq = data.equipment || [];
      eqList.innerHTML = eq.length
        ? eq.map(e => `<div class="fp-card"><div class="fp-card-title">🧰 ${_esc(e.name)}</div>${e.note ? `<div class="fp-card-note">${_esc(e.note)}</div>` : ''}</div>`).join('')
        : '<div style="color:var(--goals-muted, var(--muted));">No specific equipment needed.</div>';
    }

    // Tips
    const tipsList = document.getElementById('fp-tips-list');
    if (tipsList) {
      const tips = data.tips || [];
      tipsList.innerHTML = tips.length
        ? tips.map(t => `<li>${_esc(t)}</li>`).join('')
        : '<li>Stay consistent and listen to your body.</li>';
    }

    // Default to Workouts tab
    switchFitnessPlanTab('workouts', document.querySelector('[data-fp-tab="workouts"]'));
  }

  const FOOD_META = {
    'Whole Eggs': { icon: '🥚', category: 'protein' },
    'Egg Whites': { icon: '🍳', category: 'protein' },
    'Grilled Chicken Breast': { icon: '🍗', category: 'protein' },
    'Canned Tuna': { icon: '🐟', category: 'protein' },
    'Lean Beef (Sirloin)': { icon: '🥩', category: 'protein' },
    'Greek Yogurt': { icon: '🥛', category: 'protein' },
    'Low-Fat Milk': { icon: '🥛', category: 'protein' },
    'Firm Tofu': { icon: '🧊', category: 'protein' },
    'Cooked Lentils': { icon: '🫘', category: 'protein' },
    'Whey Protein Shake': { icon: '🥤', category: 'protein' },
    'Steamed Rice': { icon: '🍚', category: 'carbs' },
    'Brown Rice': { icon: '🍚', category: 'carbs' },
    'Oatmeal': { icon: '🥣', category: 'carbs' },
    'Sweet Potato (Kamote)': { icon: '🍠', category: 'carbs' },
    'Whole Wheat Bread': { icon: '🍞', category: 'carbs' },
    'Whole-Wheat Pasta': { icon: '🍝', category: 'carbs' },
    'Banana': { icon: '🍌', category: 'produce' },
    'Apple': { icon: '🍎', category: 'produce' },
    'Mango (sliced)': { icon: '🥭', category: 'produce' },
    'Orange': { icon: '🍊', category: 'produce' },
    'Steamed Mixed Vegetables': { icon: '🥦', category: 'produce' },
    'Sautéed Leafy Greens': { icon: '🥬', category: 'produce' },
    'Mixed Salad Greens': { icon: '🥗', category: 'produce' },
    'Peanut Butter': { icon: '🥜', category: 'fats' },
    'Avocado': { icon: '🥑', category: 'fats' },
    'Mixed Nuts / Almonds': { icon: '🥜', category: 'fats' },
    'Olive Oil (for cooking)': { icon: '🫒', category: 'fats' },
  };

  function _getFoodMeta(name, category) {
    if (FOOD_META[name]) return FOOD_META[name];
    const lower = (name || '').toLowerCase();
    const cat = (category || '').toLowerCase();
    if (cat === 'protein' || /chicken|beef|egg|tuna|fish|tofu|lentil|protein|turkey|salmon/i.test(lower)) {
      return { icon: '🍗', category: 'protein' };
    }
    if (cat === 'carb' || /rice|oat|bread|pasta|potato|quinoa|cereal/i.test(lower)) {
      return { icon: '🌾', category: 'carbs' };
    }
    if (cat === 'healthy_fat' || cat === 'fats' || /oil|butter|nut|almond|avocado|seed/i.test(lower)) {
      return { icon: '🥑', category: 'fats' };
    }
    if (cat === 'fruit' || cat === 'vegetable' || /apple|banana|mango|orange|berry|greens|salad|vegetable|spinach|broccoli/i.test(lower)) {
      return { icon: '🍎', category: 'produce' };
    }
    return { icon: '🥗', category: 'produce' };
  }

  function _updateMacroSplit(totalCal, totalPro) {
    const cal = Number(totalCal) || 2000;
    const pro = Number(totalPro) || 100;

    const proCal = pro * 4;
    const proPct = Math.max(12, Math.min(40, Math.round((proCal / cal) * 100)));
    const fatPct = 28;
    const carbPct = Math.max(15, 100 - proPct - fatPct);

    const fatCal = cal * (fatPct / 100);
    const fatG = Math.round(fatCal / 9);

    const carbCal = cal * (carbPct / 100);
    const carbG = Math.round(carbCal / 4);

    _setText('fp-macro-pct-protein', `${proPct}%`);
    _setText('fp-macro-g-protein', `(${pro}g)`);
    _setText('fp-macro-pct-carbs', `${carbPct}%`);
    _setText('fp-macro-g-carbs', `(${carbG}g)`);
    _setText('fp-macro-pct-fats', `${fatPct}%`);
    _setText('fp-macro-g-fats', `(${fatG}g)`);

    const segPro = document.getElementById('fp-split-seg-pro');
    const segCarb = document.getElementById('fp-split-seg-carb');
    const segFat = document.getElementById('fp-split-seg-fat');
    if (segPro) segPro.style.width = `${proPct}%`;
    if (segCarb) segCarb.style.width = `${carbPct}%`;
    if (segFat) segFat.style.width = `${fatPct}%`;
  }

  function _renderMealPlan(mealPlan) {
    const foodsList = document.getElementById('fp-foods-list');
    const mealPlanEl = document.getElementById('fp-meal-plan');
    const totalEl = document.getElementById('fp-meal-plan-total');
    const allocBarEl = document.getElementById('fp-meal-alloc-bar');

    if (!mealPlan || !mealPlan.meals) {
      if (foodsList) foodsList.innerHTML = '<div style="color:var(--goals-muted, var(--muted));">No recommendations available yet.</div>';
      if (mealPlanEl) mealPlanEl.innerHTML = '';
      if (totalEl) totalEl.textContent = '';
      if (allocBarEl) allocBarEl.innerHTML = '';
      return;
    }

    const totalCal = Number(mealPlan.total_calories) || 2000;
    const totalPro = Number(mealPlan.total_protein_g) || 100;

    _updateMacroSplit(totalCal, totalPro);

    const mealOrder = ['breakfast', 'lunch', 'snack', 'dinner'];
    const mealMeta = {
      breakfast: { label: 'Breakfast', icon: '🍳', color: '#ffc107' },
      lunch: { label: 'Lunch', icon: '🥗', color: '#10b981' },
      snack: { label: 'Afternoon Snack', icon: '🥜', color: '#f59e0b' },
      dinner: { label: 'Dinner', icon: '🥩', color: '#e61e25' }
    };

    const seenFoods = new Map();
    mealOrder.forEach(key => {
      const meal = mealPlan.meals[key];
      if (!meal) return;
      (meal.items || []).forEach(item => {
        if (!seenFoods.has(item.name)) seenFoods.set(item.name, item);
      });
    });

    if (foodsList) {
      const foods = Array.from(seenFoods.values());
      foodsList.innerHTML = foods.length
        ? foods.map(f => {
            const meta = _getFoodMeta(f.name, f.category);
            return `
            <div class="fp-card fp-food-card" data-food-category="${meta.category}">
              <div class="fp-food-card-top">
                <div class="fp-food-icon" aria-hidden="true">${meta.icon}</div>
                <div class="fp-food-info">
                  <div class="fp-card-title fp-food-name">${_esc(f.name)}</div>
                  <div class="fp-food-serving">${_esc(f.serving)}</div>
                </div>
              </div>
              <div class="fp-card-note fp-food-chip-row">
                <span class="fp-food-chip chip-cal" title="Calories">🔥 ${f.calories} kcal</span>
                <span class="fp-food-chip chip-pro" title="Protein">💪 ${f.protein_g}g protein</span>
              </div>
            </div>`;
          }).join('')
        : '<div style="color:var(--goals-muted, var(--muted));">No food recommendations available yet.</div>';
    }

    // Set up food category filter buttons
    const filterStrip = document.getElementById('fp-food-filter-strip');
    if (filterStrip && !filterStrip.dataset.bound) {
      filterStrip.dataset.bound = 'true';
      filterStrip.querySelectorAll('.fp-food-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          filterStrip.querySelectorAll('.fp-food-filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const filter = btn.dataset.filter;
          if (foodsList) {
            foodsList.querySelectorAll('.fp-food-card').forEach(card => {
              if (filter === 'all' || card.dataset.foodCategory === filter) {
                card.style.display = '';
              } else {
                card.style.display = 'none';
              }
            });
          }
        });
      });
    }

    if (mealPlanEl) {
      mealPlanEl.innerHTML = mealOrder.map(key => {
        const meal = mealPlan.meals[key];
        if (!meal) return '';
        const meta = mealMeta[key] || { label: key, icon: '🍽️', color: '#e61e25' };
        const items = (meal.items || []).map(i => {
          const itemMeta = _getFoodMeta(i.name, i.category);
          return `
          <li class="fp-meal-item-row">
            <span class="fp-meal-item-bullet" aria-hidden="true">${itemMeta.icon}</span>
            <div class="fp-meal-item-body">
              <span class="fp-meal-item-name">${_esc(i.name)}</span>
              <span class="fp-meal-item-desc">${_esc(i.serving)}</span>
            </div>
            <div class="fp-meal-item-metrics">
              <span class="fp-item-cal">${i.calories} kcal</span>
              <span class="fp-item-pro">${i.protein_g}g</span>
            </div>
          </li>`;
        }).join('');

        return `
        <div class="fp-card fp-meal-card">
          <div class="fp-meal-card-header">
            <div class="fp-card-title fp-meal-title">
              <span class="fp-meal-icon" aria-hidden="true">${meta.icon}</span>
              <span>${meta.label}</span>
            </div>
            <div class="fp-meal-subtotal-badge">
              <span class="fp-sub-cal">${meal.meal_calories} kcal</span>
              <span class="fp-sub-pro">${meal.meal_protein_g}g pro</span>
            </div>
          </div>
          <ul class="fp-meal-items-list">${items || '<li class="fp-meal-item-row">No items selected.</li>'}</ul>
          <div class="fp-card-note fp-meal-card-footer">
            <div class="fp-meal-summary-chip">🔥 ${meal.meal_calories} kcal</div>
            <div class="fp-meal-summary-chip pro">💪 ${meal.meal_protein_g}g protein</div>
          </div>
        </div>`;
      }).join('');
    }

    if (totalEl) {
      totalEl.textContent = `Daily total across all meals: ${mealPlan.total_calories} kcal · ${mealPlan.total_protein_g}g protein.`;
    }

    // Render Daily Calorie Meal Allocation Bar
    if (allocBarEl) {
      allocBarEl.innerHTML = mealOrder.map(key => {
        const meal = mealPlan.meals[key];
        if (!meal || !meal.meal_calories) return '';
        const meta = mealMeta[key] || { label: key, color: '#e61e25' };
        const pct = Math.max(5, Math.round((meal.meal_calories / totalCal) * 100));
        return `<div class="fp-meal-alloc-seg" style="width:${pct}%;background:${meta.color};" title="${meta.label}: ${meal.meal_calories} kcal (${pct}%)"><span class="fp-alloc-lbl">${meta.label} ${pct}%</span></div>`;
      }).join('');
    }
  }

  function _setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value == null ? '—' : value;
  }

  function _bindTabListKeyboard(containerEl, tabSelector) {
    if (!containerEl) return;
    containerEl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const tabs = Array.from(containerEl.querySelectorAll(tabSelector));
      const idx = tabs.indexOf(document.activeElement);
      if (idx === -1) return;
      e.preventDefault();
      let nextIdx = e.key === 'ArrowRight' ? idx + 1 : idx - 1;
      if (nextIdx >= tabs.length) nextIdx = 0;
      if (nextIdx < 0) nextIdx = tabs.length - 1;
      tabs[nextIdx].focus();
      tabs[nextIdx].click();
    });
  }

  function _renderWeeklyRoutine(routine, workouts) {
    const freqEl = document.getElementById('fp-workout-frequency');
    if (freqEl) {
      freqEl.textContent = (workouts && workouts.frequency_note)
        ? workouts.frequency_note
        : (routine ? `${routine.training_days} training day${routine.training_days == 1 ? '' : 's'}, ${routine.rest_days} rest day${routine.rest_days == 1 ? '' : 's'} per week.` : '');
    }

    const tabsEl = document.getElementById('fp-day-tabs');
    const panelsEl = document.getElementById('fp-day-panels');
    if (!tabsEl || !panelsEl) return;

    if (!routine || !routine.days || !routine.days.length) {
      tabsEl.innerHTML = '';
      panelsEl.innerHTML = '<div style="color:var(--goals-muted, var(--muted));">No workout routine available yet.</div>';
      return;
    }

    _exercisesById = {};
    routine.days.forEach(day => (day.exercises || []).forEach(e => { _exercisesById[e.id] = e; }));

    tabsEl.innerHTML = routine.days.map(day => `
      <button type="button" class="fp-tab-btn fw-day-pill${day.day_number === 1 ? ' active' : ''}${day.type === 'rest' ? ' rest' : ''}"
              role="tab"
              id="fp-day-tab-${day.day_number}"
              data-fp-day="${day.day_number}"
              aria-selected="${day.day_number === 1 ? 'true' : 'false'}"
              aria-controls="fp-day-panel-${day.day_number}"
              tabindex="${day.day_number === 1 ? '0' : '-1'}">
        Day ${day.day_number}${day.type === 'rest' ? ' · Rest' : ''}
      </button>`).join('');

    panelsEl.innerHTML = routine.days.map(day => `
      <div class="fp-day-panel" id="fp-day-panel-${day.day_number}" role="tabpanel" aria-labelledby="fp-day-tab-${day.day_number}" data-fp-day-panel="${day.day_number}" style="${day.day_number === 1 ? '' : 'display:none;'}">
        <div class="panel-title" style="font-size:16px;margin-bottom:10px;">${_esc(day.focus)}</div>
        ${day.type === 'rest'
          ? `<div style="font-size:15px;color:var(--goals-muted, var(--muted));">${_esc(day.note || '')}</div>`
          : `<div class="workout-exercise-list">${(day.exercises || []).map(e => {
              const targetSlug = (e.target_area || 'full-body').toLowerCase().replace(/\s+/g, '-');
              const isImg = e.media_url && typeof e.media_url === 'string' && /\.(jpg|jpeg|png|gif|webp)$/i.test(e.media_url.trim());
              const thumbSrc = isImg
                ? e.media_url.trim()
                : `/static/images/workouts/thumb-${targetSlug}.jpg`;
              const fallbackText = (e.target_area || 'EXERCISE').toUpperCase();

              return `
              <div class="workout-exercise-card" data-exercise-id="${e.id}" role="button" tabindex="0" aria-label="View instructions for ${_esc(e.name)}">
                <div class="workout-exercise-media">
                  <img src="${thumbSrc}"
                       alt="${_esc(e.name)}"
                       class="workout-exercise-img"
                       onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                  <div class="workout-exercise-fallback" style="display:none;">${_esc(fallbackText)}</div>
                </div>
                <div class="workout-exercise-content">
                  <div class="workout-exercise-title">${_esc(e.name)}</div>
                  <div class="workout-exercise-tags">
                    <span class="workout-tag-area">${_esc(e.target_area || 'Workout')}</span>
                    ${e.sub_target ? `<span class="workout-tag-sub">${_esc(e.sub_target)}</span>` : ''}
                    ${e.equipment_name ? `<span class="workout-tag-equip">${_esc(e.equipment_name)}</span>` : ''}
                  </div>
                  <div class="workout-exercise-reps">${_esc(e.sets)} sets × ${_esc(e.reps)} reps</div>
                </div>
                <div class="workout-exercise-arrow" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                </div>
              </div>`;
            }).join('')}
            </div>`}
      </div>`).join('');

    // Event handlers for clickable workout exercise cards
    panelsEl.querySelectorAll('.workout-exercise-card').forEach(card => {
      const openModal = () => openExerciseInstructionsModal(Number(card.dataset.exerciseId));
      card.addEventListener('click', openModal);
      card.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          openModal();
        }
      });
    });

    tabsEl.querySelectorAll('[data-fp-day]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dayNum = btn.dataset.fpDay;
        tabsEl.querySelectorAll('[data-fp-day]').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
          b.setAttribute('tabindex', '-1');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        btn.setAttribute('tabindex', '0');
        panelsEl.querySelectorAll('[data-fp-day-panel]').forEach(p => {
          p.style.display = p.dataset.fpDayPanel === dayNum ? '' : 'none';
        });
      });
    });

    // Arrow key navigation for day tabs
    _bindTabListKeyboard(tabsEl, '[data-fp-day]');
  }

  function switchFitnessPlanTab(tabName, btnEl) {
    if (_isMinor && tabName === 'progress') return;

    document.querySelectorAll('.fp-tabs .fp-tab-btn').forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
      b.setAttribute('tabindex', '-1');
    });
    if (!btnEl) {
      btnEl = document.querySelector(`.fp-tabs [data-fp-tab="${tabName}"]`);
    }
    if (btnEl) {
      btnEl.classList.add('active');
      btnEl.setAttribute('aria-selected', 'true');
      btnEl.setAttribute('tabindex', '0');
    }
    document.querySelectorAll('.fp-tab-panel').forEach(p => {
      p.style.display = p.dataset.fpPanel === tabName ? '' : 'none';
    });
    if (tabName === 'progress') {
      loadFitnessProgress();
    }
  }

  // ── Progress Tracking (Adults Only) ────────────────────────────────────

  function loadFitnessProgress() {
    const fitData = _parseJSON('member-fitness-data') || {};
    if (fitData.is_minor || !fitData.age || fitData.age < 18) return;

    fetch('/member/fitness/progress')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load progress');
        return res.json();
      })
      .then(data => {
        if (!data || !data.success) return;

        // Synchronize current weight & milestone bar with Hub Header
        if (data.current_weight != null) {
          _setText('fw-hub-weight', `${data.current_weight} kg`);
          _setText('meas-weight', `${data.current_weight} kg`);
          const fitScript = document.getElementById('member-fitness-data');
          if (fitScript) {
            try {
              const fd = JSON.parse(fitScript.textContent);
              fd.weight_kg = data.current_weight;
              if (data.goal_weight != null) fd.goal_weight = data.goal_weight;
              if (data.starting_weight != null) fd.calculated_weight = data.starting_weight;
              fitScript.textContent = JSON.stringify(fd);

              if (fd.height_cm && !fd.is_minor) {
                const hM = fd.height_cm / 100.0;
                const bmiVal = (data.current_weight / (hM * hM)).toFixed(1);
                _setText('meas-bmi', bmiVal);
                _setText('fw-calc-bmi', bmiVal);
                const b = parseFloat(bmiVal);
                const hubBmiVal = document.getElementById('fw-hub-bmi');
                if (hubBmiVal) {
                  hubBmiVal.textContent = bmiVal;
                  hubBmiVal.style.color = (b >= 18.5 && b <= 24.9) ? 'var(--green)' : 'var(--white)';
                }
              }
            } catch (_) {}
          }
        }
        _updateMilestoneBar(data.starting_weight || data.current_weight, data.current_weight, data.goal_weight);

        // 1. Goal Progress Summary Card
        const goalContainer = document.getElementById('fw-goal-progress-container');
        if (goalContainer) {
          if (data.goal_weight != null) {
            const startW = data.starting_weight != null ? data.starting_weight : data.current_weight;
            const curW = data.current_weight != null ? data.current_weight : startW;
            const goalW = data.goal_weight;

            let pct = 0;
            const totalChange = parseFloat(goalW) - parseFloat(startW);
            if (Math.abs(totalChange) < 0.1) {
              pct = 100;
            } else {
              const actualChange = parseFloat(curW) - parseFloat(startW);
              const ratio = actualChange / totalChange;
              pct = Math.round(ratio * 100);
              pct = Math.max(0, Math.min(100, pct));
            }

            goalContainer.innerHTML = `
              <div class="fw-goal-stats-row">
                <div><span class="fw-stat-sub">Starting</span> <strong style="color:var(--white);">${startW} kg</strong></div>
                <div><span class="fw-stat-sub">Current</span> <strong style="color:var(--gold);">${curW} kg</strong></div>
                <div><span class="fw-stat-sub">Goal</span> <strong style="color:var(--green);">${goalW} kg</strong></div>
              </div>
              <div class="fw-goal-progress-bar-wrap">
                <div class="fw-goal-progress-bar">
                  <div class="fw-progress-fill" style="width:${pct}%;"></div>
                </div>
                <div class="fw-goal-progress-pct">${pct}% to goal</div>
              </div>
            `;
          } else {
            goalContainer.innerHTML = `
              <div class="fw-no-goal-notice" style="color:var(--goals-muted, var(--muted));font-size:14px;padding:8px 0;">
                <span>No goal weight set yet.</span>
                <button type="button" class="btn btn-outline btn-sm" style="margin-left:12px;" onclick="openGoalWeightModal()">Set Goal Weight</button>
              </div>
            `;
          }
        }

        // 2. Weight Change Alert (>= 2 kg diff)
        const alertEl = document.getElementById('fw-weight-change-alert');
        const alertText = document.getElementById('fw-weight-change-text');
        if (alertEl) {
          if (data.needs_target_update) {
            alertEl.style.display = 'flex';
            if (alertText) {
              alertText.textContent = `Your weight changed by ${data.weight_diff} kg since your last target calculation. Update your targets?`;
            }
          } else {
            alertEl.style.display = 'none';
          }
        }

        // 3. Weight Trend Chart (Inline SVG)
        _renderWeightChart(data.chart_entries || [], data.goal_weight);

        // 4. Recent Weigh-ins List
        _renderRecentWeights(data.recent_entries || []);
      })
      .catch(err => {
        console.error('Error loading fitness progress:', err);
      });
  }

  function _renderWeightChart(entries, goalWeight) {
    const chartContainer = document.getElementById('fw-chart-container');
    if (!chartContainer) return;

    if (!entries || entries.length < 2) {
      chartContainer.innerHTML = `
        <div class="fw-chart-empty" style="text-align:center;padding:40px 16px;color:var(--goals-muted, var(--muted));font-size:14px;background:rgba(255,255,255,0.02);border:1px dashed rgba(255,255,255,0.1);border-radius:10px;">
          Log at least 2 weigh-ins to see your weight trend chart.
        </div>
      `;
      return;
    }

    const W = 560;
    const H = 240;
    const padX = 45;
    const padTop = 30;
    const padBottom = 45;
    const chartH = H - padTop - padBottom;

    const weights = entries.map(e => e.weight_kg);
    let minW = Math.min(...weights);
    let maxW = Math.max(...weights);
    if (goalWeight != null && !isNaN(goalWeight)) {
      minW = Math.min(minW, parseFloat(goalWeight));
      maxW = Math.max(maxW, parseFloat(goalWeight));
    }
    if (minW === maxW) {
      minW -= 2;
      maxW += 2;
    } else {
      const span = maxW - minW;
      minW -= span * 0.15;
      maxW += span * 0.15;
    }

    const n = entries.length;
    const points = entries.map((e, i) => {
      const x = padX + (i * (W - 2 * padX)) / (n - 1);
      const y = H - padBottom - ((e.weight_kg - minW) / (maxW - minW)) * chartH;
      return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, entry: e };
    });

    const goalY = (goalWeight != null && !isNaN(goalWeight) && maxW > minW)
      ? Math.round((H - padBottom - ((parseFloat(goalWeight) - minW) / (maxW - minW)) * chartH) * 10) / 10
      : null;

    const polyPoints = points.map(p => `${p.x},${p.y}`).join(' ');
    const firstP = points[0];
    const lastP = points[points.length - 1];

    const areaPoints = `${firstP.x},${H - padBottom} ${polyPoints} ${lastP.x},${H - padBottom}`;

    const svgHtml = `
      <svg viewBox="0 0 ${W} ${H}" class="fw-weight-chart-svg" style="width:100%;height:auto;display:block;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:10px;" role="img" aria-label="Weight Trend Chart">
        <defs>
          <linearGradient id="fwChartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#e61e25" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#e61e25" stop-opacity="0.0"/>
          </linearGradient>
        </defs>

        <!-- Horizontal baseline guides -->
        <line x1="${padX}" y1="${padTop}" x2="${W - padX}" y2="${padTop}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="4"/>
        <line x1="${padX}" y1="${padTop + chartH / 2}" x2="${W - padX}" y2="${padTop + chartH / 2}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="4"/>
        <line x1="${padX}" y1="${H - padBottom}" x2="${W - padX}" y2="${H - padBottom}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="4"/>

        ${goalY != null ? `
        <!-- Goal weight dashed line (matching Mockup 3) -->
        <line x1="${padX}" y1="${goalY}" x2="${W - padX}" y2="${goalY}" stroke="rgba(40,167,69,0.5)" stroke-width="1.5" stroke-dasharray="4 4" />
        <text x="${W - padX}" y="${Math.max(14, goalY - 6)}" fill="#28a745" font-size="10" font-weight="600" text-anchor="end" font-family="sans-serif">Goal (${goalWeight} kg)</text>
        ` : ''}

        <!-- Area fill under line -->
        <polygon points="${areaPoints}" fill="url(#fwChartGrad)" />

        <!-- Polyline connecting points -->
        <polyline points="${polyPoints}" fill="none" stroke="#e61e25" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />

        <!-- Data circles -->
        ${points.map(p => `
          <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#e61e25" stroke="#121212" stroke-width="2" class="fw-chart-point">
            <title>${p.entry.weight_kg} kg on ${p.entry.logged_at}</title>
          </circle>
        `).join('')}

        <!-- First point label -->
        <text x="${firstP.x}" y="${Math.max(16, firstP.y - 12)}" fill="#e0e0e0" font-size="12" font-weight="600" text-anchor="start" font-family="sans-serif">
          ${firstP.entry.weight_kg} kg
        </text>
        <text x="${firstP.x}" y="${H - padBottom + 20}" fill="rgba(255,255,255,0.5)" font-size="11" text-anchor="start" font-family="sans-serif">
          ${firstP.entry.logged_at}
        </text>

        <!-- Latest point label -->
        <text x="${lastP.x}" y="${Math.max(16, lastP.y - 12)}" fill="#e61e25" font-size="12" font-weight="bold" text-anchor="end" font-family="sans-serif">
          ${lastP.entry.weight_kg} kg
        </text>
        <text x="${lastP.x}" y="${H - padBottom + 20}" fill="#e61e25" font-size="11" text-anchor="end" font-family="sans-serif">
          ${lastP.entry.logged_at}
        </text>
      </svg>
    `;

    chartContainer.innerHTML = svgHtml;
  }

  function _renderRecentWeights(entries) {
    const listEl = document.getElementById('fw-recent-weights-list');
    if (!listEl) return;

    if (!entries || !entries.length) {
      listEl.innerHTML = '<div style="color:var(--goals-muted, var(--muted));font-size:13px;padding:8px 0;">No weigh-ins recorded yet.</div>';
      return;
    }

    listEl.innerHTML = entries.map(item => `
      <div class="fw-recent-weight-row" data-log-id="${item.id}" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:8px;margin-bottom:8px;">
        <div>
          <span style="font-weight:600;color:var(--white);font-size:15px;">${item.weight_kg} kg</span>
          <span style="font-size:12px;color:var(--goals-muted, var(--muted));margin-left:10px;">${item.full_date || item.logged_at}</span>
        </div>
        <button type="button" class="btn btn-outline btn-sm fw-delete-weight-btn" onclick="deleteWeightLog(${item.id})" style="color:var(--red);border-color:rgba(220,53,69,0.4);padding:4px 10px;font-size:12px;">Delete</button>
      </div>
    `).join('');
  }

  function submitWeightLog() {
    const input = document.getElementById('fw-today-weight');
    if (!input) return;
    const weightVal = parseFloat(input.value);
    if (isNaN(weightVal) || weightVal < 20 || weightVal > 300) {
      showToast('Please enter a valid weight between 20.0 and 300.0 kg.', 'error');
      return;
    }

    const btn = document.getElementById('fw-log-weight-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'LOGGING...'; }

    fetch('/member/fitness/log-weight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weight_kg: weightVal }),
    })
      .then(res => res.json().then(data => ({ ok: res.ok, status: res.status, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to log weight.', 'error');
          return;
        }
        showToast(data.message || 'Weight logged successfully.', 'success');
        input.value = '';

        // Update current measurements block
        const measW = document.getElementById('meas-weight');
        if (measW) measW.textContent = `${data.weight_kg} kg`;

        loadFitnessProgress();
      })
      .catch(() => {
        showToast('Could not reach server. Please try again.', 'error');
      })
      .finally(() => {
        if (btn) { btn.disabled = false; btn.textContent = 'LOG WEIGHT'; }
      });
  }

  function deleteWeightLog(logId) {
    if (!confirm('Are you sure you want to delete this weight entry?')) return;

    fetch(`/member/fitness/delete-weight/${logId}`, {
      method: 'DELETE',
    })
      .then(res => res.json())
      .then(data => {
        if (!data || !data.success) {
          showToast(data.error || 'Failed to delete weight entry.', 'error');
          return;
        }
        showToast('Weight entry deleted.', 'success');
        if (data.current_weight != null) {
          const measW = document.getElementById('meas-weight');
          if (measW) measW.textContent = `${data.current_weight} kg`;
        }
        loadFitnessProgress();
      })
      .catch(() => {
        showToast('Could not reach server. Please try again.', 'error');
      });
  }

  function openGoalWeightModal() {
    const modal = document.getElementById('goal-weight-modal');
    if (!modal) return;
    const errEl = document.getElementById('fw-modal-goal-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    const fitData = _parseJSON('member-fitness-data') || {};
    const input = document.getElementById('fw-modal-goal-weight');
    if (input) {
      input.value = fitData.goal_weight != null ? fitData.goal_weight : '';
      calculateModalGoalBmi();
    }
    modal.classList.add('open');
  }

  function closeGoalWeightModal() {
    const modal = document.getElementById('goal-weight-modal');
    if (modal) modal.classList.remove('open');
  }

  function calculateModalGoalBmi() {
    const input = document.getElementById('fw-modal-goal-weight');
    const hint = document.getElementById('fw-modal-goal-bmi-hint');
    if (!input || !hint) return;

    const fitData = _parseJSON('member-fitness-data') || {};
    const heightCm = fitData.height_cm;
    const val = parseFloat(input.value);

    if (!heightCm || isNaN(val) || val <= 0) {
      hint.style.display = 'none';
      return;
    }

    const heightM = heightCm / 100.0;
    const bmi = val / (heightM * heightM);
    let category = '';
    if (bmi < 18.5) category = '(Underweight - minimum safe BMI is 18.5)';
    else if (bmi <= 24.9) category = '(Normal)';
    else if (bmi <= 29.9) category = '(Overweight)';
    else if (bmi <= 40.0) category = '(Obese)';
    else category = '(Above maximum safe BMI 40.0)';

    hint.style.display = '';
    hint.textContent = `Implied BMI: ${bmi.toFixed(1)} ${category}`;
    if (bmi < 18.5 || bmi > 40.0) {
      hint.style.color = 'var(--red)';
    } else {
      hint.style.color = 'var(--gold)';
    }
  }

  function submitGoalWeight() {
    const input = document.getElementById('fw-modal-goal-weight');
    const errEl = document.getElementById('fw-modal-goal-error');
    if (!input) return;

    const goalVal = parseFloat(input.value);
    if (isNaN(goalVal) || goalVal < 30 || goalVal > 300) {
      if (errEl) { errEl.style.display = ''; errEl.textContent = 'Please enter a goal weight between 30.0 and 300.0 kg.'; }
      return;
    }

    const btn = document.getElementById('fw-modal-goal-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'SAVING...'; }

    fetch('/member/fitness/set-goal-weight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal_weight_kg: goalVal }),
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          if (errEl) {
            errEl.style.display = '';
            errEl.textContent = data.error || 'Failed to update goal weight.';
          }
          return;
        }
        closeGoalWeightModal();
        showToast('Goal weight updated.', 'success');

        // Update local fitData cache if present
        const fitScript = document.getElementById('member-fitness-data');
        if (fitScript) {
          try {
            const fd = JSON.parse(fitScript.textContent);
            fd.goal_weight = data.goal_weight_kg;
            fitScript.textContent = JSON.stringify(fd);
          } catch (e) {}
        }

        loadFitnessProgress();
      })
      .catch(() => {
        if (errEl) { errEl.style.display = ''; errEl.textContent = 'Could not reach server. Please try again.'; }
      })
      .finally(() => {
        if (btn) { btn.disabled = false; btn.textContent = 'SAVE GOAL'; }
      });
  }

  function recalculateFromProgress() {
    const btn = document.getElementById('fw-update-targets-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'UPDATING...'; }

    fetch('/member/fitness/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to update targets.', 'error');
          return;
        }
        const calc = data.calculations || {};
        _setText('fp-target-calories', calc.calorie_target != null ? `${calc.calorie_target} kcal` : '—');
        _setText('fp-target-protein', calc.protein_target_g != null ? `${calc.protein_target_g} g` : '—');
        _setText('fp-nutrition-calorie', calc.calorie_target != null ? `${calc.calorie_target} kcal` : '—');
        _setText('fp-nutrition-protein', calc.protein_target_g != null ? `${calc.protein_target_g} g` : '—');
        _updateMacroSplit(calc.calorie_target, calc.protein_target_g);
        _setText('fw-calc-bmr', calc.bmr != null ? `${calc.bmr} kcal` : '—');
        _setText('fw-calc-tdee', calc.tdee != null ? `${calc.tdee} kcal` : '—');
        _setText('fw-calc-bmi', calc.bmi != null ? calc.bmi : '—');

        const alertEl = document.getElementById('fw-weight-change-alert');
        if (alertEl) alertEl.style.display = 'none';

        showToast('Your daily targets have been updated to match your current weight!', 'success');
        loadFitnessProgress();
      })
      .catch(() => {
        showToast('Could not reach server. Please try again.', 'error');
      })
      .finally(() => {
        if (btn) { btn.disabled = false; btn.textContent = 'UPDATE TARGETS'; }
      });
  }

  function dismissWeightChangeAlert() {
    const alertEl = document.getElementById('fw-weight-change-alert');
    if (alertEl) alertEl.style.display = 'none';
  }

  return {
    init, tab, selectPlan, selectPromo, openPlanModal, openPromoModal, selectPlanFromModal,
    toggleStudentIdField, previewStudentId, removeStudentId, submitRenewalPayment, updateCoachAvailabilityNote,
    validateStartDateField,
    cancelPlanRequest, confirmPlanRequest, closePlanSuccessModal,
    closePlanApprovedModal, goToPaymentFromApproval, closePaymentApprovedModal,
    closePlanDeclinedModal, withdrawPlanRequest, cancelWithdrawRequest, confirmWithdrawRequest,
    feedbackWizardNext, feedbackWizardBack, selectFeedbackRecommend, dismissFeedbackModal, submitMemberFeedback,
    openFeedbackOnDemand,
    togglePaymentProofField, previewGcashProof, removeGcashProof, openGcashProofPreview, submitPaymentMethod,
    copyGcashNumber, deferPaymentMethod,
    cancelSubmitPayment, confirmSubmitPayment, closePaymentSubmitSuccessModal,
    changeProfilePicture,
    changeAttendanceMonth, openServiceModal, openEquipmentModal, openExerciseInstructionsModal,
    submitFitnessStep1, selectFitnessGoal, fitnessWizardBack, submitFitnessStep2,
    retryFitnessCalculation: retryFitnessSetup,
    fitnessWizardEditGoal: editFitnessProfileAndFocus,
    switchFitnessPlanTab,
    editFitnessProfileAndFocus, goToFitnessStep, retryFitnessSetup, cancelFitnessEdit,
    updateActivityHelperText, onFitnessGoalRadioChange,
    selectFitnessGoalByCode, selectObjectiveCard, selectPrimaryObjective,
    toggleNotificationPanel, openNotifItem,
    loadFitnessProgress, submitWeightLog, deleteWeightLog,
    openGoalWeightModal, closeGoalWeightModal, calculateModalGoalBmi, submitGoalWeight,
    recalculateFromProgress, dismissWeightChangeAlert,
  };
})();


/* ════════════════════════════════════════════════
   INIT — DOMContentLoaded Bootstrap
════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('member-dashboard-root')) return;

  // Bind every onclick-referenced global FIRST. Previously these were bound
  // *after* MemberModule.init() ran, so if init() ever threw partway through
  // (e.g. a malformed data script tag), none of them would exist at all —
  // every button on the dashboard (including "View Inclusions") would look
  // dead with no visible error. Binding first means the buttons keep working
  // even if something inside init() has a problem, and the try/catch below
  // surfaces that problem in the console instead of hiding it.
  window.memberTab               = (tabName, el) => MemberModule.tab(tabName, el);
  window.selectPlan              = (card, key) => MemberModule.selectPlan(card, key);
  window.selectPromo             = (card) => MemberModule.selectPromo(card);
  window.openPlanModal           = (key) => MemberModule.openPlanModal(key);
  window.openPromoModal          = (index) => MemberModule.openPromoModal(index);
  window.selectPlanFromModal     = () => MemberModule.selectPlanFromModal();
  window.toggleStudentIdField    = (el) => MemberModule.toggleStudentIdField(el);
  window.updateCoachAvailabilityNote = () => MemberModule.updateCoachAvailabilityNote();
  window.validateStartDateField      = () => MemberModule.validateStartDateField();
  window.previewStudentId        = (input, side) => MemberModule.previewStudentId(input, side);
  window.removeStudentId         = (side) => MemberModule.removeStudentId(side);
  window.submitRenewalPayment    = () => MemberModule.submitRenewalPayment();
  window.cancelPlanRequest       = () => MemberModule.cancelPlanRequest();
  window.confirmPlanRequest      = () => MemberModule.confirmPlanRequest();
  window.closePlanSuccessModal   = () => MemberModule.closePlanSuccessModal();
  window.closePlanApprovedModal  = () => MemberModule.closePlanApprovedModal();
  window.goToPaymentFromApproval = () => MemberModule.goToPaymentFromApproval();
  window.closePaymentApprovedModal = () => MemberModule.closePaymentApprovedModal();
  window.closePlanDeclinedModal  = () => MemberModule.closePlanDeclinedModal();
  window.feedbackWizardNext      = () => MemberModule.feedbackWizardNext();
  window.feedbackWizardBack      = () => MemberModule.feedbackWizardBack();
  window.selectFeedbackRecommend = (v) => MemberModule.selectFeedbackRecommend(v);
  window.dismissFeedbackModal    = () => MemberModule.dismissFeedbackModal();
  window.submitMemberFeedback    = () => MemberModule.submitMemberFeedback();
  window.openFeedbackOnDemand    = () => MemberModule.openFeedbackOnDemand();
  window.withdrawPlanRequest     = (paymentId) => MemberModule.withdrawPlanRequest(paymentId);
  window.cancelWithdrawRequest   = () => MemberModule.cancelWithdrawRequest();
  window.confirmWithdrawRequest  = () => MemberModule.confirmWithdrawRequest();
  window.togglePaymentProofField = (el) => MemberModule.togglePaymentProofField(el);
  window.previewGcashProof       = (input, slot) => MemberModule.previewGcashProof(input, slot);
  window.removeGcashProof        = (slot) => MemberModule.removeGcashProof(slot);
  window.openGcashProofPreview   = (slot) => MemberModule.openGcashProofPreview(slot);
  window.submitPaymentMethod     = () => MemberModule.submitPaymentMethod();
  window.copyGcashNumber         = (btn) => MemberModule.copyGcashNumber(btn);
  window.deferPaymentMethod      = () => MemberModule.deferPaymentMethod();
  window.cancelSubmitPayment     = () => MemberModule.cancelSubmitPayment();
  window.confirmSubmitPayment    = () => MemberModule.confirmSubmitPayment();
  window.closePaymentSubmitSuccessModal = () => MemberModule.closePaymentSubmitSuccessModal();
  window.changeProfilePicture   = (input) => MemberModule.changeProfilePicture(input);
  window.changeAttendanceMonth   = (delta) => MemberModule.changeAttendanceMonth(delta);
  window.openServiceModal        = (id) => MemberModule.openServiceModal(id);
  window.openEquipmentModal      = (id) => MemberModule.openEquipmentModal(id);
  window.submitFitnessStep1      = () => MemberModule.submitFitnessStep1();
  window.selectFitnessGoal       = (card) => MemberModule.selectFitnessGoal(card);
  window.selectFitnessGoalByCode = (code) => MemberModule.selectFitnessGoalByCode(code);
  window.selectPrimaryObjective  = (code, el) => MemberModule.selectPrimaryObjective(code, el);
  window.selectObjectiveCard     = (code, el) => MemberModule.selectObjectiveCard(code, el);
  window.fitnessWizardBack       = () => MemberModule.fitnessWizardBack();
  window.submitFitnessStep2      = () => MemberModule.submitFitnessStep2();
  window.retryFitnessCalculation = () => MemberModule.retryFitnessSetup();
  window.retryFitnessSetup       = () => MemberModule.retryFitnessSetup();
  window.fitnessWizardEditGoal   = () => MemberModule.editFitnessProfileAndFocus();
  window.editFitnessProfileAndFocus = () => MemberModule.editFitnessProfileAndFocus();
  window.cancelFitnessEdit       = () => MemberModule.cancelFitnessEdit();
  window.goToFitnessStep         = (step) => MemberModule.goToFitnessStep(step);
  window.updateActivityHelperText = () => MemberModule.updateActivityHelperText();
  window.onFitnessGoalRadioChange = (radio) => MemberModule.onFitnessGoalRadioChange(radio);
  window.openExerciseInstructionsModal = (id) => MemberModule.openExerciseInstructionsModal(id);
  window.switchFitnessPlanTab    = (tabName, btnEl) => MemberModule.switchFitnessPlanTab(tabName, btnEl);
  window.toggleNotificationPanel = () => MemberModule.toggleNotificationPanel();
  window.loadFitnessProgress     = () => MemberModule.loadFitnessProgress();
  window.submitWeightLog         = () => MemberModule.submitWeightLog();
  window.deleteWeightLog         = (id) => MemberModule.deleteWeightLog(id);
  window.openGoalWeightModal     = () => MemberModule.openGoalWeightModal();
  window.closeGoalWeightModal    = () => MemberModule.closeGoalWeightModal();
  window.calculateModalGoalBmi   = () => MemberModule.calculateModalGoalBmi();
  window.submitGoalWeight        = () => MemberModule.submitGoalWeight();
  window.recalculateFromProgress = () => MemberModule.recalculateFromProgress();
  window.dismissWeightChangeAlert= () => MemberModule.dismissWeightChangeAlert();

  try {
    MemberModule.init();
  } catch (e) {
    console.error('MemberModule.init() failed — the dashboard will still respond to clicks, ' +
      'but data that init() was supposed to load (attendance calendar, plan list, notices, etc.) ' +
      'may be missing:', e);
  }
});