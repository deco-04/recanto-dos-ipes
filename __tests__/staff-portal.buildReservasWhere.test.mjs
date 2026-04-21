import { describe, it, expect } from 'vitest';
import { buildReservasWhere } from '../routes/staff-portal.js';

// The /api/staff/reservas endpoint's filter builder. Pure function so we can
// pin the invariants without spinning up Express + Prisma.
//
// Two bugs it must guard against:
//   1. Orphan bookings (propertyId=null) leaking into the "Visão Geral
//      (todas)" view — invisible to property-scoped workflows but visually
//      noisy in the admin list.
//   2. All-status response when caller only wants REQUESTED / CONFIRMED etc.
//      Previously the frontend filtered client-side, which meant shipping
//      CANCELLED + PENDING bookings over the wire unnecessarily.

describe('buildReservasWhere', () => {
  it('narrows to a specific propertyId when provided', () => {
    const where = buildReservasWhere({ propertyId: 'cmnv123abc' });
    expect(where.propertyId).toBe('cmnv123abc');
  });

  it('excludes orphan (null-propertyId) bookings when no propertyId is provided', () => {
    const where = buildReservasWhere({});
    expect(where.propertyId).toEqual({ not: null });
  });

  it('excludes orphan bookings when propertyId is explicit "ALL"', () => {
    const where = buildReservasWhere({ propertyId: 'ALL' });
    expect(where.propertyId).toEqual({ not: null });
  });

  it('applies a status filter when status is a recognized enum value', () => {
    const where = buildReservasWhere({ status: 'REQUESTED' });
    expect(where.status).toBe('REQUESTED');
  });

  it('applies a multi-value status filter when status is an array', () => {
    const where = buildReservasWhere({ status: ['REQUESTED', 'CONFIRMED'] });
    expect(where.status).toEqual({ in: ['REQUESTED', 'CONFIRMED'] });
  });

  it('accepts comma-separated status values (common in query strings)', () => {
    const where = buildReservasWhere({ status: 'REQUESTED,CONFIRMED' });
    expect(where.status).toEqual({ in: ['REQUESTED', 'CONFIRMED'] });
  });

  it('ignores unknown status values silently (prevents enum-inject surprises)', () => {
    const where = buildReservasWhere({ status: 'NOT_A_STATUS' });
    expect(where.status).toBeUndefined();
  });

  it('filters out unknown values from a mixed list', () => {
    const where = buildReservasWhere({ status: 'REQUESTED,GARBAGE,CONFIRMED' });
    expect(where.status).toEqual({ in: ['REQUESTED', 'CONFIRMED'] });
  });

  it('combines propertyId + status filters', () => {
    const where = buildReservasWhere({ propertyId: 'cmnv123', status: 'REQUESTED' });
    expect(where.propertyId).toBe('cmnv123');
    expect(where.status).toBe('REQUESTED');
  });

  it('combines "ALL" + status (keeps the orphan guard)', () => {
    const where = buildReservasWhere({ propertyId: 'ALL', status: 'CANCELLED' });
    expect(where.propertyId).toEqual({ not: null });
    expect(where.status).toBe('CANCELLED');
  });

  it('is a pure function — does not mutate its input', () => {
    const input = { propertyId: 'ALL', status: 'REQUESTED,CONFIRMED' };
    const snapshot = JSON.stringify(input);
    buildReservasWhere(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
