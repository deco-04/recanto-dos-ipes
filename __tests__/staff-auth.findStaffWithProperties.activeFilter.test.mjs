import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Contract pin (2026-04-21):
//   findStaffWithProperties MUST filter StaffPropertyAssignment rows by
//   property.active = true on the nested Prisma include. Without this
//   filter the /escolher-propriedade picker renders duplicate rows (e.g.
//   2× RDI, 2× CDS) because legacy slugs soft-deleted during the
//   consolidation share display names with their canonical replacements.
//
// We use the DI-friendly factory (makeFindStaffWithProperties) to inject
// a stub prisma client — same pattern used by lib/content-history.js. No
// live DB required.

// staff-auth.js guards on STAFF_JWT_SECRET at module load.
process.env.STAFF_JWT_SECRET = process.env.STAFF_JWT_SECRET || 'test-secret';

const require_ = createRequire(import.meta.url);
const { makeFindStaffWithProperties } = require_('../routes/staff-auth.js');

function makeFakePrisma() {
  return {
    staffMember: {
      findUnique: vi.fn(async () => ({ id: 's1', active: true, properties: [] })),
    },
  };
}

describe('findStaffWithProperties · active-only filter', () => {
  let prisma, findStaffWithProperties;

  beforeEach(() => {
    prisma = makeFakePrisma();
    findStaffWithProperties = makeFindStaffWithProperties(prisma);
  });

  it('passes a where:{property:{active:true}} filter on the nested properties include', async () => {
    await findStaffWithProperties({ email: 'anyone@example.com' });

    expect(prisma.staffMember.findUnique).toHaveBeenCalledTimes(1);
    const arg = prisma.staffMember.findUnique.mock.calls[0][0];

    // Outer where is passed through as-is.
    expect(arg.where).toEqual({ email: 'anyone@example.com' });

    // Nested include must carry the active-only filter. This is the
    // exact contract the bug fix pins.
    expect(arg.include.properties.where).toEqual({ property: { active: true } });

    // The property select must still include the fields the picker needs.
    expect(arg.include.properties.include.property.select).toMatchObject({
      id:   true,
      name: true,
      slug: true,
    });
  });

  it('forwards lookups by id as well as by email (no where-key rewrite)', async () => {
    await findStaffWithProperties({ id: 'staff-123' });
    const arg = prisma.staffMember.findUnique.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'staff-123' });
    // Filter is unconditional — same for any where shape.
    expect(arg.include.properties.where).toEqual({ property: { active: true } });
  });
});
