-- CreateEnum
CREATE TYPE "SupplierTxCurrency" AS ENUM ('TRY', 'USD');

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN "currentBalanceUsd" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "supplier_transactions" ADD COLUMN "currency" "SupplierTxCurrency" NOT NULL DEFAULT 'TRY';
