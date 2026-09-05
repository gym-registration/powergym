/* ═══════════════════════════════════════════════════════════════
   POWER GYM — Common JavaScript
   tr-common.js  |  Shared across ALL pages

   Load this file FIRST, before any page-specific script
   (tr-login.js / tr-admin.js / tr-staff.js / tr-member.js).

   MODULE MAP:
   ─────────────────────────────────────────────────────────────
   1.  Auth      — login, logout, session, registration (localStorage)
   2.  Session   — guard on dashboards
   3.  Navigation — screen/tab switching, sidebar active state, role hint
   4.  Shared    — attendance grid, filter table, modals, logout
   5.  Toast     — toast notification system
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ════════════════════════════════════════════════
   1. AUTH MODULE
   Handles login, logout, registration.
   Uses localStorage so session persists across pages.
════════════════════════════════════════════════ */
const Auth = (() => {

  const ADMIN_ACCOUNTS = {
    'admin@powergym.com': { password: 'admin123', role: 'admin', name: 'Administrator', initials: 'AD' }
  };

  const STAFF_ACCOUNTS = {
    'staff@powergym.com': { password: 'staff123', role: 'staff', name: 'Staff Member', initials: 'SF' }
  };

  // Member accounts also stored in localStorage for persistence
  let _memberAccounts = {};

  function _loadMembers() {
    try { _memberAccounts = JSON.parse(localStorage.getItem('trmem_members') || '{}'); }
    catch (e) { _memberAccounts = {}; }
    // Seed default demo member
    if (!_memberAccounts['maria@email.com']) {
      _memberAccounts['maria@email.com'] = { password: 'member123', role: 'member', name: 'Maria Santos', initials: 'MS' };
      _saveMembers();
    }
  }

  function _saveMembers() {
    try { localStorage.setItem('trmem_members', JSON.stringify(_memberAccounts)); }
    catch (e) { /* Storage unavailable */ }
  }

  function getAccount(email) {
    const e = email.toLowerCase().trim();
    return ADMIN_ACCOUNTS[e] || STAFF_ACCOUNTS[e] || _memberAccounts[e] || null;
  }

  function login(email, password) {
    _loadMembers();
    const account = getAccount(email);
    if (!account) return { success: false, error: 'Account not found. Please register first.' };
    if (account.password !== password) return { success: false, error: 'Incorrect password. Please try again.' };
    const session = {
      email: email.toLowerCase().trim(),
      role: account.role,
      name: account.name,
      initials: account.initials
    };
    try { localStorage.setItem('trmem_session', JSON.stringify(session)); }
    catch (e) { /* fallback: session only lives in memory */ }
    return { success: true, session };
  }

  function logout() {
    try { localStorage.removeItem('trmem_session'); }
    catch (e) { /* ignore */ }
  }

  function getSession() {
    try {
      const raw = localStorage.getItem('trmem_session');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function getRole() {
    const s = getSession();
    return s ? s.role : null;
  }

  function detectRole(email) {
    _loadMembers();
    const e = email.toLowerCase().trim();
    if (ADMIN_ACCOUNTS[e]) return 'admin';
    if (STAFF_ACCOUNTS[e]) return 'staff';
    if (e.length > 3 && e.includes('@')) return 'member';
    return null;
  }

  function registerMember(email, password, name) {
    _loadMembers();
    const e = email.toLowerCase().trim();
    if (ADMIN_ACCOUNTS[e] || STAFF_ACCOUNTS[e]) return false;
    const initials = name ? name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'MB';
    _memberAccounts[e] = { password, role: 'member', name: name || 'New Member', initials };
    _saveMembers();
    return true;
  }

  // Initialize member store
  _loadMembers();

  return { login, logout, getSession, getRole, detectRole, registerMember, getAccount };
})();


/* ════════════════════════════════════════════════
   2. SESSION MODULE
   Guards dashboard pages; redirects if role doesn't match.
   Called on each dashboard's DOMContentLoaded.
════════════════════════════════════════════════ */
const Session = (() => {

  const DASHBOARD_ROLES = {
    'admin-dashboard.html':  'admin',
    'staff-dashboard.html':  'staff',
    'member-dashboard.html': 'member'
  };

  /**
   * Called on a dashboard page.
   * If session is invalid or role doesn't match, redirect to login.
   * Returns the session if valid, null otherwise.
   */
  function guardDashboard() {
    // Flask handles authentication server-side.
    // Just read sidebar elements already rendered by Jinja and return a session-like object.
    const name     = document.getElementById('sidebar-user-name')?.textContent  || '';
    const email    = document.getElementById('sidebar-user-email')?.textContent || '';
    const initials = document.getElementById('sidebar-user-avatar')?.textContent || '';
    return { name, email, initials };
  }

  function redirectToLogin() {
    window.location.href = '/login';
  }

  function redirectToRole(role) {
    const map = { admin: '/admin', staff: '/staff', member: '/member' };
    window.location.href = map[role] || '/login';
  }

  return { guardDashboard, redirectToLogin, redirectToRole };
})();


/* ════════════════════════════════════════════════
   3. NAVIGATION MODULE
   Handles screen switching (login page) and
   sidebar tab activation (dashboard pages).
════════════════════════════════════════════════ */
const Navigation = (() => {

  /** Switch screens on trmem.html (login/register) */
  function goToScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById('screen-' + screenId);
    if (el) el.classList.add('active');
  }

  /** Activate a sub-panel and highlight nav item */
  function activateTab(prefix, tab, navEl) {
    // Hide all sub-panels
    document.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
    // Deactivate all nav items
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    // Show target panel
    const panel = document.getElementById(prefix + '-' + tab);
    if (panel) panel.classList.add('active');
    // Highlight nav item
    if (navEl) navEl.classList.add('active');
    else {
      const autoNav = document.getElementById('nav-' + prefix + '-' + tab);
      if (autoNav) autoNav.classList.add('active');
    }
  }

  /** Show role hint bar on the login form */
  function showRoleHint(role) {
    const bar = document.getElementById('role-hint-bar');
    const tag = document.getElementById('login-role-tag');
    if (!bar || !tag) return;

    const configs = {
      admin:  { text: '🛡️ Admin Account Detected',  bg: 'rgba(230,30,37,0.12)',   color: 'var(--red)',   border: 'var(--red)',   tagText: 'ADMIN ACCESS' },
      staff:  { text: '👥 Staff Account Detected',  bg: 'rgba(26,71,138,0.2)',    color: '#8eb8ff',      border: '#8eb8ff',      tagText: 'STAFF ACCESS' },
      member: { text: '⚡ Member Login',             bg: 'rgba(255,171,64,0.1)',   color: 'var(--gold)',  border: 'rgba(255,171,64,0.3)', tagText: 'MEMBER ACCESS' }
    };

    if (role && configs[role]) {
      const cfg = configs[role];
      bar.style.cssText = `display:block;background:${cfg.bg};color:${cfg.color};border:1px solid ${cfg.border};margin-bottom:16px;padding:10px 14px;border-radius:4px;font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;`;
      bar.textContent = cfg.text;
      tag.textContent = cfg.tagText;
    } else {
      bar.style.display = 'none';
      tag.textContent = '\u00a0';
    }
  }

  return { goToScreen, activateTab, showRoleHint };
})();


/* ════════════════════════════════════════════════
   4. SHARED UTILITIES
   Functions used across multiple modules / pages.
════════════════════════════════════════════════ */

/** Build an attendance dot grid. totalDays defaults to 30 if not given
 *  (kept for backward compatibility with pages that don't pass it yet). */
function buildAttGrid(elId, presentDays, totalDays = 30, todayDay = null, noPlanDays = []) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  const noPlanSet = new Set(noPlanDays || []);
  for (let d = 1; d <= totalDays; d++) {
    const dot = document.createElement('div');
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
    dot.className  = 'att-dot ' + state;
    dot.textContent = d;
    el.appendChild(dot);
  }
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
  if (el) el.classList.remove('open');
}

