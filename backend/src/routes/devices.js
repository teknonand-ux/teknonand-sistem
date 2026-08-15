const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee, requireAdmin } = require('../middleware/auth');
const { sendStatusWhatsapp } = require('../services/whatsapp');

const router = express.Router();
router.use(requireAuth, requireEmployee);

// Görsel alanları yalnızca base64 data URL kabul eder — serbest metin izin verilirse
// bu değerler daha sonra <img src="..."> olarak basılan sayfalarda saklı XSS'e yol açabilir.
const dataUrlImage = z
  .string()
  .max(4_000_000)
  .regex(/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*$/, 'Geçersiz görsel formatı');

// Bayiye ait, teslim edilmiş bir cihazın parça/işlem tutarını bayinin veresiye
// hesabına ekler (bir cihaz için yalnızca bir kez) — hem durum DELIVERED'a
// geçtiğinde hem de zaten DELIVERED olan bir cihaz sonradan bir bayiye
// atandığında (ör. Müşteri Bilgilerini Düzenle'den) çağrılır.
async function creditDealerIfDelivered(device) {
  if (device.status !== 'DELIVERED' || !device.dealerId) return;
  const already = await prisma.dealerTransaction.findFirst({
    where: { deviceId: device.id, type: 'VERESIYE_SATIS' },
  });
  if (already) return;
  const parts = await prisma.devicePart.findMany({ where: { deviceId: device.id } });
  const total = parts.reduce((s, p) => s + lineGross(p), 0);
  if (total <= 0) return;
  await prisma.$transaction([
    prisma.dealer.update({ where: { id: device.dealerId }, data: { balance: { increment: total } } }),
    prisma.dealerTransaction.create({
      data: {
        dealerId: device.dealerId,
        deviceId: device.id,
        type: 'VERESIYE_SATIS',
        amount: total,
        description: `${device.trackingCode} — otomatik veresiye`,
      },
    }),
  ]);
}

