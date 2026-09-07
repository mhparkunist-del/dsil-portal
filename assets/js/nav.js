/* Mobile hamburger menu – same behaviour as dsil.kaist.ac.kr nav.js */
(function () {
  'use strict';

  function toggleNav() {
    var links = document.getElementById('nav-links');
    var btn = document.querySelector('.nav-toggle');
    if (!links) return;
    var open = links.classList.toggle('is-open');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  document.addEventListener('click', function (e) {
    var links = document.getElementById('nav-links');
    if (!links || !links.classList.contains('is-open')) return;
    if (e.target.closest('.nav-right')) return;
    links.classList.remove('is-open');
  });

  window.toggleNav = toggleNav;
})();
