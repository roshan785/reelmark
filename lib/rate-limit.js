'use strict';
/*
 * rate-limit.js — dependency-free fixed-window rate limiter.
 *
 * Fixed windows are deliberate: no per-request allocation beyond a counter.
 *
 * Timer discipline (this is where naive limiters leak):
 *   • exactly ONE setInterval per process, created at module load and unref'd,
 *     so it never keeps the process alive
 *   • every limiter registers its own sweep closure in a process-wide registry,
 *     so buckets of ALL limiters are reclaimed — not just the first one's
 *   • registry entries are never duplicated because registration happens once
 *     per createLimiter() call, not per request
 */

const SWEEP_INTERVAL_MS = 60_000;

const { sendJson } = require('./http');

/** @type {Array<() => void>} sweep closures, one per live limiter */
const sweepers = [];
let sweepTimer = null;

function ensureSweepTimer() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    for (const sweep of sweepers) {
      try {
        sweep();
      } catch (_) {
        /* a broken sweeper must never kill the timer */
      }
    }
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

function createLimiter({ windowMs, max, name }) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be > 0');
  if (!Number.isFinite(max) || max <= 0) throw new Error('max must be > 0');

  const buckets = new Map();

  function sweep() {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of buckets) {
      if (entry.resetAt <= cutoff) buckets.delete(key);
    }
  }

  sweepers.push(sweep);
  ensureSweepTimer();

  return {
    name,
    /** @returns {{allowed: boolean, remaining: number, retryAfterSec: number}} */
    hit(key) {
      const now = Date.now();
      let entry = buckets.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        buckets.set(key, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= max,
        remaining: Math.max(0, max - entry.count),
        retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    },
    reset(key) {
      buckets.delete(key);
    },
    size() {
      return buckets.size;
    },
    /** Test hook: run this limiter's sweep immediately. */
    sweepNow: sweep,
  };
}

/**
 * Middleware factory. `keyOf` decides the bucket for a request.
 * Signature matches the router chain: (req, res, params, next).
 */
function rateLimit(limiter, keyOf) {
  return function rateLimitMiddleware(req, res, params, next) {
    const key = keyOf ? keyOf(req) : req.socket.remoteAddress || 'unknown';
    const result = limiter.hit(key);
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSec));
      sendJson(res, 429, {
        ok: false,
        error: 'Too many requests. Try again in ' + result.retryAfterSec + 's.',
      });
      return;
    }
    next();
  };
}

module.exports = { createLimiter, rateLimit, sweeperCount: () => sweepers.length };
