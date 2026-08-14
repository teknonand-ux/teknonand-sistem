-- AlterTable
ALTER TABLE "dealer_transactions" ADD COLUMN     "deviceId" TEXT;

-- AddForeignKey
ALTER TABLE "dealer_transactions" ADD CONSTRAINT "dealer_transactions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
