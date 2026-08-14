const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_KEYS = ['exchangeRate', 'labelDesign', 'companyInfo', 'companyLogo', 'whatsappTemplates'];
// exchangeRate (Stok sayfası) kısıtlı personele de açık; belge/etiket tasarımı ve WhatsApp şablonları yönetici-özel
const ADMIN_ONLY_KEYS = ['labelDesign', 'companyInfo', 'companyLogo', 'whatsappTemplates'];

// GET /api/settings/:key — panel + gerektiğinde herkese açık şablonlar için de kullanılabilir
router.get('/:key', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    if (!ALLOWED_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Ayar bulunamadı' });
    const setting = await prisma.appSetting.findUnique({ where: { key: req.params.key } });
    res.json(setting?.value ?? null);
  } catch (e) {
    next(e);
  }
});

router.put('/:key', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    if (!ALLOWED_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Ayar bulunamadı' });
    if (ADMIN_ONLY_KEYS.includes(req.params.key) && req.user.permission !== 'ADMIN') {
      return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
    }
    const { value } = z.object({ value: z.any() }).parse({ value: req.body });
    const setting = await prisma.appSetting.upsert({
      where: { key: req.params.key },
      update: { value },
      create: { key: req.params.key, value },
    });
    res.json(setting.value);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
