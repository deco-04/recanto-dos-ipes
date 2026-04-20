'use strict';

// Vitest setup — forces NODE_ENV=test so libs that branch on it (Prisma, log
// levels, rate-limit bypass) behave correctly. Individual tests mock their own
// external deps (Prisma, Anthropic, WhatsApp, GHL, Stripe) — no shared DB state.
process.env.NODE_ENV = 'test';
process.env.TZ = 'UTC';
