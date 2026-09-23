-- AlterTable
ALTER TABLE "whatsapp_chat_messages" ADD COLUMN "deviceId" TEXT;
ALTER TABLE "whatsapp_chat_messages" ADD COLUMN "templateType" TEXT;

-- AddForeignKey
ALTER TABLE "whatsapp_chat_messages" ADD CONSTRAINT "whatsapp_chat_messages_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
