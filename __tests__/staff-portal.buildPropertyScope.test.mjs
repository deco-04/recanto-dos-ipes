import { describe, it, expect } from 'vitest';
import { buildPropertyScope } from '../routes/staff-portal.js';

// Pins the property-scope contract used by /api/staff/financeiro (and any
// other endpoint that needs to narrow Prisma queries to a single property).
//
// A real propertyId MUST narrow the where clause; 'ALL' or a missing value
// MUST return an open scope ({}). If this test ever produces an identical
// scope for two distinct propertyIds, the RDI/CDS data-leakage bug is
// regressing — the financeiro endpoint would then surface the same numbers
// no matter which property the admin selected in the PropertyPicker.

describe('buildPropertyScope', () => {
  it('narrows for a real propertyId', () => {
    const scope = buildPropertyScope('cabanas-da-serra-id');
    expect(scope).toEqual({ propertyId: 'cabanas-da-serra-id' });
  });

  it('opens for the "ALL" sentinel', () => {
    expect(buildPropertyScope('ALL')).toEqual({});
  });

  it('opens for null / undefined / empty string', () => {
    expect(buildPropertyScope(null)).toEqual({});
    expect(buildPropertyScope(undefined)).toEqual({});
    expect(buildPropertyScope('')).toEqual({});
  });

  it('two distinct propertyIds produce distinct scopes (data-leakage guard)', () => {
    const a = buildPropertyScope('rdi-id');
    const b = buildPropertyScope('cds-id');
    expect(a).not.toEqual(b);
    expect(a.propertyId).toBe('rdi-id');
    expect(b.propertyId).toBe('cds-id');
  });

  it('result is spreadable into a larger where clause without side effects', () => {
    const scope = buildPropertyScope('rdi-id');
    const where = { ...scope, status: { in: ['CONFIRMED', 'COMPLETED'] } };
    expect(where).toEqual({
      propertyId: 'rdi-id',
      status: { in: ['CONFIRMED', 'COMPLETED'] },
    });
    // Original helper return value must be untouched.
    expect(scope).toEqual({ propertyId: 'rdi-id' });
  });
});
