const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee, requireAdmin } = require('../middleware/auth');
const { hashPassword } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth, requireEmployee);

router.get('/', async (req, res, next) => {
  try {
    const employees = await prisma.employee.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, role: true, username: true, permission: true, active: true, phone: true, email: true, lockedAt: true, failedLoginAttempts: true },
    });
    res.json(employees);
  } catch (e) {
    next(e);
  }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      username: z.string().min(1),
      password: z.string().min(8),
      permission: z.enum(['ADMIN', 'RESTRICTED']),
      phone: z.string().optional(),
      email: z.string().email().optional().or(z.literal('')),
    });
    const { password, username, ...rest } = schema.parse(req.body);
    const employee = await prisma.employee.create({
      data: { ...rest, username: username.toLowerCase(), passwordHash: await hashPassword(password) },
    });
    res.status(201).json(employee);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const schema = z.object({
      active: z.boolean().optional(),
      permission: z.enum(['ADMIN', 'RESTRICTED']).optional(),
      role: z.string().optional(),
      password: z.string().min(8).optional(),
    });
    const { password, ...rest } = schema.parse(req.body);
    const data = password ? { ...rest, passwordHash: await hashPassword(password) } : rest;
    const employee = await prisma.employee.update({ where: { id: req.params.id }, data });
    res.json(employee);
  } catch (e) {
    next(e);
  }
});

// POST /api/employees/:id/unlock — 3 hatalı girişten sonra kilitlenen hesabı
// yönetici açar (bkz. routes/auth.js employee-login).
router.post('/:id/unlock', requireAdmin, async (req, res, next) => {
  try {
    const employee = await prisma.employee.update({
      where: { id: req.params.id },
      data: { lockedAt: null, failedLoginAttempts: 0 },
      select: { id: true, name: true, role: true, username: true, permission: true, active: true, phone: true, email: true, lockedAt: true, failedLoginAttempts: true },
    });
    res.json(employee);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.employee.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
