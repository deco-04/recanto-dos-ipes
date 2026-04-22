-- AddForeignKey: turn ContentPost.parentPostId from a bare string into a
-- self-referential FK so Prisma can resolve `include: { parentPost: true }`
-- in a single round-trip (replaces the buildParentTitleMap N+1 mitigation
-- in routes/content.js). ON DELETE SET NULL means orphaned alternatives
-- survive a parent delete instead of cascade-disappearing.
--
-- @@index([parentPostId]) already exists from the original migration, so no
-- new index needed.
ALTER TABLE "ContentPost"
  ADD CONSTRAINT "ContentPost_parentPostId_fkey"
  FOREIGN KEY ("parentPostId") REFERENCES "ContentPost"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
