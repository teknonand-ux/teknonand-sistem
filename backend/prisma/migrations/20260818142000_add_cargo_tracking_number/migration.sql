-- AlterEnum
ALTER TYPE "DeviceStatus" ADD VALUE 'SHIPPED' BEFORE 'DELIVERED';

-- AlterTable
ALTER TABLE "devices" ADD COLUMN "cargoTrackingNumber" TEXT;
