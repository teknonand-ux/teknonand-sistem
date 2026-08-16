const { prisma } = require('../lib/prisma');

// sistem-plani.md § 3: WhatsApp Business Cloud API (Meta) kullanılıyor.
// Serbest metin sadece müşterinin son 24 saat içinde bize mesaj attığı "customer
// service window" içinde gönderilebilir; bizim durum bildirimlerimiz işletme
// tarafından başlatıldığı için Meta'da önceden ONAYLANMIŞ bir şablon (template)
// gerektirir. Şablon adları WHATSAPP_TEMPLATE_* ortam değişkenleriyle
// yapılandırılır — henüz onaylanmamışsa gönderim BASARISIZ olarak loglanır,
// panel/takip portalı çalışmaya devam eder.
const TEMPLATES = {
  RECEIVED: (d) => `Sayın ${d.customerName}, cihazınız (${d.model}) alındı. Takip kodunuz: ${d.trackingCode}`,
  DIAGNOSIS_DONE: (d) => `Sayın ${d.customerName}, cihazınızın arıza tespiti tamamlandı. Tahmini tutar: ₺${d.estimatedPrice ?? '-'}. Onay için takip kodunuzla portalı ziyaret edebilirsiniz.`,
  AWAITING_PARTS: (d) => `Sayın ${d.customerName}, cihazınız için parça bekleniyor.`,
  READY: (d) => `Sayın ${d.customerName}, cihazınız (${d.model}) teslime hazır.`,
  DELIVERED: (d) => `Sayın ${d.customerName}, cihazınızı teslim aldığınız için teşekkür ederiz.`,
};

// Her durum için Meta'da onaylanmış şablon adı ve şablonun body'sindeki
// {{1}}, {{2}}... parametrelerinin hangi sırayla doldurulacağı.
const CLOUD_API_TEMPLATES = {
  RECEIVED: { envKey: 'WHATSAPP_TEMPLATE_RECEIVED', params: (d) => [d.customerName, d.model, d.trackingCode] },
  DIAGNOSIS_DONE: { envKey: 'WHATSAPP_TEMPLATE_DIAGNOSIS_DONE', params: (d) => [d.customerName, d.model, String(d.estimatedPrice ?? '-')] },
  AWAITING_PARTS: { envKey: 'WHATSAPP_TEMPLATE_AWAITING_PARTS', params: (d) => [d.customerName, d.model] },
  READY: { envKey: 'WHATSAPP_TEMPLATE_READY', params: (d) => [d.customerName, d.model] },
  DELIVERED: { envKey: 'WHATSAPP_TEMPLATE_DELIVERED', params: (d) => [d.customerName] },
};

// Telefonu Meta Cloud API'nin beklediği ülke koduyla başlayan, +/boşluk/tire
// içermeyen forma çevirir (ör. "0553 830 24 91" -> "905538302491").
function toCloudApiPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('90') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 11) return '90' + digits.slice(1);
  if (digits.length === 10) return '90' + digits;
  return digits;
}

async function sendViaCloudApi(templateType, data, phone) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateConfig = CLOUD_API_TEMPLATES[templateType];
  const templateName = templateConfig && process.env[templateConfig.envKey];
  if (!accessToken || !phoneNumberId || !templateConfig || !templateName) {
    return { ok: false, error: 'WhatsApp Cloud API yapılandırılmamış veya bu durum için onaylı şablon tanımlı değil' };
  }

  const to = toCloudApiPhone(phone);
  if (!to) return { ok: false, error: 'Müşteri telefon numarası yok' };

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'tr' },
      components: [
        {
          type: 'body',
          parameters: templateConfig.params(data).map((text) => ({ type: 'text', text: String(text) })),
        },
      ],
    },
  };

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      return { ok: false, error: json.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function sendStatusWhatsapp(device, customer, status) {
  const templateFn = TEMPLATES[status];
  if (!templateFn) return null;

  const data = { customerName: customer.fullName, model: device.model, trackingCode: device.trackingCode, estimatedPrice: device.estimatedPrice };
  const content = templateFn(data);

  let status_ = 'GONDERILDI';
  let errorMessage = null;

  const phone = customer.phone || device.backupPhone;
  const result = await sendViaCloudApi(status, data, phone);
  if (!result.ok) {
    status_ = 'BASARISIZ';
    errorMessage = result.error;
  }

  return prisma.whatsappMessage.create({
    data: {
      deviceId: device.id,
      customerId: customer.id,
      templateType: status,
      content,
      status: status_,
      errorMessage,
    },
  });
}

module.exports = { sendStatusWhatsapp };
