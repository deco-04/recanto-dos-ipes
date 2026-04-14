# Booking Confirmation Flow — Design Spec
*Aprovado em brainstorming · 2026-04-14*

---

## Scope

This spec covers the full booking request-to-confirmation flow across **all three properties**:

| Website | Brand | Domain |
|---|---|---|
| Sítio Recanto dos Ipês | RDI | sitiorecantodosipes.com |
| Recantos da Serra | RDS | recantosdaserra.com *(future)* |
| Cabanas da Serra | CDS | cabanasdaserra.com *(future)* |

All three share the same backend (`Sítio Recanto dos Ipês/` Express + Prisma), the same staff app (`recantos-central-equipe`), and the same GHL pipeline. Property context is determined by `propertyId` on every record.

---

## Problem Statement

The current flow immediately confirms a booking on payment — no admin review step, no way to decline. This needs to change:

1. Guest submits booking → card pre-authorized (held, not charged)
2. Booking lands in staff app as **REQUESTED** — admin must Confirm or Decline
3. On Confirm → card captured, confirmation messages sent
4. On Decline → pre-auth released, decline messages sent with admin's note
5. All stages captured in GHL for nurture campaigns

OTA bookings (Airbnb, Booking.com) are already confirmed on the platform before reaching us via iCal — they skip admin confirmation and land directly as CONFIRMED.

---

## Approved Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Payment at request time | **Pre-authorization** (Stripe `capture_method: 'manual'`) | Card committed, no charge until confirmed. Dates held. Clean decline path. |
| Admin can decline | Yes — with message sent to guest | Admin writes reason; delivered via email + WhatsApp |
| OTA booking confirmation | Skip admin step — land as CONFIRMED | Already confirmed on platform; iCal sync authoritative |
| Pre-auth expiry | 7 days (Stripe limit) | Acceptable — property reviews within hours |
| GHL lead capture | At every stage (REQUESTED, CONFIRMED, CANCELLED) | Enables full nurture pipeline even for declined/cancelled leads |
| Pet info in templates | Yes — included in all stage messages | `hasPet`, `petDescription` variables in every template |

---

## Booking State Machine

```
[Guest submits form]
        ↓
   PENDING (brief — Stripe PaymentIntent in flight)
        ↓
   REQUESTED ← new state. Admin review required. Card pre-authorized.
     ↙          ↘
CONFIRMED     CANCELLED
(card captured) (pre-auth released)
```

**OTA Path (parallel):**
```
[iCal sync detects new booking]
        ↓
   CONFIRMED (directly — no REQUESTED step)
        ↓
   SP2: StaffTask created → admin fills missing guest data
```

### Enum change
Add `REQUESTED` to `BookingStatus` enum in `prisma/schema.prisma`, between `PENDING` and `CONFIRMED`.

---

## GHL Pipeline — Reservas

All direct booking contacts enter GHL at the moment of form submission (REQUESTED), not at confirmation. This ensures every lead is captured even if declined.

| Stage | Trigger | Tags |
|---|---|---|
| **Solicitação** | Guest submits booking form (REQUESTED) | `solicitacao-direto`, `property:rdi` / `property:rds` / `property:cds` |
| **Confirmada** | Admin taps Confirm | `reserva-confirmada` |
| **OTA Confirmada** | iCal sync creates booking | `ota-confirmada`, `source:airbnb` / `source:booking-com` |
| **Check-in / Hóspede Ativo** | Cron on check-in date | `checkin-ativo` |
| **Recusada / Cancelada** | Admin taps Decline or booking cancelled | `recusa-nurture` |

### GHL Automations per stage
- **Solicitação:** "Recebemos sua solicitação" — email + WhatsApp (REQUESTED stage messages)
- **Confirmada:** Full confirmation — email + WhatsApp
- **Recusada:** Decline notification — email + WhatsApp with admin's message; enters re-engagement sequence

---

## Guest Experience

### Success Page (after form submit)
URL: `/reserva/solicitacao` (replaces current `/reserva/confirmacao` for non-OTA flow)

**Content:**
- Warm, reassuring tone (NOT "confirmed" — "received")
- Hourglass icon + "Solicitação recebida!" heading
- "O que acontece agora?" 3-step explanation:
  1. Team reviews within 24 hours
  2. On confirm → card charged + full details via email + WhatsApp
  3. If not confirmed → pre-auth cancelled automatically, no charge
- Booking summary box: property, check-in, check-out, guests, pets (if applicable), pre-authorized amount
- Contact info (phone + WhatsApp link) for questions

### Guest Messages — Stage 1: REQUESTED

