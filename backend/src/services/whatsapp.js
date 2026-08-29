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
  SHIPPED: (d) => `Sayın ${d.customerName}, cihazınız (${d.model}) Yurtiçi Kargo ile gönderildi. Takip No: ${d.cargoTrackingNumber || '-'}`,
  DELIVERED: (d) => `Sayın ${d.customerName}, cihazınızı teslim aldığınız için teşekkür ederiz.`,
};

// Cihaz bir bayiye aitse (device.dealerId doluysa) "müşteri" kaydı aslında bayinin
// kendisidir (bkz. routes/devices.js POST /bulk) — bayiye TEMPLATES'teki müşteri
// metinleri yerine, bayi adını içeren ve bayi portalına yönlendiren ayrı bir kısa
// metin seti gider. AWAITING_PARTS bilerek yok — bayiye parça bekleme bildirimi
// gönderilmiyor.
const DEALER_TEMPLATES = {
  RECEIVED: (d) => `Sayın ${d.customerName}, ${d.model} modelli cihazınızın takip kodu: ${d.trackingCode}. Cihaz aşamalarını bayi portalından takip edebilirsiniz.`,
  DIAGNOSIS_DONE: (d) => `Sayın ${d.customerName}, ${d.model} modelli cihazınızın arıza tespiti tamamlandı. Tahmini tutar: ₺${d.estimatedPrice ?? '-'}. Bayi portalından onaylanmayan cihazlar işleme alınmaz. İşlemin hızlı ilerlemesi için portaldan onay veriniz.`,
  READY: (d) => `Sayın ${d.customerName}, ${d.model} modelli cihazınız teslime hazır. Cihaz aşamalarını bayi portalından takip edebilirsiniz.`,
  SHIPPED: (d) => `Sayın ${d.customerName}, ${d.model} modelli cihazınız Yurtiçi Kargo ile gönderildi. Takip No: ${d.cargoTrackingNumber || '-'}. Cihaz aşamalarını bayi portalından takip edebilirsiniz.`,
  DELIVERED: (d) => `Sayın ${d.customerName}, ${d.model} modelli cihazınız teslim edildi. Cihaz aşamalarını bayi portalından takip edebilirsiniz.`,
};

// Her durum için Meta'da onaylanmış şablon adı ve şablonun body'sindeki
// {{1}}, {{2}}... parametrelerinin hangi sırayla doldurulacağı.
const CLOUD_API_TEMPLATES = {
  RECEIVED: { envKey: 'WHATSAPP_TEMPLATE_RECEIVED', params: (d) => [d.customerName, d.model, d.trackingCode] },
  DIAGNOSIS_DONE: { envKey: 'WHATSAPP_TEMPLATE_DIAGNOSIS_DONE', params: (d) => [d.customerName, d.model, String(d.estimatedPrice ?? '-')] },
  AWAITING_PARTS: { envKey: 'WHATSAPP_TEMPLATE_AWAITING_PARTS', params: (d) => [d.customerName, d.model] },
  READY: { envKey: 'WHATSAPP_TEMPLATE_READY', params: (d) => [d.customerName, d.model] },
  SHIPPED: { envKey: 'WHATSAPP_TEMPLATE_SHIPPED', params: (d) => [d.customerName, d.model, d.cargoTrackingNumber || '-'] },
  DELIVERED: { envKey: 'WHATSAPP_TEMPLATE_DELIVERED', params: (d) => [d.customerName] },
};

