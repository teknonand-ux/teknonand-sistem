const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee, requireDealer } = require('../middleware/auth');
const { hashPassword } = require('../lib/auth');
const { sendStatusWhatsapp, sendDealerBalanceReminder } = require('../services/whatsapp');

const router = express.Router();

// --- Personel (yönetici paneli) uçları ---
router.get('/', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    const query = (req.query.query || '').toString().trim();
    const dealers = await prisma.dealer.findMany({
      where: query ? { name: { contains: query, mode: 'insensitive' } } : undefined,
      orderBy: { name: 'asc' },
      include: { transactions: { orderBy: { createdAt: 'desc' } } },
    });
    res.json(dealers);
  } catch (e) {
    next(e);
  }
});

router.post('/', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().min(1),
      phone: z.string().optional(),
      username: z.string().min(1),
      password: z.string().min(8),
    });
    const { name, phone, username, password } = schema.parse(req.body);
    const dealer = await prisma.dealer.create({
      data: { name, phone, username: username.toLowerCase(), passwordHash: await hashPassword(password) },
    });
    res.status(201).json(dealer);
  } catch (e) {
    next(e);
  }
});

// POST /api/dealers/:id/transactions — veresiye satış / tahsilat. TAHSILAT'ta
// ödeme yöntemi zorunlu — Kasa'nın gelir dökümü (yonetici-paneli.html
// allPayments()) bu bayi tahsilatlarını yönteme göre TL/Nakit/Banka/Kredi/Sanal
// POS sütunlarına dağıtırken kullanır.
router.post('/:id/transactions', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    const schema = z
      .object({
        type: z.enum(['VERESIYE_SATIS', 'TAHSILAT']),
        amount: z.number().positive(),
        method: z.string().min(1).optional(),
        description: z.string().optional(),
      })
      .refine((d) => d.type !== 'TAHSILAT' || !!d.method, { message: 'Ödeme yöntemi seçilmelidir', path: ['method'] });
    const { type, amount, method, description } = schema.parse(req.body);
    const delta = type === 'VERESIYE_SATIS' ? amount : -amount;
    await prisma.$transaction([
      prisma.dealer.update({ where: { id: req.params.id }, data: { balance: { increment: delta } } }),
      prisma.dealerTransaction.create({ data: { dealerId: req.params.id, type, amount, method, description } }),
    ]);
    const dealer = await prisma.dealer.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { createdAt: 'desc' } } },
    });
    res.json(dealer);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/dealers/:id/transactions/:txId — hareketi sil, bakiyeyi geri al
router.delete('/:id/transactions/:txId', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    const tx = await prisma.dealerTransaction.findUnique({ where: { id: req.params.txId } });
    if (!tx || tx.dealerId !== req.params.id) return res.status(404).json({ error: 'Hareket bulunamadı' });
    const delta = tx.type === 'VERESIYE_SATIS' ? -Number(tx.amount) : Number(tx.amount);
    await prisma.$transaction([
      prisma.dealer.update({ where: { id: req.params.id }, data: { balance: { increment: delta } } }),
      prisma.dealerTransaction.delete({ where: { id: req.params.txId } }),
    ]);
    const dealer = await prisma.dealer.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { createdAt: 'desc' } } },
    });
    res.json(dealer);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    const { password, phone } = z
      .object({ password: z.string().min(8).optional(), phone: z.string().min(1).optional() })
      .parse(req.body);
    const data = {};
    if (password) data.passwordHash = await hashPassword(password);
    if (phone) data.phone = phone;
    const dealer = await prisma.dealer.update({ where: { id: req.params.id }, data });
    res.json(dealer);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    await prisma.dealer.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// POST /api/dealers/:id/balance-whatsapp — "WhatsApp ile Bakiye Bildir" butonu:
// onaylı WHATSAPP_TEMPLATE_DEALER_BALANCE şablonuyla güncel veresiye bakiyesini
// otomatik gönderir (bkz. src/services/whatsapp.js sendDealerBalanceReminder).
router.post('/:id/balance-whatsapp', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    const dealer = await prisma.dealer.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!dealer.phone) return res.status(400).json({ error: 'Bayinin telefon numarası kayıtlı değil' });
    const result = await sendDealerBalanceReminder(dealer);
    if (!result.ok) return res.status(502).json({ error: result.error || 'Mesaj gönderilemedi' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// --- Bayi portalı (kendi verisi) ---
router.get('/me', requireAuth, requireDealer, async (req, res, next) => {
  try {
    const dealer = await prisma.dealer.findUnique({
      where: { id: req.user.sub },
      include: { transactions: { orderBy: { createdAt: 'desc' } } },
    });
    res.json(dealer);
  } catch (e) {
    next(e);
  }
});

router.get('/me/devices', requireAuth, requireDealer, async (req, res, next) => {
  try {
    const { query, mode = 'imei', from, to } = req.query;
    const where = { dealerId: req.user.sub };
    if (query) {
      const q = query.toString().trim();
      if (mode === 'imei') where.imeiSerial = { contains: q, mode: 'insensitive' };
      else where.model = { contains: q, mode: 'insensitive' };
    }
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }
    const devices = await prisma.device.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        // Bayiye maliyet/toptancı gibi iç bilgiler değil, yalnızca işlem adı ve
        // (KDV'ye göre hesaplanacak) satış fiyatı gösterilir.
        parts: { select: { id: true, name: true, price: true, vatMode: true, warrantyMonths: true } },
        diagnosisItems: { orderBy: { createdAt: 'asc' } },
      },
    });
    res.json(devices);
  } catch (e) {
    next(e);
  }
});

