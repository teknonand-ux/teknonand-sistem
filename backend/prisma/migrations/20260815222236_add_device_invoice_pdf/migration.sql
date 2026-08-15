-- AlterTable
ALTER TABLE "devices" ADD COLUMN "invoicePdf" TEXT;
ALTER TABLE "devices" ADD COLUMN "invoiceUploadedAt" TIMESTAMP(3);
