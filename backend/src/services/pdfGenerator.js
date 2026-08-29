const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

// PDFKit'in yerleşik "Helvetica" fontu WinAnsi kodlamasını kullanır ve Türkçe'ye
// özgü ı/İ/ş/Ş/ğ/Ğ karakterlerini içermez (panelde "bozuk yazı" olarak görülen buydu).
// Bu yüzden tüm metinler için Türkçe karakterleri de kapsayan Arial gömülü olarak kullanılır.
const FONT_REGULAR = path.join(__dirname, '..', 'assets', 'fonts', 'Roboto-Regular.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'Roboto-Bold.ttf');
const DEFAULT_LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');

const WARRANTY_LABELS = { 0: 'Garanti Yok', 1: '1 Ay', 3: '3 Ay', 6: '6 Ay', 12: '1 Yıl' };

// yonetici-paneli.html'deki WARRANTY_EXCLUSIONS ile birebir aynı — teslim formunda
// hangi kalemler için hangi garanti kapsam dışı metninin basılacağını belirler.
const WARRANTY_EXCLUSIONS = [
  {
    id: 'anakart',
    kw: ['anakart', 'kart tamiri', 'anakart tamiri'],
    title: 'Anakart Onarımı — 6 Ay Garanti Kapsam Dışı Koşullar',
    text: 'Anakart onarımı 6 (altı) ay garanti kapsamındadır. Cihazın sıvıyla temas etmesi, darbe alması veya düşürülmesi, kasa ya da ekranında deformasyon oluşması, onarım sonrasında tarafımızca takılan garanti etiketinin sökülmesi veya cihazın başka bir yetkisiz serviste açılması/müdahale görmesi durumlarında garanti kapsam dışı kalır.',
  },
  {
    id: 'ekran',
    kw: ['ekran', 'ön cam', 'on cam', 'arka cam', 'kamera camı', 'kamera cami'],
    title: 'Ekran / Cam Değişimi — 3 Ay Garanti Kapsam Dışı Koşullar',
    text: 'Ekran ve cam değişimleri 3 (üç) ay garanti kapsamındadır. Ekranın kırılması, camın çatlaması, kasada deformasyon oluşması, cihazın darbe alması veya sıvıyla teması, tarafımızca takılan garanti etiketinin koparılması ya da cihazın başka bir serviste açılması durumlarında garanti kapsam dışı kalır.',
  },
  {
    id: 'batarya',
    kw: ['batarya', 'pil'],
    title: 'Batarya Değişimi — 1 Yıl Garanti Kapsam Dışı Koşullar',
    text: 'Batarya değişimi 1 (bir) yıl garanti kapsamındadır. Bataryanın 1 yılı aşması, 350 şarj döngüsünün üzerine çıkması, başka bir serviste bataryaya müdahale edilmiş olması, cihazın sıvıyla teması veya tarafımızca takılan garanti etiketinin sökülmesi durumlarında garanti kapsam dışı kalır.',
  },
  {
    id: 'diger',
    kw: ['soket', 'film', 'titreşim', 'titresim', 'faceid', 'face id', 'sensör', 'sensor'],
    kwKamera: true,
    title: 'Soket / Film / Kamera / Titreşim / Face ID / Sensör Değişimi — 3 Ay Garanti Kapsam Dışı Koşullar',
    text: 'Soket, film, kamera, titreşim motoru, Face ID ve sensör değişimleri 3 (üç) ay garanti kapsamındadır. Cihazın sıvıyla teması, darbe alması, başka bir serviste işlem görmesi veya tarafımızca takılan garanti etiketinin sökülmesi durumlarında garanti kapsam dışı kalır.',
  },
];

function detectWarrantyExclusions(parts) {
  const matchedIds = new Set();
  (parts || []).forEach((p) => {
    const n = (p.name || '').toLowerCase();
    WARRANTY_EXCLUSIONS.forEach((group) => {
      if (group.kw.some((k) => n.includes(k))) matchedIds.add(group.id);
      else if (group.kwKamera && n.includes('kamera') && !n.includes('kamera cam')) matchedIds.add(group.id);
    });
  });
  return WARRANTY_EXCLUSIONS.filter((g) => matchedIds.has(g.id));
}

function lineGross(part) {
  const price = Number(part.price) || 0;
  return part.vatMode === 'HARIC' ? price * 1.2 : price;
}

// Device (customer, parts, payments, statusHistory dahil) + companyInfo/companyLogo
// ayarlarından "Cihaz Teslim Formu" PDF'ini oluşturup Buffer olarak döner.
function buildDeliveryFormPdfBuffer(device, companyInfo, companyLogoDataUrl) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A5', margin: 28 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Not: font'u 'Helvetica' adıyla kaydedip standart fontun yerine geçirmek
      // işe yaramıyor — PDFKit bu ismi WinAnsi kodlamalı yerleşik font olarak
      // özel durum kabul edip Türkçe karakterleri yine bozuyor. Bu yüzden ayrı
      // isimlerle kaydedip aşağıdaki tüm doc.font(...) çağrılarında bunları kullanıyoruz.
      doc.registerFont('Body', FONT_REGULAR);
      doc.registerFont('Body-Bold', FONT_BOLD);

      const parts = device.parts || [];
      const total = parts.reduce((s, p) => s + lineGross(p), 0);
      const paid = (device.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
      const remaining = total - paid;
      // SHIPPED (kargoya verildi) fiilen teslim sayılır — DELIVERED yoksa ona bakılır.
      const deliveredEntries = (device.statusHistory || []).filter((h) => h.status === 'DELIVERED' || h.status === 'SHIPPED');
      const deliveredEntry = deliveredEntries.sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt))[0];
      const deliveredAt = deliveredEntry ? new Date(deliveredEntry.changedAt).toLocaleString('tr-TR') : '—';
      const exclusions = detectWarrantyExclusions(parts);

      // Başlık — logo (varsa) + firma bilgileri
      let headerY = doc.y;
      try {
        // Panelde de aynı mantık kullanılır (bkz. yonetici-paneli.html companyLogo):
        // özel logo yüklenmemişse varsayılan logo.png'ye düşülür.
        const imgBuf =
          companyLogoDataUrl && companyLogoDataUrl.startsWith('data:image')
            ? Buffer.from(companyLogoDataUrl.split(',')[1], 'base64')
            : fs.readFileSync(DEFAULT_LOGO_PATH);
        doc.image(imgBuf, doc.x, headerY, { height: 34 });
      } catch (e) {
        /* logo bozuksa sessizce atla */
      }
      const textX = doc.x + 50;
      doc.fontSize(13).font('Body-Bold').text(companyInfo.name || 'Teknonand', textX, headerY, { width: 300 });
      const infoLines = [companyInfo.address, [companyInfo.phone, companyInfo.email].filter(Boolean).join(' · '), companyInfo.tax ? 'Vergi: ' + companyInfo.tax : ''].filter(Boolean);
      doc.fontSize(8).font('Body').fillColor('#666');
      infoLines.forEach((l) => doc.text(l, textX, doc.y, { width: 300 }));
      doc.fillColor('#000');
      doc.moveDown(1);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.6);

      doc.fontSize(14).font('Body-Bold').text('Cihaz Teslim Formu');
      doc.fontSize(9).font('Body').fillColor('#666').text(`Kayıt No: ${device.trackingCode} · Teslim Tarihi: ${deliveredAt}`);
      doc.fillColor('#000');
      doc.moveDown(0.8);

      doc.fontSize(9).font('Body-Bold').text('Müşteri: ', { continued: true }).font('Body').text(device.customer.fullName || '—');
      doc.font('Body-Bold').text('Telefon: ', { continued: true }).font('Body').text(device.customer.phone || '—');
      doc.font('Body-Bold').text('Cihaz: ', { continued: true }).font('Body').text(device.model || '—');
      doc.font('Body-Bold').text('IMEI / Seri No: ', { continued: true }).font('Body').text(device.imeiSerial || '—');
      doc.moveDown(0.6);
      doc.font('Body-Bold').text('Arıza:');
      doc.font('Body').text(device.issueDescription || '—', { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
      doc.moveDown(0.8);

      // Parçalar tablosu
      doc.font('Body-Bold').fontSize(9);
      const colX = { name: doc.page.margins.left, warranty: 210, price: 290 };
      const tableTop = doc.y;
      doc.text('Yapılan İşlem', colX.name, tableTop, { width: 175 });
      doc.text('Garanti', colX.warranty, tableTop, { width: 75 });
      doc.text('Fiyat', colX.price, tableTop, { width: 80 });
      doc.moveDown(0.3);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.2);
      doc.font('Body').fontSize(9);
      if (parts.length) {
        parts.forEach((p) => {
          const rowY = doc.y;
          doc.text(p.name, colX.name, rowY, { width: 175 });
          doc.text(WARRANTY_LABELS[p.warrantyMonths] ?? '—', colX.warranty, rowY, { width: 75 });
          doc.text(`₺${lineGross(p).toFixed(2)}`, colX.price, rowY, { width: 80 });
          doc.moveDown(0.4);
        });
      } else {
        doc.fillColor('#999').text('Kayıtlı işlem yok');
        doc.fillColor('#000');
      }
      doc.moveDown(0.4);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.4);

      // Tablo satırları sabit x koordinatlarıyla (colX.price) basıldığı için doc.x o
      // noktada kalır — burada x/width açıkça verilmezse hem bu satır hem de altındaki
      // başlıklar sayfanın sağına kayıp dar bir alana sıkışıyordu (Garanti Kapsam Dışı
      // Koşullar'ın görünmemesinin sebebi buydu).
      const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.font('Body-Bold').fontSize(10).text(
        `Toplam: ₺${total.toFixed(2)}   ·   Ödenen: ₺${paid.toFixed(2)}   ·   Kalan: ₺${remaining.toFixed(2)}`,
        doc.page.margins.left, doc.y, { width: contentWidth, align: 'right' }
      );
      doc.moveDown(0.8);

      if (exclusions.length) {
        doc.font('Body-Bold').fontSize(9).text('Garanti Kapsam Dışı Koşullar', doc.page.margins.left, doc.y, { width: contentWidth });
        doc.moveDown(0.2);
        exclusions.forEach((g) => {
          doc.font('Body-Bold').fontSize(7.5).text(g.title, doc.page.margins.left, doc.y, { width: contentWidth });
          doc.font('Body').fontSize(7.5).fillColor('#444').text(g.text, doc.page.margins.left, doc.y, { width: contentWidth });
          doc.fillColor('#000');
          doc.moveDown(0.4);
        });
      }

      doc.moveDown(1);
      const signY = doc.y;
      doc.fontSize(8).fillColor('#666');
      doc.text('Teslim Eden (Teknonand)', doc.page.margins.left, signY);
      doc.text('Teslim Alan (Müşteri)', doc.page.width - doc.page.margins.right - 150, signY, { width: 150, align: 'right' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Bir toptancıdan, verilen tarih aralığında alınan stok kalemlerinin (stok
// girişleri + doğrudan cihaza toptancı seçilerek eklenen parçalar) dökümünü
// PDF olarak üretir. items: [{ name, costUsd, date, employeeName }] — çağıran
// taraf (suppliers.js) stok kalemleri ile cihaz parçalarını birleştirip tarihe
// göre sıralamış halde verir. Cihaz takip kodu kasıtlı olarak basılmaz
// (toptancıyı ilgilendirmez); maliyet yalnızca dolar cinsinden yazılır — TL
// girilip dolar karşılığı hiç kaydedilmemiş kalemlerde "—" gösterilir (TL->$
// dönüşümü o anki kura göre yanıltıcı olabileceğinden tahmini bir çevrim
// yapılmaz). employeeName yalnızca cihaza doğrudan eklenen parçalarda vardır —
// genel stok girişinde personel kaydı tutulmadığından "—" basılır.
function buildSupplierStockPdfBuffer(supplier, items, from, to, companyInfo, companyLogoDataUrl) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.registerFont('Body', FONT_REGULAR);
      doc.registerFont('Body-Bold', FONT_BOLD);

      let headerY = doc.y;
      try {
        const imgBuf =
          companyLogoDataUrl && companyLogoDataUrl.startsWith('data:image')
            ? Buffer.from(companyLogoDataUrl.split(',')[1], 'base64')
            : fs.readFileSync(DEFAULT_LOGO_PATH);
        doc.image(imgBuf, doc.x, headerY, { height: 34 });
      } catch (e) {
        /* logo bozuksa sessizce atla */
      }
      const textX = doc.x + 50;
      doc.fontSize(13).font('Body-Bold').text(companyInfo.name || 'Teknonand', textX, headerY, { width: 300 });
      const infoLines = [companyInfo.address, [companyInfo.phone, companyInfo.email].filter(Boolean).join(' · '), companyInfo.tax ? 'Vergi: ' + companyInfo.tax : ''].filter(Boolean);
      doc.fontSize(8).font('Body').fillColor('#666');
      infoLines.forEach((l) => doc.text(l, textX, doc.y, { width: 300 }));
      doc.fillColor('#000');
      doc.moveDown(1);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.6);

      doc.fontSize(14).font('Body-Bold').text('Toptancı Stok Kalemleri Dökümü');
      doc.fontSize(9).font('Body').fillColor('#666').text(`Toptancı: ${supplier.name} · Tarih Aralığı: ${from} — ${to}`);
      doc.fillColor('#000');
      doc.moveDown(0.8);

      const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.font('Body-Bold').fontSize(9);
      const colX = {
        name: doc.page.margins.left,
        employee: doc.page.margins.left + contentWidth - 260,
        cost: doc.page.margins.left + contentWidth - 160,
        date: doc.page.margins.left + contentWidth - 90,
      };
      const tableTop = doc.y;
      doc.text('Parça', colX.name, tableTop, { width: colX.employee - colX.name - 10 });
      doc.text('Personel', colX.employee, tableTop, { width: 100 });
      doc.text('Maliyet ($)', colX.cost, tableTop, { width: 70 });
      doc.text('İşlem Tarihi', colX.date, tableTop, { width: 90 });
      doc.moveDown(0.3);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.2);

      doc.font('Body').fontSize(9);
      let totalUsd = 0;
      if (items.length) {
        items.forEach((item) => {
          const rowY = doc.y;
          doc.text(item.name, colX.name, rowY, { width: colX.employee - colX.name - 10 });
          doc.text(item.employeeName || '—', colX.employee, rowY, { width: 100 });
          if (item.costUsd != null) {
            doc.text(`$${Number(item.costUsd).toFixed(2)}`, colX.cost, rowY, { width: 70 });
            totalUsd += Number(item.costUsd);
          } else {
            doc.text('—', colX.cost, rowY, { width: 70 });
          }
          doc.text(new Date(item.date).toLocaleDateString('tr-TR'), colX.date, rowY, { width: 90 });
          doc.moveDown(0.4);
        });
      } else {
        doc.fillColor('#999').text('Bu tarih aralığında kayıt yok');
        doc.fillColor('#000');
      }
      doc.moveDown(0.4);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.4);

      doc.font('Body-Bold').fontSize(10).text(`Toplam: $${totalUsd.toFixed(2)}`, doc.page.margins.left, doc.y, { width: contentWidth, align: 'right' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildDeliveryFormPdfBuffer, buildSupplierStockPdfBuffer };
