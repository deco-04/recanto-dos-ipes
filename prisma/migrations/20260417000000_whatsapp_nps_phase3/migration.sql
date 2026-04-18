-- Phase 3: WhatsApp direct API + NPS survey flow
-- Adds: MessageTemplate, MessageLog, WaMessageStatus enum
-- Extends: Survey (npsScore, npsClassification, npsFollowUpSent, waSentAt)
-- Adds: Booking → MessageLog relation

-- ── WaMessageStatus enum ───────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "WaMessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── MessageTemplate ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "MessageTemplate" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "name"         TEXT NOT NULL,
  "description"  TEXT NOT NULL,
  "triggerEvent" TEXT NOT NULL,
  "variables"    JSONB NOT NULL DEFAULT '[]',
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "MessageTemplate_name_key"         ON "MessageTemplate"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "MessageTemplate_triggerEvent_key" ON "MessageTemplate"("triggerEvent");

-- ── MessageLog ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "MessageLog" (
  "id"            TEXT NOT NULL PRIMARY KEY,
  "bookingId"     TEXT,
  "guestPhone"    TEXT NOT NULL,
  "templateName"  TEXT,
  "direction"     "MsgDirection" NOT NULL,
  "body"          TEXT,
  "status"        "WaMessageStatus" NOT NULL DEFAULT 'QUEUED',
  "metaMessageId" TEXT,
  "errorMessage"  TEXT,
  "sentAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MessageLog_bookingId_idx"     ON "MessageLog"("bookingId");
CREATE INDEX IF NOT EXISTS "MessageLog_guestPhone_idx"    ON "MessageLog"("guestPhone");
CREATE INDEX IF NOT EXISTS "MessageLog_metaMessageId_idx" ON "MessageLog"("metaMessageId");
CREATE INDEX IF NOT EXISTS "MessageLog_sentAt_idx"        ON "MessageLog"("sentAt");

-- Foreign key to Booking (nullable)
DO $$ BEGIN
  ALTER TABLE "MessageLog"
    ADD CONSTRAINT "MessageLog_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Survey extensions ──────────────────────────────────────────────────────────
ALTER TABLE "Survey"
  ADD COLUMN IF NOT EXISTS "waSentAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "npsScore"          INTEGER,
  ADD COLUMN IF NOT EXISTS "npsClassification" TEXT,
  ADD COLUMN IF NOT EXISTS "npsFollowUpSent"   BOOLEAN NOT NULL DEFAULT false;
