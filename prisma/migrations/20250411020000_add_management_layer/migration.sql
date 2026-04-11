-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: add_management_layer
-- Adds all new enums, columns, and tables introduced in the management layer
-- (staff portal, inspection reports, maintenance, surveys, reputation, etc.)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── New Enums ─────────────────────────────────────────────────────────────────

CREATE TYPE "SurveyStatus" AS ENUM ('NAO_ENVIADO', 'ENVIADO', 'RESPONDIDO');
CREATE TYPE "PropertyType" AS ENUM ('SITIO', 'CABANA_COMPLEX', 'CABANA');
CREATE TYPE "StaffRole" AS ENUM ('ADMIN', 'GUARDIA', 'PISCINEIRO');
CREATE TYPE "FontSize" AS ENUM ('SM', 'MD', 'LG', 'XL');
CREATE TYPE "InspectionType" AS ENUM ('PRE_CHECKIN', 'CHECKOUT');
CREATE TYPE "InspectionStatus" AS ENUM ('DRAFT', 'SUBMITTED');
CREATE TYPE "ItemStatus" AS ENUM ('OK', 'PROBLEMA', 'NAO_VERIFICADO');
CREATE TYPE "TicketPriority" AS ENUM ('BAIXA', 'NORMAL', 'ALTA', 'URGENTE');
CREATE TYPE "TicketStatus" AS ENUM ('ABERTO', 'EM_ANDAMENTO', 'RESOLVIDO');
CREATE TYPE "TaskStatus" AS ENUM ('PENDENTE', 'FEITO');
CREATE TYPE "ReputationTier" AS ENUM ('VISITANTE', 'AMIGO', 'AMIGO_DA_CASA', 'VIP', 'FAMILIA');
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDENTE', 'ACEITA', 'REJEITADA');

-- ── New Tables (dependency order) ─────────────────────────────────────────────

