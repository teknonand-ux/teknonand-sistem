// Ödeal E-FaturaPos entegrasyonu — onaylı fatura kestirme.
//
// Kredi Kartı ödemesi cihazdan (fiziksel POS'tan) geçtiği için Ödeal zaten
// kendiliğinden e-fatura/e-arşiv kesiyor, bizim hiçbir şey yapmamıza gerek yok.
// Nakit ve Banka Hesabı (Havale/EFT) ödemelerinde ise para cihazdan geçmediğinden,
// cihazın yine de fatura kesmesi için Ödeal'in Device2Device ("Cihazlar arası
// sepet aktarımı") API'sine bizim sepeti göndermemiz gerekiyor. (Sanal POS,
// Ödeal'in ayrı/bağımsız bir ürünü — bu API'nin kapsamında değil, bu yüzden
// otomatik fatura listesinden çıkarıldı; Sanal POS tahsilatlarında personel
// faturayı elle "Fatura (PDF)" alanından yükler.)
//
// Bu iki yöntemden biriyle ödeme girildiğinde Ödeal'e HİÇBİR ŞEY otomatik
// gönderilmiyor — ödeme 'TASLAK' durumunda oluşuyor, panelde "Fatura Onayı"
// kartında personel açıklama/müşteri adı/tutarı gözden geçirip gerekirse
// düzenliyor, "Onayla ve Fatura Kes" dediğinde ancak o zaman routes/devices.js
// POST /:id/payments/:paymentId/approve-invoice bu dosyadaki
// requestInvoiceForPayment'ı çağırıyor (bkz. o route).
//
// API ŞEMASI (docs.odeal.com/entegrasyon/tr/api/d2d/nakit-sepet-aktar ve
// .../havale-eft-sepet-aktar sayfalarından TEYİT EDİLDİ — 15 Eylül 2026):
//   POST https://api.odeal.com/api/v1/basket  (stage: https://stage.odealapp.com/api/v1/basket)
//   Header: X-ODEAL-MERCHANT-KEY, X-ODEAL-SECRET-KEY
//   (bkz. https://portal.odeal.com/giris > Ayarlar > Entegrasyon Bilgileri)
//   Body (zorunlu): referenceCode, customer{}, city, town, price, grossPrice,
//     items[], paymentOptions[]. (opsiyonel): externalDeviceKey, basketType,
//     receiptInfo, receiptNumber, receiptDate, siparisNo, garson.
//   customer{}: referenceCode, type (INDIVIDUAL/CORPORATE), name, surname,
//     identityNumber, title, taxNumber, taxOffice, gsmNumber, email, address.
//
// ÖNEMLİ — HÂLÂ TEYİT EDİLEMEYEN KISIMLAR: "items" ve "paymentOptions"
// dizilerinin alt alan adları (ör. items[].name/price/quantity,
// paymentOptions[].type/amount) ile paymentOptions[].type için kabul edilen
// değerler (nakit/havale kodları) docs.odeal.com'un etkileşimli "+ Ekle"
// form alanlarında JS ile render ediliyor, statik sayfa taramasıyla
// okunamadı — aşağıdaki alan adları/kodlar EN İYİ TAHMİNdir.
//
// DENEME GEÇMİŞİ:
//   1) PAYMENT_TYPE_MAP İngilizce (CASH/BANK_TRANSFER) → HTTP 500
//      {"code":1000,"exceptionType":"SERVER_ERROR","message":"server hatası"}
//      — Ödeal'in kendi sunucusunda çöktü, temiz bir 400 validasyon hatası
//      değil. Bu genelde sunucu tarafında yakalanmamış bir istisna (ör.
//      enum.valueOf() gibi bir eşleme başarısız olup exception fırlatması)
//      anlamına gelir — o yüzden şüpheli #1 paymentOptions[].type kodu.
//   2) Türkçe kodlarla (NAKIT/HAVALE_EFT) tekrar denendi → AYNI HTTP 500
//      SERVER_ERROR. İki farklı type koduyla aynı çökme alınması, sorunun
//      type kodunda OLMADIĞINI gösteriyor — kullanıcıya bu noktada Ödeal
//      destek hattına başvurması önerildi.
//   3) basketType hiç gönderilmiyordu (dokümantasyonda opsiyonel), şimdi
//      "STANDARD" ile deneniyor — ihtimal düşük ama ucuz bir deneme.
//      Bu da başarısız olursa kör tahminle devam etmek anlamsız, Ödeal'in
//      gerçek şemayı (Postman koleksiyonu/örnek istek) paylaşması gerekiyor.
const { prisma } = require('../lib/prisma');

