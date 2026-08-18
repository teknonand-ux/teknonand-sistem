const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee } = require('../middleware/auth');

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

router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.supplier.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
