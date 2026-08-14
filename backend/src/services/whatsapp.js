const { prisma } = require('../lib/prisma');

// sistem-plani.md § 3: sağlayıcı 360dialog veya Twilio olabilir.
// Bu fonksiyon durum değişikliklerinde çağrılır (bkz. routes/devices.js).
// Gerçek API entegrasyonu WHATSAPP_PROVIDER ortam değişkenine göre eklenecek;
// şimdilik mesaj veritabanına kaydedilir ("gönderildi" olarak işaretlenir)
// böylece panel ve takip portalı mesaj geçmişini gösterebilir.
const TEMPLATES = {
  RECEIVED: (d) => `Sayın ${d.customerName}, cihazınız (${d.model}) alındı. Takip kodunuz: ${d.trackingCode}`,
  DIAGNOSIS_DONE: (d) => `Sayın ${d.customerName}, cihazınızın arıza tespiti tamamlandı. Tahmini tutar: ₺${d.estimatedPrice ?? '-'}. Onay için takip kodunuzla portalı ziyaret edebilirsiniz.`,
  AWAITING_PARTS: (d) => `Sayın ${d.customerName}, cihazınız için parça bekleniyor.`,
  READY: (d) => `Sayın ${d.customerName}, cihazınız (${d.model}) teslime hazır.`,
  DELIVERED: (d) => `Sayın ${d.customerName}, cihazınızı teslim aldığınız için teşekkür ederiz.`,
};

async function sendStatusWhatsapp(device, customer, status) {
  const templateFn = TEMPLATES[status];
  if (!templateFn) return null;

  const content = templateFn({ customerName: customer.fullName, model: device.model, trackingCode: device.trackingCode, estimatedPrice: device.estimatedPrice });

  const provider = process.env.WHATSAPP_PROVIDER || 'none';
  let status_ = 'GONDERILDI';

  if (provider === '360dialog' || provider === 'twilio') {
    try {
      // TODO: gerçek sağlayıcı çağrısı burada yapılacak (fetch ile 360dialog/Twilio REST API)
      // Şablonun Meta Business Manager'da önceden onaylanmış olması gerekir.
    } catch (e) {
      status_ = 'BASARISIZ';
    }
  }

  return prisma.whatsappMessage.create({
    data: {
      deviceId: device.id,
      customerId: customer.id,
      templateType: status,
      content,
      status: status_,
    },
  });
}

module.exports = { sendStatusWhatsapp };