**Email** (subject: "Sua solicitação de reserva foi recebida ☀️")
- Warm greeting with name
- Acknowledges request for the property + dates
- Mentions pre-auth (held, not charged)
- Sets 24h expectation
- Variables: `guestName`, `propertyName`, `checkIn`, `checkOut`, `nights`, `guestCount`, `hasPet`, `petDescription`, `totalAmount`

**WhatsApp**
- Brief version: acknowledgment + dates + 24h expectation
- Same variables

### Guest Messages — Stage 2: CONFIRMED

**Email** (subject: "Reserva confirmada! Nos vemos em [month] 🌿")
- Celebratory tone
- Full booking details: dates, guests, pets, amount charged, check-in time
- Next steps: access instructions, house rules coming soon
- Variables: all REQUESTED variables + `checkInTime`, `paymentMethod` (last 4 digits)

**WhatsApp**
- Confirmation + key details + invitation to message for questions

### Guest Messages — Stage 3: DECLINED

**Email** (subject: "Atualização sobre sua solicitação de reserva")
- Neutral, polite tone (not apologetic to the point of admitting fault)
- States it was not possible to confirm
- Includes admin's decline reason in a highlighted block
- Confirms pre-auth was cancelled (no charge)
- CTA: "Ver disponibilidade" → property booking page
- Variables: all REQUESTED variables + `declineReason`

**WhatsApp**
- Brief decline notification with admin's message
- Pre-auth release confirmation
- Link to check other dates

### Complete Message Variable Set
All templates receive this object:
```javascript
{
  guestName,          // "Maria Fernanda"
  guestFirstName,     // "Maria Fernanda" (or first name only)
  propertyName,       // "Sítio Recanto dos Ipês"
  propertyPhone,      // "+55 31 2391-6688"
  propertyUrl,        // "sitiorecantodosipes.com"
  checkIn,            // "sáb, 14 jun 2025"
  checkOut,           // "ter, 17 jun 2025"
  nights,             // 3
  guestCount,         // 4
  hasPet,             // true / false  (already in Booking model)
  petDescription,     // "1 cachorro pequeno" or null  (new field — Booking.petDescription)
  totalAmount,        // "R$ 1.890"
  source,             // "Direto" | "Airbnb" | "Booking.com"
  declineReason,      // Only for DECLINED messages — admin's typed reason
  checkInTime,        // Only for CONFIRMED — "15:00"
}
```

---

## Staff App UI

### Reservations List (`components/admin/ReservasList.tsx`)

**New filter chip:**
- Add "Solicitadas" chip between existing "Todas" and "Confirmadas"
- Active style: `bg-amber-800 text-white`

**REQUESTED card treatment:**
- Left border: `border-l-4 border-amber-400`
- Status badge: `bg-amber-100 text-amber-800` · "● Solicitada"
- Action hint row at bottom of card: `bg-amber-50` · ⏳ "Aguardando sua confirmação · há [X]h"
- Time is relative ("há 2h", "há 1 dia") from `createdAt`

**CONFIRMED card:** existing green treatment (no change)
**CANCELLED card:** existing gray + reduced opacity (no change)

### Reservation Detail (REQUESTED state)

**Alert banner** (shown only when `status === 'REQUESTED'`):
- `bg-amber-100 border-2 border-amber-400 rounded-xl`
- "⏳ Aguardando confirmação" heading
- Sub-text: "Cartão pré-autorizado · R$ [amount] · solicitada há [X]h · prazo: 7 dias"

**Action buttons** (shown only when `status === 'REQUESTED'`):
- **Confirm:** full-width green `bg-[#2b7929]` · "✓ Confirmar Reserva"
- **Decline:** full-width white with red border · "✕ Recusar com mensagem"
  - Tapping Decline expands a message textarea (pre-filled with default text)
  - "Enviar recusa" red button below

**Guest info section:** add "Novo lead" badge (green) when guest has no prior bookings

**Push notification to admin** when new REQUESTED booking arrives:
```javascript
sendPushToRole('ADMIN', {
  title: 'Nova solicitação de reserva',
  body: `${guestName} · ${checkIn} → ${checkOut}`,
  type: 'BOOKING_REQUESTED',
  data: { bookingId },
})
```

---

## Technical Architecture

### 1. Stripe Change
In `routes/bookings.js` — PaymentIntent creation:
```javascript
// Before
stripe.paymentIntents.create({ amount, currency: 'brl', payment_method, confirm: true })

// After
stripe.paymentIntents.create({
  amount,
  currency: 'brl',
  payment_method,
  confirm: true,
  capture_method: 'manual',   // ← pre-auth only
})
```

### 2. Status Change on Booking Creation
`routes/bookings.js` — after Stripe PI created:
```javascript
// Before: status: 'CONFIRMED'
// After:  status: 'REQUESTED'
```
Also: fire "Solicitação recebida" email + WhatsApp + GHL contact creation at this point.

