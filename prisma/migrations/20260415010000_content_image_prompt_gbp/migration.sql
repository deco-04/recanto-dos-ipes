-- Add imagePrompt field to ContentPost
ALTER TABLE "ContentPost" ADD COLUMN IF NOT EXISTS "imagePrompt" TEXT;

-- Add GBP_POST to ContentType enum
ALTER TYPE "ContentType" ADD VALUE IF NOT EXISTS 'GBP_POST';
