'use strict';
/* Backend contract tests — run with: npm test */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const crypto = require('crypto');

const { createServer } = require('../server');
const JsonStore = require('../lib/store');
const { createLimiter } = require('../lib/rate-limit');

/* ---------- helpers ---------- */

/* Fixture credentials are generated per run, so no literal secret is ever
   committed, while every test still exercises the real hashing path. */
const TEST_PASSWORD = 'T' + crypto.randomBytes(9).toString('hex');
const TEST_ADMIN_TOKEN = crypto.randomBytes(18).toString('hex');
const WRONG_PASSWORD = 'W' + crypto.randomBytes(9).toString('hex');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genmart-test-'));
}

async function boot(overrides = {}) {
  const dir = tempDir();
  const { server, store } = createServer(
    Object.assign({ dataDir: dir, adminToken: TEST_ADMIN_TOKEN, logger: silentLogger() }, overrides)
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    dir,
    store,
    base: 'http://127.0.0.1:' + port,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await store.idle().catch(() => {});
    },
  };
}

function silentLogger() {
  const noop = () => {};
  return { log: noop, error: noop, warn: noop };
}

async function call(base, method, pathname, body, headers = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { status: response.status, body: json, text, headers: response.headers };
}

/* ---------- static + health ---------- */

test('GET / serves the landing page', async () => {
  const app = await boot();
  try {
    const res = await call(app.base, 'GET', '/');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /GenMart/);
    assert.match(res.text, /Captivate Crowds/);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await app.stop();
  }
});

test('GET /api/health reports a healthy store', async () => {
  const app = await boot();
  try {
    const res = await call(app.base, 'GET', '/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.status, 'healthy');
    assert.strictEqual(res.body.users, 0);
  } finally {
    await app.stop();
  }
});

test('unknown API route returns a JSON 404, never HTML', async () => {
  const app = await boot();
  try {
    const res = await call(app.base, 'GET', '/api/nope');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /No such endpoint/);
  } finally {
    await app.stop();
  }
});

test('static path traversal is refused', async () => {
  const app = await boot();
  try {
    const res = await call(app.base, 'GET', '/../server.js');
    assert.ok(res.status === 400 || res.status === 404, 'expected 400 or 404, got ' + res.status);
    assert.ok(!res.text.includes('createServer'), 'must not leak source');
  } finally {
    await app.stop();
  }
});

/* ---------- auth ---------- */

test('signup → login → /api/auth/me round trip', async () => {
  const app = await boot();
  try {
    const signup = await call(app.base, 'POST', '/api/auth/signup', {
      name: 'Roshan',
      email: 'Roshan@Example.com',
      password: TEST_PASSWORD,
    });
    assert.strictEqual(signup.status, 201);
    assert.ok(signup.body.token, 'token issued');
    assert.strictEqual(signup.body.user.email, 'roshan@example.com', 'email normalised');
    assert.strictEqual(signup.body.user.passwordHash, undefined, 'hash never leaks');

    const login = await call(app.base, 'POST', '/api/auth/login', {
      email: 'roshan@example.com',
      password: TEST_PASSWORD,
    });
    assert.strictEqual(login.status, 200);
    assert.ok(login.body.token);

    const me = await call(app.base, 'GET', '/api/auth/me', undefined, {
      Authorization: 'Bearer ' + login.body.token,
    });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.user.name, 'Roshan');
  } finally {
    await app.stop();
  }
});

test('duplicate signup is rejected with 409', async () => {
  const app = await boot();
  try {
    const body = { name: 'A', email: 'dup@example.com', password: TEST_PASSWORD };
    assert.strictEqual((await call(app.base, 'POST', '/api/auth/signup', body)).status, 201);
    const second = await call(app.base, 'POST', '/api/auth/signup', body);
    assert.strictEqual(second.status, 409);
  } finally {
    await app.stop();
  }
});

