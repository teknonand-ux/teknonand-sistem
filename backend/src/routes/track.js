const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { sendStatusWhatsapp } = require('../services/whatsapp');

const router = express.Router();

// Takip kodu tahmin/deneme saldırılarına karşı — dakikada 20 sorgu
const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
router.use(publicLimiter);

// Takip kodları sıralı/tahmin edilebilir (TKN-YYYY-0300, 0301, ...), bu yüzden bu uç
// herkese açık ve kimlik doğrulamasız. Prisma'nın varsayılan (select'siz) davranışı TÜM
// alanları döndürür — cihaz şifresi, yedek telefon, IMEI, iç notlar gibi hassas alanları
// da içerir. Bunu önlemek için takip portalının gerçekten ihtiyaç duyduğu alanlarla
// sınırlı bir allowlist kullanıyoruz.
const PUBLIC_DEVICE_SELECT = {
  id: true,
  trackingCode: true,
  brand: true,
  model: true,
  status: true,
  diagnosisText: true,
  estimatedPrice: true,
  diagnosingImages: true,
  diagnosisImages: true,
  diagnosisItems: { select: { id: true, description: true, price: true, approved: true, respondNote: true } },
  customerApproved: true,
  invoicePdf: true,
  invoiceUploadedAt: true,
  returnImages: true,
  readyImages: true,
  deliveryImages: true,
  deliveryMethod: true,
  cargoTrackingNumber: true,
  receivedAt: true,
  createdAt: true,
  customer: { select: { fullName: true } },
  parts: { select: { id: true, name: true, price: true, vatMode: true, warrantyMonths: true } },
  payments: { select: { id: true, amount: true, paidAt: true } },
};

// Takip kodları sıralı olduğu için tek başına yeterli bir "sır" değil — bu yüzden takip
// kodunun yanında müşteri telefonunun son 4 hanesini de doğruluyoruz. Kod var ama telefon
// yanlışsa da "bulunamadı" ile aynı 404'ü döndürüyoruz (notFoundOrMismatch), aksi halde
// yanıt "kod var ama telefon yanlış" / "kod hiç yok" diye ayrışır ve bu da tek başına kod
// enumerasyonuna izin verir.
const phoneSuffixSchema = z
  .string()
  .regex(/^\d{4}$/, 'Telefon numaranızın son 4 hanesini girin');

function phoneEndsWithSuffix(phone, suffix) {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 && digits.endsWith(suffix);
}

async function findDeviceByCodeAndPhone(code, phoneSuffix) {
  const device = await prisma.device.findUnique({
    where: { trackingCode: code },
    select: { id: true, backupPhone: true, customer: { select: { phone: true, backupPhone: true } } },
  });
  if (!device) return null;
  const matches =
    phoneEndsWithSuffix(device.customer.phone, phoneSuffix) ||
    phoneEndsWithSuffix(device.customer.backupPhone, phoneSuffix) ||
    phoneEndsWithSuffix(device.backupPhone, phoneSuffix);
  return matches ? device.id : null;
}

// GET /api/track/:code?phone=1234 — herkese açık (takip-portali.html)
router.get('/:code', async (req, res, next) => {
  try {
    const phoneSuffix = phoneSuffixSchema.parse(req.query.phone);
    const code = req.params.code.toUpperCase();
    const notFoundOrMismatch = () =>
      res.status(404).json({ error: 'Bu koda ait bir kayıt bulunamadı veya telefon numarası eşleşmiyor' });

    const deviceId = await findDeviceByCodeAndPhone(code, phoneSuffix);
    if (!deviceId) return notFoundOrMismatch();

    const device = await prisma.device.findUnique({ where: { id: deviceId }, select: PUBLIC_DEVICE_SELECT });
    res.json(device);
  } catch (e) {
    next(e);
  }
});

