const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireEmployee);

// GET /api/label-print-jobs/pending — "ana yazıcı" bilgisayarın yokladığı kuyruk
router.get('/pending', async (req, res, next) => {
  try {
    const jobs = await prisma.labelPrintJob.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { requestedByEmployee: { select: { name: true } } },
    });
    res.json(jobs);
  } catch (e) {
    next(e);
  }
});

// POST /api/label-print-jobs — personel mobil/kendi bilgisayarından etiket yazdırma isteği oluşturur
router.post('/', async (req, res, next) => {
  try {
    const schema = z.object({
      trackingCode: z.string().min(1),
      customerName: z.string().min(1),
      customerPhone: z.string().optional(),
      issueDescription: z.string().optional(),
      devicePassword: z.string().optional(),
      imeiSerial: z.string().optional(),
    });
    const data = schema.parse(req.body);
    const job = await prisma.labelPrintJob.create({
      data: { ...data, requestedByEmployeeId: req.user.sub },
    });
    res.status(201).json(job);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/label-print-jobs/:id — ana yazıcı bilgisayar yazdırdıktan sonra işaretler
router.patch('/:id', async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(['PRINTED']) }).parse(req.body);
    const job = await prisma.labelPrintJob.update({
      where: { id: req.params.id },
      data: { status, printedAt: new Date() },
    });
    res.json(job);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
