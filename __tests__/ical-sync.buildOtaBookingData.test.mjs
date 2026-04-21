import { describe, it, expect } from 'vitest';
import { buildOtaBookingData } from '../lib/ical-sync.js';

// Pins the property-scoping invariant: every OTA booking created from iCal
// MUST have a propertyId attached. Otherwise the new row is invisible in the
// staff app's property-filtered reservation list and invisible in the
// financeiro dashboard's per-property breakdown.
//
// Same class of bug we fixed for DIRECT bookings in /api/bookings/intent.

const SAMPLE_RDI_PROPERTY_ID = 'cmnvjziwv0000ohgcb3nxbl4j';

function sampleReservation(overrides = {}) {
  return {
    uid:        'abc123@airbnb.com',
    guestName:  'Maria Silva',
    checkIn:    new Date('2026-07-10T12:00:00Z'),
    checkOut:   new Date('2026-07-13T12:00:00Z'),
    nights:     3,
    ...overrides,
  };
}

describe('buildOtaBookingData — pure helper', () => {
  it('includes propertyId on the returned data object', () => {
    const data = buildOtaBookingData({
      source:        'AIRBNB',
      reservation:   sampleReservation(),
      propertyId:    SAMPLE_RDI_PROPERTY_ID,
      invoiceNumber: 'AIR-DEADBEEF42',
    });
    expect(data.propertyId).toBe(SAMPLE_RDI_PROPERTY_ID);
  });

  it('sets status=CONFIRMED for OTA sources (skip REQUESTED since guest already paid the OTA)', () => {
    const air = buildOtaBookingData({ source: 'AIRBNB',      reservation: sampleReservation(), propertyId: SAMPLE_RDI_PROPERTY_ID, invoiceNumber: 'AIR-1' });
    const bkg = buildOtaBookingData({ source: 'BOOKING_COM', reservation: sampleReservation(), propertyId: SAMPLE_RDI_PROPERTY_ID, invoiceNumber: 'BOO-1' });
    expect(air.status).toBe('CONFIRMED');
    expect(bkg.status).toBe('CONFIRMED');
  });

  it('sets source matching the channel', () => {
    const air = buildOtaBookingData({ source: 'AIRBNB',      reservation: sampleReservation(), propertyId: SAMPLE_RDI_PROPERTY_ID, invoiceNumber: 'AIR-1' });
    const bkg = buildOtaBookingData({ source: 'BOOKING_COM', reservation: sampleReservation(), propertyId: SAMPLE_RDI_PROPERTY_ID, invoiceNumber: 'BOO-1' });
    expect(air.source).toBe('AIRBNB');
    expect(bkg.source).toBe('BOOKING_COM');
  });

  it('carries through externalId, guestName, dates, and nights from the reservation', () => {
    const r = sampleReservation();
    const data = buildOtaBookingData({ source: 'AIRBNB', reservation: r, propertyId: SAMPLE_RDI_PROPERTY_ID, invoiceNumber: 'AIR-1' });
    expect(data.externalId).toBe(r.uid);
    expect(data.guestName).toBe(r.guestName);
    expect(data.checkIn).toBe(r.checkIn);
    expect(data.checkOut).toBe(r.checkOut);
    expect(data.nights).toBe(r.nights);
  });

  it('leaves guestEmail and guestPhone empty strings — iCal does not carry contact info', () => {
    const data = buildOtaBookingData({ source: 'AIRBNB', reservation: sampleReservation(), propertyId: SAMPLE_RDI_PROPERTY_ID, invoiceNumber: 'AIR-1' });
    expect(data.guestEmail).toBe('');
    expect(data.guestPhone).toBe('');
  });

  it('initializes guest/price fields to zero for admin to fill in via OTA task', () => {
    const data = buildOtaBookingData({ source: 'AIRBNB', reservation: sampleReservation(), propertyId: SAMPLE_RDI_PROPERTY_ID, invoiceNumber: 'AIR-1' });
    expect(data.guestCount).toBe(0);
    expect(data.extraGuests).toBe(0);
    expect(data.hasPet).toBe(false);
    expect(data.baseRatePerNight).toBe(0);
    expect(data.extraGuestFee).toBe(0);
    expect(data.petFee).toBe(0);
    expect(data.totalAmount).toBe(0);
  });

  it('includes the invoiceNumber passed in', () => {
    const data = buildOtaBookingData({ source: 'BOOKING_COM', reservation: sampleReservation(), propertyId: SAMPLE_RDI_PROPERTY_ID, invoiceNumber: 'BOO-ABC1234567' });
    expect(data.invoiceNumber).toBe('BOO-ABC1234567');
  });

  it('throws when propertyId is missing — fail fast instead of silently creating an orphan', () => {
    expect(() => buildOtaBookingData({ source: 'AIRBNB', reservation: sampleReservation(), propertyId: null,      invoiceNumber: 'AIR-1' })).toThrow(/propertyId/i);
    expect(() => buildOtaBookingData({ source: 'AIRBNB', reservation: sampleReservation(), propertyId: undefined, invoiceNumber: 'AIR-1' })).toThrow(/propertyId/i);
    expect(() => buildOtaBookingData({ source: 'AIRBNB', reservation: sampleReservation(), propertyId: '',        invoiceNumber: 'AIR-1' })).toThrow(/propertyId/i);
  });

  it('throws on unknown source — prevents typos from landing DIRECT-styled data on OTA', () => {
    expect(() => buildOtaBookingData({ source: 'VRBO',   reservation: sampleReservation(), propertyId: SAMPLE_RDI_PROPERTY_ID, invoiceNumber: 'VRB-1' })).toThrow();
    expect(() => buildOtaBookingData({ source: 'DIRECT', reservation: sampleReservation(), propertyId: SAMPLE_RDI_PROPERTY_ID, invoiceNumber: 'DIR-1' })).toThrow();
  });
});
