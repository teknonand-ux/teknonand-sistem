-- AlterTable
ALTER TABLE "employees" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "employees" ADD COLUMN "lockedAt" TIMESTAMP(3);
