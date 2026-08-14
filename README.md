# Teknonand Yönetim Sistemi

iPhone & iPad teknik servis işletmesi için cihaz takip, bayi portalı, randevu ve
yönetim paneli sistemi.

## Klasör yapısı

```
teknonand-sistem/
├── sistem-plani.md        # Orijinal veritabanı/akış planı
├── yonetici-paneli.html   # Yönetici paneli (prototip)
├── bayi-portali.html      # Bayi giriş/takip portalı (prototip)
├── takip-portali.html     # Müşteri cihaz takip sayfası (prototip)
├── randevu-al.html        # Herkese açık randevu formu (prototip)
└── backend/                # Node.js + Express + Prisma REST API
```

## ⚠️ Önemli: Frontend prototipleri henüz backend'e bağlı değil

`yonetici-paneli.html`, `bayi-portali.html`, `takip-portali.html` ve
`randevu-al.html` şu an `window.storage` adlı bir prototipleme API'si
kullanıyor (bu ortamın önizleme sandbox'ına özgü, gerçek tarayıcılarda
çalışmaz). Bu sayede tasarım ve akışlar hızlıca test edilebildi, ama gerçek
kullanıma açmadan önce bu dosyalardaki `window.storage.get/set` çağrılarının
`backend/`'deki REST API'ye (`fetch` ile) bağlanacak şekilde güncellenmesi
gerekiyor. Bu, ayrı bir sonraki adım — backend hazır olduğunda birlikte
yapabiliriz.

## Backend

Bkz. [`backend/README.md`](backend/README.md) kurulum ve mimari detayları için.

## Geliştirme sırası (sistem-plani.md § 4 ile uyumlu)

1. ✅ Veritabanı şeması + backend API (bu repo)
2. Frontend'lerin `window.storage` yerine gerçek API'yi kullanacak şekilde güncellenmesi
3. WhatsApp Business API başvurusu (360dialog / Twilio) — paralel başlatılmalı
4. WhatsApp otomatik bildirim entegrasyonu (`backend/src/services/whatsapp.js` içinde iskeleti hazır)
5. Barındırma (Railway) ve canlıya alma
