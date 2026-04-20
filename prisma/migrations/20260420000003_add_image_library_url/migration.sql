-- Google Drive folder URL for per-brand photo library.
-- Optional; agent falls back to empty mediaUrls when not set or when no
-- image matches. aiImageFallback is opt-in (defaults false).

ALTER TABLE "BrandContentConfig"
  ADD COLUMN "imageLibraryUrl" TEXT;

ALTER TABLE "BrandContentConfig"
  ADD COLUMN "aiImageFallback" BOOLEAN NOT NULL DEFAULT false;
