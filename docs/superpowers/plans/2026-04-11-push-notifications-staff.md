# Push Notifications (Staff PWA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable real-time Web Push notifications to staff members' browsers/devices when operationally important events occur — new booking confirmed, task assigned, service ticket opened.

**Architecture:** Use the `web-push` npm library with VAPID keys. Staff members subscribe via the existing staff PWA frontend; subscriptions are stored in `StaffMember.pushSubscription Json?` (field already in schema). The backend sends pushes via `lib/push.js`. Event triggers are added to existing booking/webhook flow and to a new cron daily briefing. Service worker code is provided here but must be added to the staff PWA frontend project separately.

**Tech Stack:** `web-push` (new dep), existing `StaffMember` + `PushNotification` Prisma models, Express.js, Node.js cron

---

## Context

**What already exists in the schema:**
- `StaffMember.pushSubscription Json?` — stores one Web Push subscription object per staff member (their most recent device)
- `PushNotification` model — notification history log (staffId, title, body, type, data, read, sentAt)

**What doesn't exist yet:**
- `lib/push.js` — VAPID send logic
- `POST /api/staff/push/subscribe` — endpoint for PWA to register subscription
- `DELETE /api/staff/push/subscribe` — endpoint to unsubscribe
- `GET /api/staff/push/vapid-key` — serves public VAPID key to PWA
- Push triggers in booking confirmation flow
- Service worker (lives in staff PWA project, not here — code provided in Task 5)

**What events trigger a push:**
| Event | Who gets notified |
|-------|-------------------|
| Booking CONFIRMED | All ADMIN staff |
| ServiceTicket created | All ADMIN staff + GUARDIA at that property |
| StaffTask assigned | The assignee only |
| Daily 07:00 briefing | All ADMIN staff (existing cron candidate) |

For v2.1 we implement: booking confirmed + task assigned. The daily briefing and ticket push are noted as easy follow-ups.

---

## Files

| File | Action |
|------|--------|
| `package.json` | Add `web-push` dependency |
| `lib/push.js` | **Create** — VAPID config + sendPushToStaff() |
| `routes/staff-portal.js` | **Modify** — add push subscribe/unsubscribe/vapid-key endpoints |
| `server.js` | **Modify** — add `VAPID_PUBLIC_KEY` to required env vars list (production) |
| `lib/cron.js` | **Modify** — add push on booking confirmation (or wire through mailer) |
| `routes/bookings.js` | **Modify** — fire push after CONFIRMED status update |

Service worker (`sw.js`) goes in the **staff PWA project**, not this repo. Code is provided in Task 5.

---

## Task 1: Install web-push + generate VAPID keys

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install web-push**

```bash
cd "C:\Users\andre\Documents\Deco - Smart Business Operations\Claude Projects\Sítio Recanto dos Ipês"
npm install web-push
```

Expected: `added 1 package` (web-push has minimal deps).

- [ ] **Step 2: Generate VAPID key pair (one-time)**

```bash
node -e "const wp = require('web-push'); const keys = wp.generateVAPIDKeys(); console.log('VAPID_PUBLIC_KEY=' + keys.publicKey); console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);"
```

Expected output (your values will differ):
```
VAPID_PUBLIC_KEY=BNq...long base64url string...
VAPID_PRIVATE_KEY=abc...long base64url string...
```

**Copy both values.** These are permanent — changing them invalidates all existing subscriptions.

- [ ] **Step 3: Add VAPID keys to Railway environment variables**

In Railway dashboard → service → Variables, add:
```
VAPID_PUBLIC_KEY   = <value from Step 2>
VAPID_PRIVATE_KEY  = <value from Step 2>
VAPID_CONTACT      = mailto:reservas@recantodosipes.com.br
```

`VAPID_CONTACT` is required by the Web Push spec — any email/URL that identifies you to push services.

- [ ] **Step 4: Update package.json (only version tracking)**

The `npm install` in Step 1 already updated `package.json`. Verify:

```bash
node -e "const p = require('./package.json'); console.log('web-push:', p.dependencies['web-push']);"
```

