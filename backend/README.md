# Teknonand Backend

Node.js + Express + Prisma (PostgreSQL) REST API.

## Mimari özet

- **Veritabanı:** PostgreSQL. Şema `prisma/schema.prisma` içinde — `sistem-plani.md`
  ile prototip HTML ekranlarının (onay akışı, bayi cari hesabı, kasa/gider,
  etiket & belge ayarları) ihtiyaçları birleştirilerek genişletildi.
- **Kimlik doğrulama:** JWT. İki ayrı giriş uç noktası — personel
  (`/api/auth/employee-login`, yönetici paneli) ve bayi
  (`/api/auth/dealer-login`, bayi portalı). Şifreler bcrypt ile hash'lenir
  (prototipteki düz metin şifrelerin aksine).
- **Yetkilendirme:** `permission: ADMIN | RESTRICTED` alanı, panelin
  `admin-only` sayfalarına (Kasa, Kâr/Zarar, Etiket/Belge Tasarımı) erişimi
  sunucu tarafında da kısıtlar.
- **Herkese açık uç noktalar** (girişsiz, oran sınırlamalı):
  `POST /api/appointments` (randevu formu), `GET /api/track/:code` ve
  `POST /api/track/:code/approve` (cihaz takip + fiyat onayı).
- **Dosya/resim depolama:** Veritabanına gömülmez. `device_images.url` ve
  logo gibi alanlar için S3 uyumlu bir nesne depolama (ör. Cloudflare R2,
  ücretsiz katmanı var) kullanılması önerilir — Railway/Render'ın disk alanı
  yeniden deploy'da sıfırlanabilir.
- **WhatsApp:** `src/services/whatsapp.js` — WhatsApp Business Cloud API'yi
  (Meta) doğrudan kullanır. Durum değişiminde otomatik tetiklenir, mesajı
  `whatsapp_messages` tablosuna kaydeder. `WHATSAPP_ACCESS_TOKEN` ve
  `WHATSAPP_PHONE_NUMBER_ID` ile birlikte, gönderilen her durum/belge için
  Meta Business Manager'da onaylanmış bir şablon adı gerekir
  (`WHATSAPP_TEMPLATE_*` — bkz. `.env.example`). Bir şablon henüz onaylı
  değilse veya ortam değişkenleri eksikse gönderim `BASARISIZ` olarak
  loglanır, panel/takip portalı çalışmaya devam eder.
- **WhatsApp gelen kutusu:** `src/routes/whatsappInbox.js` — müşterinin
  numaramıza serbest metin yazması `POST /api/whatsapp/webhook` ile bize
  ulaşır (Meta App Dashboard > WhatsApp > Configuration > Webhook alanına
  bu servisin `/api/whatsapp/webhook` adresi ve `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
  girilmelidir). Konuşmalar `whatsapp_conversations`/`whatsapp_chat_messages`
  tablolarında tutulur, panelde "WhatsApp" sekmesinden görüntülenip
  yanıtlanır. Yanıtlar şablon gerektirmez ama yalnızca müşterinin son 24
  saat içinde yazdığı "customer service window" içindeyken gönderilebilir
  (Meta'nın kısıtı — bu pencere dışında deneme API'den hata döner).

## Yerel kurulum

```bash
cd backend
npm install
cp .env.example .env      # DATABASE_URL, JWT_SECRET vb. doldurun
npx prisma migrate dev --name init   # yerel/gerçek bir Postgres'e bağlıyken
npm run seed:admin        # ilk yönetici hesabını oluşturur (.env'deki SEED_ADMIN_*)
npm run dev
```

Sağlık kontrolü: `GET http://localhost:3000/health`

## API uç noktaları (özet)

| Alan | Uç noktalar |
|---|---|
| Auth | `POST /api/auth/employee-login`, `POST /api/auth/dealer-login` |
| Müşteriler | `GET/POST /api/customers`, `DELETE /api/customers/:id` |
| Cihazlar | `GET/POST /api/devices`, `POST /api/devices/bulk`, `GET /api/devices/:id`, `PATCH /api/devices/:id/status`, `POST /api/devices/:id/parts`, `POST /api/devices/:id/payments` |
| Stok | `GET/POST /api/stock`, `PATCH /api/stock/:id/adjust` |
| Toptancı | `GET/POST /api/suppliers`, `POST /api/suppliers/:id/payment` |
| Bayiler (panel) | `GET/POST /api/dealers`, `POST /api/dealers/:id/transactions` |
| Bayi portalı | `GET /api/dealers/me`, `GET /api/dealers/me/devices`, `POST /api/dealers/me/devices/:id/approve` |
| Personel | `GET/POST/PATCH/DELETE /api/employees` |
| Randevular | `POST /api/appointments` (public), `GET/POST /api/appointments` (panel) |
| Takip portalı | `GET /api/track/:code` (public), `POST /api/track/:code/approve` (public) |
| Ayarlar | `GET/PUT /api/settings/:key` (`exchangeRate`, `labelDesign`, `companyInfo`) |
| Raporlar | `GET /api/reports/cashbox`, `POST /api/reports/cashbox/expense`, `GET /api/reports/profit` |

Tüm panel/bayi uç noktaları `Authorization: Bearer <token>` header'ı bekler.

## Railway'e deploy

Bkz. proje kökündeki deploy rehberi (sohbet geçmişinde adım adım verildi) —
özetle: Railway'de bir Postgres eklentisi + bu `backend/` klasörünü kaynak
gösteren bir Node servisi oluşturulur, `DATABASE_URL` otomatik enjekte edilir,
diğer ortam değişkenleri (`JWT_SECRET`, `CORS_ORIGIN`, `SEED_ADMIN_*`,
WhatsApp Cloud API değişkenleri — bkz. `.env.example`) elle girilir.
