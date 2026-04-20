-- Add AJUSTE_NECESSARIO and REJEITADO values to ContentStage enum
ALTER TYPE "ContentStage" ADD VALUE IF NOT EXISTS 'AJUSTE_NECESSARIO';
ALTER TYPE "ContentStage" ADD VALUE IF NOT EXISTS 'REJEITADO';

-- Add feedbackNotes and parentPostId to ContentPost for rejection/adjustment workflow
ALTER TABLE "ContentPost" ADD COLUMN IF NOT EXISTS "feedbackNotes" TEXT;
ALTER TABLE "ContentPost" ADD COLUMN IF NOT EXISTS "parentPostId" TEXT;

-- Index for parentPostId lookups (finding alternatives generated from a given original)
CREATE INDEX IF NOT EXISTS "ContentPost_parentPostId_idx" ON "ContentPost"("parentPostId");
