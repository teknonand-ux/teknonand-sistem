const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee } = require('../middleware/auth');
const { sendStatusWhatsapp } = require('../services/whatsapp');

const router = express.Router();
router.use(requireAuth, requireEmployee);

async function nextTrackingCode() {
  const year = new Date().getFullYear();
  const count = await prisma.device.count();
  return `TKN-${year}-${String(300 + count).padStart(4, '0')}`;
}

const deviceCreateSchema = z.object({
  customerName: z.string().min(1),
  customerPhone: z.string().min(1),
  backupPhone: z.string().optional(),
  dealerId: z.string().uuid().optional().nullable(),
  assignedEmployeeId: z.string().uuid().optional().nullable(),
  model: z.string().min(1),
  brand: z.string().optional(),
  imeiSerial: z.string().optional(),
  devicePassword: z.string().optional(),
  deviceOff: z.boolean().optional(),
  issueDescription: z.string().min(1),
  receivedAt: z.string().datetime().optional(),
});

// GET /api/devices?status=&query=&mode=imei|phone|name|model
router.get('/', async (req, res, next) => {
  try {
    const { status, query, mode = 'imei' } = req.query;
    const where = {};
    if (status) where.status = status;
    if (query) {
      const q = query.toString().trim();
      if (mode === 'imei') where.imeiSerial = { contains: q, mode: 'insensitive' };
      else if (mode === 'model') where.model = { contains: q, mode: 'insensitive' };
      else if (mode === 'phone') where.customer = { phone: { contains: q.replace(/\s|-/g, '') } };
      else if (mode === 'name') where.customer = { fullName: { contains: q, mode: 'insensitive' } };
    }
    const devices = await prisma.device.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { customer: true, dealer: true, assignedEmployee: true, parts: true, payments: true },
    });
    res.json(devices);
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const device = await prisma.device.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        dealer: true,
        assignedEmployee: true,
        parts: true,
        payments: true,
        statusHistory: { orderBy: { changedAt: 'desc' }, include: { changedByEmployee: true } },
        repair: true,
        images: true,
      },
    });
    if (!device) return res.status(404).json({ error: 'Cihaz bulunamadı' });
    res.json(device);
  } catch (e) {
    next(e);
  }
});

async function createOneDevice(input, employeeId) {
  const customer = await prisma.customer.findFirst({ where: { phone: input.customerPhone } });
  const customerRecord = customer
    ? await prisma.customer.update({
        where: { id: customer.id },
        data: { fullName: input.customerName, backupPhone: input.backupPhone || customer.backupPhone },
      })
    : await prisma.customer.create({
        data: { fullName: input.customerName, phone: input.customerPhone, backupPhone: input.backupPhone },
      });

  const trackingCode = await nextTrackingCode();

  const device = await prisma.device.create({
    data: {
      customerId: customerRecord.id,
      dealerId: input.dealerId || null,
      assignedEmployeeId: input.assignedEmployeeId || employeeId || null,
      trackingCode,
      brand: input.brand || 'Apple',
      model: input.model,
      imeiSerial: input.imeiSerial,
      devicePassword: input.devicePassword,
      backupPhone: input.backupPhone,
      deviceOff: !!input.deviceOff,
      issueDescription: input.issueDescription,
      receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
      status: 'RECEIVED',
    },
    include: { customer: true },
  });

  await prisma.deviceStatusHistory.create({
    data: { deviceId: device.id, status: 'RECEIVED', changedByEmployeeId: employeeId, note: 'Cihaz kabul edildi' },
  });

  await sendStatusWhatsapp(device, customerRecord, 'RECEIVED');
  return device;
}

// POST /api/devices  — tekli kayıt
router.post('/', async (req, res, next) => {
  try {
    const input = deviceCreateSchema.parse(req.body);
    const device = await createOneDevice(input, req.user.sub);
    res.status(201).json(device);
  } catch (e) {
    next(e);
  }
});

