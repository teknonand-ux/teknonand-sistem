# Teknonand Yönetim Sistemi — Sistem Planı

## 1. Veritabanı Şeması

### customers (müşteriler)
| Alan | Tip | Açıklama |
|---|---|---|
| id | uuid | birincil anahtar |
| full_name | text | ad soyad |
| phone | text | WhatsApp mesajları için |
| email | text | opsiyonel |
| created_at | timestamp | kayıt tarihi |

### devices (cihazlar)
| Alan | Tip | Açıklama |
|---|---|---|
| id | uuid | birincil anahtar |
| customer_id | uuid → customers.id | |
| tracking_code | text (unique) | örn. TKN-2026-0342 |
| brand | text | Apple |
| model | text | iPhone 13 Pro vb. |
| imei_serial | text | |
| issue_description | text | müşterinin bildirdiği arıza |
| status | enum | aşağıya bakın |
| created_at / updated_at | timestamp | |

**status enum:** `received` (alındı) → `diagnosing` (inceleniyor) → `awaiting_parts` (parça bekliyor) → `in_repair` (tamir ediliyor) → `ready` (teslime hazır) → `delivered` (teslim edildi) — ayrıca `cancelled`

### device_status_history (durum geçmişi)
id, device_id → devices.id, status, note, changed_by (employee_id), changed_at
> Her durum değişikliğinde bir kayıt eklenir — hem portalda geçmiş göstermek hem de WhatsApp tetikleyicisi için kullanılır.

### repairs (tamir kayıtları)
id, device_id, technician_id, parts_cost, labor_cost, total_cost, started_at, completed_at

### payments (ödemeler)
id, device_id, amount, method (nakit/kart/havale), type (kapora/ara ödeme/final), paid_at

### stock_items (stok)
id, name, sku, category, quantity, min_threshold, unit_cost, supplier_id

### stock_movements (stok hareketleri)
id, stock_item_id, device_id (null olabilir), quantity_change, reason (kullanım/alım/iade), created_at

### suppliers (toptancılar)
id, name, phone, contact_person, current_balance

### supplier_transactions (toptancı cari hareketleri)
id, supplier_id, type (alım/ödeme), amount, description, created_at

### employees (çalışanlar)
id, name, role (teknisyen/kasiyer/yönetici), phone, email, active

### whatsapp_messages (mesaj kayıtları)
id, device_id, customer_id, template_type, content, status (gönderildi/okundu/başarısız), sent_at

---

## 2. Yönetici Paneli — Ekran Akışı

1. **Giriş (Dashboard)**: Bugün gelen cihazlar, teslime hazır olanlar, düşük stok uyarıları, günlük kasa özeti
2. **Cihaz Kabul**: Yeni müşteri/cihaz kaydı → otomatik tracking_code üretimi → müşteriye "Cihazınız alındı, takip kodunuz: XXX" WhatsApp mesajı
3. **Cihaz Listesi**: Durum filtreli liste (inceleniyor / parça bekliyor / tamirde / hazır), arama (isim, telefon, tracking kod, IMEI)
4. **Cihaz Detayı**: Durum güncelleme (dropdown) → her değişiklikte otomatik WhatsApp tetiklenir; kullanılan parça seçimi (stoktan düşer); ödeme girişi
5. **Stok Yönetimi**: Parça listesi, kritik seviye uyarıları, toptancıdan yeni alım girişi (stok artar + toptancı cari borcu artar)
6. **Toptancı Cari Hesap**: Her toptancı için borç/alacak dökümü, ödeme girişi
7. **Kasa/Ödemeler**: Günlük/haftalık tahsilat raporu
8. **WhatsApp Şablonları**: "Cihaz alındı", "Parça bekleniyor", "Teslime hazır" gibi hazır mesaj şablonlarını düzenleme

---

## 3. WhatsApp Business API Entegrasyonu

- Sağlayıcı önerisi: **360dialog** veya **Twilio** (Meta'nın resmi API'sine erişim sağlarlar, kurulumu Meta'nın doğrudan onay sürecinden daha hızlıdır)
- Tetikleyiciler: durum değişince otomatik mesaj (device_status_history tablosuna INSERT olunca)
- Şablon onayı: WhatsApp, önceden onaylanmış mesaj şablonları gerektirir (Meta Business Manager üzerinden başvurulur, genelde 1-3 gün sürer)

---

## 4. Önerilen Geliştirme Sırası

1. Veritabanı + yönetici panelinin temel modülleri (müşteri/cihaz/stok/ödeme)
2. Müşteri takip portalı (tracking_code ile sorgulama — bağımsız, basit)
3. WhatsApp Business API başvurusu (paralel başlatılmalı, onay süresi var)
4. WhatsApp otomatik bildirim entegrasyonu
5. Toptancı cari hesap modülü ve raporlama
