# SEO, UX & User Stories — Sítio Recanto dos Ipês
**Date:** 2026-04-19  
**Stack:** Node.js + Express · Prisma ORM · HTML/CSS + Tailwind · Railway  
**Domain:** sitiorecantodosipes.com

---

## Overview

Full audit of the guest-facing website for SEO gaps, user experience friction, and missing features. This document is the source of truth for sprint planning.

---

## A. SEO Audit Summary

| Page | Meta Title | Meta Desc | Schema | H1 | Grade |
|------|-----------|-----------|--------|-----|-------|
| Homepage | A | A+ | A+ | B+ | **A** |
| Galeria | A | A | A+ | A | **A** |
| FAQ | A | A | A+ | B+ | **A** |
| Blog | C | C | F | C+ | **C+** |
| Booking | Good | Good | noindex ✓ | C | B |
| Policy pages | B | B | noindex → fixed | B | **B** |

### Key SEO Issues Fixed (2026-04-19)
- [x] Policy pages changed from `noindex` → `index, follow, nosnippet` (LGPD compliance)
- [x] `/blog` and `/blog-post` added to sitemap.xml
- [x] `/booking` added to sitemap.xml (priority 0.9)
- [x] robots.txt sitemap URL fixed (was Railway internal URL)
- [x] Homepage keywords updated, hero subheadline keyword-enriched
- [x] Blog: links fixed to use clean `/blog` URL (not `/blog.html`)

### Remaining SEO Gaps
- [ ] Blog: meta title too generic ("Blog — Sítio Recanto dos Ipês")
  - Should be: "Blog — Dicas de Viagem, Serra do Cipó e Jaboticatubas, MG"
- [ ] Blog: no Schema.org `Blog` or `BlogPosting` markup
- [ ] FAQ: missing 5-10 additional questions (WiFi, distance from SP, minimum stay, etc.)
- [ ] Homepage: reviews section exists in schema but not rendered in HTML
- [ ] Homepage: no pricing callout above the fold
- [ ] Homepage: H2/H3 hierarchy for sections (Diferenciais, Espaços, etc.)

---

## B. User Journey Map — 5 Primary User Types

### User Type 1: First-Time Visitor (Google Discovery)
**Entry keywords:** "sítio com piscina jaboticatubas", "aluguel grupo serra do cipó"

**Friction points:**
1. Hero is emotional, not functional — capacity/price not visible above fold
2. No pricing on homepage; must go to /booking to see rates
3. Blog empty — no informational content for early-funnel users
4. No WhatsApp button visible (now fixed — float button added)
5. No trust signals prominently above fold (4.95★ small badge only)

### User Type 2: Returning Visitor (Checking Availability)
**Friction points:**
1. No quick availability check on homepage (must navigate to /booking)
2. "Minhas Reservas" login state unclear for logged-in users
3. No "Book again with same dates" shortcut on dashboard

### User Type 3: Guest with Existing Booking (Pre-Stay Management)
**Friction points:**
1. No self-serve modification UI (guest count, special requests)
2. Pre-arrival info (WiFi, code, manual) only in email — not in dashboard
3. Payment status unclear in dashboard

### User Type 4: Guest Arriving (Check-In Day)
**Friction points:**
1. No "Arrival Kit" in dashboard (check-in code, WiFi, house map)
2. No in-app house manual
3. No quick emergency contact button

### User Type 5: Post-Stay Guest (Review & Rebooking)
**Friction points:**
1. No in-app review submission (redirects to Airbnb only)
2. No quick rebooking CTA on dashboard
3. No referral incentive program

---

## C. User Stories — 25 Identified Gaps

### SEO & Content (5 stories)

**US-001** — As a potential guest searching Google for "sítio com piscina Serra do Cipó",  
I want to see star rating, price range, and images in the search result snippet,  
so that I can pre-qualify the property before clicking through.  
**Acceptance criteria:** Rich snippet shows 4.95★, amenity list, price range. Schema validated in Google's Rich Results Test.  
**Priority:** High | **Effort:** 2h

