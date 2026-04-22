-- AlterTable: add isRootAdmin safety-hatch column to StaffMember.
-- Purpose: 88befd6 introduced hasStrictPropertyAccess which 403s any admin
-- without a StaffPropertyAssignment row for the booking's property. Root
-- admins (backstage operators like Andre) need to act across all
-- properties regardless of assignment state — this flag is the bypass.
ALTER TABLE "StaffMember" ADD COLUMN "isRootAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Promote the account used by Andre so confirmar/recusar keeps working
-- regardless of whether the assignment seeder has run on this environment.
UPDATE "StaffMember" SET "isRootAdmin" = true WHERE "email" = 'recantodoipes@gmail.com';
