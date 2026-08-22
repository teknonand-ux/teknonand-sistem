require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const deviceRoutes = require('./routes/devices');
const stockRoutes = require('./routes/stock');
const supplierRoutes = require('./routes/suppliers');
const dealerRoutes = require('./routes/dealers');
const employeeRoutes = require('./routes/employees');
const appointmentRoutes = require('./routes/appointments');
const trackRoutes = require('./routes/track');
const settingsRoutes = require('./routes/settings');
const reportRoutes = require('./routes/reports');
const whatsappInboxRoutes = require('./routes/whatsappInbox');
const instagramInboxRoutes = require('./routes/instagramInbox');
const labelPrintJobRoutes = require('./routes/labelPrintJobs');
const { startExchangeRateScheduler } = require('./services/exchangeRateScheduler');

const app = express();

// Railway tek atlamalı bir ters vekil (reverse proxy) arkasında çalıştırıyor — bu
// olmadan express-rate-limit, X-Forwarded-For'u görüp gerçek istemci IP'sini doğru
// tespit edemediğini düşünüp hata fırlatıyordu (prod loglarında ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// olarak görüldü) ve oran sınırlama tüm istekleri aynı IP'ymiş gibi ele alabiliyordu.
app.set('trust proxy', 1);

app.use(helmet({
  // Bu servis yalnızca JSON döndürüyor, HTML sunmuyor — CSP/COEP tarayıcıda render
  // edilen sayfalar için anlamlıdır, burada gereksiz. CORP'u "cross-origin" yapıyoruz
  // çünkü panel/portallar farklı bir origin'den (GitHub Pages) bu API'ye fetch atıyor.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// NOT: CORS_ORIGIN şu an prod'da tanımlı değil (bkz. aşağıdaki uyarı) ve bunu kasıtlı
// olarak "fail-closed" yapmadık — personel panel/portalları çoğunlukla dosyayı
// tarayıcıda doğrudan çift tıklayarak (file://) açıyor, bu da tarayıcıda "Origin: null"
// gönderir ve GitHub Pages origin'ine kilitlenen bir allowlist bu kullanımı kırar. Ayrıca
// kimlik doğrulama çerez değil Authorization header/JWT ile yapıldığından (localStorage),
// gevşek CORS burada klasik CSRF riski taşımıyor — asıl risk XSS ile token çalınması,
// CORS'un koruyamayacağı bir senaryo. Personel tamamen hosted panel URL'sine geçerse
// CORS_ORIGIN=https://teknonand-ux.github.io olarak ayarlanıp sıkılaştırılabilir.
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
const allowAllOrigins = allowedOrigins.length === 0 || allowedOrigins.includes('*');
if (allowAllOrigins) {
  console.warn('[cors] CORS_ORIGIN tanımlı değil — API şu an TÜM originlerden erişime açık. Üretimde .env dosyasında CORS_ORIGIN ayarlayın.');
}
app.use(cors({ origin: allowAllOrigins ? true : allowedOrigins }));
// rawBody: WhatsApp/Instagram webhook imza doğrulaması (bkz. middleware/verifyMetaSignature)
// HMAC'i ham gövde baytları üzerinden hesaplamak zorunda — JSON.parse sonrası yeniden
// serialize edilen gövde Meta'nın imzasıyla birebir eşleşmeyebilir.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// Genel oran sınırlama — herkese açık uçlar (randevu, takip) kötüye kullanıma karşı ayrıca sınırlanır
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/dealers', dealerRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/track', trackRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/whatsapp', whatsappInboxRoutes);
app.use('/api/instagram', instagramInboxRoutes);
app.use('/api/label-print-jobs', labelPrintJobRoutes);

app.use((req, res) => res.status(404).json({ error: 'Uç nokta bulunamadı' }));
app.use(errorHandler);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Teknonand API ${port} portunda çalışıyor`));

startExchangeRateScheduler();
