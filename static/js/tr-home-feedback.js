/* ═══════════════════════════════════════════════════════════════
   POWER GYM — Landing Page: Member Ratings & Feedback
   tr-home-feedback.js  |  Runs on home.html only

   Builds the compact "name — stars" list shown/hidden when the
   MEMBER RATINGS & FEEDBACK card (#ratings-summary) is clicked or
   tapped. Reads straight from the JSON already embedded in
   #home-feedback-data (see _public_feedback_data() in app.py) — no
   extra request needed. This used to also render a paginated grid
   of full testimonial cards below the Schedule section; that grid
   was removed since the same reviews are now reachable from this
   one toggle instead.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

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

  function bootNameList() {
    var dataEl = document.getElementById('home-feedback-data');
    var list   = document.getElementById('rf-name-ratings-list');
    if (!dataEl || !list) return;

    var items = [];
    try { items = JSON.parse(dataEl.textContent || '[]'); } catch (e) { items = []; }
    if (!items.length) return;

    list.innerHTML = items.map(function (item) {
      return (
        '<div class="rf-name-row">' +
          '<span class="rf-name-row-name">' + esc(item.name || 'A member') + '</span>' +
          '<span class="rf-name-row-stars">' + starsHtml(item.rating) + '</span>' +
        '</div>'
      );
    }).join('');
  }

  /* Global so the onclick/onkeydown on the card (in home.html) can reach it. */
  window.toggleRatingsNameList = function () {
    var card = document.getElementById('ratings-summary');
    var list = document.getElementById('rf-name-ratings-list');
    var arrow = document.getElementById('rf-toggle-arrow');
    var hint = card && card.querySelector('.rf-toggle-hint');
    if (!card || !list) return;

    var opening = list.style.display === 'none';
    list.style.display = opening ? 'flex' : 'none';
    card.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (arrow) arrow.classList.toggle('rf-toggle-arrow-open', opening);
    if (hint) hint.textContent = opening ? "Tap to hide" : "Tap to see each member's rating";
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootNameList);
  } else {
    bootNameList();
  }
})();