/* ═══════════════════════════════════════════════════════════════
   POWER GYM — Admin Dashboard
   tr-admin.js  |  Runs on admin-dashboard.html only

   Requires tr-common.js to be loaded first (Session, Navigation,
   showToast, buildAttGrid, closeModal, _injectSidebarUser,
   _bindModalBackdrops, _val).
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ════════════════════════════════════════════════
   ADMIN MODULE
   Handles all admin dashboard functionality.
════════════════════════════════════════════════ */
const AdminModule = (() => {

  let memberIdCounter = 1005;
  let currentReportType = null;
  let currentReportPayload = null;

  /** Read the attendance_calendar JSON embedded in admin-dashboard.html */
  function _parseAdminDashboardData() {
    const el = document.getElementById('admin-dashboard-data');
    if (!el) return {};
    try {
      return JSON.parse(el.textContent || el.innerText || '{}');
    } catch (e) {
      return {};
    }
  }

  /** Initialize admin dashboard */
  function init() {
    const session = Session.guardDashboard();
    if (!session) return;

    // Inject user info into sidebar
    _injectSidebarUser(session);

    // Apply role-specific CSS class for sidebar tinting
    document.body.classList.add('role-admin');

    // Build attendance grids from real gym-wide data
    const calendarData = _parseAdminDashboardData();
    buildAttGrid('att-grid-admin', calendarData.present_days || [], calendarData.days_in_month || 30,
      calendarData.today_day || null, calendarData.no_plan_days || [], calendarData.year, calendarData.month);
    buildAttGrid('att-grid-admin-full', calendarData.present_days || [], calendarData.days_in_month || 30,
      calendarData.today_day || null, calendarData.no_plan_days || [], calendarData.year, calendarData.month);

    // Modal close on backdrop click
    _bindModalBackdrops();

    // Show overview tab by default
    Navigation.activateTab('admin', 'overview', document.getElementById('nav-admin-overview'));
  }

  /** Switch admin sub-panel */
  function tab(tabName, navEl) {
    Navigation.activateTab('admin', tabName, navEl);
    if (tabName === 'settings') ContentManager.ensureLoaded();
  }

  /** Add a new member row from modal form */
  function addMember() {
    const firstName = _val('add-member-fname');
    const middleInitial = _val('add-member-mi');
    const lastName  = _val('add-member-lname');
    const extensionName = _val('add-member-ext');
    const email     = _val('add-member-email');
    const phone     = _val('add-member-phone');
    const planText  = document.getElementById('add-member-plan')?.value || 'Monthly';
    const planName  = planText.split('—')[0].trim();

    if (!firstName || !lastName || !email) {
      showToast('Please fill first name, last name, and email', 'error');
      return;
    }
    if (!/^09\d{9}$/.test(phone)) {
      showToast('Phone number must start with 09 and be exactly 11 digits.', 'error');
      return;
    }

    const addBtn = document.querySelector('#add-member-modal .btn-red');
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'ADDING...'; }

    fetch('/admin/add-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        first_name:     firstName,
        middle_initial: middleInitial,
        last_name:      lastName,
        extension_name: extensionName,
        email:          email,
        phone:          phone,
        plan:           planName
      })
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'ADD MEMBER'; }
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to add member.', 'error');
          return;
        }

        const m = data.member;
        const tbody = document.querySelector('#members-table tbody');
        if (tbody) {
          const row = document.createElement('tr');
          row.dataset.id            = m.id;
          row.dataset.plan          = m.plan;
          row.dataset.phone         = m.phone || '';
          row.dataset.expiryIso     = m.expiry_iso || '';
          row.dataset.firstName     = m.first_name || '';
          row.dataset.middleInitial = m.middle_initial || '';
          row.dataset.lastName      = m.last_name || '';
          row.dataset.extensionName = m.extension_name || '';
          row.innerHTML = `
            <td>#${m.id}</td>
            <td>${m.name}</td>
            <td>${m.email}</td>
            <td>${m.plan}</td>
            <td>${m.expiry}</td>
            <td><span class="badge badge-green">Active</span></td>
            <td>
              <button class="btn btn-sm btn-outline" onclick="openEditMemberModal(this)">Edit</button>
              <button class="btn btn-sm" style="background:rgba(230,30,37,0.1);color:var(--red);border:1px solid rgba(230,30,37,0.2);" onclick="deleteMemberRow(this)">Del</button>
            </td>`;
          tbody.prepend(row);
        }

        closeModal('add-member-modal');
        ['add-member-fname', 'add-member-mi', 'add-member-lname', 'add-member-ext', 'add-member-email', 'add-member-phone'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        const planEl = document.getElementById('add-member-plan');
        if (planEl) planEl.selectedIndex = 0;

        showToast(`Member added! Temporary password: ${m.temp_password}`, 'success');
      })
      .catch(() => {
        if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'ADD MEMBER'; }
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  let editingMemberId = null;

  /** Open the Edit Member modal, pre-filled from the row's data */
  function openEditMemberModal(btn) {
    const row = btn.closest('tr');
    if (!row) return;
    const cells = row.querySelectorAll('td');
    if (cells.length < 7) return;

    editingMemberId = row.dataset.id;
    document.getElementById('edit-member-fname').value  = row.dataset.firstName     || '';
    document.getElementById('edit-member-mi').value     = row.dataset.middleInitial || '';
    document.getElementById('edit-member-lname').value  = row.dataset.lastName      || '';
    document.getElementById('edit-member-ext').value    = row.dataset.extensionName || '';
    document.getElementById('edit-member-email').value  = cells[2].textContent.trim();
    document.getElementById('edit-member-phone').value  = row.dataset.phone || '';
    document.getElementById('edit-member-expiry').value = row.dataset.expiryIso || '';

    const planSelect = document.getElementById('edit-member-plan');
    if (planSelect) {
      [...planSelect.options].forEach(opt => {
        opt.selected = opt.value.split('—')[0].trim() === row.dataset.plan;
      });
    }

    openModal('edit-member-modal');
  }

  /** Save the Edit Member modal's fields to the server */
  function saveEditMember() {
    const firstName = _val('edit-member-fname');
    const middleInitial = _val('edit-member-mi');
    const lastName  = _val('edit-member-lname');
    const extensionName = _val('edit-member-ext');
    const email     = _val('edit-member-email');
    const phone     = _val('edit-member-phone');
    const planText  = document.getElementById('edit-member-plan')?.value || '';
    const planName  = planText.split('—')[0].trim();
    const expiry    = document.getElementById('edit-member-expiry')?.value || '';

    if (!firstName || !lastName || !email) {
      showToast('First name, last name, and email are required', 'error');
      return;
    }
    if (!/^09\d{9}$/.test(phone)) {
      showToast('Phone number must start with 09 and be exactly 11 digits.', 'error');
      return;
    }

    const saveBtn = document.querySelector('#edit-member-modal .btn-red');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'SAVING...'; }

    fetch(`/admin/edit-member/${editingMemberId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        first_name:     firstName,
        middle_initial: middleInitial,
        last_name:      lastName,
        extension_name: extensionName,
        email:          email,
        phone:          phone,
        plan:           planName,
        expiry:         expiry
      })
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'SAVE CHANGES'; }
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to update member.', 'error');
          return;
        }

        const row = document.querySelector(`#members-table tr[data-id="${editingMemberId}"]`);
        if (row) {
          const m = data.member;
          const cells = row.querySelectorAll('td');
          cells[1].textContent = m.name;
          cells[2].textContent = m.email;
          cells[3].textContent = m.plan_label || m.plan;
          cells[4].textContent = m.expiry;
          row.dataset.plan          = m.plan;
          row.dataset.expiryIso     = m.expiry_iso;
          row.dataset.phone         = m.phone || '';
          row.dataset.firstName     = m.first_name || '';
          row.dataset.middleInitial = m.middle_initial || '';
          row.dataset.lastName      = m.last_name || '';
          row.dataset.extensionName = m.extension_name || '';
        }

        closeModal('edit-member-modal');
        showToast('Member updated successfully', 'success');
      })
      .catch(() => {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'SAVE CHANGES'; }
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  /** Delete a member row from the server, then remove it from the table */
  function deleteMemberRow(btn) {
    const row  = btn.closest('tr');
    if (!row) return;
    const id   = row.dataset.id;
    const name = row.querySelectorAll('td')[1]?.textContent.trim() || 'this member';
    if (!confirm(`Delete ${name}? This cannot be undone.`)) return;

    fetch(`/admin/delete-member/${id}`, { method: 'POST' })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to delete member.', 'error');
          return;
        }
        row.remove();
        showToast('Member deleted', 'success');
      })
      .catch(() => showToast('Could not reach the server. Please try again.', 'error'));
  }

  /** Analytics report generator — pulls live data from the server. Every
   *  verified Cash/GCash payment is picked up automatically since the report
   *  reads straight from the Payment table; nothing needs to be entered here
   *  by hand. */
  function generateAnalyticsReport(type) {
    const panel = document.getElementById('report-output-panel');
    const title = document.getElementById('report-output-title');
    const body  = document.getElementById('report-output-body');
    if (!panel || !title || !body) return;

    currentReportType = type;

    // Highlight which report button is currently selected, so it's clear
    // at a glance which report is being shown below.
    document.querySelectorAll('#admin-analytics .report-btn').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById('report-btn-' + type);
    if (activeBtn) activeBtn.classList.add('active');

    const range    = document.getElementById('report-range')?.value || 'this_month';
    const fromDate = document.getElementById('report-from')?.value || '';
    const toDate   = document.getElementById('report-to')?.value   || '';

    if ((fromDate && !toDate) || (!fromDate && toDate)) {
      showToast('Please set both From and To dates, or clear them to use the preset range.', 'error');
      return;
    }

    panel.style.display = 'block';
    title.textContent = 'Loading…';
    body.innerHTML = '<div style="color:var(--muted);font-size:15px;padding:14px 0;">Generating report…</div>';

    const params = new URLSearchParams({ range });
    if (fromDate && toDate) { params.set('from', fromDate); params.set('to', toDate); }

    fetch(`/api/admin/reports/${type}?${params.toString()}`)
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast((data && data.error) || 'Could not generate report.', 'error');
          title.textContent = 'Report';
          body.innerHTML = '<div style="color:var(--muted);font-size:15px;padding:14px 0;">Could not load this report. Try Refresh.</div>';
          return;
        }

        const report = data.report;
        currentReportPayload = report;

        title.textContent = `${report.title} — ${report.range_label} — Generated ${new Date().toLocaleString()}`;
        body.innerHTML = `
          <div class="stats-grid" style="grid-template-columns:repeat(${report.stats.length},1fr);margin-bottom:14px;">
            ${report.stats.map(s => `<div class="stat-card"><div class="stat-value" style="font-size:27px;">${s.value}</div><div class="stat-label">${s.label}</div></div>`).join('')}
          </div>
          ${report.chart_series && report.chart_series.length ? `
          <div style="margin-bottom:16px;">
            <div style="font-size:13px;color:var(--muted);margin-bottom:8px;">${report.chart_label}</div>
            ${_renderReportChartCanvas(type, report.chart_series)}
          </div>` : ''}
          ${_renderRevenueBreakdowns(type, report)}
          ${report.rows.length ? `
          <table class="data-table">
            <thead><tr>${report.headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>${report.rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>` : '<div style="color:var(--muted);font-size:15px;padding:14px 0;">No records found for this range.</div>'}`;

        if (report.chart_series && report.chart_series.length) _mountReportChart(type, report.chart_series);

        showToast(report.title + ' generated successfully', 'success');
      })
      .catch(() => {
        showToast('Could not reach the server. Please try again.', 'error');
        title.textContent = 'Report';
        body.innerHTML = '<div style="color:var(--muted);font-size:15px;padding:14px 0;">Could not load this report. Try Refresh.</div>';
      });
  }

  /** Revenue Report has two extra breakdowns the server already computes
   *  (by plan, and Cash collected per staff member) but that were never
   *  being shown — surface them as two side-by-side mini tables above the
   *  full transaction list. No-op for other report types or empty data. */
  function _renderRevenueBreakdowns(type, report) {
    if (type !== 'revenue') return '';
    const hasByPlan = report.by_plan && report.by_plan.length;
    const hasByStaff = report.cash_by_staff && report.cash_by_staff.length;
    if (!hasByPlan && !hasByStaff) return '';

    const byPlanTable = hasByPlan ? `
      <div style="flex:1;min-width:220px;">
        <div style="font-size:13px;color:var(--muted);margin-bottom:8px;">Revenue by Plan</div>
        <table class="data-table">
          <thead><tr><th>Plan</th><th>Total</th></tr></thead>
          <tbody>${report.by_plan.map(r => `<tr><td>${r.plan}</td><td>\u20b1${r.total}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : '';

    const byStaffTable = hasByStaff ? `
      <div style="flex:1;min-width:220px;">
        <div style="font-size:13px;color:var(--muted);margin-bottom:8px;">Cash Collected by Staff</div>
        <table class="data-table">
          <thead><tr><th>Staff</th><th>Total</th><th>Txns</th></tr></thead>
          <tbody>${report.cash_by_staff.map(r => `<tr><td>${r.staff}</td><td>\u20b1${r.total}</td><td>${r.count}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : '';

    return `<div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:20px;">${byPlanTable}${byStaffTable}</div>`;
  }

  function clearReportDateRange() {
    const fromEl = document.getElementById('report-from');
    const toEl   = document.getElementById('report-to');
    if (fromEl) fromEl.value = '';
    if (toEl)   toEl.value   = '';
    if (currentReportType) generateAnalyticsReport(currentReportType);
  }

  function refreshCurrentReport() {
    if (currentReportType) generateAnalyticsReport(currentReportType);
    else showToast('Generate a report first', 'error');
  }

  function exportReportPDF() {
    if (!currentReportPayload) { showToast('Generate a report first', 'error'); return; }
    window.print();
    showToast('Use Print dialog to save as PDF', 'success');
  }

  // ── Private helpers ──────────────────────────

  /** Meaningful, consistent bar colors per report type/label (not a rainbow
   *  cycle) — mirrors the palette used in the "neat" reference chart. */
  const _MEMBERSHIP_BAR_COLORS = { Active: '#1baf7a', Pending: '#eda100', Expired: '#e34948', Declined: '#898781', 'No Plan': '#898781' };
  const _METHOD_BAR_COLORS     = { Cash: '#2a78d6', GCash: '#4a3aa7' };
  // Attendance bars are per-day/month, not a fixed set of named categories,
  // so there's no single "correct" color per label — cycle through a
  // palette instead to give each bar its own color, like the sample chart.
  const _ATTENDANCE_PALETTE    = ['#3d7dd4', '#1baf7a', '#eda100', '#e34948', '#4a3aa7', '#2fb5c9', '#d6689a', '#8c8c1a'];

  function _colorForBar(type, label, index) {
    if (type === 'membership') return _MEMBERSHIP_BAR_COLORS[label] || '#2a78d6';
    if (type === 'revenue')    return _METHOD_BAR_COLORS[label] || '#2a78d6';
    if (type === 'attendance') return _ATTENDANCE_PALETTE[index % _ATTENDANCE_PALETTE.length];
    return '#2a78d6';
  }

  let _reportChartInstance = null;

  function _renderReportChartCanvas(type, series) {
    const label = series.map(s => `${s.label}: ${s.value}`).join(', ');

    // Membership report: pie chart with the legend stacked to the right,
    // matching the reference "Causes of Land Degradation" pie layout.
    if (type === 'membership') {
      const legend = series.map(s => `
        <span style="display:flex;align-items:center;gap:6px;">
          <span style="width:10px;height:10px;border-radius:2px;background:${_colorForBar(type, s.label)};"></span>${s.label}
        </span>`).join('');
      return `
        <div style="display:flex;align-items:center;gap:18px;">
          <div style="position:relative;flex:0 0 auto;width:220px;height:220px;">
            <canvas id="report-chart-canvas" role="img" aria-label="Pie chart — ${label}"></canvas>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--muted);white-space:nowrap;">${legend}</div>
        </div>`;
    }

    // Revenue report: horizontal bars with the legend stacked to the right,
    // matching the reference "Chart A" layout (bars left, swatches right).
    if (type === 'revenue') {
      const heightPx = Math.max(120, series.length * 50);
      const legend = series.map(s => `
        <span style="display:flex;align-items:center;gap:6px;">
          <span style="width:10px;height:10px;border-radius:2px;background:${_colorForBar(type, s.label)};"></span>${s.label}
        </span>`).join('');
      return `
        <div style="display:flex;align-items:center;gap:18px;">
          <div style="position:relative;flex:1;min-width:0;height:${heightPx}px;">
            <canvas id="report-chart-canvas" role="img" aria-label="Horizontal bar chart — ${label}"></canvas>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--muted);white-space:nowrap;">${legend}</div>
        </div>`;
    }

    const heightPx = series.length > 10 ? 320 : 260;
    return `
      <div style="position:relative;width:100%;height:${heightPx}px;">
        <canvas id="report-chart-canvas" role="img" aria-label="Bar chart — ${label}"></canvas>
      </div>`;
  }

  /** Draw the actual Chart.js bar chart once the canvas above is in the DOM.
   *  Destroys any previous instance first — Chart.js throws if you reuse a
   *  canvas id without cleaning up the old chart bound to it. */
  function _mountReportChart(type, series) {
    if (_reportChartInstance) { _reportChartInstance.destroy(); _reportChartInstance = null; }
    const canvas = document.getElementById('report-chart-canvas');
    if (!canvas || typeof Chart === 'undefined') return;

    // This dashboard is always dark-themed (see tr-styles.css) — it doesn't
    // follow the OS light/dark preference, so the chart shouldn't either.
    // Colors below match the dashboard's own --white/--muted/--border tokens.
    const muted  = '#8b92a8';
    const grid   = '#2e3545';
    const ink    = '#f5f5f7';
    const rotate = series.length > 8;
    const horizontal = type === 'revenue';

    if (type === 'membership') {
      const total = series.reduce((sum, s) => sum + s.value, 0) || 1;
      _reportChartInstance = new Chart(canvas, {
        type: 'pie',
        data: {
          labels: series.map(s => s.label),
          datasets: [{
            data: series.map(s => s.value),
            backgroundColor: series.map(s => _colorForBar(type, s.label)),
            borderColor: '#141820',
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            datalabels: typeof ChartDataLabels === 'undefined' ? undefined : {
              color: '#0b0b0b', font: { size: 11, weight: 600 },
              formatter: v => `${Math.round((v / total) * 100)}%`
            }
          }
        },
        plugins: typeof ChartDataLabels === 'undefined' ? [] : [ChartDataLabels]
      });
      return;
    }

    _reportChartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: series.map(s => s.label),
        datasets: [{
          data: series.map(s => s.value),
          backgroundColor: series.map((s, i) => _colorForBar(type, s.label, i)),
        }]
      },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: horizontal ? { right: 20 } : { top: 20 } },
        plugins: {
          legend: { display: false },
          datalabels: typeof ChartDataLabels === 'undefined' ? undefined : {
            anchor: 'end', align: horizontal ? 'end' : 'top', color: ink, font: { size: 11, weight: 500 },
            formatter: v => v.toLocaleString()
          }
        },
        scales: horizontal ? {
          // Value axis runs along the bottom (like Chart A's 0%–90% scale);
          // category axis (bar labels themselves) is hidden since the
          // color-coded legend to the right of the canvas identifies them.
          x: {
            beginAtZero: true,
            grid: { color: grid },
            ticks: { color: muted, font: { size: 12 } }
          },
          y: {
            grid: { display: false },
            ticks: { display: false }
          }
        } : {
          x: {
            grid: { display: false },
            ticks: { color: muted, font: { size: 12 }, autoSkip: false, maxRotation: rotate ? 45 : 0 }
          },
          y: { beginAtZero: true, grid: { color: grid }, ticks: { color: muted, font: { size: 11 } } }
        }
      },
      plugins: typeof ChartDataLabels === 'undefined' ? [] : [ChartDataLabels]
    });
  }

  function _calculateExpiry(planName) {
    const today  = new Date();
    const plan   = planName.toLowerCase();
    if (plan === 'yearly') {
      const expiry = new Date(today);
      expiry.setDate(expiry.getDate() + 365);
      return expiry;
    }
    if (plan === 'half month') {
      const expiry = new Date(today);
      expiry.setDate(expiry.getDate() + 14);
      return expiry;
    }
    if (plan === 'daily') {
      const expiry = new Date(today);
      expiry.setDate(expiry.getDate() + 1);
      return expiry;
    }
    // Monthly: add one real calendar month (28-31 days), not a flat 30.
    const day = today.getDate();
    const expiry = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const lastDayOfTargetMonth = new Date(expiry.getFullYear(), expiry.getMonth() + 1, 0).getDate();
    expiry.setDate(Math.min(day, lastDayOfTargetMonth));
    return expiry;
  }

  /** Show the uploaded payment proof (image or PDF) in a modal before approving/rejecting.
   *  `title` lets callers relabel the modal — e.g. "School ID Proof" vs the
   *  default "Payment Proof" — so the two don't look identical when opened. */
  /** Opens the payment-proof modal with the receipt image (or a PDF link
   *  for non-image proofs) and, when an `html` string is supplied (payment
   *  verification calls it with the same member/plan/method/reference/
   *  amount + member-reported markup shown on the verification card), an
   *  info panel below the image showing that same structured breakdown —
   *  so the admin can compare the screenshot against the submitted
   *  details, mismatch warning included, without leaving the modal.
   *  Other callers (profile picture, school ID) simply omit `html` and
   *  get the old image-only view. The caller is responsible for building
   *  trusted markup (it's rendered server-side from template data, not
   *  raw user input), so it's inserted as-is rather than escaped. */
  function viewPaymentProof(url, title, html) {
    _showProofModal([url], title, html);
  }

  /** Show every screenshot a member uploaded for one payment (GCash proofs
   *  can be up to 3) side by side in a single modal, with the same
   *  member-reported details panel underneath — one button instead of
   *  "View Proof 1 / 2 / 3". Empty slots are simply skipped. */
  function viewPaymentProofs(url1, url2, url3, title, html) {
    const urls   = [url1, url2, url3].filter(u => u && String(u).trim());
    const labels = urls.length > 1 ? urls.map((_, i) => `Screenshot ${i + 1}`) : [];
    _showProofModal(urls, title, html, labels);
  }

  /** Show a student's ID front and back together, side by side, in the same
   *  proof modal — so the admin can compare both sides at once instead of
   *  opening two separate popups. Falls back gracefully if only one side
   *  is available. */
  function viewStudentIdProof(frontUrl, backUrl, title) {
    const urls   = [];
    const labels = [];
    if (frontUrl) { urls.push(frontUrl); labels.push('Front'); }
    if (backUrl)  { urls.push(backUrl);  labels.push('Back');  }
    _showProofModal(urls, title || 'School ID Proof', '', urls.length > 1 ? labels : []);
  }

  /** Shared renderer behind every view-proof entry point. Renders one tile
   *  per uploaded file into the modal (so a GCash payment with 2-3
   *  screenshots shows them all at once, captioned and side by side),
   *  widens the modal to fit, routes PDF uploads to an OPEN PDF link, and
   *  shows the optional member-reported details panel underneath. Each
   *  image is clickable to open the full-size file in a new tab. */
  function _showProofModal(urls, title, html, labels) {
    const wrap     = document.getElementById('proof-modal-img-wrap');
    const pdfNote  = document.getElementById('proof-modal-pdf-note');
    const pdfLink  = document.getElementById('proof-modal-pdf-link');
    const titleEl  = document.getElementById('proof-modal-title');
    const details  = document.getElementById('proof-modal-details');
    const modalBox = document.getElementById('view-proof-modal-box');
    if (!wrap) return;

    const isPdf  = (u) => /\.pdf($|\?)/i.test(u);
    const all    = (urls || []).filter(u => u && String(u).trim());
    const images = all.filter(u => !isPdf(u));
    const pdfs   = all.filter(isPdf);
    const caps   = labels || [];

    if (titleEl) titleEl.textContent = (title || 'Payment Proof').toUpperCase();

    // Rebuild the image area from scratch each time, so nothing is left
    // over from the previously opened proof.
    wrap.innerHTML = '';
    images.forEach((url, i) => {
      const tile = document.createElement('div');
      tile.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';

      const img = document.createElement('img');
      img.src = url;
      img.alt = caps[i] || 'Payment proof';
      img.title = 'Click to open the full-size file';
      img.style.cssText = images.length > 1
        ? 'width:100%;max-width:300px;max-height:55vh;object-fit:contain;border-radius:6px;border:1px solid var(--border);cursor:zoom-in;'
        : 'max-width:100%;max-height:60vh;border-radius:6px;border:1px solid var(--border);cursor:zoom-in;';
      img.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
      tile.appendChild(img);

      if (caps[i]) {
        const cap = document.createElement('div');
        cap.textContent = caps[i];
        cap.style.cssText = 'font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);';
        tile.appendChild(cap);
      }

      wrap.appendChild(tile);
    });

    if (pdfNote && pdfLink) {
      if (pdfs.length) { pdfLink.href = pdfs[0]; pdfNote.style.display = 'block'; }
      else             { pdfNote.style.display = 'none'; }
    }

    if (modalBox) {
      modalBox.style.maxWidth = images.length >= 3 ? '980px'
                              : images.length === 2 ? '760px'
                              : '520px';
    }

    if (details) {
      if (html && html.trim()) {
        details.innerHTML = html;
        details.style.display = 'block';
      } else {
        details.innerHTML = '';
        details.style.display = 'none';
      }
    }

    openModal('view-proof-modal');
  }

  // ── Member Management: status pill + search filtering ──
  // (same behavior/markup pattern as Staff → View Members)
  let adminMembersStatusFilter = 'all';

  /** Called when a status pill (All / Active / Pending / Expired / No Plan) is clicked */
  function filterMembersByStatus(status, pillEl) {
    adminMembersStatusFilter = status;
    document.querySelectorAll('#admin-members .status-pill').forEach(p => p.classList.remove('active'));
    if (pillEl) pillEl.classList.add('active');
    _applyAdminMembersFilter();
  }

  /** Jump from an Overview stat card ("Total Members" / "Active Members")
   *  straight to Member Management, pre-filtered to the given status and
   *  with any leftover search text cleared, so the count on the card and
   *  the rows shown actually match. */
  function goToAdminMembers(status) {
    tab('members', null);
    const searchEl = document.getElementById('admin-members-search');
    if (searchEl) searchEl.value = '';
    filterMembersByStatus(status, document.getElementById('admin-members-filter-' + status));
  }

  /** Jump from the "Monthly Revenue" Overview stat card straight to the
   *  Payments tab, scrolled down to Payment History. */
  function goToAdminRevenue() {
    tab('payments', null);
    const panel = document.getElementById('admin-payment-history-panel');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Called as the admin types in the Member Management search box */
  function filterMembersTable() {
    _applyAdminMembersFilter();
  }

  function _applyAdminMembersFilter() {
    const searchEl = document.getElementById('admin-members-search');
    const search   = (searchEl?.value || '').trim().toLowerCase();
    const rows     = document.querySelectorAll('#members-table tbody tr[data-status]');
    let visibleCount = 0;

    rows.forEach(row => {
      const statusMatch = adminMembersStatusFilter === 'all' || row.dataset.status === adminMembersStatusFilter;
      const nameMatch    = !search || (row.dataset.name || '').includes(search);
      const show = statusMatch && nameMatch;
      row.style.display = show ? '' : 'none';
      if (show) visibleCount++;
    });

    const emptyState = document.getElementById('admin-members-empty-state');
    if (emptyState) emptyState.style.display = (rows.length && visibleCount === 0) ? 'block' : 'none';
  }

  /** Show/hide the ID column in Member Management — same behavior as
   *  Staff → View Members' HIDE ID toggle. */
  function toggleMemberIdColumn() {
    const table = document.getElementById('members-table');
    const btn   = document.getElementById('toggle-admin-id-btn');
    if (!table || !btn) return;
    const cells = table.querySelectorAll('.col-member-id');
    const isHidden = btn.dataset.hidden === 'true';
    cells.forEach(cell => { cell.style.display = isHidden ? '' : 'none'; });
    btn.dataset.hidden = isHidden ? 'false' : 'true';
    btn.textContent = isHidden ? '👁 HIDE ID' : '🙈 SHOW ID';
  }

  // ── Announcements ─────────────────────────────
  const TARGET_LABELS = { all: 'All Members', active: 'Active Members Only', expiring: 'Expiring This Month', staff: 'Staff Only' };

  function _escAnn(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function _announcementItemHtml(item) {
    return `<div class="announcement-item" data-ann-id="${item.id}" data-ann-target="${item.target}" style="padding:14px;background:rgba(230,30,37,0.06);border:1px solid rgba(230,30,37,0.2);border-radius:6px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div style="font-weight:600;margin-bottom:4px;" data-ann-title>${_escAnn(item.title)}</div>
        <span class="badge badge-green" data-ann-status-badge>Published</span>
      </div>
      <div style="font-size:15px;color:var(--muted);white-space:pre-wrap;" data-ann-body>${_escAnn(item.body)}</div>
      <div style="margin-top:8px;font-size:12px;color:var(--muted);">Posted by ${_escAnn(item.posted_by)} · <span data-ann-target-label>${TARGET_LABELS[item.target] || 'All Members'}</span> · ${_escAnn(item.created_at)}</div>
      <div style="margin-top:10px;display:flex;gap:8px;">
        <button class="btn btn-outline btn-sm" onclick="openEditAnnouncementModal(${item.id})">EDIT</button>
        <button class="btn btn-outline btn-sm" onclick="toggleAnnouncement(${item.id}, this)">UNPUBLISH</button>
        <button class="btn btn-outline btn-sm" style="color:var(--red);border-color:rgba(230,30,37,0.4);" onclick="deleteAnnouncement(${item.id}, this)">DELETE</button>
      </div>
    </div>`;
  }

  function publishAnnouncement() {
    const title = _val('ann-title');
    const body  = _val('ann-message');

    if (!title || !body) { showToast('Please fill in both the title and message.', 'error'); return; }

    openModal('confirm-publish-announcement-modal');
  }

  function confirmPublishAnnouncement() {
    const title  = _val('ann-title');
    const body   = _val('ann-message');
    const target = document.getElementById('ann-target')?.value || 'all';

    if (!title || !body) {
      closeModal('confirm-publish-announcement-modal');
      showToast('Please fill in both the title and message.', 'error');
      return;
    }

    const modalBtn = document.getElementById('confirm-publish-announcement-btn');
    if (modalBtn) { modalBtn.disabled = true; modalBtn.textContent = 'PUBLISHING...'; }

    const formData = new FormData();
    formData.append('title', title);
    formData.append('body', body);
    formData.append('target', target);

    fetch('/api/announcements/save', { method: 'POST', body: formData })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast(data.error || 'Could not publish announcement.', 'error');
          return;
        }
        const list = document.getElementById('admin-announcements-list');
        const empty = document.getElementById('admin-announcements-empty');
        if (empty) empty.remove();
        if (list) list.insertAdjacentHTML('afterbegin', _announcementItemHtml(data.item));

        document.getElementById('ann-title').value = '';
        document.getElementById('ann-message').value = '';
        document.getElementById('ann-target').value = 'all';
        closeModal('confirm-publish-announcement-modal');
        showToast('Announcement published!', 'success');
      })
      .catch(() => showToast('Could not reach the server. Please try again.', 'error'))
      .finally(() => {
        if (modalBtn) { modalBtn.disabled = false; modalBtn.textContent = 'YES'; }
      });
  }

  let _editAnnId = null;

  function openEditAnnouncementModal(id) {
    const itemEl = document.querySelector(`.announcement-item[data-ann-id="${id}"]`);
    if (!itemEl) { showToast('Could not find that announcement.', 'error'); return; }

    _editAnnId = id;

    const titleEl  = itemEl.querySelector('[data-ann-title]');
    const bodyEl   = itemEl.querySelector('[data-ann-body]');
    const target   = itemEl.dataset.annTarget || 'all';

    document.getElementById('edit-ann-title').value   = titleEl ? titleEl.textContent.trim() : '';
    document.getElementById('edit-ann-message').value = bodyEl  ? bodyEl.textContent.trim()  : '';
    document.getElementById('edit-ann-target').value  = target;

    openModal('edit-announcement-modal');
  }

  function saveEditAnnouncement() {
    if (!_editAnnId) return;

    const title  = _val('edit-ann-title');
    const body   = _val('edit-ann-message');
    const target = document.getElementById('edit-ann-target')?.value || 'all';

    if (!title || !body) { showToast('Please fill in both the title and message.', 'error'); return; }

    const saveBtn = document.getElementById('edit-ann-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'SAVING...'; }

    const formData = new FormData();
    formData.append('title', title);
    formData.append('body', body);
    formData.append('target', target);

    fetch(`/api/announcements/${_editAnnId}/edit`, { method: 'POST', body: formData })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast((data && data.error) || 'Could not update announcement.', 'error');
          return;
        }
        const itemEl = document.querySelector(`.announcement-item[data-ann-id="${_editAnnId}"]`);
        if (itemEl) {
          itemEl.dataset.annTarget = data.item.target;
          const titleEl  = itemEl.querySelector('[data-ann-title]');
          const bodyEl   = itemEl.querySelector('[data-ann-body]');
          const targetEl = itemEl.querySelector('[data-ann-target-label]');
          if (titleEl)  titleEl.textContent  = data.item.title;
          if (bodyEl)   bodyEl.textContent   = data.item.body;
          if (targetEl) targetEl.textContent = TARGET_LABELS[data.item.target] || 'All Members';
        }
        closeModal('edit-announcement-modal');
        showToast('Announcement updated.', 'success');
      })
      .catch(() => showToast('Could not reach the server. Please try again.', 'error'))
      .finally(() => {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'SAVE CHANGES'; }
      });
  }

  function toggleAnnouncement(id, btnEl) {
    fetch(`/api/announcements/${id}/toggle`, { method: 'POST' })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast((data && data.error) || 'Could not update announcement.', 'error');
          return;
        }
        const item = document.querySelector(`.announcement-item[data-ann-id="${id}"]`);
        if (item) {
          const badge = item.querySelector('[data-ann-status-badge]');
          const isActive = data.item.is_active;
          item.style.opacity = isActive ? '1' : '0.55';
          if (badge) {
            badge.textContent = isActive ? 'Published' : 'Unpublished';
            badge.classList.toggle('badge-green', isActive);
            badge.classList.toggle('badge-muted', !isActive);
          }
          if (btnEl) btnEl.textContent = isActive ? 'UNPUBLISH' : 'REPUBLISH';
        }
        showToast(data.item.is_active ? 'Announcement republished.' : 'Announcement unpublished.', 'success');
      })
      .catch(() => showToast('Could not reach the server. Please try again.', 'error'));
  }

  function deleteAnnouncement(id, btnEl) {
    if (!confirm('Delete this announcement? This cannot be undone.')) return;

    fetch(`/api/announcements/${id}/delete`, { method: 'POST' })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast((data && data.error) || 'Could not delete announcement.', 'error');
          return;
        }
        const item = document.querySelector(`.announcement-item[data-ann-id="${id}"]`);
        if (item) item.remove();
        const list = document.getElementById('admin-announcements-list');
        if (list && !list.querySelector('.announcement-item')) {
          list.innerHTML = '<div id="admin-announcements-empty" style="color:var(--muted);font-size:15px;padding:14px 0;">No announcements yet. Compose one above to get started.</div>';
        }
        showToast('Announcement deleted.', 'success');
      })
      .catch(() => showToast('Could not reach the server. Please try again.', 'error'));
  }

  /* ── GCash accounts ────────────────────────────────────────────────
     The gym can have several GCash accounts saved at once; exactly one is
     marked default, and that's the only one members ever see. Every save /
     delete / switch returns the full account list from the server, which we
     re-render in place — no page reload, so the admin stays on Settings.
  ──────────────────────────────────────────────────────────────────── */

  let _gcashAccounts = [];       // last known list from the server
  let _gcashPendingDefaultId = null;
  let _gcashPendingDeleteId  = null;

  function _escGc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _gcashById(id) {
    return _gcashAccounts.find(a => String(a.id) === String(id)) || null;
  }

  /** Paint the saved-accounts list. Default account first, visually
   *  marked, and with its Delete button carrying a heavier warning since
   *  removing it changes what members see. */
  function renderGcashAccounts(accounts) {
    if (Array.isArray(accounts)) _gcashAccounts = accounts;

    const list  = document.getElementById('gcash-accounts-list');
    const empty = document.getElementById('gcash-accounts-empty');
    const addBtn = document.getElementById('gcash-add-btn');
    if (!list) return;

    if (addBtn) addBtn.disabled = _gcashAccounts.length >= 6;

    if (!_gcashAccounts.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = _gcashAccounts.map(a => {
      const isDefault = !!a.is_default;
      const qr = a.gcash_qr_url
        ? `<img src="${_escGc(a.gcash_qr_url)}" alt="QR"
               style="width:64px;height:64px;object-fit:contain;background:#fff;border-radius:8px;padding:4px;flex-shrink:0;">`
        : `<div style="width:64px;height:64px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
                       border:1px dashed rgba(255,255,255,0.18);color:var(--muted);font-size:10px;text-align:center;line-height:1.3;">NO<br>QR</div>`;

      const badge = isDefault
        ? `<span style="display:inline-block;font-size:10px;letter-spacing:1px;font-weight:700;padding:3px 8px;border-radius:999px;
                        background:rgba(230,30,37,0.15);color:var(--red);border:1px solid rgba(230,30,37,0.45);">DEFAULT</span>`
        : '';

      const labelLine = a.label
        ? `<div style="font-size:12px;color:var(--muted);margin-top:4px;">${_escGc(a.label)}</div>`
        : '';

      const defaultBtn = isDefault
        ? `<button type="button" class="btn btn-outline btn-sm" disabled
                   title="This is the account members already see">✓ SHOWN TO MEMBERS</button>`
        : `<button type="button" class="btn btn-outline btn-sm"
                   onclick="promptSetDefaultGcash(${a.id})">SET AS DEFAULT</button>`;

      return `
        <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;padding:16px;margin-bottom:12px;border-radius:12px;
                    background:rgba(255,255,255,0.02);
                    border:1px solid ${isDefault ? 'rgba(230,30,37,0.45)' : 'rgba(255,255,255,0.08)'};">
          ${qr}
          <div style="flex:1;min-width:180px;">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <span style="font-size:18px;font-weight:600;color:var(--white);letter-spacing:0.5px;">${_escGc(a.gcash_number)}</span>
              ${badge}
            </div>
            <div style="font-size:14px;color:var(--white);opacity:0.85;margin-top:4px;">${_escGc(a.gcash_account_name)}</div>
            ${labelLine}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            ${defaultBtn}
            <button type="button" class="btn btn-outline btn-sm" onclick="openEditGcashModal(${a.id})">✎ EDIT</button>
            <button type="button" class="btn btn-outline btn-sm"
                    style="color:var(--red);border-color:rgba(230,30,37,0.4);"
                    onclick="promptDeleteGcashAccount(${a.id})">🗑️ DELETE</button>
          </div>
        </div>`;
    }).join('');
  }

  /** Read the server-rendered account list out of the page on first load. */
  function initGcashAccounts() {
    const tag = document.getElementById('gcash-accounts-data');
    if (!tag) return;
    try {
      renderGcashAccounts(JSON.parse(tag.textContent || '[]'));
    } catch (e) {
      renderGcashAccounts([]);
    }
  }

  /** Reset the add/edit modal to a blank "add" state. */
  function openAddGcashModal() {
    document.getElementById('gcash-account-id').value   = '';
    document.getElementById('gcash-number').value       = '';
    document.getElementById('gcash-account-name').value = '';
    document.getElementById('gcash-label').value        = '';
    document.getElementById('gcash-qr-input').value     = '';

    const removeCheck = document.getElementById('gcash-qr-remove');
    if (removeCheck) removeCheck.checked = false;
    document.getElementById('gcash-qr-current-wrap').style.display = 'none';
    document.getElementById('gcash-qr-remove-row').style.display   = 'none';

    const makeDefault = document.getElementById('gcash-make-default');
    const defaultRow  = document.getElementById('gcash-make-default-row');
    // The very first account saved is the default by definition, so the
    // choice would be meaningless — hide it rather than offer a checkbox
    // that can't do anything.
    const isFirst = _gcashAccounts.length === 0;
    if (makeDefault) makeDefault.checked = isFirst;
    if (defaultRow)  defaultRow.style.display = isFirst ? 'none' : 'flex';

    document.getElementById('gcash-modal-title').textContent = 'ADD GCASH ACCOUNT';
    document.getElementById('gcash-save-btn').textContent    = 'SAVE ACCOUNT';
    openModal('gcash-account-modal');
  }

  /** Load one saved account into the modal for editing. */
  function openEditGcashModal(accountId) {
    const a = _gcashById(accountId);
    if (!a) { showToast('That account is no longer available.', 'error'); return; }

    document.getElementById('gcash-account-id').value   = a.id;
    document.getElementById('gcash-number').value       = a.gcash_number || '';
    document.getElementById('gcash-account-name').value = a.gcash_account_name || '';
    document.getElementById('gcash-label').value        = a.label || '';
    document.getElementById('gcash-qr-input').value     = '';

    const removeCheck = document.getElementById('gcash-qr-remove');
    if (removeCheck) removeCheck.checked = false;

    const wrap      = document.getElementById('gcash-qr-current-wrap');
    const img       = document.getElementById('gcash-qr-current-preview');
    const removeRow = document.getElementById('gcash-qr-remove-row');
    if (a.gcash_qr_url) {
      if (img) img.src = a.gcash_qr_url;
      wrap.style.display      = '';
      removeRow.style.display = 'flex';
    } else {
      if (img) img.src = '';
      wrap.style.display      = 'none';
      removeRow.style.display = 'none';
    }

    const makeDefault = document.getElementById('gcash-make-default');
    const defaultRow  = document.getElementById('gcash-make-default-row');
    // Already the default? Then there's nothing to switch to.
    if (makeDefault) makeDefault.checked = false;
    if (defaultRow)  defaultRow.style.display = a.is_default ? 'none' : 'flex';

    document.getElementById('gcash-modal-title').textContent = 'EDIT GCASH ACCOUNT';
    document.getElementById('gcash-save-btn').textContent    = 'SAVE CHANGES';
    openModal('gcash-account-modal');
  }

  /** Preview a newly-picked QR file before saving, and clear the "remove"
   *  checkbox since picking a new file supersedes removing the old one. */
  function previewGcashQr(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const removeCheck = document.getElementById('gcash-qr-remove');
    if (removeCheck) removeCheck.checked = false;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img  = document.getElementById('gcash-qr-current-preview');
      const wrap = document.getElementById('gcash-qr-current-wrap');
      if (img)  img.src = e.target.result;
      if (wrap) wrap.style.display = '';
    };
    reader.readAsDataURL(file);
  }

  /** Toggling "remove current QR" clears any newly-picked file and hides
   *  the preview, since the two actions are mutually exclusive. */
  function toggleGcashQrRemove(checkbox) {
    const wrap  = document.getElementById('gcash-qr-current-wrap');
    const input = document.getElementById('gcash-qr-input');
    if (checkbox.checked) {
      if (input) input.value = '';
      if (wrap) wrap.style.display = 'none';
    } else if (wrap && wrap.querySelector('img') && wrap.querySelector('img').src) {
      wrap.style.display = '';
    }
  }

  /** Validate, then create or update depending on whether the hidden id
   *  field is populated. */
  function submitGcashAccount() {
    const accountId          = _val('gcash-account-id');
    const gcash_number       = _val('gcash-number');
    const gcash_account_name = _val('gcash-account-name');

    if (!gcash_number || !gcash_account_name) {
      showToast('GCash number and account name are both required.', 'error');
      return;
    }
    if (!/^09\d{2}\s?\d{3}\s?\d{4}$/.test(gcash_number)) {
      showToast('Enter a valid GCash number, e.g. 0917 123 4567.', 'error');
      return;
    }

    const btn = document.getElementById('gcash-save-btn');
    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'SAVING...'; }

    const fd = new FormData();
    fd.append('gcash_number', gcash_number);
    fd.append('gcash_account_name', gcash_account_name);
    fd.append('label', _val('gcash-label'));

    const qrInput = document.getElementById('gcash-qr-input');
    if (qrInput && qrInput.files[0]) fd.append('gcash_qr', qrInput.files[0]);
    const removeCheck = document.getElementById('gcash-qr-remove');
    if (removeCheck && removeCheck.checked) fd.append('remove_qr', 'true');
    const makeDefault = document.getElementById('gcash-make-default');
    if (makeDefault && makeDefault.checked) fd.append('make_default', 'true');

    const url = accountId
      ? `/admin/gcash-accounts/${accountId}/update`
      : '/admin/gcash-accounts/add';

    fetch(url, { method: 'POST', body: fd })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast((data && data.error) || 'Failed to save the GCash account.', 'error');
          return;
        }
        renderGcashAccounts(data.accounts);
        closeModal('gcash-account-modal');
        showToast(data.message || 'GCash account saved.', 'success');
      })
      .catch(() => showToast('Could not reach the server. Please try again.', 'error'))
      .finally(() => {
        if (btn) { btn.disabled = false; btn.textContent = originalText; }
      });
  }

  /** Confirm before switching which account members are shown — this is a
   *  money-facing change, so it shouldn't happen on a stray click. */
  function promptSetDefaultGcash(accountId) {
    const a = _gcashById(accountId);
    if (!a) { showToast('That account is no longer available.', 'error'); return; }
    _gcashPendingDefaultId = accountId;
    const text = document.getElementById('confirm-default-gcash-text');
    if (text) {
      text.innerHTML = `Members will start sending payments to<br>
        <strong>${_escGc(a.gcash_account_name)}</strong><br>${_escGc(a.gcash_number)}<br>
        <span style="font-size:13px;color:var(--muted);">This takes effect right away. Payments already submitted aren't affected.</span>`;
    }
    openModal('confirm-default-gcash-modal');
  }

  function confirmSetDefaultGcash() {
    if (!_gcashPendingDefaultId) return;
    const btn = document.getElementById('confirm-default-gcash-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'SWITCHING...'; }

    fetch(`/admin/gcash-accounts/${_gcashPendingDefaultId}/set-default`, { method: 'POST' })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        closeModal('confirm-default-gcash-modal');
        if (!ok || !data.success) {
          showToast((data && data.error) || 'Failed to switch accounts.', 'error');
          return;
        }
        renderGcashAccounts(data.accounts);
        showToast(data.message || 'Default GCash account updated.', 'success');
      })
      .catch(() => {
        closeModal('confirm-default-gcash-modal');
        showToast('Could not reach the server. Please try again.', 'error');
      })
      .finally(() => {
        _gcashPendingDefaultId = null;
        if (btn) { btn.disabled = false; btn.textContent = 'YES, SWITCH'; }
      });
  }

  /** Confirm before deleting, spelling out what members will see next. */
  function promptDeleteGcashAccount(accountId) {
    const a = _gcashById(accountId);
    if (!a) { showToast('That account is no longer available.', 'error'); return; }
    _gcashPendingDeleteId = accountId;

    const others = _gcashAccounts.filter(x => String(x.id) !== String(accountId));
    let consequence;
    if (!a.is_default) {
      consequence = `<span style="font-size:13px;color:var(--muted);">This isn't the account members see, so nothing changes for them.</span>`;
    } else if (others.length) {
      consequence = `<span style="font-size:13px;color:var(--muted);">This is the account members currently see — another saved account will take over automatically.</span>`;
    } else {
      consequence = `<span style="font-size:13px;color:var(--red);">This is your only GCash account. Members won't be able to pay via GCash until you add a new one.</span>`;
    }

    const text = document.getElementById('confirm-delete-gcash-text');
    if (text) {
      text.innerHTML = `<strong>${_escGc(a.gcash_account_name)}</strong><br>${_escGc(a.gcash_number)}<br><br>${consequence}`;
    }
    openModal('confirm-delete-gcash-modal');
  }

  function confirmDeleteGcashAccount() {
    if (!_gcashPendingDeleteId) return;
    const btn = document.getElementById('confirm-delete-gcash-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'DELETING...'; }

    fetch(`/admin/gcash-accounts/${_gcashPendingDeleteId}/delete`, { method: 'POST' })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        closeModal('confirm-delete-gcash-modal');
        if (!ok || !data.success) {
          showToast((data && data.error) || 'Failed to remove the GCash account.', 'error');
          return;
        }
        renderGcashAccounts(data.accounts);
        showToast(data.message || 'GCash account removed.', 'success');
      })
      .catch(() => {
        closeModal('confirm-delete-gcash-modal');
        showToast('Could not reach the server. Please try again.', 'error');
      })
      .finally(() => {
        _gcashPendingDeleteId = null;
        if (btn) { btn.disabled = false; btn.textContent = 'YES, DELETE'; }
      });
  }

  /** Save the Terms & Policy content and estimated read-time shown to new
   *  members during registration. Direct save (no confirm modal, unlike
   *  GCash) since this doesn't affect money — just a toast on success. */
  function submitTermsSettings() {
    const terms_content      = (document.getElementById('terms-content-editor') || {}).value || '';
    const terms_read_minutes = _val('terms-read-minutes');

    if (!terms_content.trim()) {
      showToast('Terms & Policy content cannot be empty.', 'error');
      return;
    }
    const minutes = parseInt(terms_read_minutes, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10) {
      showToast('Estimated read time must be between 1 and 10 minutes.', 'error');
      return;
    }

    const btn = document.getElementById('terms-settings-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'SAVING...'; }

    fetch('/admin/update-terms-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms_content, terms_read_minutes: minutes })
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast((data && data.error) || 'Failed to update Terms & Policy.', 'error');
          return;
        }
        showToast(data.message || 'Terms & Policy updated.', 'success');
      })
      .catch(() => showToast('Could not reach the server. Please try again.', 'error'))
      .finally(() => {
        if (btn) { btn.disabled = false; btn.textContent = 'SAVE TERMS & POLICY'; }
      });
  }

  /** Save a coach's available days, capacity, and fee from the admin
   *  Coach tab. Called as the onsubmit handler of each coach card's form —
   *  posts to the same /staff/coach/update endpoint staff uses (it accepts
   *  either role), so both dashboards stay in sync automatically.
   *
   *  Flow: SAVE opens a "are you sure?" confirm modal (submitCoachUpdate);
   *  clicking YES there (confirmCoachUpdate) actually posts the change and,
   *  on success, shows a "successfully saved" modal instead of just a toast. */
  let pendingCoachForm = null;

  function submitCoachUpdate(event) {
    event.preventDefault();
    pendingCoachForm = event.target;
    openModal('confirm-coach-save-modal');
    return false;
  }

  function confirmCoachUpdate() {
    const form = pendingCoachForm;
    if (!form) { closeModal('confirm-coach-save-modal'); return; }

    const modalBtn = document.getElementById('confirm-coach-save-btn');
    if (modalBtn) { modalBtn.disabled = true; modalBtn.textContent = 'SAVING...'; }

    fetch('/staff/coach/update', { method: 'POST', body: new FormData(form) })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        closeModal('confirm-coach-save-modal');
        if (!ok || !data.success) {
          showToast(data.error || 'Could not update coach.', 'error');
          return;
        }
        openModal('coach-save-success-modal');
      })
      .catch(() => {
        closeModal('confirm-coach-save-modal');
        showToast('Could not reach the server. Please try again.', 'error');
      })
      .finally(() => {
        if (modalBtn) { modalBtn.disabled = false; modalBtn.textContent = 'YES'; }
        pendingCoachForm = null;
      });
  }

  /** Closes the coach "successfully saved" modal, then reloads so the Coach
   *  tab reflects the freshly saved values (occupancy badges, etc). */
  function closeCoachSaveSuccessModal() {
    closeModal('coach-save-success-modal');
    window.location.reload();
  }

  /** Toggles a coach card between its read-only view and the editable
   *  form (pencil icon <-> Cancel button). No server call — purely a
   *  local show/hide so browsing the roster doesn't look like a wall
   *  of open forms. */
  function toggleCoachEdit(coachId) {
    const card = document.querySelector(`.coach-card[data-coach-id="${coachId}"]`);
    if (!card) return;
    const view = card.querySelector('.coach-view');
    const edit = card.querySelector('.coach-edit');
    if (!view || !edit) return;
    const editing = edit.style.display !== 'none';
    view.style.display = editing ? '' : 'none';
    edit.style.display = editing ? 'none' : '';
  }

  /** Reads the "Add Coach" modal fields and posts a new coach to the
   *  roster. On success, reloads so the new card appears with correct
   *  occupancy/slot data computed server-side. */
  function addCoach() {
    const name = _val('add-coach-name');
    if (!name) {
      showToast('Please enter a coach name', 'error');
      return;
    }
    const days = Array.from(document.querySelectorAll('.add-coach-day:checked')).map(cb => cb.value);
    const maxMembers = _val('add-coach-max');
    const fee = _val('add-coach-fee');

    const addBtn = document.querySelector('#add-coach-modal .btn-red');
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'ADDING...'; }

    fetch('/staff/coach/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        available_days: days,
        max_members: maxMembers,
        fee: fee
      })
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'ADD COACH'; }
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to add coach.', 'error');
          return;
        }
        closeModal('add-coach-modal');
        showToast(data.message || 'Coach added.', 'success');
        window.location.reload();
      })
      .catch(() => {
        if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'ADD COACH'; }
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  /** Opens the delete-confirmation modal for a given coach. */
  let pendingDeleteCoachId = null;

  function promptDeleteCoach(coachId, coachName) {
    pendingDeleteCoachId = coachId;
    const label = document.getElementById('delete-coach-name');
    if (label) label.textContent = coachName;
    openModal('delete-coach-modal');
  }

  /** Confirms and posts the coach deletion. The backend blocks deletion
   *  (with an explanatory error) if the coach still has active members. */
  function confirmDeleteCoach() {
    if (!pendingDeleteCoachId) { closeModal('delete-coach-modal'); return; }

    const btn = document.getElementById('confirm-coach-delete-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'DELETING...'; }

    fetch('/staff/coach/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coach_id: pendingDeleteCoachId })
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        closeModal('delete-coach-modal');
        if (!ok || !data.success) {
          showToast(data.error || 'Could not delete coach.', 'error');
          return;
        }
        showToast(data.message || 'Coach deleted.', 'success');
        window.location.reload();
      })
      .catch(() => {
        closeModal('delete-coach-modal');
        showToast('Could not reach the server. Please try again.', 'error');
      })
      .finally(() => {
        if (btn) { btn.disabled = false; btn.textContent = 'YES, DELETE'; }
        pendingDeleteCoachId = null;
      });
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

    // Let the person reposition/zoom before it's uploaded, rather than
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
    fetch('/update-profile-picture', { method: 'POST', body: formData })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
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

  /** Create a new Staff account from the "+ ADD STAFF" modal. Admin
   *  accounts are not created here — this page only ever creates Staff.
   *  The backend generates a random temp password and emails the new hire
   *  a welcome message that explicitly says this is a staff account, never
   *  a member account — this button doesn't do that part, it just triggers it. */
  function addStaff() {
    const firstName = _val('add-staff-fname');
    const lastName  = _val('add-staff-lname');
    const email     = _val('add-staff-email');
    const phone     = _val('add-staff-phone');

    if (!firstName || !lastName || !email) {
      showToast('Please fill in first name, last name, and email.', 'error');
      return;
    }
    if (phone && !/^09\d{9}$/.test(phone)) {
      showToast('Phone number must start with 09 and be exactly 11 digits.', 'error');
      return;
    }

    const addBtn = document.querySelector('#add-staff-modal .btn-red');
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'CREATING...'; }

    fetch('/admin/add-staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ first_name: firstName, last_name: lastName, email, phone })
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'CREATE ACCOUNT'; }
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to create account.', 'error');
          return;
        }

        const s = data.staff;
        const tbody = document.querySelector('#staff-accounts-table tbody');
        if (tbody) {
          // Drop the "No staff accounts yet" placeholder row, if present.
          const placeholder = tbody.querySelector('td[colspan="5"]');
          if (placeholder) placeholder.closest('tr').remove();

          const row = document.createElement('tr');
          row.dataset.id     = s.id;
          row.dataset.name   = s.name;
          row.dataset.email  = s.email;
          row.dataset.role   = s.role;
          row.dataset.status = s.status;
          row.innerHTML = `
            <td>${s.name}</td>
            <td>${s.email}</td>
            <td><span class="badge badge-blue">Staff</span></td>
            <td><span class="badge ${s.status === 'active' ? 'badge-green' : 'badge-muted'}">${s.status === 'active' ? 'Active' : 'Suspended'}</span></td>
            <td>
              <button class="btn btn-sm btn-outline" onclick="openEditStaffModal(this)">Edit</button>
              <button class="btn btn-sm" style="background:rgba(230,30,37,0.1);color:var(--red);border:1px solid rgba(230,30,37,0.2);" onclick="promptDeleteStaff(this)">Delete</button>
            </td>`;
          tbody.prepend(row);
        }

        closeModal('add-staff-modal');
        ['add-staff-fname', 'add-staff-lname', 'add-staff-email', 'add-staff-phone'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });

        // The temp password is shown here once too (not just emailed) so
        // the admin can hand it over directly if the new hire can't check
        // their email right away.
        showToast(`Staff account created! Temporary password: ${s.temp_password}`, 'success');
      })
      .catch(() => {
        if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'CREATE ACCOUNT'; }
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  let editingStaffId = null;

  /** Open the Edit Staff modal, pre-filled from the row's data */
  function openEditStaffModal(btn) {
    const row = btn.closest('tr');
    if (!row) return;

    editingStaffId = row.dataset.id;
    document.getElementById('edit-staff-name').value  = row.dataset.name  || '';
    document.getElementById('edit-staff-email').value = row.dataset.email || '';

    const statusSelect = document.getElementById('edit-staff-status');
    if (statusSelect) statusSelect.value = row.dataset.status || 'active';

    openModal('edit-staff-modal');
  }

  /** Save status changes from the Edit Staff modal */
  function saveEditStaff() {
    if (!editingStaffId) return;
    const status = document.getElementById('edit-staff-status')?.value || 'active';

    fetch(`/admin/edit-staff/${editingStaffId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to update account.', 'error');
          return;
        }

        const s = data.staff;
        const row = document.querySelector(`#staff-accounts-table tr[data-id="${s.id}"]`);
        if (row) {
          row.dataset.status = s.status;
          const cells = row.querySelectorAll('td');
          if (cells[3]) cells[3].innerHTML = `<span class="badge ${s.status === 'active' ? 'badge-green' : 'badge-muted'}">${s.status === 'active' ? 'Active' : 'Suspended'}</span>`;
        }

        closeModal('edit-staff-modal');
        editingStaffId = null;
        showToast(data.message || 'Staff account updated.', 'success');
      })
      .catch(() => showToast('Could not reach the server. Please try again.', 'error'));
  }

  let pendingDeleteStaffId = null;

  /** "Delete" on a staff row — opens the confirmation modal rather than
   *  deleting immediately, mirroring the confirm-before-destructive-action
   *  pattern used for coaches/announcements elsewhere in this dashboard. */
  function promptDeleteStaff(btn) {
    const row = btn.closest('tr');
    if (!row) return;
    pendingDeleteStaffId = row.dataset.id;
    const msgEl = document.getElementById('delete-staff-message');
    if (msgEl) msgEl.textContent = `Delete ${row.dataset.name || 'this account'} (${row.dataset.email || ''})?`;
    openModal('delete-staff-modal');
  }

  /** "DELETE" on the confirmation modal — actually sends the request. */
  function confirmDeleteStaff() {
    if (!pendingDeleteStaffId) return;
    const id = pendingDeleteStaffId;

    fetch(`/admin/delete-staff/${id}`, { method: 'POST' })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        closeModal('delete-staff-modal');
        pendingDeleteStaffId = null;
        if (!ok || !data.success) {
          showToast(data.error || 'Failed to delete account.', 'error');
          return;
        }
        const row = document.querySelector(`#staff-accounts-table tr[data-id="${id}"]`);
        if (row) row.remove();

        // If that was the last row, restore the "no accounts yet" placeholder.
        const tbody = document.querySelector('#staff-accounts-table tbody');
        if (tbody && !tbody.querySelector('tr')) {
          tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;">No staff accounts yet — click "+ ADD STAFF" to create one.</td></tr>';
        }

        showToast(data.message || 'Account deleted.', 'success');
      })
      .catch(() => {
        closeModal('delete-staff-modal');
        pendingDeleteStaffId = null;
        showToast('Could not reach the server. Please try again.', 'error');
      });
  }

  return {
    init, tab, addMember, openEditMemberModal, saveEditMember, deleteMemberRow,
    addStaff, openEditStaffModal, saveEditStaff, promptDeleteStaff, confirmDeleteStaff,
    generateAnalyticsReport, refreshCurrentReport, exportReportPDF, clearReportDateRange,
    viewPaymentProof, viewPaymentProofs, viewStudentIdProof, filterMembersByStatus, filterMembersTable, toggleMemberIdColumn,
    goToAdminMembers, goToAdminRevenue,
    publishAnnouncement, confirmPublishAnnouncement, openEditAnnouncementModal, saveEditAnnouncement,
    toggleAnnouncement, deleteAnnouncement,
    previewGcashQr, toggleGcashQrRemove, submitTermsSettings,
    initGcashAccounts, renderGcashAccounts, openAddGcashModal, openEditGcashModal,
    submitGcashAccount, promptSetDefaultGcash, confirmSetDefaultGcash,
    promptDeleteGcashAccount, confirmDeleteGcashAccount,
    submitCoachUpdate, confirmCoachUpdate, closeCoachSaveSuccessModal,
    toggleCoachEdit, addCoach, promptDeleteCoach, confirmDeleteCoach,
    changeProfilePicture
  };
})();


