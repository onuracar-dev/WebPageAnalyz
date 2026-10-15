# WebPage Analyzer Lite (WPA Lite)

WebPage Analyzer'ın (WPA) hafif, herkese açık demo sürümünün arka yüzü (backend). Kullanıcı girişi, veritabanı, Redis, kuyruk servisi (pg-boss), abonelik, ödeme ve AI bağımlılığı bulunmaz.

Ziyaretçi bir URL girer, siteyi test etme yetkisine sahip olduğuna dair yasal onay kutusunu işaretler, tarama kuyruğa alınır ve sonuçlar ekranda sunulur.

---

## Dahil Motorlar

Yalnızca DNS veya alan adı sahiplik doğrulaması gerektirmeyen, doğrudan kamuya açık bağlantı ile çalışabilen motorlar dahildir:

| Motor | Tanım | Harici Servis |
|---|---|---|
| **lighthouse** | Chromium tabanlı performans, erişilebilirlik, en iyi pratikler ve SEO denetimi. | Hayır |
| **axe** | Puppeteer ve `@axe-core/puppeteer` ile otomatik WCAG erişilebilirlik kural kontrolleri. | Hayır |
| **yellowLab** | Yellow Lab Tools genel API'si üzerinden frontend kod kalitesi, DOM ve JavaScript denetimi. | Evet (Public API) |
| **wpaPage** | Playwright ile masaüstü ve mobil ekranlarda sayfa içi DOM, meta etiketler, render edilen bağlantılar ve çalışma zamanı teşhisleri. | Hayır |
| **performancePlus** | Playwright ile Core Web Vitals ölçümleri (LCP, CLS, long task süreleri). | Hayır |
| **advancedGeo** | Schema.org JSON-LD yapılandırılmış veri geçerliliği ve arama motoru/yapay zeka crawler erişim direktifleri denetimi. | Hayır |
| **visualUx** | Masaüstü ve mobil ekranlarda görsel kararlılık, öğe boyutları ve viewport uyumluluğu. | Hayır |

---

## Hariç Tutulan Motorlar ve Nedenleri

Aşağıdaki motorlar WPA Lite kapsamı dışındadır ve dahil edilmemiştir:

- **crawler** (`full_site_crawl`): Bütün bir sitenin taranması yüksek kaynak tüketir ve alan adı sahipliği doğrulaması (`verified_origin`) gerektirir.
- **zapBaseline** (`passive_security`): OWASP ZAP arka plan servisi gerektirir ve doğrulanmış alan adları için tasarlanmıştır.
- **journey** (`journey_test`): Çok adımlı kullanıcı akışları doğrulanmış yetki gerektirir.
- **osvScanner** (`source_audit`): Kaynak kod analizi olup dosya/zip yüklemesi gerektirir.
- **AI Remediation, Expert Review, Monitoring, White-label**: Harici AI modelleri, veritabanı kaydı ve arka plan periyodik izleme gerektirir.

---

## Güvenlik ve SSRF Koruması

Herkese açık bir URL tarama servisi olduğundan SSRF (Server-Side Request Forgery) koruması zorunludur:

- **`security/url-safety.js`**:
  - Yalnızca `http:` ve `https:` şemalarına izin verilir.
  - Özel IP blokları (10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, IPv6 ULA/bağlantı yerel), `localhost`, tek etiketli alan adları ve izin verilmeyen portlar engellenir.
- **`security/safe-proxy.js`**:
  - Tarayıcı motorlarının yaptığı tüm dış ağ istekleri, yerel ağa ve izin verilmeyen hedeflere erişimi engelleyen güvenli proxy üzerinden yönlendirilir.
- **Rate Limit ve Ters Proxy**:
  - `POST /api/scans` uç noktası IP başına saatte varsayılan 3 istek ile sınırlandırılmıştır (`RATE_LIMIT_PER_HOUR`).
  - Nginx veya benzeri bir ters proxy arkasında çalışırken `TRUST_PROXY=1` (veya `true`) ayarlanmalıdır; aksi halde ters proxy arkasındaki tüm istemciler tek bir IP olarak algılanır.
- **CORS Politikası**:
  - Production ortamında `ALLOWED_ORIGIN` tanımlı değilse cross-origin isteklere izin verilmez (fail-closed). Development ortamında varsayılan `http://localhost:5173` kökenine izin verilir.
- **Onay Kaydı (Consent Logging)**:
  - Kullanıcının açık onayı olmadan tarama başlatılamaz (`CONSENT_REQUIRED`).
  - İstemci IP adresi ham olarak saklanmaz veya loglanmaz; `CONSENT_SALT` ile hash'lenmiş sha256 özeti olarak stdout'a kaydedilir. Production ortamında `CONSENT_SALT` tanımlı değilse sunucu güvenlik nedeniyle başlatılmaz.
