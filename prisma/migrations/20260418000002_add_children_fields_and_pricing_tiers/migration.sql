-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "childrenUnder3" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "children3to5" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "childrenOver6" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "childrenFee" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ChildPricingTier" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ageMin" INTEGER NOT NULL,
    "ageMax" INTEGER NOT NULL,
    "rateType" TEXT NOT NULL,
    "fixedRate" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildPricingTier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChildPricingTier_propertyId_idx" ON "ChildPricingTier"("propertyId");

-- AddForeignKey
ALTER TABLE "ChildPricingTier" ADD CONSTRAINT "ChildPricingTier_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
