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
  let _servicesById   = {};   // id  -> {id,name,description,image_path,category,icon,equipment:[{name,icon}]}
  let _exercisesById  = {};   // id  -> exercise object (populated when the weekly routine renders)

  let _selectedPlanKey   = null;
  let _pendingPlanRequest = null; // { formData } staged between submitRenewalPayment() and confirmPlanRequest()
  let _pendingPaymentMethod = null; // { formData } staged between submitPaymentMethod() and confirmSubmitPayment()
  let _withdrawPaymentId = null;

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

  /* ── Init ─────────────────────────────────────────────── */
  function init() {
    const session = Session.guardDashboard();
    if (!session) return;

    _injectSidebarUser(session);
    document.body.classList.add('role-member');
    _bindModalBackdrops();
    Navigation.activateTab('member', 'overview', document.getElementById('nav-member-overview'));

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
      const msg = document.getElementById('plan-approved-message');
      if (msg) msg.textContent = `Congratulations! Your ${dashData.plan_approved_notice.plan_name} plan has been approved. Please proceed to payment.`;
      openModal('plan-approved-modal');
    }
    if (dashData.payment_verified_notice) {
      const msg = document.getElementById('payment-approved-message');
      if (msg) msg.textContent = `You have successfully paid your ${dashData.payment_verified_notice.plan_name} plan! Active since ${dashData.payment_verified_notice.start_date}.`;
      openModal('payment-approved-modal');
    }
    if (dashData.plan_declined_notice) {
      const msg = document.getElementById('plan-declined-message');
      if (msg) msg.textContent = `Your ${dashData.plan_declined_notice.plan_name} plan request was declined. Please check with staff or admin, then feel free to submit a new request.`;
      openModal('plan-declined-modal');
    }
    showNewAnnouncementNotices(dashData.new_announcements);

    // Plans / services lookup tables (used by the plan/service detail modals)
    (_parseJSON('member-plans-data') || []).forEach(p => { _plansByKey[p.key] = p; });
    (_parseJSON('member-services-data') || []).forEach(s => { _servicesById[s.id] = s; });

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
      const lines = (plan.inclusions || '').split('\n').map(l => l.trim()).filter(Boolean);
      list.innerHTML = lines.length
        ? lines.map(l => `<li>${_esc(l)}</li>`).join('')
        : '<li>Full gym access for the plan duration.</li>';
    }

    document.getElementById('plan-modal').dataset.planKey = key;
    openModal('plan-modal');
  }

  function selectPlanFromModal() {
    const key = document.getElementById('plan-modal').dataset.planKey;
    closeModal('plan-modal');
    if (!key) return;

    const card = Array.from(document.querySelectorAll('.plan-grid .plan-card'))
      .find(c => (c.querySelector('.plan-name')?.textContent || '').trim().toLowerCase() === key);
    if (card) selectPlan(card, key);
  }

  function toggleStudentIdField(selectEl) {
    const group = document.getElementById('member-student-id-group');
    if (group) group.style.display = selectEl.value === 'yes' ? '' : 'none';
  }

  function previewStudentId(input) {
    const preview = document.getElementById('member-student-id-preview');
    const file = input.files && input.files[0];
    if (!preview || !file) return;
    const reader = new FileReader();
    reader.onload = e => { preview.src = e.target.result; preview.style.display = 'block'; };
    reader.readAsDataURL(file);
  }

  /** Validates the plan request form, then shows the invoice confirmation
   *  modal — the actual submit happens in confirmPlanRequest(). */
  function submitRenewalPayment() {
    if (!_selectedPlanKey || !_plansByKey[_selectedPlanKey]) {
      showToast('Please select a membership plan.', 'error');
      return;
    }
    const plan = _plansByKey[_selectedPlanKey];

    const startDate = document.getElementById('member-renew-start')?.value || '';
    if (!startDate) {
      showToast('Please choose a start date for your plan.', 'error');
      return;
    }

    const isStudent = document.getElementById('member-renew-student')?.value === 'yes';
    const studentIdInput = document.getElementById('member-student-id');
    const studentIdFile = studentIdInput?.files?.[0] || null;
    if (isStudent && !studentIdFile) {
      showToast('Please upload a photo of your school ID.', 'error');
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
    if (isStudent && studentIdFile) formData.append('student_id', studentIdFile);
    _pendingPlanRequest = { formData };

    // Populate the invoice confirmation modal
    document.getElementById('confirm-plan-name').textContent = plan.name.toUpperCase();
    document.getElementById('confirm-plan-regular-price').textContent = _peso(plan.price);
    document.getElementById('confirm-plan-discount-row').style.display = 'none';
    document.getElementById('confirm-plan-coach-row').style.display = 'none';
    document.getElementById('confirm-plan-coach-fee-row').style.display = 'none';
    document.getElementById('confirm-plan-date').textContent =
      new Date(startDate + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    document.getElementById('confirm-plan-end-date').textContent = _previewExpiry(plan, startDate);
    document.getElementById('confirm-plan-total').textContent = _peso(plan.price);

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
    if (gcashFields) gcashFields.style.display = selectEl.value === 'gcash' ? '' : 'none';
  }

  function previewGcashProof(input) {
    const preview = document.getElementById('payment-gcash-proof-preview');
    const file = input.files && input.files[0];
    if (!preview || !file) return;
    const reader = new FileReader();
    reader.onload = e => { preview.src = e.target.result; preview.style.display = 'block'; };
    reader.readAsDataURL(file);
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
    init, tab, selectPlan, openPlanModal, selectPlanFromModal,
    toggleStudentIdField, previewStudentId, submitRenewalPayment,
    cancelPlanRequest, confirmPlanRequest, closePlanSuccessModal,
    closePlanApprovedModal, goToPaymentFromApproval, closePaymentApprovedModal,
    closePlanDeclinedModal, withdrawPlanRequest, cancelWithdrawRequest, confirmWithdrawRequest,
    togglePaymentProofField, previewGcashProof, submitPaymentMethod,
    cancelSubmitPayment, confirmSubmitPayment, closePaymentSubmitSuccessModal,
    changeAttendanceMonth, openServiceModal, openExerciseInstructionsModal,
    submitFitnessStep1, selectFitnessGoal, fitnessWizardBack, submitFitnessStep2,
    retryFitnessCalculation, fitnessWizardEditGoal, switchFitnessPlanTab,
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
  window.openPlanModal           = (key) => MemberModule.openPlanModal(key);
  window.selectPlanFromModal     = () => MemberModule.selectPlanFromModal();
  window.toggleStudentIdField    = (el) => MemberModule.toggleStudentIdField(el);
  window.previewStudentId        = (input) => MemberModule.previewStudentId(input);
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
  window.previewGcashProof       = (input) => MemberModule.previewGcashProof(input);
  window.submitPaymentMethod     = () => MemberModule.submitPaymentMethod();
  window.cancelSubmitPayment     = () => MemberModule.cancelSubmitPayment();
  window.confirmSubmitPayment    = () => MemberModule.confirmSubmitPayment();
  window.closePaymentSubmitSuccessModal = () => MemberModule.closePaymentSubmitSuccessModal();
  window.changeAttendanceMonth   = (delta) => MemberModule.changeAttendanceMonth(delta);
  window.openServiceModal        = (id) => MemberModule.openServiceModal(id);
  window.submitFitnessStep1      = () => MemberModule.submitFitnessStep1();
  window.selectFitnessGoal       = (card) => MemberModule.selectFitnessGoal(card);
  window.fitnessWizardBack       = () => MemberModule.fitnessWizardBack();
  window.submitFitnessStep2      = () => MemberModule.submitFitnessStep2();
  window.retryFitnessCalculation = () => MemberModule.retryFitnessCalculation();
  window.fitnessWizardEditGoal   = () => MemberModule.fitnessWizardEditGoal();
  window.switchFitnessPlanTab    = (tabName, btnEl) => MemberModule.switchFitnessPlanTab(tabName, btnEl);

  try {
    MemberModule.init();
  } catch (e) {
    console.error('MemberModule.init() failed — the dashboard will still respond to clicks, ' +
      'but data that init() was supposed to load (attendance calendar, plan list, notices, etc.) ' +
      'may be missing:', e);
  }
});