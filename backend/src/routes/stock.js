const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireEmployee);

const stockSchema = z.object({
  name: z.string().min(1),
  sku: z.string().optional(),
  category: z.string().optional(),
  quantity: z.number().int().nonnegative(),
  minThreshold: z.number().int().nonnegative(),
  unitCostTry: z.number().nonnegative(),
  unitCostUsd: z.number().nonnegative().optional(),
  supplierId: z.string().uuid().optional().nullable(),
  supplierCostCurrency: z.enum(['TRY', 'USD']).optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const items = await prisma.stockItem.findMany({ orderBy: { name: 'asc' }, include: { supplier: true } });
    res.json(items);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { supplierCostCurrency, ...data } = stockSchema.parse(req.body);
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.stockItem.create({ data, include: { supplier: true } });
      if (created.quantity > 0) {
        await tx.stockMovement.create({
          data: { stockItemId: created.id, quantityChange: created.quantity, reason: 'ALIM' },
        });
      }
      // Toptancı seçildiyse, girilen parti tutarı o toptancının cari hesabına
      // (girilen para birimi neyse o hesaba — TL veya USD) borç olarak işlenir.
      if (created.supplierId && created.quantity > 0) {
        const currency = supplierCostCurrency === 'USD' ? 'USD' : 'TRY';
        const unitCost = currency === 'USD' ? Number(created.unitCostUsd) : Number(created.unitCostTry);
        const total = unitCost * created.quantity;
        if (total > 0) {
          await tx.supplier.update({
            where: { id: created.supplierId },
            data: currency === 'USD' ? { currentBalanceUsd: { increment: total } } : { currentBalance: { increment: total } },
          });
          await tx.supplierTransaction.create({
            data: {
              supplierId: created.supplierId,
              stockItemId: created.id,
              type: 'ALIM',
              currency,
              amount: total,
              description: `${created.name} x${created.quantity}`,
            },
          });
        }
      }
      return created;
    });
    res.status(201).json(item);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/stock/:id/adjust  — toptancıdan yeni alım (stok artar + toptancı borcu artar)
router.patch('/:id/adjust', async (req, res, next) => {
  try {
    const schema = z.object({ quantityChange: z.number().int(), reason: z.enum(['ALIM', 'IADE', 'KULLANIM']) });
    const { quantityChange, reason } = schema.parse(req.body);

    const item = await prisma.$transaction(async (tx) => {
      const updated = await tx.stockItem.update({
        where: { id: req.params.id },
        data: { quantity: { increment: quantityChange } },
      });
      await tx.stockMovement.create({
        data: { stockItemId: updated.id, quantityChange, reason },
      });
      if (reason === 'ALIM' && updated.supplierId && quantityChange > 0) {
        const cost = Number(updated.unitCostTry) * quantityChange;
        await tx.supplier.update({
          where: { id: updated.supplierId },
          data: { currentBalance: { increment: cost } },
        });
        await tx.supplierTransaction.create({
          data: {
            supplierId: updated.supplierId,
            type: 'ALIM',
            amount: cost,
            description: `${updated.name} x${quantityChange}`,
          },
        });
      }
      return updated;
    });

    res.json(item);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/stock/:id — yanlış girilmiş veya toptancıya iade edilen stok
// kalemini siler; bu kalemin eklenmesiyle bir toptancı borcu oluştuysa
// (bkz. POST /) o borç da geri alınır.
router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.$transaction(async (tx) => {
      const linkedTxs = await tx.supplierTransaction.findMany({
        where: { stockItemId: req.params.id, type: 'ALIM' },
      });
      for (const t of linkedTxs) {
        const balanceField = t.currency === 'USD' ? 'currentBalanceUsd' : 'currentBalance';
        await tx.supplier.update({
          where: { id: t.supplierId },
          data: { [balanceField]: { decrement: t.amount } },
        });
      }
      await tx.supplierTransaction.deleteMany({ where: { stockItemId: req.params.id, type: 'ALIM' } });
      await tx.stockItem.delete({ where: { id: req.params.id } });
    });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
