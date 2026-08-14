const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireEmployee);

router.get('/', async (req, res, next) => {
  try {
    const suppliers = await prisma.supplier.findMany({ orderBy: { name: 'asc' } });
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

// POST /api/suppliers/:id/payment — toptancıya ödeme (borç azalır)
router.post('/:id/payment', async (req, res, next) => {
  try {
    const { amount, description } = z.object({ amount: z.number().positive(), description: z.string().optional() }).parse(req.body);
    const [supplier] = await prisma.$transaction([
      prisma.supplier.update({ where: { id: req.params.id }, data: { currentBalance: { decrement: amount } } }),
      prisma.supplierTransaction.create({ data: { supplierId: req.params.id, type: 'ODEME', amount, description } }),
    ]);
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
