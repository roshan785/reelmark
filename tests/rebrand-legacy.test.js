'use strict';
/*
 * tests/rebrand-legacy.test.js — the Reelmark → GenMart rename must not log
 * anybody out and must not lose existing data.
 *
 * Two things are proven here, because both are silent failures otherwise:
 *   • a browser holding the old `reelmark.*` localStorage keys is migrated to
 *     `genmart.*` on load, and the account pills show the signed-in user
 *   • a data directory containing the old `reelmark.json` is carried forward to
 *     `genmart.json` on boot, with every account and lead intact
 *
 * Skipped (not failed) without a Chrome binary, matching ui.test.js.
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

/* Generated per run, matching api.test.js: no literal secret is committed. */
const ADMIN_TOKEN = crypto.randomBytes(18).toString('hex');

function startServer(dataDir) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'genmart-rebrand-'));
  const { server, store } = createServer({
    dataDir: dir,
    adminToken: ADMIN_TOKEN,
    logger: { log() {}, error() {}, warn() {} },
  });
  return { dir, server, store };
}

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + app.server.address().port;
}

async function stop(app) {
  await new Promise((resolve) => app.server.close(resolve));
  await app.store.idle().catch(() => {});
}

test('boot migrates reelmark.json to genmart.json without losing data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genmart-rebrand-'));
  const legacy = {
    users: [{ id: 'u1', name: 'Sita', email: 's@example.com', passwordHash: 'x', createdAt: '2026-01-01T00:00:00.000Z' }],
    reels: [],
    contacts: [{ id: 'c1', status: 'new', name: 'Lead', email: 'l@example.com', message: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }],
  };
  fs.writeFileSync(path.join(dir, 'reelmark.json'), JSON.stringify(legacy, null, 2));

  const app = startServer(dir);
  await listen(app);
  try {
    const names = fs.readdirSync(dir);
    assert.ok(names.includes('genmart.json'), 'current state file should exist');
    assert.ok(!names.includes('reelmark.json'), 'legacy file should be renamed, not copied');

    const state = app.store.load();
    assert.strictEqual(state.users.length, 1, 'account survived');
    assert.strictEqual(state.users[0].email, 's@example.com');
    assert.strictEqual(state.contacts.length, 1, 'lead survived');
  } finally {
    await stop(app);
  }
});

test('a second boot does not touch an existing genmart.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genmart-rebrand-'));
  fs.writeFileSync(path.join(dir, 'genmart.json'), JSON.stringify({ users: [{ id: 'a' }, { id: 'b' }], reels: [], contacts: [] }));
  /* A stale legacy file must never overwrite the live one. */
  fs.writeFileSync(path.join(dir, 'reelmark.json'), JSON.stringify({ users: [], reels: [], contacts: [] }));

  const app = startServer(dir);
  await listen(app);
  try {
    const state = app.store.load();
    assert.strictEqual(state.users.length, 2, 'live data wins over stale legacy file');
  } finally {
    await stop(app);
  }
});

test('UI: legacy reelmark.* session keys are adopted as genmart.*', { skip: !CHROME && 'no chrome' }, async () => {
  const app = startServer();
  const base = await listen(app);
  const email = 'legacy' + crypto.randomBytes(6).toString('hex') + '@example.com';
  const password = 'L' + crypto.randomBytes(9).toString('hex');

  /* A REAL account + REAL token, because the page revalidates the token against
     /api/auth/me on boot — a fake token would (correctly) be logged out. */
  const signup = await fetch(base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sita Sharma', email, password }),
  });
  assert.strictEqual(signup.status, 201);
  const account = await signup.json();
  assert.ok(account.token && account.token.length > 20, 'server issued a real token');

  const session = await B.launchChrome();
  try {
    await B.enablePage(session);
    await B.goto(session, base);

    /* A returning visitor only has the pre-rename keys. */
    await B.evaluate(session, `
      localStorage.removeItem('genmart.token');
      localStorage.removeItem('genmart.user');
      localStorage.setItem('reelmark.token', ${JSON.stringify(account.token)});
      localStorage.setItem('reelmark.user', ${JSON.stringify(JSON.stringify(account.user))});
      true;
    `);

    await B.goto(session, base + '/?rebrand=' + Date.now());
    await B.sleep(600);

    const seen = await B.evaluate(session, `({
      token: localStorage.getItem('genmart.token') || '',
      user: localStorage.getItem('genmart.user') || '',
      legacyToken: localStorage.getItem('reelmark.token'),
      legacyUser: localStorage.getItem('reelmark.user'),
      pills: Array.from(document.querySelectorAll('.account-actions .pill')).map(function (e) { return e.textContent.trim(); }),
      brand: (document.querySelector('.brand-name') || {}).textContent || '',
      title: document.title
    })`);

    assert.strictEqual(seen.token, account.token, 'token carried forward');
    assert.strictEqual(JSON.parse(seen.user).email, email, 'user carried forward');
    assert.strictEqual(seen.legacyToken, null, 'legacy token key cleared');
    assert.strictEqual(seen.legacyUser, null, 'legacy user key cleared');
    assert.strictEqual(seen.pills[0], 'Sita', 'header shows the signed-in user, not Log in');
    assert.strictEqual(seen.pills[1], 'Sign out', 'still signed in after the rebrand');
    assert.strictEqual(seen.brand, 'GenMart', 'brand shows GenMart');
    assert.match(seen.title, /GenMart/, 'title shows GenMart');
    assert.doesNotMatch(seen.title, /Reelmark/, 'title no longer mentions Reelmark');
  } finally {
    await session.close();
    await stop(app);
  }
});
