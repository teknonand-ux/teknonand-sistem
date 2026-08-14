const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { verifyPassword, signToken } = require('../lib/auth');

const router = express.Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// POST /api/auth/employee-login  (yönetici paneli)
router.post('/employee-login', async (req, res, next) => {
  try {
    const { username, password } = loginSchema.parse(req.body);
    const employee = await prisma.employee.findUnique({ where: { username: username.toLowerCase() } });
    if (!employee || !employee.active || !(await verifyPassword(password, employee.passwordHash))) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
    }
    const token = signToken({ id: employee.id, type: 'employee', permission: employee.permission });
    res.json({
      token,
      user: { id: employee.id, name: employee.name, role: employee.role, permission: employee.permission },
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/dealer-login  (bayi portalı)
router.post('/dealer-login', async (req, res, next) => {
  try {
    const { username, password } = loginSchema.parse(req.body);
    const dealer = await prisma.dealer.findUnique({ where: { username: username.toLowerCase() } });
    if (!dealer || !(await verifyPassword(password, dealer.passwordHash))) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
    }
    const token = signToken({ id: dealer.id, type: 'dealer' });
    res.json({ token, user: { id: dealer.id, name: dealer.name, balance: dealer.balance } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
