/*
  Warnings:

  - You are about to drop the column `warranty` on the `device_parts` table. All the data in the column will be lost.
  - You are about to drop the `device_images` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "device_images" DROP CONSTRAINT "device_images_deviceId_fkey";

-- AlterTable
ALTER TABLE "device_parts" DROP COLUMN "warranty",
ADD COLUMN     "cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "warrantyMonths" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "deliveryImages" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "deliveryNote" TEXT,
ADD COLUMN     "diagnosisImages" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "returnImages" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "returnReason" TEXT;

-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "type" SET DEFAULT 'ARA_ODEME';

-- DropTable
DROP TABLE "device_images";
