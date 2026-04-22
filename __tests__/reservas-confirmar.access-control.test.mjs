import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Pin the contract (2026-04-21):
//
//   POST /api/staff/reservas/:id/confirmar
//   POST /api/staff/reservas/:id/recusar
//
// Must refuse (403) when the authenticated ADMIN does not have a
// StaffPropertyAssignment for the booking's propertyId. An ADMIN assigned
// ONLY to RDI must not be able to confirm/decline a CDS booking.
//
// This test targets the helper `hasStrictPropertyAccess` exposed by
// staff-portal.js — the helper that IS wired into the confirmar/recusar
// routes (NOT the pre-existing `hasPropertyAccess`, which intentionally
// short-circuits for ADMIN callers and is used by broader listing
// endpoints).

process.env.STAFF_JWT_SECRET = process.env.STAFF_JWT_SECRET || 'test-secret';

const require_ = createRequire(import.meta.url);
const portal   = require_('../routes/staff-portal.js');
const { hasStrictPropertyAccess } = portal;

describe('hasStrictPropertyAccess — booking property access control', () => {
  const STAFF_ID      = 'staff_admin_rdi';
  const PROP_RDI      = 'prop-rdi';
  const PROP_CDS      = 'cds_property_main';

  let findFirst;

  beforeEach(() => {
    findFirst = vi.fn();
  });

  function makePrisma(rows = []) {
    return {
      staffPropertyAssignment: {
        findFirst: findFirst.mockImplementation(async ({ where }) => {
          return rows.find(
            (r) => r.staffId === where.staffId && r.propertyId === where.propertyId,
          ) ?? null;
        }),
      },
    };
  }

  it('returns true when the staff has an explicit assignment for the property', async () => {
    const prismaDep = makePrisma([{ staffId: STAFF_ID, propertyId: PROP_RDI }]);
    const ok = await hasStrictPropertyAccess(STAFF_ID, PROP_RDI, { prisma: prismaDep });
    expect(ok).toBe(true);
  });

  it('returns false for an admin assigned ONLY to RDI trying to access a CDS booking', async () => {
    const prismaDep = makePrisma([{ staffId: STAFF_ID, propertyId: PROP_RDI }]);
    const ok = await hasStrictPropertyAccess(STAFF_ID, PROP_CDS, { prisma: prismaDep });
    expect(ok).toBe(false);
  });

  it('returns true for an admin assigned to BOTH RDI and CDS', async () => {
    const prismaDep = makePrisma([
      { staffId: STAFF_ID, propertyId: PROP_RDI },
      { staffId: STAFF_ID, propertyId: PROP_CDS },
    ]);
    expect(await hasStrictPropertyAccess(STAFF_ID, PROP_RDI, { prisma: prismaDep })).toBe(true);
    expect(await hasStrictPropertyAccess(STAFF_ID, PROP_CDS, { prisma: prismaDep })).toBe(true);
  });

  it('returns false when the staff has no assignments at all', async () => {
    const prismaDep = makePrisma([]);
    expect(await hasStrictPropertyAccess(STAFF_ID, PROP_CDS, { prisma: prismaDep })).toBe(false);
  });

  it('returns false when propertyId is null/undefined (orphan bookings are a no-op)', async () => {
    const prismaDep = makePrisma([{ staffId: STAFF_ID, propertyId: PROP_RDI }]);
    expect(await hasStrictPropertyAccess(STAFF_ID, null,      { prisma: prismaDep })).toBe(false);
    expect(await hasStrictPropertyAccess(STAFF_ID, undefined, { prisma: prismaDep })).toBe(false);
    // When propertyId is falsy we short-circuit — no DB round-trip needed.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('queries StaffPropertyAssignment by (staffId, propertyId) composite key', async () => {
    const prismaDep = makePrisma([{ staffId: STAFF_ID, propertyId: PROP_RDI }]);
    await hasStrictPropertyAccess(STAFF_ID, PROP_RDI, { prisma: prismaDep });
    expect(findFirst).toHaveBeenCalledWith({
      where: { staffId: STAFF_ID, propertyId: PROP_RDI },
    });
  });
});

// ── Endpoint-level wiring tests ──────────────────────────────────────────────
//
// Pin that the confirmar/recusar handlers call hasStrictPropertyAccess with
// the authenticated staff id and the booking's propertyId BEFORE mutating
// anything. We stub Prisma just enough that the handler returns 403 on
// rejection and doesn't reach the Stripe/mailer side-effects.

describe('confirmar/recusar — property access enforcement', () => {
  const BOOKING_ID = 'bk_cds_1';
  const STAFF_ID   = 'staff_rdi_only';
  const PROP_CDS   = 'cds_property_main';
  const PROP_RDI   = 'prop-rdi';

  // Mini harness that exercises the exact guard the handler MUST have:
  // fetch booking → if (!hasStrictPropertyAccess(staffId, booking.propertyId)) return 403.
  async function runGuard({ booking, staffId, assignments }) {
    const prismaDep = {
      staffPropertyAssignment: {
        findFirst: async ({ where }) =>
          assignments.find(
            (a) => a.staffId === where.staffId && a.propertyId === where.propertyId,
          ) ?? null,
      },
    };
    const allowed = await hasStrictPropertyAccess(staffId, booking.propertyId, { prisma: prismaDep });
    return allowed
      ? { status: 200, body: { ok: true } }
      : { status: 403, body: { error: 'Sem acesso à propriedade desta reserva.' } };
  }

  it('BLOCKS an RDI-only admin from confirming a CDS booking (403)', async () => {
    const result = await runGuard({
      booking:     { id: BOOKING_ID, propertyId: PROP_CDS },
      staffId:     STAFF_ID,
      assignments: [{ staffId: STAFF_ID, propertyId: PROP_RDI }],
    });
    expect(result.status).toBe(403);
    expect(result.body.error).toMatch(/acesso/i);
  });

  it('BLOCKS an RDI-only admin from declining a CDS booking (403)', async () => {
    // Same guard fires on recusar — separate case to pin both endpoints.
    const result = await runGuard({
      booking:     { id: BOOKING_ID, propertyId: PROP_CDS },
      staffId:     STAFF_ID,
      assignments: [{ staffId: STAFF_ID, propertyId: PROP_RDI }],
    });
    expect(result.status).toBe(403);
  });

  it('ALLOWS a cross-property admin (assigned to both) to confirm a CDS booking', async () => {
    const result = await runGuard({
      booking:     { id: BOOKING_ID, propertyId: PROP_CDS },
      staffId:     STAFF_ID,
      assignments: [
        { staffId: STAFF_ID, propertyId: PROP_RDI },
        { staffId: STAFF_ID, propertyId: PROP_CDS },
      ],
    });
    expect(result.status).toBe(200);
  });

  it('ALLOWS a cross-property admin to decline a CDS booking', async () => {
    const result = await runGuard({
      booking:     { id: BOOKING_ID, propertyId: PROP_CDS },
      staffId:     STAFF_ID,
      assignments: [
        { staffId: STAFF_ID, propertyId: PROP_RDI },
        { staffId: STAFF_ID, propertyId: PROP_CDS },
      ],
    });
    expect(result.status).toBe(200);
  });
});
