-- Contact model: first-class address book, auto-upserted from bookings.
-- phoneE164 is the natural key (E.164 format, defaults to +55 when Brazilian 10/11 digits).

CREATE TYPE "ContactSource" AS ENUM ('BOOKING', 'ICAL', 'GHL', 'MANUAL');

CREATE TABLE "Contact" (
  "id"           TEXT          NOT NULL,
  "phoneE164"    TEXT          NOT NULL,
  "name"         TEXT,
  "email"        TEXT,
  "propertyId"   TEXT,
  "source"       "ContactSource" NOT NULL DEFAULT 'BOOKING',
  "firstSeenAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "bookingCount" INTEGER       NOT NULL DEFAULT 1,
  "notes"        TEXT,
  "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)  NOT NULL,

  CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Contact_phoneE164_key" ON "Contact"("phoneE164");
CREATE INDEX "Contact_propertyId_lastSeenAt_idx" ON "Contact"("propertyId", "lastSeenAt");
CREATE INDEX "Contact_email_idx" ON "Contact"("email");

ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
