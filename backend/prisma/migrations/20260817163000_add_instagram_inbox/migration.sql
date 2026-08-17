-- CreateTable
CREATE TABLE "instagram_conversations" (
    "id" TEXT NOT NULL,
    "igsid" TEXT NOT NULL,
    "customerId" TEXT,
    "username" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessagePreview" TEXT,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instagram_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instagram_chat_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "WhatsappDirection" NOT NULL,
    "body" TEXT NOT NULL,
    "igMessageId" TEXT,
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instagram_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instagram_conversations_igsid_key" ON "instagram_conversations"("igsid");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_chat_messages_igMessageId_key" ON "instagram_chat_messages"("igMessageId");

-- CreateIndex
CREATE INDEX "instagram_chat_messages_conversationId_idx" ON "instagram_chat_messages"("conversationId");

-- AddForeignKey
ALTER TABLE "instagram_conversations" ADD CONSTRAINT "instagram_conversations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instagram_chat_messages" ADD CONSTRAINT "instagram_chat_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "instagram_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instagram_chat_messages" ADD CONSTRAINT "instagram_chat_messages_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
