-- Migration: conversation_status
-- Adds OPEN/RESOLVED status to Conversation for inbox triage

DO $$ BEGIN
  CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'RESOLVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN';

CREATE INDEX IF NOT EXISTS "Conversation_propertyId_status_idx"
  ON "Conversation"("propertyId", "status");