**US-002** — As a content marketer managing the property,  
I want to publish SEO-optimized blog articles about the destination (Serra do Cipó, Jaboticatubas, group travel MG),  
so that the site ranks for informational keywords and captures early-funnel users.  
**Acceptance criteria:** 3+ published articles with proper H1/H2, meta title/desc, internal links, BlogPosting schema.  
**Priority:** High | **Effort:** 8h/article

**US-003** — As a search AI (Perplexity/ChatGPT),  
I want to find well-structured, authoritative content about this property,  
so that I can cite it when users ask for vacation rental recommendations in Minas Gerais.  
**Acceptance criteria:** All pages have complete H1/H2 hierarchy. FAQ schema covers 20+ questions. Blog has destination articles.  
**Priority:** High | **Effort:** 4h

**US-004** — As a first-time visitor,  
I want to see a photo gallery with zoom and captions,  
so that I can assess room quality and amenities before booking.  
**Acceptance criteria:** Gallery loads within 2s, lightbox works on mobile, all images have descriptive alt text.  
**Priority:** Medium | **Effort:** 3h (alt text + performance)

**US-005** — As a property owner,  
I want to know which search queries are driving traffic,  
so that I can optimize homepage copy for high-intent keywords.  
**Acceptance criteria:** Google Search Console connected; top 10 queries documented monthly.  
**Priority:** Medium | **Effort:** 1h setup

---

### Booking Flow & Conversion (6 stories)

**US-006** — As a potential guest browsing casually,  
I want to see a starting price ("a partir de R$ XXX/noite") on the homepage,  
so that I can make a quick budget decision before navigating to the booking page.  
**Acceptance criteria:** Price callout visible in hero or highlights bar, updates seasonally.  
**Priority:** High | **Effort:** 2h

**US-007** — As a guest finalizing a booking,  
I want to see a real-time cost breakdown (nightly rate × nights + cleaning fee + extra guests),  
so that I'm confident there are no surprise charges.  
**Acceptance criteria:** "Resumo da reserva" sidebar shows itemized fees. Updates live as dates/guest count changes.  
**Priority:** High | **Effort:** 2h (existing UI, needs enhancement)

**US-008** — As a hesitant booker on the /booking page,  
I want quick access to WhatsApp without leaving the form,  
so that I can ask the host a question without losing my progress.  
**Acceptance criteria:** WhatsApp float button visible on /booking page (now added). Pre-filled message: "Tenho uma dúvida sobre reserva..."  
**Priority:** Done ✓ | **Effort:** Done

**US-009** — As a guest with pets,  
I want to specify my pet's breed and size during booking,  
so that the host knows what to expect and there are no disputes at check-in.  
**Acceptance criteria:** Pet description field on /booking. Pet fee shown in order summary.  
**Priority:** Medium | **Effort:** 1h

**US-010** — As a Brazilian guest,  
I want to pay via Pix (not just credit card),  
so that I can use my preferred payment method without extra fees.  
**Acceptance criteria:** Pix payment option on /booking page. QR code shown after booking. Payment confirmed via webhook.  
**Priority:** High | **Effort:** 6-8h (Stripe Pix integration)

**US-011** — As a returning guest,  
I want to see a "Book again" button on my dashboard with last-used dates pre-filled,  
so that I can rebook in one click.  
**Acceptance criteria:** Dashboard shows past bookings with "Reserve again" CTA. Pre-fills dates in /booking.  
**Priority:** Medium | **Effort:** 3h

---

### Guest Experience (6 stories)

**US-012** — As a guest 7 days before check-in,  
I want to see a "Pre-Arrival Kit" section in my dashboard with WiFi, check-in code, house rules, and emergency contact,  
so that I'm not scrambling on arrival day.  
**Acceptance criteria:** Dashboard shows "Chegando em X dias" section starting T-7. Contains: WiFi SSID/password, key safe code, parking map, emergency number.  
**Priority:** High | **Effort:** 6h

