-- AlterTable: add accessInfo JSON field to Property for pre-arrival kit
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "accessInfo" JSONB;