/** Open the Terms & Policy modal from registration, and unlock the
 *  "I agree" checkbox once the member closes it (✕ button or backdrop
 *  click) so they can't check it without opening the terms first. */
function openTermsModal() {
  openModal('terms-modal');
  const modal = document.getElementById('terms-modal');
  const checkbox = document.getElementById('reg-terms-check');
  const hint = document.getElementById('reg-terms-hint');
  if (!modal) return;

  const observer = new MutationObserver(() => {
    if (!modal.classList.contains('open')) {
      if (checkbox) checkbox.disabled = false;
      if (hint) hint.style.display = 'none';
      observer.disconnect();
    }
  });
  observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
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

/** Payment verification (used by admin and staff) — clicking Approve/Confirm
 *  or Reject on a request card doesn't fire the request immediately. It
 *  first opens a confirmation modal (see confirmVerifyPayment /
 *  cancelVerifyPayment below) that spells out exactly which member, plan,
 *  and amount are about to be approved or rejected, so staff/admin always
 *  see what they're accepting before it's final. */
let _pendingVerifyPayment = null;

function verifyPayment(btn, action) {
  const card = btn.closest('.verify-card');
  if (!card) return;

  const paymentId = card.dataset.paymentId;
  if (!paymentId) { showToast('Missing payment reference — cannot verify.', 'error'); return; }

  const memberName = card.dataset.memberName || 'this member';
  const plan       = card.dataset.plan || 'this plan';
  const amount     = card.dataset.amount;

  _pendingVerifyPayment = { card, action };

  const titleEl   = document.getElementById('confirm-verify-payment-title');
  const messageEl = document.getElementById('confirm-verify-payment-message');
  const detailsEl = document.getElementById('confirm-verify-payment-details');
  const yesBtn    = document.getElementById('confirm-verify-payment-btn');

  if (titleEl) titleEl.textContent = action === 'reject' ? 'REJECT REQUEST' : 'CONFIRM PAYMENT';
  if (messageEl) {
    messageEl.textContent = action === 'reject'
      ? `Reject ${memberName}'s request for the ${plan} plan?`
      : `Approve ${memberName}'s request for the ${plan} plan?`;
  }
  if (detailsEl) detailsEl.textContent = amount ? `Amount: ₱${amount}` : '';
  if (yesBtn) yesBtn.className = action === 'reject' ? 'btn btn-red' : 'btn btn-green';

  openModal('confirm-verify-payment-modal');
}

/** "NO" / ✕ on the verify-payment confirmation modal — discards it, no
 *  request is sent and no buttons on the card are disabled. */
function cancelVerifyPayment() {
  closeModal('confirm-verify-payment-modal');
  _pendingVerifyPayment = null;
}

/** "YES" on the verify-payment confirmation modal — actually sends the
 *  approve/reject request that verifyPayment() staged. */
function confirmVerifyPayment() {
  closeModal('confirm-verify-payment-modal');
  if (!_pendingVerifyPayment) return;
  const { card, action } = _pendingVerifyPayment;
  _pendingVerifyPayment = null;
  _doVerifyPayment(card, action);
}

/** Actually performs the approve/reject call against the backend. */
function _doVerifyPayment(card, action) {
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
      // Fields were cleared programmatically (no 'input' event fires), so
      // hide the save button ourselves rather than waiting on the listener.
      if (btn) btn.style.display = 'none';
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

  const btn = document.getElementById('pi-save-btn')
    || document.querySelector('#pi-fname')?.closest('.panel')?.querySelector('.btn-red');
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

      // Saved successfully — the current field values are now the new
      // "unchanged" baseline, so re-hide the button until something else changes.
      if (window.FormChangeTracker) window.FormChangeTracker.resetProfileBaseline();

      showToast(data.message || 'Profile updated successfully.', 'success');
    })
    .catch(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'SAVE CHANGES'; }
      showToast('Could not reach the server. Please try again.', 'error');
    });
}


