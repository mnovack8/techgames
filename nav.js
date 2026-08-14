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

  function closeDropdown(dd) {
    var menu    = dd.querySelector('.nav-dropdown-menu');
    var trigger = dd.querySelector('.nav-dropdown-trigger');
    if (menu)    menu.classList.remove('open');
    if (trigger) trigger.classList.remove('open');
  }

  dropdowns.forEach(function (dd) {
    var trigger = dd.querySelector('.nav-dropdown-trigger');
    var menu    = dd.querySelector('.nav-dropdown-menu');
    if (!trigger || !menu) return;

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      // Close every other open dropdown first
      dropdowns.forEach(function (other) {
        if (other !== dd) closeDropdown(other);
      });
      var isOpen = menu.classList.toggle('open');
      trigger.classList.toggle('open', isOpen);
    });
  });

  // ── Close everything on outside click ───────────────────────
  document.addEventListener('click', function () {
    dropdowns.forEach(closeDropdown);
    // Also close hamburger menu
    if (nav && btn) {
      nav.classList.remove('nav-open');
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  // ── Close hamburger menu on resize back to desktop ──────────
  function isMobileLayout() {
    var isLandscapeShort = window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
    return window.innerWidth <= 768 || isLandscapeShort;
  }

  window.addEventListener('resize', function () {
    if (!isMobileLayout() && nav && btn) {
      nav.classList.remove('nav-open');
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
}());