Expected: prints the installed version, e.g., `web-push: ^3.6.7`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add web-push dependency for staff PWA push notifications

VAPID keys generated separately and stored in Railway env vars
(VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Create `lib/push.js`

**Files:**
- Create: `lib/push.js`

- [ ] **Step 1: Create the file**

```js
// lib/push.js
'use strict';

const webpush = require('web-push');
const prisma  = require('./db');

// ── VAPID configuration ───────────────────────────────────────────────────────
// Configured once at module load. If keys are missing (e.g., local dev without
// env vars), push calls will be no-ops rather than crashes.

let vapidConfigured = false;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT || 'mailto:admin@recantodosipes.com.br',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  vapidConfigured = true;
} else {
  console.warn('[push] VAPID keys not set — push notifications disabled');
}

// ── sendPushToStaff ───────────────────────────────────────────────────────────

/**
 * Send a Web Push notification to a single staff member.
 * Logs the notification to PushNotification table.
 * If the subscription is expired/invalid (410), clears it from the DB.
 *
 * @param {string} staffId
 * @param {{ title: string, body: string, type: string, data?: object }} payload
 * @returns {Promise<boolean>} true if sent, false if no subscription or VAPID not configured
 */
async function sendPushToStaff(staffId, { title, body, type, data = {} }) {
  if (!vapidConfigured) return false;

  const staff = await prisma.staffMember.findUnique({
    where:  { id: staffId },
    select: { pushSubscription: true, name: true },
  });

  if (!staff?.pushSubscription) return false;

  const subscription = staff.pushSubscription; // { endpoint, keys: { p256dh, auth } }

  const notificationPayload = JSON.stringify({ title, body, type, data });

  try {
    await webpush.sendNotification(subscription, notificationPayload);

    // Log to PushNotification table
    await prisma.pushNotification.create({
      data: { staffId, title, body, type, data },
    });

    console.log(`[push] Sent "${type}" to ${staff.name || staffId}`);
    return true;
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      // Subscription expired or invalid — remove from DB
      console.warn(`[push] Subscription expired for ${staffId}, clearing`);
      await prisma.staffMember.update({
        where: { id: staffId },
        data:  { pushSubscription: null },
      });
    } else {
      console.error(`[push] Failed to send to ${staffId}:`, err.message);
    }
    return false;
  }
}

// ── sendPushToRole ────────────────────────────────────────────────────────────

/**
 * Send a push notification to all active staff members with a given role.
 *
 * @param {'ADMIN'|'GUARDIA'|'PISCINEIRO'} role
 * @param {{ title: string, body: string, type: string, data?: object }} payload
 * @returns {Promise<number>} count of successful sends
 */
async function sendPushToRole(role, payload) {
  const staff = await prisma.staffMember.findMany({
    where:  { role, active: true, NOT: { pushSubscription: null } },
    select: { id: true },
  });

  const results = await Promise.allSettled(
    staff.map(s => sendPushToStaff(s.id, payload))
  );

  const sent = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  return sent;
}

module.exports = { sendPushToStaff, sendPushToRole };
```

- [ ] **Step 2: Syntax check**

```bash
node --check lib/push.js && echo "OK"
```

Expected: `OK`

- [ ] **Step 3: Smoke test (confirms module loads without crashing even without VAPID keys)**

```bash
node -e "
// Test that push.js loads gracefully without VAPID keys
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
const { sendPushToStaff, sendPushToRole } = require('./lib/push');
console.log('Module loaded OK');
console.log('sendPushToStaff type:', typeof sendPushToStaff);
console.log('sendPushToRole type:', typeof sendPushToRole);
process.exit(0);
"
```

Expected:
```
[push] VAPID keys not set — push notifications disabled
Module loaded OK
sendPushToStaff type: function
sendPushToRole type: function
```

- [ ] **Step 4: Commit**

```bash
git add lib/push.js
git commit -m "feat: add lib/push.js for Web Push notifications

sendPushToStaff() sends to one staff member; sendPushToRole() broadcasts
to all active members with a given role. Expired subscriptions (HTTP 410)
are auto-cleared. Logs all sends to PushNotification table.
Gracefully disabled when VAPID keys are not configured.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Add push API endpoints to staff-portal routes

**Files:**
- Modify: `routes/staff-portal.js`

- [ ] **Step 1: Add the three push endpoints to routes/staff-portal.js**

Find the end of `routes/staff-portal.js` (before `module.exports = router`). Add:

```js
// ── GET /api/staff/push/vapid-key ─────────────────────────────────────────────
// Returns the VAPID public key so the PWA can create a PushSubscription.
// Safe to expose publicly — it's the public half of an asymmetric key pair.
router.get('/push/vapid-key', (_req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(503).json({ error: 'Push notifications not configured' });
  }
  res.json({ publicKey: key });
});