// Fatura taslağı oluşturmamız gereken ödeme yöntemleri — panelin ödeme
// yöntemi seçenekleriyle birebir eşleşmeli (bkz. yonetici-paneli.html
// #pay-method) ve prisma/schema.prisma Payment.method yorum satırı. Sanal
// POS burada YOK — Ödeal'in D2D sepet API'si sadece fiziksel cihaz üzerinden
// kesilen (Nakit/Kredi Kartı/Havale-EFT/Açık Hesap/Cari Hesap/Avans/Yemek
// Kartı) satışları kapsıyor, online Sanal POS ayrı bir üründür.
const AUTO_INVOICE_METHODS = new Set(['Nakit', 'Banka Hesabı']);

// Bizim ödeme yöntemi adlarımızdan Ödeal'in paymentOptions[].type alanına
// eşleme — TODO: hâlâ teyit edilemedi, bkz. dosya başındaki DENEME GEÇMİŞİ.
const PAYMENT_TYPE_MAP = {
  Nakit: 'NAKIT',
  'Banka Hesabı': 'HAVALE_EFT',
};

function isAutoInvoiceMethod(method) {
  return AUTO_INVOICE_METHODS.has(method);
}

// Panelin fatura taslağı formunda göstereceği/onaylayacağı değerler — ödemenin
// invoiceDescription/invoiceCustomerName/invoiceCustomerTcKimlikNo/invoiceAmount
// alanları boşsa (personel henüz düzenlemediyse) makul varsayılanlara düşer.
function buildInvoiceDraft(payment, device) {
  return {
    description: payment.invoiceDescription || `Teknonand Teknik Servis — ${device.trackingCode || device.id}`,
    customerName: payment.invoiceCustomerName || device.customer?.fullName || '',
    tcKimlikNo: payment.invoiceCustomerTcKimlikNo || device.customer?.tcKimlikNo || '',
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

// "Ahmet Yılmaz" → { name: 'Ahmet', surname: 'Yılmaz' }. Ödeal customer
// nesnesi name/surname'i ayrı alanlar olarak istiyor, biz tek fullName
// tutuyoruz — son kelimeyi soyad, kalanını ad kabul ediyoruz. Tek kelimelik
// isimlerde surname boş kalır (bazı API'ler bunu reddedebilir, teyit edilmeli).
function splitFullName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { name: '', surname: '' };
  if (parts.length === 1) return { name: parts[0], surname: '' };
  return { name: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] };
}

