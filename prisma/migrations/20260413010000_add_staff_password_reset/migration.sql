-- AddColumn: passwordResetToken and passwordResetExpiry to StaffMember
ALTER TABLE "StaffMember" ADD COLUMN "passwordResetToken" TEXT;
ALTER TABLE "StaffMember" ADD COLUMN "passwordResetExpiry" TIMESTAMP(3);
