# AccessRequest Feature — Persistence + Admin UI

**Goal:** When someone submits the "Solicitar acesso" form on the login screen, persist it in a new `AccessRequest` table so admins can approve/decline from `/admin/equipe/solicitacoes`. Currently the endpoint only fires an admin notification email + push, which silently drops if Gmail OAuth is broken (as reported: Sthefane's request was lost).

## Schema

```prisma
enum AccessRequestStatus {
  PENDING
  APPROVED
  DECLINED
}

model AccessRequest {
  id          String              @id @default(cuid())
  name        String
  email       String
  phone       String?
  message     String?
  status      AccessRequestStatus @default(PENDING)
  handledAt   DateTime?
  handledById String?
  handledBy   StaffMember?        @relation(fields: [handledById], references: [id])
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt

  @@index([status, createdAt])
}
```

Add a reverse relation on `StaffMember`: `handledRequests AccessRequest[]`.

## Backend endpoints (`routes/staff-auth.js` + `routes/staff-portal.js` — or co-located)

### Updated `POST /api/staff/auth/request-access`

After the existing Zod parse, write the row:

```js
// Persist the request so admins can review it in /admin/equipe/solicitacoes
// even if the notification email fails (Gmail OAuth has been flaky).
const ar = await prisma.accessRequest.create({
  data: { name, email, phone: phone ?? null, message: message ?? null },
});
```

Keep the notification email + push (best-effort).

### New `GET /api/staff/admin/access-requests?status=PENDING`

- `requireRole('ADMIN')`
- Returns array of `{ id, name, email, phone, message, status, createdAt, handledAt, handledBy: { name } | null }` ordered by `createdAt desc`.
- Supports `?status=PENDING|APPROVED|DECLINED|ALL` (default PENDING).

### New `POST /api/staff/admin/access-requests/:id/approve`

- `requireRole('ADMIN')`
- Body: `{ role: 'ADMIN'|'GOVERNANTA'|'PISCINEIRO', propertyIds: string[] }`
- Action:
  1. Create `StaffMember` row from the request's name/email/phone (active=true, firstLoginDone=false, invite token generated).
  2. Assign to each requested `propertyId` via `StaffPropertyAssignment.upsert`.
  3. Update the `AccessRequest` row: `status=APPROVED`, `handledAt=now`, `handledById=req.staffId`.
  4. Send the invite email (same flow `admin-staff.js` uses for admin-created staff — find and reuse `sendStaffInviteEmail` or equivalent helper). If the helper doesn't exist, leave a TODO but still complete the approval; the admin can resend later.
  5. Return `{ staffId, accessRequestId }`.

### New `POST /api/staff/admin/access-requests/:id/decline`

- `requireRole('ADMIN')`
- Body: optional `{ reason: string }`
- Action: update status to `DECLINED`, set `handledAt` + `handledById`. No StaffMember created.

## Regression pin

Add `__tests__/staff-auth.requestAccess.persist.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

// Pin the persistence contract: POST /request-access MUST write to
// AccessRequest so admins can review requests even if the notification
// email fails silently (Gmail OAuth has been flaky). Sthefane Souza's
// 2026-04-21 request was silently dropped — this test prevents recurrence.

test('request-access persists an AccessRequest row', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const app = (await import('../server.js')).default ?? (await import('../server.js')).app;
  // If server.js doesn't export the app directly, spin up a mini Express
  // with the router: const router = (await import('../routes/staff-auth.js')).default;

  const beforeCount = await prisma.accessRequest.count({ where: { email: 'regression-test@example.com' } });
  // Minimal in-process request using supertest OR a plain fetch-like helper
  // — match whatever pattern other __tests__ files use.
  const res = await fetch('http://localhost:3000/api/staff/auth/request-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Regression Bot', email: 'regression-test@example.com' }),
  });
  assert.equal(res.status, 200);
  const afterCount = await prisma.accessRequest.count({ where: { email: 'regression-test@example.com' } });
  assert.equal(afterCount, beforeCount + 1);

  // Cleanup
  await prisma.accessRequest.deleteMany({ where: { email: 'regression-test@example.com' } });
  await prisma.$disconnect();
});
```

Adapt to the repo's actual test style (node:test with local http requires the server to be running — if that's not what peers do, follow peer pattern, e.g. use `supertest` with the Express app exported from `server.js`).

## Staff-app admin UI

### New page `/admin/equipe/solicitacoes/page.tsx`

Server component: fetches `GET /api/staff/admin/access-requests?status=PENDING` + `?status=ALL` then renders a client component with approve/decline actions.

### Client component `components/admin/AccessRequestsList.tsx`

- List pending requests at top (card per request: name, email, phone, message, "há X dias")
- Each card has "Aprovar" + "Recusar" buttons
- "Aprovar" opens a small form inline: role picker (ADMIN/GOVERNANTA/PISCINEIRO) + property multiselect (loaded from `GET /api/staff/propriedades` or similar existing endpoint) → submits `POST /approve`
- "Recusar" opens inline confirm with optional reason → submits `POST /decline`
- After handled, card collapses to a row showing final status + who handled it + when

### Mais sheet badge

In `AdminShell.tsx` (after Tier 1 refactor), `adminMaisItems` already iterates for badges. Add pending-count badge to a new item:

```tsx
{
  href: '/admin/equipe/solicitacoes',
  label: 'Solicitações de acesso',
  desc: 'Aprovar novos membros',
  icon: <...>, // paper-plane or bell-new
  badge: pendingRequestCount,
}
```

Fetch `pendingRequestCount` in the same `useEffect` that fetches `requestedCount`/`unreadCount` (line ~343 of AdminShell.tsx).

## Rollout

1. SRI backend: migration + endpoints + test → push → Railway deploys.
2. Staff-app: admin page + Mais badge → push → Railway deploys.
3. Once live, the `/request-access` flow persists. Sthefane's original request (lost to the void) can be recreated manually by admin via `/admin/equipe` → Criar novo (existing flow) — no migration needed for historical data.
