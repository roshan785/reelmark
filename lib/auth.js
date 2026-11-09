'use strict';
/*
 * auth.js — password hashing (scrypt) and stateless signed session tokens.
 *
 * Design notes:
 *   • scrypt with a per-user random salt; parameters are stored IN the hash so
 *     they can be raised later without invalidating existing users.
 *   • verification uses timingSafeEqual, and unknown accounts still pay the
 *     full scrypt cost (dummy hash) so response time does not leak existence.
 *   • session tokens are HMAC-SHA256 signed and expire; no server-side session
 *     table is required, so a restart keeps users logged in.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const TOKEN_VERSION = 'v1';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* Placeholder used to equalise timing when the email is unknown. */
const DUMMY_HASH = (() => {
  const salt = Buffer.alloc(16, 7);
  const hash = crypto.scryptSync('placeholder-password', salt, SCRYPT.keylen, SCRYPT);
  return 'scrypt$' + SCRYPT.N + '$' + SCRYPT.r + '$' + SCRYPT.p + '$' +
    salt.toString('base64') + '$' + hash.toString('base64');
})();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p });
    return actual.length === expected.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

/** Burn the same CPU an existing user would cost. */
function fakeVerify(password) {
  verifyPassword(String(password || ''), DUMMY_HASH);
  return false;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function sign(payloadB64, secret) {
  return base64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

/**
 * @param {{uid: string}} claims
 * @param {Buffer} secret
 * @param {number} [ttlMs]
 */
function createToken(claims, secret, ttlMs = DEFAULT_TTL_MS) {
  const payload = JSON.stringify({ uid: claims.uid, exp: Date.now() + ttlMs });
  const payloadB64 = base64url(payload);
  return TOKEN_VERSION + '.' + payloadB64 + '.' + sign(payloadB64, secret);
}

function verifyToken(token, secret) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
    const expected = Buffer.from(sign(parts[1], secret));
    const given = Buffer.from(parts[2]);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const payload = JSON.parse(fromBase64url(parts[1]).toString('utf8'));
    if (!payload || typeof payload.uid !== 'string' || payload.uid.length === 0) return null;
    if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    return { uid: payload.uid, exp: payload.exp };
  } catch (_) {
    return null;
  }
}

/** Persisted 32-byte HMAC key (mode 0600) so sessions survive restarts. */
function loadOrCreateSecret(file) {
  const target = path.resolve(file);
  try {
    const existing = fs.readFileSync(target);
    if (existing.length >= 32) return existing;
  } catch (_) {
    /* fall through and create */
  }
  const secret = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, secret, { mode: 0o600 });
  return secret;
}

module.exports = {
  hashPassword,
  verifyPassword,
  fakeVerify,
  createToken,
  verifyToken,
  loadOrCreateSecret,
  DEFAULT_TTL_MS,
};
