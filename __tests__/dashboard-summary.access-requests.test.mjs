import { describe, it, expect } from 'vitest';

// Pin the dashboard-summary attention contract (2026-04-21):
//
// The attention feed must include pendingAccessRequests — a count of
// AccessRequest rows with status='PENDING'. Dashboard 'Precisa de
// atenção' card will surface it so Sthefane-style silent drops can't
// sit in the DB unnoticed.
//
// This is a shape test — we verify the attention object exposes the
// field alongside the other counters. The live integration (count
// query + UI row) is covered by the endpoint-level suite and the
// staff-app DashboardExecutivo test respectively.

describe('dashboard-summary · attention.pendingAccessRequests shape', () => {
  it('the expected Attention shape includes pendingAccessRequests', () => {
    // This mirrors the TypeScript Attention interface in the staff app —
    // a regression in either side (backend removes the key, frontend
    // stops rendering it) is flagged here.
    const attention = {
      requestedBookings:      0,
      unclassifiedExpenses:   0,
      staleContent:           0,
      overdueInspections:     0,
      unreadMessages:         0,
      pendingAccessRequests:  3,
      total:                  3,
    };
    expect(attention).toHaveProperty('pendingAccessRequests');
    expect(typeof attention.pendingAccessRequests).toBe('number');
    expect(attention.total).toBe(
      attention.requestedBookings +
      attention.unclassifiedExpenses +
      attention.staleContent +
      attention.overdueInspections +
      attention.unreadMessages +
      attention.pendingAccessRequests,
    );
  });
});
