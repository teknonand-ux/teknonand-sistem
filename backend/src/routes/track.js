const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { sendStatusWhatsapp } = require('../services/whatsapp');

const router = express.Router();

// Takip kodu tahmin/deneme saldırılarına karşı — dakikada 20 sorgu
const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
router.use(publicLimiter);

// GET /api/track/:code — herkese açık (takip-portali.html)
router.get('/:code', async (req, res, next) => {
  try {
    const code = req.params.code.toUpperCase();
    const device = await prisma.device.findUnique({
      where: { trackingCode: code },
      include: { customer: { select: { fullName: true } }, parts: true, payments: true },
    });
    if (!device) return res.status(404).json({ error: 'Bu koda ait bir kayıt bulunamadı' });
    res.json(device);
  } catch (e) {
    next(e);
  }
});

// POST /api/track/:code/approve — müşteri fiyat onayı
router.post('/:code/approve', async (req, res, next) => {
  try {
    const { note } = z.object({ note: z.string().optional() }).parse(req.body);
    const code = req.params.code.toUpperCase();
    const device = await prisma.device.findUnique({ where: { trackingCode: code }, include: { customer: true } });
    if (!device) return res.status(404).json({ error: 'Bu koda ait bir kayıt bulunamadı' });

    const updated = await prisma.device.update({
      where: { id: device.id },
      data: { customerApproved: true, status: 'APPROVED', approvalNote: note, approvedAt: new Date() },
    });
    await prisma.deviceStatusHistory.create({
      data: {
        deviceId: device.id,
        status: 'APPROVED',
        note: note ? `Müşteri tarafından onaylandı — Not: ${note}` : 'Müşteri tarafından onaylandı',
      },
    });
    await sendStatusWhatsapp(updated, device.customer, 'APPROVED');
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
