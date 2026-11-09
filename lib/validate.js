'use strict';
/*
 * validate.js — boundary validation for every request body.
 *
 * Rule: user input is never trusted. Everything crossing the HTTP boundary is
 * coerced, length-capped and type-checked here, so route handlers can assume
 * clean data. Errors are returned as a flat {field: message} map.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const UUID_RE = /^[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}$/i;

class ValidationError extends Error {
  constructor(fields) {
    super('validation failed');
    this.name = 'ValidationError';
    this.status = 400;
    this.fields = fields;
  }
}

function asString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function trim(value, max) {
  return asString(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function required(fields, key, value, max, label) {
  const clean = trim(value, max);
  if (clean.length === 0) fields[key] = (label || key) + ' is required';
  return clean;
}

function optional(value, max) {
  return trim(value, max);
}

function email(fields, key, value) {
  const clean = trim(value, 254).toLowerCase();
  if (clean.length === 0) {
    fields[key] = 'Email is required';
  } else if (!EMAIL_RE.test(clean)) {
    fields[key] = 'Enter a valid email address';
  }
  return clean;
}

function oneOf(fields, key, value, allowed, fallback) {
  const clean = trim(value, 40).toLowerCase();
  if (clean.length === 0) return fallback;
  if (!allowed.includes(clean)) {
    fields[key] = 'Must be one of: ' + allowed.join(', ');
    return fallback;
  }
  return clean;
}

function boolean(value, fallback) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function throwIfInvalid(fields) {
  if (Object.keys(fields).length > 0) throw new ValidationError(fields);
}

/* ---------- request validators ---------- */

const REEL_FORMATS = ['vertical-9-16', 'square-1-1', 'landscape-16-9'];
const REEL_GOALS = ['launch', 'awareness', 'sales', 'community'];
const BUDGET_BANDS = ['under-500', '500-1500', '1500-5000', '5000-plus'];
const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'];

function validateSignup(body) {
  const fields = {};
  const name = required(fields, 'name', body.name, 80, 'Name');
  const mail = email(fields, 'email', body.email);
  const password = asString(body.password).slice(0, 200);
  if (password.length < 8) fields.password = 'Password must be at least 8 characters';
  throwIfInvalid(fields);
  return { name, email: mail, password };
}

function validateLogin(body) {
  const fields = {};
  const mail = email(fields, 'email', body.email);
  const password = asString(body.password).slice(0, 200);
  if (password.length === 0) fields.password = 'Password is required';
  throwIfInvalid(fields);
  return { email: mail, password };
}

function validateReelBrief(body) {
  const fields = {};
  const brand = required(fields, 'brand', body.brand, 80, 'Brand name');
  const product = required(fields, 'product', body.product, 120, 'Product');
  const audience = required(fields, 'audience', body.audience, 200, 'Audience');
  const format = oneOf(fields, 'format', body.format, REEL_FORMATS, 'vertical-9-16');
  const goal = oneOf(fields, 'goal', body.goal, REEL_GOALS, 'launch');
  const budget = oneOf(fields, 'budget', body.budget, BUDGET_BANDS, 'under-500');
  const notes = optional(body.notes, 1000);
  throwIfInvalid(fields);
  return { brand, product, audience, format, goal, budget, notes };
}

function validateContact(body) {
  const fields = {};
  const name = required(fields, 'name', body.name, 80, 'Name');
  const mail = email(fields, 'email', body.email);
  const message = required(fields, 'message', body.message, 2000, 'Message');
  if (message.length > 0 && message.length < 10) {
    fields.message = 'Message must be at least 10 characters';
  }
  const newsletter = boolean(body.newsletter, false);
  throwIfInvalid(fields);
  return { name, email: mail, message, newsletter };
}

function validateLeadPatch(body) {
  const fields = {};
  const status = oneOf(fields, 'status', body.status, LEAD_STATUSES, null);
  const note = optional(body.note, 500);
  if (status === null && note === '') fields.status = 'Provide status or note';
  throwIfInvalid(fields);
  return { status, note };
}

module.exports = {
  ValidationError,
  validateSignup,
  validateLogin,
  validateReelBrief,
  validateContact,
  validateLeadPatch,
  UUID_RE,
  REEL_FORMATS,
  REEL_GOALS,
  BUDGET_BANDS,
  LEAD_STATUSES,
  asString,
  trim,
  boolean,
};
