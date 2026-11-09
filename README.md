GenMart — landing page + backend
================================

Formerly named Reelmark. The rename is cosmetic plus a one-time migration:
existing accounts/leads in `data/reelmark.json` are moved to
`data/genmart.json` on first boot, and the old `reelmark.*` localStorage keys are
carried over to `genmart.*` so nobody is logged out.

`public/index.html` is the original design from Downloads, byte-identical except
for two added `<link>`/`<script>` lines. Everything else around it is new.

What the backend adds
---------------------
| Endpoint                | Method | Auth        | Purpose                                   |
|-------------------------|--------|-------------|-------------------------------------------|
| `/api/health`           | GET    | —           | liveness + live counts                    |
| `/api/meta`             | GET    | —           | formats/goals/budgets + creator count      |
| `/api/auth/signup`      | POST   | —           | create account, returns session token     |
| `/api/auth/login`       | POST   | —           | log in, returns session token             |
| `/api/auth/me`          | GET    | Bearer      | current user                              |
| `/api/reels`            | POST   | Bearer      | submit a reel brief (validated)           |
| `/api/reels`            | GET    | Bearer      | list my briefs (scoped to the user)       |
| `/api/contact`          | POST   | —           | lead capture                              |
| `/api/leads`            | GET    | Admin token | list leads                                |
| `/api/leads/:id`        | PATCH  | Admin token | update status / append note               |

Frontend wiring (`public/app.js` + `public/styles.css`):
CTA → brief modal → signed-in POST `/api/reels`; Log in / Sign up pills → real
sessions; `#contact` → lead form; hero badge count hydrated from `/api/meta`.

Design decisions worth knowing
------------------------------
* **Zero dependencies.** Node core only, so the app starts anywhere with no
  install step (important when it is exposed through a tunnel).
* **Atomic persistence.** `lib/store.js` writes temp → fsync → rename, batches
  all mutations in a tick into one write, and copies a rolling backup before
  each write. A corrupt file is quarantined to `*.corrupt_<ts>` and the newest
  valid backup is restored — it is never silently treated as an empty store.
* **Passwords.** scrypt with a per-user salt and parameters stored in the hash;
  unknown emails still pay the full scrypt cost so timing cannot enumerate
  accounts. Comparison is `timingSafeEqual`.
* **Sessions.** HMAC-SHA256 signed tokens (`v1.payload.sig`) with a 7-day expiry
  and a 32-byte key persisted at `data/session.key` (0600), so restarts keep
  users logged in without a session table.
* **Rate limits.** Fixed windows per route family (signup 5/15 min, login
  10/15 min, contact 5/h, briefs 20/h, reads 240/min). One sweep timer per
  process, `unref()`d, sweeping every limiter's buckets.
* **Transport guards.** JSON-only bodies, 100 KB cap (413), malformed JSON → 400,
  static path traversal refused by realpath containment, CSP + nosniff headers.

Running
-------
```bash
./start.sh                  # http://127.0.0.1:4177
npm test                    # 27 tests, node:test
```

Env: `PORT`, `HOST`, `DATA_DIR`, `ADMIN_TOKEN`, `TRUST_PROXY=1` (needed behind
a tunnel so rate limits key on the real client IP instead of 127.0.0.1).

Public URL
----------
Exposed with a Cloudflare Tunnel (no account needed):

```bash
cloudflared tunnel --url http://127.0.0.1:4177 --no-autoupdate
```

Quick tunnels get a new hostname whenever cloudflared restarts. For a permanent
URL, point a named tunnel at the same local port (`cloudflared tunnel create` +
`cloudflared tunnel route dns`).
