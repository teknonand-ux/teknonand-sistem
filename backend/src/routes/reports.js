const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireEmployee);

function dateRange(req) {
  const { from, to } = req.query;
  const range = {};
  if (from) range.gte = new Date(from);
  if (to) range.lte = new Date(to);
  return Object.keys(range).length ? range : undefined;
}

// Kasa ve Kâr/Zarar uç noktaları yönetici-özel — kısıtlı personel bu finansal verileri göremez
router.use('/cashbox', requireAdmin);
router.use('/profit', requireAdmin);

// GET /api/reports/cashbox — gelir (ödemeler) + gider dökümü
router.get('/cashbox', async (req, res, next) => {
  try {
    const createdAt = dateRange(req);
    const [payments, expenses] = await Promise.all([
      prisma.payment.findMany({ where: createdAt ? { paidAt: createdAt } : undefined, include: { device: { select: { trackingCode: true, model: true } } }, orderBy: { paidAt: 'desc' } }),
      prisma.expense.findMany({ where: createdAt ? { createdAt } : undefined, orderBy: { createdAt: 'desc' } }),
    ]);
    const totalIncome = payments.reduce((s, p) => s + Number(p.amount), 0);
    const totalExpense = expenses.reduce((s, e) => s + Number(e.amount), 0);
    res.json({ payments, expenses, totalIncome, totalExpense, net: totalIncome - totalExpense });
  } catch (e) {
    next(e);
  }
});

router.post('/cashbox/expense', async (req, res, next) => {
  try {
    const schema = z.object({
      category: z.string().min(1),
      supplierId: z.string().uuid().optional().nullable(),
      amount: z.number().positive(),
      method: z.string().min(1),
      description: z.string().optional(),
    });
    const data = schema.parse(req.body);
    const expense = await prisma.$transaction(async (tx) => {
      const created = await tx.expense.create({ data, include: { supplier: true } });
      if (data.category === 'Toptancı Ödemesi' && data.supplierId) {
        await tx.supplier.update({ where: { id: data.supplierId }, data: { currentBalance: { decrement: data.amount } } });
        await tx.supplierTransaction.create({
          data: { supplierId: data.supplierId, type: 'ODEME', amount: data.amount, description: data.description },
        });
      }
      return created;
    });
    res.status(201).json(expense);
  } catch (e) {
    next(e);
  }
});

router.delete('/cashbox/expense/:id', async (req, res, next) => {
  try {
    await prisma.expense.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// GET /api/reports/cashbox/resets — geçmiş kasa sıfırlama kayıtları (en yeni önce)
router.get('/cashbox/resets', async (req, res, next) => {
  try {
    const resets = await prisma.cashboxReset.findMany({
      orderBy: { periodEnd: 'desc' },
      include: { employee: { select: { name: true } } },
    });
    res.json(resets);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/reports/cashbox/reset/:id — bir sıfırlama kaydını geri alır (arşiv
// kaydı silinir, ödeme/gider verisi zaten hiç silinmemişti). Silinen kayıt en son
// sıfırlamaysa Kasa ekranı otomatik olarak bir önceki sıfırlamanın (varsa) veya
// dönem başının gösterdiği duruma geri döner — çünkü ekran her zaman kalan
// kayıtlar arasındaki en yeni periodEnd'i baz alır.
router.delete('/cashbox/reset/:id', async (req, res, next) => {
  try {
    await prisma.cashboxReset.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// POST /api/reports/cashbox/reset — kapanan dönemin özetini arşivler; ödeme/gider
// kayıtları silinmez, Kasa ekranı bundan sonra yalnızca periodEnd'den sonrasını gösterir.
// Dönem toplamları (gelir/gider/net) panel tarafında hesaplanıp gönderilir — Kasa
// ekranındaki gelir toplamı bayi tahsilatlarını da içerdiği için (bkz. allPayments())
// burada yeniden hesaplamak yerine gönderileni arşivliyoruz.
router.post('/cashbox/reset', async (req, res, next) => {
  try {
    const schema = z.object({
      periodStart: z.coerce.date(),
      totalIncome: z.number(),
      totalExpense: z.number(),
      net: z.number(),
      note: z.string().optional(),
    });
    const data = schema.parse(req.body);
    const reset = await prisma.cashboxReset.create({
      data: { ...data, employeeId: req.user.sub },
      include: { employee: { select: { name: true } } },
    });
    res.status(201).json(reset);
  } catch (e) {
    next(e);
  }
});

// GET /api/reports/profit — personel bazında tahsilat + cihaz bazında kâr
router.get('/profit', async (req, res, next) => {
  try {
    const devices = await prisma.device.findMany({
      include: { payments: true, parts: true, assignedEmployee: true },
    });

    const deviceProfit = devices.map((d) => {
      const income = d.payments.reduce((s, p) => s + Number(p.amount), 0);
      const partsCost = d.parts.reduce((s, p) => s + Number(p.cost), 0);
      return { code: d.trackingCode, model: d.model, income, partsCost, profit: income - partsCost, employee: d.assignedEmployee?.name ?? '—' };
    });

    const byEmployee = {};
    for (const d of deviceProfit) {
      byEmployee[d.employee] ??= { employee: d.employee, deviceCount: 0, income: 0 };
      byEmployee[d.employee].deviceCount += 1;
      byEmployee[d.employee].income += d.income;
    }

    res.json({
      totalIncome: deviceProfit.reduce((s, d) => s + d.income, 0),
      totalPartsCost: deviceProfit.reduce((s, d) => s + d.partsCost, 0),
      totalProfit: deviceProfit.reduce((s, d) => s + d.profit, 0),
      byEmployee: Object.values(byEmployee),
      byDevice: deviceProfit,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
