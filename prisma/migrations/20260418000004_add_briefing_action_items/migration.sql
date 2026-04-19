-- AlterTable
ALTER TABLE "DailyBriefing" ADD COLUMN "actionItems" JSONB;
ALTER TABLE "DailyBriefing" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "DailyBriefing" ADD COLUMN "outputTokens" INTEGER;
ALTER TABLE "DailyBriefing" ADD COLUMN "cachedTokens" INTEGER;
