const express = require('express');
const crypto = require('crypto');
const { prisma } = require('../lib/prisma');

const router = express.Router();

// query string'deki token'ı sabit zamanlı (timing-safe) karşılaştırır — düz
// !== ile karşılaştırmak, karakterlerin ne kadarının eşleştiğine göre yanıt
// süresinde ölçülebilir farklar yaratıp token'ın byte byte tahmin edilmesine
// (timing attack) açık kapı bırakır. verifyMetaSignature.js'teki aynı desen.
function isValidWebhookToken(provided, expected) {
  const providedBuf = Buffer.from(String(provided || ''));
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// Webhook body'sindeki base64 veya URL biçimindeki fatura PDF'ini panelin
// beklediği data URL biçimine (data:application/pdf;base64,...) çevirir.
async function extractInvoicePdfDataUrl(invoicePdfBase64, invoicePdfUrl) {
  if (invoicePdfBase64) return `data:application/pdf;base64,${invoicePdfBase64}`;
  if (!invoicePdfUrl) return null;
  const pdfRes = await fetch(invoicePdfUrl);
  if (!pdfRes.ok) {
    console.error(`[odeal webhook] Fatura PDF'i indirilemedi (HTTP ${pdfRes.status}): ${invoicePdfUrl}`);
    return null;
  }
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  return `data:application/pdf;base64,${buf.toString('base64')}`;
}

// Ödeal, services/odeal.js'in gönderdiği sepet isteğinin sonucunu (fatura
// kesildi/başarısız vb.) bu adrese webhook olarak POST eder. Ödeal Developer
// Portal'daki Entegrasyon Profili ayarlarında bu URL'i "e-fatura oluşturma"
// callback adresi olarak tanımlamak gerekiyor:
//   https://<backend-domain>/webhooks/odeal?token=<ODEAL_WEBHOOK_TOKEN>
//
// ÖNEMLİ — bu handler iskelettir: Ödeal'in gönderdiği gerçek gövde şeması
// (alan adları) ve imza doğrulama şeması genel dokümantasyonda yayınlı değil,
// servis anahtarı alınıp gerçek payload görülünce güncellenmeli. Ödeal kendi
// imza şemasını (HMAC vb.) belgeleyene kadar geçici önlem olarak: callback
// URL'e Ödeal panelinden ?token= parametresiyle rastgele bir ODEAL_WEBHOOK_TOKEN
// ekliyoruz, bu adresi sadece o token'ı bilen (yani bizim Ödeal'e kendi
// tanımladığımız) çağıran kullanabiliyor — bkz. .env.example.
router.post('/', express.json(), async (req, res) => {
  try {
    const expectedToken = process.env.ODEAL_WEBHOOK_TOKEN;
    if (expectedToken && !isValidWebhookToken(req.query.token, expectedToken)) {
      console.warn('[odeal webhook] Geçersiz/eksik token ile istek, reddedildi.');
      return res.sendStatus(401);
    }
    if (!expectedToken) {
      console.warn('[odeal webhook] ODEAL_WEBHOOK_TOKEN tanımlı değil — doğrulama atlanıyor, bu adres şu an korumasız.');
    }

    const body = req.body || {};
    console.log('[odeal webhook] Gelen istek:', JSON.stringify(body).slice(0, 2000));

    // referenceCode — docs.odeal.com/entegrasyon/tr/api/d2d/nakit-sepet-aktar'da
    // teyit edilen gerçek alan adı, requestInvoiceForPayment sepet isteğinde bunu
    // payment.id olarak gönderiyor (bkz. services/odeal.js). Webhook body'sinde
    // aynı adla mı yoksa başka bir sarmalayıcı alanda mı geri geldiği henüz
    // teyit edilmedi (webhook payload şeması dokümante değil) — birkaç olası
    // adı deniyoruz.
    const paymentId = body.referenceCode || body.externalReferenceId || body.paymentId;
    const invoicePdfBase64 = body.invoicePdfBase64 || body.eInvoicePdfBase64;
    const invoicePdfUrl = body.invoicePdfUrl || body.eInvoicePdfUrl;
    // TODO: Ödeal'in başarısızlığı hangi alanla bildirdiği (ör. status/success)
    // teyit edilince buradaki tahmini kontrol gerçek değerlerle değiştirilmeli.
    const isFailure = body.success === false || /fail|hata|basarisiz|başarısız/i.test(String(body.status || ''));

    let payment = null;
    if (paymentId) payment = await prisma.payment.findUnique({ where: { id: paymentId } });

    if (!payment) {
      // Kredi Kartı ile ödemeler cihazda kasiyer tarafından bizim sepet API'mizden
      // GEÇMEDEN doğrudan okutulup fatura kesiliyor — bu yüzden referenceCode hiç
      // gelmiyor/eşleşmiyor. Yine de faturayı otomatik "Fatura (PDF)" alanına
      // düşürebilmek için son çare: siparisNo alanına (D2D sepet şemasında
      // teyit edilen gerçek alan, bkz. services/odeal.js) ya da açıklamada geçen
      // takip koduna (TKN-2026-0342 biçimi) göre cihazı buluyoruz. Bunun çalışması
      // için kasiyerin kart geçişinde cihazın sipariş no/açıklama alanına takip
      // kodunu yazması gerekiyor — yazılmazsa personel yine elle yükleyebilir,
      // akış bozulmaz.
      const siparisNo = String(body.siparisNo || '').trim().toUpperCase();
      const desc = String(body.description || body.orderDescription || body.note || body.explanation || '');
      const trackingMatch = /^TKN-\d{4}-\d{3,}$/i.test(siparisNo) ? [siparisNo] : desc.match(/TKN-\d{4}-\d{3,}/i);
      if (!trackingMatch) {
        console.warn('[odeal webhook] Ödeme kaydı (referenceCode) veya siparisNo/açıklamada takip kodu bulunamadı, eşleştirme yapılamadı.');
        return res.sendStatus(200); // Ödeal'in aynı isteği tekrar tekrar denemesini önlemek için 200 dönüyoruz
      }
      const deviceByTracking = await prisma.device.findUnique({ where: { trackingCode: trackingMatch[0].toUpperCase() } });
      if (!deviceByTracking) {
        console.warn(`[odeal webhook] Açıklamadaki takip koduna (${trackingMatch[0]}) sahip cihaz bulunamadı.`);
        return res.sendStatus(200);
      }
      if (isFailure) return res.sendStatus(200); // eşleşen ödeme kaydı yok, HATA işaretlenecek bir yer de yok
      const dataUrl = await extractInvoicePdfDataUrl(invoicePdfBase64, invoicePdfUrl);
      if (dataUrl) {
        await prisma.device.update({ where: { id: deviceByTracking.id }, data: { invoicePdf: dataUrl, invoiceUploadedAt: new Date() } });
        console.log(`[odeal webhook] Fatura, takip koduyla eşleşen cihaz ${deviceByTracking.id} (${trackingMatch[0]}) için otomatik kaydedildi.`);
      }
      return res.sendStatus(200);
    }

    if (isFailure) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: { invoiceStatus: 'HATA', invoiceError: (body.message || body.error || 'Ödeal fatura kesme bildirimi başarısız döndü').slice(0, 500) },
      });
      console.warn(`[odeal webhook] Fatura başarısız bildirildi (ödeme ${paymentId}).`);
      return res.sendStatus(200);
    }

    const dataUrl = await extractInvoicePdfDataUrl(invoicePdfBase64, invoicePdfUrl);

    if (dataUrl) {
      await prisma.$transaction([
        prisma.device.update({
          where: { id: payment.deviceId },
          data: { invoicePdf: dataUrl, invoiceUploadedAt: new Date() },
        }),
        prisma.payment.update({
          where: { id: paymentId },
          data: { invoiceStatus: 'KESILDI', invoiceError: null },
        }),
      ]);
      console.log(`[odeal webhook] Fatura, cihaz ${payment.deviceId} için otomatik kaydedildi (ödeme ${paymentId}).`);
    } else {
      // PDF gelmedi ama başarısızlık da bildirilmedi — muhtemelen ara bir ödeme
      // bildirimi (fatura ayrı bir webhook çağrısıyla gelecek). Durumu değiştirmeden
      // sadece logluyoruz, bir sonraki çağrı asıl PDF'i getirebilir.
      console.log(`[odeal webhook] Bu istekte fatura PDF'i yoktu (ödeme ${paymentId}) — muhtemelen ödeme/iptal bildirimi.`);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(`[odeal webhook] İşlenirken hata: ${e.message}`);
    res.sendStatus(200); // Ödeal'in sürekli tekrar denemesini önlemek için hata durumunda da 200 dönüyoruz
  }
});

module.exports = router;