- **Hata Mesajı Gizliliği**:
  - Public API yanıtlarında çalışma zamanı stack trace, ANSI kodları veya tarayıcı çağrı logları istemciye sızdırılmaz; istemciye sabit ve güvenli hata kodları/mesajları dönülür, ayrıntılar yalnızca sunucu log'una yazılır.

---

## Bellek ve Kuyruk Mimarisi

Düşük kaynaklı VDS ortamları için optimize edilmiştir:

- **Eşzamanlılık**: Bellek içi kuyruk aynı anda en fazla 1 tarama çalıştırır (`SCAN_CONCURRENCY=1`).
- **Kapasite**: Kuyrukta en fazla 5 iş bekleyebilir (`MAX_QUEUE=5`); kuyruk doluyken gelen istekler `429 QUEUE_FULL` döner.
- **Deduplikasyon**: Aynı URL için zaten kuyrukta veya çalışmakta olan bir tarama varsa yeni iş açılmaz, mevcut tarama kimliği döndürülür.
- **Host Cooldown & Sonuç Önbelleği**:
  - Aynı host (hostname) için `HOST_COOLDOWN_MS` (varsayılan 10 dk) içinde en fazla 1 yeni tarama başlatılabilir.
  - Cooldown süresi içinde aynı URL için bellekte tamamlanmış bir sonuç varsa yeni iş açılmaz, doğrudan `200 { id, status: 'completed', cached: true }` döner (günlük kotayı harcamaz).
  - Cooldown süresi içinde aynı host'un farklı bir URL'si istenirse `429 HOST_COOLDOWN` yanıtı ve `retryAfterSeconds` süresi döndürülür.
- **Günlük Global Limit**: Sistem genelinde günde en fazla `DAILY_SCAN_LIMIT` (varsayılan 200) yeni tarama başlatılabilir. Sayaç UTC gün değişiminde sıfırlanır; limit dolduğunda `429 DAILY_LIMIT_REACHED` döner.
- **Saklanan Sonuç Sınırı**: Biten taramalar bellekte en fazla `MAX_STORED_RESULTS` (varsayılan 100) adede kadar tutulur; sınır aşıldığında en eski tamamlanmış iş silinir. Bekleyen veya çalışmakta olan işler asla silinmez.
- **Zaman Aşımları**:
  - Browser lane motorları (Lighthouse 180s, Axe 90s, WpaPage 120s, AdvancedBrowser 150s) VDS kaynaklarını korumak amacıyla sıralı çalıştırıldığından, toplam tarama zaman aşımı `SCAN_TIMEOUT_MS` bu sürelerin toplamını karşılayacak şekilde varsayılan 8 dakika (480000 ms) olarak ayarlanmıştır.
  - Her motor kendi zaman aşımı bütçesiyle çalışır (`LIGHTHOUSE_TIMEOUT_MS`, `AXE_TIMEOUT_MS`, `YELLOWLAB_TIMEOUT_MS`, `WPAPAGE_TIMEOUT_MS`, `ADVANCED_BROWSER_TIMEOUT_MS`); bir motor hata verdiğinde veya zaman aşımına uğradığında diğer motorlar etkilenmez.
- **Sonuç ve Disk Temizliği**: Tamamlanan veya başarısız olan sonuçlar bellekte 30 dakika saklanır (`RESULT_TTL_MS`), ardından otomatik silinir. Disk üzerinde oluşturulan geçici rapor dosyaları tarama bittiği anda derhal kaldırılır.
- Restart olursa kuyruk ve sonuçlar kaybolur (bilinçli tercih, bellek içi demo).

---

