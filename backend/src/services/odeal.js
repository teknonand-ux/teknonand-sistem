// Ödeal E-FaturaPos entegrasyonu — onaylı fatura kestirme.
//
// Kredi Kartı ödemesi cihazdan (fiziksel POS'tan) geçtiği için Ödeal zaten
// kendiliğinden e-fatura/e-arşiv kesiyor, bizim hiçbir şey yapmamıza gerek yok.
// Nakit, Banka Hesabı (Havale/EFT) ve Sanal POS ödemelerinde ise para cihazdan
// geçmediğinden, cihazın yine de fatura kesmesi için Ödeal'in Device2Device
// ("Cihazlar arası sepet aktarımı") API'sine bizim sepeti göndermemiz gerekiyor.
//
// Bu üç yöntemden biriyle ödeme girildiğinde Ödeal'e HİÇBİR ŞEY otomatik
// gönderilmiyor — ödeme 'TASLAK' durumunda oluşuyor, panelde "Fatura" kartında
// personel açıklama/müşteri adı/tutarı gözden geçirip gerekirse düzenliyor,
// "Onayla ve Fatura Kes" dediğinde ancak o zaman routes/devices.js
// POST /:id/payments/:paymentId/approve-invoice bu dosyadaki
// requestInvoiceForPayment'ı çağırıyor (bkz. o route).
//
// ÖNEMLİ — Ödeal'e giden sepet isteğinin tam API şeması (endpoint yolu, header
// adı, sepet alanları, ödeme tipi kodları) docs.odeal.com/reference/sepet
// sayfasında giriş/servis anahtarı gerektiriyor, genel dokümantasyonda yayınlı
// değil. Servis anahtarı (ODEAL_SERVICE_KEY) ve cihaz kodu (ODEAL_DEVICE_KEY)
// alınıp Ödeal Developer Portal'daki gerçek API referansı görülünce, aşağıdaki
// TODO'lar gerçek değerlerle güncellenmeli — akışın geri kalanı (taslak/onay,
// durum takibi, panel gösterimi, webhook) zaten çalışır durumda.
const { prisma } = require('../lib/prisma');

// Fatura taslağı oluşturmamız gereken ödeme yöntemleri — panelin ödeme
// yöntemi seçenekleriyle birebir eşleşmeli (bkz. yonetici-paneli.html
// #pay-method) ve prisma/schema.prisma Payment.method yorum satırı.
const AUTO_INVOICE_METHODS = new Set(['Nakit', 'Banka Hesabı', 'Sanal POS']);

// Bizim ödeme yöntemi adlarımızdan Ödeal'in beklediği ödeme tipi koduna eşleme.
// TODO: Bu değerler EN İYİ TAHMİNdir, gerçek API şeması görülünce teyit/güncelle.
const PAYMENT_TYPE_MAP = {
  Nakit: 'Nakit',
  'Banka Hesabı': 'HavaleEft',
  'Sanal POS': 'SanalPos',
};

function isAutoInvoiceMethod(method) {
  return AUTO_INVOICE_METHODS.has(method);
}

// Panelin fatura taslağı formunda göstereceği/onaylayacağı değerler — ödemenin
// invoiceDescription/invoiceCustomerName/invoiceAmount alanları boşsa (personel
// henüz düzenlemediyse) makul varsayılanlara düşer.
function buildInvoiceDraft(payment, device) {
  return {
    description: payment.invoiceDescription || `Teknonand Teknik Servis — ${device.trackingCode || device.id}`,
    customerName: payment.invoiceCustomerName || device.customer?.fullName || '',
    amount: payment.invoiceAmount != null ? Number(payment.invoiceAmount) : Number(payment.amount),
  };
}

// Ödeme kaydını HATA durumuna çeker ve panelde görünmesi için hata mesajını yazar.
async function markFailed(paymentId, message) {
  try {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { invoiceStatus: 'HATA', invoiceError: message.slice(0, 500) },
    });
  } catch (e) {
    console.error(`[odeal] Ödeme ${paymentId} HATA durumuna çekilirken hata: ${e.message}`);
  }
}

