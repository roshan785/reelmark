'use strict';
/*
 * tests/browser-helpers.js — minimal Chrome DevTools Protocol driver.
 *
 * Why hand-rolled: the project is deliberately dependency-free (see README),
 * so browser verification cannot pull in puppeteer/playwright. Node 22 ships a
 * global WebSocket, which is all CDP needs. It is read off globalThis so the
 * reference resolves under both the browser and Node lint/type environments.
 *
 * Test-only module; nothing in lib/ or server.js imports it.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

/** Resolve a WebSocket constructor that exists in this runtime, or null. */
function webSocketCtor() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try {
    // Node < 21 has no global WebSocket; undici ships one on newer releases.
    const undici = require('undici');
    return typeof undici.WebSocket === 'function' ? undici.WebSocket : null;
  } catch (_) {
    return null;
  }
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* keep looking */ }
  }
  return '';
}

function killProcessTree(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGKILL'); } catch (_) {}
}

function cleanupProfile(profile) {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}

function waitForEndpoint(child, profile) {
  const activePortPath = path.join(profile, 'DevToolsActivePort');
  return new Promise((resolve) => {
    const deadline = Date.now() + 15000;

    const poll = () => {
      try {
        if (fs.existsSync(activePortPath)) {
          const raw = fs.readFileSync(activePortPath, 'utf8').split('\n').filter(Boolean);
          const port = Number(raw[0]);
          if (Number.isFinite(port) && port > 0) {
            resolve({ http: 'http://127.0.0.1:' + port });
            return;
          }
        }
      } catch (_) { /* the file may be mid-write */ }

      if (Date.now() > deadline) {
        resolve(null);
        return;
      }
      setTimeout(poll, 60);
    };

    child.on('exit', () => resolve(null));
    poll();
  });
}

/** Launch a headless Chrome exposing CDP on an ephemeral port. */
async function launchChrome() {
  const binary = findChrome();
  if (!binary) return null;
  if (!webSocketCtor()) return null;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'genmart-cdp-'));
  const child = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const endpoint = await waitForEndpoint(child, profile);
  if (!endpoint) {
    killProcessTree(child);
    cleanupProfile(profile);
    return null;
  }

  const response = await fetch(endpoint.http + '/json/new?about:blank', { method: 'PUT' });
  if (!response.ok) {
    killProcessTree(child);
    cleanupProfile(profile);
    return null;
  }
  const target = await response.json();

  const client = await Cdp.connect(target.webSocketDebuggerUrl);

  return {
    child,
    profile,
    client,
    targetId: target.id,
    async close() {
      try { client.close(); } catch (_) {}
      killProcessTree(child);
      cleanupProfile(profile);
    },
  };
}

/* ---------- CDP client ---------- */

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket.addEventListener('message', (event) => this._onMessage(event.data));
    this.socket.addEventListener('close', () => this._onClose());
  }

  static connect(url) {
    const WebSocketImpl = webSocketCtor();
    if (!WebSocketImpl) return Promise.reject(new Error('no WebSocket implementation'));

    return new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(url);
      const timer = setTimeout(() => {
        try { socket.close(); } catch (_) {}
        reject(new Error('CDP connect timed out'));
      }, 10000);

      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Cdp(socket));
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP socket error'));
      });
    });
  }

  _onMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch (_) { return; }

    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || 'CDP error'));
      else entry.resolve(message.result);
      return;
    }

    if (message.method) {
      const handlers = this.listeners.get(message.method);
      if (handlers) handlers.forEach((handler) => handler(message.params));
    }
  }

  _onClose() {
    this.pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP connection closed'));
    });
    this.pending.clear();
  }

  send(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, timeoutMs || 20000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method).delete(handler);
  }

  close() {
    try { this.socket.close(); } catch (_) {}
  }
}

/* ---------- page helpers ---------- */

async function enablePage(session) {
  await session.client.send('Page.enable');
  await session.client.send('Runtime.enable');
}

/** Navigate and resolve once the load event has fired (or on timeout). */
async function goto(session, url) {
  const loaded = new Promise((resolve) => {
    const off = session.client.on('Page.loadEventFired', () => {
      off();
      resolve();
    });
    setTimeout(() => resolve(), 12000);
  });
  await session.client.send('Page.navigate', { url });
  await loaded;
  await sleep(350);
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(session, expression, awaitPromise) {
  const result = await session.client.send(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: !!awaitPromise,
      userGesture: true,
    },
    20000
  );

  if (result.exceptionDetails) {
    const description =
      (result.exceptionDetails.exception && result.exceptionDetails.exception.description) ||
      result.exceptionDetails.text ||
      'evaluation failed';
    throw new Error(description);
  }
  return result.result ? result.result.value : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  findChrome,
  launchChrome,
  enablePage,
  goto,
  evaluate,
  sleep,
};
