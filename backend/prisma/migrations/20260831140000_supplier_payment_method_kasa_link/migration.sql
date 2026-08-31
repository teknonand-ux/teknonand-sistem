-- AlterTable
ALTER TABLE "supplier_transactions" ADD COLUMN "method" TEXT;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "supplierTransactionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "expenses_supplierTransactionId_key" ON "expenses"("supplierTransactionId");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplierTransactionId_fkey" FOREIGN KEY ("supplierTransactionId") REFERENCES "supplier_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