// ── POST /api/staff/push/subscribe ────────────────────────────────────────────
// Body: { subscription: { endpoint, keys: { p256dh, auth } } }
// Saves the Web Push subscription to the authenticated staff member record.
router.post('/push/subscribe', requireStaffAuth, async (req, res) => {
  try {
    const { subscription } = req.body;

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }

    await prisma.staffMember.update({
      where: { id: req.staffId },
      data:  { pushSubscription: subscription },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[push] subscribe error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar subscription' });
  }
});

// ── DELETE /api/staff/push/subscribe ──────────────────────────────────────────
// Removes the push subscription from the authenticated staff member record.
router.delete('/push/subscribe', requireStaffAuth, async (req, res) => {
  try {
    await prisma.staffMember.update({
      where: { id: req.staffId },
      data:  { pushSubscription: null },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[push] unsubscribe error:', err.message);
    res.status(500).json({ error: 'Erro ao remover subscription' });
  }
});
```

**Note:** `requireStaffAuth` and `req.staffId` must already be defined in `routes/staff-portal.js`. If the auth middleware uses a different variable name (e.g., `req.staff.id`), adjust accordingly — read the top of the file before editing.

- [ ] **Step 2: Syntax check**

```bash
node --check routes/staff-portal.js && echo "OK"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add routes/staff-portal.js
git commit -m "feat: add push subscription API endpoints

GET  /api/staff/push/vapid-key  — serves VAPID public key to PWA
POST /api/staff/push/subscribe  — save push subscription (auth required)
DELETE /api/staff/push/subscribe — remove subscription (auth required)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Wire push triggers into booking flow

**Files:**
- Modify: `server.js` (Stripe webhook handler — booking confirmed event)
- Modify: `routes/staff-portal.js` (task assignment endpoint)
- Modify: `server.js` (env var validation list)

- [ ] **Step 1: Add VAPID env vars to startup validation in server.js**

Find the `REQUIRED_ENV` array in `server.js`:
```js
const REQUIRED_ENV = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'ADMIN_SECRET',
];
```

Change it to:
```js
const REQUIRED_ENV = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'ADMIN_SECRET',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
];
```

- [ ] **Step 2: Fire push on booking confirmed (Stripe webhook)**

In `server.js`, find the `payment_intent.succeeded` handler block. After the existing `notifyBookingConfirmed` and `sendBookingConfirmation` lines, add the push call:

```js
// After: sendBookingConfirmation({ booking: updated }).catch(...)

// Push notification to ADMIN staff (non-blocking)
const { sendPushToRole } = require('./lib/push');
sendPushToRole('ADMIN', {
  title: 'Nova Reserva Confirmada 🏡',
  body:  `${updated.guestName} · ${new Date(updated.checkIn).toLocaleDateString('pt-BR')} → ${new Date(updated.checkOut).toLocaleDateString('pt-BR')}`,
  type:  'BOOKING_CONFIRMED',
  data:  { bookingId: updated.id },
}).catch(e => console.error('[push] booking confirmed push failed:', e.message));
```

- [ ] **Step 3: Fire push on task assignment**

In `routes/staff-portal.js`, find the endpoint that creates a `StaffTask` (likely `POST /api/staff/tasks`). After the task is created and saved to DB, add:

```js
// After task is created:
const { sendPushToStaff } = require('../lib/push');
sendPushToStaff(task.assignedToId, {
  title: 'Nova Tarefa Atribuída',
  body:  task.title,
  type:  'TASK_ASSIGNED',
  data:  { taskId: task.id },
}).catch(e => console.error('[push] task assigned push failed:', e.message));
```

If the task creation endpoint doesn't exist yet, skip this step and note it for when task creation is implemented.

- [ ] **Step 4: Syntax check both files**

```bash
node --check server.js && echo "server.js OK"
node --check routes/staff-portal.js && echo "staff-portal.js OK"
```

Expected: both print `OK`

- [ ] **Step 5: Commit**

```bash
git add server.js routes/staff-portal.js
git commit -m "feat: fire push notifications on booking confirmed and task assigned

- ADMIN staff receive push on every booking confirmation (Stripe webhook)
- Task assignee receives push when a StaffTask is created for them
- VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY added to production required env vars
- All push calls are non-blocking (.catch logged, never crash the request)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Service Worker (staff PWA — separate project)

**Files:** These go in the **staff PWA frontend project**, not this repo.

This task documents what the staff PWA needs. Copy this code into the appropriate location in the staff app.

- [ ] **Step 1: Create or update `public/sw.js` in the staff PWA**

```js
// sw.js — Staff PWA Service Worker
// Handles Web Push notifications from the backend.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Recanto dos Ipês', body: event.data.text(), type: 'GENERIC' };
  }

  const { title, body, type, data = {} } = payload;

  // Map notification type to icon and badge
  const iconMap = {
    BOOKING_CONFIRMED: '/icons/booking.png',
    TASK_ASSIGNED:     '/icons/task.png',
    GENERIC:           '/icons/logo.png',
  };

  const options = {
    body,
    icon:   iconMap[type] || '/icons/logo.png',
    badge:  '/icons/badge.png',
    data:   { type, ...data },
    vibrate: [200, 100, 200],
    requireInteraction: type === 'BOOKING_CONFIRMED',
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const { type, bookingId, taskId } = event.notification.data || {};

  let url = '/';
  if (type === 'BOOKING_CONFIRMED' && bookingId) {
    url = `/bookings/${bookingId}`;
  } else if (type === 'TASK_ASSIGNED' && taskId) {
    url = `/tasks/${taskId}`;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.navigate(url);
      } else {
        self.clients.openWindow(url);
      }
    })
  );
});
```

- [ ] **Step 2: Register service worker and subscribe in the staff PWA app**

In the staff PWA's main JS (app entry point), add:

```js
// push-setup.js — call this after staff login

