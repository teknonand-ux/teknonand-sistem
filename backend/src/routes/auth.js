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

const dealerLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  phone: z.string().min(1),
});

const normalizePhone = (val) => String(val || '').replace(/\D/g, '');

// Hesap bazlı kilitleme eşiği — IP bazlı loginLimiter'dan (10 istek/15dk) farklı
// bir savunma katmanı: farklı/rotasyonlu IP'lerden tek bir hesabı hedefleyen
// denemelere karşı. Süre sonunda otomatik açılmaz (kasıtlı) — yönetici, kilitli
// hesabı POST /api/employees/:id/unlock ile açar (bkz. routes/employees.js).
const MAX_FAILED_LOGIN_ATTEMPTS = 3;

// POST /api/auth/employee-login  (yönetici paneli)
router.post('/employee-login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = loginSchema.parse(req.body);
    const employee = await prisma.employee.findUnique({ where: { username: username.toLowerCase() } });
    const passwordOk = await verifyPassword(password, employee?.passwordHash || DUMMY_HASH);

    if (employee?.lockedAt) {
      return res.status(423).json({ error: `Hesabınız ${MAX_FAILED_LOGIN_ATTEMPTS} hatalı giriş denemesinden sonra kilitlendi. Açılması için yöneticinize başvurun.` });
    }

    if (!employee || !employee.active || !passwordOk) {
      if (employee && employee.active) {
        const attempts = employee.failedLoginAttempts + 1;
        await prisma.employee.update({
          where: { id: employee.id },
          data: attempts >= MAX_FAILED_LOGIN_ATTEMPTS
            ? { failedLoginAttempts: attempts, lockedAt: new Date() }
            : { failedLoginAttempts: attempts },
        });
      }
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
    }

    if (employee.failedLoginAttempts > 0) {
      await prisma.employee.update({ where: { id: employee.id }, data: { failedLoginAttempts: 0 } });
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
// Kullanıcı adı/şifreye ek olarak bayinin sistemde kayıtlı telefon numarasını da
// doğruluyoruz — yalnızca kullanıcı adı/şifresini ele geçiren biri, bayinin
// telefonunu bilmeden giriş yapamaz. Bayinin telefonu kayıtlı değilse (admin
// panelinden girilmemişse) güvenli tarafta kalıp girişi reddediyoruz.
router.post('/dealer-login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password, phone } = dealerLoginSchema.parse(req.body);
    const dealer = await prisma.dealer.findUnique({ where: { username: username.toLowerCase() } });
    const passwordOk = await verifyPassword(password, dealer?.passwordHash || DUMMY_HASH);
    const dealerPhoneDigits = normalizePhone(dealer?.phone).slice(-10);
    const inputPhoneDigits = normalizePhone(phone).slice(-10);
    const phoneOk = dealerPhoneDigits.length === 10 && dealerPhoneDigits === inputPhoneDigits;
    if (!dealer || !passwordOk || !phoneOk) {
      return res.status(401).json({ error: 'Kullanıcı adı, şifre veya telefon numarası hatalı' });
    }
    const token = signToken({ id: dealer.id, type: 'dealer' }, '30d');
    res.json({ token, user: { id: dealer.id, name: dealer.name, balance: dealer.balance } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
