const express = require('express');
const { prisma } = require('../lib/prisma');

const router = express.Router();

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
    if (expectedToken && req.query.token !== expectedToken) {
      console.warn('[odeal webhook] Geçersiz/eksik token ile istek, reddedildi.');
      return res.sendStatus(401);
    }
    if (!expectedToken) {
      console.warn('[odeal webhook] ODEAL_WEBHOOK_TOKEN tanımlı değil — doğrulama atlanıyor, bu adres şu an korumasız.');
    }

    const body = req.body || {};
    console.log('[odeal webhook] Gelen istek:', JSON.stringify(body).slice(0, 2000));

    // TODO: Gerçek alan adları Ödeal API referansı görülünce teyit edilmeli.
    // requestInvoiceForPayment'ın gönderdiği externalReferenceId, Ödeal'in
    // bunu olduğu gibi geri yansıttığı varsayımıyla ödeme kaydını eşleştirmek
    // için kullanılıyor.
    const paymentId = body.externalReferenceId || body.paymentId;
    const invoicePdfBase64 = body.invoicePdfBase64 || body.eInvoicePdfBase64;
    const invoicePdfUrl = body.invoicePdfUrl || body.eInvoicePdfUrl;
    // TODO: Ödeal'in başarısızlığı hangi alanla bildirdiği (ör. status/success)
    // teyit edilince buradaki tahmini kontrol gerçek değerlerle değiştirilmeli.
    const isFailure = body.success === false || /fail|hata|basarisiz|başarısız/i.test(String(body.status || ''));

    if (!paymentId) {
      console.warn('[odeal webhook] externalReferenceId/paymentId alanı bulunamadı, eşleştirme yapılamadı.');
      return res.sendStatus(200); // Ödeal'in aynı isteği tekrar tekrar denemesini önlemek için 200 dönüyoruz
    }

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      console.warn(`[odeal webhook] Eşleşen ödeme kaydı bulunamadı: ${paymentId}`);
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

    let dataUrl = null;
    if (invoicePdfBase64) {
      dataUrl = `data:application/pdf;base64,${invoicePdfBase64}`;
    } else if (invoicePdfUrl) {
      const pdfRes = await fetch(invoicePdfUrl);
      if (pdfRes.ok) {
        const buf = Buffer.from(await pdfRes.arrayBuffer());
        dataUrl = `data:application/pdf;base64,${buf.toString('base64')}`;
      } else {
        console.error(`[odeal webhook] Fatura PDF'i indirilemedi (HTTP ${pdfRes.status}): ${invoicePdfUrl}`);
      }
    }

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
