/*!
 * app.js — GenMart frontend controller.
 *
 * The hero markup is a static design; this file only ADDS behaviour:
 *   • CTA "Make a Reel" → brief modal → POST /api/reels (signed-in) or contact
 *   • Log in / Sign up pills → auth modal with real email + password fields
 *   • Contact links → lead capture
 *   • Nav links (Brands / Creators / Pricing / Use Cases) → animated info modals
 *   • Live creator count from /api/meta
 *   • Dashboard → the signed-in user's own briefs
 *
 * No framework, no build step. Every network call is wrapped so a backend
 * hiccup degrades to an inline message instead of a dead button. The file stays
 * inert when there is no DOM, so a test runner can require it safely.
 */
(function () {
  'use strict';

  /* Browser-only module. Staying inert when there is no DOM means this file can
     be required by a test runner or bundler without throwing. */
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  var TOKEN_KEY = 'genmart.token';
  var USER_KEY = 'genmart.user';
  /* Pre-rename keys. Read once and migrated forward so nobody is logged out by
     the brand change; nothing writes them any more. */
  var LEGACY_TOKEN_KEY = 'reelmark.token';
  var LEGACY_USER_KEY = 'reelmark.user';

  var dialog = null;
  var dash = null;
  var currentMode = 'brief';
  var currentUser = null;
  var metaCache = null;
  var isBusy = false;

  function $(selector, root) { return (root || document).querySelector(selector); }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---------- session ---------- */

  /* Move a value from the pre-rename key to the current one. Returns the new
     key's value, so an existing session survives the rebrand exactly once. */
  function adoptLegacy(legacyKey, key) {
    try {
      var legacy = localStorage.getItem(legacyKey);
      if (!legacy) return null;
      localStorage.setItem(key, legacy);
      localStorage.removeItem(legacyKey);
      return legacy;
    } catch (_) { return null; }
  }

  function token() {
    try {
      var value = localStorage.getItem(TOKEN_KEY);
      if (value) return value;
      return adoptLegacy(LEGACY_TOKEN_KEY, TOKEN_KEY) || '';
    } catch (_) { return ''; }
  }

  function cachedUser() {
    try {
      var raw = localStorage.getItem(USER_KEY) || adoptLegacy(LEGACY_USER_KEY, USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (_) { /* private mode: session simply won't persist */ }
  }

  function setUser(user) {
    currentUser = user || null;
    try {
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
      else localStorage.removeItem(USER_KEY);
    } catch (_) { /* private mode: session won't persist */ }
    refreshAccountActions();
  }

  function clearSession() {
    setToken('');
    setUser(null);
  }

  /* ---------- transport ---------- */

  function api(path, options) {
    var opts = options || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token()) headers.Authorization = 'Bearer ' + token();
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (response) {
      return response.json().catch(function () { return { ok: false, error: 'Unexpected server response' }; })
        .then(function (payload) {
          if (!response.ok || payload.ok === false) {
            var err = new Error(payload.error || 'Request failed');
            err.fields = payload.fields || null;
            err.status = response.status;
            throw err;
          }
          return payload;
        });
    });
  }

  /* ---------- motion helpers ---------- */

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* display:none → visible cannot transition in the same frame: mount, force a
     reflow, then add the open class so the CSS transition actually runs. */
  function mountThenOpen(element, openClass) {
    element.classList.add('rm-mounted');
    void element.offsetWidth;
    element.classList.add(openClass);
  }

  function unmountAfterClose(element, openClass) {
    element.classList.remove(openClass);
    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      element.classList.remove('rm-mounted');
    };
    element.addEventListener('transitionend', function handler(event) {
      if (event.target !== element) return;
      element.removeEventListener('transitionend', handler);
      finish();
    });
    /* Backstop: a missing transitionend must never leave it mounted on screen. */
    window.setTimeout(finish, 420);
  }

  function pulse(element) {
    if (!element || !element.animate || reducedMotion()) return;
    element.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(0.965)' }, { transform: 'scale(1)' }],
      { duration: 260, easing: 'cubic-bezier(.16,1.2,.35,1)' }
    );
  }

  function toast(message, kind) {
    var host = $('#rm-toast');
    if (!host) {
      host = document.createElement('div');
      host.id = 'rm-toast';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    host.textContent = message;
    host.className = 'show' + (kind ? ' ' + kind : '');
    window.clearTimeout(host._timer);
    host._timer = window.setTimeout(function () { host.className = ''; }, 3600);
  }

  /* ---------- account pills ---------- */

  function refreshAccountActions() {
    var host = $('.account-actions');
    if (!host) return;
    if (currentUser) {
      var first = String(currentUser.name || currentUser.email || 'You').split(' ')[0];
      host.innerHTML =
        '<a class="pill login" href="#dashboard" data-action="dashboard">' + escapeHtml(first) + '</a>' +
        '<a class="pill signup" href="#signout" data-action="signout">Sign out</a>';
    } else {
      host.innerHTML =
        '<a class="pill login" href="#login" data-action="login">Log in</a>' +
        '<a class="pill signup" href="#signup" data-action="signup">Sign up</a>';
    }
    /* The pills were just re-created, so their listeners must be re-attached. */
    wireAccountPills();
  }

  function wireAccountPills() {
    intercept('.account-actions .pill', function (event, element) {
      var action = element.getAttribute('data-action');
      if (action && ACTIONS[action]) ACTIONS[action](event);
    });
  }

  /* ---------- shared markup helpers ---------- */

  function optionsMarkup(pairs) {
    return pairs.map(function (pair) {
      return '<option value="' + escapeHtml(pair[0]) + '">' + escapeHtml(pair[1]) + '</option>';
    }).join('');
  }

  var FORMAT_OPTIONS = [['vertical-9-16', 'Vertical 9:16'], ['square-1-1', 'Square 1:1'], ['landscape-16-9', 'Landscape 16:9']];
  var GOAL_OPTIONS = [['launch', 'Product launch'], ['awareness', 'Awareness'], ['sales', 'Sales'], ['community', 'Community']];
  var BUDGET_OPTIONS = [['under-500', 'Under $500'], ['500-1500', '$500 – $1,500'], ['1500-5000', '$1,500 – $5,000'], ['5000-plus', '$5,000+']];

  function listMarkup(items) {
    return '<ul class="rm-list">' + items.map(function (item) {
      return '<li><span class="rm-tick" aria-hidden="true">✓</span><span>' + escapeHtml(item) + '</span></li>';
    }).join('') + '</ul>';
  }

  /* ---------- modal shell ---------- */

  function buildModal() {
    var wrap = document.createElement('div');
    wrap.id = 'rm-modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'rm-modal-title');
    wrap.innerHTML = [
      '<div class="rm-backdrop" data-close></div>',
      '<div class="rm-panel">',
      '  <button class="rm-x" type="button" aria-label="Close" data-close>&times;</button>',
      '  <h2 id="rm-modal-title" class="rm-title">Make a Reel</h2>',
      '  <p class="rm-sub" id="rm-sub"></p>',
      '  <div class="rm-body" id="rm-body"></div>',
      '  <p class="rm-hint" id="rm-hint"></p>',
      '</div>',
    ].join('\n');
    return wrap;
  }

  var MODE_COPY = {
    brief: {
      title: 'Make a Reel',
      sub: 'Tell us about the product. Our crew replies within one business day.',
    },
    login: { title: 'Log in', sub: 'Welcome back. Your briefs are waiting.' },
    signup: { title: 'Create account', sub: 'Free to start — no card, no commitment.' },
    contact: { title: 'Talk to us', sub: 'Tell us what you are launching. We reply within one business day.' },
    brands: { title: 'For brands', sub: 'Short-form video that actually ships on schedule.' },
    creators: { title: 'For creators', sub: 'Get matched with brands that pay on time.' },
    pricing: { title: 'Pricing', sub: 'Fixed-price briefs. No retainers, no surprises.' },
    'use-cases': { title: 'Use cases', sub: 'Where snackable reels move the number you care about.' },
  };

  /* ---------- panel bodies ---------- */

  function signedInLine() {
    if (!currentUser) return '';
    return '<p class="rm-signed">Signed in as <strong>' + escapeHtml(currentUser.email) + '</strong></p>';
  }

  function briefBody() {
    return [
      signedInLine(),
      '<form id="rm-form" novalidate>',
      '  <div class="rm-field"><label for="rm-brand">Brand</label><input id="rm-brand" name="brand" maxlength="80" autocomplete="organization" /></div>',
      '  <div class="rm-field"><label for="rm-product">Product</label><input id="rm-product" name="product" maxlength="120" /></div>',
      '  <div class="rm-field"><label for="rm-audience">Audience</label><input id="rm-audience" name="audience" maxlength="200" placeholder="e.g. indie founders shipping weekly" /></div>',
      '  <div class="rm-row">',
      '    <div class="rm-field"><label for="rm-format">Format</label><select id="rm-format" name="format"></select></div>',
      '    <div class="rm-field"><label for="rm-goal">Goal</label><select id="rm-goal" name="goal"></select></div>',
      '  </div>',
      '  <div class="rm-field"><label for="rm-budget">Budget</label><select id="rm-budget" name="budget"></select></div>',
      '  <div class="rm-field"><label for="rm-notes">Notes</label><textarea id="rm-notes" name="notes" rows="3" maxlength="1000" placeholder="Anything we should know about the launch?"></textarea></div>',
      '  <p class="rm-error" id="rm-error" role="alert" hidden></p>',
      '  <button class="rm-submit" type="submit" id="rm-submit">Send brief</button>',
      '</form>',
    ].join('\n');
  }

  function authBody(mode) {
    var isLogin = mode === 'login';
    return [
      '<form id="rm-form" novalidate>',
      isLogin ? '' : '  <div class="rm-field"><label for="rm-name">Name</label><input id="rm-name" name="name" maxlength="80" autocomplete="name" /></div>',
      '  <div class="rm-field"><label for="rm-email">Email</label><input id="rm-email" name="email" type="email" maxlength="254" autocomplete="email" /></div>',
      '  <div class="rm-field"><label for="rm-password">Password</label><input id="rm-password" name="password" type="password" minlength="8" maxlength="200" autocomplete="' +
        (isLogin ? 'current-password' : 'new-password') + '" /></div>',
      '  <p class="rm-error" id="rm-error" role="alert" hidden></p>',
      '  <button class="rm-submit" type="submit" id="rm-submit">' + (isLogin ? 'Log in' : 'Create account') + '</button>',
      '</form>',
    ].join('\n');
  }

  function contactBody() {
    return [
      '<form id="rm-form" novalidate>',
      '  <div class="rm-field"><label for="rm-c-name">Name</label><input id="rm-c-name" name="name" maxlength="80" autocomplete="name" /></div>',
      '  <div class="rm-field"><label for="rm-c-email">Email</label><input id="rm-c-email" name="email" type="email" maxlength="254" autocomplete="email" /></div>',
      '  <div class="rm-field"><label for="rm-c-message">Message</label><textarea id="rm-c-message" name="message" rows="4" maxlength="2000"></textarea></div>',
      '  <label class="rm-check"><input type="checkbox" name="newsletter" value="1" /> Send me occasional creator picks</label>',
      '  <p class="rm-error" id="rm-error" role="alert" hidden></p>',
      '  <button class="rm-submit" type="submit" id="rm-submit">Send message</button>',
      '</form>',
    ].join('\n');
  }

  function pricingBody() {
    var bands = (metaCache && metaCache.budgets) || ['under-500', '500-1500', '1500-5000', '5000-plus'];
    var detail = {
      'under-500': { price: 'Under $500', text: '1 reel, single hook, one revision round.' },
      '500-1500': { price: '$500 – $1,500', text: '2 reels, two hooks, captions, one revision round.' },
      '1500-5000': { price: '$1,500 – $5,000', text: '3 reels, three formats, two revision rounds.' },
      '5000-plus': { price: '$5,000+', text: 'Campaign set, multiple creators, dedicated producer.' },
    };
    return '<div class="rm-price-grid">' + bands.map(function (band) {
      var row = detail[band] || { price: band, text: '' };
      return '<div class="rm-price"><span class="rm-price-amount">' + escapeHtml(row.price) +
        '</span><span class="rm-price-detail">' + escapeHtml(row.text) + '</span></div>';
    }).join('') + '</div>' +
      '<p class="rm-note">Every band is a fixed price for the scope above — nothing is billed by the hour.</p>' +
      '<button class="rm-submit" type="button" data-action="start-brief">Start a brief</button>';
  }

  function infoBody(mode) {
    if (mode === 'brands') {
      return listMarkup([
        'Vertical, square and landscape cuts of the same brief — one shoot, three placements.',
        'Scripts written for the first 1.5 seconds, because that is where the scroll stops.',
        'Every deliverable arrives with captions burned in and a silent-first edit.',
        'One producer owns your brief end to end, so nothing is lost in a handoff.',
      ]) + '<button class="rm-submit" type="button" data-action="start-brief">Start a brief</button>';
    }
    if (mode === 'creators') {
      return listMarkup([
        'Briefs arrive with the budget agreed up front — no unpaid pitching.',
        'You keep the raw footage and the right to post the work in your own reel.',
        'Fixed scopes: 1 to 3 reels, quoted in the same message as the brief.',
        'Payout on delivery. No net-60, no invoice chasing.',
      ]) + '<button class="rm-submit" type="button" data-action="contact">Talk to us</button>';
    }
    if (mode === 'use-cases') {
      return listMarkup([
        'Product launch — three cuts that explain the product before the fold.',
        'Paid social — square and vertical variants built for the same hook.',
        'Community — creator-style clips that do not read as an ad.',
        'Lifecycle — a short clip per feature for onboarding emails.',
      ]) + '<button class="rm-submit" type="button" data-action="start-brief">Start a brief</button>';
    }
    return pricingBody();
  }

  function fillSelects() {
    [
      ['#rm-format', FORMAT_OPTIONS],
      ['#rm-goal', GOAL_OPTIONS],
      ['#rm-budget', BUDGET_OPTIONS],
    ].forEach(function (pair) {
      var select = $(pair[0], dialog);
      if (!select) return;
      pair[1].forEach(function (option) {
        var el = document.createElement('option');
        el.value = option[0];
        el.textContent = option[1];
        select.appendChild(el);
      });
    });
  }

  function hintMarkup(mode) {
    if (mode === 'login') return 'New here? <a href="#signup" data-action="signup">Create an account</a>';
    if (mode === 'signup') return 'Already have an account? <a href="#login" data-action="login">Log in</a>';
    if (mode === 'brief') {
      return currentUser
        ? 'Signed in. <a href="#dashboard" data-action="dashboard">View your briefs</a>'
        : 'Already have an account? <a href="#login" data-action="login">Log in</a>';
    }
    return 'Questions? <a href="#contact" data-action="contact">Talk to us</a>';
  }

  function renderBody(mode) {
    var body = $('#rm-body', dialog);
    if (!body) return;

    /* Rebuilt from scratch on every mode change: a stale input from the previous
       panel can never be submitted by accident. */
    if (mode === 'brief') body.innerHTML = briefBody();
    else if (mode === 'login' || mode === 'signup') body.innerHTML = authBody(mode);
    else if (mode === 'contact') body.innerHTML = contactBody();
    else body.innerHTML = infoBody(mode);

    if (mode === 'brief') fillSelects();

    var error = $('#rm-error', body);
    if (error) error.hidden = true;
  }

  function setMode(mode) {
    currentMode = mode;
    if (!dialog) return;
    var copy = MODE_COPY[mode] || MODE_COPY.brief;

    $('#rm-modal-title', dialog).textContent = copy.title;
    $('#rm-sub', dialog).textContent = copy.sub;
    $('#rm-hint', dialog).innerHTML = hintMarkup(mode);
    renderBody(mode);

    var first = dialog.querySelector('#rm-body input, #rm-body select, #rm-body textarea');
    if (first && first.focus) window.setTimeout(function () { first.focus(); }, 80);

    var panel = $('.rm-panel', dialog);
    if (panel && panel.animate && !reducedMotion()) {
      panel.animate(
        [{ opacity: 0.55, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 260, easing: 'cubic-bezier(.2,.75,.25,1)' }
      );
    }
  }

  /* ---------- open / close ---------- */

  function open(mode) {
    if (!dialog) {
      dialog = buildModal();
      document.body.appendChild(dialog);
      wireModal();
    }
    closeDashboard();
    mountThenOpen(dialog, 'open');
    document.body.classList.add('rm-locked');
    setMode(mode || 'brief');
  }

  function close() {
    if (!dialog || !dialog.classList.contains('open')) return;
    unmountAfterClose(dialog, 'open');
    document.body.classList.remove('rm-locked');
    isBusy = false;
  }

  function openContact() {
    open('contact');
  }

  /* ---------- feedback ---------- */

  function showError(message) {
    var box = $('#rm-error', dialog);
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
    if (message) pulse(box);
  }

  /* The backend answers 400 with {fields:{name:'Name is required', …}}. Put each
     message under its own input instead of showing one vague banner. */
  function showFieldErrors(fields) {
    if (!fields) return false;
    var form = $('#rm-form', dialog);
    if (!form) return false;

    $$('.rm-fielderr', form).forEach(function (node) { node.remove(); });
    $$('.rm-invalid', form).forEach(function (node) { node.classList.remove('rm-invalid'); });

    var first = null;
    Object.keys(fields).forEach(function (key) {
      var input = form.querySelector('[name="' + key + '"]');
      if (!input) return;
      input.classList.add('rm-invalid');
      var note = document.createElement('span');
      note.className = 'rm-fielderr';
      note.textContent = fields[key];
      input.parentNode.appendChild(note);
      if (!first) first = input;
    });

    if (first && first.focus) first.focus();
    return true;
  }

  function busy(flag, label) {
    isBusy = !!flag;
    var button = $('#rm-body #rm-submit', dialog);
    if (!button) return;
    if (flag) {
      button.dataset.label = button.textContent;
      button.textContent = label || 'Sending…';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.label || defaultLabel();
      button.disabled = false;
    }
  }

  function defaultLabel() {
    if (currentMode === 'login') return 'Log in';
    if (currentMode === 'signup') return 'Create account';
    if (currentMode === 'contact') return 'Send message';
    return 'Send brief';
  }

  function success(message) {
    var body = $('#rm-body', dialog);
    if (!body) return;
    body.innerHTML =
      '<div class="rm-success">' +
      '<span class="rm-success-mark" aria-hidden="true">✓</span>' +
      '<p class="rm-ok" role="status">' + escapeHtml(message) + '</p>' +
      '</div>';
  }

  function successWithAction(message, label, action) {
    success(message);
    var host = $('.rm-success', dialog);
    if (!host) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'rm-submit rm-ghost';
    button.setAttribute('data-action', action);
    button.textContent = label;
    host.appendChild(button);
  }

  function payloadFrom(form) {
    var data = {};
    $$('input, select, textarea', form).forEach(function (input) {
      if (!input.name) return;
      data[input.name] = input.type === 'checkbox' ? input.checked : input.value;
    });
    return data;
  }

  /* ---------- submissions ---------- */

  function submitBrief(data) {
    if (!token()) {
      setMode('login');
      showError('Log in or create an account first — your brief goes through right after.');
      return;
    }
    busy(true, 'Sending…');
    api('/api/reels', { method: 'POST', body: data })
      .then(function (result) {
        var brand = result.reel && result.reel.brand ? result.reel.brand : 'your product';
        successWithAction('Brief received for ' + brand + '. Our crew will reply within one business day.', 'View your briefs', 'dashboard');
        toast('Brief submitted', 'ok');
        if (dash && dash.classList.contains('open')) hydrateDashboard();
      })
      .catch(function (err) {
        if (err.status === 401) {
          clearSession();
          setMode('login');
          showError('Your session expired. Please log in again.');
          return;
        }
        if (!showFieldErrors(err.fields)) showError(err.message);
      })
      .then(function () { busy(false); });
  }

  function submitAuth(data, mode) {
    var path = mode === 'login' ? '/api/auth/login' : '/api/auth/signup';
    var body = mode === 'login'
      ? { email: data.email, password: data.password }
      : { name: data.name, email: data.email, password: data.password };

    busy(true, mode === 'login' ? 'Logging in…' : 'Creating…');
    api(path, { method: 'POST', body: body })
      .then(function (result) {
        setToken(result.token);
        setUser(result.user);
        var first = String(result.user.name || result.user.email).split(' ')[0];
        successWithAction(
          (mode === 'login' ? 'Welcome back, ' : 'Account created, ') + first + '. Close this and send your brief.',
          'Send a brief',
          'start-brief'
        );
        toast(mode === 'login' ? 'Logged in' : 'Account created', 'ok');
        if (dash && dash.classList.contains('open')) hydrateDashboard();
      })
      .catch(function (err) {
        if (!showFieldErrors(err.fields)) showError(err.message);
      })
      .then(function () { busy(false); });
  }

  function submitContact(data) {
    busy(true, 'Sending…');
    api('/api/contact', { method: 'POST', body: data })
      .then(function (result) {
        successWithAction(result.message || 'Thanks — our crew will reply within one business day.', 'Start a brief', 'start-brief');
        toast('Message sent', 'ok');
      })
      .catch(function (err) {
        if (!showFieldErrors(err.fields)) showError(err.message);
      })
      .then(function () { busy(false); });
  }

  /* One submit handler, attached once, dispatching on the current mode. The old
     build attached a second handler in openContact(), so every contact message
     also hit POST /api/reels and flipped the panel into login mode. */
  function onFormSubmit(event) {
    var form = event.target;
    if (!form || form.id !== 'rm-form') return;
    event.preventDefault();
    if (isBusy) return;

    var data = payloadFrom(form);
    showError('');
    $$('.rm-fielderr', form).forEach(function (node) { node.remove(); });

    if (currentMode === 'brief') return submitBrief(data);
    if (currentMode === 'login' || currentMode === 'signup') return submitAuth(data, currentMode);
    if (currentMode === 'contact') return submitContact(data);
  }

  function wireModal() {
    dialog.addEventListener('submit', onFormSubmit);
  }

  /* ---------- dashboard ---------- */

  function ensureDashboard() {
    if (dash) return dash;
    dash = document.createElement('main');
    dash.id = 'rm-dash';
    dash.setAttribute('role', 'dialog');
    dash.setAttribute('aria-modal', 'true');
    dash.setAttribute('aria-labelledby', 'rm-dash-title');
    dash.innerHTML = [
      '<div class="rm-dash-inner">',
      '  <header class="rm-dash-head">',
      '    <div>',
      '      <h1 id="rm-dash-title">Your briefs</h1>',
      '      <p class="rm-dash-sub" id="rm-dash-sub"></p>',
      '    </div>',
      '    <div class="rm-dash-actions">',
      '      <button class="rm-submit rm-small" type="button" data-action="start-brief">New brief</button>',
      '      <button class="rm-submit rm-ghost rm-small" type="button" data-action="close-dashboard">Back to site</button>',
      '    </div>',
      '  </header>',
      '  <div class="rm-stats" id="rm-stats"></div>',
      '  <div class="rm-dash-list" id="rm-dash-list"></div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(dash);
    return dash;
  }

  function statusChip(status) {
    var label = String(status || 'submitted');
    return '<span class="rm-chip rm-chip-' + escapeHtml(label) + '">' + escapeHtml(label) + '</span>';
  }

  function renderStats(reels) {
    var host = $('#rm-stats', dash);
    if (!host) return;
    var list = reels || [];
    var open = list.filter(function (r) { return r.status !== 'delivered' && r.status !== 'cancelled'; }).length;
    var delivered = list.filter(function (r) { return r.status === 'delivered'; }).length;
    host.innerHTML =
      '<div class="rm-stat"><span class="rm-stat-num">' + list.length + '</span><span class="rm-stat-label">Briefs sent</span></div>' +
      '<div class="rm-stat"><span class="rm-stat-num">' + open + '</span><span class="rm-stat-label">In progress</span></div>' +
      '<div class="rm-stat"><span class="rm-stat-num">' + delivered + '</span><span class="rm-stat-label">Delivered</span></div>';
  }

  function renderDashboard(reels) {
    var host = $('#rm-dash-list', dash);
    if (!host) return;

    if (!reels || reels.length === 0) {
      host.innerHTML =
        '<div class="rm-empty"><p>No briefs yet — your first one takes about a minute.</p>' +
        '<button class="rm-submit" type="button" data-action="start-brief">Make a Reel</button></div>';
      return;
    }

    host.innerHTML = reels.map(function (reel) {
      var when = '';
      try {
        when = new Date(reel.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      } catch (_) { when = ''; }
      return '<article class="rm-brief">' +
        '<div class="rm-brief-top"><h3>' + escapeHtml(reel.brand || 'Untitled') + '</h3>' + statusChip(reel.status) + '</div>' +
        '<p class="rm-brief-product">' + escapeHtml(reel.product) + '</p>' +
        '<p class="rm-brief-meta">' +
        escapeHtml(reel.format) + ' · ' + escapeHtml(reel.goal) + ' · ' + escapeHtml(reel.budget) +
        (when ? ' · ' + escapeHtml(when) : '') + '</p>' +
        (reel.notes ? '<p class="rm-brief-notes">' + escapeHtml(reel.notes) + '</p>' : '') +
        '</article>';
    }).join('');

    $$('.rm-brief', host).forEach(function (node, index) {
      if (!node.animate || reducedMotion()) return;
      node.animate(
        [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 380, delay: index * 60, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' }
      );
    });
  }

  function hydrateDashboard() {
    if (!dash) return;
    var sub = $('#rm-dash-sub', dash);
    if (sub) sub.textContent = currentUser ? currentUser.email + ' — everything you have sent us.' : '';

    if (!token()) {
      renderStats([]);
      renderDashboard([]);
      return;
    }

    api('/api/reels')
      .then(function (result) {
        renderStats(result.reels);
        renderDashboard(result.reels);
      })
      .catch(function (err) {
        if (err.status === 401) {
          clearSession();
          closeDashboard();
          open('login');
          return;
        }
        var host = $('#rm-dash-list', dash);
        if (host) host.innerHTML = '<div class="rm-empty"><p>' + escapeHtml(err.message) + '</p></div>';
      });
  }

  function openDashboard() {
    if (!currentUser) {
      open('login');
      return;
    }
    close();
    ensureDashboard();
    mountThenOpen(dash, 'open');
    document.body.classList.add('rm-locked');
    hydrateDashboard();
  }

  function closeDashboard() {
    if (!dash || !dash.classList.contains('open')) return;
    unmountAfterClose(dash, 'open');
    document.body.classList.remove('rm-locked');
  }

  /* ---------- live counts ---------- */

  function hydrateCounts() {
    var badge = document.getElementById('badge');
    if (!badge) return;
    api('/api/meta').then(function (meta) {
      metaCache = meta;
      var creators = meta.counts && meta.counts.creators;
      if (creators) {
        badge.textContent = 'Trusted by ' + Number(creators).toLocaleString('en-US') + '+ indie makers';
      }
    }).catch(function () { /* the static copy stays; never break the hero */ });
  }

  /* ---------- wiring ---------- */

  var ACTIONS = {
    login: function () { open('login'); },
    signup: function () { open('signup'); },
    brief: function () { open('brief'); },
    contact: function () { openContact(); },
    brands: function () { open('brands'); },
    creators: function () { open('creators'); },
    pricing: function () { open('pricing'); },
    'use-cases': function () { open('use-cases'); },
    'start-brief': function () { open('brief'); },
    dashboard: function () { openDashboard(); },
    'close-dashboard': function () { closeDashboard(); },
    signout: function () {
      clearSession();
      closeDashboard();
      toast('Signed out');
    },
  };

  function actionFromHref(href) {
    if (!href || href.charAt(0) !== '#') return '';
    var key = href.slice(1);
    return Object.prototype.hasOwnProperty.call(ACTIONS, key) ? key : '';
  }

  /* Delegated: modal panels and dashboard cards are created after load, so their
     data-action triggers must not need individual listeners. */
  function onDelegatedClick(event) {
    if (event.target.closest('[data-close]')) {
      event.preventDefault();
      close();
      return;
    }

    var trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    var action = trigger.getAttribute('data-action') || actionFromHref(trigger.getAttribute('href'));
    if (!action || !ACTIONS[action]) {
      if (trigger.getAttribute('href') === '#') {
        event.preventDefault();
        close();
        closeDashboard();
      }
      return;
    }
    event.preventDefault();
    if (trigger.classList.contains('pill') || trigger.classList.contains('cta')) pulse(trigger);
    ACTIONS[action](event);
  }

  /* Static elements present in the hero markup: bound explicitly so an anchor
     with href="#login" still works even if it lacks a data-action attribute. */
  function intercept(selector, handler) {
    $$(selector).forEach(function (element) {
      element.addEventListener('click', function (event) {
        event.preventDefault();
        handler(event, element);
      });
    });
  }

  function wireHero() {
    intercept('.cta', function () { open('brief'); });
    intercept('.nav a', function (event, element) {
      var action = actionFromHref(element.getAttribute('href'));
      if (action && ACTIONS[action]) ACTIONS[action](event);
    });
    intercept('.brand', function () { close(); closeDashboard(); });
    wireAccountPills();
  }

  function boot() {
    document.addEventListener('click', onDelegatedClick);
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (dash && dash.classList.contains('open')) closeDashboard();
      else close();
    });

    wireHero();

    /* Restore the previous visit's session, then revalidate it so a stale token
       cannot leave the header claiming a signed-in state. */
    setUser(cachedUser());
    if (token()) {
      api('/api/auth/me')
        .then(function (result) { setUser(result.user); })
        .catch(function (err) { if (err.status === 401) clearSession(); });
    }

    hydrateCounts();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* Used by tools/verify-ui.js and tests/ui.test.js to drive the page without a
     human. Exposed under the current brand name only. */
  window.__genmart = {
    open: open,
    close: close,
    dashboard: openDashboard,
    mode: function () { return currentMode; },
    user: function () { return currentUser; },
  };
}());
