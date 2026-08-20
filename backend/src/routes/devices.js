const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee, requireAdmin } = require('../middleware/auth');
const { sendStatusWhatsapp, sendDocumentWhatsapp } = require('../services/whatsapp');
const { buildDeliveryFormPdfBuffer } = require('../services/pdfGenerator');

const router = express.Router();
router.use(requireAuth, requireEmployee);

// Görsel alanları yalnızca base64 data URL kabul eder — serbest metin izin verilirse
// bu değerler daha sonra <img src="..."> olarak basılan sayfalarda saklı XSS'e yol açabilir.
const dataUrlImage = z
  .string()
  .max(4_000_000)
  .regex(/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*$/, 'Geçersiz görsel formatı');

// Fatura PDF'i — yalnızca base64 data URL kabul eder (aynı XSS/istismar gerekçesiyle
// görsel alanlarında olduğu gibi), en fazla ~5MB.
const dataUrlPdf = z
  .string()
  .max(7_000_000)
  .regex(/^data:application\/pdf;base64,[A-Za-z0-9+/]+=*$/, 'Geçersiz PDF formatı');

// Bayiye ait bir cihazın parça/işlem tutarını bayinin veresiye hesabına ekler
// (bir cihaz için yalnızca bir kez) — cihaz Teslime Hazır (READY) durumuna
// geldiği anda işlenir; bir cihaz READY'yi atlayıp doğrudan SHIPPED/DELIVERED
// olursa (ör. hızlı teslim, kargo) orada da devreye girer. SHIPPED (kargoya
// verildi) fiilen teslim sayıldığı için DELIVERED ile aynı muameleyi görür.
// Zaten SHIPPED/DELIVERED/READY olan bir cihaz sonradan bir bayiye
// atandığında (ör. Müşteri Bilgilerini Düzenle'den) da çağrılır.
async function creditDealerIfDelivered(device) {
  if (!['READY', 'SHIPPED', 'DELIVERED'].includes(device.status) || !device.dealerId) return;
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

// Not: cihaz sayisi (count) ile en yuksek kullanilan takip numarasi ayni sey
// degil -- eski sistemden aktarilan kayitlarda numaralar satir sayisiyla
// orantili degil (aralarda bosluklar var). Bu yuzden count() yerine o ana
// kadar kullanilmis en yuksek numarayi bulup bir arttiriyoruz.
async function nextTrackingCode() {
  const year = new Date().getFullYear();
  const result = await prisma.$queryRaw`SELECT MAX(SUBSTRING("trackingCode" FROM '[0-9]+$')::int) AS maxnum FROM devices`;
  const maxNum = Number(result[0]?.maxnum) || 0;
  return `TKN-${year}-${String(maxNum + 1).padStart(4, '0')}`;
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
  intakeImages: z.array(dataUrlImage).max(4).optional(),
  issueDescription: z.string().min(1),
  receivedAt: z.string().datetime().optional(),
  sendWhatsapp: z.boolean().optional(), // panelde personelin onayı — bkz. yonetici-paneli.html createDevice
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
        customer: true, dealer: true, assignedEmployee: true,
        parts: { include: { supplier: true, addedByEmployee: true } },
        payments: true,
        statusHistory: { orderBy: { changedAt: 'desc' }, include: { changedByEmployee: true } },
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
        parts: { include: { supplier: true, addedByEmployee: true } },
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

  // nextTrackingCode() cihaz sayisina bakarak kod uretiyor; iki kayit neredeyse
  // ayni anda gelirse (ör. cift tiklama) ayni kodu uretebilir ve ikincisi
  // trackingCode'un @unique kisitina takilir (P2002) -- bu durumda kodu
  // yeniden uretip tekrar deniyoruz.
  let device;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const trackingCode = await nextTrackingCode();
    try {
      device = await prisma.device.create({
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
          intakeImages: input.intakeImages || [],
          issueDescription: input.issueDescription,
          receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
          status: 'RECEIVED',
        },
        include: { customer: true },
      });
      break;
    } catch (e) {
      if (e.code === 'P2002' && attempt < 5) continue;
      throw e;
    }
  }

  await prisma.deviceStatusHistory.create({
    data: { deviceId: device.id, status: 'RECEIVED', changedByEmployeeId: employeeId, note: 'Cihaz kabul edildi' },
  });

  if (input.sendWhatsapp !== false) {
    await sendStatusWhatsapp(device, customerRecord, 'RECEIVED');
  }
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

