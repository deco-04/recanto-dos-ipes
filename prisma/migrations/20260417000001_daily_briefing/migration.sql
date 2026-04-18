-- Phase 4.1: DailyBriefing — DB-cached AI briefing (one per property per day)

CREATE TABLE IF NOT EXISTS "DailyBriefing" (
  "id"         TEXT         NOT NULL PRIMARY KEY,
  "propertyId" TEXT         NOT NULL,
  "date"       TEXT         NOT NULL,
  "text"       TEXT         NOT NULL,
  "model"      TEXT         NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "DailyBriefing_propertyId_date_key" ON "DailyBriefing"("propertyId", "date");
CREATE INDEX        IF NOT EXISTS "DailyBriefing_date_idx"            ON "DailyBriefing"("date");

-- Foreign key to Property
DO $$ BEGIN
  ALTER TABLE "DailyBriefing"
    ADD CONSTRAINT "DailyBriefing_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
