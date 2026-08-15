-- CreateTable
CREATE TABLE "diagnosis_items" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "approved" BOOLEAN,
    "respondedBy" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnosis_items_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "diagnosis_items" ADD CONSTRAINT "diagnosis_items_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
