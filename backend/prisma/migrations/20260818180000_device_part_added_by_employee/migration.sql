-- AlterTable
ALTER TABLE "device_parts" ADD COLUMN "addedByEmployeeId" TEXT;

-- AddForeignKey
ALTER TABLE "device_parts" ADD CONSTRAINT "device_parts_addedByEmployeeId_fkey" FOREIGN KEY ("addedByEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