// Personel panelde "Onayla ve Fatura Kes" dedikten SONRA çağrılır — Ödeal
// cihazına sepet gönderip fatura kesilmesini tetikler. Çağrıldığında
// payment.invoiceStatus zaten 'BEKLIYOR' olarak ayarlanmış olur (bkz.
// routes/devices.js approve-invoice). Bu fonksiyon yalnızca başarısızlık
// durumunda 'HATA'ya çeker; başarılı sepet isteğinde durum 'BEKLIYOR' kalır,
// faturanın gerçekten kesildiği yalnızca webhooks/odeal ile teyit edilip
// 'KESILDI'ye çekilir.
//
// Servis anahtarı/cihaz kodu henüz tanımlı değilse (kurulumun bu aşamasında
// beklenen durum) 'HATA' + açıklayıcı mesajla işaretlenir. Çağıran taraf bunu
// "fire-and-forget" çağırır: Ödeal API'si yavaş/kapalıysa bile onay isteği
// kullanıcıya hemen döner.
async function requestInvoiceForPayment(payment, device) {
  const draft = buildInvoiceDraft(payment, device);

  const serviceKey = process.env.ODEAL_SERVICE_KEY;
  const deviceKey = process.env.ODEAL_DEVICE_KEY; // externalDeviceKey — Ödeal Stage uygulaması > Cihazlarım
  const apiBase = process.env.ODEAL_API_BASE_URL || 'https://api.odeal.com'; // TODO: gerçek host teyit edilmeli

  if (!serviceKey || !deviceKey) {
    const msg = 'ODEAL_SERVICE_KEY/ODEAL_DEVICE_KEY tanımlı değil — Ödeal Developer Portal üzerinden servis anahtarını, cihazın Cihazlarım menüsünden de cihaz kodunu alıp .env dosyasına ekleyin.';
    console.warn(`[odeal] ${msg} (ödeme ${payment.id}, ${payment.method})`);
    await markFailed(payment.id, msg);
    return null;
  }

  const paymentTypeCode = PAYMENT_TYPE_MAP[payment.method];
  if (!paymentTypeCode) {
    const msg = `"${payment.method}" ödeme yöntemi için otomatik fatura eşlemesi tanımlı değil.`;
    console.warn(`[odeal] ${msg}`);
    await markFailed(payment.id, msg);
    return null;
  }

  try {
    // TODO: Gerçek endpoint yolu ve gövde alan adları docs.odeal.com/reference/sepet
    // (Device2Device sepet oluşturma) referansından teyit edilip güncellenmeli —
    // özellikle customerName alanının gerçek adı (alıcı/buyer bilgisi) teyit edilmeli.
    const res = await fetch(`${apiBase}/api/d2d/basket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`, // TODO: gerçek auth şeması (header adı/biçimi) teyit edilmeli
      },
      body: JSON.stringify({
        externalDeviceKey: deviceKey,
        amount: draft.amount,
        paymentType: paymentTypeCode,
        description: draft.description,
        customerName: draft.customerName || undefined,
        // Webhook geri döndüğünde ödeme kaydıyla eşleştirmek için — Ödeal bu
        // alanı olduğu gibi geri yansıtıyorsa routes/odealWebhook.js bununla eşleştirir.
        externalReferenceId: payment.id,
      }),
    });

    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = `Sepet isteği başarısız (HTTP ${res.status}): ${JSON.stringify(body)}`;
      console.error(`[odeal] ${msg} — ödeme ${payment.id}`);
      await markFailed(payment.id, msg);
      return null;
    }

    console.log(`[odeal] Sepet oluşturuldu, ödeme ${payment.id} için fatura cihazdan bekleniyor.`);
    return body;
  } catch (e) {
    console.error(`[odeal] Sepet isteği sırasında hata (ödeme ${payment.id}): ${e.message}`);
    await markFailed(payment.id, e.message);
    return null;
  }
}

module.exports = { isAutoInvoiceMethod, buildInvoiceDraft, requestInvoiceForPayment };