/* ════════════════════════════════════════════════
   INIT — DOMContentLoaded Bootstrap
════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('admin-dashboard-root')) return;

  AdminModule.init();

  window.adminTab                = (tab, el) => AdminModule.tab(tab, el);
  window.addMember               = AdminModule.addMember;
  window.openEditMemberModal     = AdminModule.openEditMemberModal;
  window.saveEditMember          = AdminModule.saveEditMember;
  window.deleteMemberRow         = AdminModule.deleteMemberRow;
  window.generateAnalyticsReport = AdminModule.generateAnalyticsReport;
  window.refreshCurrentReport    = AdminModule.refreshCurrentReport;
  window.exportCurrentReportPDF  = AdminModule.exportReportPDF;
  window.clearReportDateRange    = AdminModule.clearReportDateRange;
  window.viewPaymentProof        = AdminModule.viewPaymentProof;
  window.viewPaymentProofs       = AdminModule.viewPaymentProofs;
  window.viewStudentIdProof      = AdminModule.viewStudentIdProof;
  window.filterAdminMembersByStatus = (status, el) => AdminModule.filterMembersByStatus(status, el);
  window.filterAdminMembersTable    = () => AdminModule.filterMembersTable();
  window.toggleAdminMemberIdColumn  = () => AdminModule.toggleMemberIdColumn();
  window.goToAdminMembers        = (status) => AdminModule.goToAdminMembers(status);
  window.goToAdminRevenue        = () => AdminModule.goToAdminRevenue();
  window.publishAnnouncement     = AdminModule.publishAnnouncement;
  window.confirmPublishAnnouncement = AdminModule.confirmPublishAnnouncement;
  window.openEditAnnouncementModal = AdminModule.openEditAnnouncementModal;
  window.saveEditAnnouncement    = AdminModule.saveEditAnnouncement;
  window.toggleAnnouncement      = AdminModule.toggleAnnouncement;
  window.deleteAnnouncement      = AdminModule.deleteAnnouncement;
  window.previewGcashQr          = (input) => AdminModule.previewGcashQr(input);
  window.toggleGcashQrRemove     = (checkbox) => AdminModule.toggleGcashQrRemove(checkbox);
  window.openAddGcashModal       = () => AdminModule.openAddGcashModal();
  window.openEditGcashModal      = (id) => AdminModule.openEditGcashModal(id);
  window.submitGcashAccount      = () => AdminModule.submitGcashAccount();
  window.promptSetDefaultGcash   = (id) => AdminModule.promptSetDefaultGcash(id);
  window.confirmSetDefaultGcash  = () => AdminModule.confirmSetDefaultGcash();
  window.promptDeleteGcashAccount  = (id) => AdminModule.promptDeleteGcashAccount(id);
  window.confirmDeleteGcashAccount = () => AdminModule.confirmDeleteGcashAccount();
  AdminModule.initGcashAccounts();
  window.submitTermsSettings     = AdminModule.submitTermsSettings;
  window.submitCoachUpdate       = AdminModule.submitCoachUpdate;
  window.confirmCoachUpdate      = AdminModule.confirmCoachUpdate;
  window.closeCoachSaveSuccessModal = AdminModule.closeCoachSaveSuccessModal;
  window.toggleCoachEdit         = (coachId) => AdminModule.toggleCoachEdit(coachId);
  window.addCoach                = () => AdminModule.addCoach();
  window.promptDeleteCoach       = (coachId, coachName) => AdminModule.promptDeleteCoach(coachId, coachName);
  window.confirmDeleteCoach      = () => AdminModule.confirmDeleteCoach();
  window.changeProfilePicture    = (input) => AdminModule.changeProfilePicture(input);
  window.openEditStaffModal      = AdminModule.openEditStaffModal;
  window.promptDeleteStaff       = AdminModule.promptDeleteStaff;
});