// Bayi bildirimleri için Meta Business Manager'da onaylatılan şablonlar (bkz.
// WhatsApp Yöneticisi > Mesaj şablonları: cihaz_alindi_bayi, ariza_tespiti_tamamlandi_bayi,
// teslime_hazir_bayi, kargoya_verildi_bayi, teslim_edildi_bayi). AWAITING_PARTS yok —
// bayiye parça bekleme bildirimi gönderilmiyor. SHIPPED şablonu ayrıca gövdedeki
// {{3}} takip numarasının yanında, "Kargomu Takip Et" adlı dinamik URL düğmesi
// içerir (bkz. buttonParams) — düğme Yurtiçi Kargo'nun gönderi sorgulama sayfasına
// takip numarasını otomatik dolduran bir linke gider.
const DEALER_CLOUD_API_TEMPLATES = {
  RECEIVED: { envKey: 'WHATSAPP_TEMPLATE_DEALER_RECEIVED', params: (d) => [d.customerName, d.model, d.trackingCode] },
  DIAGNOSIS_DONE: { envKey: 'WHATSAPP_TEMPLATE_DEALER_DIAGNOSIS_DONE', params: (d) => [d.customerName, d.model, String(d.estimatedPrice ?? '-')] },
  READY: { envKey: 'WHATSAPP_TEMPLATE_DEALER_READY', params: (d) => [d.customerName, d.model] },
  SHIPPED: {
    envKey: 'WHATSAPP_TEMPLATE_DEALER_SHIPPED',
    params: (d) => [d.customerName, d.model, d.cargoTrackingNumber || '-'],
    buttonParams: (d) => [d.cargoTrackingNumber || ''],
  },
  DELIVERED: { envKey: 'WHATSAPP_TEMPLATE_DEALER_DELIVERED', params: (d) => [d.customerName, d.model] },
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

async function sendViaCloudApi(templateType, data, phone, templatesConfig = CLOUD_API_TEMPLATES) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateConfig = templatesConfig[templateType];
  const templateName = templateConfig && process.env[templateConfig.envKey];
  if (!accessToken || !phoneNumberId || !templateConfig || !templateName) {
    return { ok: false, error: 'WhatsApp Cloud API yapılandırılmamış veya bu durum için onaylı şablon tanımlı değil' };
  }

  const to = toCloudApiPhone(phone);
  if (!to) return { ok: false, error: 'Müşteri telefon numarası yok' };

  const components = [
    {
      type: 'body',
      parameters: templateConfig.params(data).map((text) => ({ type: 'text', text: String(text) })),
    },
  ];
  // Dinamik URL düğmesi olan şablonlar için (ör. bayi SHIPPED şablonundaki
  // "Kargomu Takip Et") — düğmenin {{1}}'i gövdedeki parametrelerden bağımsız,
  // her zaman index 0'daki tek düğmeye ait ayrı bir parametre listesidir.
  if (templateConfig.buttonParams) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: templateConfig.buttonParams(data).map((text) => ({ type: 'text', text: String(text) })),
    });
  }

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'tr' },
      components,
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
  const isDealerDevice = !!device.dealerId;
  const templateFn = (isDealerDevice ? DEALER_TEMPLATES : TEMPLATES)[status];
  if (!templateFn) return null;

  const data = { customerName: customer.fullName, model: device.model, trackingCode: device.trackingCode, estimatedPrice: device.estimatedPrice, cargoTrackingNumber: device.cargoTrackingNumber };
  const content = templateFn(data);

  let status_ = 'GONDERILDI';
  let errorMessage = null;

  const phone = customer.phone || device.backupPhone;
  const result = await sendViaCloudApi(status, data, phone, isDealerDevice ? DEALER_CLOUD_API_TEMPLATES : CLOUD_API_TEMPLATES);
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

