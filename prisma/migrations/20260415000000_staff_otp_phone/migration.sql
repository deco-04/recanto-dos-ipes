-- Migration: support phone-based OTP for staff WhatsApp login
-- Makes email optional in VerificationCode, adds phone column, adds STAFF_LOGIN purpose

-- Step 1: Make email nullable (existing rows keep their email values)
ALTER TABLE "VerificationCode" ALTER COLUMN "email" DROP NOT NULL;

-- Step 2: Add phone column (nullable — used for staff WhatsApp OTP)
ALTER TABLE "VerificationCode" ADD COLUMN IF NOT EXISTS "phone" TEXT;

-- Step 3: Add STAFF_LOGIN value to CodePurpose enum
ALTER TYPE "CodePurpose" ADD VALUE IF NOT EXISTS 'STAFF_LOGIN';

-- Step 4: Add index on phone for fast lookup
CREATE INDEX IF NOT EXISTS "VerificationCode_phone_idx" ON "VerificationCode"("phone");
