-- AlterEnum
ALTER TYPE "OdealInvoiceStatus" ADD VALUE 'TASLAK';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "invoiceDescription" TEXT;
ALTER TABLE "payments" ADD COLUMN "invoiceCustomerName" TEXT;
ALTER TABLE "payments" ADD COLUMN "invoiceAmount" DECIMAL(12,2);
