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

// PDF/belge gibi bir dosyayı Meta'nın medya sunucusuna yükler, referans olarak
// kullanılacak media id'yi döner. Belge mesajları da (metin mesajları gibi)
// business-initiated ise onaylı bir şablonun "header" bileşeni üzerinden gönderilir.
async function uploadMediaToMeta(buffer, filename, mimeType) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json.id;
}

async function sendDocumentTemplateMessage(phone, templateName, mediaId, filename, bodyParams) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const to = toCloudApiPhone(phone);
  if (!to) throw new Error('Müşteri telefon numarası yok');

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'tr' },
      components: [
        { type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename } }] },
        { type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text: String(text) })) },
      ],
    },
  };
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

// Yalnızca personelin panelde ilgili "WhatsApp ile Gönder" butonuna basmasıyla
// tetiklenir (otomatik durum bildirimlerinden bağımsızdır). templateType, DB'ye
// hangi belgenin gönderildiğini not düşmek için (ör. "DELIVERY_FORM", "INVOICE").
// Otomatik durum/belge bildirimlerini de panelin "WhatsApp" gelen kutusu sohbetine
// işler — personel oraya gidip müşteriyle olan TÜM yazışmayı (bizim otomatik
// bildirimlerimiz + serbest yazışma) tek yerden takip edebilsin diye.
async function recordOutboundInInbox({ phone, customerId, body, ok, errorMessage }) {
  const waPhone = toCloudApiPhone(phone);
  if (!waPhone) return;
  const text = ok ? body : `${body}\n\n⚠️ Gönderilemedi: ${errorMessage}`;
  try {
    const existing = await prisma.whatsappConversation.findUnique({ where: { phone: waPhone } });
    const conversation =
      existing ||
      (await prisma.whatsappConversation.create({ data: { phone: waPhone, customerId: customerId || null } }));
    await prisma.whatsappChatMessage.create({
      data: { conversationId: conversation.id, direction: 'OUT', body: text },
    });
    await prisma.whatsappConversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: text.slice(0, 120),
        ...(customerId && !conversation.customerId ? { customerId } : {}),
      },
    });
  } catch (e) {
    console.error('[whatsapp] gelen kutusuna işlenemedi:', e);
  }
}

async function sendDocumentWhatsapp({ device, customer, pdfBuffer, filename, templateEnvKey, bodyParams, templateType }) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName = process.env[templateEnvKey];
  const phone = customer.phone || device.backupPhone;

  let status_ = 'GONDERILDI';
  let errorMessage = null;

  if (!accessToken || !phoneNumberId || !templateName) {
    status_ = 'BASARISIZ';
    errorMessage = 'WhatsApp Cloud API yapılandırılmamış veya bu belge için onaylı şablon tanımlı değil';
  } else {
    try {
      const mediaId = await uploadMediaToMeta(pdfBuffer, filename, 'application/pdf');
      await sendDocumentTemplateMessage(phone, templateName, mediaId, filename, bodyParams);
    } catch (e) {
      status_ = 'BASARISIZ';
      errorMessage = e.message;
    }
  }

  await recordOutboundInInbox({
    phone,
    customerId: customer.id,
    body: `[Belge] ${filename}`,
    ok: status_ === 'GONDERILDI',
    errorMessage,
  });

  return prisma.whatsappMessage.create({
    data: {
      deviceId: device.id,
      customerId: customer.id,
      templateType,
      content: `[Belge] ${filename}`,
      status: status_,
      errorMessage,
    },
  });
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

  await recordOutboundInInbox({
    phone,
    customerId: customer.id,
    body: content,
    ok: status_ === 'GONDERILDI',
    errorMessage,
  });

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

// Panelden gelen kutusuna verilen serbest metin yanıtları için — şablon gerektirmez,
// yalnızca müşterinin son 24 saat içinde bize yazdığı "customer service window"
// içindeyken çalışır (Meta bunun dışındaki denemeleri kendi tarafında reddeder).
async function sendFreeTextMessage(phone, text) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    return { ok: false, error: 'WhatsApp Cloud API yapılandırılmamış' };
  }
  const to = toCloudApiPhone(phone);
  if (!to) return { ok: false, error: 'Müşteri telefon numarası yok' };

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json.error?.message || `HTTP ${res.status}` };
    return { ok: true, waMessageId: json.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendStatusWhatsapp, sendDocumentWhatsapp, sendFreeTextMessage, toCloudApiPhone };
