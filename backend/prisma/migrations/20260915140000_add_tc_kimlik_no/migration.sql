-- AlterTable
ALTER TABLE "customers" ADD COLUMN "tcKimlikNo" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "invoiceCustomerTcKimlikNo" TEXT;
