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

// GET /api/customers?query=  — isim/telefon autocomplete (Cihaz Kabul ekranı)
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
      take: query ? 8 : 100,
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

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.customer.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
