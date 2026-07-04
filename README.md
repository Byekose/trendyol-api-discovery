# Trendyol API Discovery Harness

Read-only "pazaryeri API gözlemevi": gerçek mağaza credential'ları ile Trendyol
Satıcı API'sinin tüm GET endpoint'lerini gezer, ham response'ları saklar,
şema çıkarır (field, tip, doluluk oranı, enum kümeleri) ve HTML rapor sunar.
finEcom'un canonical modelini gerçek veriye dayanarak tasarlamak için kullanılır.

**Güvenlik garantisi:** Kod tabanında hiçbir POST/PUT/DELETE yoktur.
`src/trendyol/client.js` içindeki tek fonksiyon `get()`tir ve method sabittir.
Bu servis mağaza verisine yazamaz.

## Railway kurulumu

1. Bu repo'yu GitHub'a push'la.
2. Railway → New Project → Deploy from GitHub repo.
3. Aynı projeye New → Database → PostgreSQL ekle.
4. Node servisinin **Variables** sekmesine:

| Değişken | Değer |
|---|---|
| `DATABASE_URL` | Postgres servisinden referans ver (`${{Postgres.DATABASE_URL}}`) |
| `TRENDYOL_SUPPLIER_ID` | Satıcı paneli → Hesap Bilgilerim → Entegrasyon Bilgileri |
| `TRENDYOL_API_KEY` | aynı ekrandan |
| `TRENDYOL_API_SECRET` | aynı ekrandan |
| `DASHBOARD_PASSWORD` | rapor ekranı için senin belirleyeceğin şifre |
| `DISCOVERY_DAYS` | (opsiyonel) varsayılan 90 |
| `CRON_ENABLED` | (opsiyonel) `true` → her gün 05:00'te otomatik toplar |

## Kullanım

- **İlk toplama:** `https://<servis>/run?password=ŞİFRE`
  Son 90 günü çeker; settlements 22 işlem tipi × 15 günlük pencerelerle
  gezildiği için 15-40 dakika sürebilir. 
- **İlerleme:** `https://<servis>/status?password=ŞİFRE`
- **Rapor:** `https://<servis>/report?password=ŞİFRE`

## Rapor ne gösterir

Her endpoint için: kayıt sayısı, başarılı/hatalı response oranı, field
tablosu (path, gözlenen tipler, doluluk %, distinct sayısı, enum değerleri,
maskelenmiş örnek) ve **önceki koşuya göre değişiklikler** (yeni field,
kaybolan field, enum'a eklenen değer). Müşteri adı/e-posta/adres/TCKN gibi
alanlar raporda maskelenir.

## Notlar

- Endpoint listesi `src/trendyol/endpoints.js` içinde tek yerde durur;
  Trendyol bir path değiştirirse tek satırlık düzeltmedir. Her kayıtta
  resmi doküman linki vardır.
- 400/404 dönen istekler de saklanır — "bu endpoint/parametre bu hesapta
  geçersiz" bilgisi de bir bulgudur, raporda hata örnekleri bölümünde görünür.
- Base URL: `https://apigw.trendyol.com/integration` (eski `api.trendyol.com`
  deprecated).
- Hepsiburada/ikas eklemek için: `endpoints.js` + `client.js` kopyası yeterli;
  analyzer ve reporter ortak çalışır.
