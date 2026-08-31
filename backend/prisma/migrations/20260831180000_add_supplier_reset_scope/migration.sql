-- AlterTable
ALTER TABLE "supplier_resets" ADD COLUMN "supplierId" TEXT;

-- AddForeignKey
ALTER TABLE "supplier_resets" ADD CONSTRAINT "supplier_resets_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
