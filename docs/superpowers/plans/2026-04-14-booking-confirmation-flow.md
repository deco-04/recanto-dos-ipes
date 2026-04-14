# Booking Confirmation Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a REQUESTED booking state so direct bookings require admin Confirm/Decline before payment is captured; all stages captured in GHL for nurture; guest sees appropriate page/messages at each stage; applies to all 3 property brands.

**Architecture:** Stripe PaymentIntent switches to `capture_method: 'manual'` so the card is held on guest submit. `POST /api/bookings/confirm` (called by the guest's browser after Stripe succeeds) now sets status `REQUESTED` and fires request-received messages + GHL event. Two new staff endpoints (`/confirmar`, `/recusar`) handle the admin action — `/confirmar` captures the Stripe PI and fires confirmation; `/recusar` cancels it and fires decline. The staff app ReservaDetail shows Confirm/Decline buttons only when `status === 'REQUESTED'`.

**Tech Stack:** Node.js + Express + Prisma (backend) · Next.js 14 + TypeScript + Tailwind (staff app) · Stripe SDK · GoHighLevel webhooks · Gmail API via `lib/mailer.js`

---

## File Map

### Backend (`Sítio Recanto dos Ipês/`)
| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `REQUESTED` to `BookingStatus`; add `petDescription`, `adminDeclineNote` to `Booking`; add `phone`, `websiteUrl` to `Property` |
| `routes/bookings.js` | `capture_method: 'manual'`; availability blocks REQUESTED; `/confirm` handler sets REQUESTED + fires messages |
| `routes/staff-portal.js` | Add `POST /:id/confirmar` and `POST /:id/recusar` endpoints |
| `lib/mailer.js` | Add `sendBookingRequestReceived()` and `sendBookingDeclined()`; update `sendBookingConfirmation()` with `petDescription` |
| `lib/ghl-webhook.js` | Add `notifyBookingRequested()` and `notifyBookingDeclined()` |
| `.env.example` | Add `GHL_BOOKING_REQUESTED_URL` and `GHL_BOOKING_DECLINED_URL` |
| `public/js/booking.js` | Change redirect from `/reserva-confirmada` to `/reserva-solicitada` after confirm |
| `public/reserva-solicitada.html` | New guest success page for REQUESTED state |

### Staff App (`recantos-central-equipe/`)
| File | Change |
|---|---|
| `components/admin/ReservasList.tsx` | Add `'REQUESTED'` to `Reserva` type + constants; add filter chip + card action hint |
| `components/admin/ReservaDetail.tsx` | Add `'REQUESTED'` to type + constants; alert banner + Confirm/Decline action component |

---

## Task 1: Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add REQUESTED to BookingStatus enum**

In `prisma/schema.prisma`, find the `BookingStatus` enum (currently around line 103) and add `REQUESTED` between `PENDING` and `CONFIRMED`:

```prisma
enum BookingStatus {
  PENDING
  REQUESTED
  CONFIRMED
  CANCELLED
  REFUNDED
}
```

- [ ] **Step 2: Add new fields to Booking model**

In the `Booking` model (around line 57), add three fields after `notes String?`:

```prisma
  notes                 String?
  petDescription        String?   // free-text pet description, e.g. "1 cachorro pequeno"
  adminDeclineNote      String?   // admin's typed reason, stored for audit trail
```

- [ ] **Step 3: Add phone and websiteUrl to Property model**

In the `Property` model (around line 166), add after `porteiroPhone`:

```prisma
  porteiroPhone  String?
  phone          String?   // e.g. "+55 31 2391-6688"
  websiteUrl     String?   // e.g. "sitiorecantodosipes.com"
```

- [ ] **Step 4: Run migration**

```bash
cd "Sítio Recanto dos Ipês"
npx prisma migrate dev --name add_requested_status_and_pet_description
```

Expected: Migration created and applied. `prisma generate` runs automatically.

- [ ] **Step 5: Verify**

```bash
npx prisma studio
```

Open http://localhost:5555 → Booking model → confirm `petDescription`, `adminDeclineNote` columns exist. Check BookingStatus enum values include REQUESTED.

- [ ] **Step 6: Commit**

```bash
git add prisma/
git commit -m "feat: add REQUESTED booking status, petDescription, adminDeclineNote, Property phone/websiteUrl"
```

---

## Task 2: Stripe Pre-Auth + Availability

**Files:**
- Modify: `routes/bookings.js`

This task has two parts: (a) make the Stripe PaymentIntent use manual capture, (b) update availability checks to block REQUESTED dates.

- [ ] **Step 1: Switch PaymentIntent to manual capture**

In `routes/bookings.js`, around line 169, find the `stripe.paymentIntents.create()` call and add `capture_method: 'manual'`:

```javascript
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   Math.round(quote.totalAmount * 100), // cents
      currency: 'brl',
      capture_method: 'manual',          // ← hold card, don't charge yet
      metadata: {
        checkIn, checkOut,
        guestCount: String(guestCount),
        petCount:   String(petCount),
        hasPet:     String(hasPet),
        guestName, guestEmail,
      },
      description: `Reserva Recanto dos Ipês — ${checkIn} a ${checkOut}`,
    });
```

- [ ] **Step 2: Add petDescription to booking.create data**

In the same `POST /intent` handler, the Zod schema (around line 125) must accept `petDescription`:

```javascript
    const schema = z.object({
      checkIn:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      checkOut:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      guestCount:    z.number().int().min(1).max(20),
      petCount:      z.number().int().min(0).max(4).optional().default(0),
      guestName:     z.string().min(2).max(120),
      guestEmail:    z.string().email(),
      guestPhone:    z.string().min(8).max(30),
      guestCpf:      z.string().optional(),
      petDescription: z.string().max(200).optional(),
      notes:         z.string().max(500).optional(),
    });
```

Then in the `prisma.booking.create` call (around line 183), add `petDescription`:

```javascript
    const booking = await prisma.booking.create({
      data: {
        userId:               req.session?.userId ?? null,
        guestName, guestEmail, guestPhone,
        guestCpf:             guestCpf || null,
        checkIn:              inDate,
        checkOut:             outDate,
        nights:               quote.nights,
        guestCount,
        extraGuests:          quote.extraGuests,
        hasPet,
        petDescription:       data.petDescription || null,   // ← new
        baseRatePerNight:     quote.baseRatePerNight,
        extraGuestFee:        quote.extraGuestFee,
        petFee:               quote.petFee,
        totalAmount:          quote.totalAmount,
        stripePaymentIntentId: paymentIntent.id,
        notes:                data.notes || null,
        status:               'PENDING',
        source:               'DIRECT',
      },
    });
```

- [ ] **Step 3: Block REQUESTED dates in availability checks**

There are two places in `routes/bookings.js` that query bookings to check conflicts. Both must now include `REQUESTED` in the blocked statuses.

**In `GET /availability` (around line 64):**
```javascript
    const bookings = await prisma.booking.findMany({
      where: {
        status:   { in: ['CONFIRMED', 'REQUESTED'] },   // ← add REQUESTED
        checkIn:  { lte: end },
        checkOut: { gte: start },
      },
      select: { checkIn: true, checkOut: true },
    });
```

**In `POST /intent` conflict check (around line 151):**
```javascript
      const bookingConflict = await tx.booking.count({
        where: {
          status: { in: ['CONFIRMED', 'PENDING', 'REQUESTED'] },  // ← add REQUESTED
          checkIn:  { lt: outDate },
          checkOut: { gt: inDate },
        },
      });
```

- [ ] **Step 4: Update /confirm to handle requires_capture status**

The `POST /confirm` handler (around line 232) currently checks `pi.status !== 'succeeded'`. With manual capture, the PI status after client-side confirm is `requires_capture`. Replace the check:

```javascript
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== 'requires_capture') {
      return res.status(402).json({ error: 'Pagamento não autorizado' });
    }
```

- [ ] **Step 5: Change confirm to set REQUESTED + fire request messages**

Replace everything from the atomic transaction to the end of `POST /confirm` (lines 247–291). The new version:

```javascript
    // 3. Atomic final availability check + set REQUESTED
    const result = await prisma.$transaction(async tx => {
      const blockedCount = await tx.blockedDate.count({
        where: { date: { gte: pending.checkIn, lt: pending.checkOut } },
      });
      if (blockedCount > 0) return { conflict: true };

      const bookingConflict = await tx.booking.count({
        where: {
          id:       { not: bookingId },
          status:   { in: ['CONFIRMED', 'REQUESTED'] },
          checkIn:  { lt: pending.checkOut },
          checkOut: { gt: pending.checkIn },
        },
      });
      if (bookingConflict > 0) return { conflict: true };

      const requested = await tx.booking.update({
        where: { id: bookingId },
        data:  { status: 'REQUESTED' },
      });
      return { requested };
    });

    // 4. Handle conflict: cancel pre-auth
    if (result.conflict) {
      console.warn(`[bookings] confirm conflict on booking ${bookingId} — cancelling pre-auth`);
      await stripe.paymentIntents.cancel(paymentIntentId)
        .catch(e => console.error('[bookings] PI cancel failed:', e.message));
      await prisma.booking.update({
        where: { id: bookingId },
        data:  { status: 'CANCELLED' },
      }).catch(() => {});
      return res.status(409).json({
        error: 'Infelizmente as datas foram reservadas por outra pessoa durante o seu checkout. A pré-autorização do seu cartão foi cancelada.',
      });
    }

    // 5. Fire request-received messages + GHL (non-blocking)
    const { sendBookingRequestReceived } = require('../lib/mailer');
    const { notifyBookingRequested }     = require('../lib/ghl-webhook');
    const { sendPushToRole }             = require('../lib/push');

    sendBookingRequestReceived({ booking: result.requested })
      .catch(e => console.error('[mailer] requestReceived error:', e.message));

    notifyBookingRequested(result.requested)
      .catch(e => console.error('[ghl] notifyRequested error:', e.message));

    sendPushToRole('ADMIN', {
      title: 'Nova solicitação de reserva',
      body:  `${result.requested.guestName} · ${result.requested.checkIn.toISOString().split('T')[0]} → ${result.requested.checkOut.toISOString().split('T')[0]}`,
      type:  'BOOKING_REQUESTED',
      data:  { bookingId: result.requested.id },
    }).catch(() => {});

    res.json({ success: true, booking: sanitizeBooking(result.requested) });
```

- [ ] **Step 6: Manual test — intent + confirm**

Start the server: `npm start`

Create an intent (use test card `4000000000003220` for 3D Secure pre-auth):
```bash
curl -s -X POST http://localhost:3000/api/bookings/intent \
  -H 'Content-Type: application/json' \
  -d '{
    "checkIn":"2025-08-01","checkOut":"2025-08-04",
    "guestCount":2,"guestName":"Test Guest","guestEmail":"test@test.com",
    "guestPhone":"+5531999999999","petCount":1,"petDescription":"1 gato"
  }' | jq '{clientSecret: .clientSecret, bookingId: .bookingId}'
```

Expected: `clientSecret` starting with `pi_...`, `bookingId` present.

Then simulate a confirmed pre-auth (Stripe test mode, PI reaches `requires_capture`):
```bash
# Use Stripe CLI to confirm test PI to requires_capture state:
# stripe payment_intents confirm <pi_id> --payment-method pm_card_visa
# Then check status:
# stripe payment_intents retrieve <pi_id> | grep '"status"'
# Expected: "requires_capture"

# Then call our /confirm endpoint:
curl -s -X POST http://localhost:3000/api/bookings/confirm \
  -H 'Content-Type: application/json' \
  -d '{"paymentIntentId":"<pi_id>","bookingId":"<booking_id>"}' | jq .
```

Expected response: `{ success: true, booking: { ..., status: "REQUESTED" } }`

Check DB: `npx prisma studio` → Booking → confirm `status = REQUESTED`.

- [ ] **Step 7: Commit**

```bash
git add routes/bookings.js
git commit -m "feat: switch to Stripe pre-auth and REQUESTED booking status on confirm"
```

---

## Task 3: Email Templates

**Files:**
- Modify: `lib/mailer.js`

Read the existing `sendBookingConfirmation` function (lines 175–242) to understand the HTML template pattern before adding new functions.

- [ ] **Step 1: Add FROM_RECANTO helper note**

Confirm `FROM_RECANTO` is a function already defined earlier in `lib/mailer.js`. (It is — search for `function FROM_RECANTO` to find it.) All new templates use the same pattern.

- [ ] **Step 2: Add sendBookingRequestReceived function**

Add this function before `module.exports` at the bottom of `lib/mailer.js`:

```javascript
/**
 * Email sent when a direct booking lands as REQUESTED (pre-auth held).
 * Guest is informed their request is under review; no charge yet.
 */
async function sendBookingRequestReceived({ booking }) {
  const checkIn  = new Date(booking.checkIn).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const checkOut = new Date(booking.checkOut).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const total    = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(booking.totalAmount));
  const petLine  = booking.hasPet
    ? `<tr><td style="color:#6B6B6B;font-size:13px;">Pet</td><td style="color:#261C15;font-weight:600;font-size:13px;">${booking.petDescription || 'Sim'}</td></tr>`
    : '';

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"></head>
    <body style="margin:0;padding:0;background:#F7F7F2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F2;padding:40px 20px;">
        <tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <tr><td style="background:#261C15;padding:32px;text-align:center;">
              <img src="https://sitiorecantodosipes.com/brand/sri-mark-white.svg" width="88" alt="Sítio Recanto dos Ipês" style="display:block;margin:0 auto 20px;border:0;height:auto;">
              <p style="margin:0;color:#C5D86D;font-size:22px;font-weight:700;">☀️ Solicitação Recebida!</p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:13px;">Sítio Recanto dos Ipês · Jaboticatubas, MG</p>
            </td></tr>
            <tr><td style="padding:40px 36px;">
              <p style="margin:0 0 16px;color:#1A1A1A;font-size:16px;">Olá, <strong>${booking.guestName}</strong>!</p>
              <p style="margin:0 0 24px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                Recebemos sua solicitação de reserva! Nossa equipe irá analisar e confirmar em até <strong>24 horas</strong>.
              </p>
              <table width="100%" style="background:#F7F7F2;border-radius:12px;padding:20px;margin-bottom:24px;" cellpadding="8">
                <tr><td style="color:#6B6B6B;font-size:13px;">Check-in</td><td style="color:#261C15;font-weight:600;font-size:13px;">${checkIn}</td></tr>
                <tr><td style="color:#6B6B6B;font-size:13px;">Check-out</td><td style="color:#261C15;font-weight:600;font-size:13px;">${checkOut}</td></tr>
                <tr><td style="color:#6B6B6B;font-size:13px;">Hóspedes</td><td style="color:#261C15;font-weight:600;font-size:13px;">${booking.guestCount}</td></tr>
                ${petLine}
                <tr><td style="color:#6B6B6B;font-size:13px;">Pré-autorizado</td><td style="color:#261C15;font-weight:700;font-size:14px;">${total} <span style="font-weight:400;font-size:11px;color:#9A9A9A;">(não cobrado ainda)</span></td></tr>
              </table>
              <div style="background:#FEF9EE;border-radius:10px;padding:16px;margin-bottom:24px;">
                <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#92400E;">O que acontece agora?</p>
                <p style="margin:0;font-size:13px;color:#78350F;line-height:1.6;">
                  1. Nossa equipe revisa sua solicitação.<br>
                  2. Ao confirmar, o valor é cobrado e você recebe todos os detalhes.<br>
                  3. Se não pudermos confirmar, a pré-autorização é cancelada sem nenhum custo.
                </p>
              </div>
              <p style="margin:0;color:#9A9A9A;font-size:12px;line-height:1.6;">
                Dúvidas? Entre em contato via WhatsApp: +55 31 2391-6688
              </p>
            </td></tr>
            <tr><td style="background:#F7F7F2;padding:20px 36px;border-top:1px solid #E4E6C3;">
              <p style="margin:0;color:#9A9A9A;font-size:11px;text-align:center;">
                © ${new Date().getFullYear()} Sítio Recanto dos Ipês · Jaboticatubas, MG
              </p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  await sendMail({
    from:    FROM_RECANTO(),
    to:      booking.guestEmail,
    subject: 'Sua solicitação de reserva foi recebida ☀️',
    html,
    text: `Olá, ${booking.guestName}!\n\nRecebemos sua solicitação de reserva para ${checkIn} a ${checkOut} (${booking.guestCount} hóspedes). Valor pré-autorizado: ${total}.\n\nNossa equipe confirmará em até 24 horas. Nenhum valor foi cobrado ainda.\n\nDúvidas: +55 31 2391-6688`,
  });
}
```

- [ ] **Step 3: Add sendBookingDeclined function**

Add this function after `sendBookingRequestReceived`, before `module.exports`:

```javascript
/**
 * Email sent when admin declines a REQUESTED booking.
 * Includes admin's typed reason. Pre-auth was already cancelled before calling this.
 */
async function sendBookingDeclined({ booking, declineReason }) {
  const checkIn  = new Date(booking.checkIn).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  const checkOut = new Date(booking.checkOut).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"></head>
    <body style="margin:0;padding:0;background:#F7F7F2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F2;padding:40px 20px;">
        <tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <tr><td style="background:#261C15;padding:32px;text-align:center;">
              <img src="https://sitiorecantodosipes.com/brand/sri-mark-white.svg" width="88" alt="Sítio Recanto dos Ipês" style="display:block;margin:0 auto 20px;border:0;height:auto;">
              <p style="margin:0;color:#C5D86D;font-size:18px;font-weight:700;">Atualização sobre sua solicitação</p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:13px;">Sítio Recanto dos Ipês · Jaboticatubas, MG</p>
            </td></tr>
            <tr><td style="padding:40px 36px;">
              <p style="margin:0 0 16px;color:#1A1A1A;font-size:16px;">Olá, <strong>${booking.guestName}</strong>,</p>
              <p style="margin:0 0 24px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                Infelizmente não foi possível confirmar sua solicitação para o período de <strong>${checkIn}</strong> a <strong>${checkOut}</strong>.
              </p>
              <div style="background:#FFF5F5;border-left:4px solid #FCA5A5;border-radius:0 10px 10px 0;padding:16px;margin-bottom:24px;">
                <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#991B1B;text-transform:uppercase;letter-spacing:0.5px;">Motivo</p>
                <p style="margin:0;font-size:13px;color:#7F1D1D;line-height:1.6;">${declineReason || 'As datas solicitadas não estão disponíveis.'}</p>
              </div>
              <div style="background:#F0FDF4;border-radius:10px;padding:16px;margin-bottom:24px;">
                <p style="margin:0;font-size:13px;color:#14532D;line-height:1.6;">
                  ✓ A pré-autorização do seu cartão foi <strong>cancelada automaticamente</strong>. Nenhum valor foi cobrado.
                </p>
              </div>
              <p style="margin:0 0 16px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                Adoraríamos recebê-lo(a) em outra data! Consulte nossa disponibilidade:
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
                <tr><td style="background:#2B7929;border-radius:10px;padding:12px 28px;">
                  <a href="https://sitiorecantodosipes.com/booking" style="color:white;font-weight:700;font-size:14px;text-decoration:none;">Ver disponibilidade</a>
                </td></tr>
              </table>
              <p style="margin:0;color:#9A9A9A;font-size:12px;">
                Dúvidas? Fale conosco: +55 31 2391-6688
              </p>
            </td></tr>
            <tr><td style="background:#F7F7F2;padding:20px 36px;border-top:1px solid #E4E6C3;">
              <p style="margin:0;color:#9A9A9A;font-size:11px;text-align:center;">
                © ${new Date().getFullYear()} Sítio Recanto dos Ipês · Jaboticatubas, MG
              </p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  await sendMail({
    from:    FROM_RECANTO(),
    to:      booking.guestEmail,
    subject: 'Atualização sobre sua solicitação de reserva',
    html,
    text: `Olá, ${booking.guestName},\n\nInfelizmente não foi possível confirmar sua solicitação.\n\nMotivo: ${declineReason || 'As datas solicitadas não estão disponíveis.'}\n\nA pré-autorização do seu cartão foi cancelada. Nenhum valor foi cobrado.\n\nConsulte outras datas em: sitiorecantodosipes.com/booking`,
  });
}
```

- [ ] **Step 4: Update sendBookingConfirmation to include petDescription**

In the existing `sendBookingConfirmation` function (around line 180), the `petReminderHtml` currently checks `booking.petCount > 0`. Since `petCount` may not be on the booking object when called from the staff confirm endpoint, change the condition to check `booking.hasPet`:

```javascript
  const petReminderHtml = booking.hasPet ? `
  <tr>
    <td style="padding:16px 32px;background:#f9f4ef;border-radius:8px;margin:0 32px;">
      <p style="margin:0;font-size:14px;color:#5a4a3f;line-height:1.6;">
        🐾 <strong>Lembrete sobre seus pets:</strong>${booking.petDescription ? ` ${booking.petDescription}.` : ''} Pedimos que os animais sejam mantidos supervisionados
        durante toda a estadia, e que dejetos sejam recolhidos do jardim e áreas comuns.
        Qualquer dúvida, entre em contato via WhatsApp antes da chegada. Obrigado pela compreensão! 🙏
      </p>
    </td>
  </tr>
  <tr><td style="height:16px"></td></tr>
` : '';
```

Also add `petDescription` to the booking summary table (after `guestCount` row):

```javascript
                <tr><td style="color:#6B6B6B;font-size:13px;">Hóspedes</td><td style="color:#261C15;font-weight:600;font-size:13px;">${booking.guestCount}</td></tr>
                ${booking.hasPet ? `<tr><td style="color:#6B6B6B;font-size:13px;">Pet</td><td style="color:#261C15;font-weight:600;font-size:13px;">${booking.petDescription || 'Sim'}</td></tr>` : ''}
                <tr><td style="color:#6B6B6B;font-size:13px;">Total pago</td>...
```

- [ ] **Step 5: Export new functions**

Update `module.exports` at the bottom of `lib/mailer.js`:

```javascript
module.exports = {
  sendOtpEmail,
  sendBookingConfirmation,
  sendBookingRequestReceived,   // ← new
  sendBookingDeclined,           // ← new
  sendStaffInvite,
  sendAdminNotification,
  sendGuestInvite,
  sendPasswordResetEmail,
  sendCheckoutProblemaAlert,
  sendInboxEmail,
};
```

- [ ] **Step 6: Smoke test**

```bash
node -e "
const { sendBookingRequestReceived } = require('./lib/mailer');
sendBookingRequestReceived({ booking: {
  guestName: 'Test Guest', guestEmail: 'andre@test.com',
  checkIn: new Date('2025-08-01'), checkOut: new Date('2025-08-04'),
  guestCount: 2, hasPet: true, petDescription: '1 gato', totalAmount: 890
}}).then(() => console.log('OK')).catch(console.error);
"
```

Expected: `OK` (check your Gmail inbox for the test email)

- [ ] **Step 7: Commit**

```bash
git add lib/mailer.js
git commit -m "feat: add sendBookingRequestReceived and sendBookingDeclined email templates"
```

---

## Task 4: GHL Webhook Functions

**Files:**
- Modify: `lib/ghl-webhook.js`
- Modify: `.env.example`

These functions fire events to GHL so that workflows can handle contact creation, pipeline stage moves, and automation sequences.

- [ ] **Step 1: Add env vars to .env.example**

In `.env.example`, after the existing `GHL_WEBHOOK_URL` line:

```
GHL_WEBHOOK_URL="https://services.leadconnectorhq.com/hooks/..."       # fired on booking.confirmed
GHL_BOOKING_REQUESTED_URL="https://services.leadconnectorhq.com/hooks/..."  # fired on booking.requested (new)
GHL_BOOKING_DECLINED_URL="https://services.leadconnectorhq.com/hooks/..."   # fired on booking.declined (new)
```

- [ ] **Step 2: Add notifyBookingRequested function**

In `lib/ghl-webhook.js`, add after the existing `notifyBookingConfirmed` function:

```javascript
/**
 * Fires when a direct booking lands as REQUESTED (pre-auth held, awaiting admin).
 * GHL workflow: create/update contact → move to "Solicitação" pipeline stage → fire request-received automation.
 *
 * Set GHL_BOOKING_REQUESTED_URL env var to your GHL workflow webhook URL.
 */
async function notifyBookingRequested(booking) {
  const url = process.env.GHL_BOOKING_REQUESTED_URL;
  if (!url) return;

  const payload = JSON.stringify({
    event:          'booking.requested',
    bookingId:      booking.id,
    invoiceNumber:  booking.invoiceNumber,
    guestName:      booking.guestName,
    guestEmail:     booking.guestEmail,
    guestPhone:     booking.guestPhone,
    checkIn:        booking.checkIn,
    checkOut:       booking.checkOut,
    nights:         booking.nights,
    guestCount:     booking.guestCount,
    hasPet:         booking.hasPet,
    petDescription: booking.petDescription || null,
    totalAmount:    Number(booking.totalAmount),
    source:         booking.source,
    createdAt:      booking.createdAt,
  });

  return postJson(url, payload).catch(e =>
    console.error('[ghl] notifyBookingRequested error:', e.message)
  );
}
```

- [ ] **Step 3: Add notifyBookingDeclined function**

Add after `notifyBookingRequested`:

```javascript
/**
 * Fires when admin declines a booking (REQUESTED → CANCELLED).
 * GHL workflow: move contact to "Recusada/Cancelada" stage → tag recusa-nurture → enter re-engagement sequence.
 *
 * Set GHL_BOOKING_DECLINED_URL env var to your GHL workflow webhook URL.
 */
async function notifyBookingDeclined(booking) {
  const url = process.env.GHL_BOOKING_DECLINED_URL;
  if (!url) return;

  const payload = JSON.stringify({
    event:          'booking.declined',
    bookingId:      booking.id,
    invoiceNumber:  booking.invoiceNumber,
    guestName:      booking.guestName,
    guestEmail:     booking.guestEmail,
    guestPhone:     booking.guestPhone,
    checkIn:        booking.checkIn,
    checkOut:       booking.checkOut,
    nights:         booking.nights,
    guestCount:     booking.guestCount,
    hasPet:         booking.hasPet,
    petDescription: booking.petDescription || null,
    totalAmount:    Number(booking.totalAmount),
    source:         booking.source,
    declineReason:  booking.adminDeclineNote || null,
    createdAt:      booking.createdAt,
  });

  return postJson(url, payload).catch(e =>
    console.error('[ghl] notifyBookingDeclined error:', e.message)
  );
}
```

- [ ] **Step 4: Update module.exports**

```javascript
module.exports = {
  notifyBookingConfirmed,
  notifyBookingRequested,   // ← new
  notifyBookingDeclined,    // ← new
  notifyOTABooking,
  notifyContactCreated,
  sendGuestListReminder,
  sendPorteiroMessage,
  sendWhatsAppMessage,
  sendInstagramDM,
};
```

- [ ] **Step 5: Commit**

```bash
git add lib/ghl-webhook.js .env.example
git commit -m "feat: add GHL notifyBookingRequested and notifyBookingDeclined webhook functions"
```

---

## Task 5: Staff Portal Endpoints

**Files:**
- Modify: `routes/staff-portal.js`

First, read the top of `routes/staff-portal.js` to find where `requireStaff` middleware is defined (it uses the same jwt.verify + prisma.staffMember.findUnique pattern) and where the existing reservation endpoints start. Find the `PATCH /reservas/:id` endpoint — the new endpoints go after it.

- [ ] **Step 1: Find insertion point**

```bash
grep -n "router\.\(post\|patch\|get\|delete\).*reservas" routes/staff-portal.js | head -20
```

Identify the last reservation-related route to know where to insert the two new POST routes.

- [ ] **Step 2: Add POST /reservas/:id/confirmar**

Add this route after the existing reservation PATCH/GET routes:

```javascript
// ── POST /reservas/:id/confirmar — admin confirms a REQUESTED booking ──────────
router.post('/reservas/:id/confirmar', requireStaff, async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
    if (booking.status !== 'REQUESTED') {
      return res.status(400).json({ error: `Reserva está em status ${booking.status}, não pode ser confirmada` });
    }
    if (!booking.stripePaymentIntentId) {
      return res.status(400).json({ error: 'Reserva sem PaymentIntent Stripe' });
    }

    const stripe = require('../lib/stripe');

    // Final availability check before capturing payment
    const conflict = await prisma.$transaction(async tx => {
      const blockedCount = await tx.blockedDate.count({
        where: { date: { gte: booking.checkIn, lt: booking.checkOut } },
      });
      if (blockedCount > 0) return true;

      const bookingConflict = await tx.booking.count({
        where: {
          id:       { not: booking.id },
          status:   'CONFIRMED',
          checkIn:  { lt: booking.checkOut },
          checkOut: { gt: booking.checkIn },
        },
      });
      return bookingConflict > 0;
    });

    if (conflict) {
      // Cancel pre-auth and decline
      await stripe.paymentIntents.cancel(booking.stripePaymentIntentId)
        .catch(e => console.error('[staff] PI cancel on conflict:', e.message));
      const cancelled = await prisma.booking.update({
        where: { id: booking.id },
        data:  { status: 'CANCELLED', adminDeclineNote: 'Datas indisponíveis no momento da confirmação' },
      });
      const { sendBookingDeclined }  = require('../lib/mailer');
      const { notifyBookingDeclined } = require('../lib/ghl-webhook');
      sendBookingDeclined({ booking: cancelled, declineReason: cancelled.adminDeclineNote }).catch(() => {});
      notifyBookingDeclined(cancelled).catch(() => {});
      return res.status(409).json({ error: 'Datas ficaram indisponíveis. Reserva cancelada e hóspede notificado.' });
    }

    // Capture the pre-authorized payment
    await stripe.paymentIntents.capture(booking.stripePaymentIntentId);

    const confirmed = await prisma.booking.update({
      where: { id: booking.id },
      data:  { status: 'CONFIRMED' },
    });

    // Fire confirmation messages (non-blocking)
    const { sendBookingConfirmation }  = require('../lib/mailer');
    const { notifyBookingConfirmed }   = require('../lib/ghl-webhook');
    sendBookingConfirmation({ booking: confirmed }).catch(e => console.error('[mailer] confirm email error:', e.message));
    notifyBookingConfirmed(confirmed).catch(e => console.error('[ghl] confirm webhook error:', e.message));

    res.json({ ok: true, booking: confirmed });
  } catch (err) {
    console.error('[staff] confirmar error:', err);
    res.status(500).json({ error: err.message || 'Erro ao confirmar reserva' });
  }
});
```

- [ ] **Step 3: Add POST /reservas/:id/recusar**

Add immediately after the confirmar route:

```javascript
// ── POST /reservas/:id/recusar — admin declines a REQUESTED booking ───────────
router.post('/reservas/:id/recusar', requireStaff, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message é obrigatório' });

  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
    if (booking.status !== 'REQUESTED') {
      return res.status(400).json({ error: `Reserva está em status ${booking.status}, não pode ser recusada` });
    }
    if (!booking.stripePaymentIntentId) {
      return res.status(400).json({ error: 'Reserva sem PaymentIntent Stripe' });
    }

    const stripe = require('../lib/stripe');

    // Cancel the pre-authorization (no charge)
    await stripe.paymentIntents.cancel(booking.stripePaymentIntentId);

    const declined = await prisma.booking.update({
      where: { id: booking.id },
      data:  { status: 'CANCELLED', adminDeclineNote: message.trim() },
    });

    // Fire decline messages (non-blocking)
    const { sendBookingDeclined }   = require('../lib/mailer');
    const { notifyBookingDeclined } = require('../lib/ghl-webhook');
    sendBookingDeclined({ booking: declined, declineReason: message.trim() })
      .catch(e => console.error('[mailer] decline email error:', e.message));
    notifyBookingDeclined(declined)
      .catch(e => console.error('[ghl] decline webhook error:', e.message));

    res.json({ ok: true, booking: declined });
  } catch (err) {
    console.error('[staff] recusar error:', err);
    res.status(500).json({ error: err.message || 'Erro ao recusar reserva' });
  }
});
```

- [ ] **Step 4: Manual test — confirmar endpoint**

Start the server. Create a REQUESTED booking using Task 2 steps. Then get a valid staff token (from the staff app login or the DB). Then:

```bash
# Replace <booking_id> and <staff_token>
curl -s -X POST http://localhost:3000/api/staff/reservas/<booking_id>/confirmar \
  -H 'Authorization: Bearer <staff_token>' \
  -H 'Content-Type: application/json' | jq '.booking.status'
```

Expected: `"CONFIRMED"`. Check DB → booking status CONFIRMED. Check that Stripe PI was captured (dashboard.stripe.com or `stripe payment_intents retrieve <pi_id>`).

- [ ] **Step 5: Manual test — recusar endpoint**

Create another REQUESTED booking (fresh Stripe PI). Then:

```bash
curl -s -X POST http://localhost:3000/api/staff/reservas/<booking_id>/recusar \
  -H 'Authorization: Bearer <staff_token>' \
  -H 'Content-Type: application/json' \
  -d '{"message":"As datas solicitadas não estão mais disponíveis."}' | jq '.booking.status'
```

Expected: `"CANCELLED"`. Check DB → `status = CANCELLED`, `adminDeclineNote` populated. Check Stripe → PI cancelled.

- [ ] **Step 6: Commit**

```bash
git add routes/staff-portal.js
git commit -m "feat: add staff confirmar and recusar endpoints for REQUESTED bookings"
```

---

## Task 6: Guest Success Page

**Files:**
- Modify: `public/js/booking.js`
- Create: `public/reserva-solicitada.html`

- [ ] **Step 1: Change redirect in booking.js**

In `public/js/booking.js`, around line 243, change the redirect target:

```javascript
    try {
      sessionStorage.setItem('rdi_booking_confirmation', JSON.stringify(bookingData));
      window.location.href = '/reserva-solicitada';   // ← was '/reserva-confirmada'
    } catch {
      showSuccessModal(bookingData);
      document.getElementById('success-email').value = email;
    }
```

- [ ] **Step 2: Create reserva-solicitada.html**

Create `public/reserva-solicitada.html`:

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Solicitação Recebida — Sítio Recanto dos Ipês</title>
  <link rel="stylesheet" href="/css/sri-design.css">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    body { background: #F7F7F2; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
    .card { background: white; border-radius: 20px; padding: 32px 28px; max-width: 420px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .icon-wrap { width: 64px; height: 64px; background: #FEF3C7; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 32px; }
    h1 { font-size: 22px; font-weight: 800; color: #261C15; text-align: center; margin: 0 0 8px; }
    .subtitle { font-size: 14px; color: #6B6B6B; text-align: center; margin: 0 0 28px; line-height: 1.5; }
    .steps { background: #FEF9EE; border-radius: 12px; padding: 16px; margin-bottom: 24px; }
    .steps p { margin: 0 0 4px; font-size: 12px; font-weight: 700; color: #92400E; text-transform: uppercase; letter-spacing: 0.5px; }
    .step { display: flex; gap: 12px; align-items: flex-start; margin-top: 12px; }
    .step-num { width: 24px; height: 24px; min-width: 24px; background: #FEF3C7; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #92400E; }
    .step-text { font-size: 13px; color: #78350F; line-height: 1.5; padding-top: 2px; }
    .summary { background: #F7F7F2; border-radius: 12px; padding: 16px; margin-bottom: 24px; }
    .summary-row { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px; }
    .summary-row .label { color: #6B6B6B; }
    .summary-row .value { font-weight: 600; color: #261C15; }
    .summary-row.total { border-top: 1px solid #E5E7EB; margin-top: 8px; padding-top: 8px; }
    .summary-row.total .value { font-size: 15px; font-weight: 700; }
    .contact { background: #F0FDF4; border-radius: 10px; padding: 12px; text-align: center; font-size: 12px; color: #14532D; line-height: 1.6; }
    .contact a { color: #2B7929; font-weight: 600; text-decoration: none; }
    .brand { display: block; width: 64px; height: auto; margin: 0 auto 24px; }
  </style>
</head>
<body>
  <div class="card">
    <img src="/brand/sri-mark-color.svg" alt="Sítio Recanto dos Ipês" class="brand">
    <div class="icon-wrap">⏳</div>
    <h1>Solicitação recebida!</h1>
    <p class="subtitle">Já recebemos seu pedido de reserva.<br>Nossa equipe confirma em breve.</p>

    <div class="steps">
      <p>O que acontece agora?</p>
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text">Nossa equipe analisa sua solicitação em até <strong>24 horas</strong>.</div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text">Ao confirmar, o valor é cobrado e você recebe todos os detalhes por e-mail e WhatsApp.</div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text">Se não pudermos confirmar, a pré-autorização do cartão é cancelada sem nenhum custo.</div>
      </div>
    </div>

    <div class="summary" id="booking-summary">
      <!-- populated by JS -->
    </div>

    <div class="contact">
      Dúvidas? Fale conosco:<br>
      <a href="tel:+553123916688">+55 31 2391-6688</a> ·
      <a href="https://wa.me/553123916688">WhatsApp</a>
    </div>
  </div>

  <script>
    (function() {
      const raw = sessionStorage.getItem('rdi_booking_confirmation');
      if (!raw) return;
      try {
        const b = JSON.parse(raw);
        const fmt = d => new Date(d).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
        const cur = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        const petRow = b.hasPet ? `<div class="summary-row"><span class="label">Pet</span><span class="value">${b.petDescription || 'Sim'}</span></div>` : '';
        document.getElementById('booking-summary').innerHTML = `
          <div class="summary-row"><span class="label">Check-in</span><span class="value">${fmt(b.checkIn)}</span></div>
          <div class="summary-row"><span class="label">Check-out</span><span class="value">${fmt(b.checkOut)}</span></div>
          <div class="summary-row"><span class="label">Hóspedes</span><span class="value">${b.guestCount || '—'}</span></div>
          ${petRow}
          <div class="summary-row total"><span class="label">Pré-autorizado</span><span class="value">${b.totalAmount ? cur(b.totalAmount) : '—'}</span></div>
        `;
      } catch(e) { /* ignore */ }
    })();
  </script>
</body>
</html>
```

- [ ] **Step 3: Register the route in Express**

Open `server.js`. Check whether static files in `public/` are served automatically (they should be via `express.static`). If `reserva-solicitada.html` doesn't load automatically (Express static serving HTML files without extension), add an explicit route.

Search in `server.js` for `reserva-confirmada` to see how that route is declared:

```bash
grep -n "reserva-confirmada\|reserva-solicitada\|sendFile" server.js | head -10
```

If there's an explicit `app.get('/reserva-confirmada', ...)` route, add the same for the new page right below it:

```javascript
app.get('/reserva-solicitada', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reserva-solicitada.html'));
});
```

- [ ] **Step 4: Test the page**

Start server, open `http://localhost:3000/reserva-solicitada` in browser.

Expected: Page renders with the hourglass icon, "Solicitação recebida!" heading, 3-step list, and an empty summary box (since no sessionStorage data). No JS errors in console.

Then repeat with sessionStorage pre-populated:
```javascript
// In browser console on the page:
sessionStorage.setItem('rdi_booking_confirmation', JSON.stringify({
  checkIn: '2025-08-01', checkOut: '2025-08-04', guestCount: 3,
  hasPet: true, petDescription: '1 gato', totalAmount: 1890
}));
location.reload();
```

Expected: Summary box shows dates, 3 guests, pet, pre-authorized amount.

- [ ] **Step 5: Commit**

```bash
git add public/js/booking.js public/reserva-solicitada.html server.js
git commit -m "feat: add reserva-solicitada page and redirect booking flow to REQUESTED success"
```

---

## Task 7: Staff App — ReservasList

**Files:**
- Modify: `components/admin/ReservasList.tsx`

- [ ] **Step 1: Add REQUESTED to Reserva type and constants**

At the top of `ReservasList.tsx`, update the `Reserva` interface and all status-related constants:

```typescript
export interface Reserva {
  id: string;
  guestName: string;
  guestEmail?: string;
  guestPhone?: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  totalPrice: number;
  status: 'REQUESTED' | 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'COMPLETED';  // ← add REQUESTED
  source: 'DIRECT' | 'AIRBNB' | 'BOOKING';
  notes?: string;
  hasPet?: boolean;
  petDescription?: string;   // ← new
  otaTaskId?: string | null;
  createdAt?: string;
}

const STATUS_LABEL: Record<Reserva['status'], string> = {
  REQUESTED: 'Solicitada',   // ← new
  CONFIRMED: 'Confirmada',
  PENDING: 'Pendente',
  CANCELLED: 'Cancelada',
  COMPLETED: 'Concluída',
};

const STATUS_COLOR: Record<Reserva['status'], string> = {
  REQUESTED: 'bg-amber-100 text-amber-800',   // ← new
  CONFIRMED: 'bg-green-100 text-green-800',
  PENDING: 'bg-yellow-100 text-yellow-800',
  CANCELLED: 'bg-red-100 text-red-800',
  COMPLETED: 'bg-stone-100 text-stone-600',
};
```

- [ ] **Step 2: Add REQUESTED to the FilterStatus type and filter chips**

Update the `FilterStatus` type and the filter chips array. The current filter array (around line 137) is:
`(['ALL', 'CONFIRMED', 'PENDING', 'CANCELLED', 'COMPLETED'] as FilterStatus[])`

Change to:
```typescript
type FilterStatus = 'ALL' | Reserva['status'];
```

And the chips JSX (around line 137):
```tsx
      {/* Filtros de status */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {(['ALL', 'REQUESTED', 'CONFIRMED', 'CANCELLED', 'COMPLETED'] as (FilterStatus)[]).map((s) => (
          <button
            key={s}
            onClick={() => applyFilter(s)}
            className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              filter === s
                ? 'bg-[#3D2B1A] text-white border-[#3D2B1A]'
                : 'bg-white text-stone-600 border-stone-200'
            }`}
          >
            {s === 'ALL' ? 'Todas' : STATUS_LABEL[s as Reserva['status']]}
          </button>
        ))}
      </div>
```

Note: `PENDING` is removed from the chips (it's a brief internal state, not useful to filter on in the UI). REQUESTED replaces it.

- [ ] **Step 3: Add amber left-border and action hint to REQUESTED cards**

In the booking card JSX (around line 176), the outer `<div>` currently has `border border-stone-200`. Wrap the entire card in a conditional border:

```tsx
            <div className={`bg-white rounded-xl border p-4 space-y-3 active:bg-stone-50 transition-colors ${
              r.status === 'REQUESTED'
                ? 'border-l-4 border-l-amber-400 border-stone-200'
                : 'border-stone-200'
            }`}>
```

Then after the source/price row, add the action hint for REQUESTED bookings:

```tsx
                <div className="flex items-center justify-between">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SOURCE_COLOR[r.source]}`}>
                    {SOURCE_LABEL[r.source]}
                  </span>
                  <span className="font-bold text-stone-800">{formatCurrency(r.totalPrice)}</span>
                </div>
                {r.status === 'REQUESTED' && (
                  <div className="flex items-center gap-2 bg-amber-50 rounded-lg px-3 py-2">
                    <span className="text-sm">⏳</span>
                    <span className="text-xs text-amber-800 font-medium">
                      Aguardando sua confirmação
                      {r.createdAt && ` · há ${Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 3600000)}h`}
                    </span>
                  </div>
                )}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd recantos-central-equipe
npx tsc --noEmit
```

Expected: No errors related to ReservasList.tsx.

- [ ] **Step 5: Commit**

```bash
git add components/admin/ReservasList.tsx
git commit -m "feat: add REQUESTED status to reservations list with amber card treatment and action hint"
```

---

## Task 8: Staff App — ReservaDetail (Confirm/Decline UI)

**Files:**
- Modify: `components/admin/ReservaDetail.tsx`

- [ ] **Step 1: Add REQUESTED to type and constants in ReservaDetail.tsx**

At the top of `ReservaDetail.tsx`, both `STATUS_LABEL` and `STATUS_COLOR` records must include `REQUESTED`. Also update the import type to include `REQUESTED` (it already imports `Reserva` from ReservasList, so this is covered automatically after Task 7).

Verify `STATUS_LABEL` and `STATUS_COLOR` in this file include REQUESTED (they are defined separately here):

```typescript
const STATUS_LABEL: Record<Reserva['status'], string> = {
  REQUESTED: 'Solicitada',   // ← add
  CONFIRMED: 'Confirmada',
  PENDING:   'Pendente',
  CANCELLED: 'Cancelada',
  COMPLETED: 'Concluída',
};

const STATUS_COLOR: Record<Reserva['status'], string> = {
  REQUESTED: 'bg-amber-100 text-amber-800',   // ← add
  CONFIRMED: 'bg-green-100 text-green-800',
  PENDING:   'bg-yellow-100 text-yellow-800',
  CANCELLED: 'bg-red-100 text-red-800',
  COMPLETED: 'bg-stone-100 text-stone-600',
};
```

- [ ] **Step 2: Add state for confirm/decline UI**

In the `ReservaDetail` function body (after the existing `saving` / `saveMsg` state), add:

```typescript
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [declineOpen, setDeclineOpen]       = useState(false);
  const [declineMsg, setDeclineMsg]         = useState('Infelizmente as datas solicitadas não estão mais disponíveis.');
  const [declineLoading, setDeclineLoading] = useState(false);
  const [actionMsg, setActionMsg]           = useState<string | null>(null);
  const [actionError, setActionError]       = useState<string | null>(null);
```

- [ ] **Step 3: Add handleConfirm and handleDecline functions**

Add these two functions inside `ReservaDetail`, after `updateSource`:

```typescript
  async function handleConfirm() {
    if (!session?.staffToken) return;
    setConfirmLoading(true);
    setActionError(null);
    try {
      const res = await fetch(`${API_URL}/api/staff/reservas/${reserva.id}/confirmar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.staffToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao confirmar');
      setReserva(data.booking);
      setActionMsg('Reserva confirmada! Hóspede notificado.');
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Erro ao confirmar');
    } finally {
      setConfirmLoading(false);
    }
  }

  async function handleDecline() {
    if (!session?.staffToken || !declineMsg.trim()) return;
    setDeclineLoading(true);
    setActionError(null);
    try {
      const res = await fetch(`${API_URL}/api/staff/reservas/${reserva.id}/recusar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.staffToken}` },
        body: JSON.stringify({ message: declineMsg.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao recusar');
      setReserva(data.booking);
      setDeclineOpen(false);
      setActionMsg('Reserva recusada. Hóspede notificado e pré-autorização cancelada.');
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Erro ao recusar');
    } finally {
      setDeclineLoading(false);
    }
  }
```

- [ ] **Step 4: Add alert banner and action buttons to the JSX**

In the JSX `return` of `ReservaDetail`, after the `{/* Back */}` link and before `{/* Dados incompletos banner */}`, add the REQUESTED alert + action section:

```tsx
      {/* REQUESTED alert banner + actions */}
      {reserva.status === 'REQUESTED' && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 bg-amber-100 border-b border-amber-200">
            <span className="text-base">⏳</span>
            <p className="text-sm font-semibold text-amber-800">Aguardando confirmação</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-xs text-amber-700 leading-relaxed mb-3">
              Cartão pré-autorizado · {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(reserva.totalPrice)} · prazo: 7 dias
            </p>

            {actionMsg && (
              <p className="text-xs text-green-700 font-medium bg-green-50 rounded-lg px-3 py-2 mb-3">{actionMsg}</p>
            )}
            {actionError && (
              <p className="text-xs text-red-700 font-medium bg-red-50 rounded-lg px-3 py-2 mb-3">{actionError}</p>
            )}

            <div className="flex flex-col gap-2">
              <button
                onClick={handleConfirm}
                disabled={confirmLoading || declineLoading}
                className="w-full bg-[#2b7929] text-white rounded-xl py-3 font-bold text-sm disabled:opacity-50 transition-opacity active:opacity-80"
              >
                {confirmLoading ? 'Confirmando…' : '✓ Confirmar Reserva'}
              </button>
              <button
                onClick={() => { setDeclineOpen(o => !o); setActionError(null); }}
                disabled={confirmLoading || declineLoading}
                className="w-full bg-white text-red-700 border-2 border-red-200 rounded-xl py-2.5 font-semibold text-sm disabled:opacity-50 transition-opacity"
              >
                ✕ Recusar com mensagem
              </button>
            </div>

            {declineOpen && (
              <div className="mt-3 bg-red-50 border border-red-200 rounded-xl p-3">
                <p className="text-xs font-semibold text-red-800 mb-2">Motivo da recusa (enviado ao hóspede):</p>
                <textarea
                  value={declineMsg}
                  onChange={e => setDeclineMsg(e.target.value)}
                  rows={3}
                  className="w-full text-xs text-stone-700 border border-red-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-300 resize-none"
                />
                <button
                  onClick={handleDecline}
                  disabled={declineLoading || !declineMsg.trim()}
                  className="w-full mt-2 bg-red-600 text-white rounded-lg py-2 font-semibold text-sm disabled:opacity-50 transition-opacity"
                >
                  {declineLoading ? 'Enviando recusa…' : 'Enviar recusa'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
```

- [ ] **Step 5: TypeScript compile check**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Dev server smoke test**

```bash
npm run dev
```

Open http://localhost:3001/admin/reservas in browser. Create a test REQUESTED booking via the backend. Navigate to the detail page. Verify:
- Amber banner appears with "Aguardando confirmação"
- "✓ Confirmar Reserva" green button visible
- "✕ Recusar com mensagem" white/red button visible
- Tapping Decline button expands the textarea
- Status badge shows "Solicitada" in amber

- [ ] **Step 7: Commit**

```bash
git add components/admin/ReservaDetail.tsx
git commit -m "feat: add REQUESTED alert banner with Confirm/Decline actions in ReservaDetail"
```

---

## Self-Review Checklist

After all tasks are committed, run through these:

- [ ] `REQUESTED` appears in: Prisma schema ✓, availability check (`/intent` + `/availability`) ✓, `/confirm` handler ✓, ReservasList type + constants ✓, ReservaDetail type + constants ✓
- [ ] All email templates include: `guestName`, `checkIn`, `checkOut`, `guestCount`, `hasPet`, `petDescription`, `totalAmount`
- [ ] Staff `/confirmar` does final availability check before capturing (prevents race condition)
- [ ] Staff `/recusar` requires `message` body (400 if missing)
- [ ] GHL functions fire non-blocking (`.catch()` on all calls, never awaited in request path for non-blocking calls)
- [ ] `petDescription` field stored in DB and passed through to all templates
- [ ] Guest page `/reserva-solicitada` accessible without auth
- [ ] Both new env vars documented in `.env.example`
- [ ] All Stripe operations wrapped in try/catch

---

## Environment Variables to Set in Railway

After deploying, add these to Railway Variables for the SRI backend service:

```
GHL_BOOKING_REQUESTED_URL  = <webhook URL from GHL workflow for "booking.requested">
GHL_BOOKING_DECLINED_URL   = <webhook URL from GHL workflow for "booking.declined">
```

The GHL workflows need to be created manually in GHL to handle these events. The webhook payloads include all booking fields needed to create/update contacts and move pipeline stages.
