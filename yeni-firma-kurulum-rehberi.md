# Yeni Firma İçin Kurulum Rehberi

Bu sistemi başka bir firmaya (kendi GitHub + Railway hesabıyla, kendi WhatsApp
hattıyla) tamamen bağımsız bir kopya olarak kurmak için izlenecek adımlar.
Backend (`GET/POST /api/...`) ve frontend (HTML dosyaları) ayrı ayrı deploy
edilir — bu rehber ikisini de kapsar.

## 1. Kod tarafı: yeni bir depoya kopyala

1. Bu repoyu yeni firmanın kendi GitHub hesabında/organizasyonunda **yeni bir
   depo** olarak oluşturun (fork değil — firmalar arası bağımsız kalmalı).
   Yerelde: `git clone` edip `origin` remote'unu yeni deponun adresine
   çevirin, sonra `git push`.
2. `backend/prisma/migrations/` klasörünü olduğu gibi koruyun — şema geçmişi
   bozulmamalı.

## 2. Marka / metin değişiklikleri

Aşağıdaki dosya ve satırlarda "Teknonand" adı ve sabit telefon numarası
geçiyor, yeni firmaya göre değiştirilmeli:

| Dosya | Ne değişecek |
|---|---|
| `logo.png`, `icon-192.png`, `icon-512.png` | Firmanın kendi logosuyla değiştirilir (aynı dosya adlarını koruyun, kod bunlara referans veriyor) |
| `yonetici-paneli.html`, `bayi-portali.html`, `takip-portali.html`, `randevu-al.html` | `<title>`, `apple-mobile-web-app-title`, header'daki marka adı, WhatsApp mesaj şablon metinleri (`Teknonand — ...` ile başlayan metinler) |
| `gizlilik-politikasi.html` | Tamamı firma adına/işine göre yeniden yazılmalı (KVKK/gizlilik metni firma-özel) |
| `manifest.json`, `manifest-panel.json` | `name`/`short_name` alanları |
| `backend/src/index.js` (satır ~111) | Konsol log mesajı — kozmetik, isterseniz değiştirin |

> Not: Firma adı, telefon, adres, vergi bilgisi ve logo aslında **panelden de
> girilebiliyor** (Ayarlar > Belge Tasarımı — `AppSetting` tablosunda
> saklanır, kod değişikliği gerekmez). Yukarıdaki liste yalnızca sayfa
> başlıkları / sabit metinler gibi koddaki yerler için.

## 3. Railway kurulumu (backend + veritabanı)

1. Yeni bir Railway projesi açın (firmanın kendi hesabında).
2. **Postgres** eklentisini ekleyin — `DATABASE_URL` otomatik enjekte edilir.
3. Yeni bir **Node servisi** ekleyin, kaynak olarak yukarıda oluşturduğunuz
   GitHub deposunu gösterin, **Root Directory: `/backend`** olarak ayarlayın.
   Build otomatik algılanır (Railpack, `npm run build` → `prisma generate`).
   Start komutu zaten `package.json`'da tanımlı:
   `prisma migrate deploy && node src/index.js` — yani her deploy'da
   migration'lar otomatik uygulanır.
4. `backend/.env.example` dosyasındaki değişkenleri servise girin. En
   kritik olanlar:
   - `JWT_SECRET` — yeni, uzun, rastgele bir değer (asla eski projeyle aynı
     olmasın)
   - `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` — ilk yönetici girişi
   - `CORS_ORIGIN` — frontend'in barınacağı adres (bkz. 5. adım)
   - WhatsApp/Instagram değişkenleri — bkz. 4. adım
   - `SUPPLIER_STOCK_PDF_EXTRA_PHONE` — toptancı stok dökümünün ayrıca
     gönderileceği sabit ofis/muhasebe hattı; istemiyorsanız boş bırakın
     (o zaman yalnızca "toptancıya gönder" seçeneği çalışır)
5. İlk deploy sonrası panelden `SEED_ADMIN_USERNAME`/`SEED_ADMIN_PASSWORD`
   ile giriş yapıp yeni bir yönetici hesabı oluşturup o şifreyi değiştirmeniz
   önerilir (`npm run seed:admin` betiği ilk açılışta bir kez çalışır).