**US-013** — As a guest on check-in day,  
I want to see the key code prominently displayed and a map to the key safe,  
so that I don't waste time at arrival.  
**Acceptance criteria:** Key safe code displayed large and copyable. Property map with key safe location pinned.  
**Priority:** High | **Effort:** 2h (part of US-012)

**US-014** — As a guest during my stay,  
I want to access the house manual (appliances, WiFi, emergency contacts) from my phone,  
so that I don't need to call the host for routine questions.  
**Acceptance criteria:** In-app house manual in /dashboard. Sections: WiFi, appliances, pool, sauna, emergency. Mobile-friendly.  
**Priority:** Medium | **Effort:** 4h

**US-015** — As a guest after checkout,  
I want to submit a rating and brief comment directly in-app,  
so that I can share feedback quickly without creating an Airbnb account.  
**Acceptance criteria:** Post-checkout modal: 5-star selector + comment (max 300 chars) + optional photo. Reviews stored in DB. Best ones shown on homepage.  
**Priority:** High | **Effort:** 8h

**US-016** — As a property owner,  
I want to collect guest photos from their stay (with consent),  
so that I can feature authentic experiences on the homepage.  
**Acceptance criteria:** Post-checkout prompt: "Share a photo of your stay." Consent checkbox. Photo stored. Admin approval before display.  
**Priority:** Low | **Effort:** 8h

**US-017** — As a loyal guest,  
I want to receive a referral link I can share with friends,  
so that when they complete a booking, I get 10% off my next stay.  
**Acceptance criteria:** Dashboard "Indique um amigo" section. Unique referral code. Tracking in DB. Discount applied at checkout.  
**Priority:** Low | **Effort:** 10h

---

### Operational & Admin (4 stories)

**US-018** — As a property manager,  
I want to receive push notifications when a booking is confirmed or a guest submits a review,  
so that I can respond promptly.  
**Acceptance criteria:** Push notification to staff app when: booking CONFIRMED, review submitted, guest arrives on check-in day.  
**Priority:** Medium | **Effort:** 4h (webhook + push to existing system)

**US-019** — As a property owner,  
I want to see occupancy rate, revenue YTD, and booking trends on my owner dashboard,  
so that I can make data-driven pricing decisions.  
**Acceptance criteria:** Owner view: occupancy % per month, revenue chart, avg nightly rate, top source (Airbnb/Booking/Direct).  
**Priority:** Medium | **Effort:** 8h

**US-020** — As a property owner,  
I want real-time iCal sync from Airbnb and Booking.com,  
so that blocked dates are automatically reflected on my website.  
**Acceptance criteria:** iCal sync runs every 4h. Blocked dates visible in /booking calendar. No double-bookings in last 90 days.  
**Priority:** High | **Effort:** Done (infrastructure exists, verify uptime)

**US-021** — As a property owner,  
I want to set seasonal pricing for specific date ranges (e.g., "Dec 20-31: R$1,200/night"),  
so that I capture peak-season demand.  
**Acceptance criteria:** Admin UI to set date ranges + price. /booking calendar shows dynamic pricing.  
**Priority:** High | **Effort:** 4h (pricing config already in DB, needs admin UI)

---

### Mobile & Accessibility (2 stories)

**US-022** — As a mobile user,  
I want to complete a booking from start to finish on my phone without excessive scrolling,  
so that the booking process is fast and frustration-free.  
**Acceptance criteria:** Booking form is ≤3 scroll-lengths on iPhone 14 Pro. Step indicator visible. CTA always accessible.  
**Priority:** Medium | **Effort:** 6h (form redesign)

**US-023** — As a user with visual impairment,  
I want to navigate the gallery and booking form with keyboard only,  
so that I can use the site without a mouse or screen reader.  
**Acceptance criteria:** All interactive elements keyboard-accessible. Gallery lightbox: ESC closes, arrow keys navigate. WCAG 2.1 AA compliance.  
**Priority:** Low | **Effort:** 4h

