const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireEmployee);

const customerSchema = z.object({
  fullName: z.string().min(1),
  phone: z.string().min(1),
  backupPhone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
});

// GET /api/customers?query=  — verilmezse Müşteriler sayfası için TÜM kayıtları
// döner (bkz. /devices — bu uygulamada listeler client-side filtrelenir);
// verilirse Cihaz Kabul ekranındaki canlı isim/telefon araması içindir (en fazla 8 sonuç).
router.get('/', async (req, res, next) => {
  try {
    const query = (req.query.query || '').toString().trim();
    const where = query
      ? {
          OR: [
            { fullName: { contains: query, mode: 'insensitive' } },
            { phone: { contains: query.replace(/\s|-/g, '') } },
          ],
        }
      : {};
    const customers = await prisma.customer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...(query ? { take: 8 } : {}),
      include: { _count: { select: { devices: true } } },
    });
    res.json(customers);
  } catch (e) {
    next(e);
  }
});

// POST /api/customers  — upsert (telefon numarasına göre eşleşen varsa günceller)
router.post('/', async (req, res, next) => {
  try {
    const data = customerSchema.parse(req.body);
    const existing = await prisma.customer.findFirst({ where: { phone: data.phone } });
    const customer = existing
      ? await prisma.customer.update({ where: { id: existing.id }, data })
      : await prisma.customer.create({ data });
    res.status(existing ? 200 : 201).json(customer);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/customers/:id — mevcut müşteri kaydını ID ile günceller (telefon
// değişse bile POST'taki gibi yeni/farklı bir kayıt oluşturmaz veya başka bir
// müşteriyle birleşmez — cihaz detayından "Müşteri Bilgilerini Düzenle" için)
router.patch('/:id', async (req, res, next) => {
  try {
    const data = customerSchema.partial().parse(req.body);
    const customer = await prisma.customer.update({ where: { id: req.params.id }, data });
    res.json(customer);
  } catch (e) {
    next(e);
  }
});

const normPhone = (p) => (p || '').replace(/\s|-/g, '');
const normName = (n) => (n || '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('tr-TR');
// Eski/toplu aktarilan kayitlarda telefon alaninda gercek numara yerine "belirtilmedi",
// "Numara Yok #123" gibi yer tutucular ya da bos deger bulunabiliyor. Gercek telefonu
// olanlar telefon+isimle eslestirilir (guvenli); telefonu olmayanlar sadece isimle
// eslestirilir (cogunlukla bayi/dukkan proxy kayitlari -- ayni isim tekrar tekrar
// aktarilmis). Isim de bossa asla eslestirilmez -- yoksa tum isimsiz kayitlar
// birbirinden tamamen farkli kisiler olsa da tek grupta toplanip yanlislikla birlesir.
const isRealPhone = (p) => /^0?5\d{9}$/.test(normPhone(p));

// POST /api/customers/merge-duplicates — aynı isim soyisim VE (gerçek telefonu varsa)
// aynı telefon numarasına sahip müşteri kayıtlarını (biçim farkları — boşluk/tire,
// büyük/küçük harf — yok sayılarak) tek kayda birleştirir: en çok cihazı olan kayıt
// hayatta kalır (eşitlikte en eski kayıt), diğerlerinin cihazları ve WhatsApp/Instagram
// sohbetleri ona aktarılıp kopya kayıtlar silinir. Cihaz/işlem geçmişi kaybolmaz.
router.post('/merge-duplicates', requireAdmin, async (req, res, next) => {
  try {
    const all = await prisma.customer.findMany({ include: { _count: { select: { devices: true } } } });
    const groups = new Map();
    for (const c of all) {
      const name = normName(c.fullName);
      if (!name) continue;
      const key = isRealPhone(c.phone) ? `phone:${normPhone(c.phone)}|${name}` : `name:${name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    let mergedGroups = 0;
    let mergedCustomers = 0;
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => b._count.devices - a._count.devices || new Date(a.createdAt) - new Date(b.createdAt));
      const [survivor, ...duplicates] = list;
      const backupPhone = survivor.backupPhone || duplicates.map((d) => d.backupPhone).find(Boolean);
      const email = survivor.email || duplicates.map((d) => d.email).find(Boolean);

      await prisma.$transaction(async (tx) => {
        for (const dup of duplicates) {
          await tx.device.updateMany({ where: { customerId: dup.id }, data: { customerId: survivor.id } });
          await tx.whatsappConversation.updateMany({ where: { customerId: dup.id }, data: { customerId: survivor.id } });
          await tx.instagramConversation.updateMany({ where: { customerId: dup.id }, data: { customerId: survivor.id } });
          await tx.customer.delete({ where: { id: dup.id } });
        }
        if (backupPhone !== survivor.backupPhone || email !== survivor.email) {
          await tx.customer.update({ where: { id: survivor.id }, data: { backupPhone, email } });
        }
      });
      mergedGroups++;
      mergedCustomers += duplicates.length;
    }

    res.json({ mergedGroups, mergedCustomers });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.customer.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
