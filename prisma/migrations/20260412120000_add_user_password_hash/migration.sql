-- AddColumn: passwordHash (optional) on User
-- Allows guests to set a password after first OTP login for faster subsequent access
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
