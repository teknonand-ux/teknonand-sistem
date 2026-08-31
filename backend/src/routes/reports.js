const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee, requireAdmin } = require('../middleware/auth');
const { recordSupplierPayment, reverseSupplierTransaction } = require('../lib/supplierPayments');

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
    let expense;
    if (data.category === 'Toptancı Ödemesi' && data.supplierId) {
      // Toptancı bakiyesi ve karşı SupplierTransaction, paylaşılan mantıkla
      // (lib/supplierPayments.js) oluşturulur — silindiğinde de ikisi birden geri alınır.
      const created = await prisma.$transaction((tx) =>
        recordSupplierPayment(tx, {
          supplierId: data.supplierId,
          amount: data.amount,
          currency: 'TRY',
          method: data.method,
          description: data.description,
        })
      );
      expense = await prisma.expense.findUnique({ where: { id: created.expense.id }, include: { supplier: true } });
    } else {
      expense = await prisma.expense.create({ data, include: { supplier: true } });
    }
    res.status(201).json(expense);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/reports/cashbox/expense/:id — gideri siler; "Toptancı Ödemesi"
// giderleri bir SupplierTransaction'a bağlıysa (bkz. lib/supplierPayments.js)
// toptancı bakiyesi geri yüklenir ve bağlı hareket de silinir.
router.delete('/cashbox/expense/:id', async (req, res, next) => {
  try {
    const expense = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!expense) return res.status(404).json({ error: 'Gider bulunamadı' });
    if (expense.supplierTransactionId) {
      const supplierTx = await prisma.supplierTransaction.findUnique({ where: { id: expense.supplierTransactionId } });
      if (supplierTx) {
        await prisma.$transaction((tx) => reverseSupplierTransaction(tx, supplierTx));
        return res.status(204).end();
      }
    }
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

// GET /api/reports/profit/resets — geçmiş kâr/zarar sıfırlama kayıtları (en yeni önce)
router.get('/profit/resets', async (req, res, next) => {
  try {
    const resets = await prisma.profitReset.findMany({
      orderBy: { periodEnd: 'desc' },
      include: { employee: { select: { name: true } } },
    });
    res.json(resets);
  } catch (e) {
    next(e);
  }
});

// POST /api/reports/profit/reset — kapanan dönemin gelir/maliyet/net kâr özetini
// arşivler; ödeme/parça kayıtları silinmez. Toplamlar panel tarafında hesaplanıp
// gönderilir (bkz. cashbox/reset ile aynı desen).
router.post('/profit/reset', async (req, res, next) => {
  try {
    const schema = z.object({
      periodStart: z.coerce.date(),
      totalRevenue: z.number(),
      totalCost: z.number(),
      netProfit: z.number(),
      note: z.string().optional(),
    });
    const data = schema.parse(req.body);
    const reset = await prisma.profitReset.create({
      data: { ...data, employeeId: req.user.sub },
      include: { employee: { select: { name: true } } },
    });
    res.status(201).json(reset);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/reports/profit/reset/:id — bir sıfırlamayı geri alır (bkz. cashbox/reset ile aynı desen)
router.delete('/profit/reset/:id', async (req, res, next) => {
  try {
    await prisma.profitReset.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// Toptancı dönemi uçları — Toptancılar sayfası tüm personele açık olduğundan
// (yalnızca Kasa ve Kâr/Zarar yönetici-özel) bunlar da requireAdmin OLMADAN,
// dosyanın en üstündeki requireEmployee ile korunur.

// GET /api/reports/suppliers/resets — geçmiş toptancı dönemi sıfırlamaları (en yeni önce).
// ?supplierId= verilirse yalnızca o toptancının kendi sıfırlamaları döner; verilmezse
// yalnızca toplu (supplierId'siz) sıfırlamalar döner — "Toptancılar" ekranıyla aynı davranış.
router.get('/suppliers/resets', async (req, res, next) => {
  try {
    const { supplierId } = req.query;
    const resets = await prisma.supplierReset.findMany({
      where: { supplierId: supplierId || null },
      orderBy: { periodEnd: 'desc' },
      include: { employee: { select: { name: true } } },
    });
    res.json(resets);
  } catch (e) {
    next(e);
  }
});

// POST /api/reports/suppliers/reset — kapanan dönemin alım/ödeme özetini (₺ ve $
// ayrı) arşivler. supplierId BOŞSA (toplu "Toptancılar" ekranı) hiçbir bakiyeye
// dokunmaz. supplierId DOLUYSA (Toptancı Detay sayfası) o toptancının gerçek
// borç bakiyesini (₺ ve $) sıfırlama anındaki değeriyle arşivleyip 0'a çeker —
// bu değer DELETE'te ("Geri Al") bakiyeyi eski haline getirmek için kullanılır.
router.post('/suppliers/reset', async (req, res, next) => {
  try {
    const schema = z.object({
      supplierId: z.string().uuid().optional().nullable(),
      periodStart: z.coerce.date(),
      totalAlimTry: z.number(),
      totalOdemeTry: z.number(),
      totalAlimUsd: z.number(),
      totalOdemeUsd: z.number(),
      note: z.string().optional(),
    });
    const data = schema.parse(req.body);

    let reset;
    if (data.supplierId) {
      reset = await prisma.$transaction(async (tx) => {
        const supplier = await tx.supplier.findUnique({ where: { id: data.supplierId } });
        if (!supplier) throw Object.assign(new Error('Toptancı bulunamadı'), { status: 404 });
        const created = await tx.supplierReset.create({
          data: {
            ...data,
            employeeId: req.user.sub,
            balanceTryBefore: supplier.currentBalance,
            balanceUsdBefore: supplier.currentBalanceUsd,
          },
          include: { employee: { select: { name: true } } },
        });
        await tx.supplier.update({ where: { id: data.supplierId }, data: { currentBalance: 0, currentBalanceUsd: 0 } });
        return created;
      });
    } else {
      reset = await prisma.supplierReset.create({
        data: { ...data, employeeId: req.user.sub },
        include: { employee: { select: { name: true } } },
      });
    }
    res.status(201).json(reset);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/reports/suppliers/reset/:id — bir dönem sıfırlamasını geri alır.
// Bakiye sıfırlanmış bir toptancı sıfırlamasıysa VE bu, o toptancının EN SON
// sıfırlamasıysa, bakiye sıfırlama öncesindeki değerine geri yüklenir — aradan
// yeni alım/ödeme hareketi eklendiyse (yani bu artık en son sıfırlama değilse)
// eski bakiyeyi geri yazmak güncel hareketleri yok sayar, o yüzden o durumda
// yalnızca arşiv kaydı silinir, bakiyeye dokunulmaz.
router.delete('/suppliers/reset/:id', async (req, res, next) => {
  try {
    const reset = await prisma.supplierReset.findUnique({ where: { id: req.params.id } });
    if (!reset) return res.status(204).end();

    if (reset.supplierId && reset.balanceTryBefore !== null) {
      const latest = await prisma.supplierReset.findFirst({
        where: { supplierId: reset.supplierId },
        orderBy: { periodEnd: 'desc' },
      });
      if (latest && latest.id === reset.id) {
        await prisma.$transaction([
          prisma.supplier.update({
            where: { id: reset.supplierId },
            data: { currentBalance: reset.balanceTryBefore, currentBalanceUsd: reset.balanceUsdBefore },
          }),
          prisma.supplierReset.delete({ where: { id: req.params.id } }),
        ]);
        return res.status(204).end();
      }
    }

    await prisma.supplierReset.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
