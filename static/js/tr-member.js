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

  // Attendance calendar month navigation state
  let _attYear = null;
  let _attMonth = null;
  let _attCurrentYear = null;  // the real "today" month — never navigate past this
  let _attCurrentMonth = null;

  const ACTIVITY_LABELS = {
    low_activity:      'Low Activity',
    moderate_activity:  'Moderate Activity',
    high_activity:      'High Activity',
  };

  const GOAL_LABELS = {
    CUT:      'CUT',
    BULK:     'BULK',
    MAINTAIN: 'MAINTAIN',
    RECOMP:   'BODY RECOMPOSITION',
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
        dashData.today_day, dashData.no_plan_days || []);
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
        : '<li>Full gym access for the promo duration.</li>';
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
    document.getElementById('confirm-plan-end-date').textContent = promo.period || 'See promo details';

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
            data.today_day, data.no_plan_days || []);
        }

        const body = document.getElementById('attendance-session-history-body');
        if (body) {
          const rows = data.session_history || [];
          body.innerHTML = rows.length
            ? rows.map(s => `<tr><td>${_esc(s.date)}</td><td>${_esc(s.check_in)}</td><td>${_esc(s.check_out)}</td><td>${_esc(s.duration)}</td></tr>`).join('')
            : '<tr><td colspan="4" style="text-align:center;color:var(--muted);">No sessions logged this month yet.</td></tr>';
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

    const list = document.getElementById('exercise-instructions-modal-steps');
    if (list) {
      const steps = (ex.instructions || '').split('\n').map(s => s.trim()).filter(Boolean);
      list.innerHTML = steps.length
        ? steps.map(s => `<li>${_esc(s)}</li>`).join('')
        : '<li>No detailed instructions available for this exercise yet.</li>';
    }

    openModal('exercise-instructions-modal');
  }

  /* ════════════════════════════════════════════════
     BODY GOALS — Fitness Goal Setup wizard (Steps 1–3)
     + Personalized Fitness Plan (Stage 4)
  ════════════════════════════════════════════════ */

  function _setWizardStep(step) {
    ['fw-step-1', 'fw-step-2', 'fw-step-3', 'fw-confirm'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    const target = document.getElementById(step === 'confirm' ? 'fw-confirm' : `fw-step-${step}`);
    if (target) target.style.display = '';

    const activeDot = step === 'confirm' ? 3 : step;
    for (let i = 1; i <= 3; i++) {
      const dot = document.getElementById(`fw-dot-${i}`);
      if (dot) dot.classList.toggle('active', i <= activeDot);
      const line = document.getElementById(`fw-line-${i}`);
      if (line) line.classList.toggle('active', i < activeDot || (i === activeDot && step === 3));
    }
  }

  /** Restores the wizard to whatever stage the member's saved data
   *  supports, and — if Step 3 is already calculated — loads the
   *  Personalized Fitness Plan panel too. */
  function _initFitnessWizard() {
    const data = _parseJSON('member-fitness-data') || {};

    if (data.fitness_goal) {
      _fitnessGoal = data.fitness_goal;
      const card = document.querySelector(`#fw-goal-grid [data-goal="${data.fitness_goal}"]`);
      if (card) card.classList.add('selected');
    }

    if (data.fitness_goal && data.calculations) {
      _renderFitnessResults(data.calculations, data.fitness_goal);
      _setWizardStep(3);
      _loadFitnessPlan();
    }
    // Otherwise leave the wizard on its server-rendered default (Step 1,
    // with height/weight/sex/activity pre-filled by Jinja where known).
  }

  function submitFitnessStep1() {
    const height = document.getElementById('fw-height')?.value;
    const weight = document.getElementById('fw-weight')?.value;
    const sex = document.getElementById('fw-sex')?.value;
    const activity = document.getElementById('fw-activity')?.value;

    if (!height || !weight) { showToast('Please enter your height and weight.', 'error'); return; }
    if (!sex) { showToast('Please select your sex.', 'error'); return; }
    if (!activity) { showToast('Please select your activity level.', 'error'); return; }

    const btn = document.getElementById('fw-step1-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'SAVING...'; }

    _apiJson('/member/fitness/save-profile', {
      height_cm: height, weight_kg: weight, sex, activity_level: activity,
    }).then(({ ok, data }) => {
      if (btn) { btn.disabled = false; btn.textContent = 'CONTINUE'; }
      if (!ok || !data.success) {
        showToast(data.error || 'Failed to save your information.', 'error');
        return;
      }
      _setWizardStep(2);
    }).catch(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'CONTINUE'; }
      showToast('Could not reach the server. Please try again.', 'error');
    });
  }

  function selectFitnessGoal(card) {
    document.querySelectorAll('#fw-goal-grid .plan-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    _fitnessGoal = card.dataset.goal;
    const btn = document.getElementById('fw-step2-btn');
    if (btn) btn.disabled = false;
  }

  function fitnessWizardBack() {
    _setWizardStep(1);
  }

  function submitFitnessStep2() {
    if (!_fitnessGoal) { showToast('Please select a fitness goal.', 'error'); return; }

    const btn = document.getElementById('fw-step2-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'SAVING...'; }

    _apiJson('/member/fitness/save-goal', { fitness_goal: _fitnessGoal })
      .then(({ ok, data }) => {
        if (btn) { btn.disabled = false; btn.textContent = 'CONTINUE'; }
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to save your goal.', 'error');
          return;
        }
        _showConfirmCalculating();
        _runFitnessCalculation();
      }).catch(() => {
        if (btn) { btn.disabled = false; btn.textContent = 'CONTINUE'; }
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  function _showConfirmCalculating() {
    const goalLabel = document.getElementById('fw-confirm-goal-label');
    if (goalLabel) goalLabel.textContent = GOAL_LABELS[_fitnessGoal] || _fitnessGoal;
    const msg = document.getElementById('fw-confirm-message');
    if (msg) msg.textContent = 'Calculating your fitness targets...';
    const retryBtn = document.getElementById('fw-confirm-retry-btn');
    if (retryBtn) retryBtn.style.display = 'none';
    _setWizardStep('confirm');
  }

  function _runFitnessCalculation() {
    _apiJson('/member/fitness/calculate', {})
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          const msg = document.getElementById('fw-confirm-message');
          if (msg) msg.textContent = data.error || 'Could not calculate your targets. Please try again.';
          const retryBtn = document.getElementById('fw-confirm-retry-btn');
          if (retryBtn) retryBtn.style.display = '';
          return;
        }
        _renderFitnessResults(data.calculations, data.goal);
        _setWizardStep(3);
        _loadFitnessPlan();
      })
      .catch(() => {
        const msg = document.getElementById('fw-confirm-message');
        if (msg) msg.textContent = 'Could not reach the server. Please try again.';
        const retryBtn = document.getElementById('fw-confirm-retry-btn');
        if (retryBtn) retryBtn.style.display = '';
      });
  }

  function retryFitnessCalculation() {
    _showConfirmCalculating();
    _runFitnessCalculation();
  }

  function fitnessWizardEditGoal() {
    _setWizardStep(2);
  }

  function _renderFitnessResults(calc, goal) {
    const note = document.getElementById('fw-goal-note');
    if (note) note.textContent = `Based on your ${GOAL_LABELS[goal] || goal} goal.`;
    _setText('fw-result-bmi', calc.bmi);
    _setText('fw-result-bmr', calc.bmr != null ? `${calc.bmr} kcal` : '—');
    _setText('fw-result-tdee', calc.tdee != null ? `${calc.tdee} kcal` : '—');
    _setText('fw-result-calorie', calc.calorie_target != null ? `${calc.calorie_target} kcal` : '—');
    _setText('fw-result-protein', calc.protein_target_g != null ? `${calc.protein_target_g} g` : '—');
  }

  function _setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value == null ? '—' : value;
  }

  /* ── Personalized Fitness Plan (Stage 4) ────────────────── */

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
        if (!data.success) {
          if (statusEl) statusEl.textContent = data.error || 'Your plan could not be loaded right now.';
          return;
        }
        _renderFitnessPlan(data);
        if (statusEl) statusEl.style.display = 'none';
        if (contentEl) contentEl.style.display = '';
      })
      .catch(() => {
        if (statusEl) statusEl.textContent = 'Could not reach the server. Please try again.';
      });
  }

  function _renderFitnessPlan(data) {
    // Summary strip
    _setText('fp-summary-goal', GOAL_LABELS[data.goal] || data.goal);
    _setText('fp-overview-goal-label', GOAL_LABELS[data.goal] || data.goal);
    const activityLevel = (data.workouts && data.workouts.frequency_note) ? null : null; // frequency label handled below
    _setText('fp-summary-calorie', data.nutrition_targets ? `${data.nutrition_targets.calorie_target} kcal` : '—');
    _setText('fp-summary-protein', data.nutrition_targets ? `${data.nutrition_targets.protein_target_g} g` : '—');
    _setText('fp-nutrition-calorie', data.nutrition_targets ? `${data.nutrition_targets.calorie_target} kcal` : '—');
    _setText('fp-nutrition-protein', data.nutrition_targets ? `${data.nutrition_targets.protein_target_g} g` : '—');

    const fitnessProfileData = _parseJSON('member-fitness-data') || {};
    _setText('fp-summary-activity', ACTIVITY_LABELS[fitnessProfileData.activity_level] || '—');

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
        : '<div style="color:var(--muted);">No specific equipment needed.</div>';
    }

    // Tips
    const tipsList = document.getElementById('fp-tips-list');
    if (tipsList) {
      const tips = data.tips || [];
      tipsList.innerHTML = tips.length
        ? tips.map(t => `<li>${_esc(t)}</li>`).join('')
        : '<li>Stay consistent and listen to your body.</li>';
    }

    // Default to Overview tab
    switchFitnessPlanTab('overview', document.querySelector('[data-fp-tab=overview]'));
  }

  function _renderMealPlan(mealPlan) {
    const foodsList = document.getElementById('fp-foods-list');
    const mealPlanEl = document.getElementById('fp-meal-plan');
    const totalEl = document.getElementById('fp-meal-plan-total');
    if (!mealPlan || !mealPlan.meals) {
      if (foodsList) foodsList.innerHTML = '<div style="color:var(--muted);">No recommendations available yet.</div>';
      if (mealPlanEl) mealPlanEl.innerHTML = '';
      if (totalEl) totalEl.textContent = '';
      return;
    }

    const mealOrder = ['breakfast', 'lunch', 'snack', 'dinner'];
    const mealLabels = { breakfast: 'Breakfast', lunch: 'Lunch', snack: 'Snack', dinner: 'Dinner' };

    // Flat, de-duplicated "Recommended Foods" list across all meals
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
        ? foods.map(f => `<div class="fp-card"><div class="fp-card-title">🥗 ${_esc(f.name)}</div><div class="fp-card-note">${_esc(f.serving)} · ${f.calories} kcal · ${f.protein_g}g protein</div></div>`).join('')
        : '<div style="color:var(--muted);">No food recommendations available yet.</div>';
    }

    // Per-meal breakdown
    if (mealPlanEl) {
      mealPlanEl.innerHTML = mealOrder.map(key => {
        const meal = mealPlan.meals[key];
        if (!meal) return '';
        const items = (meal.items || []).map(i => `<li>${_esc(i.name)} — ${_esc(i.serving)} (${i.calories} kcal, ${i.protein_g}g protein)</li>`).join('');
        return `<div class="fp-card" style="grid-column:1/-1;">
          <div class="fp-card-title">${mealLabels[key] || key}</div>
          <ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--white);line-height:1.7;">${items || '<li>No items selected.</li>'}</ul>
          <div class="fp-card-note" style="margin-top:6px;">${meal.meal_calories} kcal · ${meal.meal_protein_g}g protein</div>
        </div>`;
      }).join('');
    }

    if (totalEl) {
      totalEl.textContent = `Daily total across all meals: ${mealPlan.total_calories} kcal · ${mealPlan.total_protein_g}g protein.`;
    }
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
      panelsEl.innerHTML = '<div style="color:var(--muted);">No workout routine available yet.</div>';
      return;
    }

    _exercisesById = {};
    routine.days.forEach(day => (day.exercises || []).forEach(e => { _exercisesById[e.id] = e; }));

    tabsEl.innerHTML = routine.days.map(day => `
      <button type="button" class="fp-tab-btn${day.day_number === 1 ? ' active' : ''}" data-fp-day="${day.day_number}">
        Day ${day.day_number}${day.type === 'rest' ? ' · Rest' : ''}
      </button>`).join('');

    panelsEl.innerHTML = routine.days.map(day => `
      <div class="fp-day-panel" data-fp-day-panel="${day.day_number}" style="${day.day_number === 1 ? '' : 'display:none;'}">
        <div class="panel-title" style="font-size:16px;margin-bottom:10px;">${_esc(day.focus)}</div>
        ${day.type === 'rest'
          ? `<div style="font-size:15px;color:var(--muted);">${_esc(day.note || '')}</div>`
          : `<div class="fp-card-grid">${(day.exercises || []).map(e => `
              <div class="fp-card" data-exercise-id="${e.id}">
                <div class="fp-card-title">🏋️ ${_esc(e.name)}</div>
                <div class="fp-card-note">${_esc(e.target_area || '')}${e.sub_target ? ' · ' + _esc(e.sub_target) : ''}</div>
                <div class="fp-card-note">${_esc(e.sets)} sets × ${_esc(e.reps)} reps${e.equipment_name ? ' · ' + _esc(e.equipment_name) : ''}</div>
                <button type="button" class="btn btn-outline btn-sm fp-view-instructions-btn" style="margin-top:8px;" data-exercise-id="${e.id}">VIEW INSTRUCTIONS</button>
              </div>`).join('')}
            </div>`}
      </div>`).join('');

    // Event delegation for the "View Instructions" buttons — avoids
    // fragile inline-onclick string escaping for exercise data.
    panelsEl.querySelectorAll('.fp-view-instructions-btn').forEach(btn => {
      btn.addEventListener('click', () => openExerciseInstructionsModal(Number(btn.dataset.exerciseId)));
    });

    tabsEl.querySelectorAll('[data-fp-day]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dayNum = btn.dataset.fpDay;
        tabsEl.querySelectorAll('[data-fp-day]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        panelsEl.querySelectorAll('[data-fp-day-panel]').forEach(p => {
          p.style.display = p.dataset.fpDayPanel === dayNum ? '' : 'none';
        });
      });
    });
  }

  function switchFitnessPlanTab(tabName, btnEl) {
    document.querySelectorAll('.fp-tabs .fp-tab-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    document.querySelectorAll('.fp-tab-panel').forEach(p => {
      p.style.display = p.dataset.fpPanel === tabName ? '' : 'none';
    });
  }

  return {
    init, tab, selectPlan, selectPromo, openPlanModal, openPromoModal, selectPlanFromModal,
    toggleStudentIdField, previewStudentId, removeStudentId, submitRenewalPayment, updateCoachAvailabilityNote,
    validateStartDateField,
    cancelPlanRequest, confirmPlanRequest, closePlanSuccessModal,
    closePlanApprovedModal, goToPaymentFromApproval, closePaymentApprovedModal,
    closePlanDeclinedModal, withdrawPlanRequest, cancelWithdrawRequest, confirmWithdrawRequest,
    togglePaymentProofField, previewGcashProof, removeGcashProof, openGcashProofPreview, submitPaymentMethod,
    copyGcashNumber, deferPaymentMethod,
    cancelSubmitPayment, confirmSubmitPayment, closePaymentSubmitSuccessModal,
    changeProfilePicture,
    changeAttendanceMonth, openServiceModal, openEquipmentModal, openExerciseInstructionsModal,
    submitFitnessStep1, selectFitnessGoal, fitnessWizardBack, submitFitnessStep2,
    retryFitnessCalculation, fitnessWizardEditGoal, switchFitnessPlanTab,
    toggleNotificationPanel, openNotifItem,
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
  window.fitnessWizardBack       = () => MemberModule.fitnessWizardBack();
  window.submitFitnessStep2      = () => MemberModule.submitFitnessStep2();
  window.retryFitnessCalculation = () => MemberModule.retryFitnessCalculation();
  window.fitnessWizardEditGoal   = () => MemberModule.fitnessWizardEditGoal();
  window.switchFitnessPlanTab    = (tabName, btnEl) => MemberModule.switchFitnessPlanTab(tabName, btnEl);
  window.toggleNotificationPanel = () => MemberModule.toggleNotificationPanel();

  try {
    MemberModule.init();
  } catch (e) {
    console.error('MemberModule.init() failed — the dashboard will still respond to clicks, ' +
      'but data that init() was supposed to load (attendance calendar, plan list, notices, etc.) ' +
      'may be missing:', e);
  }
});