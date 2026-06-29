/* ============================================================
   SHARED HEADER NAVIGATION BEHAVIOUR — nav.js
   Handles click-toggle for .nav-dropdown menus.
   Injects hamburger button for mobile viewports.
   Sub-dropdowns open on hover (CSS only, no JS needed).
   Load via: <script src="/nav.js"></script> before </body>
   ============================================================ */
(function () {
  // ── Hamburger injection ──────────────────────────────────────
  var header = document.querySelector('header');
  var nav    = document.querySelector('header nav');

  if (header && nav) {
    var btn = document.createElement('button');
    btn.className = 'nav-hamburger';
    btn.setAttribute('aria-label', 'Open menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span></span><span></span><span></span>';
    header.appendChild(btn);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = nav.classList.toggle('nav-open');
      btn.classList.toggle('open', isOpen);
      btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  }

  // ── Primary dropdown toggles ─────────────────────────────────
  var dropdowns = document.querySelectorAll('.nav-dropdown');

  dropdowns.forEach(function (dd) {
    var trigger = dd.querySelector('.nav-dropdown-trigger');
    var menu    = dd.querySelector('.nav-dropdown-menu');
    if (!trigger || !menu) return;

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      // Close every other open dropdown first
      dropdowns.forEach(function (other) {
        if (other !== dd) {
          var om = other.querySelector('.nav-dropdown-menu');
          var ot = other.querySelector('.nav-dropdown-trigger');
          if (om) om.classList.remove('open');
          if (ot) ot.classList.remove('open');
        }
      });
      var isOpen = menu.classList.toggle('open');
      trigger.classList.toggle('open', isOpen);
    });
  });

  // ── Close everything on outside click ───────────────────────
  document.addEventListener('click', function () {
    dropdowns.forEach(function (dd) {
      var om = dd.querySelector('.nav-dropdown-menu');
      var ot = dd.querySelector('.nav-dropdown-trigger');
      if (om) om.classList.remove('open');
      if (ot) ot.classList.remove('open');
    });
    // Also close hamburger menu
    if (nav && btn) {
      nav.classList.remove('nav-open');
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  // ── Close hamburger menu on resize back to desktop ──────────
  window.addEventListener('resize', function () {
    if (window.innerWidth > 768 && nav && btn) {
      nav.classList.remove('nav-open');
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
}());