// Personel panelde "Onayla ve Fatura Kes" dedikten SONRA çağrılır — Ödeal
// cihazına sepet gönderip fatura kesilmesini tetikler. Çağrıldığında
// payment.invoiceStatus zaten 'BEKLIYOR' olarak ayarlanmış olur (bkz.
// routes/devices.js approve-invoice). Bu fonksiyon yalnızca başarısızlık
// durumunda 'HATA'ya çeker; başarılı sepet isteğinde durum 'BEKLIYOR' kalır,
// faturanın gerçekten kesildiği yalnızca webhooks/odeal ile teyit edilip
// 'KESILDI'ye çekilir.
//
// Anahtarlar/cihaz kodu/il-ilçe henüz tanımlı değilse (kurulumun bu
// aşamasında beklenen durum) 'HATA' + açıklayıcı mesajla işaretlenir. Çağıran
// taraf bunu "fire-and-forget" çağırır: Ödeal API'si yavaş/kapalıysa bile
// onay isteği kullanıcıya hemen döner.
async function requestInvoiceForPayment(payment, device) {
  const draft = buildInvoiceDraft(payment, device);

  const merchantKey = process.env.ODEAL_MERCHANT_KEY;
  const secretKey = process.env.ODEAL_SECRET_KEY;
  const deviceKey = process.env.ODEAL_DEVICE_KEY; // externalDeviceKey — Ödeal Stage uygulaması > Cihazlarım
  // Prod varsayılan; test için ODEAL_API_BASE_URL=https://stage.odealapp.com/api/v1 verilebilir.
  const apiBase = process.env.ODEAL_API_BASE_URL || 'https://api.odeal.com/api/v1';

  if (!merchantKey || !secretKey || !deviceKey) {
    const msg = 'ODEAL_MERCHANT_KEY/ODEAL_SECRET_KEY/ODEAL_DEVICE_KEY tanımlı değil — portal.odeal.com > Ayarlar > Entegrasyon Bilgileri\'nden API/Secret anahtarını, cihazın Cihazlarım menüsünden de cihaz kodunu alıp Railway ortam değişkenlerine ekleyin.';
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

  // city/town Ödeal'in şemasında zorunlu — burada işletmenin kendi il/ilçesini
  // kullanıyoruz (Ayarlar > Belge Tasarımı > Firma Bilgileri), müşterininkini
  // değil: bu fiziksel dükkanda gerçekleşen bir satış, "işlem yeri" anlamında.
  const companyInfoSetting = await prisma.appSetting.findUnique({ where: { key: 'companyInfo' } });
  const companyInfo = companyInfoSetting?.value || {};
  if (!companyInfo.city || !companyInfo.town) {
    const msg = 'Ayarlar > Belge Tasarımı > Firma Bilgileri\'nde İl/İlçe girilmemiş — Ödeal bunu zorunlu istiyor.';
    console.warn(`[odeal] ${msg}`);
    await markFailed(payment.id, msg);
    return null;
  }

  const { name, surname } = splitFullName(draft.customerName);

  const requestBody = {
    referenceCode: payment.id, // webhook geri döndüğünde eşleştirmek için (bkz. routes/odealWebhook.js)
    externalDeviceKey: deviceKey,
    siparisNo: device.trackingCode || undefined, // webhook'ta ikinci eşleştirme yolu olarak da kullanılıyor
    // TODO: basketType dokümantasyonda opsiyonel görünüyor ama iki farklı
    // paymentOptions[].type denemesi de aynı genel HTTP 500 SERVER_ERROR ile
    // sonuçlandığından, sunucunun (opsiyonel işaretlenmiş olsa bile) bunu
    // zımnen beklediği/eksikliğinde çöktüğü ihtimaline karşı deneniyor.
    // Değer "STANDARD" — Ödeal'in D2D dokümantasyonunda geçen sepet türleri
    // (Standard/Advance/Account Receivable/Meal Card) grubundan en genel olanı.
    basketType: 'STANDARD',
    city: companyInfo.city,
    town: companyInfo.town,
    price: draft.amount,
    grossPrice: draft.amount, // KDV dahil fiyatlandırma kullanıyoruz (bkz. DevicePart vatMode DAHIL) — TODO: price'ın net mi brüt mü beklendiği teyit edilmeli
    customer: {
      type: 'INDIVIDUAL', // TODO: kurumsal müşteri (taxNumber/taxOffice) desteği eklenmedi
      name: name || draft.customerName || 'Müşteri',
      surname: surname || undefined,
      identityNumber: draft.tcKimlikNo || undefined,
      gsmNumber: device.customer?.phone || undefined,
      email: device.customer?.email || undefined,
    },
    items: [
      {
        name: draft.description,
        price: draft.amount,
        quantity: 1,
      },
    ],
    paymentOptions: [
      {
        type: paymentTypeCode,
        amount: draft.amount,
      },
    ],
  };

  // Railway loglarında (get-logs) gidiş/dönüş birlikte görünsün diye — Ödeal
  // opak bir 500 döndürdüğünde bu satır olmadan hangi payload'ın suçlu olduğunu
  // ayırt etmek imkansız oluyordu.
  console.log(`[odeal] Sepet isteği gönderiliyor (ödeme ${payment.id}):`, JSON.stringify(requestBody));

  try {
    const res = await fetch(`${apiBase}/basket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ODEAL-MERCHANT-KEY': merchantKey,
        'X-ODEAL-SECRET-KEY': secretKey,
      },
      body: JSON.stringify(requestBody),
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