async function setupPushNotifications(apiBase) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('[push] Not supported in this browser');
    return;
  }

  // Register service worker
  const registration = await navigator.serviceWorker.register('/sw.js');
  console.log('[push] Service worker registered');

  // Check if already subscribed
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    console.log('[push] Already subscribed');
    return;
  }

  // Fetch VAPID public key from backend
  const keyRes = await fetch(`${apiBase}/api/staff/push/vapid-key`, {
    credentials: 'include',
  });
  if (!keyRes.ok) {
    console.warn('[push] VAPID key not available');
    return;
  }
  const { publicKey } = await keyRes.json();

  // Request permission
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.log('[push] Permission denied');
    return;
  }

  // Subscribe
  subscription = await registration.pushManager.subscribe({
    userVisibleOnly:      true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  // Send subscription to backend
  await fetch(`${apiBase}/api/staff/push/subscribe`, {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    credentials: 'include',
    body:        JSON.stringify({ subscription }),
  });

  console.log('[push] Subscribed successfully');
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

export { setupPushNotifications };
```

Call `setupPushNotifications('https://your-railway-url.up.railway.app')` after a successful staff login.

- [ ] **Step 3: Note for icons**

The service worker references these icon paths in the staff PWA:
- `/icons/logo.png` — generic logo (96×96 or 192×192 PNG)
- `/icons/booking.png` — booking icon
- `/icons/task.png` — task icon
- `/icons/badge.png` — monochrome badge icon (72×72 PNG, used on Android)

Create or copy these into the staff PWA's `public/icons/` folder.

---

## Task 6: Deploy and test

**Files:** None (deployment/testing)

- [ ] **Step 1: Deploy to Railway**

```bash
git push origin main
```

Confirm clean startup in Railway build logs. Check for:
- No `[startup] FATAL: Missing required env vars` — means VAPID keys are set correctly
- `[push] VAPID keys not set` warning should NOT appear (if it does, check Railway env vars)

- [ ] **Step 2: Verify vapid-key endpoint**

```bash
node -e "
const https = require('https');
https.get('https://YOUR_RAILWAY_URL/api/staff/push/vapid-key', res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const body = JSON.parse(d);
    console.log('Status:', res.statusCode);
    console.log('publicKey starts with:', body.publicKey?.slice(0, 20) + '...');
    if (res.statusCode === 200 && body.publicKey) {
      console.log('✅ VAPID public key endpoint OK');
    } else {
      console.error('❌ Unexpected response:', body);
    }
  });
}).on('error', e => console.error(e.message));
"
```

Expected:
```
Status: 200
publicKey starts with: BNq...
✅ VAPID public key endpoint OK
```

- [ ] **Step 3: Test push subscription endpoint with a real browser**

1. Install the staff PWA service worker (from Task 5) in the staff frontend project
2. Log into the staff app
3. Call `setupPushNotifications(apiBase)` — browser will prompt for notification permission
4. Grant permission
5. In Railway → Prisma Studio (or direct DB query): verify `StaffMember.pushSubscription` is now populated for your staff account

- [ ] **Step 4: Trigger a test push**

Create a minimal test booking via the admin or via Stripe test mode, confirm it — this triggers the `payment_intent.succeeded` webhook → `sendPushToRole('ADMIN', ...)` → push should arrive in the browser.

Alternative: manual test push via a small script (run locally with Railway DATABASE_URL):

```bash
node -e "
process.env.DATABASE_URL = 'YOUR_RAILWAY_DB_URL';
process.env.VAPID_PUBLIC_KEY = 'YOUR_VAPID_PUBLIC_KEY';
process.env.VAPID_PRIVATE_KEY = 'YOUR_VAPID_PRIVATE_KEY';
process.env.VAPID_CONTACT = 'mailto:test@example.com';

