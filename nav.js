/* ============================================================
   SHARED HEADER NAVIGATION BEHAVIOUR — nav.js
   Handles click-toggle for .nav-dropdown menus.
   Sub-dropdowns open on hover (CSS only, no JS needed).
   Load via: <script src="/nav.js"></script> before </body>
   ============================================================ */
(function () {
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

  // Clicking anywhere outside closes all dropdowns
  document.addEventListener('click', function () {
    dropdowns.forEach(function (dd) {
      var om = dd.querySelector('.nav-dropdown-menu');
      var ot = dd.querySelector('.nav-dropdown-trigger');
      if (om) om.classList.remove('open');
      if (ot) ot.classList.remove('open');
    });
  });
}());
