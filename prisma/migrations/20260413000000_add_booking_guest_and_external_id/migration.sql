-- AddColumn: externalId on Booking (for iCal OTA deduplication)
ALTER TABLE "Booking" ADD COLUMN "externalId" TEXT;
CREATE UNIQUE INDEX "Booking_externalId_key" ON "Booking"("externalId");

-- CreateEnum: GuestInviteStatus
CREATE TYPE "GuestInviteStatus" AS ENUM ('PENDENTE', 'CONFIRMADO', 'CANCELADO');

-- CreateTable: BookingGuest
CREATE TABLE "BookingGuest" (
    "id"           TEXT NOT NULL,
    "bookingId"    TEXT NOT NULL,
    "addedById"    TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "email"        TEXT NOT NULL,
    "phone"        TEXT,
    "inviteToken"  TEXT,
    "inviteExpiry" TIMESTAMP(3),
    "status"       "GuestInviteStatus" NOT NULL DEFAULT 'PENDENTE',
    "userId"       TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingGuest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingGuest_bookingId_idx" ON "BookingGuest"("bookingId");
CREATE INDEX "BookingGuest_inviteToken_idx" ON "BookingGuest"("inviteToken");

-- AddForeignKey
ALTER TABLE "BookingGuest" ADD CONSTRAINT "BookingGuest_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookingGuest" ADD CONSTRAINT "BookingGuest_addedById_fkey"
    FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookingGuest" ADD CONSTRAINT "BookingGuest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
