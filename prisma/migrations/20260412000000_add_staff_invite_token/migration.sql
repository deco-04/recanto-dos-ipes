-- AlterTable
ALTER TABLE "StaffMember" ADD COLUMN "inviteToken" TEXT,
ADD COLUMN "inviteTokenExpiry" TIMESTAMP(3);
