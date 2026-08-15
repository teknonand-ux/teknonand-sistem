const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { verifyPassword, signToken } = require('../lib/auth');

const router = express.Router();

// Şifre kaba kuvvet / kimlik bilgisi doldurma (credential stuffing) saldırılarına karşı —
// genel API oran sınırlaması (15 dk'da 300 istek, tüm uçlar için) giriş denemesi kısıtlamak
// için yeterince sıkı değil; burada IP başına 15 dakikada 10 deneme ile ayrıca sınırlıyoruz.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla giriş denemesi yapıldı, lütfen birkaç dakika sonra tekrar deneyin' },
});

// Kullanıcı adı bulunamadığında bcrypt.compare hiç çağrılmıyordu — bu, var olan/olmayan
// kullanıcı adları arasında ölçülebilir bir yanıt süresi farkı (timing side-channel) yaratıp
// kullanıcı adı numaralandırmayı (enumeration) kolaylaştırıyordu. Sahte olsa da geçerli
// formatta bir bcrypt hash'ine karşı her zaman karşılaştırma yaparak süreyi sabitliyoruz.
const DUMMY_HASH = '$2a$10$oabGmc37rBPIuuqZ2qqEsO7akHS2f7uctea0P3I8QiIP3otX3hjo.';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// POST /api/auth/employee-login  (yönetici paneli)
router.post('/employee-login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = loginSchema.parse(req.body);
    const employee = await prisma.employee.findUnique({ where: { username: username.toLowerCase() } });
    const passwordOk = await verifyPassword(password, employee?.passwordHash || DUMMY_HASH);
    if (!employee || !employee.active || !passwordOk) {
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
router.post('/dealer-login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = loginSchema.parse(req.body);
    const dealer = await prisma.dealer.findUnique({ where: { username: username.toLowerCase() } });
    const passwordOk = await verifyPassword(password, dealer?.passwordHash || DUMMY_HASH);
    if (!dealer || !passwordOk) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
    }
    const token = signToken({ id: dealer.id, type: 'dealer' }, '30d');
    res.json({ token, user: { id: dealer.id, name: dealer.name, balance: dealer.balance } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
