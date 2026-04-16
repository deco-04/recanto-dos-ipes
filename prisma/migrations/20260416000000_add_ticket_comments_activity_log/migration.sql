-- CreateTable: TicketComment
CREATE TABLE IF NOT EXISTS "TicketComment" (
    "id"        TEXT          NOT NULL,
    "ticketId"  TEXT          NOT NULL,
    "staffId"   TEXT          NOT NULL,
    "body"      TEXT          NOT NULL,
    "createdAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TicketComment_ticketId_idx" ON "TicketComment"("ticketId");

-- AddForeignKey
ALTER TABLE "TicketComment" ADD CONSTRAINT "TicketComment_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "ServiceTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TicketComment" ADD CONSTRAINT "TicketComment_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: StaffActivityLog
CREATE TABLE IF NOT EXISTS "StaffActivityLog" (
    "id"         TEXT          NOT NULL,
    "staffId"    TEXT          NOT NULL,
    "actionType" TEXT          NOT NULL,
    "entityType" TEXT,
    "entityId"   TEXT,
    "summary"    TEXT,
    "meta"       JSONB,
    "createdAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StaffActivityLog_staffId_createdAt_idx" ON "StaffActivityLog"("staffId", "createdAt");
CREATE INDEX IF NOT EXISTS "StaffActivityLog_createdAt_idx" ON "StaffActivityLog"("createdAt");

-- AddForeignKey
ALTER TABLE "StaffActivityLog" ADD CONSTRAINT "StaffActivityLog_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
