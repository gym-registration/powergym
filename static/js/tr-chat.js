/* ═══════════════════════════════════════════════════════════════
   POWER GYM — Member AI Chat Box
   tr-chat.js  |  Runs on member-dashboard.html only

   Self-contained: builds its own floating button + chat panel, talks to
   POST /member/ai-chat (see gym_ai.py) and needs nothing from
   tr-common.js / tr-member.js, so it can't interfere with them.

   The conversation lives only in this page's memory: it is gone when the
   page reloads or the member signs out, so nothing personal is left behind
   on a shared computer.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var ENDPOINT      = '/member/ai-chat';
  var MAX_CHARS     = 500;      // keep in sync with MAX_MESSAGE_CHARS in gym_ai.py
  var HISTORY_TURNS = 8;        // keep in sync with MAX_HISTORY_TURNS in gym_ai.py
  var TIMEOUT_MS    = 40000;

  var SUGGESTIONS = [
    'What plans do you offer?',
    'When does my membership expire?',
    'Who are the coaches and when are they available?',
    'What equipment do you have?',
    'How many times did I visit this month?',
    'What are the gym rules?'
  ];

  var ICONS = {
    chat:  '<svg class="gc-ico-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.6-.8L3 21l1.9-5.1A8.4 8.4 0 1 1 21 11.5Z"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" stroke-width="2.6"/></svg>',
    close: '<svg class="gc-ico-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    bot:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    x:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    send:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
  };

  function boot() {
    if (window.__gymChatLoaded) return;
    if (!document.getElementById('member-dashboard-root')) return;   // member dashboard only
    window.__gymChatLoaded = true;

    var state = { open: false, busy: false, history: [] };
    var el = {};
    var DASHBOARD_PANEL_ID = 'member-overview'; // the chat only shows while this sub-panel is active

    /* ── Build the DOM ─────────────────────────────────────── */
    document.body.classList.add('gc-on');
    document.body.insertAdjacentHTML('beforeend',
      '<button type="button" class="gc-launcher" id="gc-launcher" aria-label="Open Gym Assistant chat" aria-expanded="false" aria-controls="gc-panel">' +
        ICONS.chat + ICONS.close + '<span class="gc-launcher-tag">AI</span>' +
      '</button>' +
      '<section class="gc-panel" id="gc-panel" role="dialog" aria-labelledby="gc-title" aria-modal="false">' +
        '<header class="gc-header">' +
          '<div class="gc-avatar">' + ICONS.bot + '</div>' +
          '<div class="gc-head-text">' +
            '<div class="gc-title" id="gc-title">GYM ASSISTANT</div>' +
            '<div class="gc-sub"><span class="gc-dot"></span>AI · gym records only</div>' +
          '</div>' +
          '<button type="button" class="gc-icon-btn" id="gc-reset" aria-label="Start a new chat" title="New chat">' + ICONS.reset + '</button>' +
          '<button type="button" class="gc-icon-btn" id="gc-x" aria-label="Close chat" title="Close">' + ICONS.x + '</button>' +
        '</header>' +
        '<div class="gc-messages" id="gc-messages" role="log" aria-live="polite" aria-relevant="additions"></div>' +
        '<div class="gc-composer">' +
          '<div class="gc-row">' +
            '<textarea class="gc-input" id="gc-input" rows="1" maxlength="' + MAX_CHARS + '" placeholder="Type your question…" aria-label="Your question"></textarea>' +
            '<button type="button" class="gc-send" id="gc-send" aria-label="Send message" disabled>' + ICONS.send + '</button>' +
          '</div>' +
          '<div class="gc-foot"><span>AI can make mistakes. Confirm important details with the front desk.</span><span class="gc-count" id="gc-count"></span></div>' +
        '</div>' +
      '</section>'
    );

    ['launcher', 'panel', 'messages', 'input', 'send', 'count', 'reset', 'x'].forEach(function (id) {
      el[id] = document.getElementById('gc-' + id);
    });

    /* ── Helpers ───────────────────────────────────────────── */
    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    // Escape FIRST, then add only our own tags — model output can never inject HTML.
    function inline(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); }

    function renderRich(text) {
      var html = '', list = null;
      String(text).replace(/\r/g, '').split('\n').forEach(function (raw) {
        var ul = raw.match(/^\s*[-*•]\s+(.*)$/);
        var ol = raw.match(/^\s*\d+[.)]\s+(.*)$/);
        var kind = ul ? 'ul' : ol ? 'ol' : null;
        if (kind) {
          if (list !== kind) { if (list) html += '</' + list + '>'; html += '<' + kind + '>'; list = kind; }
          html += '<li>' + inline((ul || ol)[1]) + '</li>';
          return;
        }
        if (list) { html += '</' + list + '>'; list = null; }
        var line = raw.trim().replace(/^#{1,6}\s+/, '');
        if (line) html += '<p>' + inline(line) + '</p>';
      });
      if (list) html += '</' + list + '>';
      return html;
    }

    function timeNow() {
      return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    function scrollDown() { el.messages.scrollTop = el.messages.scrollHeight; }
    function firstName() {
      var n = (document.getElementById('sidebar-user-name') || {}).textContent || '';
      return n.trim().split(/\s+/)[0] || 'there';
    }

    function addMessage(role, text, opts) {
      opts = opts || {};
      var wrap = document.createElement('div');
      wrap.className = 'gc-msg ' + (role === 'user' ? 'gc-user' : 'gc-bot') + (opts.error ? ' gc-err' : '');
      var bubble = document.createElement('div');
      bubble.className = 'gc-bubble';
      if (role === 'user') bubble.textContent = text;
      else bubble.innerHTML = renderRich(text);
      wrap.appendChild(bubble);
      if (opts.retry) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'gc-retry'; b.textContent = 'Try again';
        b.addEventListener('click', function () { if (!state.busy) { wrap.remove(); submit(opts.retry, true); } });
        wrap.appendChild(b);
      } else if (!opts.noTime) {
        var t = document.createElement('div');
        t.className = 'gc-time'; t.textContent = timeNow();
        wrap.appendChild(t);
      }
      el.messages.appendChild(wrap);
      scrollDown();
      return wrap;
    }

    function addTyping() {
      var w = document.createElement('div');
      w.className = 'gc-msg gc-bot gc-typing';
      w.setAttribute('aria-label', 'Assistant is typing');
      w.innerHTML = '<div class="gc-bubble"><i></i><i></i><i></i></div>';
      el.messages.appendChild(w);
      scrollDown();
      return w;
    }

    function showChips() {
      if (document.getElementById('gc-chips')) return;
      var box = document.createElement('div');
      box.className = 'gc-chips'; box.id = 'gc-chips';
      SUGGESTIONS.forEach(function (q) {
        var c = document.createElement('button');
        c.type = 'button'; c.className = 'gc-chip'; c.textContent = q;
        c.addEventListener('click', function () { submit(q); });
        box.appendChild(c);
      });
      el.messages.appendChild(box);
      scrollDown();
    }
    function hideChips() {
      var c = document.getElementById('gc-chips');
      if (c) c.remove();
    }

    function welcome() {
      el.messages.innerHTML = '';
      addMessage('bot',
        'Hi ' + firstName() + '! 👋 I\'m the Power Gym assistant. I answer from the gym\'s own records — ' +
        'plans, promos, coaches, equipment, your membership, attendance and more.\n\nWhat would you like to know?',
        { noTime: true });
      showChips();
    }

    /* ── Composer state ────────────────────────────────────── */
    function refreshComposer() {
      var len = el.input.value.length;
      el.send.disabled = state.busy || !el.input.value.trim();
      el.count.textContent = len + '/' + MAX_CHARS;
      el.count.classList.toggle('gc-show', len >= MAX_CHARS - 100);
      el.count.classList.toggle('gc-max', len >= MAX_CHARS);
    }
    function autoGrow() {
      el.input.style.height = 'auto';
      el.input.style.height = Math.min(el.input.scrollHeight, 112) + 'px';
    }
    function setBusy(b) {
      state.busy = b;
      el.input.disabled = b;
      refreshComposer();
      if (!b && state.open) el.input.focus();
    }

    /* ── Talking to the server ─────────────────────────────── */
    function fetchJson(body) {
      var ctl = ('AbortController' in window) ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT_MS);
      return fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          return { status: res.status, ok: res.ok, data: data };
        });
      }).then(function (r) { clearTimeout(timer); return r; },
              function (e) { clearTimeout(timer); throw e; });
    }

    function submit(text, isRetry) {
      text = String(text == null ? el.input.value : text).trim();
      if (!text || state.busy) return;
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

      hideChips();
      if (!isRetry) addMessage('user', text);
      el.input.value = ''; autoGrow();

      var prior = state.history.slice(-HISTORY_TURNS);   // previous turns only — the server adds the new question
      setBusy(true);
      var typing = addTyping();

      fetchJson({ message: text, history: prior }).then(function (r) {
        typing.remove();
        if (r.ok && r.data && r.data.success && r.data.reply) {
          state.history.push({ role: 'user', content: text }, { role: 'assistant', content: r.data.reply });
          addMessage('bot', r.data.reply);
        } else {
          var msg = (r.data && r.data.error) ||
            (r.status === 401 ? 'Your session has expired. Please refresh the page and sign in again.'
                              : 'Something went wrong. Please try again.');
          addMessage('bot', msg, { error: true, retry: r.status === 401 ? null : text });
        }
      }).catch(function (e) {
        typing.remove();
        addMessage('bot', e && e.name === 'AbortError'
          ? 'That took too long. Please try again.'
          : 'I could not reach the server. Check your connection and try again.',
          { error: true, retry: text });
      }).then(function () { setBusy(false); });
    }

    /* ── Open / close ──────────────────────────────────────── */
    function setOpen(open) {
      state.open = open;
      el.panel.classList.toggle('gc-open', open);
      el.launcher.classList.toggle('gc-open', open);
      el.launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
      el.launcher.setAttribute('aria-label', open ? 'Close Gym Assistant chat' : 'Open Gym Assistant chat');
      if (open) { scrollDown(); setTimeout(function () { el.input.focus(); }, 60); }
    }

    function newChat() {
      if (state.busy) return;
      state.history = [];
      welcome();
      el.input.focus();
    }

    /* ── Events ────────────────────────────────────────────── */
    el.launcher.addEventListener('click', function () { setOpen(!state.open); });
    el.x.addEventListener('click', function () { setOpen(false); el.launcher.focus(); });
    el.reset.addEventListener('click', newChat);
    el.send.addEventListener('click', function () { submit(); });
    el.input.addEventListener('input', function () { autoGrow(); refreshComposer(); });
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.open) {
        // don't fight an open modal (they close on their own Escape/backdrop)
        if (document.querySelector('.modal-overlay.open')) return;
        setOpen(false); el.launcher.focus();
      }
    });

    welcome();
    refreshComposer();
    window.GymChat = { open: function () { setOpen(true); }, close: function () { setOpen(false); } };

    /* ── Restrict the widget to the Overview (dashboard) tab ──
       The member area is a single page whose sections (Overview, My
       Membership, Payment, My Attendance, etc.) are just divs toggled
       with a .sub-panel.active class — there's no real navigation, so
       without this the launcher would stay stuck on screen everywhere.
       We watch that class and show/hide the whole widget to match,
       force-closing the panel if the member navigates away mid-chat. */
    function syncVisibilityToDashboardTab() {
      var dash = document.getElementById(DASHBOARD_PANEL_ID);
      var onDashboard = !!(dash && dash.classList.contains('active'));
      el.launcher.classList.toggle('gc-hidden', !onDashboard);
      el.panel.classList.toggle('gc-hidden', !onDashboard);
      if (!onDashboard && state.open) setOpen(false);
    }
    syncVisibilityToDashboardTab();
    var panelsRoot = document.getElementById('member-dashboard-root') || document.body;
    new MutationObserver(syncVisibilityToDashboardTab)
      .observe(panelsRoot, { attributes: true, attributeFilter: ['class'], subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();