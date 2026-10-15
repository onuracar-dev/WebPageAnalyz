# TASK: WPA Lite — backend (Gemini için)

## Amaç
WebPage Analyzer'ın (WPA) hafif, herkese açık demo sürümü. Login, register, plan, ödeme, workspace **yok**.
Ziyaretçi bir URL yapıştırır, "bu siteyi test etme yetkim var, sorumluluk bende" onay kutusunu işaretler, tarama başlar, rapor ekranda görünür.
Sadece **DNS/sahiplik doğrulaması gerektirmeyen** (public link ile çalışan) motorlar çalışır.

Yayın hedefi: küçük bir VDS, `webpageanalyzer.onuracar.dev`. Bu görevde sadece **backend** yapılacak, tasarım sonra.

## Kesin kurallar
1. **Mevcut koda dokunma.** `backend/`, `frontend/`, `website/`, `infra/`, `docs/` ve kök dosyalar değişmeyecek. Her şey `lite/` altında. İş bitince `git status` sadece `lite/` altında değişiklik göstermeli.
2. Gerekli modülleri `backend/`'den `lite/backend/` altına **kopyala** (import etme, `../backend` yolu kullanma). Kopyalanan dosyanın başına tek satır yorum: `// Copied from backend/<yol> — keep in sync manually.`
3. Veritabanı, Redis, pg-boss, Better Auth, billing, e-posta, AI servisi **yok**.
4. SSRF koruması **zorunlu**: `url-safety.js` + `safe-proxy.js` aynen kullanılacak. Herkes URL yapıştırabildiği için bu en kritik kısım.
5. README'ye ölçülmemiş sayı, "production-ready" ya da abartılı iddia yazma.

## Hangi motorlar
Kaynak: `backend/domain/analysis-contract.js` (`ENGINE_CAPABILITIES`, `MODULE_ENGINES`) ve `backend/domain/modules.js`.

**Dahil (requiredInput = `public_url`):**
| Motor | Dosya | Not |
|---|---|---|
| lighthouse | `analyzers/lighthouse.js` | chromium |
| axe | `analyzers/axe.js` | puppeteer + axe-core |
| yellowLab | `analyzers/yellowlab.js` | Yellow Lab public API'ye URL gönderir, UI'da belirtilecek |
| wpaPage | `analyzers/wpa-page.js` | runtime / seo / geo / design / backend_surface |
| performancePlus, advancedGeo, visualUx | `analyzers/advanced-browser.js` (`runAdvancedBrowser`) | playwright-core |