/* ════════════════════════════════════════════════
   5b. FORM CHANGE TRACKER
   Keeps the "Save Changes" / "Save Password" buttons
   hidden until the user has actually typed/changed
   something in the corresponding form. Used on the
   Settings tab of the admin/staff/member dashboards.
════════════════════════════════════════════════ */
const FormChangeTracker = (() => {

  const PROFILE_FIELD_IDS  = ['pi-fname', 'pi-mi', 'pi-lname', 'pi-ext', 'pi-email', 'pi-phone', 'pi-bday'];
  const PASSWORD_FIELD_IDS = ['cp-current', 'cp-new', 'cp-confirm'];

  let profileBaseline = {};

  function _fieldValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  }

  function _captureProfileBaseline() {
    profileBaseline = {};
    PROFILE_FIELD_IDS.forEach(id => { profileBaseline[id] = _fieldValue(id); });
  }

  function _profileHasChanges() {
    return PROFILE_FIELD_IDS.some(id => _fieldValue(id) !== profileBaseline[id]);
  }

  function _updateProfileButton() {
    const btn = document.getElementById('pi-save-btn');
    if (!btn) return;
    btn.style.display = _profileHasChanges() ? '' : 'none';
  }

  function _updatePasswordButton() {
    const btn = document.getElementById('cp-submit-btn');
    if (!btn) return;
    const hasInput = PASSWORD_FIELD_IDS.some(id => _fieldValue(id).length > 0);
    btn.style.display = hasInput ? '' : 'none';
  }

  /** Re-capture the profile baseline (call after a successful save) and hide the button. */
  function resetProfileBaseline() {
    _captureProfileBaseline();
    _updateProfileButton();
  }

  /** Wire up listeners for whichever of the two forms exist on this page. */
  function init() {
    if (document.getElementById('pi-save-btn') && PROFILE_FIELD_IDS.some(id => document.getElementById(id))) {
      _captureProfileBaseline();
      _updateProfileButton();
      PROFILE_FIELD_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', _updateProfileButton);
      });
    }

    if (document.getElementById('cp-submit-btn')) {
      _updatePasswordButton();
      PASSWORD_FIELD_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', _updatePasswordButton);
      });
    }
  }

  return { init, resetProfileBaseline };
})();

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
  const password       = document.getElementById('reg-pass')?.value || '';
  const confirm        = document.getElementById('reg-confirm')?.value || '';
  const termsChecked   = document.getElementById('reg-terms-check')?.checked;

  if (!first_name || !last_name || !email || !password) {
    showToast('Please fill in all required fields.', 'error');
    return;
  }
  if (phone && !/^09\d{9}$/.test(phone)) {
    showToast('Phone number must start with 09 and be exactly 11 digits.', 'error');
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

  fetch('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name, middle_initial, last_name, extension_name, email, phone, birthday, password })
  })
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (btn) { btn.disabled = false; btn.textContent = 'SUBMIT REGISTRATION'; }
      if (!ok || !data.success) {
        showToast(data.error || 'Registration failed. Please try again.', 'error');
        return;
      }
      showToast(data.message || 'Account created! Sign in to continue.', 'success');
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