function lineGross(part) {
  const price = Number(part.price);
  return part.vatMode === 'HARIC' ? price * 1.2 : price;
}

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
  isCargo: z.boolean().optional(),
  cargoAddress: z.string().optional(),
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
      include: {
        customer: true, dealer: true, assignedEmployee: true, parts: true, payments: true,
        statusHistory: { orderBy: { changedAt: 'desc' } },
        diagnosisItems: { orderBy: { createdAt: 'asc' } },
      },
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
        diagnosisItems: { orderBy: { createdAt: 'asc' } },
        repair: true,
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
      isCargo: !!input.isCargo,
      cargoAddress: input.cargoAddress || null,
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
        'IN_REPAIR', 'TESTING', 'READY', 'DELIVERED', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED',
      ]),
      note: z.string().optional(),
      changedAt: z.string().datetime().optional(),
      diagnosisText: z.string().optional(),
      estimatedPrice: z.number().optional(),
      diagnosisImages: z.array(dataUrlImage).max(4).optional(),
      // Bir cihazda birden fazla ariza olabilir -- her biri kendi fiyati ve
      // (musteri/bayi tarafindan) kendi onay/ret durumuyla ayri ayri takip edilir.
      diagnosisItems: z.array(z.object({
        description: z.string().min(1),
        price: z.number().nonnegative(),
      })).max(20).optional(),
      returnReason: z.string().optional(),
      returnImages: z.array(dataUrlImage).max(4).optional(),
      deliveryMethod: z.string().optional(),
      deliveryNote: z.string().optional(),
      deliveryImages: z.array(dataUrlImage).max(4).optional(),
      imeiSerial: z.string().optional(), // cihaz kapalı kabul edilmişse teslimde girilir
    });
    const { status, note, changedAt, imeiSerial, diagnosisItems, ...fields } = schema.parse(req.body);

    // Arıza tespiti yeniden girildiğinde (ör. tanı/fiyat güncellendi) önceki onay artık
    // geçersizdir — müşteri/bayiden tekrar onay istenmesi için onay bilgilerini sıfırlıyoruz.
    const resetApproval = status === 'DIAGNOSIS_DONE'
      ? { customerApproved: false, dealerApproved: false, approvalNote: null, approvedAt: null }
      : {};

    // diagnosisItems gönderildiyse (arıza tespiti kalem kalem girildiyse), eski kalemleri
    // silip yenilerini oluşturuyoruz; diagnosisText/estimatedPrice de bu kalemlerden
    // otomatik hesaplanıp geriye dönük uyumluluk için (WhatsApp şablonları, dashboard vb.)
    // Device üzerinde de tutulmaya devam ediyor.
    const itemFields = {};
    if (status === 'DIAGNOSIS_DONE' && diagnosisItems && diagnosisItems.length) {
      itemFields.diagnosisText = diagnosisItems.map((it) => it.description).join(', ');
      itemFields.estimatedPrice = diagnosisItems.reduce((s, it) => s + it.price, 0);
    }

    const device = await prisma.$transaction(async (tx) => {
      if (status === 'DIAGNOSIS_DONE' && diagnosisItems) {
        await tx.diagnosisItem.deleteMany({ where: { deviceId: req.params.id } });
        if (diagnosisItems.length) {
          await tx.diagnosisItem.createMany({
            data: diagnosisItems.map((it) => ({ deviceId: req.params.id, description: it.description, price: it.price })),
          });
        }
      }
      return tx.device.update({
        where: { id: req.params.id },
        data: { status, ...fields, ...itemFields, ...resetApproval, ...(imeiSerial ? { imeiSerial } : {}) },
        include: { customer: true, diagnosisItems: { orderBy: { createdAt: 'asc' } } },
      });
    });

    await prisma.deviceStatusHistory.create({
      data: {
        deviceId: device.id, status, note, changedByEmployeeId: req.user.sub,
        ...(changedAt ? { changedAt: new Date(changedAt) } : {}),
      },
    });

    await creditDealerIfDelivered(device);

    await sendStatusWhatsapp(device, device.customer, status);

    res.json(device);
  } catch (e) {
    next(e);
  }
});

// POST /api/devices/:id/notes — durumu değiştirmeden serbest metin not ekler
router.post('/:id/notes', async (req, res, next) => {
  try {
    const { note } = z.object({ note: z.string().min(1) }).parse(req.body);
    const device = await prisma.device.findUniqueOrThrow({ where: { id: req.params.id } });
    const entry = await prisma.deviceStatusHistory.create({
      data: { deviceId: device.id, status: device.status, note, changedByEmployeeId: req.user.sub },
      include: { changedByEmployee: true },
    });
    res.status(201).json(entry);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/devices/:id/assign — personel devri
router.patch('/:id/assign', async (req, res, next) => {
  try {
    const { employeeId } = z.object({ employeeId: z.string().uuid() }).parse(req.body);
    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: { assignedEmployeeId: employeeId },
    });
    res.json(device);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/devices/:id/dealer — kaydı başka bir bayinin hesabına aktar (veya bayiden çıkar)
router.patch('/:id/dealer', async (req, res, next) => {
  try {
    const { dealerId } = z.object({ dealerId: z.string().uuid().nullable() }).parse(req.body);
    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: { dealerId },
      include: { customer: true, dealer: true },
    });
    await creditDealerIfDelivered(device);
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
      cost: z.number().nonnegative().default(0),
      vatMode: z.enum(['DAHIL', 'HARIC']).default('DAHIL'),
      warrantyMonths: z.number().int().nonnegative().default(0),
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
      method: z.string().min(1),
      type: z.enum(['KAPORA', 'ARA_ODEME', 'FINAL']).default('ARA_ODEME'),
    });
    const input = schema.parse(req.body);
    const payment = await prisma.payment.create({ data: { deviceId: req.params.id, ...input } });
    res.status(201).json(payment);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/payments/:paymentId', async (req, res, next) => {
  try {
    await prisma.payment.delete({ where: { id: req.params.paymentId } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.device.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
