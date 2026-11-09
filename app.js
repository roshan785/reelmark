'use strict';
/*
 * app.js — all HTTP routes and business logic for GenMart.
 *
 * Layering:
 *   server.js  → transport (listen, static files, error boundary)
 *   app.js     → routes (this file)
 *   lib/*      → store, auth, validation, rate limiting, http helpers
 *
 * Every handler returns a JSON envelope: {ok:true, ...} or {ok:false, error}.
 * No handler throws to the client without a status; unexpected errors are
 * logged server-side and reported as a generic 500 (never a stack trace).
 */

const crypto = require('crypto');

const { Router, runChain, sendJson, readJsonBody } = require('./lib/http');
const { createLimiter, rateLimit } = require('./lib/rate-limit');
const auth = require('./lib/auth');
const V = require('./lib/validate');

function nowISO() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

/** Strip secrets before anything leaves the process. */
function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  };
}

function publicReel(reel) {
  return {
    id: reel.id,
    brand: reel.brand,
    product: reel.product,
    audience: reel.audience,
    format: reel.format,
    goal: reel.goal,
    budget: reel.budget,
    notes: reel.notes,
    status: reel.status,
    createdAt: reel.createdAt,
  };
}

function createApp(options = {}) {
  const store = options.store;
  if (!store) throw new Error('createApp requires a store');

  const secret = options.secret || auth.loadOrCreateSecret(options.secretFile || './data/session.key');
  const adminToken = options.adminToken || process.env.ADMIN_TOKEN || '';
  const logger = options.logger || console;

  const limiterSignup = createLimiter({ name: 'signup', windowMs: 15 * 60_000, max: 5 });
  const limiterLogin = createLimiter({ name: 'login', windowMs: 15 * 60_000, max: 10 });
  const limiterContact = createLimiter({ name: 'contact', windowMs: 60 * 60_000, max: 5 });
  const limiterReel = createLimiter({ name: 'reel', windowMs: 60 * 60_000, max: 20 });
  const limiterRead = createLimiter({ name: 'read', windowMs: 60_000, max: 240 });

  const router = new Router();

  /* ---------- middleware helpers ---------- */

  function bearer(req) {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : '';
  }

  /** Resolve the session user or answer 401 and return null. */
  function requireUser(req, res) {
    const token = bearer(req);
    if (!token) {
      sendJson(res, 401, { ok: false, error: 'Authentication required' });
      return null;
    }
    const claims = auth.verifyToken(token, secret);
    if (!claims) {
      sendJson(res, 401, { ok: false, error: 'Session expired or invalid' });
      return null;
    }
    const data = store.load();
    const user = data.users.find((candidate) => candidate.id === claims.uid);
    if (!user) {
      sendJson(res, 401, { ok: false, error: 'Account no longer exists' });
      return null;
    }
    return user;
  }

  /** Constant-time admin check; an unset ADMIN_TOKEN disables the surface. */
  function requireAdmin(req, res) {
    if (!adminToken) {
      sendJson(res, 403, { ok: false, error: 'Admin surface is disabled (ADMIN_TOKEN not set)' });
      return false;
    }
    const provided = Buffer.from(bearer(req) || String(req.headers['x-admin-token'] || ''));
    const expected = Buffer.from(adminToken);
    const same = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    if (!same) {
      sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return false;
    }
    return true;
  }

  function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim().slice(0, 60);
    }
    return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
  }

  /* ---------- system ---------- */

  router.get('/api/health', async (req, res) => {
    const data = store.load();
    sendJson(res, 200, {
      ok: true,
      status: 'healthy',
      uptimeSec: Math.round(process.uptime()),
      version: options.version || '1.0.0',
      users: data.users.length,
      reels: data.reels.length,
      contacts: data.contacts.length,
      time: nowISO(),
    });
  });

  router.get('/api/meta', rateLimit(limiterRead, clientIp), async (req, res) => {
    const data = store.load();
    sendJson(res, 200, {
      ok: true,
      site: 'GenMart',
      tagline: 'Captivate Crowds with Snackable Reels',
      formats: V.REEL_FORMATS,
      goals: V.REEL_GOALS,
      budgets: V.BUDGET_BANDS,
      counts: {
        creators: 120000,
        briefs: data.reels.length,
        delivered: data.reels.filter((reel) => reel.status === 'delivered').length,
      },
    });
  });

  /* ---------- auth ---------- */

  router.post('/api/auth/signup', rateLimit(limiterSignup, clientIp), async (req, res) => {
    const input = V.validateSignup(await readJsonBody(req));
    const data = store.load();
    const existing = data.users.find((user) => user.email === input.email);
    if (existing) {
      sendJson(res, 409, { ok: false, error: 'An account with that email already exists' });
      return;
    }

    const user = {
      id: newId(),
      name: input.name,
      email: input.email,
      passwordHash: auth.hashPassword(input.password),
      createdAt: nowISO(),
    };
    await store.mutate((state) => {
      state.users.push(user);
    });

    sendJson(res, 201, {
      ok: true,
      token: auth.createToken({ uid: user.id }, secret),
      user: publicUser(user),
    });
  });

  router.post('/api/auth/login', rateLimit(limiterLogin, clientIp), async (req, res) => {
    const input = V.validateLogin(await readJsonBody(req));
    const data = store.load();
    const user = data.users.find((candidate) => candidate.email === input.email);

    if (!user) {
      auth.fakeVerify(input.password);
      sendJson(res, 401, { ok: false, error: 'Invalid email or password' });
      return;
    }
    if (!auth.verifyPassword(input.password, user.passwordHash)) {
      sendJson(res, 401, { ok: false, error: 'Invalid email or password' });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      token: auth.createToken({ uid: user.id }, secret),
      user: publicUser(user),
    });
  });

  router.get('/api/auth/me', rateLimit(limiterRead, clientIp), async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    sendJson(res, 200, { ok: true, user: publicUser(user) });
  });

  /* ---------- reel briefs ---------- */

  router.post('/api/reels', rateLimit(limiterReel, clientIp), async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const input = V.validateReelBrief(await readJsonBody(req));
    const reel = Object.assign({ id: newId(), userId: user.id, status: 'submitted', createdAt: nowISO() }, input);

    await store.mutate((state) => {
      state.reels.push(reel);
    });

    logger.log('[reels] brief created id=' + reel.id + ' user=' + user.id);
    sendJson(res, 201, { ok: true, reel: publicReel(reel) });
  });

  router.get('/api/reels', rateLimit(limiterRead, clientIp), async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const data = store.load();
    const mine = data.reels
      .filter((reel) => reel.userId === user.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(publicReel);
    sendJson(res, 200, { ok: true, reels: mine, count: mine.length });
  });

  /* ---------- contact / leads ---------- */

  router.post('/api/contact', rateLimit(limiterContact, clientIp), async (req, res) => {
    const input = V.validateContact(await readJsonBody(req));
    const lead = Object.assign(
      { id: newId(), status: 'new', createdAt: nowISO(), sourceIp: clientIp(req) },
      input
    );

    await store.mutate((state) => {
      state.contacts.push(lead);
    });

    logger.log('[contact] lead created id=' + lead.id + ' email=' + lead.email);
    sendJson(res, 201, {
      ok: true,
      message: 'Thanks — our crew will reply within one business day.',
      id: lead.id,
    });
  });

  router.get('/api/leads', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const data = store.load();
    const leads = data.contacts.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    sendJson(res, 200, { ok: true, leads, count: leads.length });
  });

  router.patch('/api/leads/:id', async (req, res, params) => {
    if (!requireAdmin(req, res)) return;
    const patch = V.validateLeadPatch(await readJsonBody(req));
    const data = store.load();
    const lead = data.contacts.find((candidate) => candidate.id === params.id);
    if (!lead) {
      sendJson(res, 404, { ok: false, error: 'Lead not found' });
      return;
    }

    await store.mutate(() => {
      if (patch.status) lead.status = patch.status;
      if (patch.note) {
        if (!Array.isArray(lead.history)) lead.history = [];
        lead.history.push({ at: nowISO(), note: patch.note });
      }
      lead.updatedAt = nowISO();
    });

    sendJson(res, 200, { ok: true, lead });
  });

  /* ---------- 404 for unknown API routes ---------- */

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    const matched = router.match(req.method, pathname);
    if (!matched) {
      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { ok: false, error: 'No such endpoint: ' + req.method + ' ' + pathname });
      } else {
        sendJson(res, 404, { ok: false, error: 'Not found' });
      }
      return;
    }

    try {
      await runChain(matched.handlers, req, res, matched.params);
    } catch (err) {
      if (err instanceof V.ValidationError) {
        sendJson(res, 400, { ok: false, error: 'Please check the form', fields: err.fields });
        return;
      }
      const status = Number(err && err.status);
      if (Number.isFinite(status) && status >= 400 && status < 500) {
        sendJson(res, status, { ok: false, error: err.message });
        return;
      }
      logger.error('[app] unhandled error on ' + req.method + ' ' + pathname + ':', err && err.message);
      sendJson(res, 500, { ok: false, error: 'Something went wrong on our side' });
    }
  }

  return { handle, router, store, secret };
}

module.exports = { createApp, publicUser, publicReel };
