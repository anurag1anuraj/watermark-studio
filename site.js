/* Watermark Studio – shared site behaviour (mobile menu, footer year, contact mailto form) */
(function () {
  'use strict';

  // Footer year
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // Mobile menu
  var btn = document.getElementById('menuBtn');
  var menu = document.getElementById('mobileMenu');
  if (btn && menu) {
    var iconOpen = document.getElementById('menuIconOpen');
    var iconClose = document.getElementById('menuIconClose');

    function setMenu(open) {
      menu.classList.toggle('hidden', !open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      if (iconOpen) iconOpen.classList.toggle('hidden', open);
      if (iconClose) iconClose.classList.toggle('hidden', !open);
    }

    btn.addEventListener('click', function () {
      setMenu(menu.classList.contains('hidden'));
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
        setMenu(false);
        btn.focus();
      }
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 1024) setMenu(false);
    });
  }

  // Contact form: builds a mailto: link. Nothing is sent from this website.
  var form = document.getElementById('contactForm');
  if (form) {
    var EMAIL = 'heycoders.anurag@gmail.com';
    var status = document.getElementById('contactStatus');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var type = form.elements['type'].value;
      var name = form.elements['name'].value.trim();
      var message = form.elements['message'].value.trim();
      var includeInfo = form.elements['includeInfo'].checked;

      if (!message) {
        status.textContent = 'Please write a message before opening your email app.';
        status.className = 'mt-3 text-sm text-red-700';
        form.elements['message'].focus();
        return;
      }

      var body = message;
      if (name) body = 'From: ' + name + '\n\n' + body;
      if (includeInfo) {
        body += '\n\n---\nBrowser: ' + navigator.userAgent +
          '\nScreen: ' + window.screen.width + 'x' + window.screen.height;
      }

      var subject = 'Watermark Studio – ' + type;
      var url = 'mailto:' + EMAIL + '?subject=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(body);

      status.textContent = 'Opening your email app. If nothing opens, copy the address ' + EMAIL +
        ' and send your message manually. Nothing has been sent yet.';
      status.className = 'mt-3 text-sm text-slate-700';
      window.location.href = url;
    });
  }
})();