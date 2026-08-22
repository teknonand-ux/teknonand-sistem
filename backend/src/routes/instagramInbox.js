const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee } = require('../middleware/auth');
const { verifyMetaSignature } = require('../middleware/verifyMetaSignature');
const { sendInstagramMessage } = require('../services/instagram');

const router = express.Router();

// GET /api/instagram/webhook — Meta'nın webhook URL'ini doğrulama adımı. Herkese
// açık, kimlik doğrulaması gerekmez.
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Yeni bir sohbet açılırken (ilk kez mesaj atan igsid) kullanıcı adını en iyi
// çaba (best-effort) ile çeker — başarısız olursa sessizce geçilir, sohbeti
// oluşturmayı engellemez.
async function fetchInstagramUsername(igsid) {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!accessToken) return null;
  try {
    const res = await fetch(`https://graph.instagram.com/v21.0/${igsid}?fields=username&access_token=${accessToken}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json.username || null;
  } catch {
    return null;
  }
}

// POST /api/instagram/webhook — Meta'dan gelen DM bildirimleri. Herkese açık
// olmak zorunda; her zaman hızlıca 200 dönüyoruz, aksi halde Meta aynı
// bildirimi tekrar tekrar dener.
router.post('/webhook', verifyMetaSignature('INSTAGRAM_APP_SECRET'), async (req, res) => {
  res.sendStatus(200);
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const event of entry.messaging || []) {
        if (event.message?.is_echo) continue; // kendi gönderdiğimiz mesajın yankısı — panelden gönderirken zaten kaydediyoruz
        const igsid = event.sender?.id;
        const msg = event.message;
        if (!igsid || !msg) continue;
        const body = msg.text || (msg.attachments?.length ? `[${msg.attachments[0].type || 'medya'} mesajı]` : '[boş mesaj]');

        let conversation = await prisma.instagramConversation.findUnique({ where: { igsid } });
        if (!conversation) {
          const username = await fetchInstagramUsername(igsid);
          conversation = await prisma.instagramConversation.create({ data: { igsid, username } });
        }

        try {
          await prisma.instagramChatMessage.create({
            data: { conversationId: conversation.id, direction: 'IN', body, igMessageId: msg.mid },
          });
        } catch (e) {
          if (e.code === 'P2002') continue; // Meta aynı mesajı tekrar gönderdi (retry) — atla
          throw e;
        }

        await prisma.instagramConversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: new Date(), lastMessagePreview: body.slice(0, 120), unreadCount: { increment: 1 } },
        });
      }
    }
  } catch (e) {
    console.error('[instagram webhook] işlenemedi:', e);
  }
});

router.use(requireAuth, requireEmployee);

// GET /api/instagram/conversations — gelen kutusu listesi, son mesaja göre sıralı
router.get('/conversations', async (req, res, next) => {
  try {
    const conversations = await prisma.instagramConversation.findMany({
      orderBy: { lastMessageAt: 'desc' },
      include: { customer: { select: { id: true, fullName: true } } },
    });
    res.json(conversations);
  } catch (e) {
    next(e);
  }
});

// GET /api/instagram/conversations/:id/messages — sohbet geçmişi; açılınca okunmamış sayacı sıfırlanır
router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const conversation = await prisma.instagramConversation.findUnique({
      where: { id: req.params.id },
      include: { customer: { select: { id: true, fullName: true } } },
    });
    if (!conversation) return res.status(404).json({ error: 'Sohbet bulunamadı' });

    const messages = await prisma.instagramChatMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
      include: { employee: { select: { id: true, name: true } } },
    });

    if (conversation.unreadCount > 0) {
      await prisma.instagramConversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
    }

    res.json({ conversation, messages });
  } catch (e) {
    next(e);
  }
});

// POST /api/instagram/conversations/:id/messages — panelden serbest metin yanıtı gönderir
router.post('/conversations/:id/messages', async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().min(1).max(1000) }).parse(req.body);
    const conversation = await prisma.instagramConversation.findUnique({ where: { id: req.params.id } });
    if (!conversation) return res.status(404).json({ error: 'Sohbet bulunamadı' });

    const result = await sendInstagramMessage(conversation.igsid, text);
    if (!result.ok) return res.status(502).json({ error: result.error });

    const message = await prisma.instagramChatMessage.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUT',
        body: text,
        igMessageId: result.igMessageId,
        employeeId: req.user.sub,
      },
      include: { employee: { select: { id: true, name: true } } },
    });
    await prisma.instagramConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), lastMessagePreview: text.slice(0, 120) },
    });

    res.status(201).json(message);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/instagram/conversations/:id — sohbeti ve tüm mesajlarını kalıcı olarak siler
router.delete('/conversations/:id', async (req, res, next) => {
  try {
    await prisma.instagramConversation.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Sohbet bulunamadı' });
    next(e);
  }
});

module.exports = router;
