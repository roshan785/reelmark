'use strict';
/*
 * server.js — transport layer for GenMart.
 *
 * Responsibilities (and nothing else):
 *   • serve public/ statically, with ETag + cache-busting-friendly headers
 *   • hand /api/* to app.js
 *   • own the error boundary: a thrown handler can never crash the process
 *   • graceful shutdown on SIGINT/SIGTERM (finish in-flight writes first)
 *
 * Env:
 *   PORT          listen port (default 4000)
 *   HOST          bind address (default 127.0.0.1 — tunnels connect locally)
 *   DATA_DIR      where genmart.json / session.key live (default ./data)
 *   ADMIN_TOKEN   enables GET /api/leads + PATCH /api/leads/:id
 *   TRUST_PROXY   '1' to trust X-Forwarded-For (required behind a tunnel)
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const { createApp } = require('./app');
const JsonStore = require('./lib/store');
const { sendJson, sendText, applySecurityHeaders } = require('./lib/http');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_STATIC_BYTES = 25 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const EMPTY_STATE = () => ({ users: [], reels: [], contacts: [] });

const STATE_FILE = 'genmart.json';
const LEGACY_STATE_FILE = 'reelmark.json';

/**
 * Carry an existing data file forward across the rebrand. Runs once: if the
 * current file is missing but the pre-rename one is present, it is renamed so
 * accounts and leads survive. A failure here must never stop the server —
 * the store simply starts empty instead of crashing on boot.
 */
function migrateLegacyState(dir) {
  const target = path.join(dir, STATE_FILE);
  const legacy = path.join(dir, LEGACY_STATE_FILE);
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return false;
  try {
    fs.renameSync(legacy, target);
    console.log('[genmart] migrated ' + LEGACY_STATE_FILE + ' -> ' + STATE_FILE);
    return true;
  } catch (err) {
    console.error('[genmart] could not migrate ' + LEGACY_STATE_FILE + ':', err.message);
    return false;
  }
}

function buildStore(dataDir) {
  const dir = path.resolve(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  migrateLegacyState(dir);
  const store = new JsonStore(path.join(dir, STATE_FILE), { empty: EMPTY_STATE });
  const state = store.load();
  /* Repair a partially-shaped file instead of crashing on first request. */
  let repaired = false;
  for (const key of ['users', 'reels', 'contacts']) {
    if (!Array.isArray(state[key])) {
      state[key] = [];
      repaired = true;
    }
  }
  if (repaired) {
    store.dirty = true;
    store.flushSync();
  }
  return store;
}

/** Resolve a request path inside PUBLIC_DIR, or null if it escapes the root. */
function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    return null;                       // malformed %-escape
  }
  if (decoded.includes('\0')) return null;

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);

  const root = path.resolve(PUBLIC_DIR);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function serveStatic(req, res, pathname) {
  const wantsHtml = pathname === '/' || pathname.endsWith('/') || pathname.endsWith('.html');
  const target = resolveStatic(wantsHtml && pathname.endsWith('/') ? pathname + 'index.html' : pathname);
  if (!target) {
    sendText(res, 400, 'Bad request');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_) {
    sendText(res, 404, 'Not found');
    return;
  }

  /* Directory request → its index.html (single level, never recursive). */
  if (stat.isDirectory()) {
    const index = path.join(target, 'index.html');
    try {
      stat = fs.statSync(index);
    } catch (_) {
      sendText(res, 404, 'Not found');
      return;
    }
    return serveFile(req, res, index, stat);
  }

  return serveFile(req, res, target, stat);
}

function serveFile(req, res, filePath, stat) {
  if (stat.size > MAX_STATIC_BYTES) {
    sendText(res, 413, 'File too large');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const etag = 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
  const isHtml = ext === '.html';

  applySecurityHeaders(res);
  res.setHeader('ETag', etag);
  res.setHeader(
    'Cache-Control',
    isHtml ? 'no-cache' : 'public, max-age=86400'
  );
  if (isHtml) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: https:",
        "media-src 'self' https:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "script-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "frame-ancestors 'self'",
        "base-uri 'self'",
      ].join('; ')
    );
  }

  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      sendText(res, 500, 'Read error');
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

function createServer(config = {}) {
  const dataDir = config.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const store = config.store || buildStore(dataDir);
  const adminToken = config.adminToken !== undefined ? config.adminToken : process.env.ADMIN_TOKEN || '';

  if (String(process.env.TRUST_PROXY || '') === '1') {
    /* Behind the Cloudflare tunnel every request arrives from 127.0.0.1, so the
       real client IP only exists in X-Forwarded-For. */
    config.trustProxy = true;
  }

  const app = createApp({
    store,
    secretFile: path.join(path.resolve(dataDir), 'session.key'),
    adminToken,
    version: config.version || '1.0.0',
    logger: config.logger || console,
  });

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      if (req.url && req.url.startsWith('/api/')) {
        (config.logger || console).log(
          '[http] ' + req.method + ' ' + req.url + ' → ' + res.statusCode + ' (' + ms + 'ms)'
        );
      }
    });

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      sendText(res, 400, 'Bad request');
      return;
    }

    /* HEAD is a read-only GET for static assets. */
    const method = req.method === 'HEAD' ? 'HEAD' : req.method;

    if (pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
        applySecurityHeaders(res);
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        return;
      }
      app.handle(req, res).catch((err) => {
        (config.logger || console).error('[server] routing failure:', err && err.message);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: 'Internal server error' });
        } else {
          res.destroy();
        }
      });
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed');
      return;
    }

    try {
      serveStatic(req, res, pathname);
    } catch (err) {
      (config.logger || console).error('[server] static failure:', err && err.message);
      if (!res.headersSent) sendText(res, 500, 'Internal server error');
    }
  });

  server.on('clientError', (err, socket) => {
    if (!socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, app, store };
}

/* ---------- CLI entry ---------- */

if (require.main === module) {
  const port = Number(process.env.PORT || 4000);
  /* Render/Railway/Fly route traffic to the container, not to loopback, so the
     default bind address must differ from a local dev box. */
  const host = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
  const { server, store } = createServer();

  server.listen(port, host, () => {
    console.log('[genmart] listening on http://' + host + ':' + port);
    console.log('[genmart] admin API ' + (process.env.ADMIN_TOKEN ? 'ENABLED' : 'disabled (set ADMIN_TOKEN)'));
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[genmart] port ' + port + ' is already in use — set PORT to another value');
    } else {
      console.error('[genmart] server error:', err.message);
    }
    process.exit(1);
  });

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log('[genmart] ' + signal + ' received — draining store and closing');
    store
      .idle()
      .catch(() => {})
      .then(() => {
        server.close(() => process.exit(0));
        /* Never hang forever on a stuck keep-alive socket. */
        setTimeout(() => process.exit(0), 5000).unref();
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createServer, resolveStatic, buildStore, EMPTY_STATE };
