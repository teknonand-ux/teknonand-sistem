-- AlterTable
ALTER TABLE "device_parts" ADD COLUMN "supplierId" TEXT;
ALTER TABLE "device_parts" ADD COLUMN "costUsd" DECIMAL(12,2);

-- AddForeignKey
ALTER TABLE "device_parts" ADD CONSTRAINT "device_parts_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
