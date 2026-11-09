/*!
 * app.js — Reelmark frontend controller.
 *
 * The hero markup is a static design; this file only ADDS behaviour:
 *   • CTA "Make a Reel" → brief modal → POST /api/reels (signed-in) or /api/contact
 *   • Log in / Sign up pills → auth modal → real session token
 *   • Contact links → lead capture
 *   • Live creator/video counts from /api/meta
 *
 * No framework, no build step. Every network call is wrapped so a backend
 * hiccup degrades to an inline message instead of a dead button.
 */
(function () {
  'use strict';

  /* Browser-only module. Staying inert when there is no DOM means this file can
     be required by a test runner or bundler without throwing. */
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  var API = '';
  var TOKEN_KEY = 'reelmark.token';
  var dialog = null;
  var currentMode = 'brief';

  function $(selector, root) { return (root || document).querySelector(selector); }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
  }

  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (_) { /* private mode: session simply won't persist */ }
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token()) headers.Authorization = 'Bearer ' + token();
    return fetch(API + path, {
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

  /* ---------- modal ---------- */

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
      '  <p class="rm-sub" id="rm-sub">Tell us about the product. Our crew replies within one business day.</p>',
      '  <form id="rm-form" novalidate>',
      '    <div class="rm-field"><label for="rm-brand">Brand</label><input id="rm-brand" name="brand" maxlength="80" autocomplete="organization" /></div>',
      '    <div class="rm-field"><label for="rm-product">Product</label><input id="rm-product" name="product" maxlength="120" /></div>',
      '    <div class="rm-field"><label for="rm-audience">Audience</label><input id="rm-audience" name="audience" maxlength="200" placeholder="e.g. indie founders shipping weekly" /></div>',
      '    <div class="rm-row">',
      '      <div class="rm-field"><label for="rm-format">Format</label><select id="rm-format" name="format"></select></div>',
      '      <div class="rm-field"><label for="rm-goal">Goal</label><select id="rm-goal" name="goal"></select></div>',
      '    </div>',
      '    <div class="rm-field"><label for="rm-budget">Budget</label><select id="rm-budget" name="budget"></select></div>',
      '    <div class="rm-field"><label for="rm-notes">Notes</label><textarea id="rm-notes" name="notes" rows="3" maxlength="1000"></textarea></div>',
      '    <p class="rm-error" id="rm-error" role="alert" hidden></p>',
      '    <button class="rm-submit" type="submit" id="rm-submit">Send brief</button>',
      '    <p class="rm-hint" id="rm-hint">Already have an account? <a href="#" data-mode="login">Log in</a></p>',
      '  </form>',
      '</div>',
    ].join('\n');
    return wrap;
  }

  function fillSelects() {
    var formats = [['vertical-9-16', 'Vertical 9:16'], ['square-1-1', 'Square 1:1'], ['landscape-16-9', 'Landscape 16:9']];
    var goals = [['launch', 'Product launch'], ['awareness', 'Awareness'], ['sales', 'Sales'], ['community', 'Community']];
    var budgets = [['under-500', 'Under $500'], ['500-1500', '$500 – $1,500'], ['1500-5000', '$1,500 – $5,000'], ['5000-plus', '$5,000+']];
    [
      ['#rm-format', formats],
      ['#rm-goal', goals],
      ['#rm-budget', budgets],
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

  function setMode(mode) {
    currentMode = mode;
    if (!dialog) return;
    var title = $('#rm-modal-title', dialog);
    var sub = $('#rm-sub', dialog);
    var submit = $('#rm-submit', dialog);
    var hint = $('#rm-hint', dialog);
    var briefOnly = dialog.querySelectorAll('.rm-brief-only');

    if (mode === 'login') {
      title.textContent = 'Log in';
      sub.textContent = 'Welcome back. Your briefs are waiting.';
      submit.textContent = 'Log in';
      hint.innerHTML = 'New here? <a href="#" data-mode="signup">Create an account</a>';
    } else if (mode === 'signup') {
      title.textContent = 'Create account';
      sub.textContent = 'Free to start — no card, no commitment.';
      submit.textContent = 'Create account';
      hint.innerHTML = 'Already have an account? <a href="#" data-mode="login">Log in</a>';
    } else {
      title.textContent = 'Make a Reel';
      sub.textContent = 'Tell us about the product. Our crew replies within one business day.';
      submit.textContent = 'Send brief';
      hint.innerHTML = 'Already have an account? <a href="#" data-mode="login">Log in</a>';
    }

    for (var i = 0; i < briefOnly.length; i += 1) {
      briefOnly[i].hidden = mode !== 'brief';
    }
    showError('');
  }

  function showError(message) {
    var box = $('#rm-error', dialog);
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  }

  function open(mode) {
    if (!dialog) {
      dialog = buildModal();
      document.body.appendChild(dialog);
      fillSelects();
      wireModal();
    }
    setMode(mode || 'brief');
    dialog.classList.add('open');
    document.body.classList.add('rm-locked');
    var first = dialog.querySelector('input, select');
    if (first && first.focus) first.focus();
  }

  function close() {
    if (!dialog) return;
    dialog.classList.remove('open');
    document.body.classList.remove('rm-locked');
  }

  function busy(isBusy, label) {
    var button = $('#rm-submit', dialog);
    if (!button) return;
    button.disabled = isBusy;
    button.textContent = isBusy ? (label || 'Sending…') : defaultLabel();
  }

  function defaultLabel() {
    if (currentMode === 'login') return 'Log in';
    if (currentMode === 'signup') return 'Create account';
    return 'Send brief';
  }

  function success(message) {
    var form = $('#rm-form', dialog);
    form.innerHTML = '<p class="rm-ok" role="status">' + message + '</p>';
  }

  function payloadFrom(form) {
    var data = {};
    var inputs = form.querySelectorAll('input, select, textarea');
    for (var i = 0; i < inputs.length; i += 1) {
      if (inputs[i].name) data[inputs[i].name] = inputs[i].value;
    }
    return data;
  }

  function wireModal() {
    dialog.addEventListener('click', function (event) {
      var modeLink = event.target.closest('[data-mode]');
      if (modeLink) {
        event.preventDefault();
        setMode(modeLink.getAttribute('data-mode'));
        return;
      }
      if (event.target.closest('[data-close]')) close();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') close();
    });

    $('#rm-form', dialog).addEventListener('submit', function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var data = payloadFrom(form);
      showError('');

      if (currentMode === 'login') {
        busy(true, 'Logging in…');
        api('/api/auth/login', { method: 'POST', body: { email: data.email, password: data.password } })
          .then(function (result) {
            setToken(result.token);
            success('Logged in as ' + result.user.name + '. Close this to send your brief.');
          })
          .catch(function (err) { showError(err.message); })
          .then(function () { busy(false); });
        return;
      }

      if (currentMode === 'signup') {
        busy(true, 'Creating…');
        api('/api/auth/signup', { method: 'POST', body: { name: data.name, email: data.email, password: data.password } })
          .then(function (result) {
            setToken(result.token);
            success('Account created. Close this to send your brief.');
          })
          .catch(function (err) { showError(err.message); })
          .then(function () { busy(false); });
        return;
      }

      busy(true, 'Sending…');
      api('/api/reels', { method: 'POST', body: data })
        .then(function () {
          success('Brief received. Our crew will reply within one business day.');
        })
        .catch(function (err) {
          if (err.status === 401) {
            showError('Please log in first — your brief is saved once you do.');
            setMode('login');
            return;
          }
          showError(err.message);
        })
        .then(function () { busy(false); });
    });
  }

  /* ---------- contact modal (reuses the panel shell) ---------- */

  function openContact() {
    open('contact');
    var title = $('#rm-modal-title', dialog);
    var sub = $('#rm-sub', dialog);
    var form = $('#rm-form', dialog);
    title.textContent = 'Talk to us';
    sub.textContent = 'Tell us what you are launching. We reply within one business day.';
    form.innerHTML = [
      '<div class="rm-field"><label for="rm-c-name">Name</label><input id="rm-c-name" name="name" maxlength="80" autocomplete="name" /></div>',
      '<div class="rm-field"><label for="rm-c-email">Email</label><input id="rm-c-email" name="email" type="email" maxlength="254" autocomplete="email" /></div>',
      '<div class="rm-field"><label for="rm-c-message">Message</label><textarea id="rm-c-message" name="message" rows="4" maxlength="2000"></textarea></div>',
      '<label class="rm-check"><input type="checkbox" name="newsletter" value="1" /> Send me occasional creator picks</label>',
      '<p class="rm-error" id="rm-error" role="alert" hidden></p>',
      '<button class="rm-submit" type="submit">Send message</button>',
    ].join('\n');

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var box = $('#rm-error', dialog);
      box.hidden = true;
      var button = form.querySelector('.rm-submit');
      button.disabled = true;
      button.textContent = 'Sending…';

      var data = payloadFrom(form);
      data.newsletter = !!form.querySelector('[name="newsletter"]').checked;

      api('/api/contact', { method: 'POST', body: data })
        .then(function (result) {
          form.innerHTML = '<p class="rm-ok" role="status">' + result.message + '</p>';
        })
        .catch(function (err) {
          box.textContent = err.message;
          box.hidden = false;
          button.disabled = false;
          button.textContent = 'Send message';
        });
    });
  }

  /* ---------- live counts ---------- */

  function hydrateCounts() {
    var badge = document.getElementById('badge');
    if (!badge) return;
    api('/api/meta').then(function (meta) {
      var creators = meta.counts && meta.counts.creators;
      if (creators) {
        badge.textContent = 'Trusted by ' + creators.toLocaleString('en-US') + '+ indie makers';
      }
    }).catch(function () { /* the static copy stays; never break the hero */ });
  }

  /* ---------- wiring ---------- */

  function intercept(selector, handler) {
    document.querySelectorAll(selector).forEach(function (element) {
      element.addEventListener('click', function (event) {
        event.preventDefault();
        handler(event);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    intercept('.cta', function () { open('brief'); });
    intercept('.signup', function () { open('signup'); });
    intercept('.login', function () { open('login'); });
    intercept('a[href="#contact"]', function () { openContact(); });
    intercept('.nav a[href="#pricing"], .nav a[href="#brands"], .nav a[href="#creators"], .nav a[href="#use-cases"]', function (event) {
      var target = document.querySelector(event.currentTarget.getAttribute('href'));
      if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else open('brief');
    });
    hydrateCounts();
  });
}());
