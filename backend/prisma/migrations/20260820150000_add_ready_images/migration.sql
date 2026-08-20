-- AlterTable
ALTER TABLE "devices" ADD COLUMN "readyImages" JSONB NOT NULL DEFAULT '[]';
