/* ═══════════════════════════════════════════════════════════════
   POWER GYM — Member Dashboard
   tr-member.js  |  Runs on member-dashboard.html only

   Requires tr-common.js to be loaded first (Auth, Session, Navigation,
   showToast, buildAttGrid, _injectSidebarUser, _bindModalBackdrops).
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ════════════════════════════════════════════════
   MEMBER MODULE
   Handles member dashboard functionality.
════════════════════════════════════════════════ */
const MemberModule = (() => {

  let selectedPlan    = null;
  const LOCKED_TABS   = [];
  let attendanceView  = { year: null, month: null };
  let attendanceBusy  = false;

  // Populated at init() from JSON the server embeds for the plans/services
  // that admin/staff manage under Settings → Manage Content.
  let PLAN_DATA    = {}; // keyed by plan name lowercased, e.g. 'monthly'
  let SERVICE_DATA = {}; // keyed by service id

  // AI Fitness Goal & Recommendation feature — Steps 1/2 only for now.
  // Populated at init() from #member-fitness-data (see _parseJsonScript).
  let FITNESS_DATA = {};
  let fwSelectedGoal = null; // goal card the member has clicked on Step 2, before it's saved

  // Exercise detail cache (id -> exercise dict) populated whenever the
  // weekly routine renders, so the "View Instructions" modal can look up
  // an exercise's full instructions without a separate fetch.
  let _fwExerciseCache = {};

  function _planActive() {
    const root = document.getElementById('member-dashboard-root');
    return root ? root.dataset.planActive === 'true' : true;
  }

  function init() {
    const session = Session.guardDashboard();
    if (!session) return;

    _injectSidebarUser(session);
    document.body.classList.add('role-member');

    // Populate member card
    const cardName = document.getElementById('member-card-name');
    if (cardName) cardName.textContent = session.name;

    const memberData = _parseMemberDashboardData();
    attendanceView = { year: memberData.year || null, month: memberData.month || null };
    buildAttGrid('att-grid-member', memberData.present_days || [], memberData.days_in_month || 30, memberData.today_day || null, memberData.no_plan_days || []);
    _updateAttendanceNav(memberData.today_day != null);
    _hydrateProgressBars();
    _bindModalBackdrops();
    _initStartDateField();
    _syncPaymentMethodButton();
    _showApprovalNoticeIfAny(memberData.plan_approved_notice);
    _showPaymentApprovedNoticeIfAny(memberData.payment_verified_notice);
    _showDeclinedNoticeIfAny(memberData.plan_declined_notice);
    showNewAnnouncementNotices(memberData.new_announcements);

    // Load membership-plan and service content managed by admin/staff
    // (Settings → Manage Content) — keeps prices, descriptions, and
    // inclusions here in sync with what they edit, instead of hardcoding it.
    (_parseJsonScript('member-plans-data', []) || []).forEach(p => { PLAN_DATA[p.key] = p; });
    (_parseJsonScript('member-services-data', []) || []).forEach(s => { SERVICE_DATA[s.id] = s; });
    _updatePlanPriceDisplays();

    // AI Fitness Goal & Recommendation feature — Steps 1/2 only.
    FITNESS_DATA = _parseJsonScript('member-fitness-data', {});
    _fwInit();

    // Members without an active plan land on Overview (which points them to
    // My Membership); everything else stays locked until they pay.
    Navigation.activateTab('member', 'overview', document.getElementById('nav-member-overview'));
  }

  /** Show the one-time "Congratulations! Your plan was approved" popup, if
   *  the server flagged this page load as the first one since approval. */
  function _showApprovalNoticeIfAny(notice) {
    if (!notice) return;
    const msgEl = document.getElementById('plan-approved-message');
    if (msgEl) {
      msgEl.textContent = `Congratulations! Your ${notice.plan_name} plan has been approved. Please proceed to payment.`;
    }
    openModal('plan-approved-modal');
  }

  /** "✕" or "Later" on the approval popup — just dismiss it. */
  function closePlanApprovedModal() {
    closeModal('plan-approved-modal');
  }

  /** "Proceed to Payment" on the approval popup — jump straight to the Payment tab. */
  function goToPaymentFromApproval() {
    closeModal('plan-approved-modal');
    Navigation.activateTab('member', 'payment', document.getElementById('nav-member-payment'));
  }

  /** Show the one-time "Congratulations! Your payment was approved" popup,
   *  including the date the (now-active) membership starts from. */
  function _showPaymentApprovedNoticeIfAny(notice) {
    if (!notice) return;
    const msgEl = document.getElementById('payment-approved-message');
    if (msgEl) {
      msgEl.textContent = `Congratulations! Your payment has been approved. Your ${notice.plan_name} membership plan starts on ${notice.start_date}.`;
    }
    openModal('payment-approved-modal');
  }

  /** "✕" or "OK" on the payment-approved popup — just dismiss it. */
  function closePaymentApprovedModal() {
    closeModal('payment-approved-modal');
  }

  /** Show the one-time "Your request was declined" popup, if the server
   *  flagged this page load as the first one since staff/admin rejected it. */
  function _showDeclinedNoticeIfAny(notice) {
    if (!notice) return;
    const msgEl = document.getElementById('plan-declined-message');
    if (msgEl) {
      msgEl.textContent = `Your ${notice.plan_name} plan request was declined. You can submit a new request from My Membership.`;
    }
    openModal('plan-declined-modal');
  }

  /** "✕" or "OK" on the declined popup — just dismiss it. */
  function closePlanDeclinedModal() {
    closeModal('plan-declined-modal');
  }

  function _parseMemberDashboardData() {
    const el = document.getElementById('member-dashboard-data');
    if (!el) return {};
    try {
      return JSON.parse(el.textContent || el.innerText || '{}');
    } catch (e) {
      return {};
    }
  }

  /** Parse a JSON <script> tag embedded by the server (e.g. plan/service
   *  content managed by admin/staff). Returns fallback on any failure. */
  function _parseJsonScript(id, fallback) {
    const el = document.getElementById(id);
    if (!el) return fallback;
    try {
      return JSON.parse(el.textContent || el.innerText || 'null') ?? fallback;
    } catch (e) {
      return fallback;
    }
  }

  /** Enable/disable the "NEXT" arrow — members can't browse into the future. */
  function _updateAttendanceNav(isCurrentMonth) {
    const nextBtn = document.getElementById('attendance-next-month');
    if (nextBtn) nextBtn.disabled = !!isCurrentMonth;
  }

  function _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function _renderAttendanceSessionHistory(rows) {
    const body = document.getElementById('attendance-session-history-body');
    if (!body) return;
    if (!rows || !rows.length) {
      body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);">No sessions logged this month yet.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(s => `<tr><td>${_escapeHtml(s.date)}</td><td>${_escapeHtml(s.check_in)}</td><td>${_escapeHtml(s.check_out)}</td><td>${_escapeHtml(s.duration)}</td></tr>`).join('');
  }

  /** Back/forward navigation for the "My Attendance" calendar — fetches that
   *  month's data from the server and re-renders in place, no page reload. */
  function changeAttendanceMonth(direction) {
    if (attendanceBusy) return;
    if (!attendanceView.year || !attendanceView.month) return;

    let { year, month } = attendanceView;
    month += direction;
    if (month < 1)  { month = 12; year -= 1; }
    if (month > 12) { month = 1;  year += 1; }

    attendanceBusy = true;
    const prevBtn = document.getElementById('attendance-prev-month');
    const nextBtn = document.getElementById('attendance-next-month');
    const nextWasDisabled = nextBtn ? nextBtn.disabled : false;
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;

    fetch(`/member/attendance-month?year=${year}&month=${month}`)
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast(data.error || 'Could not load that month.', 'error');
          if (prevBtn) prevBtn.disabled = false;
          if (nextBtn) nextBtn.disabled = nextWasDisabled;
          return;
        }
        attendanceView = { year: data.year, month: data.month };
        const label = document.getElementById('attendance-month-label');
        if (label) label.textContent = data.month_label;
        buildAttGrid('att-grid-member', data.present_days || [], data.days_in_month || 30, data.today_day || null, data.no_plan_days || []);
        _renderAttendanceSessionHistory(data.session_history);
        if (prevBtn) prevBtn.disabled = false;
        _updateAttendanceNav(data.is_current_month);
      })
      .catch(() => {
        showToast('Could not reach the server. Please try again.', 'error');
        if (prevBtn) prevBtn.disabled = false;
        if (nextBtn) nextBtn.disabled = nextWasDisabled;
      })
      .finally(() => { attendanceBusy = false; });
  }

  function _hydrateProgressBars() {
    document.querySelectorAll('.progress-fill[data-width]').forEach(el => {
      const width = Number(el.dataset.width);
      if (!Number.isNaN(width)) {
        el.style.width = `${width}%`;
      }
    });
  }

  /** Restrict the "when do you want to start?" picker to today or later,
   *  and default it to today so most members can just leave it as-is. */
  function _initStartDateField() {
    const input = document.getElementById('member-renew-start');
    if (!input) return;
    const todayStr = new Date().toISOString().slice(0, 10);
    input.min   = todayStr;
    input.value = todayStr;
  }

  function tab(tabName, navEl) {
    if (LOCKED_TABS.includes(tabName) && !_planActive()) {
      showToast('Activate your membership first to unlock this.', 'error');
      Navigation.activateTab('member', 'membership', document.getElementById('nav-member-membership'));
      return;
    }
    Navigation.activateTab('member', tabName, navEl);
  }

  /* ══════════════════════════════════════════════
     AI FITNESS GOAL & RECOMMENDATION — Steps 1 & 2
     (Member Fitness Information + Goal Selection only.
      No BMI/BMR/TDEE, no AI call — those are later stages.)
  ══════════════════════════════════════════════ */

  /** Decide which step to show when the Body Goals tab first loads, based
   *  on what's already saved server-side (FITNESS_DATA, from
   *  #member-fitness-data). Lets a member navigate away and back without
   *  re-entering anything they've already submitted. */
  function _fwInit() {
    if (!document.getElementById('fitness-wizard-panel')) return; // safety: markup not present

    if (FITNESS_DATA && FITNESS_DATA.fitness_goal && FITNESS_DATA.calculations) {
      _fwShowStep3(FITNESS_DATA.calculations, FITNESS_DATA.fitness_goal);
    } else if (FITNESS_DATA && FITNESS_DATA.fitness_goal) {
      // Goal already selected but no calculation snapshot saved yet (e.g. it
      // failed last time, or a birthday was missing) — try again automatically.
      _fwRunCalculation(FITNESS_DATA.fitness_goal);
    } else if (FITNESS_DATA && FITNESS_DATA.height_cm && FITNESS_DATA.sex && FITNESS_DATA.activity_level) {
      _fwShowStep(2);
    } else {
      _fwShowStep(1);
    }
  }

  /** Switch which step panel is visible and update the step-dot indicator.
   *  step: 1 or 2 (Step 3 and the confirmation/error state are shown via
   *  their own dedicated functions below, since they're driven by the
   *  calculation call rather than simple forward navigation). */
  function _fwShowStep(step) {
    const step1El  = document.getElementById('fw-step-1');
    const step2El  = document.getElementById('fw-step-2');
    const step3El  = document.getElementById('fw-step-3');
    const confirmEl = document.getElementById('fw-confirm');
    const dot1 = document.getElementById('fw-dot-1');
    const dot2 = document.getElementById('fw-dot-2');
    const dot3 = document.getElementById('fw-dot-3');

    if (step1El)   step1El.style.display   = step === 1 ? '' : 'none';
    if (step2El)   step2El.style.display   = step === 2 ? '' : 'none';
    if (step3El)   step3El.style.display   = 'none';
    if (confirmEl) confirmEl.style.display = 'none';
    _fwHidePlanPanel();

    if (dot1) dot1.classList.toggle('active', step === 1);
    if (dot2) {
      dot2.classList.toggle('active', step === 2);
      dot2.classList.toggle('complete', step > 2);
    }
    if (dot1 && step > 1) { dot1.classList.remove('active'); dot1.classList.add('complete'); }
    if (dot3) { dot3.classList.remove('active'); dot3.classList.remove('complete'); }

    if (step === 2) _fwPreselectExistingGoal();
  }

  /** Show Step 3 with the given calculation results (BMI/BMR/TDEE/calorie
   *  target/protein target) and the goal-specific explanatory note. */
  function _fwShowStep3(calc, goal) {
    const step1El  = document.getElementById('fw-step-1');
    const step2El  = document.getElementById('fw-step-2');
    const step3El  = document.getElementById('fw-step-3');
    const confirmEl = document.getElementById('fw-confirm');
    const dot1 = document.getElementById('fw-dot-1');
    const dot2 = document.getElementById('fw-dot-2');
    const dot3 = document.getElementById('fw-dot-3');

    if (step1El)   step1El.style.display   = 'none';
    if (step2El)   step2El.style.display   = 'none';
    if (confirmEl) confirmEl.style.display = 'none';
    if (step3El)   step3El.style.display   = '';

    if (dot1) { dot1.classList.remove('active'); dot1.classList.add('complete'); }
    if (dot2) { dot2.classList.remove('active'); dot2.classList.add('complete'); }
    if (dot3) { dot3.classList.remove('complete'); dot3.classList.add('active'); }

    const bmiEl     = document.getElementById('fw-result-bmi');
    const bmrEl     = document.getElementById('fw-result-bmr');
    const tdeeEl    = document.getElementById('fw-result-tdee');
    const calEl     = document.getElementById('fw-result-calorie');
    const proteinEl = document.getElementById('fw-result-protein');
    const noteEl    = document.getElementById('fw-goal-note');

    if (bmiEl)     bmiEl.textContent     = calc.bmi;
    if (bmrEl)     bmrEl.textContent     = calc.bmr + ' kcal/day';
    if (tdeeEl)    tdeeEl.textContent    = calc.tdee + ' kcal/day';
    if (calEl)     calEl.textContent     = calc.calorie_target + ' kcal/day';
    if (proteinEl) proteinEl.textContent = calc.protein_target_g + ' g/day';
    if (noteEl)    noteEl.textContent    = _fwGoalNote(goal);

    // Stage 4 — load the personalized plan now that Step 3 has results.
    // Non-fatal if this fails: Step 3's numbers above remain fully usable.
    _fwLoadRecommendations();
  }

  /** Stage 4 — fetch the deterministic, rule-based recommendations and
   *  render them. Failure here never affects Step 1/2/3, which are already
   *  shown and saved independently of this call. */
  function _fwLoadRecommendations() {
    const panel   = document.getElementById('fitness-plan-panel');
    const status  = document.getElementById('fp-status-message');
    const content = document.getElementById('fp-plan-content');
    if (!panel) return; // safety: markup not present

    panel.style.display = '';
    if (content) content.style.display = 'none';
    if (status) { status.style.display = ''; status.textContent = 'Loading your personalized plan...'; }

    fetch('/member/fitness/recommendations', { method: 'GET' })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          if (status) { status.style.display = ''; status.textContent = data.error || 'Your personalized plan is temporarily unavailable.'; }
          if (content) content.style.display = 'none';
          return;
        }
        if (status) status.style.display = 'none';
        _fwRenderRecommendations(data);
        if (content) content.style.display = '';
      })
      .catch(() => {
        if (status) { status.style.display = ''; status.textContent = 'Could not load your personalized plan. Please try again later.'; }
        if (content) content.style.display = 'none';
      });
  }

  /** Renders the recommendations payload from GET /member/fitness/recommendations
   *  into the "Your Personalized Fitness Plan" mini-dashboard (summary strip +
   *  tabbed panels). Presentation only — the payload shape and every value in
   *  it come unchanged from the existing endpoint; nothing here recalculates
   *  or duplicates that data. */
  function _fwRenderRecommendations(data) {
    // Always land back on the Overview tab whenever a fresh plan renders
    // (new goal, new weight, or first load) — never leaves the member on
    // whatever tab happened to be open for a previous, now-stale plan.
    switchFitnessPlanTab('overview', document.querySelector('.fp-tab-btn[data-fp-tab="overview"]'));

    // ── Summary strip ──
    const goalLabel = _fwGoalLabel(data.goal);
    const summaryGoalEl     = document.getElementById('fp-summary-goal');
    const summaryActivityEl = document.getElementById('fp-summary-activity');
    const summaryCalEl      = document.getElementById('fp-summary-calorie');
    const summaryProteinEl  = document.getElementById('fp-summary-protein');
    const overviewGoalEl    = document.getElementById('fp-overview-goal-label');
    if (summaryGoalEl)     summaryGoalEl.textContent     = goalLabel;
    if (summaryActivityEl) summaryActivityEl.textContent = _fwActivityLabel(FITNESS_DATA && FITNESS_DATA.activity_level);
    if (summaryCalEl)      summaryCalEl.textContent      = data.nutrition_targets.calorie_target + ' kcal';
    if (summaryProteinEl)  summaryProteinEl.textContent  = data.nutrition_targets.protein_target_g + 'g';
    if (overviewGoalEl)    overviewGoalEl.textContent    = goalLabel;

    // ── NUTRITION tab ──
    const calEl     = document.getElementById('fp-nutrition-calorie');
    const proteinEl = document.getElementById('fp-nutrition-protein');
    if (calEl)     calEl.textContent     = data.nutrition_targets.calorie_target + ' kcal/day';
    if (proteinEl) proteinEl.textContent = data.nutrition_targets.protein_target_g + ' g/day';

    // ── FOODS & MEALS tab — Recommended Foods: de-duplicated cards drawn
    //    from every meal. ──
    const foodsListEl = document.getElementById('fp-foods-list');
    if (foodsListEl) {
      const seen = new Set();
      const rows = [];
      Object.values(data.meal_plan.meals).forEach(meal => {
        meal.items.forEach(item => {
          if (seen.has(item.name)) return;
          seen.add(item.name);
          rows.push(item);
        });
      });
      foodsListEl.innerHTML = rows.map(item => `
        <div class="fp-card fp-food-card">
          <div class="fp-food-name">${_fwEscape(item.name)}</div>
          <div class="fp-food-serving">${_fwEscape(item.serving)}</div>
          <div class="fp-food-macros"><span class="fp-macro-cal">${item.calories} kcal</span><span class="fp-macro-sep">|</span><span class="fp-macro-protein">${item.protein_g}g protein</span></div>
        </div>
      `).join('');
    }

    // Sample Daily Meal Plan — one card per Breakfast/Lunch/Snack/Dinner.
    const mealPlanEl = document.getElementById('fp-meal-plan');
    const mealTotalEl = document.getElementById('fp-meal-plan-total');
    if (mealPlanEl) {
      const mealOrder = ['breakfast', 'lunch', 'snack', 'dinner'];
      const mealLabels = { breakfast: 'Breakfast', lunch: 'Lunch', snack: 'Snack', dinner: 'Dinner' };
      mealPlanEl.innerHTML = mealOrder.map(mealKey => {
        const meal = data.meal_plan.meals[mealKey];
        if (!meal) return '';
        const items = meal.items.map(item =>
          `<div class="fp-meal-item">• ${_fwEscape(item.name)} — ${_fwEscape(item.serving)}</div>`
        ).join('');
        return `
          <div class="fp-card fp-meal-card">
            <div class="fp-meal-card-header"><span class="fp-meal-name">${mealLabels[mealKey].toUpperCase()}</span><span class="fp-meal-macros">${meal.meal_calories} kcal · ${meal.meal_protein_g}g</span></div>
            <div class="fp-meal-items">${items}</div>
          </div>
        `;
      }).join('');
    }
    if (mealTotalEl) {
      mealTotalEl.textContent = `Approximate daily total: ${data.meal_plan.total_calories} kcal, ${data.meal_plan.total_protein_g}g protein `
        + `(target: ${data.nutrition_targets.calorie_target} kcal, ${data.nutrition_targets.protein_target_g}g protein).`;
    }

    // ── WORKOUTS tab — Day 1–7 weekly routine (training/rest days).
    //    Reuses the existing weekly_routine payload from the same
    //    /member/fitness/recommendations response — no separate fetch.
    //    The schedule itself (6 training days + 1 rest day, same
    //    muscle-group rotation) is now fixed for every activity level;
    //    activity level only changes the number of sets per exercise
    //    (shown per-exercise below), so this line clarifies that
    //    relationship instead of implying the schedule varies. ──
    const freqEl = document.getElementById('fp-workout-frequency');
    const routine = data.weekly_routine;
    if (freqEl) {
      if (routine) {
        // Read the actual sets count straight from the routine payload
        // (every exercise already carries it) instead of duplicating the
        // activity-level -> sets-tier mapping here in JS.
        const firstTrainDay = routine.days.find(d => d.type === 'train' && d.exercises.length > 0);
        const setsCount = firstTrainDay ? firstTrainDay.exercises[0].sets : null;
        freqEl.textContent = `${routine.training_days} training days and ${routine.rest_days} rest day every week. `
          + (setsCount ? `Your activity level sets how many sets per exercise (currently ${setsCount} sets).` : '');
      } else {
        freqEl.textContent = (data.workouts && data.workouts.frequency_note) || '';
      }
    }
    _fwRenderWeeklyRoutine(routine);

    // ── EQUIPMENT tab ──
    const equipmentListEl = document.getElementById('fp-equipment-list');
    if (equipmentListEl) {
      equipmentListEl.innerHTML = data.equipment.map(eq => `
        <div class="fp-card fp-equipment-card">
          <div class="fp-equipment-name">${_fwEscape(eq.name)}</div>
          <div class="fp-equipment-note">${_fwEscape(eq.note)}</div>
        </div>
      `).join('');
    }

    // ── TIPS tab ──
    const tipsListEl = document.getElementById('fp-tips-list');
    if (tipsListEl) {
      tipsListEl.innerHTML = (data.tips || []).map(tip => `<li style="margin-bottom:6px;">${_fwEscape(tip)}</li>`).join('');
    }
  }

  /** Renders the Day 1–7 tab nav + day panels for the weekly workout
   *  routine (fp-panel-workouts). Only one day is visible at a time; Day 1
   *  is selected by default whenever a fresh routine renders. Training
   *  days show exercises as compact cards (reusing .fp-exercise-card);
   *  rest days show a short recovery note instead. */
  function _fwRenderWeeklyRoutine(routine) {
    const tabsEl = document.getElementById('fp-day-tabs');
    const panelsEl = document.getElementById('fp-day-panels');
    if (!tabsEl || !panelsEl) return;

    if (!routine || !routine.days || !routine.days.length) {
      tabsEl.innerHTML = '';
      panelsEl.innerHTML = '';
      return;
    }

    tabsEl.innerHTML = routine.days.map(day => `
      <button type="button" class="fp-tab-btn fp-day-tab-btn${day.day_number === 1 ? ' active' : ''}${day.type === 'rest' ? ' fp-day-tab-rest' : ''}"
              data-fp-day="${day.day_number}" onclick="switchWorkoutDay(${day.day_number}, this)">
        DAY ${day.day_number}
      </button>
    `).join('');

    // Refresh the instructions-modal lookup cache from this render, keyed
    // by exercise id (falls back to name if an id is ever missing, so a
    // stale/older payload shape doesn't break the button).
    _fwExerciseCache = {};
    routine.days.forEach(day => (day.exercises || []).forEach(ex => {
      _fwExerciseCache[ex.id != null ? ex.id : ex.name] = ex;
    }));

    panelsEl.innerHTML = routine.days.map(day => {
      const bodyHtml = day.type === 'rest'
        ? `
          <div class="fp-card fp-rest-card">
            <div class="fp-rest-label">REST / RECOVERY DAY</div>
            <div class="fp-rest-note">${_fwEscape(day.note)}</div>
          </div>
        `
        : `
          <div class="fp-day-focus">${_fwEscape(day.focus)}</div>
          <div class="fp-card-grid">
            ${day.exercises.map(ex => `
              <div class="fp-card fp-exercise-card">
                <div class="fp-exercise-header"><span class="fp-exercise-name">${_fwEscape(ex.name)}</span><span class="fp-exercise-area">${_fwEscape(ex.target_area)}</span></div>
                ${ex.sub_target ? `<div class="fp-exercise-subtarget">${_fwEscape(ex.sub_target)}</div>` : ''}
                <div class="fp-exercise-sets">${ex.sets ? _fwEscape(ex.sets) + ' sets' : ''}${ex.sets && ex.reps ? ' × ' : ''}${ex.reps ? _fwEscape(ex.reps) : ''}</div>
                ${ex.equipment_name ? `<div class="fp-exercise-equipment">🧰 ${_fwEscape(ex.equipment_name)}</div>` : ''}
                ${ex.instructions ? `<button type="button" class="fp-view-instructions-btn" onclick="openExerciseInstructionsModal('${ex.id != null ? ex.id : _fwEscape(ex.name)}')">View Instructions</button>` : ''}
              </div>
            `).join('')}
          </div>
        `;
      return `<div class="fp-day-panel" data-fp-day-panel="${day.day_number}" style="${day.day_number === 1 ? '' : 'display:none;'}">${bodyHtml}</div>`;
    }).join('');
  }

  /** Opens the exercise-instructions modal (mirrors openServiceModal's
   *  pattern) using the exercise looked up from _fwExerciseCache — no
   *  separate fetch, since the weekly routine payload already carries the
   *  full instructions text. */
  function openExerciseInstructionsModal(exerciseKey) {
    const ex = _fwExerciseCache[exerciseKey];
    if (!ex) return;

    const title    = document.getElementById('exercise-instructions-modal-title');
    const subtitle = document.getElementById('exercise-instructions-modal-subtitle');
    const steps    = document.getElementById('exercise-instructions-modal-steps');

    if (title)    title.textContent = ex.name.toUpperCase();
    if (subtitle) subtitle.textContent = [ex.target_area, ex.sub_target].filter(Boolean).join(' — ');

    const lines = (ex.instructions || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (steps) steps.innerHTML = lines.map(line => `<li>${_fwEscape(line.replace(/^\d+\.\s*/, ''))}</li>`).join('');

    openModal('exercise-instructions-modal');
  }

  /** Switches which Day panel is visible inside the Workouts tab, mirroring
   *  switchFitnessPlanTab's pattern one level down. */
  function switchWorkoutDay(dayNumber, btnEl) {
    document.querySelectorAll('.fp-day-panel').forEach(panel => {
      panel.style.display = String(panel.dataset.fpDayPanel) === String(dayNumber) ? '' : 'none';
    });
    document.querySelectorAll('.fp-day-tab-btn').forEach(btn => btn.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
  }

  /** Switches which "Your Personalized Fitness Plan" tab panel is visible
   *  and updates the active tab-button state. Pure UI state — never
   *  re-fetches or recomputes anything. */
  function switchFitnessPlanTab(tabName, btnEl) {
    document.querySelectorAll('.fp-tab-panel').forEach(panel => {
      panel.style.display = panel.dataset.fpPanel === tabName ? '' : 'none';
    });
    document.querySelectorAll('.fp-tab-btn').forEach(btn => btn.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
  }

  /** Human-readable label for an activity_level slug, for display in the
   *  plan summary strip (the same slugs already used by Step 1's <select>). */
  function _fwActivityLabel(level) {
    const labels = {
      low_activity:      'Low Activity',
      moderate_activity: 'Moderate Activity',
      high_activity:     'High Activity',
    };
    return labels[level] || (level || '—');
  }

  /** Minimal HTML-escaping for text interpolated into innerHTML above —
   *  all source text here comes from our own seeded catalog/tips, not
   *  member input, but escaping is kept as a safe default regardless. */
  function _fwEscape(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Goal-specific explanatory note shown above the Step 3 results. */
  function _fwGoalNote(goal) {
    const notes = {
      CUT:      'Your calorie target is set below estimated maintenance to support fat loss.',
      BULK:     'Your calorie target is set above estimated maintenance to support weight gain and muscle growth.',
      MAINTAIN: 'Your calorie target is approximately your estimated maintenance level.',
      RECOMP:   'Your calorie target uses a modest deficit while maintaining a higher protein target.'
    };
    return notes[goal] || '';
  }

  /** Call the deterministic calculation endpoint and show Step 3 on
   *  success. On failure, falls back to the confirmation panel with an
   *  error message and a Retry button — Step 1/2 data is never touched or
   *  lost by a calculation failure. */
  function _fwRunCalculation(goal) {
    showLoadingOverlay('Please wait, calculating your targets...');
    return fetch('/member/fitness/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        hideLoadingOverlay();
        if (!ok || !data.success) {
          _fwShowCalculationError(goal, data.error || 'Could not calculate your fitness targets.');
          return;
        }
        FITNESS_DATA = Object.assign({}, FITNESS_DATA, { calculations: data.calculations });
        _fwShowStep3(data.calculations, data.goal);
      })
      .catch(() => {
        hideLoadingOverlay();
        _fwShowCalculationError(goal, 'Could not reach the server. Please try again.');
      });
  }

  /** Fallback state when calculation fails — reuses the confirmation panel
   *  markup, showing the goal that's already saved plus a Retry button, so
   *  the member never loses their Step 1/2 progress. */
  function _fwShowCalculationError(goal, message) {
    const step1El   = document.getElementById('fw-step-1');
    const step2El   = document.getElementById('fw-step-2');
    const step3El   = document.getElementById('fw-step-3');
    const confirmEl = document.getElementById('fw-confirm');
    const labelEl   = document.getElementById('fw-confirm-goal-label');
    const msgEl     = document.getElementById('fw-confirm-message');
    const retryBtn  = document.getElementById('fw-confirm-retry-btn');
    const dot3      = document.getElementById('fw-dot-3');

    if (step1El)   step1El.style.display   = 'none';
    if (step2El)   step2El.style.display   = 'none';
    if (step3El)   step3El.style.display   = 'none';
    if (confirmEl) confirmEl.style.display = '';
    _fwHidePlanPanel();
    if (labelEl) labelEl.textContent = _fwGoalLabel(goal);
    if (msgEl)   msgEl.textContent   = message;
    if (retryBtn) { retryBtn.style.display = ''; retryBtn.dataset.goal = goal || ''; }
    if (dot3) { dot3.classList.remove('active'); dot3.classList.remove('complete'); }
  }

  /** Hides the Stage 4 "Your Personalized Fitness Plan" section — used
   *  whenever the wizard is showing anything other than Step 3 results. */
  function _fwHidePlanPanel() {
    const panel = document.getElementById('fitness-plan-panel');
    if (panel) panel.style.display = 'none';
  }

  /** "RETRY CALCULATION" on the fallback state. */
  function retryFitnessCalculation() {
    const retryBtn = document.getElementById('fw-confirm-retry-btn');
    const goal = (retryBtn && retryBtn.dataset.goal) || (FITNESS_DATA && FITNESS_DATA.fitness_goal);
    _fwRunCalculation(goal);
  }

  /** Human-readable label for a stored goal code. */
  function _fwGoalLabel(goal) {
    const labels = { CUT: 'CUT', BULK: 'BULK', MAINTAIN: 'MAINTAIN', RECOMP: 'BODY RECOMPOSITION' };
    return labels[goal] || goal;
  }

  /** If the member already has a goal saved (e.g. they clicked "CHANGE
   *  GOAL" from Step 3 or the fallback state), highlight that card as
   *  selected when Step 2 is shown, instead of starting from a blank slate. */
  function _fwPreselectExistingGoal() {
    const existing = FITNESS_DATA && FITNESS_DATA.fitness_goal;
    const grid = document.getElementById('fw-goal-grid');
    if (!grid) return;
    grid.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
    fwSelectedGoal = null;
    const btn = document.getElementById('fw-step2-btn');
    if (existing) {
      const card = grid.querySelector(`.plan-card[data-goal="${existing}"]`);
      if (card) {
        card.classList.add('selected');
        fwSelectedGoal = existing;
      }
    }
    if (btn) btn.disabled = !fwSelectedGoal;
  }

  /** Step 1 — validate height/weight/sex/activity level client-side, then
   *  save to the server. Age is never collected here: it's derived
   *  server-side from the member's existing birthday. */
  function submitFitnessStep1() {
    const heightRaw = _val('fw-height');
    const weightRaw = _val('fw-weight');
    const sex            = document.getElementById('fw-sex')?.value || '';
    const activityLevel  = document.getElementById('fw-activity')?.value || '';

    if (!heightRaw || !weightRaw) {
      showToast('Please enter your height and weight.', 'error');
      return;
    }
    const height = parseFloat(heightRaw);
    const weight = parseFloat(weightRaw);
    if (isNaN(height) || isNaN(weight)) {
      showToast('Height and weight must be numbers.', 'error');
      return;
    }
    if (height < 100 || height > 250) {
      showToast('Height must be between 100 and 250 cm.', 'error');
      return;
    }
    if (weight < 20 || weight > 300) {
      showToast('Weight must be between 20 and 300 kg.', 'error');
      return;
    }
    if (!sex) {
      showToast('Please select your sex.', 'error');
      return;
    }
    if (!activityLevel) {
      showToast('Please select your activity level.', 'error');
      return;
    }

    const btn = document.getElementById('fw-step1-btn');
    const originalLabel = btn ? btn.textContent : 'CONTINUE';
    if (btn) { btn.disabled = true; btn.textContent = 'SAVING...'; }
    showLoadingOverlay('Please wait, saving your information...');

    fetch('/member/fitness/save-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ height_cm: height, weight_kg: weight, sex, activity_level: activityLevel })
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        hideLoadingOverlay();
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
        if (!ok || !data.success) {
          showToast(data.error || 'Could not save your information.', 'error');
          return;
        }
        FITNESS_DATA = Object.assign({}, FITNESS_DATA, data.fitness_profile);
        showToast(data.message || 'Information saved.', 'success');
        // If a goal is already set (e.g. the member came back to update
        // their weight), recalculate immediately instead of dropping them
        // back to Step 2 — this is what keeps BMI/BMR/TDEE/targets in sync
        // whenever the current weight changes.
        if (FITNESS_DATA.fitness_goal) {
          _fwRunCalculation(FITNESS_DATA.fitness_goal);
        } else {
          _fwShowStep(2);
        }
      })
      .catch(() => {
        hideLoadingOverlay();
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  /** Step 2 — click a goal card to select it (single-select, clear visual
   *  active state), enabling the Continue button. Not yet saved to the
   *  server until CONTINUE is pressed. */
  function selectFitnessGoal(cardEl) {
    if (!cardEl) return;
    const grid = document.getElementById('fw-goal-grid');
    if (grid) grid.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
    cardEl.classList.add('selected');
    fwSelectedGoal = cardEl.dataset.goal;
    const btn = document.getElementById('fw-step2-btn');
    if (btn) btn.disabled = false;
  }

  /** Step 2 — save the selected goal to the server. */
  function submitFitnessStep2() {
    if (!fwSelectedGoal) {
      showToast('Please select a fitness goal.', 'error');
      return;
    }

    const btn = document.getElementById('fw-step2-btn');
    const originalLabel = btn ? btn.textContent : 'CONTINUE';
    if (btn) { btn.disabled = true; btn.textContent = 'SAVING...'; }
    showLoadingOverlay('Please wait, saving your goal...');

    fetch('/member/fitness/save-goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fitness_goal: fwSelectedGoal })
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        hideLoadingOverlay();
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
        if (!ok || !data.success) {
          showToast(data.error || 'Could not save your goal.', 'error');
          return;
        }
        FITNESS_DATA = Object.assign({}, FITNESS_DATA, { fitness_goal: data.fitness_goal });
        showToast(data.message || 'Goal saved.', 'success');
        // Calculate targets for the (possibly new) goal — this is also
        // what keeps BMI/BMR/TDEE/targets in sync whenever the goal changes.
        _fwRunCalculation(data.fitness_goal);
      })
      .catch(() => {
        hideLoadingOverlay();
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  /** "← BACK" on Step 2 — return to Step 1 (values remain filled in). */
  function fitnessWizardBack() {
    _fwShowStep(1);
  }

  /** "CHANGE GOAL" / "← BACK TO GOAL" on Step 3 or the fallback state —
   *  return to Step 2 with the current goal pre-selected. */
  function fitnessWizardEditGoal() {
    _fwShowStep(2);
  }

  /** Show/hide the school ID upload field based on the student Yes/No dropdown */
  function toggleStudentIdField(select) {
    const group = document.getElementById('member-student-id-group');
    if (group) {
      const isStudent = select?.value === 'yes';
      group.style.display = isStudent ? 'block' : 'none';
      if (!isStudent) {
        const input   = document.getElementById('member-student-id');
        const preview = document.getElementById('member-student-id-preview');
        if (input) input.value = '';
        if (preview) { preview.style.display = 'none'; preview.removeAttribute('src'); }
      }
    }
    _updatePlanPriceDisplays();
  }

  // ── Student discount pricing ──
  // This promo table is a fixed rate list (not part of the admin/staff
  // content editor) and mirrors the same STUDENT_PLAN_PRICES table the
  // server uses to compute the actual charge — so what's shown here always
  // matches what gets billed. Regular prices come from PLAN_DATA (admin/
  // staff editable). Daily has no listed student rate on purpose — it just
  // falls back to its normal price everywhere below.
  const STUDENT_PRICES = { 'half month': 400, monthly: 800, yearly: 6000 };

  function _formatPeso(n) { return '₱' + Number(n).toLocaleString('en-US'); }

  function _isStudentSelected() {
    return document.getElementById('member-renew-student')?.value === 'yes';
  }

  /** Plain "₱N" text for a plan key, honoring student status. */
  function _planPriceText(key, isStudent) {
    const regular = PLAN_DATA[key] ? PLAN_DATA[key].price : 0;
    const price = (isStudent && STUDENT_PRICES[key] !== undefined) ? STUDENT_PRICES[key] : regular;
    return _formatPeso(price);
  }

  /** Refresh the price shown on each plan card — struck-through original
   *  plus the discounted rate when the student toggle is set to Yes. */
  function _updatePlanPriceDisplays() {
    const isStudent = _isStudentSelected();
    Object.keys(PLAN_DATA).forEach(key => {
      const el = document.querySelector(`#member-membership .plan-card[onclick*="'${key}'"] .plan-price`);
      if (!el) return;
      const regular = PLAN_DATA[key].price;
      const discounted = isStudent && STUDENT_PRICES[key] !== undefined;
      el.innerHTML = discounted
        ? `<span style="text-decoration:line-through;opacity:.55;font-size:0.65em;margin-right:4px;">${_formatPeso(regular)}</span>${_formatPeso(STUDENT_PRICES[key])}`
        : _formatPeso(regular);
    });
  }


  /** Preview uploaded school ID image */
  function previewStudentId(input) {
    const file    = input.files && input.files[0];
    const preview = document.getElementById('member-student-id-preview');
    if (!preview) return;
    if (!file) { preview.style.display = 'none'; preview.removeAttribute('src'); return; }
    preview.src           = URL.createObjectURL(file);
    preview.style.display = 'block';
  }

  /** Show/hide the coach selection dropdown based on the coach Yes/No dropdown */
  function toggleCoachField(select) {
    const group = document.getElementById('member-coach-name-group');
    if (!group) return;
    const wantsCoach = select?.value === 'yes';
    group.style.display = wantsCoach ? 'block' : 'none';
    if (!wantsCoach) {
      const coachSelect = document.getElementById('member-renew-coach-name');
      if (coachSelect) coachSelect.value = '';
    }
  }

  /** Show/hide the GCash reference + proof-of-payment fields based on the
   *  payment method dropdown (Payment tab). */
  /** Force the Submit/Proceed button to match whatever the payment-method
   *  dropdown is actually showing, right when the page loads. Needed
   *  because some browsers restore a <select>'s previous value on reload
   *  (e.g. it remembers "GCash" from an earlier visit) without firing a
   *  'change' event — so without this, the button label could silently
   *  fall out of sync with what the dropdown displays. */
  function _syncPaymentMethodButton() {
    const select = document.getElementById('payment-method-select');
    if (select) togglePaymentProofField(select);
  }

  function togglePaymentProofField(select) {
    const group = document.getElementById('payment-gcash-fields');
    if (!group) return;
    const isGcash = select?.value === 'gcash';
    group.style.display = isGcash ? 'block' : 'none';
    if (!isGcash) {
      const refEl     = document.getElementById('payment-gcash-reference');
      const proofEl   = document.getElementById('payment-gcash-proof');
      const previewEl = document.getElementById('payment-gcash-proof-preview');
      if (refEl) refEl.value = '';
      if (proofEl) proofEl.value = '';
      if (previewEl) { previewEl.style.display = 'none'; previewEl.removeAttribute('src'); }
    }
    // Cash isn't actually "submitted" online — the member still has to pay
    // in person at the front desk, so the button shouldn't claim to submit
    // anything. GCash is a real online submission (reference + proof sent
    // to admin for verification), so it keeps the SUBMIT PAYMENT label.
    const submitBtn = document.getElementById('payment-submit-btn');
    if (submitBtn) submitBtn.textContent = isGcash ? 'SUBMIT PAYMENT' : 'PROCEED TO FRONT DESK';
  }

  /** Preview the uploaded GCash proof-of-payment screenshot (Payment tab) */
  function previewGcashProof(input) {
    const file    = input.files && input.files[0];
    const preview = document.getElementById('payment-gcash-proof-preview');
    if (!preview) return;
    if (!file) { preview.style.display = 'none'; preview.removeAttribute('src'); return; }
    preview.src           = URL.createObjectURL(file);
    preview.style.display = 'block';
  }

  let _pendingPaymentSubmission = null;

  /** Validate the chosen payment method (Cash/GCash), then ask for
   *  confirmation before actually sending it — submitting fires off a real
   *  payment request that admin will act on, so we don't want an accidental
   *  click to submit it right away. */
  function submitPaymentMethod() {
    const methodEl       = document.getElementById('payment-method-select');
    const paymentMethod  = methodEl?.value || 'cash';
    const isGcash        = paymentMethod === 'gcash';
    const gcashRefEl     = document.getElementById('payment-gcash-reference');
    const gcashRef       = (gcashRefEl?.value || '').trim();
    const gcashProofEl   = document.getElementById('payment-gcash-proof');
    const gcashProofFile = gcashProofEl && gcashProofEl.files && gcashProofEl.files[0];

    if (isGcash && !gcashRef) {
      showToast('Please enter your GCash reference number', 'error');
      return;
    }
    if (isGcash && !gcashProofFile) {
      showToast('Please attach a screenshot of your GCash proof of payment', 'error');
      return;
    }

    _pendingPaymentSubmission = { paymentMethod, isGcash, gcashRef, gcashProofFile };

    const titleEl = document.getElementById('confirm-payment-title');
    const textEl  = document.getElementById('confirm-payment-text');
    if (titleEl) titleEl.textContent = isGcash ? 'CONFIRM PAYMENT' : 'PROCEED TO FRONT DESK?';
    if (textEl) {
      textEl.textContent = isGcash
        ? 'Are you sure you want to submit your payment?'
        : 'Are you sure you want to proceed with cash payment?';
    }

    openModal('confirm-payment-modal');
  }

  /** "Yes" button inside the payment confirmation modal — actually submits. */
  function confirmSubmitPayment() {
    closeModal('confirm-payment-modal');
    if (!_pendingPaymentSubmission) return;
    _doSubmitPaymentMethod(_pendingPaymentSubmission);
    _pendingPaymentSubmission = null;
  }

  /** "No" button inside the payment confirmation modal — discards it and
   *  returns to the Payment tab, no changes made. */
  function cancelSubmitPayment() {
    closeModal('confirm-payment-modal');
    _pendingPaymentSubmission = null;
  }

  /** Actually send the chosen payment method to the backend. */
  function _doSubmitPaymentMethod(p) {
    const { paymentMethod, isGcash, gcashRef, gcashProofFile } = p;

    const formData = new FormData();
    formData.append('payment_method', paymentMethod);
    if (isGcash) {
      formData.append('gcash_reference', gcashRef);
      if (gcashProofFile) formData.append('gcash_proof', gcashProofFile);
    }

    const btn = document.getElementById('payment-submit-btn');
    const originalLabel = btn ? btn.textContent : (isGcash ? 'SUBMIT PAYMENT' : 'PROCEED TO FRONT DESK');
    if (btn) { btn.disabled = true; btn.textContent = isGcash ? 'SUBMITTING...' : 'PROCESSING...'; }
    showLoadingOverlay(isGcash ? 'Please wait, payment is submitting...' : 'Please wait...');

    fetch('/member/submit-payment-method', { method: 'POST', body: formData })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        hideLoadingOverlay();
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
        if (!ok || !data.success) {
          showToast(data.error || 'Could not submit payment.', 'error');
          return;
        }
        const msgEl = document.getElementById('payment-submit-success-message');
        if (msgEl) {
          msgEl.textContent = isGcash
            ? "You have successfully submitted your payment. Please wait for admin's approval."
            : 'Please go to staff for your membership payment.';
        }
        openModal('payment-submit-success-modal');
      })
      .catch(() => {
        hideLoadingOverlay();
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  /** "OK" button on the payment success modal — reload so the dashboard
   *  reflects the newly-submitted payment status. */
  function closePaymentSubmitSuccessModal() {
    closeModal('payment-submit-success-modal');
    window.location.reload();
  }

  let _pendingSubmission = null;

  /** Validate the plan request, then ask for confirmation before actually
   *  sending it — submitting activates a real payment request that staff
   *  will act on, so we don't want an accidental click to fire it off. */
  function submitRenewalPayment() {
    const startEl        = document.getElementById('member-renew-start');
    const startDate      = startEl?.value || '';
    const studentEl      = document.getElementById('member-renew-student');
    const isStudent      = studentEl?.value === 'yes';
    const studentIdEl    = document.getElementById('member-student-id');
    const studentIdFile  = studentIdEl && studentIdEl.files && studentIdEl.files[0];
    const coachToggleEl  = document.getElementById('member-renew-coach-toggle');
    const wantsCoach     = coachToggleEl?.value === 'yes';
    const coachNameEl    = document.getElementById('member-renew-coach-name');
    const coachName      = coachNameEl?.value || '';
    // Fee is read off the selected <option>'s data-fee attribute (rendered
    // server-side from the Coach's editable fee) so the invoice always
    // matches what staff/admin configured — no separate lookup table to
    // keep in sync on the client.
    const coachFee       = wantsCoach && coachNameEl?.selectedOptions?.[0]
      ? parseFloat(coachNameEl.selectedOptions[0].dataset.fee || '0')
      : 0;

    if (!selectedPlan) { showToast('Please select a plan first', 'error'); return; }
    if (!startDate) { showToast('Please choose a start date', 'error'); return; }
    const todayStr = new Date().toISOString().slice(0, 10);
    if (startDate < todayStr) { showToast('Start date cannot be in the past', 'error'); return; }
    if (isStudent && !studentIdFile) {
      showToast('Please upload a photo of your school ID', 'error');
      return;
    }
    if (wantsCoach && !coachName) {
      showToast('Please choose a coach', 'error');
      return;
    }

    _pendingSubmission = {
      startEl, startDate, todayStr, studentEl, isStudent, studentIdEl, studentIdFile,
      coachToggleEl, wantsCoach, coachNameEl, coachName, coachFee,
    };
    _openConfirmPlanModal();
  }

  /** Add one calendar month, landing on the same day-of-month when possible
   *  and clamping to the last valid day when the target month is shorter
   *  (e.g. Jan 31 -> Feb 28/29, not Mar 3). Mirrors the backend's logic so
   *  the preview here always matches what actually gets scheduled. */
  function _addCalendarMonth(d) {
    const day = d.getDate();
    const result = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const lastDayOfTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(day, lastDayOfTargetMonth));
    return result;
  }

  /** Compute a plan's end date from its start date, given the plan key.
   *  "Monthly" is always a real calendar month (mirrors the backend's
   *  _plan_expiry special-case); every other plan uses its duration_days
   *  from PLAN_DATA (admin/staff editable), falling back to 30. */
  function _planEndDate(planKey, start) {
    if (planKey === 'monthly') return _addCalendarMonth(start);
    const durationDays = (PLAN_DATA[planKey] && PLAN_DATA[planKey].duration_days) || 30;
    const end = new Date(start);
    end.setDate(end.getDate() + durationDays);
    return end;
  }

  /** Fill in and open the "are you sure?" modal for the pending request —
   *  rendered as a small itemized invoice so the member sees exactly what
   *  they'll owe: plan price (with student discount applied) plus the
   *  selected coach's fee (set by staff/admin, ₱0 if none), before they
   *  submit the request. */
  function _openConfirmPlanModal() {
    const p = _pendingSubmission;
    if (!p) return;

    const info    = PLAN_DATA[selectedPlan];
    const regular = info ? info.price : 0;
    const hasStudentRate = p.isStudent && STUDENT_PRICES[selectedPlan] !== undefined;
    const planTotal = hasStudentRate ? STUDENT_PRICES[selectedPlan] : regular;
    const discount  = regular - planTotal;
    const coachFee  = p.wantsCoach ? (p.coachFee || 0) : 0;
    const total     = planTotal + coachFee;

    const nameEl         = document.getElementById('confirm-plan-name');
    const regularPriceEl = document.getElementById('confirm-plan-regular-price');
    const discountRowEl  = document.getElementById('confirm-plan-discount-row');
    const discountAmtEl  = document.getElementById('confirm-plan-discount-amount');
    const coachRowEl     = document.getElementById('confirm-plan-coach-row');
    const coachNameEl    = document.getElementById('confirm-plan-coach-name');
    const coachFeeRowEl  = document.getElementById('confirm-plan-coach-fee-row');
    const coachFeeEl     = document.getElementById('confirm-plan-coach-fee');
    const dateEl         = document.getElementById('confirm-plan-date');
    const endEl          = document.getElementById('confirm-plan-end-date');
    const totalEl        = document.getElementById('confirm-plan-total');

    if (nameEl) nameEl.textContent = info ? info.name.toUpperCase() : selectedPlan.toUpperCase();
    if (regularPriceEl) regularPriceEl.textContent = _formatPeso(regular);

    if (discountRowEl) discountRowEl.style.display = hasStudentRate ? 'flex' : 'none';
    if (discountAmtEl) discountAmtEl.textContent = '\u2212' + _formatPeso(discount);

    if (coachRowEl) coachRowEl.style.display = p.wantsCoach ? 'flex' : 'none';
    if (coachNameEl) coachNameEl.textContent = p.wantsCoach ? p.coachName : '\u2014';
    if (coachFeeRowEl) coachFeeRowEl.style.display = p.wantsCoach ? 'flex' : 'none';
    if (coachFeeEl) coachFeeEl.textContent = coachFee > 0 ? ('+' + _formatPeso(coachFee)) : 'Free';

    if (totalEl) totalEl.textContent = _formatPeso(total);

    const start = new Date(p.startDate + 'T00:00:00');
    if (dateEl) {
      dateEl.textContent = start.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }
    if (endEl) {
      const end = _planEndDate(selectedPlan, start);
      endEl.textContent = end.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }

    openModal('confirm-plan-modal');
  }

  /** "Yes, request this plan" button inside the confirmation modal. */
  function confirmPlanRequest() {
    closeModal('confirm-plan-modal');
    if (!_pendingSubmission) return;
    _doSubmitRenewalPayment(_pendingSubmission);
    _pendingSubmission = null;
  }

  /** "Cancel" button inside the confirmation modal — just discards it. */
  function cancelPlanRequest() {
    closeModal('confirm-plan-modal');
    _pendingSubmission = null;
  }

  /** Actually send the plan request to the backend. No payment details are
   *  collected here — staff/admin confirm payment separately before
   *  approving. */
  function _doSubmitRenewalPayment(p) {
    const {
      startEl, startDate, todayStr, studentEl, isStudent, studentIdEl, studentIdFile,
      coachToggleEl, wantsCoach, coachNameEl, coachName,
    } = p;

    const formData = new FormData();
    formData.append('plan',        selectedPlan);
    formData.append('start_date',  startDate);
    formData.append('is_student',  isStudent ? '1' : '0');
    if (isStudent && studentIdFile) formData.append('student_id', studentIdFile);
    formData.append('wants_coach', wantsCoach ? '1' : '0');
    if (wantsCoach) formData.append('coach_name', coachName);

    const btn = document.querySelector('#member-membership .btn-red');
    const originalLabel = btn ? btn.textContent : 'REQUEST THIS PLAN';
    if (btn) { btn.disabled = true; btn.textContent = 'SUBMITTING...'; }
    showLoadingOverlay('Please wait, membership plan is submitting...');

    fetch('/member/submit-payment', { method: 'POST', body: formData })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        hideLoadingOverlay();
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
        if (!ok || !data.success) {
          showToast(data.error || 'Could not submit request.', 'error');
          return;
        }

        if (studentEl) studentEl.value = 'no';
        if (startEl) startEl.value = todayStr;
        if (studentIdEl) studentIdEl.value = '';
        const studentGroup = document.getElementById('member-student-id-group');
        if (studentGroup) studentGroup.style.display = 'none';
        const studentPreview = document.getElementById('member-student-id-preview');
        if (studentPreview) { studentPreview.style.display = 'none'; studentPreview.removeAttribute('src'); }

        if (coachToggleEl) coachToggleEl.value = 'no';
        if (coachNameEl) coachNameEl.value = '';
        const coachGroup = document.getElementById('member-coach-name-group');
        if (coachGroup) coachGroup.style.display = 'none';

        _showPlanSuccessModal(data.message || 'Plan requested! Please wait for staff approval before proceeding to payment.');
      })
      .catch(() => {
        hideLoadingOverlay();
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  /** Show the "request successful" popup; reloads the page once it's dismissed. */
  function _showPlanSuccessModal(message) {
    const msgEl = document.getElementById('plan-success-message');
    if (msgEl) msgEl.textContent = message;
    openModal('plan-success-modal');
  }

  /** "OK" button (or ✕) on the success popup — closes it and refreshes the dashboard. */
  function closePlanSuccessModal() {
    closeModal('plan-success-modal');
    window.location.reload();
  }

  /* ── Withdraw a submitted plan request (Pending / Processing only) ── */
  let _pendingWithdrawId = null;

  /** Button on the "awaiting approval" banner — asks for confirmation
   *  before actually withdrawing the request. */
  function withdrawPlanRequest(paymentId) {
    _pendingWithdrawId = paymentId;
    openModal('withdraw-request-modal');
  }

  /** "No, keep it" — just discards, no changes made. */
  function cancelWithdrawRequest() {
    closeModal('withdraw-request-modal');
    _pendingWithdrawId = null;
  }

  /** "Yes, cancel it" — actually withdraws the request from the server. */
  function confirmWithdrawRequest() {
    closeModal('withdraw-request-modal');
    if (!_pendingWithdrawId) return;
    _pendingWithdrawId = null;

    const btn = document.querySelector('.withdraw-request-btn');
    const originalLabel = btn ? btn.textContent : 'CANCEL REQUEST';
    if (btn) { btn.disabled = true; btn.textContent = 'CANCELLING...'; }

    fetch('/member/cancel-plan-request', { method: 'POST' })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
          showToast(data.error || 'Could not cancel request.', 'error');
          return;
        }
        showToast(data.message || 'Plan request cancelled.', 'success');
        setTimeout(() => window.location.reload(), 700);
      })
      .catch(() => {
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  /** Expose plan selection for the renewal grid */
  function selectRenewalPlan(card, plan) {
    selectedPlan = plan;
    document.querySelectorAll('#member-membership .plan-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    const label = PLAN_DATA[plan] ? PLAN_DATA[plan].name : (plan.charAt(0).toUpperCase() + plan.slice(1));
    showToast('Plan selected: ' + label, 'success');
    openPlanModal(plan);
  }

  // ── Membership plans: "what's included" modal ──
  // Sourced from PLAN_DATA (built from #member-plans-data), which mirrors
  // whatever admin/staff have set for each plan's description and
  // inclusions under Settings → Manage Content.
  let planModalKey = null;

  function openPlanModal(key) {
    const info = PLAN_DATA[key];
    if (!info) return;
    planModalKey = key;

    const title    = document.getElementById('plan-modal-title');
    const price    = document.getElementById('plan-modal-price');
    const subtitle = document.getElementById('plan-modal-subtitle');
    const list     = document.getElementById('plan-modal-list');

    if (title)    title.textContent = info.name.toUpperCase();
    if (price)    price.textContent = _planPriceText(key, _isStudentSelected());
    if (subtitle) subtitle.textContent = info.description || '';
    if (list)     list.innerHTML = (info.inclusions || []).map(i => `<li>${_escapeHtml(i)}</li>`).join('');

    openModal('plan-modal');
  }

  /** "SELECT THIS PLAN" button inside the inclusions modal */
  function selectPlanFromModal() {
    if (!planModalKey) return;
    const card = document.querySelector(`#member-membership .plan-card[onclick*="'${planModalKey}'"]`);
    selectedPlan = planModalKey;
    document.querySelectorAll('#member-membership .plan-card').forEach(c => c.classList.remove('selected'));
    if (card) card.classList.add('selected');
    const label = PLAN_DATA[planModalKey] ? PLAN_DATA[planModalKey].name : (planModalKey.charAt(0).toUpperCase() + planModalKey.slice(1));
    showToast('Plan selected: ' + label, 'success');
    closeModal('plan-modal');
  }

  // ── Services tab: "what's included" modal ──
  // Sourced from SERVICE_DATA (built from #member-services-data), which
  // mirrors whatever admin/staff have set under Settings → Manage Content.
  // The eye icon on each service card opens this same modal; it now also
  // lists the equipment/machines admin/staff linked to that service (via
  // the "Equipment / Machines used for this service" checklist on the
  // content form), so members know what to use before they show up.
  function openServiceModal(id) {
    const info = SERVICE_DATA[id];
    if (!info) return;

    const icon      = document.getElementById('service-modal-icon');
    const title     = document.getElementById('service-modal-title');
    const subtitle  = document.getElementById('service-modal-subtitle');
    const listTitle = document.getElementById('service-modal-list-title');
    const list      = document.getElementById('service-modal-list');
    const equipment = info.equipment || [];

    if (icon)     icon.textContent = info.icon || '🛎️';
    if (title)    title.textContent = info.name.toUpperCase();
    if (subtitle) subtitle.textContent = info.description || '';

    if (equipment.length) {
      if (listTitle) { listTitle.textContent = 'Equipment used for this service'; listTitle.style.display = ''; }
      if (list)       list.innerHTML = equipment.map(e => `<li>${e.icon || '🏋️'} ${_escapeHtml(e.name)}</li>`).join('');
    } else {
      if (list)      list.innerHTML = '';
      if (listTitle) listTitle.style.display = 'none';
    }

    openModal('service-modal');
  }

  return {
    init, tab, submitRenewalPayment, confirmPlanRequest, cancelPlanRequest,
    closePlanSuccessModal, closePlanApprovedModal, goToPaymentFromApproval,
    closePaymentApprovedModal, closePlanDeclinedModal,
    selectRenewalPlan, openServiceModal,
    toggleStudentIdField, previewStudentId, toggleCoachField,
    togglePaymentProofField, previewGcashProof, submitPaymentMethod,
    confirmSubmitPayment, cancelSubmitPayment, closePaymentSubmitSuccessModal,
    openPlanModal, selectPlanFromModal, changeAttendanceMonth,
    withdrawPlanRequest, confirmWithdrawRequest, cancelWithdrawRequest,
    submitFitnessStep1, selectFitnessGoal, submitFitnessStep2,
    fitnessWizardBack, fitnessWizardEditGoal, retryFitnessCalculation, switchFitnessPlanTab, switchWorkoutDay,
    openExerciseInstructionsModal
  };
})();


/* ════════════════════════════════════════════════
   INIT — DOMContentLoaded Bootstrap
════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('member-dashboard-root')) return;

  MemberModule.init();

  window.memberTab            = (tab, el) => MemberModule.tab(tab, el);
  window.openServiceModal     = MemberModule.openServiceModal;
  window.submitRenewalPayment = MemberModule.submitRenewalPayment;
  window.confirmPlanRequest   = MemberModule.confirmPlanRequest;
  window.cancelPlanRequest    = MemberModule.cancelPlanRequest;
  window.closePlanSuccessModal = MemberModule.closePlanSuccessModal;
  window.closePlanApprovedModal = MemberModule.closePlanApprovedModal;
  window.closePaymentApprovedModal = MemberModule.closePaymentApprovedModal;
  window.closePlanDeclinedModal = MemberModule.closePlanDeclinedModal;
  window.goToPaymentFromApproval = MemberModule.goToPaymentFromApproval;
  window.selectPlan           = MemberModule.selectRenewalPlan;
  window.toggleStudentIdField = MemberModule.toggleStudentIdField;
  window.previewStudentId     = MemberModule.previewStudentId;
  window.toggleCoachField     = MemberModule.toggleCoachField;
  window.togglePaymentProofField = MemberModule.togglePaymentProofField;
  window.previewGcashProof       = MemberModule.previewGcashProof;
  window.submitPaymentMethod     = MemberModule.submitPaymentMethod;
  window.confirmSubmitPayment    = MemberModule.confirmSubmitPayment;
  window.cancelSubmitPayment     = MemberModule.cancelSubmitPayment;
  window.closePaymentSubmitSuccessModal = MemberModule.closePaymentSubmitSuccessModal;
  window.withdrawPlanRequest     = MemberModule.withdrawPlanRequest;
  window.confirmWithdrawRequest  = MemberModule.confirmWithdrawRequest;
  window.cancelWithdrawRequest   = MemberModule.cancelWithdrawRequest;
  window.openPlanModal        = MemberModule.openPlanModal;
  window.selectPlanFromModal  = MemberModule.selectPlanFromModal;
  window.changeAttendanceMonth = MemberModule.changeAttendanceMonth;
  window.submitFitnessStep1   = MemberModule.submitFitnessStep1;
  window.selectFitnessGoal    = MemberModule.selectFitnessGoal;
  window.submitFitnessStep2   = MemberModule.submitFitnessStep2;
  window.fitnessWizardBack    = MemberModule.fitnessWizardBack;
  window.fitnessWizardEditGoal = MemberModule.fitnessWizardEditGoal;
  window.retryFitnessCalculation = MemberModule.retryFitnessCalculation;
  window.switchFitnessPlanTab = MemberModule.switchFitnessPlanTab;
  window.switchWorkoutDay = MemberModule.switchWorkoutDay;
  window.openExerciseInstructionsModal = MemberModule.openExerciseInstructionsModal;
});