# Prisma v6 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Prisma from v5.22.0 to v6.x (latest stable), resolving all breaking changes, with zero downtime on Railway.

**Architecture:** Pure dependency upgrade — update `package.json`, regenerate the client, fix any API incompatibilities found in the codebase, migrate. No schema changes needed; this codebase uses standard CRUD operations that are all forward-compatible with v6.

**Tech Stack:** Node.js 18+, Prisma ORM, PostgreSQL (Railway), Express.js

---

## Context

Current state: `@prisma/client` and `prisma` both pinned to `^5.22.0`. Railway deploy logs show v7.7.0 is available. We upgrade to v6 first (smaller diff, well-documented), validate fully, then do v7 in a follow-up sprint.

Prisma v5 → v6 breaking changes relevant to this codebase:
- `prisma.$use()` middleware removed → **not used here, no action needed**
- `rejectOnNotFound` removed → **not used here, no action needed**
- `Prisma.raw` removed → **not used here (no raw queries), no action needed**
- `Decimal` type from `@prisma/client/runtime` → still accessible via `new Prisma.Decimal()` but we just do `Number(b.totalAmount)` which still works
- Node.js minimum: 18.18.0 → met (`"node": ">=18"` in package.json)
- Generator output path: unchanged (`node_modules/@prisma/client`)

Expected effort: low risk. The hardest part is watching Railway's build logs confirm a clean deploy.

---

## Files Modified

| File | Change |
|------|--------|
| `package.json` | Bump `@prisma/client` and `prisma` to `^6.0.0` |
| `package-lock.json` | Auto-updated by `npm install` |
| `prisma/schema.prisma` | Add `output` field to generator (v6 best practice) if needed |

No route, lib, or public files need changes unless a runtime error surfaces during smoke tests (Task 3 covers this).

---

## Task 1: Research v6 exact target version + check changelog

**Files:** None (research only)

- [ ] **Step 1: Check latest v6 on npm**

```bash
npm view prisma versions --json | node -e "const v=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(v.filter(x=>x.startsWith('6.')).slice(-5).join('\n'))"
```

On Windows PowerShell use:
```powershell
npm view prisma versions --json | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d);console.log(v.filter(x=>x.startsWith('6.')).slice(-5).join('\n'))})"
```

Note the latest `6.x.x` version — that's our target.

- [ ] **Step 2: Scan codebase for any v5-only API usage**

Run each of these searches. All should return zero matches:

```bash
# $use middleware (removed in v6)
grep -r "\.\$use(" lib/ routes/ server.js

# rejectOnNotFound (removed in v6)
grep -r "rejectOnNotFound" lib/ routes/ prisma/

# Prisma.raw (removed in v6, use Prisma.sql)
grep -r "Prisma\.raw" lib/ routes/ server.js

# Old runtime import path
grep -r "prisma-client-js/runtime" lib/ routes/
```

Expected: all return nothing. If any match is found, note it and fix it in Task 2 before proceeding.

- [ ] **Step 3: Commit research findings (no code change)**

```bash
git add -A
git status
```

If nothing changed (expected), skip this commit and proceed to Task 2.

---

## Task 2: Bump versions and install

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package.json**

In `package.json`, change both entries to the v6 version you found in Task 1 Step 1 (example shows `6.7.0` — replace with actual latest):

```json
"dependencies": {
  "@prisma/client": "^6.7.0",
  ...
},
"devDependencies": {
  "prisma": "^6.7.0"
}
```

- [ ] **Step 2: Install**

```bash
cd "C:\Users\andre\Documents\Deco - Smart Business Operations\Claude Projects\Sítio Recanto dos Ipês"
npm install
```

Expected output: sees `@prisma/client@6.x.x` and `prisma@6.x.x` in the install summary. No peer dependency errors.

If you see peer dependency warnings about other packages (e.g., `connect-pg-simple`), they are warnings only — do not downgrade Prisma for them unless they are hard `UNMET PEER DEPENDENCY` errors.

- [ ] **Step 3: Regenerate Prisma client**

```bash
npx prisma generate
```

Expected: `Generated Prisma Client (v6.x.x) to ./node_modules/@prisma/client`

If it fails with a schema error, read the error carefully — it will tell you which field or feature needs updating.

- [ ] **Step 4: Commit the version bump**