const { sendPushToRole } = require('./lib/push');
sendPushToRole('ADMIN', {
  title: 'Teste de Push 🔔',
  body:  'Notificação de teste — sistema funcionando!',
  type:  'GENERIC',
}).then(count => {
  console.log('Pushes enviados:', count);
  process.exit(0);
}).catch(e => {
  console.error(e.message);
  process.exit(1);
});
"
```

Expected: notification appears in the browser, `Pushes enviados: 1` in console.

- [ ] **Step 5: Commit if service worker was added to this repo**

If the staff PWA service worker lives in this repo (e.g., `public/staff/sw.js`):

```bash
git add public/staff/sw.js
git commit -m "feat: add service worker for staff push notifications

Handles push events from web-push backend. Routes notificationclick
to the relevant booking or task page in the staff PWA.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: VAPID setup ✓, lib/push.js ✓, subscribe/unsubscribe API ✓, booking trigger ✓, task trigger ✓, service worker code ✓, deploy + test ✓
- [x] **No placeholders**: All steps have complete code
- [x] **Type consistency**: `sendPushToStaff` / `sendPushToRole` consistent in lib and usage sites
- [x] **Error handling**: 410 expired subscriptions auto-cleared, all send calls non-blocking (`.catch` never crashes), graceful no-op when VAPID not configured
- [x] **Schema alignment**: Uses `StaffMember.pushSubscription Json?` and `PushNotification` model exactly as defined in `prisma/schema.prisma`
- [x] **Security**: VAPID public key served via API (not hardcoded in frontend), private key stays server-only, subscription endpoint requires staff auth
