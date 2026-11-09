'use strict';
/*
 * store.js — atomic, corruption-safe JSON persistence.
 *
 * WHY NOT sqlite/leveldb: this app ships to any Node host with zero install
 * steps, so the store must be dependency-free. Correctness still matters:
 *   • writes are ATOMIC (write temp file -> fsync -> rename), so a crash can
 *     never leave a half-written JSON file that parses as "empty store"
 *   • writes are BATCHED: every mutation in the same tick shares one flush,
 *     so a burst of requests never rewrites the file N times
 *   • corruption is QUARANTINED, never silently discarded: the bad file is
 *     renamed to *.corrupt_<ts> and the newest valid backup is restored
 */

const fs = require('fs');
const path = require('path');

const MAX_BACKUPS = 5;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return undefined;
  }
}

class JsonStore {
  /**
   * @param {string} file absolute path of the JSON file
   * @param {{empty?: () => any}} [options] factory for the empty value
   */
  constructor(file, options = {}) {
    this.file = path.resolve(file);
    this.dir = path.dirname(this.file);
    this.backupDir = path.join(this.dir, 'backups');
    this.emptyFactory = typeof options.empty === 'function' ? options.empty : () => ({});
    this.maxBackups = Number.isFinite(options.maxBackups) ? options.maxBackups : MAX_BACKUPS;

    this.data = null;
    this.dirty = false;
    this.flushPromise = null;
  }

  /* ---------- reading ---------- */

  load() {
    if (this.data !== null) return this.data;

    fs.mkdirSync(this.dir, { recursive: true });

    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (raw !== null) {
      const parsed = parseJson(raw);
      if (parsed !== undefined && parsed !== null) {
        this.data = parsed;
        return this.data;
      }
      this.quarantine(raw);
    }

    const restored = this.restoreFromBackup();
    if (restored !== undefined) {
      this.data = restored;
      this.dirty = true;
      this.flushSync();
      return this.data;
    }

    this.data = this.emptyFactory();
    return this.data;
  }

  quarantine(raw) {
    const target = this.file + '.corrupt_' + Date.now();
    try {
      fs.writeFileSync(target, raw, { mode: 0o600 });
      fs.unlinkSync(this.file);
      console.error('[store] corrupt file quarantined -> ' + target);
    } catch (err) {
      console.error('[store] could not quarantine corrupt file:', err.message);
    }
  }

  restoreFromBackup() {
    let names;
    try {
      names = fs.readdirSync(this.backupDir).sort().reverse();
    } catch (_) {
      return undefined;
    }
    for (const name of names) {
      const full = path.join(this.backupDir, name);
      let raw;
      try {
        raw = fs.readFileSync(full, 'utf8');
      } catch (_) {
        continue;
      }
      const parsed = parseJson(raw);
      if (parsed !== undefined && parsed !== null) {
        console.error('[store] restored from backup ' + name);
        return parsed;
      }
    }
    return undefined;
  }

  /* ---------- writing ---------- */

  /**
   * Apply a mutation. All mutations issued in the same tick are coalesced into
   * a single atomic write, and every caller awaits that write.
   * @param {(data: any) => any} fn
   * @returns {Promise<any>} whatever fn returned
   */
  async mutate(fn) {
    const data = this.load();
    const result = fn(data);
    this.dirty = true;
    await this.scheduleFlush();
    return result;
  }

  /** Resolve once all pending writes are on disk. */
  async idle() {
    if (this.flushPromise) await this.flushPromise.catch(() => {});
    if (this.dirty) this.flushSync();
  }

  scheduleFlush() {
    if (!this.flushPromise) {
      this.flushPromise = new Promise((resolve, reject) => {
        setImmediate(() => {
          this.flushPromise = null;
          try {
            this.flushSync();
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    }
    return this.flushPromise;
  }

  flushSync() {
    if (!this.dirty) return false;

    fs.mkdirSync(this.dir, { recursive: true });
    const json = JSON.stringify(this.data, null, 2);
    const tmp = this.file + '.tmp';

    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    if (fs.existsSync(this.file)) this.snapshotBackup();
    fs.renameSync(tmp, this.file);
    this.dirty = false;
    return true;
  }

  snapshotBackup() {
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const base = path.basename(this.file, path.extname(this.file));
      fs.copyFileSync(this.file, path.join(this.backupDir, base + '.' + timestamp() + '.json'));
      const names = fs.readdirSync(this.backupDir)
        .filter((n) => n.startsWith(base + '.') && n.endsWith('.json'))
        .sort()
        .reverse();
      for (const stale of names.slice(this.maxBackups)) {
        try {
          fs.unlinkSync(path.join(this.backupDir, stale));
        } catch (_) {
          /* ignore */
        }
      }
    } catch (_) {
      /* backup is best-effort; never block the real write */
    }
  }
}

module.exports = JsonStore;
