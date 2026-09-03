-- CreateEnum
CREATE TYPE "WhatsappChatMessageStatus" AS ENUM ('GONDERILDI', 'ILETILDI', 'OKUNDU', 'BASARISIZ');

-- AlterTable
ALTER TABLE "whatsapp_chat_messages" ADD COLUMN "status" "WhatsappChatMessageStatus" NOT NULL DEFAULT 'GONDERILDI';
ALTER TABLE "whatsapp_chat_messages" ADD COLUMN "statusError" TEXT;
