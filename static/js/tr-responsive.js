/* ═══════════════════════════════════════════════════════════════
   POWER GYM — tr-responsive.js
   Adds the mobile/tablet behaviour that tr-responsive.css styles:
     1. Dashboard drawer sidebar + sticky top bar (admin / staff / member)
     2. Tables → labelled cards on phones (data-label from <th>)
     3. Hamburger menu on the public home page
   Standalone: does not depend on or modify tr-common.js / tr-*.js.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var TABLET_MQ = window.matchMedia('(max-width: 1024px)');
  var SITE_MQ   = window.matchMedia('(max-width: 860px)');

  /* ───────── 1. Dashboard drawer ───────── */
  function initDashboard() {
    var layout  = document.querySelector('.dashboard-layout');
    var sidebar = layout && layout.querySelector('.sidebar');
    if (!layout || !sidebar || layout.dataset.trResponsive) return;
    layout.dataset.trResponsive = '1';

    if (!sidebar.id) sidebar.id = 'tr-sidebar';

    // Pull brand + role from the existing sidebar so it stays in sync
    var logoImg  = sidebar.querySelector('.sidebar-logo img');
    var roleEl   = sidebar.querySelector('.sidebar-role');
    var roleText = roleEl ? roleEl.textContent.trim() : 'Power Gym';

    // Top bar
    var bar = document.createElement('header');
    bar.className = 'tr-mobile-bar';
    bar.innerHTML =
      '<button type="button" class="tr-burger" aria-label="Open menu" aria-expanded="false" aria-controls="' + sidebar.id + '">' +
        '<span></span><span></span><span></span></button>' +
      '<div class="tr-bar-brand">' +
        (logoImg ? '<img alt="Power Gym" src="' + logoImg.getAttribute('src') + '">' : '') +
        '<div class="tr-bar-text"><span class="tr-bar-role"></span><span class="tr-bar-title"></span></div>' +
      '</div>';
    bar.querySelector('.tr-bar-role').textContent = roleText;
    layout.insertBefore(bar, sidebar);

    // Overlay + close button
    var overlay = document.createElement('div');
    overlay.className = 'tr-drawer-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    document.body.appendChild(overlay);

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tr-sidebar-close';
    closeBtn.setAttribute('aria-label', 'Close menu');
    closeBtn.innerHTML = '&times;';
    sidebar.insertBefore(closeBtn, sidebar.firstChild);

    var burger = bar.querySelector('.tr-burger');
    var titleEl = bar.querySelector('.tr-bar-title');

    function isOpen() { return sidebar.classList.contains('mobile-open'); }

    function openDrawer() {
      sidebar.classList.add('mobile-open');
      overlay.classList.add('show');
      document.body.classList.add('tr-no-scroll');
      burger.setAttribute('aria-expanded', 'true');
      burger.setAttribute('aria-label', 'Close menu');
      var first = sidebar.querySelector('.nav-item.active') || sidebar.querySelector('.nav-item');
      if (first) { first.setAttribute('tabindex', '0'); try { first.focus({ preventScroll: true }); } catch (e) {} }
    }
    function closeDrawer(returnFocus) {
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('show');
      document.body.classList.remove('tr-no-scroll');
      burger.setAttribute('aria-expanded', 'false');
      burger.setAttribute('aria-label', 'Open menu');
      if (returnFocus) { try { burger.focus({ preventScroll: true }); } catch (e) {} }
    }

    burger.addEventListener('click', function () { isOpen() ? closeDrawer(true) : openDrawer(); });
    closeBtn.addEventListener('click', function () { closeDrawer(true); });
    overlay.addEventListener('click', function () { closeDrawer(true); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) closeDrawer(true);
    });

    // Picking a tab closes the drawer (nav items use inline onclick, so listen by delegation)
    sidebar.addEventListener('click', function (e) {
      if (e.target.closest('.nav-item') && TABLET_MQ.matches) {
        setTimeout(function () { closeDrawer(false); window.scrollTo(0, 0); }, 60);
      }
    });

    // Keyboard support for the div-based nav items
    sidebar.querySelectorAll('.nav-item').forEach(function (n) {
      if (!n.hasAttribute('role')) n.setAttribute('role', 'button');
      if (!n.hasAttribute('tabindex')) n.setAttribute('tabindex', '0');
      n.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); n.click(); }
      });
    });

    // Reset when resizing up to laptop/desktop
    var onMQ = function () { if (!TABLET_MQ.matches) closeDrawer(false); };
    TABLET_MQ.addEventListener ? TABLET_MQ.addEventListener('change', onMQ) : TABLET_MQ.addListener(onMQ);

    // Show the active tab name in the bar
    function syncTitle() {
      var active = sidebar.querySelector('.nav-item.active');
      if (!active) { titleEl.textContent = ''; return; }
      // drop the emoji icon span, keep the label
      var clone = active.cloneNode(true);
      var ic = clone.querySelector('.nav-icon'); if (ic) ic.remove();
      var badges = clone.querySelectorAll('.nav-badge, .badge'); badges.forEach(function (b) { b.remove(); });
      titleEl.textContent = clone.textContent.replace(/\s+/g, ' ').trim();
    }
    syncTitle();
    new MutationObserver(syncTitle).observe(sidebar, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  /* ───────── 2. Tables ───────── */
  var MAX_STACK_COLS = 8;
  var tableObserver = null;
  var tableQueued = false;

  function enhanceTables() {
    tableQueued = false;
    if (tableObserver) tableObserver.disconnect();

    document.querySelectorAll('.main-content table, .dashboard-layout table').forEach(function (table) {
      // header labels
      var ths = table.querySelectorAll('thead th');
      var labels = Array.prototype.map.call(ths, function (th) { return th.textContent.replace(/\s+/g, ' ').trim(); });
      var cols = labels.length;

      if (cols) {
        table.querySelectorAll('tbody tr').forEach(function (tr) {
          var tds = tr.children;
          for (var i = 0; i < tds.length; i++) {
            var td = tds[i];
            if (td.tagName !== 'TD' || td.hasAttribute('colspan')) continue;
            if (labels[i] && td.getAttribute('data-label') !== labels[i]) td.setAttribute('data-label', labels[i]);
          }
        });
      }

      // Narrow tables become cards on phones; wide ones scroll horizontally
      var stackable = cols > 0 && cols <= MAX_STACK_COLS && !table.classList.contains('no-stack');
      table.classList.toggle('tr-stack', stackable);

      // scroll wrapper
      var p = table.parentElement;
      if (p && !p.classList.contains('tr-table-scroll')) {
        var wrap = document.createElement('div');
        wrap.className = 'tr-table-scroll';
        p.insertBefore(wrap, table);
        wrap.appendChild(table);
      }
    });

    watchTables();
  }

  function queueEnhance() {
    if (tableQueued) return;
    tableQueued = true;
    (window.requestAnimationFrame || setTimeout)(enhanceTables);
  }

  function watchTables() {
    var root = document.querySelector('.dashboard-layout');
    if (!root) return;
    if (!tableObserver) tableObserver = new MutationObserver(queueEnhance);
    tableObserver.observe(root, { childList: true, subtree: true });
  }

  /* ───────── 3. Public site header ───────── */
  function initSiteHeader() {
    var header = document.querySelector('.site-header');
    var wrap = header && header.querySelector('.section-wrap');
    if (!header || !wrap || header.dataset.trResponsive) return;
    header.dataset.trResponsive = '1';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tr-burger-site';
    btn.setAttribute('aria-label', 'Open menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span></span><span></span><span></span>';
    wrap.appendChild(btn);

    function set(open) {
      header.classList.toggle('nav-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    btn.addEventListener('click', function () { set(!header.classList.contains('nav-open')); });
    header.querySelectorAll('.nav-links a').forEach(function (a) { a.addEventListener('click', function () { set(false); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
    var onMQ = function () { if (!SITE_MQ.matches) set(false); };
    SITE_MQ.addEventListener ? SITE_MQ.addEventListener('change', onMQ) : SITE_MQ.addListener(onMQ);
  }

  /* ───────── boot ───────── */
  function boot() {
    initDashboard();
    initSiteHeader();
    enhanceTables();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
