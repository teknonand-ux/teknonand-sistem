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
    const data = stockSchema.parse(req.body);
    const item = await prisma.stockItem.create({ data });
    if (item.quantity > 0) {
      await prisma.stockMovement.create({
        data: { stockItemId: item.id, quantityChange: item.quantity, reason: 'ALIM' },
      });
    }
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

router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.stockItem.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