// POST /api/dealers/me/devices/:id/approve — bayi fiyat onayı
router.post('/me/devices/:id/approve', requireAuth, requireDealer, async (req, res, next) => {
  try {
    const { note } = z.object({ note: z.string().optional() }).parse(req.body);
    const device = await prisma.device.findFirst({ where: { id: req.params.id, dealerId: req.user.sub } });
    if (!device) return res.status(404).json({ error: 'Cihaz bulunamadı' });

    const updated = await prisma.device.update({
      where: { id: device.id },
      data: { dealerApproved: true, status: 'APPROVED', approvalNote: note, approvedAt: new Date(), approvalSeenByStaff: false },
    });
    await prisma.deviceStatusHistory.create({
      data: {
        deviceId: device.id,
        status: 'APPROVED',
        note: note ? `Bayi tarafından onaylandı — Not: ${note}` : 'Bayi tarafından onaylandı',
      },
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

// POST /api/dealers/me/devices/:id/request-return — bayi onarımı reddedip cihazın iadesini ister
router.post('/me/devices/:id/request-return', requireAuth, requireDealer, async (req, res, next) => {
  try {
    const { note } = z.object({ note: z.string().optional() }).parse(req.body);
    const device = await prisma.device.findFirst({ where: { id: req.params.id, dealerId: req.user.sub } });
    if (!device) return res.status(404).json({ error: 'Cihaz bulunamadı' });

    const updated = await prisma.device.update({
      where: { id: device.id },
      data: {
        status: 'RETURN_REQUESTED',
        returnReason: note || 'Bayi onarımı onaylamayıp cihazın iadesini istedi',
        approvalSeenByStaff: false,
      },
    });
    await prisma.deviceStatusHistory.create({
      data: {
        deviceId: device.id,
        status: 'RETURN_REQUESTED',
        note: note ? `Bayi tarafından iade istendi — Not: ${note}` : 'Bayi tarafından iade istendi',
      },
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

// Tüm arıza kalemleri yanıtlandığında cihazı otomatik APPROVED/RETURN_REQUESTED
// durumuna geçirir (bkz. track.js'teki aynı isimli fonksiyon — burada bayi tarafı için).
async function advanceStatusIfAllItemsResponded(deviceId, respondedByLabel) {
  const items = await prisma.diagnosisItem.findMany({ where: { deviceId } });
  if (!items.length || items.some((it) => it.approved === null)) return null;

  const anyApproved = items.some((it) => it.approved === true);
  const newStatus = anyApproved ? 'APPROVED' : 'RETURN_REQUESTED';
  const data = anyApproved
    ? { status: 'APPROVED', approvedAt: new Date(), approvalSeenByStaff: false }
    : { status: 'RETURN_REQUESTED', returnReason: `${respondedByLabel} tüm arızaları reddetti, cihazın iadesini istedi`, approvalSeenByStaff: false };

  const updated = await prisma.device.update({ where: { id: deviceId }, data, include: { customer: true } });
  await prisma.deviceStatusHistory.create({
    data: {
      deviceId,
      status: newStatus,
      note: anyApproved
        ? `${respondedByLabel} tüm arıza kalemlerini yanıtladı, en az biri onaylandı`
        : `${respondedByLabel} tüm arıza kalemlerini reddetti`,
    },
  });
  await sendStatusWhatsapp(updated, updated.customer, newStatus);
  return updated;
}

// POST /api/dealers/me/devices/:id/diagnosis-items/:itemId/respond — bayi, tek bir
// arıza kalemini onaylar ya da reddeder ("yapılmasın")
router.post('/me/devices/:id/diagnosis-items/:itemId/respond', requireAuth, requireDealer, async (req, res, next) => {
  try {
    const { approved, note } = z
      .object({ approved: z.boolean(), note: z.string().max(300).optional() })
      .parse(req.body);
    const device = await prisma.device.findFirst({ where: { id: req.params.id, dealerId: req.user.sub } });
    if (!device) return res.status(404).json({ error: 'Cihaz bulunamadı' });

    const item = await prisma.diagnosisItem.findFirst({ where: { id: req.params.itemId, deviceId: device.id } });
    if (!item) return res.status(404).json({ error: 'Arıza kalemi bulunamadı' });

    await prisma.diagnosisItem.update({
      where: { id: item.id },
      data: { approved, respondedBy: 'dealer', respondedAt: new Date(), respondNote: note || null },
    });

    await advanceStatusIfAllItemsResponded(device.id, 'Bayi');

    const updatedDevice = await prisma.device.findUnique({
      where: { id: device.id },
      include: {
        parts: { select: { id: true, name: true, price: true, vatMode: true, warrantyMonths: true } },
        diagnosisItems: { orderBy: { createdAt: 'asc' } },
      },
    });
    res.json(updatedDevice);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
