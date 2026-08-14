const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee } = require('../middleware/auth');

const router = express.Router();

const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

const apptSchema = z.object({
  customerName: z.string().min(1),
  phone: z.string().min(1),
  datetime: z.string().datetime(),
  service: z.string().optional(),
});

// POST /api/appointments — herkese açık (randevu-al.html)
router.post('/', publicLimiter, async (req, res, next) => {
  try {
    const data = apptSchema.parse(req.body);
    const appt = await prisma.appointment.create({
      data: { ...data, datetime: new Date(data.datetime), source: 'WEBSITE' },
    });
    // TODO: WhatsApp bildirimi (müşteriye teyit + işletmeye bilgi) sendStatusWhatsapp benzeri servis ile gönderilecek
    res.status(201).json(appt);
  } catch (e) {
    next(e);
  }
});

// GET /api/appointments — panel için (giriş gerekli)
router.get('/', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    const appts = await prisma.appointment.findMany({ orderBy: { datetime: 'asc' } });
    res.json(appts);
  } catch (e) {
    next(e);
  }
});

// POST /api/appointments/panel — panelden manuel randevu oluşturma
router.post('/panel', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    const data = apptSchema.parse(req.body);
    const appt = await prisma.appointment.create({
      data: { ...data, datetime: new Date(data.datetime), source: 'PANEL' },
    });
    res.status(201).json(appt);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    await prisma.appointment.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
