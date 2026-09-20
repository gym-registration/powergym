/* ═══════════════════════════════════════════════════════════════
   POWER GYM — Landing Page: Member Ratings & Feedback
   tr-home-feedback.js  |  Runs on home.html only

   Renders the member reviews embedded in #home-feedback-data (see
   _public_feedback_data() in app.py / the #feedback section in home.html)
   as testimonial cards, paginated client-side at 5 per page. Everything
   needed is already on the page, so paging never round-trips to the
   server — it only re-slices the array already in memory.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var PER_PAGE = 5;

  function boot() {
    var dataEl = document.getElementById('home-feedback-data');
    var grid   = document.getElementById('rf-grid');
    var pager  = document.getElementById('rf-pagination');
    if (!dataEl || !grid || !pager) return; // section not present (no feedback yet)

    var items = [];
    try { items = JSON.parse(dataEl.textContent || '[]'); } catch (e) { items = []; }
    if (!items.length) return;

    var totalPages = Math.max(1, Math.ceil(items.length / PER_PAGE));
    var page = 1;

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function starsHtml(rating) {
      var out = '';
      for (var i = 1; i <= 5; i++) {
        out += i <= rating ? '★' : '☆';
      }
      return out;
    }

    function cardHtml(item) {
      var plan = item.plan_name ? esc(item.plan_name) + ' Member' : 'Power Gym Member';
      return (
        '<div class="testimonial-card">' +
          '<div class="testimonial-stars">' + starsHtml(item.rating) + '</div>' +
          '<div class="testimonial-quote">\u201C' + esc(item.comment) + '\u201D</div>' +
          '<div class="testimonial-author">' +
            '<div class="testimonial-avatar">' + esc(item.initial || '?') + '</div>' +
            '<div>' + esc(item.name || 'A member') + '<br><span style="opacity:.75;">' + plan + ' \u00B7 ' + esc(item.date) + '</span></div>' +
          '</div>' +
        '</div>'
      );
    }

    function renderPager() {
      if (totalPages <= 1) { pager.innerHTML = ''; return; }
      var html = '<button type="button" class="rf-page-btn" data-page="prev"' + (page === 1 ? ' disabled' : '') + ' aria-label="Previous page">\u2039 Prev</button>';
      for (var p = 1; p <= totalPages; p++) {
        html += '<button type="button" class="rf-page-btn rf-page-num' + (p === page ? ' active' : '') + '" data-page="' + p + '">' + p + '</button>';
      }
      html += '<button type="button" class="rf-page-btn" data-page="next"' + (page === totalPages ? ' disabled' : '') + ' aria-label="Next page">Next \u203A</button>';
      pager.innerHTML = html;

      Array.prototype.forEach.call(pager.querySelectorAll('.rf-page-btn'), function (btn) {
        btn.addEventListener('click', function () {
          var val = btn.getAttribute('data-page');
          if (val === 'prev') page = Math.max(1, page - 1);
          else if (val === 'next') page = Math.min(totalPages, page + 1);
          else page = parseInt(val, 10) || 1;
          render();
          var section = document.getElementById('feedback');
          if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    }

    function render() {
      var start = (page - 1) * PER_PAGE;
      grid.innerHTML = items.slice(start, start + PER_PAGE).map(cardHtml).join('');
      renderPager();
    }

    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
