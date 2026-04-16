-- Add COMPLETED to BookingStatus enum
-- This allows past bookings (checkout < today) to be explicitly marked as completed
-- rather than remaining as CONFIRMED indefinitely.

ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';