const DEVICE_STATUS_VALUES = [
  'RECEIVED', 'DIAGNOSING', 'DIAGNOSIS_DONE', 'AWAITING_PARTS', 'APPROVED',
  'IN_REPAIR', 'TESTING', 'READY', 'SHIPPED', 'DELIVERED', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED',
];

const bulkImportRowSchema = z.object({
  // Verilirse ve mevcut bir cihazla eşleşirse GÜNCELLER; yoksa (veya eşleşmezse) bu
  // kodla YENİ bir cihaz oluşturur — boşsa otomatik takip kodu üretilir. Bu sayede
  // "Dışa Aktar" ile alınan dosya düzenlenip "İçe Aktar" ile geri yüklendiğinde
  // mevcut kayıtlar güncellenir, silinip yeniden oluşturulmaz.
  trackingCode: z.string().optional(),
  customerName: z.string().min(1),
  customerPhone: z.string().min(1),
  backupPhone: z.string().optional(),
  model: z.string().min(1),
  imeiSerial: z.string().optional(),
  devicePassword: z.string().optional(),
  issueDescription: z.string().optional(),
  receivedAt: z.string().datetime().optional(),
  status: z.enum(DEVICE_STATUS_VALUES).optional(),
  parts: z.array(z.object({ name: z.string().min(1), price: z.number(), cost: z.number().optional() })).optional(),
});

// POST /api/devices/bulk-import — Cihazlar sayfasındaki "İçe Aktar" ile kullanılır.
// Panel bunu büyük dosyalarda ~300 satırlık parçalar halinde çağırır. Hiçbir zaman
// WhatsApp göndermez (toplu/tarihsel veri; müşteriye bildirim gitmesi istenmez).
router.post('/bulk-import', async (req, res, next) => {
  try {
    const { rows } = z.object({ rows: z.array(bulkImportRowSchema).min(1).max(500) }).parse(req.body);
    let created = 0, updated = 0;
    const errors = [];

    for (const row of rows) {
      try {
        await prisma.$transaction(async (tx) => {
          let customer = await tx.customer.findFirst({ where: { phone: row.customerPhone } });
          customer = customer
            ? await tx.customer.update({
                where: { id: customer.id },
                data: { fullName: row.customerName, backupPhone: row.backupPhone || customer.backupPhone },
              })
            : await tx.customer.create({
                data: { fullName: row.customerName, phone: row.customerPhone, backupPhone: row.backupPhone },
              });

          const existing = row.trackingCode
            ? await tx.device.findUnique({ where: { trackingCode: row.trackingCode } })
            : null;

          const deviceData = {
            customerId: customer.id,
            model: row.model,
            imeiSerial: row.imeiSerial || null,
            devicePassword: row.devicePassword || null,
            deviceOff: !row.imeiSerial,
            issueDescription: row.issueDescription || 'Belirtilmedi',
            ...(row.receivedAt ? { receivedAt: new Date(row.receivedAt) } : {}),
            ...(row.status ? { status: row.status } : {}),
          };

          let device;
          if (existing) {
            device = await tx.device.update({ where: { id: existing.id }, data: deviceData });
            if (row.status && row.status !== existing.status) {
              await tx.deviceStatusHistory.create({
                data: { deviceId: device.id, status: row.status, note: 'İçe aktarımla güncellendi' },
              });
            }
          } else {
            device = await tx.device.create({
              data: {
                ...deviceData,
                trackingCode: row.trackingCode || await nextTrackingCode(),
                status: row.status || 'RECEIVED',
              },
            });
            await tx.deviceStatusHistory.create({
              data: { deviceId: device.id, status: device.status, note: 'İçe aktarımla oluşturuldu' },
            });
          }

          if (row.parts) {
            await tx.devicePart.deleteMany({ where: { deviceId: device.id } });
            for (const p of row.parts) {
              await tx.devicePart.create({
                data: { deviceId: device.id, name: p.name, price: p.price, cost: p.cost || 0 },
              });
            }
          }

          if (existing) updated++; else created++;
        });
      } catch (e) {
        errors.push({ trackingCode: row.trackingCode || null, customerName: row.customerName, error: e.message });
      }
    }

    res.json({ created, updated, errors });
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
        'IN_REPAIR', 'TESTING', 'READY', 'SHIPPED', 'DELIVERED', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED',
      ]),
      note: z.string().optional(),
      changedAt: z.string().datetime().optional(),
      diagnosingImages: z.array(dataUrlImage).max(4).optional(),
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
      readyImages: z.array(dataUrlImage).max(4).optional(),
      deliveryMethod: z.string().optional(),
      deliveryNote: z.string().optional(),
      deliveryImages: z.array(dataUrlImage).max(4).optional(),
      cargoTrackingNumber: z.string().optional(), // durum SHIPPED'e geçerken girilen Yurtiçi Kargo takip numarası
      imeiSerial: z.string().optional(), // cihaz kapalı kabul edilmişse teslimde girilir
      sendWhatsapp: z.boolean().optional(), // panelde personelin onayı — bkz. aşağıdaki kullanım
    });
    const { status, note, changedAt, imeiSerial, diagnosisItems, sendWhatsapp, ...fields } = schema.parse(req.body);

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

    // Panel personeli her durum değişikliğinde WhatsApp gönderimini onaylar/reddeder
    // (bkz. yonetici-paneli.html addStatusEntry) — açıkça false gelmediği sürece
    // (ör. bu alanı göndermeyen eski/harici çağıranlar için) gönderim yapılır.
    if (sendWhatsapp !== false) {
      await sendStatusWhatsapp(device, device.customer, status);
    }

    res.json(device);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/devices/:id/details — durum/geçmiş etkilenmeden cihaza özel bilgileri
