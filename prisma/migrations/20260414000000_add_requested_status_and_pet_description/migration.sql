-- Migration: add REQUESTED to BookingStatus enum, petDescription + adminDeclineNote to Booking,
--            phone + websiteUrl to Property

-- Step 1: Add REQUESTED value to BookingStatus enum
-- PostgreSQL requires renaming the old type, creating the new one, then casting columns
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'REQUESTED' BEFORE 'CONFIRMED';

-- Step 2: Add petDescription and adminDeclineNote columns to Booking
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "petDescription" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "adminDeclineNote" TEXT;

-- Step 3: Add phone and websiteUrl columns to Property
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "websiteUrl" TEXT;