## Ortam Değişkenleri (Environment Variables)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `8080` | Sunucunun dinleyeceği port. |
| `HOST` | `0.0.0.0` | Sunucunun dinleyeceği adres. |
| `NODE_ENV` | `production` | Çalışma ortamı (`production` / `development` / `test`). |
| `ALLOWED_ORIGIN` | `""` | CORS için izin verilen istemci origin'i. Production'da boşsa cross-origin engellenir. |
| `TRUST_PROXY` | `false` | Ters proxy (Nginx vb.) arkasında çalışıyorsa `true` veya `1` olmalıdır. |
| `RATE_LIMIT_PER_HOUR` | `3` | IP başına saatlik maksimum tarama isteği. |
| `HOST_COOLDOWN_MS` | `600000` | Aynı host (hostname) için iki tarama arasındaki bekleme süresi (ms, 10 dk). |
| `DAILY_SCAN_LIMIT` | `200` | Günlük global yeni tarama üst limiti (UTC gün değişiminde sıfırlanır). |
| `MAX_STORED_RESULTS` | `100` | Bellekte saklanacak maksimum bitmiş tarama sonucu sayısı (aşılınca en eski silinir). |
| `SCAN_CONCURRENCY` | `1` | Eşzamanlı çalıştırılacak tarama sayısı. |
| `MAX_QUEUE` | `5` | Kuyrukta bekleyebilecek maksimum tarama sayısı. |
| `RESULT_TTL_MS` | `1800000` | Tamamlanan tarama sonucunun bellekte tutulma süresi (ms, 30 dk). |
| `SCAN_TIMEOUT_MS` | `480000` | Bir taramanın toplam maksimum süresi (ms, 8 dk). |
| `LIGHTHOUSE_TIMEOUT_MS` | `180000` | Lighthouse motoru zaman aşımı (ms, 180 sn). |
| `AXE_TIMEOUT_MS` | `90000` | Axe motoru zaman aşımı (ms, 90 sn). |
| `YELLOWLAB_TIMEOUT_MS` | `150000` | YellowLab motoru zaman aşımı (ms, 150 sn). |
| `WPAPAGE_TIMEOUT_MS` | `120000` | WPA Page motoru zaman aşımı (ms, 120 sn). |
| `ADVANCED_BROWSER_TIMEOUT_MS` | `150000` | Advanced Browser motorları zaman aşımı (ms, 150 sn). |
| `YELLOWLAB_MAX_POLL_ATTEMPTS` | `24` | YellowLab API'si için yoklama deneme sayısı. |
| `CONSENT_VERSION` | `2026-10-15` | İstemcinin kabul etmesi gereken geçerli onay sözleşmesi sürümü. |
| `CONSENT_SALT` | *(Zorunlu)* | İstemci IP özetini oluşturmak için salt. Production'da zorunludur. |
| `CHROME_PATH` | Sistem varsayılanı | Chromium/Chrome çalıştırılabilir dosya yolu. |
| `CHROME_NO_SANDBOX` | `false` | Docker ortamında gerekliyse `--no-sandbox` bayrağı. |
| `ARTIFACT_DIR` | `./artifacts` | Geçici tarama dosyalarının yazılacağı dizin. |

---

## API Uç Noktaları

Tüm yanıtlar JSON formatındadır. Hatalar `{ "error": { "code": "...", "message": "..." } }` biçiminde döner.

### 1. `GET /api/health`
Kuyruk ve servis durumunu döndürür.
```json
{
  "ok": true,
  "queue": {
    "running": 0,
    "waiting": 0
  },
  "dailyRemaining": 200
}
```

### 2. `GET /api/engines`
Desteklenen aktif motorların listesini döndürür. Hariç tutulan motorlar bu listede yer almaz.

### 3. `POST /api/scans`
Yeni bir tarama başlatır veya aynı URL için mevcut taramayı döndürür.
```json
{
  "url": "https://example.com",
  "consent": {
    "accepted": true,
    "version": "2026-10-15"
  }
}
```
**Başarılı Yanıt (`202 Accepted`):**
```json
{
  "id": "18f9933c-38e2-45e6-bd9b-c4f48ff3c8a9",
  "status": "queued",
  "position": 1
}
```

### 4. `GET /api/scans/:id`
Belirtilen taramanın durumunu ve sonuçlarını döndürür.
```json
{
  "id": "18f9933c-38e2-45e6-bd9b-c4f48ff3c8a9",
  "url": "https://example.com",
  "status": "completed",
  "startedAt": "2026-10-15T12:00:00.000Z",
  "finishedAt": "2026-10-15T12:01:15.000Z",
  "engines": {
    "lighthouse": { "status": "completed", "durationMs": 14200 },
    "axe": { "status": "completed", "durationMs": 4500 },
    "yellowLab": { "status": "completed", "durationMs": 8100 },
    "wpaPage": { "status": "completed", "durationMs": 6200 },
    "performancePlus": { "status": "completed", "durationMs": 5800 },
    "advancedGeo": { "status": "completed", "durationMs": 5800 },
    "visualUx": { "status": "completed", "durationMs": 5800 }
  },
  "findings": [ ... ],
  "summary": {
    "bySeverity": { "critical": 0, "high": 2, "medium": 4, "low": 1, "info": 0 },
    "byCategory": { "performance": 3, "accessibility": 2, "seo": 1 }
  }
}
```
Tarama tamamen başarısız olduğunda:
```json
{
  "id": "...",
  "url": "https://example.com",
  "status": "failed",
  "error": {
    "code": "SCAN_FAILED",
    "message": "Scan execution failed."
  },
  "engines": { ... },
  "findings": [],
  "summary": { "bySeverity": { "critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0 }, "byCategory": {} }
}
```

---

## Çalıştırma

### Yerel Kurulum
```bash
cd lite/backend
npm install
npm test
npm start
```

### Docker
```bash
cd lite/backend
docker build -t wpa-lite .
docker run -p 8080:8080 -e CONSENT_SALT="prod-salt-value" --rm wpa-lite
```