---

### Competitive Differentiation (2 stories)

**US-024** — As a potential guest comparing properties on Google,  
I want to see lifestyle photos and video tour on the homepage,  
so that I can visualize myself staying there.  
**Acceptance criteria:** 2-3 min video embed on homepage (or gallery). Lifestyle photos (group meals, pool fun, sauna, game room) in carousel.  
**Priority:** Medium | **Effort:** 4h (embed) + production cost (video)

**US-025** — As a first-time visitor,  
I want to see real reviews (names, rating, excerpt) displayed on the homepage,  
so that I immediately trust this property without clicking to Airbnb.  
**Acceptance criteria:** 3-4 reviews rendered in HTML on homepage. Shows guest name, month/year, rating, 2-3 sentence excerpt.  
**Priority:** High | **Effort:** 2h

---

## D. Priority Matrix

### Sprint A — Quick Wins (< 1 week)
| Story | Feature | Impact | Status |
|-------|---------|--------|--------|
| US-008 | WhatsApp float button | +10-15% contact rate | **Done ✓** |
| US-025 | Render reviews on homepage | +5-10% conversion | To do |
| US-006 | Pricing callout on homepage | +10-15% engagement | To do |
| US-002 | 3 pillar blog articles | +20-30% organic traffic | To do |

### Sprint B — Critical UX (1-2 weeks)
| Story | Feature | Impact | Status |
|-------|---------|--------|--------|
| US-012/013 | Pre-arrival portal in dashboard | +0.5★ rating | To do |
| US-015 | Post-checkout review modal | +2-3× reviews | To do |
| US-010 | Pix payment option | +20% conversion (Brazil) | To do |
| US-021 | Seasonal pricing admin UI | +15-20% peak revenue | To do |

### Sprint C — Retention (2-4 weeks)
| Story | Feature | Impact | Status |
|-------|---------|--------|--------|
| US-011 | Repeat booking CTA | +20-30% repeat rate | To do |
| US-017 | Referral program | +15-20% word-of-mouth | To do |
| US-019 | Owner analytics dashboard | Data-driven decisions | To do |
| US-022 | Mobile booking form (step-by-step) | Better mobile UX | To do |

---

## E. TDD Requirements

All new features should follow test-driven development:

### Test Categories
1. **Unit tests** (Vitest) — Pure functions: pricing calculation, date validation, booking rules
2. **Integration tests** — API endpoints: POST /api/bookings, GET /api/blog/posts, PATCH /api/bookings/:id
3. **E2E tests** (Playwright) — Critical user flows: full booking, login, review submission

### Test Coverage Targets
- Unit: 80%+ for lib/ and pricing utilities
- Integration: All API endpoints have at least happy-path + error-path tests
- E2E: Booking flow, login flow, blog listing

### Existing Test Foundation
- Vitest configured in `vitest.config.ts`
- iCal sync backoff tested in sprint-i
- Future: add booking flow tests before Pix integration

---

## F. AI Search Optimization Strategy

### Target Queries (Perplexity/ChatGPT)
1. "best sítio with heated pool in Minas Gerais" → homepage + blog
2. "group vacation rental 20 people Serra do Cipó" → homepage capacity emphasis
3. "what to do in Jaboticatubas" → blog destination articles
4. "sauna elétrica sítio jaboticatubas" → FAQ + homepage (now updated)
5. "is sitio recanto dos ipes good?" → reviews schema + rendered reviews

### Optimization Actions
- [ ] Publish destination blog content (US-002)
- [ ] Add rendered reviews to homepage HTML (US-025) — not just schema
- [ ] Ensure all FAQ answers are direct and factual (not sales-y)
- [ ] Add original data: "150+ group stays per year", "avg 12 guests", "available all year"
- [ ] Structured data: add `numberOfRooms`, `petsAllowed`, `amenityFeature` (all 12 amenities)

---

*Last updated: 2026-04-19 | Author: Claude Sonnet + Andre*
