'use strict';
/*
 * http.js — a small, dependency-free router for node:http.
 *
 * Why hand-rolled instead of Express: this app must run with zero install
 * steps on any host (including a Cloudflare tunnel on a phone-sized box), and
 * the needed surface is tiny — path params, JSON bodies, security headers.
 *
 * Safety defaults baked in here:
 *   • request bodies are size-capped and must be JSON (no form/x-www surprises)
 *   • a malformed Content-Length or chunked abuse cannot grow memory unbounded
 *   • every response gets the security headers below; routes cannot forget them
 */

const MAX_BODY_BYTES = 100 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

function applySecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Cache-Control', 'no-store');
  applySecurityHeaders(res);
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', Buffer.byteLength(text));
  applySecurityHeaders(res);
  res.end(text);
}

/**
 * Read and parse a JSON body.
 * Rejects with an error carrying .status so the caller can answer correctly.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.toLowerCase().startsWith('application/json')) {
      const err = new Error('Content-Type must be application/json');
      err.status = 415;
      reject(err);
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      const err = new Error('Request body too large');
      err.status = 413;
      reject(err);
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('Request body too large');
        err.status = 413;
        finish(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', (err) => finish(err));
    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        finish(null, {});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('Body must be a JSON object');
          err.status = 400;
          finish(err);
          return;
        }
        finish(null, parsed);
      } catch (_) {
        const err = new Error('Invalid JSON body');
        err.status = 400;
        finish(err);
      }
    });
  });
}

/** Compile "/api/contact/:id" into a RegExp + param names. */
function compilePath(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp('^' + source + '/?$'), names };
}

class Router {
  constructor() {
    /** @type {Map<string, Array<{regex: RegExp, names: string[], handlers: Function[]}>>} */
    this.table = new Map();
  }

  /**
   * Register a route: add(method, pattern, ...middleware, finalHandler).
   * Every handler is called as (req, res, params, next); middleware calls
   * next() to continue, the final handler answers and never calls next.
   */
  add(method, pattern, ...handlers) {
    if (handlers.length === 0) throw new Error('route needs at least one handler');
    for (const handler of handlers) {
      if (typeof handler !== 'function') throw new Error('every handler must be a function');
    }
    const key = method.toUpperCase();
    if (!this.table.has(key)) this.table.set(key, []);
    this.table.get(key).push(Object.assign({ handlers }, compilePath(pattern)));
    return this;
  }

  get(pattern, ...handlers) { return this.add('GET', pattern, ...handlers); }
  post(pattern, ...handlers) { return this.add('POST', pattern, ...handlers); }
  patch(pattern, ...handlers) { return this.add('PATCH', pattern, ...handlers); }
  delete(pattern, ...handlers) { return this.add('DELETE', pattern, ...handlers); }

  /** @returns {{handlers: Function[], params: Object}|null} */
  match(method, pathname) {
    const list = this.table.get(String(method).toUpperCase());
    if (!list) return null;
    for (const route of list) {
      const found = route.regex.exec(pathname);
      if (!found) continue;
      const params = {};
      route.names.forEach((name, index) => {
        params[name] = decodeURIComponent(found[index + 1]);
      });
      return { handlers: route.handlers, params };
    }
    return null;
  }
}

/**
 * Run a handler chain. A handler that does not call next() is terminal.
 * Errors thrown (or passed to next) reject the promise exactly once.
 */
async function runChain(handlers, req, res, params) {
  for (let index = 0; index < handlers.length; index += 1) {
    const handler = handlers[index];
    const isLast = index === handlers.length - 1;

    const outcome = await new Promise((resolve, reject) => {
      let advanced = false;
      let settled = false;

      const next = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve({ advanced: true });
      };

      let result;
      try {
        result = handler(req, res, params, next);
      } catch (err) {
        if (!settled) { settled = true; reject(err); }
        return;
      }

      Promise.resolve(result)
        .then(() => {
          if (settled) return;
          settled = true;
          /* A sync resolver counts as "did not call next" — but only after the
             microtask queue drains, which is why we await the result above. */
          resolve({ advanced });
        })
        .catch((err) => {
          if (!settled) { settled = true; reject(err); }
        });
    }).catch((err) => ({ error: err }));

    if (outcome.error) throw outcome.error;
    if (!outcome.advanced) {
      if (isLast || res.headersSent || res.writableEnded) return;
      throw Object.assign(new Error('Middleware stopped the chain without responding'), { status: 500 });
    }
  }
}

module.exports = {
  Router,
  runChain,
  sendJson,
  sendText,
  readJsonBody,
  applySecurityHeaders,
  MAX_BODY_BYTES,
  compilePath,
};