// (şifre, IMEI, kargo adresi vb.) düzenler — bkz. yonetici-paneli.html "Müşteri
// Bilgilerini Düzenle" kutusu (saveCustomerEdit).
router.patch('/:id/details', async (req, res, next) => {
  try {
    const schema = z.object({
      backupPhone: z.string().optional(),
      imeiSerial: z.string().optional(),
      devicePassword: z.string().optional(),
      issueDescription: z.string().min(1).optional(),
      isCargo: z.boolean().optional(),
      cargoAddress: z.string().optional(),
    });
    const data = schema.parse(req.body);
    const device = await prisma.device.update({
      where: { id: req.params.id },
      data,
      include: { customer: true, diagnosisItems: { orderBy: { createdAt: 'asc' } } },
    });
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

// POST /api/devices/:id/invoice — ödeme sonrası fatura PDF'i ekler/değiştirir
router.post('/:id/invoice', async (req, res, next) => {
  try {
    const { invoicePdf } = z.object({ invoicePdf: dataUrlPdf }).parse(req.body);
    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: { invoicePdf, invoiceUploadedAt: new Date() },
    });
    await prisma.deviceStatusHistory.create({
      data: { deviceId: device.id, status: device.status, note: 'Fatura (PDF) yüklendi', changedByEmployeeId: req.user.sub },
    });
    res.json(device);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/devices/:id/invoice — yüklenen fatura PDF'ini kaldırır
router.delete('/:id/invoice', async (req, res, next) => {
  try {
    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: { invoicePdf: null, invoiceUploadedAt: null },
    });
    res.json(device);
  } catch (e) {
    next(e);
  }
});

// POST /api/devices/:id/send-invoice-whatsapp — yüklü fatura PDF'ini WhatsApp'tan
// belge olarak gönderir. Yalnızca panelde bu butona basıldığında tetiklenir,
// otomatik durum bildirimlerinden bağımsızdır.
router.post('/:id/send-invoice-whatsapp', async (req, res, next) => {
  try {
    const device = await prisma.device.findUnique({
      where: { id: req.params.id },
      include: { customer: true },
    });
    if (!device) return res.status(404).json({ error: 'Cihaz bulunamadı' });
    if (!device.invoicePdf) return res.status(400).json({ error: 'Yüklenmiş bir fatura yok' });

    const base64 = device.invoicePdf.split(',')[1];
    const pdfBuffer = Buffer.from(base64, 'base64');
    const filename = `Fatura-${device.trackingCode}.pdf`;

    const message = await sendDocumentWhatsapp({
      device,
      customer: device.customer,
      pdfBuffer,
      filename,
      templateEnvKey: 'WHATSAPP_TEMPLATE_INVOICE',
      bodyParams: [device.customer.fullName, device.model],
      templateType: 'INVOICE',
    });
    res.json(message);
  } catch (e) {
    next(e);
  }
});

// POST /api/devices/:id/send-delivery-form-whatsapp — cihaz teslim formunu PDF
// olarak üretip WhatsApp'tan belge olarak gönderir. Yalnızca panelde bu butona
// basıldığında tetiklenir, otomatik durum bildirimlerinden bağımsızdır.
// SHIPPED (kargoya verildi) fiilen teslim sayıldığı için DELIVERED ile birlikte kabul edilir.
router.post('/:id/send-delivery-form-whatsapp', async (req, res, next) => {
  try {
    const device = await prisma.device.findUnique({
      where: { id: req.params.id },
      include: { customer: true, parts: true, payments: true, statusHistory: true },
    });
    if (!device) return res.status(404).json({ error: 'Cihaz bulunamadı' });
    if (!['SHIPPED', 'DELIVERED'].includes(device.status)) return res.status(400).json({ error: 'Cihaz henüz teslim edilmedi' });

    const [companyInfoSetting, companyLogoSetting] = await Promise.all([
      prisma.appSetting.findUnique({ where: { key: 'companyInfo' } }),
      prisma.appSetting.findUnique({ where: { key: 'companyLogo' } }),
    ]);
    const companyInfo = companyInfoSetting?.value || {};
    const companyLogo = companyLogoSetting?.value || null;

    const pdfBuffer = await buildDeliveryFormPdfBuffer(device, companyInfo, companyLogo);
    const filename = `Teslim-Formu-${device.trackingCode}.pdf`;

    const message = await sendDocumentWhatsapp({
      device,
      customer: device.customer,
      pdfBuffer,
      filename,
      templateEnvKey: 'WHATSAPP_TEMPLATE_DELIVERY_FORM',
      bodyParams: [device.customer.fullName, device.model],
      templateType: 'DELIVERY_FORM',
    });
    res.json(message);
  } catch (e) {
    next(e);
  }
});

// POST /api/devices/:id/mark-approval-seen — yönetici paneli cihazı açtığında çağrılır;
// müşteri/bayinin arıza onayı/reddi ya da iade isteği sonrası "Cihazlar" başlığının
// yanındaki bildirim rozetini bu cihaz için kapatır (bkz. approvalSeenByStaff).
router.post('/:id/mark-approval-seen', async (req, res, next) => {
  try {
    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: { approvalSeenByStaff: true },
    });
    res.json({ id: device.id, approvalSeenByStaff: device.approvalSeenByStaff });
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
      costUsd: z.number().nonnegative().optional(),
      vatMode: z.enum(['DAHIL', 'HARIC']).default('DAHIL'),
      warrantyMonths: z.number().int().nonnegative().default(0),
      supplierId: z.string().uuid().optional().nullable(),
      supplierCostCurrency: z.enum(['TRY', 'USD']).optional(),
    });
    const { supplierCostCurrency, ...input } = schema.parse(req.body);

    const part = await prisma.$transaction(async (tx) => {
      const created = await tx.devicePart.create({
        data: { deviceId: req.params.id, ...input, addedByEmployeeId: req.user.sub },
        include: { supplier: true, addedByEmployee: true },
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
      // Toptancı seçildiyse, girilen maliyet (girilen para birimi neyse o
      // hesaba — TL veya USD) o toptancının cari hesabına borç olarak işlenir.
      if (input.supplierId) {
        const currency = supplierCostCurrency === 'USD' ? 'USD' : 'TRY';
        const amount = currency === 'USD' ? Number(input.costUsd) : Number(input.cost);
        if (amount > 0) {
          const balanceField = currency === 'USD' ? 'currentBalanceUsd' : 'currentBalance';
          await tx.supplier.update({
            where: { id: input.supplierId },
            data: { [balanceField]: { increment: amount } },
          });
          await tx.supplierTransaction.create({
            data: { supplierId: input.supplierId, type: 'ALIM', currency, amount, description: input.name },
          });
        }
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