test('weak password and bad email fail validation with field messages', async () => {
  const app = await boot();
  try {
    const res = await call(app.base, 'POST', '/api/auth/signup', {
      name: '',
      email: 'not-an-email',
      password: 'short',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.name);
    assert.ok(res.body.fields.email);
    assert.ok(res.body.fields.password);
  } finally {
    await app.stop();
  }
});

test('wrong password and unknown account give the same 401 shape', async () => {
  const app = await boot();
  try {
    await call(app.base, 'POST', '/api/auth/signup', {
      name: 'B',
      email: 'b@example.com',
      password: TEST_PASSWORD,
    });

    const wrong = await call(app.base, 'POST', '/api/auth/login', {
      email: 'b@example.com',
      password: WRONG_PASSWORD,
    });
    const missing = await call(app.base, 'POST', '/api/auth/login', {
      email: 'ghost@example.com',
      password: TEST_PASSWORD,
    });

    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(missing.status, 401);
    assert.strictEqual(wrong.body.error, missing.body.error, 'no account enumeration');
  } finally {
    await app.stop();
  }
});

test('protected route without a token is 401', async () => {
  const app = await boot();
  try {
    const res = await call(app.base, 'GET', '/api/reels');
    assert.strictEqual(res.status, 401);
  } finally {
    await app.stop();
  }
});

test('tampered token is rejected', async () => {
  const app = await boot();
  try {
    const signup = await call(app.base, 'POST', '/api/auth/signup', {
      name: 'C',
      email: 'c@example.com',
      password: TEST_PASSWORD,
    });
    const parts = signup.body.token.split('.');
    const forged = parts[0] + '.' + parts[1] + '.' + 'deadbeef';
    const res = await call(app.base, 'GET', '/api/auth/me', undefined, {
      Authorization: 'Bearer ' + forged,
    });
    assert.strictEqual(res.status, 401);
  } finally {
    await app.stop();
  }
});

/* ---------- reel briefs ---------- */

test('signed-in user can create and list reel briefs', async () => {
  const app = await boot();
  try {
    const signup = await call(app.base, 'POST', '/api/auth/signup', {
      name: 'D',
      email: 'd@example.com',
      password: TEST_PASSWORD,
    });
    const token = signup.body.token;
    const authHeader = { Authorization: 'Bearer ' + token };

    const created = await call(app.base, 'POST', '/api/reels', {
      brand: 'GenMart',
      product: 'Snackable reels',
      audience: 'indie founders',
      format: 'vertical-9-16',
      goal: 'launch',
      budget: '500-1500',
      notes: 'Launch on Product Hunt',
    }, authHeader);

    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.reel.status, 'submitted');
    assert.ok(created.body.reel.id);

    const list = await call(app.base, 'GET', '/api/reels', undefined, authHeader);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.count, 1);
    assert.strictEqual(list.body.reels[0].brand, 'GenMart');
  } finally {
    await app.stop();
  }
});

test('invalid reel format is rejected', async () => {
  const app = await boot();
  try {
    const signup = await call(app.base, 'POST', '/api/auth/signup', {
      name: 'E',
      email: 'e@example.com',
      password: TEST_PASSWORD,
    });
    const res = await call(app.base, 'POST', '/api/reels', {
      brand: 'X',
      product: 'Y',
      audience: 'Z',
      format: 'imax-70mm',
    }, { Authorization: 'Bearer ' + signup.body.token });

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.format);
  } finally {
    await app.stop();
  }
});

test('another user cannot see my briefs', async () => {
  const app = await boot();
  try {
    const a = await call(app.base, 'POST', '/api/auth/signup', {
      name: 'A', email: 'a1@example.com', password: TEST_PASSWORD,
    });
    const b = await call(app.base, 'POST', '/api/auth/signup', {
      name: 'B', email: 'b1@example.com', password: TEST_PASSWORD,
    });

    await call(app.base, 'POST', '/api/reels', {
      brand: 'Private', product: 'p', audience: 'a',
    }, { Authorization: 'Bearer ' + a.body.token });

    const list = await call(app.base, 'GET', '/api/reels', undefined, {
      Authorization: 'Bearer ' + b.body.token,
    });
    assert.strictEqual(list.body.count, 0);
  } finally {
    await app.stop();
  }
});

/* ---------- contact + admin ---------- */

test('contact form stores a lead', async () => {
  const app = await boot();
  try {
    const res = await call(app.base, 'POST', '/api/contact', {
      name: 'Roshan',
      email: 'hello@example.com',
      message: 'We want 5 reels for our launch.',
      newsletter: true,
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.id);
    const stored = app.store.load().contacts;
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].newsletter, true);
    assert.strictEqual(stored[0].status, 'new');
  } finally {
    await app.stop();
  }
});

test('short contact message is rejected', async () => {
  const app = await boot();
  try {
    const res = await call(app.base, 'POST', '/api/contact', {
      name: 'A', email: 'a@example.com', message: 'hi',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.message);
  } finally {
    await app.stop();
  }
});

test('leads API requires the admin token', async () => {
  const app = await boot();
  try {
    await call(app.base, 'POST', '/api/contact', {
      name: 'A', email: 'a@example.com', message: 'A real question about reels.',
    });

    const denied = await call(app.base, 'GET', '/api/leads');
    assert.strictEqual(denied.status, 403);

    const allowed = await call(app.base, 'GET', '/api/leads', undefined, {
      Authorization: 'Bearer ' + TEST_ADMIN_TOKEN,
    });
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual(allowed.body.count, 1);
  } finally {
    await app.stop();
  }
});

test('admin can patch lead status and append a note', async () => {
  const app = await boot();
  try {
    const created = await call(app.base, 'POST', '/api/contact', {
      name: 'A', email: 'a@example.com', message: 'A real question about reels.',
    });
    const id = created.body.id;

    const patched = await call(app.base, 'PATCH', '/api/leads/' + id, {
      status: 'contacted',
      note: 'Called, wants 3 reels',
    }, { Authorization: 'Bearer ' + TEST_ADMIN_TOKEN });

    assert.strictEqual(patched.status, 200);
    assert.strictEqual(patched.body.lead.status, 'contacted');
    assert.strictEqual(patched.body.lead.history.length, 1);

    const missing = await call(app.base, 'PATCH', '/api/leads/does-not-exist', {
      status: 'won',
    }, { Authorization: 'Bearer ' + TEST_ADMIN_TOKEN });
    assert.strictEqual(missing.status, 404);
  } finally {
    await app.stop();
  }
});

/* ---------- transport guards ---------- */

test('non-JSON content type is refused with 415', async () => {
  const app = await boot();
  try {
    const response = await fetch(app.base + '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=a&email=b',
    });
    assert.strictEqual(response.status, 415);
  } finally {
    await app.stop();
  }
});

