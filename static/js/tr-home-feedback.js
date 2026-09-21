/* ═══════════════════════════════════════════════════════════════
   POWER GYM — Landing Page: Member Feedback
   tr-home-feedback.js  |  Runs on home.html only

   Renders the "WHAT OUR MEMBERS SAY" section: each member's star
   rating and written feedback as a review card, PAGE_SIZE (5) per
   page, with Prev / page numbers / Next controls in #rf-pagination.
   Reads straight from the JSON already embedded in
   #home-feedback-data (see _public_feedback_data() in app.py) — no
   extra request needed.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var PAGE_SIZE = 5;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function starsHtml(rating) {
    var out = '';
    for (var i = 1; i <= 5; i++) out += i <= rating ? '★' : '☆';
    return out;
  }

  /* Page numbers to show: everything when there are few pages, otherwise
     first, last, and the current page with one neighbour each side. */
  function pageWindow(current, total) {
    var pages = [], i;
    if (total <= 7) {
      for (i = 1; i <= total; i++) pages.push(i);
      return pages;
    }
    pages.push(1);
    var start = Math.max(2, current - 1);
    var end = Math.min(total - 1, current + 1);
    if (start > 2) pages.push('…');
    for (i = start; i <= end; i++) pages.push(i);
    if (end < total - 1) pages.push('…');
    pages.push(total);
    return pages;
  }

  function cardHtml(item) {
    var name = item.name || 'A member';
    var meta = [item.plan_name, item.date].filter(Boolean).map(esc).join(' · ');
    return (
      '<article class="testimonial-card">' +
        '<div class="testimonial-stars" role="img" aria-label="' + esc(item.rating) + ' out of 5 stars">' +
          starsHtml(item.rating) +
        '</div>' +
        '<div class="testimonial-quote">“' + esc(item.comment) + '”</div>' +
        '<div class="testimonial-author">' +
          '<div class="testimonial-avatar">' + esc(item.initial || name.charAt(0).toUpperCase() || '?') + '</div>' +
          '<div><span class="testimonial-name">' + esc(name) + '</span>' +
            (meta ? '<span class="testimonial-meta">' + meta + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</article>'
    );
  }

  function boot() {
    var dataEl = document.getElementById('home-feedback-data');
    var list   = document.getElementById('rf-testimonials');
    var pag    = document.getElementById('rf-pagination');
    if (!dataEl || !list) return;

    var items = [];
    try { items = JSON.parse(dataEl.textContent || '[]'); } catch (e) { items = []; }
    if (!items.length) return;

    var totalPages = Math.ceil(items.length / PAGE_SIZE);
    var page = 1;

    function render(focusKey) {
      var start = (page - 1) * PAGE_SIZE;
      list.innerHTML = items.slice(start, start + PAGE_SIZE).map(cardHtml).join('');

      if (!pag) return;
      if (totalPages <= 1) { pag.innerHTML = ''; return; }

      var html = '<button type="button" class="rf-page-btn" data-page="prev" aria-label="Previous page"' +
                 (page === 1 ? ' disabled' : '') + '>&lsaquo;</button>';
      pageWindow(page, totalPages).forEach(function (p) {
        if (p === '…') {
          html += '<span class="rf-page-gap" aria-hidden="true">…</span>';
        } else {
          html += '<button type="button" class="rf-page-btn rf-page-num' + (p === page ? ' active' : '') +
                  '" data-page="' + p + '"' + (p === page ? ' aria-current="page"' : '') +
                  ' aria-label="Page ' + p + '">' + p + '</button>';
        }
      });
      html += '<button type="button" class="rf-page-btn" data-page="next" aria-label="Next page"' +
              (page === totalPages ? ' disabled' : '') + '>&rsaquo;</button>';
      pag.innerHTML = html;

      // Re-rendering replaces the buttons, so hand keyboard focus back.
      if (focusKey) {
        var again = pag.querySelector('[data-page="' + focusKey + '"]:not(:disabled)') ||
                    pag.querySelector('.rf-page-num.active');
        if (again) again.focus({ preventScroll: true });
      }
    }

    if (pag) {
      pag.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-page]') : null;
        if (!btn || btn.disabled) return;
        var key = btn.getAttribute('data-page');
        if (key === 'prev') page = Math.max(1, page - 1);
        else if (key === 'next') page = Math.min(totalPages, page + 1);
        else page = parseInt(key, 10) || page;
        render(key);

        // Pages differ in height: if the top of the list has scrolled out
        // of view (or under the sticky header), bring it back into view.
        var top = list.getBoundingClientRect().top;
        if (top < 100) window.scrollTo({ top: window.pageYOffset + top - 110, behavior: 'smooth' });
      });
    }

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();