const crypto = require('crypto');

// Meta (WhatsApp/Instagram) webhook'ları gövdeyi kendi uygulama secret'ıyla
// HMAC-SHA256 imzalayıp X-Hub-Signature-256 header'ında gönderir — bu olmadan
// herkes webhook JSON formatını taklit edip sahte müşteri mesajı enjekte
// edebilir (bkz. index.js'teki express.json({ verify }) ile req.rawBody).
// Secret henüz tanımlanmadıysa (ör. Meta App Secret'ı almadan önce mevcut
// kurulumlarla geriye dönük uyumluluk için) doğrulamayı atlayıp sadece uyarı
// loglar — secret eklenince otomatik olarak zorunlu hale gelir.
function verifyMetaSignature(secretEnvVar) {
  return (req, res, next) => {
    const secret = process.env[secretEnvVar];
    if (!secret) {
      console.warn(`[webhook] ${secretEnvVar} tanımlı değil — imza doğrulaması atlanıyor, webhook sahteciliğine açık. Meta App Dashboard > Settings > Basic'ten App Secret'ı alıp ortam değişkenine ekleyin.`);
      return next();
    }
    const signature = req.get('X-Hub-Signature-256') || '';
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex')}`;
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
    if (!valid) {
      console.warn(`[webhook] ${secretEnvVar}: imza doğrulaması başarısız, istek reddedildi.`);
      return res.sendStatus(401);
    }
    next();
  };
}

module.exports = { verifyMetaSignature };
