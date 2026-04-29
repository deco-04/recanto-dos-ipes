-- Add GHL conversation message ID to InboxMessage for dedup. Used by:
--   1. lib/cron.js GHL Conversations poll — idempotent re-runs
--   2. routes/mensagens.js staff-send — stamps the row so the next poll
--      doesn't re-mirror our own outbound message
ALTER TABLE "InboxMessage" ADD COLUMN "ghlMessageId" TEXT;
CREATE UNIQUE INDEX "InboxMessage_ghlMessageId_key" ON "InboxMessage"("ghlMessageId");
