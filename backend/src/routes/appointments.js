const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee } = require('../middleware/auth');
const { sendNotificationEmail } = require('../services/mail');
const { sendNewAppointmentStaffAlert, sendAppointmentConfirmation } = require('../services/whatsapp');

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
    sendNotificationEmail(
      'Yeni Randevu Talebi — Teknonand',
      [
        'Web sitesinden yeni bir randevu talebi alındı:',
        '',
        `Ad Soyad: ${data.customerName}`,
        `Telefon: ${data.phone}`,
        `Tarih / Saat: ${new Date(data.datetime).toLocaleString('tr-TR', { dateStyle: 'long', timeStyle: 'short' })}`,
        data.service ? `Not: ${data.service}` : null,
        '',
        'Yönetici panelindeki Randevular sayfasından onaylayabilirsiniz.',
      ].filter(Boolean).join('\n')
    ).catch((e) => console.error('Randevu e-postası gönderilemedi:', e.message));
    sendNewAppointmentStaffAlert(appt).catch((e) => console.error('Randevu WhatsApp bildirimi gönderilemedi:', e.message));
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

// POST /api/appointments/:id/send-confirmation-whatsapp — panelden müşteriye gerçek
// WhatsApp Cloud API üzerinden onay gönderir (bkz. yonetici-paneli.html Randevular sayfası).
router.post('/:id/send-confirmation-whatsapp', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    const appt = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!appt) return res.status(404).json({ error: 'Randevu bulunamadı' });

    const result = await sendAppointmentConfirmation(appt);
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ ok: true });
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
