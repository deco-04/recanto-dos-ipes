-- Adds ground-truth financial fields populated from the Airbnb completed-
-- bookings CSV (scripts/import-airbnb-financial-csv.js).
--
-- Why: pre-2026-04-30 the OTA bookings table only carried heuristic numbers
-- derived from Property.pricingConfig (cleaning fee R$240ish hardcoded, host
-- commission estimated). The Airbnb host CSV is the actual source of truth
-- per booking — fees vary by date (R$200/250/270 historically), and host
-- service fee is real (not estimated). User reported 2026-04-30 the
-- financial reports were inaccurate; this migration is the schema half of
-- the fix.
--
-- All new columns are nullable so existing rows + future Booking.com
-- imports (which currently lack a CSV source) keep working unchanged.

ALTER TABLE "Booking"
  ADD COLUMN "actualCleaningFee"  DECIMAL(10, 2),
  ADD COLUMN "airbnbHostFee"      DECIMAL(10, 2),
  ADD COLUMN "airbnbGuestFee"     DECIMAL(10, 2),
  ADD COLUMN "actualPayout"       DECIMAL(10, 2),
  ADD COLUMN "airbnbReportedAt"   TIMESTAMP(3);