**Hariç (kenarda kalacak, lite'a kopyalanmayacak):**
- `crawler` (full_site_crawl) → verified_origin ister
- `zapBaseline` (passive_security) → verified origin + ZAP daemon
- `journey` (journey_test) → verified read-only journey
- `osvScanner` (source_audit) → zip upload, link değil
- AI remediation, expert_review, monitoring, white_label, api_webhooks

## Kopyalanacak yardımcılar (minimum)
- `analyzers/browser-options.js`
- `security/url-safety.js`, `security/safe-proxy.js`
- `domain/findings.js`, `domain/analysis-normalization.js`, `domain/url-normalization.js`
- `lib/abort.js`, `lib/errors.js`, `lib/logger.js` (gerekirse sadeleştir)
- `utils/parser.js` (lighthouse/yellowlab çıktısı için gerekiyorsa)

Bir dosya hariç tutulan bir şeye (DB, auth, zap-lock vb.) bağımlıysa o bağımlılığı **kopyalanan kopyada** kaldır; orijinale dokunma.

## Mimari
```
lite/
  TASK.md
  README.md
  backend/
    package.json          # express, helmet, express-rate-limit, lighthouse, chrome-launcher,
                          # puppeteer, @axe-core/puppeteer, playwright-core (sürümler backend/package.json ile aynı)
    server.js             # app'i dinletir
    app.js                # express app factory (test edilebilir)
    config.js             # env okuma, sade
    scan-runner.js        # motorları çalıştırır, findings normalize eder
    job-queue.js          # bellek içi kuyruk
    engines/ ...          # kopyalanan analyzer'lar
    security/ domain/ lib/ utils/   # kopyalanan yardımcılar
    test/
    Dockerfile
    environment.template
```

`scan-runner.js` için `backend/services/analysis-service.js`'i **referans al** ama kopyalama: ZAP, journey, crawler, zapLock, progress-chain karmaşıklığı olmadan; her motor `runWithTimeout` ile sarılı, biri patlarsa diğerleri devam eder, motor sonucu `{ status: 'completed'|'failed'|'timed_out', findings, error? }`.

### Kuyruk (VDS küçük, Chromium ağır)
- Bellek içi, **eşzamanlılık 1** (`SCAN_CONCURRENCY`, varsayılan 1).
- Kuyrukta en fazla 5 iş (`MAX_QUEUE`); doluysa `429 QUEUE_FULL`.
- Bitmiş sonuçlar 30 dk bellekte tutulur (`RESULT_TTL_MS`), sonra silinir. Disk artifact'ları tarama bitince silinir.
- Tek iş için toplam üst süre (`SCAN_TIMEOUT_MS`, varsayılan 4 dk).

## API
Tüm cevaplar JSON. Hata formatı: `{ "error": { "code": "...", "message": "..." } }`.

### `GET /api/health`
`{ "ok": true, "queue": { "running": n, "waiting": n } }`

### `GET /api/engines`
Dahil motorların listesi (id, ad, kısa açıklama, dış servise veri gidiyor mu). Hariç motorlar burada **görünmez**.

### `POST /api/scans`
```json
{ "url": "https://example.com", "consent": { "accepted": true, "version": "2026-10-15" } }
```
- `consent.accepted !== true` veya `version` sunucudakiyle eşleşmiyorsa → `400 CONSENT_REQUIRED`.
- URL `validatePublicUrl` ile doğrulanır; private/loopback/link-local IP, `localhost`, izinsiz port, http(s) dışı şema → `400 URL_NOT_ALLOWED`.
- Başarılı → `202 { "id": "<uuid>", "status": "queued", "position": n }`.
- Onay kaydı: sadece stdout log `{ event: 'consent', scanId, consentVersion, at, ipHash }` (IP'nin salt'lı sha256'sı, ham IP loglanmaz).

### `GET /api/scans/:id`
`{ id, url, status: queued|running|completed|failed, position?, startedAt?, finishedAt?, engines: { <engineId>: { status, durationMs } }, findings: [...], summary: { bySeverity, byCategory } }`
Bilinmeyen/expired id → `404 SCAN_NOT_FOUND`.

### Rate limit / güvenlik
- `POST /api/scans`: IP başına saatte 3 (`RATE_LIMIT_PER_HOUR`). `trust proxy` sadece env ile açılır (nginx arkasında).
- `helmet`, body limit 10kb, CORS sadece `ALLOWED_ORIGIN` env'i.
- Aynı URL aynı anda kuyruktaysa yeni iş açma, mevcut id'yi döndür.

## Testler (`node --test`)
- Consent yok / yanlış versiyon → 400.
- `http://127.0.0.1`, `http://localhost`, `http://169.254.169.254`, `http://10.0.0.1`, `file:///etc/passwd`, `ftp://...` → 400 URL_NOT_ALLOWED (DNS lookup mock'lanabilir).
- Kuyruk doluyken → 429.
- `/api/engines` crawler/zapBaseline/journey/osvScanner içermez.
- `scan-runner`: sahte analyzer'larla, biri hata verince diğerlerinin sonucu raporda var, biri timeout olunca `timed_out`.
- Testler gerçek Chromium başlatmamalı (analyzer'lar inject edilebilir olmalı).

## Docker
`lite/backend/Dockerfile`: `backend/Dockerfile`'ı referans al (Chromium kurulumu), non-root kullanıcı, `npm ci --omit=dev`, port 8080. ZAP/OSV yok.

## Bitti sayılması için
- [ ] `cd lite/backend && npm ci && npm test` yeşil.
- [ ] `npm start` sonrası `curl -X POST localhost:8080/api/scans -H "content-type: application/json" -d '{"url":"https://example.com","consent":{"accepted":true,"version":"2026-10-15"}}'` → 202, sonra `GET /api/scans/:id` ile `completed` ve findings geliyor (lokalde Chrome varsa).
- [ ] `git status` sadece `lite/` altında değişiklik gösteriyor.
- [ ] `lite/README.md`: ne yapar, hangi motorlar dahil/hariç ve neden, env değişkenleri, çalıştırma. Uydurma metrik yok.
- [ ] Bitince Claude'a denetim için haber ver (değişen dosya listesi + test çıktısı).

## Kapsam dışı (sonraki görevler)
- Frontend/tasarım (`lite/web/`), nginx + TLS, VDS kurulumu, `webpageanalyzer.onuracar.dev` DNS'i.

---

## Revizyon 1 (Claude denetimi, 2026-10-15)

Kopyalar temiz, 23 test geçiyor, izolasyon doğru. Ama canlı taramada `example.com` için 7 motordan sadece **axe ve yellowLab** sonuç verdi; lighthouse, wpaPage ve advanced motorlar `timed_out` döndü. Önceki raporda bu `...` ile gizlenmişti. **Raporlarda her motorun durumunu tam yaz, kısaltma.**

Not: wpaPage/advanced timeout'unun bir kısmı Onur'un makinesindeki Kaspersky'nin enjekte ettiği long-polling isteğinden kaynaklanıyor (`networkidle` gelmiyor). Bu kod hatası değil, ona dokunma. Aşağıdakiler ise kod hatası:

1. **Motor başına timeout.** Tek bir `ENGINE_TIMEOUT_MS=60s` yerine orijinal `backend/config.js` değerleri, ayrı env değişkenleriyle:
   lighthouse 180s, axe 90s, yellowLab 150s, wpaPage 120s, advancedBrowser 150s.
   `SCAN_TIMEOUT_MS` varsayılanını browser lane'in toplamını karşılayacak şekilde ayarla (öneri: 8 dk) ve README'de neden böyle olduğunu tek cümleyle yaz.
2. **yellowLab:** `config.yellowLabMaxPollAttempts` şu an hiç kullanılmıyor. Orijinaldeki gibi `maxPollAttempts` olarak geçir.
3. **Hata detayı sızıyor.** Public API'de motor `error.message` alanları ham Playwright call log'u ve ANSI kodları döndürüyor. Client'a sadece `{ code }` ve sabit, kısa bir mesaj dön (ör. `OPERATION_TIMEOUT` → "Engine exceeded its time limit."). Ham mesaj sadece sunucu log'una gitsin.
4. **Başarısız taramanın sebebi görünmüyor.** `job.error` set ediliyor ama `GET /api/scans/:id` cevabında yok. `status: failed` olduğunda `error: { code, message }` dön (3. maddedeki gibi temizlenmiş haliyle).
5. **CONSENT_SALT:** Hardcoded varsayılanı kaldır. `NODE_ENV=production` ise ve env'de yoksa sunucu açılmasın (açık hata mesajıyla). Test ortamında sabit değer kullanılabilir.
6. **CORS fail-closed olsun.** `ALLOWED_ORIGIN` boşsa şu an `cors()` herkese açık. Production'da boşsa cross-origin isteklere izin verme. Development'ta `http://localhost:5173` varsayılan olabilir.
7. **Rate limit ve proxy.** `validate: { xForwardedForHeader: false }` satırını kaldır, çünkü nginx arkasında `TRUST_PROXY` unutulursa tüm kullanıcılar tek IP'ye düşer ve uyarı da gizlenir. README ve `environment.template`'e "nginx arkasında `TRUST_PROXY=1`" notunu ekle.
8. **Test ekle:** (a) runner her motora kendi timeout'unu uyguluyor, (b) API cevabında ham hata mesajı yok, (c) failed job'da `error` alanı dönüyor, (d) production'da `CONSENT_SALT` yoksa config hata fırlatıyor.

Bitti kriteri: `npm test` yeşil. `git status` sadece `lite/` gösteriyor. Rapora her motorun status'unu (kısaltmasız) ve test çıktısını ekle. Canlı taramayı Windows'ta değil Docker içinde dene: `docker build` + `docker run`, ardından `example.com` taraması.

---

## Revizyon 2: Yayın öncesi kötüye kullanım önlemleri (Claude, 2026-10-15)

Revizyon 1 doğrulandı: 30 test yeşil ve example.com taramasında 7 motorun hepsi `completed`. Bu revizyon, site herkese açıldığında kötüye kullanımı sınırlamak için. Kurallar aynı: sadece `lite/` altında çalış, kopyalanan motor dosyalarına dokunma.

1. **Aynı host'a tekrar tekrar tarama.** Farklı IP'lerden aynı siteyi sürekli taratmak mümkün, bu da aracı başkasına saldırı için kullanılabilir hale getiriyor.
   - Host başına (normalize edilmiş `hostname`) `HOST_COOLDOWN_MS` (varsayılan 10 dk) içinde en fazla 1 yeni tarama.
   - Cooldown içinde aynı URL'nin biten sonucu bellekte duruyorsa yeni iş açma, `200 { id, status: 'completed', cached: true }` dön.
   - Aynı host'un farklı bir URL'si cooldown içindeyse `429 HOST_COOLDOWN` dön, `retryAfterSeconds` alanıyla.
   - Kontrol sırası: consent → URL doğrulama → aktif iş dedup → sonuç cache → host cooldown → günlük limit → kuyruk kapasitesi.
2. **Günlük global limit.** `DAILY_SCAN_LIMIT` (varsayılan 200). UTC gün değişince sıfırlanır. Aşılınca `429 DAILY_LIMIT_REACHED`. Cache'ten dönen sonuçlar bu sayaçtan düşmez.
3. **Saklanan sonuçlara üst sınır.** Biten işler şu an 30 dk boyunca sınırsız birikebiliyor. `MAX_STORED_RESULTS` (varsayılan 100) aşılınca en eski biten iş silinsin. Kuyrukta bekleyen ve çalışan işler asla silinmez.
4. **Tanımlanabilir trafik.** Browser motorları için kendini tanıtan bir User-Agent ekle: `WPA-Lite/1.0 (+https://webpageanalyzer.onuracar.dev/about)`. Sadece `lite/` altındaki runner'dan uygulanabiliyorsa uygula. Uygulamak için kopyalanan motor dosyalarına dokunmak gerekiyorsa uygulama, raporda nedenini yaz.
5. **`GET /api/health`:** Mevcut alanlara `dailyRemaining` ekle. Kuyruk içeriği ya da URL listesi asla dönme.
6. **Testler:** (a) Cooldown içinde aynı host 429 dönüyor, `retryAfterSeconds` var. (b) Aynı URL'nin biten sonucu `cached: true` ile dönüyor ve günlük sayaçtan düşmüyor. (c) Günlük limit aşılınca 429 dönüyor ve UTC gün değişince sıfırlanıyor (saat inject edilebilir olmalı, gerçek bekleme yok). (d) `MAX_STORED_RESULTS` aşılınca en eski biten iş siliniyor, çalışan iş silinmiyor.
7. README ve `environment.template`'e yeni env değişkenlerini ekle. Ayrıca README'ye tek satır: "Restart olursa kuyruk ve sonuçlar kaybolur (bilinçli tercih, bellek içi demo)."

Bitti kriteri: `npm test` yeşil. `git status` sadece `lite/` gösteriyor. Raporda her yeni maddenin hangi dosyada olduğu ve test çıktısı olsun. Uydurma sayı yazma.

## Deploy checklist'i (kod değil, VDS kurulumunda yapılacak)
- [ ] VDS: en az 2 GB RAM ve 2 GB swap.
- [ ] Docker: `mem_limit` (ör. 1500m), `pids_limit` (ör. 512), `restart: unless-stopped`, log rotasyonu (`max-size: 10m`, `max-file: 3`), `read_only: true` ve `/app/artifacts` + `/tmp` için tmpfs, `cap_drop: [ALL]`, `security_opt: no-new-privileges`. Chrome sandbox seccomp ile sorun çıkarırsa önce Chromium'un önerdiği seccomp profilini dene, `CHROME_NO_SANDBOX` en son çare.
- [ ] Container'a secret koyma, VDS'te başka servislerle aynı Docker ağını paylaşma.
- [ ] nginx: TLS (Let's Encrypt), `TRUST_PROXY=1`, `client_max_body_size 16k`, okuma/gönderme timeout'ları, sadece 80/443 açık. Firewall'da 8080 dışarıya kapalı.
- [ ] Cloudflare proxy (turuncu bulut) aç. Turnstile frontend aşamasında eklenecek.
- [ ] `CONSENT_SALT` için rastgele uzun bir değer, `ALLOWED_ORIGIN=https://webpageanalyzer.onuracar.dev`.
- [ ] `/about` sayfası: ne yapıyor, abuse/iletişim adresi, tarama trafiğinin bu sunucudan geldiği bilgisi.
- [ ] Kullanım koşulları/KVKK sayfası: Yellow Lab'e URL gönderildiği, IP'nin sadece salt'lı hash'inin tutulduğu, sonuçların 30 dk sonra silindiği.
- [ ] İzleme: `/api/health` için uptime kontrolü (ör. UptimeRobot), kuyruk uzun süre doluysa bildirim.
- [ ] İlk hafta: zombi Chrome süreçleri için `docker top` ve RAM kullanımını kontrol et.
