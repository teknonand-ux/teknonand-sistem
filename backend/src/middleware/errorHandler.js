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
  const status = err.status || 500;
  // 500 (beklenmeyen/işlenmemiş) hatalarda err.message istemciye sızdırılmıyor —
  // DB bağlantı dizesi, dosya yolu gibi iç detaylar içerebilir; sunucu logunda
  // (yukarıdaki console.error) zaten tam haliyle duruyor. 4xx'lerde mesaj
  // korunuyor — route'ların next(Object.assign(new Error('...'), {status}))
  // ile kasıtlı fırlattığı, kullanıcıya gösterilmek üzere yazılmış metinler bunlar.
  res.status(status).json({ error: status >= 500 ? 'Sunucu hatası, lütfen tekrar deneyin' : (err.message || 'İstek işlenemedi') });
}

module.exports = { errorHandler };