// POST /api/track/:code/approve — müşteri fiyat onayı
router.post('/:code/approve', async (req, res, next) => {
  try {
    const { note, phone } = z
      .object({ note: z.string().max(500).optional(), phone: phoneSuffixSchema })
      .parse(req.body);
    const code = req.params.code.toUpperCase();
    const notFoundOrMismatch = () =>
      res.status(404).json({ error: 'Bu koda ait bir kayıt bulunamadı veya telefon numarası eşleşmiyor' });

    const deviceId = await findDeviceByCodeAndPhone(code, phone);
    if (!deviceId) return notFoundOrMismatch();
    const device = await prisma.device.findUnique({ where: { id: deviceId }, include: { customer: true } });

    const updated = await prisma.device.update({
      where: { id: device.id },
      data: { customerApproved: true, status: 'APPROVED', approvalNote: note, approvedAt: new Date(), approvalSeenByStaff: false },
      select: PUBLIC_DEVICE_SELECT,
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

// POST /api/track/:code/request-return — müşteri onarımı reddedip cihazın iadesini ister
router.post('/:code/request-return', async (req, res, next) => {
  try {
    const { note, phone } = z
      .object({ note: z.string().max(500).optional(), phone: phoneSuffixSchema })
      .parse(req.body);
    const code = req.params.code.toUpperCase();
    const notFoundOrMismatch = () =>
      res.status(404).json({ error: 'Bu koda ait bir kayıt bulunamadı veya telefon numarası eşleşmiyor' });

    const deviceId = await findDeviceByCodeAndPhone(code, phone);
    if (!deviceId) return notFoundOrMismatch();
    const device = await prisma.device.findUnique({ where: { id: deviceId } });

    const updated = await prisma.device.update({
      where: { id: device.id },
      data: {
        status: 'RETURN_REQUESTED',
        returnReason: note || 'Müşteri onarımı onaylamayıp cihazın iadesini istedi',
        approvalSeenByStaff: false,
      },
      select: PUBLIC_DEVICE_SELECT,
    });
    await prisma.deviceStatusHistory.create({
      data: {
        deviceId: device.id,
        status: 'RETURN_REQUESTED',
        note: note ? `Müşteri iade istedi — Not: ${note}` : 'Müşteri iade istedi',
      },
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

// Tüm arıza kalemleri yanıtlandığında (her biri onaylandı ya da reddedildi), cihazı
// otomatik olarak APPROVED (en az bir kalem onaylandıysa) ya da RETURN_REQUESTED
// (hiçbiri onaylanmadıysa) durumuna geçirir. Hem takip portalı hem bayi portalı
// tarafından kullanılan ortak mantık.
async function advanceStatusIfAllItemsResponded(deviceId, respondedByLabel, sendWhatsapp) {
  const [device, items] = await Promise.all([
    prisma.device.findUnique({ where: { id: deviceId }, select: { status: true } }),
    prisma.diagnosisItem.findMany({ where: { deviceId } }),
  ]);
  if (!items.length || items.some((it) => it.approved === null)) return null;

  const anyApproved = items.some((it) => it.approved === true);
  const newStatus = anyApproved ? 'APPROVED' : 'RETURN_REQUESTED';
  // Müşteri daha önce verdiği bir kararı düzeltip aynı sonuca (ör. yine APPROVED)
  // varmışsa tekrar geçmiş kaydı/bildirim oluşturmuyoruz.
  if (device?.status === newStatus) return null;
  const data = anyApproved
    ? { status: 'APPROVED', approvedAt: new Date(), approvalSeenByStaff: false }
    : { status: 'RETURN_REQUESTED', returnReason: `${respondedByLabel} tüm arızaları reddetti, cihazın iadesini istedi`, approvalSeenByStaff: false };

  const updated = await prisma.device.update({
    where: { id: deviceId },
    data,
    include: { customer: true },
  });
  await prisma.deviceStatusHistory.create({
    data: {
      deviceId,
      status: newStatus,
      note: anyApproved
        ? `${respondedByLabel} tüm arıza kalemlerini yanıtladı, en az biri onaylandı`
        : `${respondedByLabel} tüm arıza kalemlerini reddetti`,
    },
  });
  if (sendWhatsapp) await sendStatusWhatsapp(updated, updated.customer, newStatus);
  return updated;
}

// Cihaz bu durumlardayken müşteri henüz fiilen işleme alınmamış demektir — arıza
// kalemi yanıtı burada serbestçe verilip yanlışlıkla basılırsa düzeltilebilir.
// Personel durumu IN_REPAIR ve sonrasına taşıdıktan sonra düzeltme kapanır.
const DIAGNOSIS_RESPONSE_EDITABLE_STATUSES = ['DIAGNOSIS_DONE', 'APPROVED', 'RETURN_REQUESTED'];

// POST /api/track/:code/diagnosis-items/:itemId/respond — müşteri, tek bir arıza
// kalemini onaylar ya da reddeder ("yapılmasın"); daha önce yanıtladığı bir kalemi
// de (cihaz henüz işleme alınmadıysa) aynı uçtan tekrar çağırarak düzeltebilir.
router.post('/:code/diagnosis-items/:itemId/respond', async (req, res, next) => {
  try {
    const { approved, phone, note } = z
      .object({ approved: z.boolean(), phone: phoneSuffixSchema, note: z.string().max(300).optional() })
      .parse(req.body);
    const code = req.params.code.toUpperCase();
    const notFoundOrMismatch = () =>
      res.status(404).json({ error: 'Bu koda ait bir kayıt bulunamadı veya telefon numarası eşleşmiyor' });

    const deviceId = await findDeviceByCodeAndPhone(code, phone);
    if (!deviceId) return notFoundOrMismatch();

    const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { status: true } });
    if (!DIAGNOSIS_RESPONSE_EDITABLE_STATUSES.includes(device.status)) {
      return res.status(409).json({ error: 'Cihaz işleme alındığı için arıza kalemi yanıtı artık değiştirilemez' });
    }

    const item = await prisma.diagnosisItem.findFirst({ where: { id: req.params.itemId, deviceId } });
    if (!item) return res.status(404).json({ error: 'Arıza kalemi bulunamadı' });

    await prisma.diagnosisItem.update({
      where: { id: item.id },
      data: { approved, respondedBy: 'customer', respondedAt: new Date(), respondNote: note || null },
    });

    await advanceStatusIfAllItemsResponded(deviceId, 'Müşteri', true);

    const deviceOut = await prisma.device.findUnique({ where: { id: deviceId }, select: PUBLIC_DEVICE_SELECT });
    res.json(deviceOut);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
