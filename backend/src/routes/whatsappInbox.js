const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee } = require('../middleware/auth');
const { sendFreeTextMessage } = require('../services/whatsapp');

const router = express.Router();

// GET /api/whatsapp/webhook — Meta'nın webhook URL'ini doğrulama adımı (App Dashboard'da
// "Verify and Save" denildiğinde çağrılır). Herkese açık, kimlik doğrulaması gerekmez.
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function normalizePhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function findCustomerByPhone(waPhoneDigits) {
  // Customer.phone serbest formatta saklanıyor (bkz. devices.js) — normalize edip karşılaştırıyoruz.
  const candidates = await prisma.customer.findMany({ where: { phone: { contains: waPhoneDigits.slice(-10) } } });
  return candidates.find((c) => normalizePhoneDigits(c.phone) === waPhoneDigits) || candidates[0] || null;
}

// POST /api/whatsapp/webhook — Meta'dan gelen mesaj/olay bildirimleri. Herkese açık
// olmak zorunda (Meta bu uca istek atarken oturum/token kullanmaz); her zaman hızlıca
// 200 dönüyoruz, aksi halde Meta aynı bildirimi tekrar tekrar dener.
router.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contactName = value.contacts?.[0]?.profile?.name || null;
        for (const msg of value.messages || []) {
          const phoneDigits = normalizePhoneDigits(msg.from);
          if (!phoneDigits) continue;
          const body =
            msg.type === 'text'
              ? msg.text?.body || ''
              : `[desteklenmeyen mesaj türü: ${msg.type}]`;

          const existing = await prisma.whatsappConversation.findUnique({ where: { phone: phoneDigits } });
          let conversation = existing;
          if (!conversation) {
            const customer = await findCustomerByPhone(phoneDigits);
            conversation = await prisma.whatsappConversation.create({
              data: { phone: phoneDigits, contactName, customerId: customer?.id || null },
            });
          }

          try {
            await prisma.whatsappChatMessage.create({
              data: { conversationId: conversation.id, direction: 'IN', body, waMessageId: msg.id },
            });
          } catch (e) {
            if (e.code === 'P2002') continue; // Meta aynı mesajı tekrar gönderdi (retry) — atla
            throw e;
          }

          await prisma.whatsappConversation.update({
            where: { id: conversation.id },
            data: {
              lastMessageAt: new Date(),
              lastMessagePreview: body.slice(0, 120),
              unreadCount: { increment: 1 },
              ...(contactName && !conversation.contactName ? { contactName } : {}),
            },
          });
        }
      }
    }
  } catch (e) {
    console.error('[whatsapp webhook] işlenemedi:', e);
  }
});

router.use(requireAuth, requireEmployee);

// GET /api/whatsapp/conversations — gelen kutusu listesi, son mesaja göre sıralı
router.get('/conversations', async (req, res, next) => {
  try {
    const conversations = await prisma.whatsappConversation.findMany({
      orderBy: { lastMessageAt: 'desc' },
      include: { customer: { select: { id: true, fullName: true } } },
    });
    res.json(conversations);
  } catch (e) {
    next(e);
  }
});

// GET /api/whatsapp/conversations/:id/messages — sohbet geçmişi; açılınca okunmamış sayacı sıfırlanır
router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const conversation = await prisma.whatsappConversation.findUnique({
      where: { id: req.params.id },
      include: { customer: { select: { id: true, fullName: true } } },
    });
    if (!conversation) return res.status(404).json({ error: 'Sohbet bulunamadı' });

    const messages = await prisma.whatsappChatMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
      include: { employee: { select: { id: true, name: true } } },
    });

    if (conversation.unreadCount > 0) {
      await prisma.whatsappConversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
    }

    res.json({ conversation, messages });
  } catch (e) {
    next(e);
  }
});

// POST /api/whatsapp/conversations/:id/messages — panelden serbest metin yanıtı gönderir
router.post('/conversations/:id/messages', async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().min(1).max(4096) }).parse(req.body);
    const conversation = await prisma.whatsappConversation.findUnique({ where: { id: req.params.id } });
    if (!conversation) return res.status(404).json({ error: 'Sohbet bulunamadı' });

    const result = await sendFreeTextMessage(conversation.phone, text);
    if (!result.ok) return res.status(502).json({ error: result.error });

    const message = await prisma.whatsappChatMessage.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUT',
        body: text,
        waMessageId: result.waMessageId,
        employeeId: req.user.sub,
      },
      include: { employee: { select: { id: true, name: true } } },
    });
    await prisma.whatsappConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), lastMessagePreview: text.slice(0, 120) },
    });

    res.status(201).json(message);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/whatsapp/conversations/:id — sohbeti ve tüm mesajlarını kalıcı olarak siler
// (onDelete: Cascade — bkz. schema.prisma). Yalnızca panelden, geri alınamaz.
router.delete('/conversations/:id', async (req, res, next) => {
  try {
    await prisma.whatsappConversation.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Sohbet bulunamadı' });
    next(e);
  }
});

module.exports = router;
