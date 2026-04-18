-- Phase 5: CDS Obra Management
-- Obra (project) → ObraEtapa (phase) → ObraUpdate (field update with photos)
-- Plus obraId foreign key on Expense for budget tracking

CREATE TYPE "ObraStatus" AS ENUM (
  'PLANEJAMENTO', 'EM_ANDAMENTO', 'PAUSADA', 'CONCLUIDA', 'CANCELADA'
);

CREATE TYPE "ObraEtapaStatus" AS ENUM (
  'PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA'
);

CREATE TABLE "Obra" (
  "id"               TEXT           NOT NULL PRIMARY KEY,
  "propertyId"       TEXT           NOT NULL,
  "title"            TEXT           NOT NULL,
  "description"      TEXT,
  "status"           "ObraStatus"   NOT NULL DEFAULT 'PLANEJAMENTO',
  "startDate"        DATE,
  "estimatedEndDate" DATE,
  "actualEndDate"    DATE,
  "orcamento"        DECIMAL(10, 2),
  "contractorName"   TEXT,
  "contractorPhone"  TEXT,
  "fornecedorId"     TEXT,
  "createdById"      TEXT           NOT NULL,
  "createdAt"        TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "ObraEtapa" (
  "id"          TEXT                NOT NULL PRIMARY KEY,
  "obraId"      TEXT                NOT NULL,
  "title"       TEXT                NOT NULL,
  "description" TEXT,
  "order"       INTEGER             NOT NULL,
  "status"      "ObraEtapaStatus"   NOT NULL DEFAULT 'PENDENTE',
  "photoUrls"   JSONB               NOT NULL DEFAULT '[]',
  "startedAt"   TIMESTAMP(3),
  "concluidaAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "ObraUpdate" (
  "id"        TEXT         NOT NULL PRIMARY KEY,
  "etapaId"   TEXT         NOT NULL,
  "authorId"  TEXT         NOT NULL,
  "body"      TEXT         NOT NULL,
  "photoUrls" JSONB        NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX "Obra_propertyId_idx"     ON "Obra"("propertyId");
CREATE INDEX "ObraEtapa_obraId_idx"    ON "ObraEtapa"("obraId");
CREATE INDEX "ObraUpdate_etapaId_idx"  ON "ObraUpdate"("etapaId");

-- Link expenses to obras
ALTER TABLE "Expense" ADD COLUMN "obraId" TEXT;
CREATE INDEX "Expense_obraId_idx" ON "Expense"("obraId");

-- Foreign keys (idempotent via DO $$ block)
DO $$ BEGIN
  ALTER TABLE "Obra" ADD CONSTRAINT "Obra_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Obra" ADD CONSTRAINT "Obra_fornecedorId_fkey"
    FOREIGN KEY ("fornecedorId") REFERENCES "Fornecedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Obra" ADD CONSTRAINT "Obra_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ObraEtapa" ADD CONSTRAINT "ObraEtapa_obraId_fkey"
    FOREIGN KEY ("obraId") REFERENCES "Obra"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ObraUpdate" ADD CONSTRAINT "ObraUpdate_etapaId_fkey"
    FOREIGN KEY ("etapaId") REFERENCES "ObraEtapa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ObraUpdate" ADD CONSTRAINT "ObraUpdate_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Expense" ADD CONSTRAINT "Expense_obraId_fkey"
    FOREIGN KEY ("obraId") REFERENCES "Obra"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
