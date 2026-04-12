-- AddColumn: pushSubscription to User table
-- Stores the Web Push API subscription object (JSON) for guest push notifications.
-- Nullable — users without an active browser push subscription will have NULL here.

ALTER TABLE "User" ADD COLUMN "pushSubscription" JSONB;
