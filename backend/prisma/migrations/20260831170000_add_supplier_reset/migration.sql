-- CreateTable
CREATE TABLE "supplier_resets" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalAlimTry" DECIMAL(12,2) NOT NULL,
    "totalOdemeTry" DECIMAL(12,2) NOT NULL,
    "totalAlimUsd" DECIMAL(12,2) NOT NULL,
    "totalOdemeUsd" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_resets_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "supplier_resets" ADD CONSTRAINT "supplier_resets_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