```bash
git add package.json package-lock.json
git commit -m "chore: upgrade Prisma to v6

Bumps @prisma/client and prisma devDep from ^5.22.0 to ^6.x.x.
No schema or query API changes needed — this codebase uses only
standard CRUD operations that are fully forward-compatible with v6.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Local smoke tests

**Files:** None (testing only)

- [ ] **Step 1: Syntax check all server files**

```bash
node --check server.js && echo "server.js OK"
node --check lib/db.js && echo "db.js OK"
node --check lib/pricing.js && echo "pricing.js OK"
node --check routes/bookings.js && echo "bookings.js OK"
node --check routes/auth.js && echo "auth.js OK"
node --check routes/dashboard.js && echo "dashboard.js OK"
node --check routes/staff-portal.js && echo "staff-portal.js OK"
```

Expected: all print `OK`.

- [ ] **Step 2: Start server locally (if DATABASE_URL is available)**

```bash
node server.js
```

Expected first lines:
```
Recanto dos Ipês · listening on port 3000
```

No `[startup] FATAL:` lines and no Prisma client errors.

If no local DATABASE_URL: skip to Task 4 (deploy to Railway handles the live DB test).

- [ ] **Step 3: Spot-check a Prisma query locally**

If server started in Step 2, in a separate terminal:

```bash
node -e "
const prisma = require('./lib/db');
prisma.seaso nalPricing.count().then(n => { console.log('SeasonalPricing rows:', n); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
"
```

Expected: prints `SeasonalPricing rows: N` where N > 0.

- [ ] **Step 4: Stop local server**

`Ctrl+C` in the server terminal.

---

## Task 4: Deploy to Railway and verify

**Files:** None (deployment only)

- [ ] **Step 1: Push to main**

```bash
git push origin main
```

Railway auto-deploys on push. Open Railway dashboard → service → Deployments tab.

- [ ] **Step 2: Watch build logs**

In Railway build logs, confirm:
```
✓ Installed @prisma/client@6.x.x
✓ Generated Prisma Client (v6.x.x)
✓ Migration applied (or "No pending migrations")
Recanto dos Ipês · listening on port ...
```

Red flags to watch for:
- `Error: This version of Prisma requires Node.js X.X` → check Node version
- `Schema validation errors` → fix schema, regenerate, redeploy
- `Cannot find module '@prisma/client'` → `npx prisma generate` missing from build command

- [ ] **Step 3: Run production API smoke tests**

Replace `YOUR_RAILWAY_URL` with the actual URL:

```bash
node -e "
const https = require('https');
const BASE = 'https://YOUR_RAILWAY_URL';

function get(path) {
  return new Promise((resolve, reject) => {
    https.get(BASE + path, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    }).on('error', reject);
  });
}

async function run() {
  let passed = 0, failed = 0;
  const tests = [
    ['/health', r => r.status === 200 && r.body.status === 'ok'],
    ['/api/pricing/calendar', r => r.status === 200 && Array.isArray(r.body.periods)],
    ['/api/bookings/availability', r => r.status === 200 && Array.isArray(r.body.blockedDates)],
    ['/api/bookings/quote?checkIn=2026-12-20&checkOut=2026-12-23&guests=4', r => r.status === 200 && r.body.totalAmount > 0],
    ['/api/auth/me', r => r.status === 401],
  ];
  for (const [path, check] of tests) {
    const r = await get(path);
    const ok = check(r);
    console.log((ok ? '✅' : '❌') + ' ' + path + ' → ' + r.status);
    ok ? passed++ : failed++;
  }
  console.log('\n' + passed + '/' + tests.length + ' tests passed');
  process.exit(failed > 0 ? 1 : 0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
"
```

Expected: `5/5 tests passed`

- [ ] **Step 4: Check for runtime errors in Railway logs**

In Railway → service → Logs tab, look for any `[prisma]` or `PrismaClientKnownRequestError` lines in the last 5 minutes. There should be none.

---

## Task 5 (Optional): Upgrade to v7 after v6 is stable

**Files:** `package.json`

This is a separate sprint. Only attempt after v6 is confirmed stable in production for at least 24 hours.

- [ ] **Step 1: Check v7 migration guide**

Visit: https://www.prisma.io/docs/guides/upgrade-guides/upgrading-versions/upgrading-to-prisma-7

Note any breaking changes and assess impact on this codebase before modifying anything.

- [ ] **Step 2: Follow the same Task 1-4 pattern above**

Bump versions to `^7.x.x`, run `npm install && npx prisma generate`, check for errors, run smoke tests, deploy.

---

## Self-Review Checklist

- [x] **Spec coverage**: Version bump ✓, breaking change audit ✓, local test ✓, Railway deploy ✓, production smoke test ✓
- [x] **No placeholders**: All steps have exact commands
- [x] **Type consistency**: N/A (no new types introduced)
- [x] **Scope**: Minimal — only `package.json` changes. No application logic touched unless a runtime error forces a fix.