// POST /api/devices/bulk  — bayiden toplu kayıt
router.post('/bulk', async (req, res, next) => {
  try {
    const schema = z.object({
      dealerId: z.string().uuid(),
      receivedAt: z.string().datetime().optional(),
      rows: z
        .array(
          z.object({
            model: z.string().min(1),
            imeiSerial: z.string().optional(),
            issueDescription: z.string().min(1),
            devicePassword: z.string().optional(),
            deviceOff: z.boolean().optional(),
          })
        )
        .min(1),
    });
    const { dealerId, receivedAt, rows } = schema.parse(req.body);
    const dealer = await prisma.dealer.findUniqueOrThrow({ where: { id: dealerId } });

    const created = [];
    for (const row of rows) {
      const device = await createOneDevice(
        {
          customerName: dealer.name,
          customerPhone: dealer.phone || dealer.username,
          dealerId,
          model: row.model,
          imeiSerial: row.imeiSerial,
          issueDescription: row.issueDescription,
          devicePassword: row.devicePassword,
          deviceOff: row.deviceOff,
          receivedAt,
        },
        req.user.sub
      );
      created.push(device);
    }
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/devices/:id/status
router.patch('/:id/status', async (req, res, next) => {
  try {
    const schema = z.object({
      status: z.enum([
        'RECEIVED', 'DIAGNOSING', 'DIAGNOSIS_DONE', 'AWAITING_PARTS', 'APPROVED',
        'IN_REPAIR', 'TESTING', 'READY', 'DELIVERED', 'RETURNED', 'CANCELLED',
      ]),
      note: z.string().optional(),
      diagnosisText: z.string().optional(),
      estimatedPrice: z.number().optional(),
      deliveryMethod: z.string().optional(),
    });
    const { status, note, diagnosisText, estimatedPrice, deliveryMethod } = schema.parse(req.body);

    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: { status, diagnosisText, estimatedPrice, deliveryMethod },
      include: { customer: true },
    });

    await prisma.deviceStatusHistory.create({
      data: { deviceId: device.id, status, note, changedByEmployeeId: req.user.sub },
    });

    await sendStatusWhatsapp(device, device.customer, status);

    res.json(device);
  } catch (e) {
    next(e);
  }
});

// POST /api/devices/:id/parts  — parça ekle (stoktan düşer)
router.post('/:id/parts', async (req, res, next) => {
  try {
    const schema = z.object({
      stockItemId: z.string().uuid().optional(),
      name: z.string().min(1),
      price: z.number().nonnegative(),
      vatMode: z.enum(['DAHIL', 'HARIC']).default('DAHIL'),
      warranty: z.boolean().optional(),
    });
    const input = schema.parse(req.body);

    const part = await prisma.$transaction(async (tx) => {
      const created = await tx.devicePart.create({
        data: { deviceId: req.params.id, ...input },
      });
      if (input.stockItemId) {
        await tx.stockItem.update({
          where: { id: input.stockItemId },
          data: { quantity: { decrement: 1 } },
        });
        await tx.stockMovement.create({
          data: {
            stockItemId: input.stockItemId,
            deviceId: req.params.id,
            quantityChange: -1,
            reason: 'KULLANIM',
          },
        });
      }
      return created;
    });

    res.status(201).json(part);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/parts/:partId', async (req, res, next) => {
  try {
    await prisma.devicePart.delete({ where: { id: req.params.partId } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// POST /api/devices/:id/payments
router.post('/:id/payments', async (req, res, next) => {
  try {
    const schema = z.object({
      amount: z.number().positive(),
      method: z.enum(['NAKIT', 'KART', 'HAVALE']),
      type: z.enum(['KAPORA', 'ARA_ODEME', 'FINAL']),
    });
    const input = schema.parse(req.body);
    const payment = await prisma.payment.create({ data: { deviceId: req.params.id, ...input } });
    res.status(201).json(payment);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.device.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
