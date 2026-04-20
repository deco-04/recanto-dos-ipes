-- Attribution: which staff member logged this expense.
-- Optional so bank-imported expenses (no staff context) still work.
ALTER TABLE "Expense"
  ADD COLUMN "createdById" TEXT;

ALTER TABLE "Expense"
  ADD CONSTRAINT "Expense_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "StaffMember"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Expense_createdById_idx" ON "Expense"("createdById");
