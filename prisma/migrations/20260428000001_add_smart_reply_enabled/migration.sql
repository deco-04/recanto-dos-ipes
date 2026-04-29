-- AlterTable: opt-in flag for the AI FAQ bot (lib/smart-reply.js).
-- Default false so existing properties are not auto-enrolled. Flip per
-- property via Prisma update once their accessInfo is fully populated.
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "smartReplyEnabled" BOOLEAN NOT NULL DEFAULT false;