### 3. New Backend Endpoints

**`POST /api/staff/reservas/:id/confirmar`** (staff auth required)
1. Load booking — verify `status === 'REQUESTED'`
2. `stripe.paymentIntents.capture(booking.stripePaymentIntentId)`
3. `prisma.booking.update({ status: 'CONFIRMED' })`
4. Fire confirmation email + WhatsApp to guest
5. `ghlWebhook.updateContactStage(ghlContactId, 'Confirmada')`
6. Return updated booking

**`POST /api/staff/reservas/:id/recusar`** (staff auth required)
- Body: `{ message: string }`
1. Load booking — verify `status === 'REQUESTED'`
2. `stripe.paymentIntents.cancel(booking.stripePaymentIntentId)`
3. `prisma.booking.update({ status: 'CANCELLED' })`
4. Fire decline email + WhatsApp to guest (include `message` in template)
5. `ghlWebhook.updateContactStage(ghlContactId, 'Recusada/Cancelada')` + tag `recusa-nurture`
6. Return updated booking

### 4. GHL Integration
In `lib/ghl-webhook.js`, add or extend:
- `createBookingContact(booking)` — called at REQUESTED stage; creates/updates GHL contact, adds to *Solicitação* pipeline stage, fires "Recebemos sua solicitação" automation
- `updateContactStage(ghlContactId, stage)` — moves contact to named pipeline stage
- Both functions are property-aware (pass `propertyId` → lookup GHL locationId)

### 5. Schema Migration
```prisma
// BookingStatus enum — add REQUESTED between PENDING and CONFIRMED
enum BookingStatus {
  PENDING
  REQUESTED       // ← new
  CONFIRMED
  CANCELLED
  REFUNDED
}

// Booking model — fields to ADD (stripePaymentIntentId already exists)
// Add to Booking:
ghlContactId     String?   // GHL contact ID for pipeline stage management
adminDeclineNote String?   // admin's typed decline reason (stored for audit)
petDescription   String?   // free-text description (e.g. "1 cachorro pequeno")

// Property model — fields to ADD (for multi-brand template variables)
// Add to Property:
phone      String?   // e.g. "+55 31 2391-6688"
websiteUrl String?   // e.g. "sitiorecantodosipes.com"
```

> Note: `stripePaymentIntentId String? @unique` already exists on `Booking` — no change needed there.

### 6. New Email Templates in `lib/mailer.js`
- `sendBookingRequestReceived(booking)` — REQUESTED stage
- `sendBookingDeclined(booking, declineReason)` — CANCELLED by admin
- Existing `sendBookingConfirmation(booking)` — update to include pet info variables

---

## Multi-Website Implementation Notes

All three property websites will share this exact flow. The key property-specific variables are:
- `propertyName` — from `Property.name`
- `propertyPhone` — from `Property.phone`
- `propertyUrl` — from `Property.websiteUrl`
- GHL `locationId` — from property config (already mapped)

When RDS and CDS guest sites are built, they will use the same `routes/bookings.js` + same state machine. The only differences will be brand tokens in email templates.

For now, implement on RDI (`sitiorecantodosipes.com`) — the pattern will port to RDS/CDS with minimal changes.

---

## Files to Create / Modify

### Backend (`Sítio Recanto dos Ipês/`)
| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `REQUESTED` to `BookingStatus`; add `ghlContactId`, `adminDeclineNote` to `Booking` |
| `routes/bookings.js` | `capture_method: 'manual'`; status `REQUESTED`; fire request-received messages + GHL contact |
| `routes/staff-portal.js` | Add `POST /:id/confirmar` and `POST /:id/recusar` endpoints |
| `lib/mailer.js` | Add `sendBookingRequestReceived()` and `sendBookingDeclined()`; update `sendBookingConfirmation()` with pet vars |
| `lib/ghl-webhook.js` | Add `createBookingContact()` and `updateContactStage()` |
| `public/reserva/solicitacao.html` | New guest success page (REQUESTED state) |

### Staff App (`recantos-central-equipe/`)
| File | Change |
|---|---|
| `components/admin/ReservasList.tsx` | Add "Solicitadas" filter chip; REQUESTED card treatment + action hint |
| `app/admin/reservas/[id]/page.tsx` | Alert banner + Confirm/Decline buttons when `status === 'REQUESTED'` |
| `components/admin/ReservaDetail.tsx` | Confirm/Decline action components with API calls |

---

## Out of Scope (this spec)
- Partial refunds / modifications after confirmation → separate spec
- Guest-facing booking management (cancel, modify) → future
- RDS/CDS website builds → ports this pattern when those sites exist
- Stripe webhook handler for `payment_intent.requires_capture` → nice-to-have, not blocking
