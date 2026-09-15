-- CreateEnum
CREATE TYPE "OdealInvoiceStatus" AS ENUM ('YOK', 'BEKLIYOR', 'KESILDI', 'HATA');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "invoiceStatus" "OdealInvoiceStatus" NOT NULL DEFAULT 'YOK';
ALTER TABLE "payments" ADD COLUMN "invoiceError" TEXT;