-- Property (no FK deps)
CREATE TABLE "Property" (
    "id"             TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "slug"           TEXT NOT NULL,
    "type"           "PropertyType" NOT NULL DEFAULT 'SITIO',
    "address"        TEXT,
    "city"           TEXT,
    "state"          TEXT,
    "hasPool"        BOOLEAN NOT NULL DEFAULT false,
    "icalAirbnb"     TEXT,
    "icalBookingCom" TEXT,
    "active"         BOOLEAN NOT NULL DEFAULT true,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Property_slug_key" ON "Property"("slug");

-- Cabin (depends on Property)
CREATE TABLE "Cabin" (
    "id"          TEXT NOT NULL,
    "propertyId"  TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "slug"        TEXT NOT NULL,
    "capacity"    INTEGER NOT NULL DEFAULT 2,
    "description" TEXT,
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cabin_pkey" PRIMARY KEY ("id")
);

-- StaffMember (no FK deps)
CREATE TABLE "StaffMember" (
    "id"                 TEXT NOT NULL,
    "name"               TEXT NOT NULL,
    "email"              TEXT,
    "phone"              TEXT,
    "passwordHash"       TEXT,
    "googleId"           TEXT,
    "role"               "StaffRole" NOT NULL,
    "fontSizePreference" "FontSize" NOT NULL DEFAULT 'MD',
    "firstLoginDone"     BOOLEAN NOT NULL DEFAULT false,
    "pushSubscription"   JSONB,
    "active"             BOOLEAN NOT NULL DEFAULT true,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffMember_email_key" ON "StaffMember"("email");
CREATE UNIQUE INDEX "StaffMember_phone_key" ON "StaffMember"("phone");
CREATE UNIQUE INDEX "StaffMember_googleId_key" ON "StaffMember"("googleId");

-- StaffPropertyAssignment (depends on StaffMember, Property)
CREATE TABLE "StaffPropertyAssignment" (
    "id"         TEXT NOT NULL,
    "staffId"    TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPropertyAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffPropertyAssignment_staffId_propertyId_key"
    ON "StaffPropertyAssignment"("staffId", "propertyId");

-- ── Alter Existing Tables ─────────────────────────────────────────────────────

-- Booking: add propertyId, cabinId, surveyStatus
ALTER TABLE "Booking"
    ADD COLUMN "propertyId"   TEXT,
    ADD COLUMN "cabinId"      TEXT,
    ADD COLUMN "surveyStatus" "SurveyStatus" NOT NULL DEFAULT 'NAO_ENVIADO';

-- SeasonalPricing: add propertyId
ALTER TABLE "SeasonalPricing"
    ADD COLUMN "propertyId" TEXT;

-- ── Remaining New Tables ──────────────────────────────────────────────────────

-- InspectionReport (depends on Booking, Property, StaffMember)
CREATE TABLE "InspectionReport" (
    "id"               TEXT NOT NULL,
    "bookingId"        TEXT NOT NULL,
    "propertyId"       TEXT NOT NULL,
    "staffId"          TEXT NOT NULL,
    "type"             "InspectionType" NOT NULL,
    "status"           "InspectionStatus" NOT NULL DEFAULT 'DRAFT',
    "signatureDataUrl" TEXT,
    "submittedAt"      TIMESTAMP(3),
    "notes"            TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionReport_pkey" PRIMARY KEY ("id")
);

-- InspectionItem (depends on InspectionReport)
CREATE TABLE "InspectionItem" (
    "id"                 TEXT NOT NULL,
    "reportId"           TEXT NOT NULL,
    "category"           TEXT NOT NULL,
    "description"        TEXT NOT NULL,
    "status"             "ItemStatus" NOT NULL DEFAULT 'NAO_VERIFICADO',
    "problemDescription" TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionItem_pkey" PRIMARY KEY ("id")
);

-- InspectionPhoto (depends on InspectionReport, InspectionItem)
CREATE TABLE "InspectionPhoto" (
    "id"                  TEXT NOT NULL,
    "reportId"            TEXT NOT NULL,
    "itemId"              TEXT,
    "cloudinaryPublicId"  TEXT NOT NULL,
    "cloudinaryUrl"       TEXT NOT NULL,
    "caption"             TEXT,
    "takenAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionPhoto_pkey" PRIMARY KEY ("id")
);

-- MaintenanceLog (depends on Property, StaffMember, Booking)
CREATE TABLE "MaintenanceLog" (
    "id"            TEXT NOT NULL,
    "propertyId"    TEXT NOT NULL,
    "staffId"       TEXT NOT NULL,
    "bookingId"     TEXT,
    "logType"       TEXT NOT NULL DEFAULT 'ROUTINE',
    "visitDate"     TIMESTAMP(3) NOT NULL,
    "borderCleaned" BOOLEAN NOT NULL DEFAULT false,
    "coverCleaned"  BOOLEAN NOT NULL DEFAULT false,
    "vacuumed"      BOOLEAN NOT NULL DEFAULT false,
    "waterTreated"  BOOLEAN NOT NULL DEFAULT false,
    "filterCleaned" BOOLEAN NOT NULL DEFAULT false,
    "checklistJson" JSONB NOT NULL DEFAULT '[]',
    "notes"         TEXT,
    "photoUrls"     JSONB NOT NULL DEFAULT '[]',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceLog_pkey" PRIMARY KEY ("id")
);

-- ServiceTicket (depends on Property, StaffMember)
CREATE TABLE "ServiceTicket" (
    "id"          TEXT NOT NULL,
    "propertyId"  TEXT NOT NULL,
    "openedById"  TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "photoUrls"   JSONB NOT NULL DEFAULT '[]',
    "priority"    "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "status"      "TicketStatus" NOT NULL DEFAULT 'ABERTO',
    "adminNotes"  TEXT,
    "resolvedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceTicket_pkey" PRIMARY KEY ("id")
);

-- MaintenanceSchedule (depends on Property)
CREATE TABLE "MaintenanceSchedule" (
    "id"              TEXT NOT NULL,
    "propertyId"      TEXT NOT NULL,
    "item"            TEXT NOT NULL,
    "frequencyDays"   INTEGER NOT NULL,
    "lastDoneAt"      TIMESTAMP(3),
    "nextDueAt"       TIMESTAMP(3) NOT NULL,
    "alertDaysBefore" INTEGER NOT NULL DEFAULT 7,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceSchedule_pkey" PRIMARY KEY ("id")
);

-- StaffTask (depends on StaffMember)
CREATE TABLE "StaffTask" (
    "id"           TEXT NOT NULL,
    "assignedToId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "bookingId"    TEXT,
    "title"        TEXT NOT NULL,
    "description"  TEXT,
    "dueDate"      TIMESTAMP(3),
    "status"       "TaskStatus" NOT NULL DEFAULT 'PENDENTE',
    "completedAt"  TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffTask_pkey" PRIMARY KEY ("id")
);

-- Survey (depends on Booking)
CREATE TABLE "Survey" (
    "id"                   TEXT NOT NULL,
    "bookingId"            TEXT NOT NULL,
    "guestEmail"           TEXT NOT NULL,
    "sentAt"               TIMESTAMP(3),
    "respondedAt"          TIMESTAMP(3),
    "score"                INTEGER,
    "comment"              TEXT,
    "googleReviewLinkSent" BOOLEAN NOT NULL DEFAULT false,
    "adminAlerted"         BOOLEAN NOT NULL DEFAULT false,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Survey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Survey_bookingId_key" ON "Survey"("bookingId");

-- GuestReputation (depends on User)
CREATE TABLE "GuestReputation" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "totalStays"    INTEGER NOT NULL DEFAULT 0,
    "averageScore"  DECIMAL(3,2) NOT NULL DEFAULT 0,
    "totalSpent"    DECIMAL(10,2) NOT NULL DEFAULT 0,
    "reviewsGiven"  INTEGER NOT NULL DEFAULT 0,
    "incidentCount" INTEGER NOT NULL DEFAULT 0,
    "score"         INTEGER NOT NULL DEFAULT 0,
    "tier"          "ReputationTier" NOT NULL DEFAULT 'VISITANTE',
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestReputation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GuestReputation_userId_key" ON "GuestReputation"("userId");

-- PricingSuggestion (depends on Property, StaffMember)
CREATE TABLE "PricingSuggestion" (
    "id"             TEXT NOT NULL,
    "propertyId"     TEXT NOT NULL,
    "periodStart"    TIMESTAMP(3) NOT NULL,
    "periodEnd"      TIMESTAMP(3) NOT NULL,
    "currentPrice"   DECIMAL(10,2) NOT NULL,
    "suggestedPrice" DECIMAL(10,2) NOT NULL,
    "reason"         TEXT NOT NULL,
    "status"         "SuggestionStatus" NOT NULL DEFAULT 'PENDENTE',
    "acceptedById"   TEXT,
    "acceptedAt"     TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingSuggestion_pkey" PRIMARY KEY ("id")
);

-- PushNotification (depends on StaffMember)
CREATE TABLE "PushNotification" (
    "id"      TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "title"   TEXT NOT NULL,
    "body"    TEXT NOT NULL,
    "type"    TEXT NOT NULL,
    "data"    JSONB,
    "read"    BOOLEAN NOT NULL DEFAULT false,
    "sentAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushNotification_pkey" PRIMARY KEY ("id")
);

-- ── Foreign Keys ──────────────────────────────────────────────────────────────

-- Cabin → Property
ALTER TABLE "Cabin"
    ADD CONSTRAINT "Cabin_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- StaffPropertyAssignment → StaffMember, Property
ALTER TABLE "StaffPropertyAssignment"
    ADD CONSTRAINT "StaffPropertyAssignment_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StaffPropertyAssignment"
    ADD CONSTRAINT "StaffPropertyAssignment_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Booking → Property, Cabin
ALTER TABLE "Booking"
    ADD CONSTRAINT "Booking_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Booking"
    ADD CONSTRAINT "Booking_cabinId_fkey"
    FOREIGN KEY ("cabinId") REFERENCES "Cabin"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- SeasonalPricing → Property
ALTER TABLE "SeasonalPricing"
    ADD CONSTRAINT "SeasonalPricing_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- InspectionReport → Booking, Property, StaffMember
ALTER TABLE "InspectionReport"
    ADD CONSTRAINT "InspectionReport_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InspectionReport"
    ADD CONSTRAINT "InspectionReport_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InspectionReport"
    ADD CONSTRAINT "InspectionReport_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- InspectionItem → InspectionReport
ALTER TABLE "InspectionItem"
    ADD CONSTRAINT "InspectionItem_reportId_fkey"
    FOREIGN KEY ("reportId") REFERENCES "InspectionReport"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- InspectionPhoto → InspectionReport, InspectionItem
ALTER TABLE "InspectionPhoto"
    ADD CONSTRAINT "InspectionPhoto_reportId_fkey"
    FOREIGN KEY ("reportId") REFERENCES "InspectionReport"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InspectionPhoto"
    ADD CONSTRAINT "InspectionPhoto_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "InspectionItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- MaintenanceLog → Property, StaffMember, Booking
ALTER TABLE "MaintenanceLog"
    ADD CONSTRAINT "MaintenanceLog_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaintenanceLog"
    ADD CONSTRAINT "MaintenanceLog_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaintenanceLog"
    ADD CONSTRAINT "MaintenanceLog_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ServiceTicket → Property, StaffMember
ALTER TABLE "ServiceTicket"
    ADD CONSTRAINT "ServiceTicket_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ServiceTicket"
    ADD CONSTRAINT "ServiceTicket_openedById_fkey"
    FOREIGN KEY ("openedById") REFERENCES "StaffMember"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- MaintenanceSchedule → Property
ALTER TABLE "MaintenanceSchedule"
    ADD CONSTRAINT "MaintenanceSchedule_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- StaffTask → StaffMember (assignee), StaffMember (creator)
ALTER TABLE "StaffTask"
    ADD CONSTRAINT "StaffTask_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "StaffMember"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StaffTask"
    ADD CONSTRAINT "StaffTask_assignedById_fkey"
    FOREIGN KEY ("assignedById") REFERENCES "StaffMember"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Survey → Booking
ALTER TABLE "Survey"
    ADD CONSTRAINT "Survey_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- GuestReputation → User
ALTER TABLE "GuestReputation"
    ADD CONSTRAINT "GuestReputation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- PricingSuggestion → Property, StaffMember
ALTER TABLE "PricingSuggestion"
    ADD CONSTRAINT "PricingSuggestion_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PricingSuggestion"
    ADD CONSTRAINT "PricingSuggestion_acceptedById_fkey"
    FOREIGN KEY ("acceptedById") REFERENCES "StaffMember"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- PushNotification → StaffMember
ALTER TABLE "PushNotification"
    ADD CONSTRAINT "PushNotification_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