## 4. WhatsApp / Instagram (Meta) kurulumu — firmanın kendi hattı

Bu adım tamamen Meta for Developers üzerinden, firmanın kendi Business
hesabıyla yapılır — kod tarafında sadece env değişkenleri değişir:

1. Meta for Developers'da yeni bir **Uygulama** oluşturun (WhatsApp Business
   Cloud API ürünü eklenmiş).
2. `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_BUSINESS_ACCOUNT_ID` değerlerini alıp Railway'e girin.
3. **Şablonlar (templates):** `backend/src/services/whatsapp.js` içindeki
   `CLOUD_API_TEMPLATES` / `DEALER_CLOUD_API_TEMPLATES` her şablon için kaç
   parametre (değişken) gönderdiğini sabitler. Yeni firma Meta Business
   Manager'da **aynı sayıda değişkene sahip** kendi şablonlarını oluşturup
   onaylatmalı, sonra şablon *adlarını* `.env`'deki `WHATSAPP_TEMPLATE_*`
   değişkenlerine yazmalı. Metin içeriği farklı olabilir, değişken sayısı ve
   sırası aynı kalmalı — aksi halde gönderim Meta tarafından reddedilir.
4. Webhook (gelen mesajlar için): App Settings'te webhook URL'i
   `https://<yeni-backend-adresi>/api/whatsapp/webhook` olarak girilir,
   doğrulama token'ı `WHATSAPP_WEBHOOK_VERIFY_TOKEN` ile eşleşmeli. Aynı
   şekilde Instagram DM'leri için `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` ve
   `/api/instagram/webhook`.
5. **App Secret'lar** (`WHATSAPP_APP_SECRET`, `INSTAGRAM_APP_SECRET`):
   Meta App Dashboard > App Settings > Basic > "App Secret" alanından
   alınır — webhook isteklerinin gerçekten Meta'dan geldiğini doğrulamak
   için kullanılır. Boş bırakılırsa doğrulama atlanır ama bu güvenlik
   açısından önerilmez.

## 5. Frontend barındırma

Panel/portal HTML dosyaları (`yonetici-paneli.html` vb.) sabit kod içinde
backend adresine (`API_BASE`) `fetch` ile bağlanır — statik dosya olarak
her yerde barındırılabilir:

1. `bayi-portali.html`, `randevu-al.html`, `yonetici-paneli.html`,
   `takip-portali.html` içindeki `const API_BASE = '...'` satırını yeni
   Railway backend'inin genel (public) adresiyle güncelleyin
   (`https://<yeni-servis>.up.railway.app/api`).
2. Deponun GitHub ayarlarından **Pages**'i açın (Settings > Pages > Deploy
   from a branch, `main` / kök dizin) — dosyalar otomatik yayınlanır.
   Alternatif: herhangi bir statik barındırma (Netlify, Cloudflare Pages)
   veya personel dosyayı bilgisayarında `file://` olarak da açabilir (kod
   buna göre `Origin: null` istekleri CORS'ta serbest bırakıyor).
3. Backend'deki `CORS_ORIGIN` değişkenini bu adrese göre ayarlayın (birden
   fazla origin virgülle ayrılabilir).

## 6. İlk açılış kontrol listesi

- [ ] 4 HTML dosyasında `API_BASE` yeni backend'i gösteriyor
- [ ] Logo/ikon dosyaları değiştirildi
- [ ] `gizlilik-politikasi.html` firmaya göre güncellendi
- [ ] Railway: Postgres + backend servisi ayakta, `/health` 200 dönüyor
- [ ] İlk yönetici girişi yapıldı, panelden firma adı/logo/adres girildi
      (Ayarlar > Belge Tasarımı)
- [ ] WhatsApp şablonları Meta'da onaylandı, isimleri `.env`'e girildi
- [ ] Webhook'lar Meta'da tanımlandı, `WHATSAPP_APP_SECRET`/
      `INSTAGRAM_APP_SECRET` girildi (bkz. imza doğrulaması notu — bu
      secret'lar zaman zaman Meta tarafında yenilenebilir, webhook mesajları
      aniden gelmemeye başlarsa ilk kontrol edilecek yer burasıdır)
