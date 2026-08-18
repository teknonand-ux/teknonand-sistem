-- CreateEnum
CREATE TYPE "LabelPrintJobStatus" AS ENUM ('PENDING', 'PRINTED');

-- CreateTable
CREATE TABLE "label_print_jobs" (
    "id" TEXT NOT NULL,
    "trackingCode" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "issueDescription" TEXT,
    "devicePassword" TEXT,
    "imeiSerial" TEXT,
    "status" "LabelPrintJobStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printedAt" TIMESTAMP(3),

    CONSTRAINT "label_print_jobs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "label_print_jobs" ADD CONSTRAINT "label_print_jobs_requestedByEmployeeId_fkey" FOREIGN KEY ("requestedByEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
