const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee } = require('../middleware/auth');
const { sendSupplierStockPdfWhatsapp } = require('../services/whatsapp');
const { buildSupplierStockPdfBuffer } = require('../services/pdfGenerator');

const router = express.Router();
router.use(requireAuth, requireEmployee);

router.get('/', async (req, res, next) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      orderBy: { name: 'asc' },
      include: { transactions: { orderBy: { createdAt: 'desc' } } },
    });
    res.json(suppliers);
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { createdAt: 'desc' } } },
    });
    if (!supplier) return res.status(404).json({ error: 'Toptancı bulunamadı' });
    res.json(supplier);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const data = z.object({ name: z.string().min(1), phone: z.string().optional(), contactPerson: z.string().optional() }).parse(req.body);
    const supplier = await prisma.supplier.create({ data });
    res.status(201).json(supplier);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/suppliers/:id — toptancı bilgilerini düzenle (ad, telefon, ilgili kişi)
router.patch('/:id', async (req, res, next) => {
  try {
    const data = z
      .object({ name: z.string().min(1).optional(), phone: z.string().optional(), contactPerson: z.string().optional() })
      .parse(req.body);
    const supplier = await prisma.supplier.update({ where: { id: req.params.id }, data });
    res.json(supplier);
  } catch (e) {
    next(e);
  }
});

// POST /api/suppliers/:id/transactions — borç ekle (ALIM) veya ödeme (ODEME), TL veya USD
router.post('/:id/transactions', async (req, res, next) => {
  try {
    const schema = z.object({
      type: z.enum(['ALIM', 'ODEME']),
      currency: z.enum(['TRY', 'USD']).default('TRY'),
      amount: z.number().positive(),
      description: z.string().optional(),
    });
    const { type, currency, amount, description } = schema.parse(req.body);
    const delta = type === 'ALIM' ? amount : -amount;
    const balanceField = currency === 'USD' ? 'currentBalanceUsd' : 'currentBalance';
    await prisma.$transaction([
      prisma.supplier.update({ where: { id: req.params.id }, data: { [balanceField]: { increment: delta } } }),
      prisma.supplierTransaction.create({ data: { supplierId: req.params.id, type, currency, amount, description } }),
    ]);
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { createdAt: 'desc' } } },
    });
    res.json(supplier);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/suppliers/:id/transactions/:txId — hareketi sil, bakiyeyi geri al
router.delete('/:id/transactions/:txId', async (req, res, next) => {
  try {
    const tx = await prisma.supplierTransaction.findUnique({ where: { id: req.params.txId } });
    if (!tx || tx.supplierId !== req.params.id) return res.status(404).json({ error: 'Hareket bulunamadı' });
    const delta = tx.type === 'ALIM' ? -Number(tx.amount) : Number(tx.amount);
    const balanceField = tx.currency === 'USD' ? 'currentBalanceUsd' : 'currentBalance';
    await prisma.$transaction([
      prisma.supplier.update({ where: { id: req.params.id }, data: { [balanceField]: { increment: delta } } }),
      prisma.supplierTransaction.delete({ where: { id: req.params.txId } }),
    ]);
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { createdAt: 'desc' } } },
    });
    res.json(supplier);
  } catch (e) {
    next(e);
  }
});

// POST /api/suppliers/:id/stock-pdf-whatsapp — "Bu Toptancıdan Alınan Stok
// Kalemleri" kartındaki tarih aralığı araması sonucunu PDF olarak üretip
// hem toptancının kendi numarasına hem de sabit ofis hattına WhatsApp'tan
// belge olarak gönderir (bkz. src/services/whatsapp.js sendSupplierStockPdfWhatsapp).
router.post('/:id/stock-pdf-whatsapp', async (req, res, next) => {
  try {
    const { from, to } = z
      .object({ from: z.string().min(1), to: z.string().min(1) })
      .parse(req.body);

    const supplier = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!supplier) return res.status(404).json({ error: 'Toptancı bulunamadı' });

    const fromDate = new Date(`${from}T00:00:00`);
    const toDate = new Date(`${to}T23:59:59.999`);
    if (isNaN(fromDate) || isNaN(toDate) || fromDate > toDate) {
      return res.status(400).json({ error: 'Geçersiz tarih aralığı' });
    }
    const dateRange = { gte: fromDate, lte: toDate };

    const [stockItems, deviceParts] = await Promise.all([
      prisma.stockItem.findMany({ where: { supplierId: supplier.id, createdAt: dateRange } }),
      // Stoktan seçilmeden, doğrudan toptancı seçilerek cihaza eklenen parçalar —
      // stoktan seçilenler zaten kendi stok kalemi üzerinden yukarıda geliyor
      // (bkz. yonetici-paneli.html renderSupplierDetail ile aynı ayrım).
      prisma.devicePart.findMany({ where: { supplierId: supplier.id, stockItemId: null, createdAt: dateRange } }),
    ]);

    const items = [
      ...stockItems.map((item) => ({ name: item.name, costUsd: item.unitCostUsd, date: item.createdAt })),
      ...deviceParts.map((p) => ({ name: p.name, costUsd: p.costUsd, date: p.createdAt })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    const [companyInfoSetting, companyLogoSetting] = await Promise.all([
      prisma.appSetting.findUnique({ where: { key: 'companyInfo' } }),
      prisma.appSetting.findUnique({ where: { key: 'companyLogo' } }),
    ]);
    const companyInfo = companyInfoSetting?.value || {};
    const companyLogo = companyLogoSetting?.value || null;

    const fromLabel = fromDate.toLocaleDateString('tr-TR');
    const toLabel = toDate.toLocaleDateString('tr-TR');
    const pdfBuffer = await buildSupplierStockPdfBuffer(supplier, items, fromLabel, toLabel, companyInfo, companyLogo);
    const filename = `Stok-Dokumu-${supplier.name}-${from}-${to}.pdf`;

    const result = await sendSupplierStockPdfWhatsapp(supplier, pdfBuffer, filename, [supplier.name, fromLabel, toLabel]);
    if (!result.ok) return res.status(502).json({ error: result.errorMessage || 'Mesaj gönderilemedi' });
    res.json({ ok: true, itemCount: items.length });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.supplier.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