/* ════════════════════════════════════════════════
   4b. CONTENT MANAGER — Manage Gym Content
   Shared by staff-dashboard.html and admin-dashboard.html.
   Lets staff/admin add/edit/delete membership plans, services,
   and equipment (name, price, description, inclusions, picture).
════════════════════════════════════════════════ */
const ContentManager = (() => {

  // "facilities" (home page Our Facilities photos) and "machines"
  // (Equipments and Machines) are two admin-facing views over the SAME
  // GymEquipment table/endpoint, split client-side by the is_facility flag —
  // this lets the dashboard offer two focused tabs without a second backend
  // model. TYPES lists every tab the UI can show; ENDPOINTS/LABELS below
  // map each one to the request it should make and its display name.
  const TYPES = ['plans', 'services', 'facilities', 'machines'];
  const ENDPOINTS = {
    plans:     { list: '/api/content/plans',     save: '/api/content/plans/save',     del: id => `/api/content/plans/${id}/delete` },
    services:  { list: '/api/content/services',  save: '/api/content/services/save',  del: id => `/api/content/services/${id}/delete` },
    equipment: { list: '/api/content/equipment', save: '/api/content/equipment/save', del: id => `/api/content/equipment/${id}/delete` },
  };
  ENDPOINTS.facilities = ENDPOINTS.equipment;
  ENDPOINTS.machines   = ENDPOINTS.equipment;
  const LABELS = { plans: 'Membership Plan', services: 'Service', facilities: 'Facility Photo', machines: 'Equipment' };
  // Which value of is_facility each tab represents, and therefore which
  // value gets saved automatically when adding/editing from that tab.
  const IS_FACILITY_TYPE = { facilities: true, machines: false };
  const DEFAULT_CATEGORY_JS = 'General'; // mirrors app.py's DEFAULT_CATEGORY, used when an item has no category set

  let currentType = 'plans';
  // cache.equipment holds the single raw list backing both the
  // "facilities" and "machines" tabs (and the Services equipment checklist);
  // it's filtered client-side per tab in _filterEquipment().
  let cache = { plans: null, services: null, equipment: null };
  let pendingDelete = null; // { type, id }
  let loaded = false;
  // Category filter for the "machines" tab only (e.g. "Free Weights",
  // "Cardio Equipment") — 'ALL' shows every machine regardless of category.
  let categoryFilter = 'ALL';

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    showType('plans');
  }

  function showType(type) {
    currentType = type;
    categoryFilter = 'ALL';
    document.querySelectorAll('.content-subtab').forEach(el => {
      el.classList.toggle('active', el.dataset.contentType === type);
    });
    TYPES.forEach(t => {
      const grid = document.getElementById('content-grid-' + t);
      if (grid) grid.style.display = (t === type) ? 'grid' : 'none';
    });
    const filterBar = document.getElementById('content-category-filters');
    if (filterBar) filterBar.style.display = (type === 'machines') ? 'flex' : 'none';
    if (type === 'facilities' || type === 'machines') {
      if (cache.equipment === null) _fetchEquipment();
      else {
        _renderGrid(type, _filterEquipment(type));
        if (type === 'machines') _renderCategoryFilters();
      }
    } else if (cache[type] === null) {
      _fetchType(type);
    } else {
      _renderGrid(type, cache[type]);
    }
  }

  // The unfiltered set of real machines/equipment (excludes facility-zone
  // photos and any category filter) — used both to render the grid and to
  // derive the list of distinct categories for the filter chips.
  function _machineList() {
    return (cache.equipment || []).filter(it => !it.is_facility);
  }

  function _filterEquipment(type) {
    const base = (cache.equipment || []).filter(it => !!it.is_facility === IS_FACILITY_TYPE[type]);
    if (type === 'machines' && categoryFilter !== 'ALL') {
      return base.filter(it => (it.category || DEFAULT_CATEGORY_JS) === categoryFilter);
    }
    return base;
  }

  function _renderCategoryFilters() {
    const bar = document.getElementById('content-category-filters');
    if (!bar) return;
    const categories = [];
    _machineList().forEach(it => {
      const cat = it.category || DEFAULT_CATEGORY_JS;
      if (!categories.includes(cat)) categories.push(cat);
    });
    if (!categories.length) { bar.innerHTML = ''; return; }
    const chips = ['ALL', ...categories];
    bar.innerHTML = chips.map(cat => `
      <button type="button" class="content-category-chip${cat === categoryFilter ? ' active' : ''}"
              onclick="ContentManager.filterByCategory('${cat.replace(/'/g, "\\'")}')">${_esc(cat === 'ALL' ? 'All' : cat)}</button>
    `).join('');
  }

  function filterByCategory(cat) {
    categoryFilter = cat;
    _renderCategoryFilters();
    _renderGrid('machines', _filterEquipment('machines'));
  }

  function _fetchType(type) {
    const grid = document.getElementById('content-grid-' + type);
    if (grid) grid.innerHTML = '<div class="content-empty">Loading…</div>';
    fetch(ENDPOINTS[type].list)
      .then(res => res.json())
      .then(data => {
        if (!data.success) { showToast(data.error || 'Could not load content.', 'error'); return; }
        cache[type] = data.items;
        if (currentType === type) _renderGrid(type, data.items);
      })
      .catch(() => showToast('Could not reach the server.', 'error'));
  }

  function _fetchEquipment() {
    const grid = document.getElementById('content-grid-' + currentType);
    if (grid) grid.innerHTML = '<div class="content-empty">Loading…</div>';
    fetch(ENDPOINTS.equipment.list)
      .then(res => res.json())
      .then(data => {
        if (!data.success) { showToast(data.error || 'Could not load content.', 'error'); return; }
        cache.equipment = data.items;
        if (currentType === 'facilities' || currentType === 'machines') {
          _renderGrid(currentType, _filterEquipment(currentType));
          if (currentType === 'machines') _renderCategoryFilters();
        }
      })
      .catch(() => showToast('Could not reach the server.', 'error'));
  }

  function refresh(type) {
    if (type === 'facilities' || type === 'machines') {
      cache.equipment = null;
      if (currentType === 'facilities' || currentType === 'machines') _fetchEquipment();
    } else {
      cache[type] = null;
      if (currentType === type) _fetchType(type);
    }
  }

  function _renderGrid(type, items) {
    const grid = document.getElementById('content-grid-' + type);
    if (!grid) return;
    if (!items.length) {
      grid.innerHTML = `<div class="content-empty">No ${LABELS[type].toLowerCase()}s yet. Click "+ Add New" to create one.</div>`;
      return;
    }
    grid.innerHTML = items.map(item => _cardHtml(type, item)).join('');
  }

  function _esc(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function _cardHtml(type, item) {
    const isPlan = type === 'plans';
    const img = item.image_path
      ? `background-image:url('/static/${item.image_path}')`
      : '';
    const fallbackIcon = isPlan ? '💳' : type === 'services' ? '🛎️' : type === 'facilities' ? '🏢' : '🏋️';
    const icon = item.image_path ? '' : (item.icon || fallbackIcon);
    const priceLine = isPlan
      ? `<div class="content-card-price">₱${Number(item.price).toLocaleString()} / ${item.duration_days} day${item.duration_days == 1 ? '' : 's'}</div>`
      : '';
    const categoryBadge = (!isPlan && item.category)
      ? `<div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);">${_esc(item.category)}</div>`
      : '';
    let inclusionsHtml = '';
    if (isPlan && item.inclusions) {
      const lines = item.inclusions.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4);
      if (lines.length) inclusionsHtml = `<ul class="content-card-inclusions">${lines.map(l => `<li>${_esc(l)}</li>`).join('')}</ul>`;
    }
    const statusBadge = item.is_active
      ? '<span class="badge badge-green">ACTIVE</span>'
      : '<span class="badge badge-muted">HIDDEN</span>';
    return `
      <div class="content-card" data-id="${item.id}">
        <div class="content-card-img" style="${img}">${img ? '' : icon}${statusBadge}</div>
        <div class="content-card-body">
          <div class="content-card-name">${_esc(item.name)}</div>
          ${categoryBadge}
          ${priceLine}
          ${item.description ? `<div class="content-card-desc">${_esc(item.description)}</div>` : ''}
          ${inclusionsHtml}
          <div class="content-card-actions">
            <button class="btn btn-outline" onclick='ContentManager.openForm("${type}", ${JSON.stringify(item).replace(/'/g, "&#39;")})'>EDIT</button>
            <button class="btn btn-outline" style="color:var(--red);border-color:rgba(230,30,37,0.4);" onclick="ContentManager.confirmDelete('${type}', ${item.id}, '${_esc(item.name).replace(/'/g, "\\'")}')">DELETE</button>
          </div>
        </div>
      </div>`;
  }

  function openForm(type, item) {
    currentType = type;
    document.getElementById('cf-type').value = type;
    document.getElementById('cf-id').value = item ? item.id : '';
    document.getElementById('content-form-title').textContent = item ? `EDIT ${LABELS[type].toUpperCase()}` : `ADD ${LABELS[type].toUpperCase()}`;
    document.getElementById('cf-description').value = item ? item.description : '';
    document.getElementById('cf-sort-order').value = item ? item.sort_order : 0;
    document.getElementById('cf-active').checked = item ? !!item.is_active : true;
    document.getElementById('cf-image-input').value = '';
    document.getElementById('cf-remove-image').checked = false;

    // Name field. Plans/Services, and editing an existing item of any
    // type, keep the classic free-text box. Adding a brand-new facility
    // or machine instead shows a picker of already-used names (with
    // rename/delete on each) — picking "+ Add New …" swaps to the
    // free-text box for a name that isn't listed yet.
    const nameLabel = document.getElementById('cf-name-label');
    const nameInput = document.getElementById('cf-name');
    if (nameLabel) {
      nameLabel.textContent = type === 'machines'    ? 'Name of Equipment/Machine'
                             : type === 'facilities'  ? 'Name of Facility/Area'
                             : 'Name';
    }
    nameInput.value = item ? item.name : '';
    const useNamePicker = !item && (type === 'facilities' || type === 'machines');
    _closePicker('name');
    const namePickerWrap = document.getElementById('cf-name-picker-wrap');
    const nameBack = document.getElementById('cf-name-toggle');
    if (useNamePicker) {
      if (namePickerWrap) namePickerWrap.style.display = '';
      nameInput.style.display = 'none';
      if (nameBack) nameBack.style.display = 'none';
      _setPickerTriggerText('name', '');
    } else {
      if (namePickerWrap) namePickerWrap.style.display = 'none';
      nameInput.style.display = '';
      if (nameBack) nameBack.style.display = 'none';
    }

    const isPlan = type === 'plans';
    document.getElementById('cf-plan-fields').style.display = isPlan ? 'grid' : 'none';
    document.getElementById('cf-inclusions-wrap').style.display = isPlan ? 'block' : 'none';
    if (isPlan) {
      document.getElementById('cf-price').value = item ? item.price : '';
      document.getElementById('cf-duration').value = item ? item.duration_days : '';
      document.getElementById('cf-inclusions').value = item ? item.inclusions : '';
    }

    // Category + icon (services & equipment only). Category is always the
    // picker (list of real, already-used categories + rename/delete +
    // "Add New") whether adding or editing — there's no reason to hide it
    // behind an extra click the way the Name picker is (Name only offers
    // it when adding new, to avoid implying you're renaming the CURRENT
    // item by picking a different existing name from the list).
    const catEqWrap = document.getElementById('cf-category-icon-wrap');
    if (catEqWrap) catEqWrap.style.display = isPlan ? 'none' : 'grid';
    const catInput  = document.getElementById('cf-category');
    const iconInput = document.getElementById('cf-icon');
    const catPickerWrap = document.getElementById('cf-category-picker-wrap');
    const catBack = document.getElementById('cf-category-toggle');
    if (!isPlan) {
      _closePicker('category');
      if (catInput) catInput.value = item ? (item.category || '') : '';
      if (catPickerWrap) catPickerWrap.style.display = '';
      if (catInput) catInput.style.display = 'none';
      if (catBack) catBack.style.display = 'none';
      _setPickerTriggerText('category', item ? (item.category || '') : '');
    }
    if (iconInput) iconInput.value = item ? (item.icon || '') : '';
    _refreshIconPicks(type);

    // Equipment/machines checklist — services only ("what to use for this
    // service", shown to members via the eye icon on their service card).
    const isService = type === 'services';
    const eqWrap = document.getElementById('cf-equipment-wrap');
    if (eqWrap) eqWrap.style.display = isService ? 'block' : 'none';
    if (isService) _renderEquipmentChecklist(item ? (item.equipment_ids || []) : []);

    // is_facility is no longer a manual checkbox — it's implied by which
    // tab (Our Facilities vs Equipments and Machines) the form was opened
    // from, and is set automatically on submit(). Kept here only in case
    // an older page still has the legacy checkbox markup.
    const facilityWrap = document.getElementById('cf-is-facility-wrap');
    if (facilityWrap) facilityWrap.style.display = 'none';

    const preview = document.getElementById('cf-image-preview');
    const removeWrap = document.getElementById('cf-remove-image-wrap');
    if (item && item.image_path) {
      preview.style.backgroundImage = `url('/static/${item.image_path}')`;
      preview.textContent = '';
      removeWrap.style.display = 'block';
    } else {
      preview.style.backgroundImage = '';
      preview.textContent = '🖼️';
      removeWrap.style.display = 'none';
    }

    openModal('content-form-modal');
  }

  function previewImage(input) {
    const preview = document.getElementById('cf-image-preview');
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      preview.style.backgroundImage = `url('${e.target.result}')`;
      preview.textContent = '';
    };
    reader.readAsDataURL(file);
  }

  // ══════════════════════════════════════════════
  // Field Picker — shared by the Category field (all types) and the Name
  // field (facilities/machines, add-new only). A dropdown of real,
  // already-used values pulled live from the server, with inline
  // rename/delete on every row and an "Add New" row that swaps to a
  // free-text box for a value that isn't listed yet. Nothing here is
  // hardcoded — the list is always whatever's actually in the database.
  // ══════════════════════════════════════════════
  const PICKER_CONFIG = {
    category: {
      manageUrl: type => `/api/content/categories/manage?type=${encodeURIComponent(type)}`,
      renameUrl: '/api/content/categories/rename',
      deleteUrl: '/api/content/categories/delete',
      addLabel: () => '+ Add New Category…',
      placeholder: () => 'Select or add a category…',
      freeformPlaceholder: () => 'e.g. Boxing, Strengthening',
      deleteWarning: (name, count) => `Remove "${name}" from ${count} item${count === 1 ? '' : 's'}? They'll fall back to "General".`,
    },
    name: {
      manageUrl: type => `/api/content/names/manage?type=${encodeURIComponent(type)}`,
      renameUrl: '/api/content/names/rename',
      deleteUrl: '/api/content/names/delete',
      addLabel: type => type === 'facilities' ? '+ Add New Facility/Area…' : '+ Add New Equipment/Machine…',
      placeholder: type => type === 'facilities' ? 'Select a facility/area…' : 'Select equipment or a machine…',
      freeformPlaceholder: () => '',
      deleteWarning: (name, count) => `Delete "${name}"? This permanently deletes ${count} item${count === 1 ? '' : 's'} named this — it cannot be undone.`,
    },
  };
  let pickerOpenField = null;              // 'category' | 'name' | null — which picker panel is currently open
  const pickerItems = { category: [], name: [] }; // last-fetched [{name,count}] for whichever field is open
  const pickerMode = { category: 'idle', name: 'idle' };       // 'idle' | 'rename' | 'delete'
  const pickerModeTarget = { category: null, name: null };     // the row name currently being renamed/deleted

  function _pickerEls(field) {
    return {
      wrap:        document.getElementById(`cf-${field}-picker-wrap`),
      triggerText: document.getElementById(`cf-${field}-trigger-text`),
      panel:       document.getElementById(`cf-${field}-panel`),
      input:       document.getElementById(`cf-${field}`),
      backWrap:    document.getElementById(`cf-${field}-toggle`),
    };
  }

  function _setPickerTriggerText(field, value) {
    const els = _pickerEls(field);
    if (els.triggerText) els.triggerText.textContent = value || PICKER_CONFIG[field].placeholder(currentType);
  }

  function togglePicker(field, ev) {
    if (ev) ev.stopPropagation();
    if (pickerOpenField === field) { _closePicker(field); return; }
    if (pickerOpenField) _closePicker(pickerOpenField);
    pickerOpenField = field;
    pickerMode[field] = 'idle';
    pickerModeTarget[field] = null;
    pickerItems[field] = [];
    const els = _pickerEls(field);
    if (els.panel) {
      // The content-form-modal scrolls internally (overflow-y:auto), which
      // would otherwise clip a plain absolutely-positioned dropdown once
      // the field scrolls near the bottom. Fixed positioning computed from
      // the trigger's live screen position escapes that clipping.
      const trigger = els.wrap ? els.wrap.querySelector('.picker-select') : null;
      if (trigger) {
        const rect = trigger.getBoundingClientRect();
        els.panel.style.position = 'fixed';
        els.panel.style.top = `${rect.bottom + 6}px`;
        els.panel.style.left = `${rect.left}px`;
        els.panel.style.width = `${rect.width}px`;
      }
      els.panel.style.display = 'block';
      els.panel.innerHTML = '<div class="picker-empty">Loading…</div>';
    }
    _fetchPickerItems(field);
  }

  function _closePicker(field) {
    const els = _pickerEls(field);
    if (els.panel) { els.panel.style.display = 'none'; els.panel.innerHTML = ''; }
    if (pickerOpenField === field) pickerOpenField = null;
  }

  // Fixed-position panels don't move with the modal's internal scroll or a
  // window resize, so just close them rather than let them drift.
  document.addEventListener('scroll', () => { if (pickerOpenField) _closePicker(pickerOpenField); }, true);
  window.addEventListener('resize', () => { if (pickerOpenField) _closePicker(pickerOpenField); });

  function _fetchPickerItems(field) {
    const type = currentType;
    const cfg = PICKER_CONFIG[field];
    fetch(cfg.manageUrl(type))
      .then(res => res.json())
      .then(data => {
        if (!data.success) { showToast(data.error || 'Could not load list.', 'error'); return; }
        pickerItems[field] = field === 'category' ? data.categories : data.names;
        if (pickerOpenField === field) _renderPickerPanel(field);
      })
      .catch(() => {
        if (pickerOpenField === field) {
          const els = _pickerEls(field);
          if (els.panel) els.panel.innerHTML = '<div class="picker-empty">Could not reach the server.</div>';
        }
      });
  }

  function _renderPickerPanel(field) {
    const els = _pickerEls(field);
    if (!els.panel) return;
    const cfg = PICKER_CONFIG[field];
    const items = pickerItems[field] || [];
    const mode = pickerMode[field];
    const target = pickerModeTarget[field];
    let rowsHtml = items.length ? '' : '<div class="picker-empty">Nothing yet — add one below.</div>';
    rowsHtml += items.map(it => {
      if (mode === 'rename' && target === it.name) {
        return `
          <div class="picker-row picker-row-editing">
            <input class="form-input" id="picker-inline-input" value="${_esc(it.name)}">
            <button type="button" class="picker-row-btn" onclick="event.stopPropagation();ContentManager.submitPickerRename('${field}','${_jsStr(it.name)}')" title="Save">✓</button>
            <button type="button" class="picker-row-btn" onclick="event.stopPropagation();ContentManager.cancelPickerAction('${field}')" title="Cancel">✕</button>
          </div>`;
      }
      if (mode === 'delete' && target === it.name) {
        return `
          <div class="picker-row picker-row-editing">
            <div class="picker-row-warning">${_esc(cfg.deleteWarning(it.name, it.count))}</div>
            <button type="button" class="picker-row-btn picker-row-btn-danger" onclick="event.stopPropagation();ContentManager.submitPickerDelete('${field}','${_jsStr(it.name)}')" title="Confirm">✓</button>
            <button type="button" class="picker-row-btn" onclick="event.stopPropagation();ContentManager.cancelPickerAction('${field}')" title="Cancel">✕</button>
          </div>`;
      }
      return `
        <div class="picker-row" onclick="ContentManager.selectPickerValue('${field}','${_jsStr(it.name)}')">
          <span class="picker-row-label">${_esc(it.name)}</span>
          <span class="picker-row-count">${it.count}</span>
          <button type="button" class="picker-row-btn" onclick="event.stopPropagation();ContentManager.startPickerRename('${field}','${_jsStr(it.name)}')" title="Rename">✎</button>
          <button type="button" class="picker-row-btn picker-row-btn-danger" onclick="event.stopPropagation();ContentManager.startPickerDelete('${field}','${_jsStr(it.name)}')" title="Delete">🗑</button>
        </div>`;
    }).join('');
    rowsHtml += `<div class="picker-add-row" onclick="ContentManager.pickerAddNew('${field}')">${_esc(cfg.addLabel(currentType))}</div>`;
    els.panel.innerHTML = rowsHtml;
    if (mode === 'rename') {
      const inp = document.getElementById('picker-inline-input');
      if (inp) { inp.focus(); inp.select(); }
    }
  }

  function selectPickerValue(field, name) {
    const els = _pickerEls(field);
    if (els.input) els.input.value = name;
    _setPickerTriggerText(field, name);
    _closePicker(field);
  }

  function startPickerRename(field, name) { pickerMode[field] = 'rename'; pickerModeTarget[field] = name; _renderPickerPanel(field); }
  function startPickerDelete(field, name) { pickerMode[field] = 'delete'; pickerModeTarget[field] = name; _renderPickerPanel(field); }
  function cancelPickerAction(field) { pickerMode[field] = 'idle'; pickerModeTarget[field] = null; _renderPickerPanel(field); }

  function submitPickerRename(field, oldName) {
    const inp = document.getElementById('picker-inline-input');
    const newName = inp ? inp.value.trim() : '';
    if (!newName) { showToast('Name cannot be empty.', 'error'); return; }
    const type = currentType;
    fetch(PICKER_CONFIG[field].renameUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, old_name: oldName, new_name: newName })
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) { showToast((data && data.error) || 'Could not rename.', 'error'); return; }
        showToast(data.message || 'Renamed.', 'success');
        pickerMode[field] = 'idle'; pickerModeTarget[field] = null;
        const els = _pickerEls(field);
        if (els.input && els.input.value === oldName) { els.input.value = newName; _setPickerTriggerText(field, newName); }
        _fetchPickerItems(field);
        refresh(type); // reload the grid/filter chips behind the modal so they reflect the rename immediately
      })
      .catch(() => showToast('Could not reach the server.', 'error'));
  }

  function submitPickerDelete(field, name) {
    const type = currentType;
    fetch(PICKER_CONFIG[field].deleteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, name })
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) { showToast((data && data.error) || 'Could not delete.', 'error'); return; }
        showToast(data.message || 'Deleted.', 'success');
        pickerMode[field] = 'idle'; pickerModeTarget[field] = null;
        const els = _pickerEls(field);
        if (els.input && els.input.value === name) { els.input.value = ''; _setPickerTriggerText(field, ''); }
        _fetchPickerItems(field);
        refresh(type);
      })
      .catch(() => showToast('Could not reach the server.', 'error'));
  }

  /** "+ Add New …" row — swaps the picker for a free-text box so staff can
   *  type a value that isn't on the list yet. */
  function pickerAddNew(field) {
    _closePicker(field);
    const els = _pickerEls(field);
    if (els.wrap) els.wrap.style.display = 'none';
    if (els.input) {
      els.input.style.display = '';
      els.input.value = '';
      els.input.placeholder = PICKER_CONFIG[field].freeformPlaceholder(currentType);
      els.input.focus();
    }
    if (els.backWrap) els.backWrap.style.display = 'block';
  }

  /** "← Choose from list instead" link — swaps back from the free-text
   *  box to the picker. */
  function pickerBackToList(field) {
    const els = _pickerEls(field);
    if (els.input) els.input.style.display = 'none';
    if (els.wrap) els.wrap.style.display = '';
    if (els.backWrap) els.backWrap.style.display = 'none';
    _setPickerTriggerText(field, els.input ? els.input.value : '');
  }

  // Escapes a string for safe embedding inside a single-quoted JS string
  // literal within inline onclick="" HTML attributes above.
  function _jsStr(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  // Close any open picker panel when clicking anywhere outside it.
  document.addEventListener('click', e => {
    if (!pickerOpenField) return;
    const wrap = document.getElementById(`cf-${pickerOpenField}-picker-wrap`);
    if (wrap && !wrap.contains(e.target)) _closePicker(pickerOpenField);
  });

  // ── Icon quick-pick (services & equipment) ──
  const ICON_SUGGESTIONS = {
    machines:   ['🏋️', '💪', '🥊', '🏃', '🚴', '🤸', '🪢', '🦵', '🔩', '⬇️', '🔧', '🎯', '🧘', '🔥'],
    services:   ['🥊', '💪', '🔥', '🏃', '🛎️', '🧑‍🏫', '🥤', '🚿', '🅿️', '📅', '🩺'],
    facilities: ['🏢', '🚪', '🏋️', '🧘', '🚿', '🅿️', '🛎️', '🔥'],
  };

  function _refreshIconPicks(type) {
    const iconRow = document.getElementById('cf-icon-picks');
    if (iconRow) {
      const icons = ICON_SUGGESTIONS[type] || [];
      iconRow.innerHTML = icons.map(i =>
        `<button type="button" class="icon-pick-btn" onclick="ContentManager.pickIcon('${i}')">${i}</button>`
      ).join('');
    }
  }

  function pickIcon(emoji) {
    const iconInput = document.getElementById('cf-icon');
    if (iconInput) iconInput.value = emoji;
  }

  // ── Equipment checklist (Services form only) ──
  function _renderEquipmentChecklist(checkedIds) {
    const list = document.getElementById('cf-equipment-list');
    if (!list) return;
    const checked = new Set((checkedIds || []).map(String));
    const render = (allItems) => {
      // Facility-zone photos (Weight Area, Reception, etc.) aren't real
      // machines, so they don't belong in a service's equipment list.
      const items = allItems.filter(eq => !eq.is_facility);
      if (!items.length) {
        list.innerHTML = '<div style="font-size:13px;color:var(--muted);">No equipment set up yet — add some under the Equipment tab first.</div>';
        return;
      }
      list.innerHTML = items.map(eq => `
        <label style="display:flex;align-items:center;gap:6px;font-size:15px;color:var(--white);cursor:pointer;background:rgba(255,255,255,0.04);padding:6px 10px;border-radius:6px;">
          <input type="checkbox" class="cf-equipment-check" value="${eq.id}" ${checked.has(String(eq.id)) ? 'checked' : ''}>
          <span>${eq.icon || '🏋️'} ${_esc(eq.name)}</span>
        </label>`).join('');
    };
    if (cache.equipment !== null) {
      render(cache.equipment);
    } else {
      list.innerHTML = '<div style="font-size:13px;color:var(--muted);">Loading equipment…</div>';
      fetch(ENDPOINTS.equipment.list)
        .then(res => res.json())
        .then(data => {
          if (!data.success) { list.innerHTML = '<div style="font-size:13px;color:var(--muted);">Could not load equipment.</div>'; return; }
          cache.equipment = data.items;
          render(data.items);
        })
        .catch(() => { list.innerHTML = '<div style="font-size:13px;color:var(--muted);">Could not reach the server.</div>'; });
    }
  }

  function submit() {
    const type = document.getElementById('cf-type').value;
    const id = document.getElementById('cf-id').value;

    // cf-name is the single source of truth whether it was filled by
    // typing (classic free-text box) or by picking from the Name picker
    // (facilities/machines add-new) — the picker writes into it directly.
    const name = _val('cf-name');
    if (!name) { showToast('Name is required.', 'error'); return; }

    const fd = new FormData();
    if (id) fd.append('id', id);
    fd.append('name', name);
    fd.append('description', document.getElementById('cf-description').value.trim());
    fd.append('sort_order', document.getElementById('cf-sort-order').value || '0');
    fd.append('is_active', document.getElementById('cf-active').checked ? 'true' : 'false');
    fd.append('remove_image', document.getElementById('cf-remove-image').checked ? 'true' : 'false');
    const file = document.getElementById('cf-image-input').files[0];
    if (file) fd.append('image', file);

    if (type !== 'plans') {
      const catInput  = document.getElementById('cf-category');
      const iconInput = document.getElementById('cf-icon');
      fd.append('category', catInput ? catInput.value.trim() : '');
      fd.append('icon', iconInput ? iconInput.value.trim() : '');
    }

    if (type === 'services') {
      document.querySelectorAll('.cf-equipment-check:checked').forEach(cb => fd.append('equipment_ids', cb.value));
    }
    if (type === 'facilities' || type === 'machines') {
      // Determined by which tab the form was opened from, not a manual checkbox.
      fd.append('is_facility', IS_FACILITY_TYPE[type] ? 'true' : 'false');
    }

    if (type === 'plans') {
      const price = document.getElementById('cf-price').value;
      const duration = document.getElementById('cf-duration').value;
      if (!price || Number(price) < 0) { showToast('Enter a valid price.', 'error'); return; }
      if (!duration || Number(duration) <= 0) { showToast('Enter a valid duration in days.', 'error'); return; }
      fd.append('price', price);
      fd.append('duration_days', duration);
      fd.append('inclusions', document.getElementById('cf-inclusions').value);
    }

    fetch(ENDPOINTS[type].save, { method: 'POST', body: fd })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) { showToast(data.error || 'Could not save.', 'error'); return; }
        showToast(data.message || 'Saved.', 'success');
        closeModal('content-form-modal');
        refresh(type);
      })
      .catch(() => showToast('Could not reach the server.', 'error'));
  }

  function confirmDelete(type, id, name) {
    pendingDelete = { type, id };
    const msgEl = document.getElementById('content-delete-message');
    if (msgEl) msgEl.textContent = `Are you sure you want to delete "${name}"? This cannot be undone.`;
    openModal('content-delete-modal');
  }

  function cancelDelete() {
    pendingDelete = null;
    closeModal('content-delete-modal');
  }

  function performDelete() {
    if (!pendingDelete) return;
    const { type, id } = pendingDelete;
    fetch(ENDPOINTS[type].del(id), { method: 'POST' })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.success) { showToast((data && data.error) || 'Could not delete.', 'error'); return; }
        showToast(data.message || 'Deleted.', 'success');
        refresh(type);
      })
      .catch(() => showToast('Could not reach the server.', 'error'))
      .finally(() => { pendingDelete = null; closeModal('content-delete-modal'); });
  }

  return {
    ensureLoaded, showType, openForm, previewImage, pickIcon, submit, confirmDelete, cancelDelete, performDelete,
    refresh, filterByCategory,
    togglePicker, selectPickerValue, startPickerRename, startPickerDelete, cancelPickerAction,
    submitPickerRename, submitPickerDelete, pickerAddNew, pickerBackToList,
  };
})();


