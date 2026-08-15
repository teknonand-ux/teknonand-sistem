-- AlterTable
ALTER TABLE "devices" ADD COLUMN "isCargo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "devices" ADD COLUMN "cargoAddress" TEXT;
