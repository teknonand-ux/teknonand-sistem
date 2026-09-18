const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireEmployee, requireAdmin } = require('../middleware/auth');
const { fetchUsdTryRate } = require('../services/exchangeRate');
const { GOOGLE_REVIEW_TEMPLATE_DEFINITION } = require('../services/whatsapp');

const router = express.Router();

const ALLOWED_KEYS = ['exchangeRate', 'labelDesign', 'companyInfo', 'companyLogo', 'whatsappTemplates', 'labelPrinterName'];
// exchangeRate (Stok sayfası) kısıtlı personele de açık; belge/etiket tasarımı ve WhatsApp şablonları yönetici-özel
const ADMIN_ONLY_KEYS = ['labelDesign', 'companyInfo', 'companyLogo', 'whatsappTemplates', 'labelPrinterName'];

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

// POST /api/settings/exchangeRate/refresh — güncel USD/TL piyasa kurunu otomatik çeker ve kaydeder
router.post('/exchangeRate/refresh', requireAuth, requireEmployee, async (req, res, next) => {
  try {
    const { rate, source, fetchedAt } = await fetchUsdTryRate();
    const value = { rate, source, updatedAt: fetchedAt };
    const setting = await prisma.appSetting.upsert({
      where: { key: 'exchangeRate' },
      update: { value },
      create: { key: 'exchangeRate', value },
    });
    res.json(setting.value);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Kur çekilemedi' });
  }
});

// POST /api/settings/whatsapp-templates/create-google-review-template — TEK SEFERLİK
// KURULUM UCU: "⭐ Google Yorum İste" şablonunu Meta'ya (WhatsApp Cloud API) submit
// eder. Panelde kimse çağırmaz; WHATSAPP_TEMPLATE_SETUP_KEY env değişkeni Railway'de
// tanımlıyken ve istekteki x-setup-key header'ı ona eşitken çalışır — env değişkeni
// yoksa (kurulum tamamlanıp kaldırıldıktan sonraki hal) 404 döner. Şablon Meta'da
// onaylandıktan sonra hem bu env değişkeni hem bu route güvenlik için kaldırılabilir.
router.post('/whatsapp-templates/create-google-review-template', async (req, res, next) => {
  try {
    const setupKey = process.env.WHATSAPP_TEMPLATE_SETUP_KEY;
    if (!setupKey || req.headers['x-setup-key'] !== setupKey) return res.status(404).json({ error: 'Uç nokta bulunamadı' });

    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    if (!accessToken || !wabaId) return res.status(500).json({ error: 'WHATSAPP_ACCESS_TOKEN / WHATSAPP_BUSINESS_ACCOUNT_ID tanımlı değil' });

    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(GOOGLE_REVIEW_TEMPLATE_DEFINITION),
    });
    const json = await metaRes.json();
    if (!metaRes.ok) return res.status(502).json({ error: json.error?.message || `HTTP ${metaRes.status}`, details: json });
    res.json({ ok: true, templateName: GOOGLE_REVIEW_TEMPLATE_DEFINITION.name, meta: json });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
