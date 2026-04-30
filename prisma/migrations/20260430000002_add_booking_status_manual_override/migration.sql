-- Adds statusManuallyOverriddenAt to Booking. The hourly iCal sync uses this
-- to respect admin manual status changes — a temporarily-empty OTA feed can
-- no longer re-cancel a booking the admin just confirmed.
--
-- Real-world bug this fixes (2026-04-30 reported by user):
--   "Roberta Magalhães 04/06-07/06 está voltando para 'cancelada' automaticamente
--    mesmo eu alterando para o status de confirmada por diversas vezes"
--
-- Mechanism:
--   1. routes/staff-portal.js PATCH /reservas/:id stamps this column when
--      a status field is included in the update.
--   2. lib/ical-sync.js cancellation filter excludes bookings whose
--      statusManuallyOverriddenAt < 30 days ago.

ALTER TABLE "Booking" ADD COLUMN "statusManuallyOverriddenAt" TIMESTAMP(3);
