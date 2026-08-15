const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee, requireDealer } = require('../middleware/auth');
const { hashPassword } = require('../lib/auth');

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

// POST /api/dealers/:id/transactions — veresiye satış / tahsilat
router.post('/:id/transactions', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    const schema = z.object({ type: z.enum(['VERESIYE_SATIS', 'TAHSILAT']), amount: z.number().positive(), description: z.string().optional() });
    const { type, amount, description } = schema.parse(req.body);
    const delta = type === 'VERESIYE_SATIS' ? amount : -amount;
    await prisma.$transaction([
      prisma.dealer.update({ where: { id: req.params.id }, data: { balance: { increment: delta } } }),
      prisma.dealerTransaction.create({ data: { dealerId: req.params.id, type, amount, description } }),
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
    const devices = await prisma.device.findMany({ where, orderBy: { createdAt: 'desc' }, include: { parts: true } });
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
      data: { dealerApproved: true, status: 'APPROVED', approvalNote: note, approvedAt: new Date() },
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
        status: 'RETURNED',
        returnReason: note || 'Bayi onarımı onaylamayıp cihazın iadesini istedi',
      },
    });
    await prisma.deviceStatusHistory.create({
      data: {
        deviceId: device.id,
        status: 'RETURNED',
        note: note ? `Bayi tarafından iade istendi — Not: ${note}` : 'Bayi tarafından iade istendi',
      },
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
