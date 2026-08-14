const { ZodError } = require('zod');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Geçersiz veri', details: err.flatten() });
  }
  if (err?.code === 'P2002') {
    return res.status(409).json({ error: 'Bu kayıt zaten mevcut (benzersiz alan çakışması)' });
  }
  if (err?.code === 'P2025') {
    return res.status(404).json({ error: 'Kayıt bulunamadı' });
  }
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Sunucu hatası' });
}

module.exports = { errorHandler };