// Müşteriden gelen bir görsel/belge mesajının medyasını indirir (Meta'nın
// media-id -> geçici indirme URL'i -> binary akışı) ve base64 data URL olarak
// döner. Video/ses gibi büyük dosyalarda veritabanını şişirmemek için boyut sınırı var
// (dekont/görsel WhatsApp'ta zaten 5MB altında kalır — bkz. Meta media limitleri).
const MAX_INBOUND_MEDIA_BYTES = 8 * 1024 * 1024;
async function downloadIncomingMedia(mediaId) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) throw new Error('WhatsApp Cloud API yapılandırılmamış');

  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(meta.error?.message || `HTTP ${metaRes.status}`);
  if (meta.file_size && meta.file_size > MAX_INBOUND_MEDIA_BYTES) {
    throw new Error(`Dosya çok büyük (${Math.round(meta.file_size / 1024 / 1024)}MB)`);
  }

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!fileRes.ok) throw new Error(`Medya indirilemedi (HTTP ${fileRes.status})`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  if (buffer.length > MAX_INBOUND_MEDIA_BYTES) {
    throw new Error(`Dosya çok büyük (${Math.round(buffer.length / 1024 / 1024)}MB)`);
  }
  const mimeType = meta.mime_type || 'application/octet-stream';
  return { dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`, mimeType };
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

function formatApptDateTime(datetime) {
  return new Date(datetime).toLocaleString('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Meta'da onaylı, sabit isimli bir şablonu (parametreleri sırayla body'ye dolduran)
// verilen numaraya gönderir — randevu bildirimleri gibi tek-parametre setli, basit
// şablonlar için sendViaCloudApi'nin genelleştirilmiş hali.
async function sendNamedTemplateMessage(phone, templateName, params) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId || !templateName) {
    return { ok: false, error: 'WhatsApp Cloud API yapılandırılmamış veya bu bildirim için onaylı şablon tanımlı değil' };
  }
  const to = toCloudApiPhone(phone);
  if (!to) return { ok: false, error: 'Telefon numarası yok' };

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'tr' },
          components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }],
        },
      }),
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json.error?.message || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Web sitesinden yeni bir randevu talebi geldiğinde işletmeye (WHATSAPP_STAFF_ALERT_PHONE)
// haber verir — panel/e-posta bildiriminden bağımsız, ayrı bir kanal.
async function sendNewAppointmentStaffAlert(appointment) {
  const staffPhone = process.env.WHATSAPP_STAFF_ALERT_PHONE;
  if (!staffPhone) return { ok: false, error: 'WHATSAPP_STAFF_ALERT_PHONE tanımlı değil' };

  const templateName = process.env.WHATSAPP_TEMPLATE_NEW_APPOINTMENT;
  const body = `Web sitesinden yeni bir randevu talebi alındı. Müşteri: ${appointment.customerName}. Tarih: ${formatApptDateTime(appointment.datetime)}. Telefon: ${appointment.phone}. Panelden onaylayabilirsiniz.`;
  const result = await sendNamedTemplateMessage(staffPhone, templateName, [
    appointment.customerName,
    formatApptDateTime(appointment.datetime),
    appointment.phone,
  ]);
  await recordOutboundInInbox({ phone: staffPhone, customerId: null, body, ok: result.ok, errorMessage: result.error });
  return result;
}

// Panelden "WhatsApp ile Onay Gönder" ile müşteriye randevu onayı gönderir.
async function sendAppointmentConfirmation(appointment) {
  const templateName = process.env.WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMED;
  const whenStr = formatApptDateTime(appointment.datetime);
  const body = `Sayın ${appointment.customerName}, ${whenStr} tarihindeki randevunuz onaylanmıştır. Sizi bekliyoruz!`;
  const result = await sendNamedTemplateMessage(appointment.phone, templateName, [appointment.customerName, whenStr]);
  await recordOutboundInInbox({ phone: appointment.phone, customerId: null, body, ok: result.ok, errorMessage: result.error });
  return result;
}

// Bayiler sayfasındaki "WhatsApp ile Bakiye Bildir" butonu — önceden wa.me linki
// açıp personelin elle "gönder"e basmasını gerektiriyordu; artık diğer bayi
// bildirimleri gibi onaylı şablon üzerinden otomatik gönderiliyor.
async function sendDealerBalanceReminder(dealer) {
  const templateName = process.env.WHATSAPP_TEMPLATE_DEALER_BALANCE;
  const balance = (parseFloat(dealer.balance) || 0).toFixed(2);
  const body = `Sayın ${dealer.name}, toplam bakiyeniz ₺${balance}. Ödeme yapmanız rica olunur. Bakiye detayını bayi portalından görüntüleyebilirsiniz.`;
  const result = await sendNamedTemplateMessage(dealer.phone, templateName, [dealer.name, balance]);
  await recordOutboundInInbox({ phone: dealer.phone, customerId: null, body, ok: result.ok, errorMessage: result.error });
  return result;
}

// "Bu Toptancıdan Alınan Stok Kalemleri" kartındaki tarih aralığı PDF'i — panelde
// ayrı iki düğmeyle ya toptancının kendi numarasına ya da sabit muhasebe/ofis
// hattına gönderilir (bkz. routes/suppliers.js POST /:id/stock-pdf-whatsapp,
// target: 'supplier' | 'extra'). Cihaz/müşteri bağlamı olmadığından
// sendDocumentWhatsapp'tan (whatsappMessage kaydı, device/customer zorunluluğu)
// bağımsız, kendi belge gönderimini yapar.
const SUPPLIER_STOCK_PDF_EXTRA_PHONE = '05342024037';

async function sendSupplierStockPdfToPhone(phone, pdfBuffer, filename, bodyParams) {
  const templateName = process.env.WHATSAPP_TEMPLATE_SUPPLIER_STOCK;
  let status_ = 'GONDERILDI';
  let errorMessage = null;
  if (!templateName) {
    status_ = 'BASARISIZ';
    errorMessage = 'Bu belge için onaylı şablon tanımlı değil (WHATSAPP_TEMPLATE_SUPPLIER_STOCK)';
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
    customerId: null,
    body: `[Belge] ${filename}`,
    ok: status_ === 'GONDERILDI',
    errorMessage,
  });
  return { ok: status_ === 'GONDERILDI', error: errorMessage };
}

module.exports = {
  sendStatusWhatsapp,
  sendDocumentWhatsapp,
  sendFreeTextMessage,
  sendNewAppointmentStaffAlert,
  sendAppointmentConfirmation,
  sendDealerBalanceReminder,
  sendSupplierStockPdfToPhone,
  SUPPLIER_STOCK_PDF_EXTRA_PHONE,
  toCloudApiPhone,
  downloadIncomingMedia,
};
