'use strict';
/*
 * tests/ui.test.js — real-browser verification of the landing page UI.
 *
 * These tests drive a headless Chrome against the real server, because the bugs
 * this file guards against cannot be proven from static markup:
 *   • the auth form used to have no email/password inputs at all
 *   • the contact form double-submitted into /api/reels and flipped to login
 *   • nav links pointed at #brands/#pricing/… which had no target and no handler
 *
 * Skipped (not failed) when no Chrome binary is present, so CI without a browser
 * stays green while a developer machine still gets the real check.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const B = require('./browser-helpers');
const { createServer } = require('../server');

const CHROME = B.findChrome();

/* Credentials are generated per run: no literal ever lands in the source. */
function randomPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function withBrowser(fn) {
  const session = await B.launchChrome();
  if (!session) {
    throw new Error('headless Chrome could not start');
  }
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genmart-ui-data-'));
  const { server, store } = createServer({
    dataDir: dir,
    adminToken: randomToken(),
    logger: { log() {}, error() {}, warn() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: 'http://127.0.0.1:' + port,
    store,
    async close() {
      store.flushSync();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Poll `expression` in the page until it is truthy, or throw after `timeout`. */
async function waitFor(session, expression, timeout) {
  const deadline = Date.now() + (timeout || 6000);
  const maxAttempts = 400;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const value = await B.evaluate(session, expression);
    if (value) return value;
    if (Date.now() > deadline) break;
    await B.sleep(80);
  }
  throw new Error('timed out waiting for: ' + expression);
}

test('UI: hero renders and the Make a Reel CTA opens the brief panel', { skip: !CHROME && 'no chrome' }, async () => {
  const app = await startServer();
  await withBrowser(async (session) => {
    await B.enablePage(session);
    await B.goto(session, app.url);

    const title = await B.evaluate(session, 'document.title');
    assert.match(title, /GenMart/);

    await B.evaluate(session, "document.querySelector('.cta').click()");
    const open = await waitFor(session, "!!document.querySelector('#rm-modal.open')");
    assert.ok(open, 'modal should be open');

    const mode = await B.evaluate(session, 'window.__genmart.mode()');
    assert.strictEqual(mode, 'brief');

    const fields = await B.evaluate(
      session,
      "Array.from(document.querySelectorAll('#rm-form [name]')).map(function (e) { return e.name; })"
    );
    for (const name of ['brand', 'product', 'audience', 'format', 'goal', 'budget', 'notes']) {
      assert.ok(fields.includes(name), 'brief form should include ' + name);
    }

    /* Selects must be populated, otherwise a submit posts empty strings. */
    const optionCount = await B.evaluate(session, "document.querySelectorAll('#rm-format option').length");
    assert.strictEqual(optionCount, 3, 'format select should have the three formats');

    await app.close();
  });
});

test('UI: log in panel has real email + password inputs and an animation', { skip: !CHROME && 'no chrome' }, async () => {
  const app = await startServer();
  await withBrowser(async (session) => {
    await B.enablePage(session);
    await B.goto(session, app.url);

    await B.evaluate(session, "document.querySelector('.login').click()");
    await waitFor(session, "!!document.querySelector('#rm-modal.open')");

    /* THE BUG THIS GUARDS: the old build built one shared form with no email or
       password field, so login always posted {email: undefined}. */
    const names = await B.evaluate(
      session,
      "Array.from(document.querySelectorAll('#rm-form [name]')).map(function (e) { return e.name; })"
    );
    assert.ok(names.includes('email'), 'login form must expose an email input');
    assert.ok(names.includes('password'), 'login form must expose a password input');

    const passwordType = await B.evaluate(
      session,
      "document.querySelector('#rm-form [name=password]').type"
    );
    assert.strictEqual(passwordType, 'password');

    /* The panel must actually animate: opacity goes from 0 to 1 via a CSS
       transition, so a mid-flight sample is strictly between the endpoints. */
    const transition = await B.evaluate(
      session,
      "getComputedStyle(document.querySelector('#rm-modal .rm-panel')).transitionDuration"
    );
    assert.notStrictEqual(transition, '0s', 'panel should declare a transition');

    /* Sample while the transition is still running: the panel was just mounted,
       so opacity must be below 1 at least once. This proves a real animation
       rather than an instant paint. */
    const midFlight = await B.evaluate(
      session,
      "Number(getComputedStyle(document.querySelector('#rm-modal .rm-panel')).opacity) < 1"
    );
    assert.ok(midFlight, 'panel should still be fading in right after mount');

    const settled = await waitFor(
      session,
      "Number(getComputedStyle(document.querySelector('#rm-modal .rm-panel')).opacity) > 0.99 && true",
      4000
    );
    assert.ok(settled, 'panel should settle fully visible within the transition window');

    await app.close();
  });
});

test('UI: sign up creates a real account and the header switches to the user', { skip: !CHROME && 'no chrome' }, async () => {
  const app = await startServer();
  await withBrowser(async (session) => {
    await B.enablePage(session);
    await B.goto(session, app.url);

    await B.evaluate(session, "document.querySelector('.signup').click()");
    await waitFor(session, "!!document.querySelector('#rm-modal.open')");

    const email = 'ui-' + crypto.randomBytes(4).toString('hex') + '@example.com';
    const password = randomPassword();

    await B.evaluate(session, `
      (function () {
        var form = document.querySelector('#rm-form');
        form.querySelector('[name=name]').value = 'Roshan Test';
        form.querySelector('[name=email]').value = ${JSON.stringify(email)};
        form.querySelector('[name=password]').value = ${JSON.stringify(password)};
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }())
    `);

    await waitFor(session, "!!document.querySelector('#rm-modal .rm-success')");

    const token = await B.evaluate(session, "localStorage.getItem('genmart.token') || ''");
    assert.ok(token.length > 20, 'a session token should be stored');

    const pills = await B.evaluate(
      session,
      "Array.from(document.querySelectorAll('.account-actions .pill')).map(function (e) { return e.textContent.trim(); })"
    );
    assert.ok(pills.includes('Sign out'), 'signed-in header should offer Sign out, got ' + pills.join('|'));

    /* The account really landed in the store, not just in localStorage. */
    const state = app.store.load();
    assert.ok(
      state.users.some((user) => user.email === email),
      'created user should be persisted server-side'
    );

    await app.close();
  });
});

test('UI: an invalid signup shows a per-field error under the input', { skip: !CHROME && 'no chrome' }, async () => {
  const app = await startServer();
  await withBrowser(async (session) => {
    await B.enablePage(session);
    await B.goto(session, app.url);

    await B.evaluate(session, "document.querySelector('.signup').click()");
    await waitFor(session, "!!document.querySelector('#rm-modal.open')");

    await B.evaluate(session, `
      (function () {
        var form = document.querySelector('#rm-form');
        form.querySelector('[name=name]').value = '';
        form.querySelector('[name=email]').value = 'not-an-email';
        form.querySelector('[name=password]').value = '123';
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }())
    `);

    await waitFor(session, "!!document.querySelector('#rm-form .rm-fielderr')");

    const messages = await B.evaluate(
      session,
      "Array.from(document.querySelectorAll('#rm-form .rm-fielderr')).map(function (e) { return e.textContent; })"
    );
    const joined = messages.join(' | ');
    assert.match(joined, /required/i, 'name should be reported required, got ' + joined);
    assert.match(joined, /email/i, 'email should be reported invalid, got ' + joined);
    assert.match(joined, /8 characters/i, 'password length should be reported, got ' + joined);

    await app.close();
  });
});

test('UI: contact form posts once to /api/contact and never to /api/reels', { skip: !CHROME && 'no chrome' }, async () => {
  const app = await startServer();
  await withBrowser(async (session) => {
    await B.enablePage(session);
    await B.goto(session, app.url);

    /* Count requests per endpoint so a double-submit shows up as 2, not 1. */
    await B.evaluate(session, `
      (function () {
        window.__calls = [];
        var realFetch = window.fetch;
        window.fetch = function (input, init) {
          window.__calls.push({
            url: String(typeof input === 'string' ? input : input.url),
            method: (init && init.method) || 'GET',
          });
          return realFetch.apply(this, arguments);
        };
      }())
    `);

    await B.evaluate(session, "document.querySelector('a[href=\"#contact\"]').click()");
    await waitFor(session, "!!document.querySelector('#rm-modal.open')");

    const mode = await B.evaluate(session, 'window.__genmart.mode()');
    assert.strictEqual(mode, 'contact', 'contact link should open the contact panel');

    await B.evaluate(session, `
      (function () {
        var form = document.querySelector('#rm-form');
        form.querySelector('[name=name]').value = 'Browser Lead';
        form.querySelector('[name=email]').value = 'lead-browser@example.com';
        form.querySelector('[name=message]').value = 'We need four reels for a launch next month.';
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }())
    `);

    await waitFor(session, "!!document.querySelector('#rm-modal .rm-success')");

    const calls = await B.evaluate(session, 'window.__calls');
    const posts = calls.filter((call) => call.method === 'POST');
    assert.strictEqual(posts.length, 1, 'exactly one POST expected, got ' + JSON.stringify(posts));
    assert.strictEqual(posts[0].url, '/api/contact');

    const state = app.store.load();
    assert.strictEqual(state.contacts.length, 1, 'exactly one lead should be stored');

    await app.close();
  });
});

test('UI: every nav link opens a panel instead of a dead anchor', { skip: !CHROME && 'no chrome' }, async () => {
  const app = await startServer();
  await withBrowser(async (session) => {
    await B.enablePage(session);
    await B.goto(session, app.url);

    const hrefs = await B.evaluate(
      session,
      "Array.from(document.querySelectorAll('.nav a')).map(function (a) { return a.getAttribute('href'); })"
    );
    assert.deepStrictEqual(hrefs, ['#brands', '#creators', '#pricing', '#use-cases', '#contact']);

    for (const href of hrefs) {
      const expected = href.slice(1) === 'contact' ? 'contact' : href.slice(1);
      await B.evaluate(session, 'window.__genmart.close()');
      await B.sleep(80);
      await B.evaluate(session, `document.querySelector('.nav a[href="${href}"]').click()`);
      await waitFor(session, "!!document.querySelector('#rm-modal.open')");
      const mode = await B.evaluate(session, 'window.__genmart.mode()');
      assert.strictEqual(mode, expected, href + ' should open the ' + expected + ' panel');
      const body = await B.evaluate(session, "document.querySelector('#rm-body').textContent.trim().length");
      assert.ok(body > 40, href + ' panel should have content');
    }

    await app.close();
  });
});

test('UI: dashboard lists only the signed-in user\'s briefs', { skip: !CHROME && 'no chrome' }, async () => {
  const app = await startServer();
  await withBrowser(async (session) => {
    await B.enablePage(session);
    await B.goto(session, app.url);

    /* Seed one account with a brief and one without, over the real HTTP API. */
    const email = 'dash-' + crypto.randomBytes(4).toString('hex') + '@example.com';
    const password = randomPassword();

    const created = await fetch(app.url + '/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Dash User', email: email, password: password }),
    }).then((r) => r.json());

    await fetch(app.url + '/api/reels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + created.token },
      body: JSON.stringify({
        brand: 'DashBrand',
        product: 'Dash Product',
        audience: 'indie founders',
        format: 'vertical-9-16',
        goal: 'launch',
        budget: 'under-500',
        notes: 'seeded by the UI test',
      }),
    });

    /* Sign the page in through the real login panel. */
    await B.evaluate(session, "document.querySelector('.login').click()");
    await waitFor(session, "!!document.querySelector('#rm-modal.open')");
    await B.evaluate(session, `
      (function () {
        var form = document.querySelector('#rm-form');
        form.querySelector('[name=email]').value = ${JSON.stringify(email)};
        form.querySelector('[name=password]').value = ${JSON.stringify(password)};
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }())
    `);
    await waitFor(session, "!!document.querySelector('#rm-modal .rm-success')");

    await B.evaluate(session, 'window.__genmart.dashboard()');
    await waitFor(session, "document.querySelectorAll('#rm-dash .rm-brief').length > 0");

    const brands = await B.evaluate(
      session,
      "Array.from(document.querySelectorAll('#rm-dash .rm-brief h3')).map(function (h) { return h.textContent; })"
    );
    assert.deepStrictEqual(brands, ['DashBrand']);

    const stats = await B.evaluate(
      session,
      "Array.from(document.querySelectorAll('#rm-dash .rm-stat-num')).map(function (n) { return n.textContent; })"
    );
    assert.deepStrictEqual(stats, ['1', '1', '0']);

    await app.close();
  });
});

test('UI: submitting a brief while signed out routes to login and keeps the intent', { skip: !CHROME && 'no chrome' }, async () => {
  const app = await startServer();
  await withBrowser(async (session) => {
    await B.enablePage(session);
    await B.goto(session, app.url);

    await B.evaluate(session, "document.querySelector('.cta').click()");
    await waitFor(session, "!!document.querySelector('#rm-modal.open')");

    await B.evaluate(session, `
      (function () {
        var form = document.querySelector('#rm-form');
        form.querySelector('[name=brand]').value = 'Anon';
        form.querySelector('[name=product]').value = 'Anon Product';
        form.querySelector('[name=audience]').value = 'nobody yet';
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }())
    `);

    await waitFor(session, "window.__genmart.mode() === 'login'");
    const error = await B.evaluate(session, "document.querySelector('#rm-error').textContent");
    assert.match(error, /log in|account/i);

    const reels = app.store.load().reels;
    assert.strictEqual(reels.length, 0, 'no brief may be stored without a session');

    await app.close();
  });
});