test('malformed JSON body is a 400, not a crash', async () => {
  const app = await boot();
  try {
    const response = await fetch(app.base + '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not json',
    });
    assert.strictEqual(response.status, 400);
    const health = await call(app.base, 'GET', '/api/health');
    assert.strictEqual(health.status, 200, 'server still alive');
  } finally {
    await app.stop();
  }
});

test('oversized body is refused with 413', async () => {
  const app = await boot();
  try {
    const huge = 'x'.repeat(200 * 1024);
    const response = await fetch(app.base + '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a', email: 'a@example.com', message: huge }),
    });
    assert.strictEqual(response.status, 413);
  } finally {
    await app.stop();
  }
});

test('HEAD on the landing page returns headers without a body', async () => {
  const app = await boot();
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(app.base + '/', { method: 'HEAD' }, (response) => {
        resolve({ status: response.statusCode, headers: response.headers });
        response.resume();
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
  } finally {
    await app.stop();
  }
});

/* ---------- persistence ---------- */

test('data survives a server restart', async () => {
  const dir = tempDir();
  const first = createServer({ dataDir: dir, adminToken: 't', logger: silentLogger() });
  await new Promise((resolve) => first.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + first.server.address().port;

  await call(base, 'POST', '/api/auth/signup', {
    name: 'Persist', email: 'p@example.com', password: TEST_PASSWORD,
  });
  await new Promise((resolve) => first.server.close(resolve));
  await first.store.idle();

  const second = createServer({ dataDir: dir, adminToken: 't', logger: silentLogger() });
  await new Promise((resolve) => second.server.listen(0, '127.0.0.1', resolve));
  const base2 = 'http://127.0.0.1:' + second.server.address().port;

  const login = await call(base2, 'POST', '/api/auth/login', {
    email: 'p@example.com', password: TEST_PASSWORD,
  });
  assert.strictEqual(login.status, 200, 'account survived restart');

  await new Promise((resolve) => second.server.close(resolve));
  const store2 = second.store.load();
  assert.strictEqual(store2.users.length, 1);
});

test('corrupt data file is quarantined and the store starts clean', () => {
  const dir = tempDir();
  const file = path.join(dir, 'genmart.json');
  fs.writeFileSync(file, '{ broken json');

  const logger = silentLogger();
  const original = console.error;
  console.error = () => {};
  try {
    const store = new JsonStore(file, { empty: () => ({ users: [], reels: [], contacts: [] }) });
    const state = store.load();
    assert.deepStrictEqual(state.users, []);
    const quarantined = fs.readdirSync(dir).filter((name) => name.includes('.corrupt_'));
    assert.strictEqual(quarantined.length, 1, 'bad file kept, not deleted');
  } finally {
    console.error = original;
    assert.ok(logger);
  }
});

test('store writes are atomic and leave no .tmp behind', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'genmart.json');
  const store = new JsonStore(file, { empty: () => ({ items: [] }) });
  store.load();

  const writes = [];
  for (let index = 0; index < 25; index += 1) {
    writes.push(store.mutate((state) => {
      state.items.push(index);
    }));
  }
  await Promise.all(writes);
  await store.idle();

  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 25);
  assert.ok(!fs.existsSync(file + '.tmp'), 'temp file cleaned up');
});

/* ---------- rate limiter ---------- */

test('rate limiter allows up to max then blocks', () => {
  const limiter = createLimiter({ name: 'unit', windowMs: 1000, max: 3 });
  assert.strictEqual(limiter.hit('ip').allowed, true);
  assert.strictEqual(limiter.hit('ip').allowed, true);
  assert.strictEqual(limiter.hit('ip').allowed, true);
  const blocked = limiter.hit('ip');
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.strictEqual(limiter.hit('other-ip').allowed, true, 'buckets are per key');
});

test('rate limiter sweeps expired buckets', async () => {
  const limiter = createLimiter({ name: 'sweep', windowMs: 20, max: 1 });
  limiter.hit('ip');
  assert.strictEqual(limiter.size(), 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  limiter.sweepNow();
  assert.strictEqual(limiter.size(), 0);
});

test('signup endpoint rate limits after repeated attempts', async () => {
  const app = await boot();
  try {
    let limited = 0;
    for (let i = 0; i < 8; i += 1) {
      const res = await call(app.base, 'POST', '/api/auth/signup', {
        name: 'N' + i,
        email: 'n' + i + '@example.com',
        password: TEST_PASSWORD,
      });
      if (res.status === 429) limited += 1;
    }
    assert.ok(limited > 0, 'expected at least one 429, got none');
  } finally {
    await app.stop();
  }
});