/* ════════════════════════════════════════════════
   5. TOAST SYSTEM
════════════════════════════════════════════════ */
function showToast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast       = document.createElement('div');
  toast.className   = 'toast' + (type === 'error' ? ' error' : type === 'info' ? ' info' : '');
  toast.innerHTML   = (type === 'success' ? '✓ ' : type === 'info' ? 'ℹ ' : '✗ ') + msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3100);
}

/** Toast the receiver about announcement(s) posted since their last visit.
 *  Shared by the member and staff dashboards — `items` comes from the
 *  server's new_announcements list (already scoped to their target
 *  audience and de-duped against what they've already seen). Shows one
 *  "Notice from the Admin" message box at a time; if there's more than
 *  one, the button reads "NEXT" and cycles through the rest. */
let _announcementNoticeQueue = [];
let _announcementNoticeTotal = 0;

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
  window.openModal     = openModal;
  window.closeModal    = closeModal;
  window.openTermsModal = openTermsModal;
  window.showToast     = showToast;
  window.showNewAnnouncementNotices = showNewAnnouncementNotices;
  window.closeAnnouncementNoticeModal = closeAnnouncementNoticeModal;
  window.buildAttGrid  = buildAttGrid;
  window.doLogout      = doLogout;
  window.verifyPayment = verifyPayment;
  window.confirmVerifyPayment = confirmVerifyPayment;
  window.cancelVerifyPayment = cancelVerifyPayment;
  window.submitChangePassword = submitChangePassword;
  window.submitProfileUpdate  = submitProfileUpdate;
  window.completeRegistration = completeRegistration;
  window.filterTable   = filterTable;
  window.togglePasswordVisibility = togglePasswordVisibility;
  window.ContentManager = ContentManager;
  window.goTo          = (screen) => Navigation.goToScreen(screen);
  // selectPlan is re-assigned per page (login/member) where relevant; keep a fallback
  if (!window.selectPlan) window.selectPlan = selectPlan;

  window.FormChangeTracker = FormChangeTracker;
  FormChangeTracker.init();
});