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

---

## Revizyon 3: Canlı motor ilerlemesi (Claude, 2026-10-15)

Frontend'i Claude yazıyor (`lite/web/`). **Sen sadece `lite/backend/` altında çalış, `lite/web/`'e dokunma.** Kopyalanan motor dosyalarına (`lite/backend/engines/`) yine dokunma.

Şu an `job.engines` sadece tarama bitince doluyor, bu yüzden frontend'deki timeline canlı akamıyor.

1. `enqueue` sırasında `job.engines` dahil 7 motorla başlatılsın: `lighthouse, axe, yellowLab, wpaPage, performancePlus, advancedGeo, visualUx` → her biri `{ status: 'pending' }`. Bu, kuyruktaki iş için `GET /api/scans/:id`'de de görünmeli.
2. `scan-runner` opsiyonel bir `onEngineUpdate(engineId, patch)` callback'i alsın:
   - motor başlarken `{ status: 'running', startedAt: <ISO> }`
   - motor bitince `{ status: 'completed' | 'failed' | 'timed_out', durationMs, error? }`
   - `advancedBrowser` tek çalıştırma olduğu için `performancePlus`, `advancedGeo` ve `visualUx` aynı anda güncellenir.
3. `job-queue` bu callback'le `job.engines[engineId]`'yi canlı güncellesin (merge). `GET /api/scans/:id` çalışırken güncel `engines` dönsün. `findings` ve `summary` yine sadece tamamlanınca dolu.
4. Canlı güncellemedeki `error` da Revizyon 1'deki gibi sanitize edilmiş olmalı (`{ code, message }`, ham mesaj yok).
5. Cevap şeması değişmesin, sadece `engines` erken dolsun. Frontend bu alan adlarına göre yazılıyor: `engines.<id>.status`, `engines.<id>.startedAt`, `engines.<id>.durationMs`, `engines.<id>.error`.
6. Testler (sahte analyzer'larla, gerçek Chromium yok):
   - (a) enqueue sonrası 7 motor `pending`.
   - (b) runner çalışırken GET'te `running` ve `completed` motorlar karışık görünüyor (bir analyzer'ı promise ile bekletip araya GET at).
   - (c) canlı güncellemede ham hata mesajı yok.
   - (d) callback verilmezse runner eskisi gibi çalışıyor.

Bitti kriteri: `cd lite/backend && npm test` yeşil. `git status` sadece `lite/backend/` ve bu TASK.md dışında değişiklik göstermiyor. Raporda değişen dosyalar ve test çıktısı olsun. Mümkünse bir canlı taramada tarama sürerken alınmış bir GET cevabını da ekle (Kaspersky HTTPS taraması kapalıyken).

---

## Revizyon 4: Yönlendirmeleri takip et (Claude, 2026-10-15)

Revizyon 3 bittikten sonra yap. Yine sadece `lite/backend/` altında çalış.

**Bug:** `https://onuracar.dev` taramasında axe, wpaPage ve advanced motorlar `failed` döndü (`net::ERR_TUNNEL_CONNECTION_FAILED`). Site `308` ile `https://www.onuracar.dev/`'e yönlendiriyor. Safe proxy sadece ilk girilen origin'e izin verdiği için tarayıcı yönlendirmede takılıyor. Apex → www ve http → https yönlendirmeleri çok yaygın, yani gerçek kullanıcıların çoğu bu hataya düşer.

1. `POST /api/scans`'te URL doğrulamasından sonra, kuyruğa almadan önce yönlendirmeleri sunucu tarafında çöz:
   - `redirect: 'manual'` ile en fazla 5 hop. Her hop'un `Location`'ı `validatePublicUrl` ile doğrulanmalı (SSRF: yönlendirme iç ağa gidemez).
   - Önce `HEAD`, 405/501 dönerse `GET` (body okunmadan iptal). Toplam süre sınırı ~8 sn. Zaman aşımında ya da hata durumunda orijinal URL ile devam et (tarama yine motorlarda dürüstçe fail olur).
   - Sadece http(s) ve izinli portlar.
2. Kuyruğa, cache ve dedup kontrollerine, host cooldown'a **son URL** girsin (yani `example.com` ile `www.example.com` aynı cooldown'a düşer).
3. Cevaba ve `GET /api/scans/:id`'ye `requestedUrl` (kullanıcının girdiği) ekle. `url` taranan son URL olsun.
4. Testler (fetch mock'lanır, gerçek ağ yok): (a) 308 → www takip ediliyor ve job.url son URL. (b) Yönlendirme private IP'ye gidiyorsa `400 URL_NOT_ALLOWED`. (c) 6+ hop'ta orijinal URL ile devam ya da açık bir hata (hangisini seçtiğini raporla). (d) Ağ hatasında orijinal URL ile devam.
5. Bitti kriteri: `npm test` yeşil. Canlı olarak `https://onuracar.dev` taramasında axe ve wpaPage `completed` dönüyor (Kaspersky HTTPS taraması kapalıyken). Rapora her motorun status'unu yaz.

---

## Revizyon 5: Yönlendirme çözücüsünde SSRF sıkılaştırması (Claude, 2026-10-15)

Revizyon 3 ve 4 doğrulandı: 42 test yeşil. UI üzerinden canlı `onuracar.dev` taramasında yönlendirme `www`'ye çözüldü, timeline canlı aktı, 7 motorun hepsi `completed`. Sadece `lite/backend/security/url-resolver.js` (ve gerekiyorsa `app.js` ile testleri) değişecek.

1. **DNS rebinding (öncelikli).** `validatePublicUrl` DNS'i çözüp kontrol ediyor, ama ardından `fetch` DNS'i **kendisi tekrar çözüyor**. Kısa TTL'li bir domain ilk sorguda public IP, ikinci sorguda `127.0.0.1` / `169.254.169.254` / `10.x` döndürebilir ve sunucu iç ağa HEAD/GET atmış olur. `SafeBrowserProxy` bu yüzden doğrulanmış IP'ye bağlanıyor, çözücü de aynısını yapmalı.
   - `fetch` yerine `node:http` / `node:https` `request` kullan. `lookup` seçeneğine `url-safety.js`'teki doğrulamayı kullanan bir fonksiyon ver: çözülen adres public değilse hata dönsün. Ya da doğrulanmış adrese bağlan ve `servername` (SNI) ile `Host` başlığını orijinal hostname olarak ayarla. Hangisini seçtiğini raporla.
   - Yeni bağımlılık ekleme.
2. **GET fallback'te zaman aşımı yok.** HEAD 405/501 dönünce atılan GET'in sinyali sadece header geldikten sonra iptal ediliyor. Yanıt vermeyen bir sunucu `POST /api/scans` isteğini süresiz askıda tutabilir. Her istek kalan süre bütçesiyle sınırlı olsun ve toplam süre 8 sn'yi asla aşmasın. Body hiç okunmasın, header gelince bağlantı kapatılsın.
3. **Testler:**
   - (a) İlk DNS çözümü public, bağlantı anındaki çözüm private IP olduğunda istek yapılmıyor, orijinal URL ile devam ediliyor ya da `URL_NOT_ALLOWED` dönüyor (hangisi olduğunu raporla). `lookup` inject edilebilir olmalı.
   - (b) Header göndermeyen bir sunucuda çözücü bütçe içinde dönüyor. Gerçek ağ yerine lokal bir `net.createServer` ile test et, test 10 sn'den kısa sürsün.
   - (c) Mevcut Revizyon 4 testleri hâlâ geçiyor.

Bitti kriteri: `npm test` yeşil. `git status` sadece `lite/backend/` altında değişiklik gösteriyor. Canlı `https://onuracar.dev` taramasında hâlâ `www`'ye çözülüyor ve 7 motor `completed` (PORT=8099).

---

## Revizyon 6: İletişim formu API'si + Docker/deploy dosyaları (Claude, 2026-10-15)

Revizyon 3-5 doğrulandı ve commit'lendi. Frontend'i Claude yazıyor: `/contact` sayfası aşağıdaki API'yi kullanacak. **`lite/web/src/` altına dokunma.** Çalışabileceğin yerler: `lite/backend/`, `lite/docker-compose.yml`, `lite/web/Dockerfile`, `lite/web/nginx.conf`, `lite/web/.dockerignore`, `lite/.env.example`, `lite/README.md`. Kopyalanan motor dosyalarına yine dokunma.

### A. `POST /api/contact`

İstek gövdesi (JSON, body limiti mevcut 10kb):
```json
{ "name": "Ada", "email": "ada@example.com", "topic": "Feedback", "message": "En az 20 karakterlik mesaj...", "website": "" }
```
- Doğrulama:
  - `name` 1–100 karakter.
  - `email` geçerli bir adres, en fazla 200 karakter.
  - `topic` şunlardan biri: `Feedback`, `Bug report`, `Abuse report`, `Other`.
  - `message` 20–2000 karakter.
  - Hata olursa `400 CONTACT_INVALID` ve `{ error: { code, message, fields: { name?: string, email?: string, message?: string } } }`.
- **Honeypot:** `website` doluysa mail gönderme, ama `202 { ok: true }` dön (bot fark etmesin).
- **Limitler:** IP başına saatte 3 (`CONTACT_RATE_LIMIT_PER_HOUR`), global günlük 50 (`CONTACT_DAILY_LIMIT`). Aşılınca `429 CONTACT_RATE_LIMITED`. Tarama limitlerinden ayrı sayaçlar olsun.
- **Gönderim:** Resend HTTP API'si (`https://api.resend.com/emails`), yeni bağımlılık ekleme, `fetch` yeter. Referans için `backend/email/resend-provider.js`'e bakabilirsin ama kopyalamak zorunda değilsin.
  - `from`: `CONTACT_FROM`, **zorunlu, varsayılan yok**. Resend'de doğrulanmış bir domainden olmalı (ör. `WPA Lite <noreply@usewpa.tech>`). Not: `onboarding@resend.dev` sadece Resend hesabının sahibine gönderebilir, bizim alıcımız farklı bir adres olduğu için kullanılamaz.
  - `to`: `CONTACT_TO` (env'den, kodda adres yazma).
  - `reply_to`: kullanıcının e-postası.
  - `subject`: `[WPA Lite] <topic> from <name>`. Name'deki CR/LF karakterlerini temizle (header injection), 80 karaktere kırp.
  - Sadece **düz metin** gövde (`text`), HTML yok. Gövdede name, email, topic, message ve gönderim zamanı olsun.
  - 8 sn timeout. Resend hata dönerse `502 CONTACT_FAILED`, sabit ve kısa bir mesajla. Ham sağlayıcı cevabı client'a gitmesin.
- `RESEND_API_KEY`, `CONTACT_TO` veya `CONTACT_FROM` yoksa `503 CONTACT_DISABLED` (sunucu açılmaya devam etsin, sadece bu uç kapalı olsun). `GET /api/health`'e `contact: true/false` ekle.
- **Log:** Sadece `{ event: 'contact', topic, at, ipHash }`. Mesaj içeriği, e-posta ve isim asla loglanmaz.
- Başarılı → `202 { ok: true }`.
- **Testler** (`fetch` mock'lanır, gerçek ağ yok): geçerli istek Resend'e doğru gövdeyle gidiyor (`reply_to`, düz metin, `to` env'den), honeypot mail atmıyor ama 202 dönüyor, doğrulama hataları `fields` ile dönüyor, CR/LF temizleniyor, rate limit 429, env eksikken 503, Resend hatası 502 ve ham hata sızmıyor, log'da mesaj/e-posta yok.

### B. Docker ve deploy dosyaları

1. **`lite/web/Dockerfile`:** Multi-stage. İlk aşamada `node` imajında `npm ci && npm run build`. İkinci aşamada `nginx:alpine` ile `dist/` sunuluyor, non-root çalışıyor (ör. `nginxinc/nginx-unprivileged`), port 8080. `lite/web/.dockerignore` ile `node_modules`, `dist`, `test-results`, `e2e` dışarıda.
2. **`lite/web/nginx.conf`:**
   - `try_files $uri /index.html` (`/terms`, `/about`, `/contact` için).
   - `/api/` → `http://backend:8080` proxy. `X-Forwarded-For` ve `X-Forwarded-Proto` iletilsin. Proxy okuma timeout'u en az 30 sn olsun (POST /api/scans yönlendirme çözümü ~8 sn sürebiliyor).
   - `client_max_body_size 16k`, gzip.
   - Hash'li asset'ler (`/assets/`) için uzun süreli cache, `index.html` için `no-cache`.
   - Güvenlik başlıkları: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options DENY`, `Permissions-Policy`. **CSP** eklersen şunlara izin vermesi gerekiyor: `https://api.fontshare.com` (style), `https://cdn.fontshare.com` (font), `'self'` (script/connect). WebGL için ek bir izin gerekmiyor. Raporda CSP'yi yaz.
3. **`lite/docker-compose.yml`:**
   - Servisler: `backend` (mevcut Dockerfile) ve `web`.
   - `backend` dışarıya port açmasın, sadece compose ağında olsun. `web` host'ta `127.0.0.1:${WEB_PORT:-8081}:8080` (TLS'i VDS'teki reverse proxy yapacak).
   - İkisinde de: `restart: unless-stopped`, log rotasyonu (`max-size: 10m`, `max-file: 3`), `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `pids_limit`.
   - Backend'e `mem_limit` (ör. 1500m), `read_only: true` ve `/tmp` + artifact dizini için tmpfs.
   - Backend `env_file: .env`, `TRUST_PROXY=1` (nginx arkasında).
4. **`lite/.env.example`:** `NODE_ENV=production`, `CONSENT_SALT=` (uzun rastgele değer nasıl üretilir: `openssl rand -hex 32`), `ALLOWED_ORIGIN=https://webpageanalyzer.onuracar.dev`, `TRUST_PROXY=1`, `RESEND_API_KEY=` (ana projeden ayrı, sadece gönderim yetkili bir anahtar önerilir), `CONTACT_TO=` (boş bırak, gerçek adres repoya girmez), `CONTACT_FROM=` (doğrulanmış domainden, ör. `WPA Lite <noreply@usewpa.tech>`), `WEB_PORT=8081`. `lite/.gitignore`'a `.env` ekli olsun.
5. **Docker testi:** Onur Docker Desktop kuracak. Kurulunca:
   - `docker compose -f lite/docker-compose.yml up --build`
   - `http://localhost:8081` üzerinden `https://example.com` taraması yap.
   - **Chromium sandbox:** Önce `CHROME_NO_SANDBOX` olmadan dene. Hata alırsan hatayı rapora yaz. `--no-sandbox`'a geçmeden önce seccomp/cap seçeneklerini dene ve hangisinin işe yaradığını açıkla.
   - Raporda: 7 motorun status'u, container RAM kullanımı (`docker stats`, ölçülmüş değer), `docker compose ps` çıktısı.
6. **`lite/README.md`'ye kısa bir "Deploy" bölümü:** `.env` oluşturma, compose ile başlatma, VDS'te önünde TLS yapan bir reverse proxy (Caddy ya da nginx) olacağı, `docker compose logs`. Uydurma sayı yok.

Bitti kriteri: `cd lite/backend && npm test` yeşil. Docker kuruluysa compose ile gerçek bir tarama tamamlanmış ve raporlanmış. `git status` sadece izin verilen dosyaları gösteriyor. Rapora değişen dosyalar, test çıktısı, CSP ve Docker sonuçları eklensin.

### Revizyon 6 denetimi (Claude, 2026-10-15)
Testler yeşil (backend 55, web 36). Contact uç noktası canlıda doğrulandı (503 / 400 / honeypot 202 / 502, log'da kişisel veri yok). Claude'un düzelttikleri:
- **Gerçek IP:** `TRUST_PROXY=1` tek başına host'taki reverse proxy'nin iç IP'sini görüyordu, yani IP başına limitler bütün site için tek sayaca dönüşecekti. `nginx.conf`'a `real_ip` (özel ağ aralıklarına güven, `real_ip_recursive on`) eklendi. Backend'e artık sadece gerçek ziyaretçi IP'si gidiyor.
- **Chromium:** `read_only` container'da `HOME`/`XDG_*` dizinleri `/tmp`'ye yönlendirildi.

### Deploy günü kontrol listesi (VDS'te, Docker ile)
1. `docker compose up --build` sonrası `docker compose exec web nginx -t` (nginx ayarı burada hiç çalıştırılmadı).
2. Gerçek bir tarama: 7 motorun status'u. **Chromium sandbox:** Ubuntu 24.04 unprivileged user namespace'leri AppArmor ile kısıtlıyor ve `no-new-privileges` SUID sandbox'ı engelliyor. Tarayıcı açılmazsa önce hatayı oku, sonra seçenekleri tartış (`--no-sandbox` son çare).
3. IP doğrulaması: iki farklı ağdan birer tarama. Log'daki `ipHash` değerleri farklı olmalı. Cloudflare proxy açıksa Cloudflare IP aralıkları `set_real_ip_from`'a eklenmeli.
4. `docker stats` ile RAM/CPU (ölçülmüş değer), sonra `mem_limit` gözden geçirilir.
5. Contact: gerçek anahtarla bir test mesajı.
6. CSP: tarayıcı konsolunda CSP ihlali olmamalı (Fontshare, WebGL).

---

## Revizyon 7: Sandbox'sız Chromium için güvenlik önlemleri + mail kodunun kaldırılması (Claude, 2026-10-16)

### Bağlam (VDS'te ilk gerçek çalıştırmanın sonuçları)
- VDS: Ubuntu 24.04, 4 vCore, 6 GB. SSH sadece anahtarla, UFW (22/80/443), fail2ban, Docker 29 kurulu. Compose ayakta, nginx ve health sağlam.
- İlk taramada artifact klasörü `EACCES` verdi. Claude düzeltti (`ARTIFACT_DIR=/tmp/wpa-artifacts`, commit'li).
- **Chromium container'da açılmıyor.** SUID sandbox'ı `no-new-privileges` engelliyor, namespace sandbox'ını Ubuntu 24.04'ün AppArmor kısıtlaması ve Docker'ın seccomp profili engelliyor.
- **Karar (Onur):** Chromium `--no-sandbox` ile çalışacak. İletişim formu mail göndermeyecek, frontend'de `mailto:` olacak (bunu Claude yapıyor). Böylece backend'de hiçbir gizli anahtar kalmıyor. Sandbox olmadığı için aşağıdaki önlemler zorunlu.

### Kurallar
- **Çalışma alanı:** `lite/backend/`, `lite/docker-compose.yml`, `lite/.env.example`, `lite/README.md`, yeni `lite/deploy/` klasörü. `lite/web/src/`'ye ve kopyalanan motor dosyalarına dokunma.
- **Sunucuya bağlanamıyorsun.** Sunucu işleri için repoda **idempotent** (tekrar çalıştırılınca bozmayan) script ve ayar dosyaları hazırla. Claude denetleyip sunucuda uygulayacak ve test edecek.
- **Shell script kuralları:** `#!/usr/bin/env bash` + `set -euo pipefail`, root gerektiriyorsa başta kontrol et. `bash -n` ile sözdizimi kontrolünden geçmeli, `shellcheck` varsa o da temiz olmalı.
- Uydurma sayı yazma.

### A. Mail gönderme kodunu kaldır
`POST /api/contact` ve ona ait her şey gidiyor:
- Uç nokta, `security/contact-limiter.js`.
- `config.js`'teki `resendApiKey`/`contactTo`/`contactFrom`/`contactRateLimitPerHour`/`contactDailyLimit` alanları.
- `/api/health`'teki `contact` alanı.
- İlgili testler.
- `environment.template`, `.env.example` ve README'deki Resend/contact bölümleri.

Kalan testlerin hepsi yeşil kalmalı.

### B. Zorunlu önlemler (sandbox olmadığı için)
1. **Chromium `--no-sandbox`:**
   - `docker-compose.yml` backend'e `CHROME_NO_SANDBOX: "true"` ekle. Yanına neden böyle olduğunu ve bu dosyadaki diğer önlemlere güvendiğimizi anlatan bir yorum yaz.
   - Dört tarayıcı motoru da `chromeFlags(..., config)` üzerinden bunu okuyor mu, doğrula ve raporla (lighthouse, axe, wpa-page, advanced-browser). Motor dosyalarını değiştirme, sadece doğrula.
2. **Çıkış engeli (en önemlisi):** Sandbox'sız bir Chromium'da kod çalıştıran bir sayfa, SSRF proxy'mizi atlayıp doğrudan bağlantı açabilir. Backend container'ı internete çıkabilmeli, ama özel ve iç adreslere hiç ulaşamamalı.
   - Compose'a sabit bir ağ tanımla: `lite_net`, subnet `172.30.240.0/24`, backend için sabit IP (ör. `172.30.240.10`). `web` aynı ağda kalsın.
   - `lite/deploy/egress-firewall.sh` iki şey yapsın:
     - (a) `DOCKER-USER` zincirinde, backend IP'sinden şu hedeflere giden **yeni** bağlantıları DROP etsin: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `0.0.0.0/8`, `224.0.0.0/4`. Önce `ESTABLISHED,RELATED` kabul edilsin ki web → backend istekleri ve cevaplar çalışsın.
     - (b) `INPUT` zincirinde, backend IP'sinden host'un kendisine gelen yeni bağlantıları DROP etsin (host'un public IP'si dahil; container → host trafiği FORWARD'dan değil INPUT'tan geçer). Bu kural UFW kurallarından **önce** değerlendirilmeli.
   - Script idempotent olsun: kendi kurallarını bir yorumla (`-m comment --comment wpa-lite-egress`) işaretlesin, eklemeden önce eskilerini silsin.
   - `lite/deploy/wpa-lite-egress.service`: systemd unit'i. `After=docker.service`, `Requires=docker.service`, `Type=oneshot`, `RemainAfterExit=yes`. Böylece kurallar reboot ve Docker yeniden başlayınca geri gelsin.
   - Docker'ın DNS'i (127.0.0.11) container'ın kendi ağ ad alanında çalıştığı için bu kurallardan etkilenmez. Bunu script'e yorum olarak yaz.
3. **Haftalık yeniden build (Chromium güncel kalsın):**
   - `lite/deploy/wpa-lite-update.service` + `wpa-lite-update.timer`: haftada bir (ör. Pazar 04:30, `Persistent=true`) `docker compose build --pull --no-cache` ve `docker compose up -d` çalıştırsın, ardından `docker image prune -f`. `--no-cache` önemli, yoksa `apt-get install chromium` katmanı önbellekten gelir ve güncellenmez.
   - Kullanıcı `deploy`, çalışma dizini `/home/deploy/app/lite`. Çıktı journal'a gitsin.
4. **CPU sınırı:** compose'da backend `cpus: "3"`, web `cpus: "0.5"`. Sunucu taramalar sırasında da SSH'a ve nginx'e yanıt verebilsin.

### C. Diğer gerekli önlemler
5. **TLS ve Cloudflare (Caddy):**
   - `lite/deploy/Caddyfile`: `wpa.onuracar.dev` → `reverse_proxy 127.0.0.1:8081`.
   - TLS için **Cloudflare Origin Certificate** kullanılacak (Cloudflare panelinden alınır, ACME ve API token gerekmez). Dosya yolları `/etc/caddy/certs/origin.pem` ve `origin.key`. Cloudflare SSL modu "Full (strict)".
   - **Gerçek IP:** Caddy'de `servers { trusted_proxies static <Cloudflare IP aralıkları>; client_ip_headers CF-Connecting-IP }` ve `reverse_proxy` içinde `header_up X-Forwarded-For {client_ip}`. Böylece nginx'e tek ve doğru bir IP gider. nginx `real_ip` ayarına (özel ağlara güven) dokunma, olduğu gibi çalışmalı.
   - Cloudflare IP aralıklarını Caddyfile'a elle yazma: `lite/deploy/cloudflare-ips.sh` bunları `https://www.cloudflare.com/ips-v4` ve `ips-v6`'dan çekip bir snippet dosyası üretsin, Caddyfile de onu `import` etsin.
   - Caddy'nin resmi apt deposundan nasıl kurulacağını `DEPLOY.md`'ye yaz.
6. **Origin'i Cloudflare'e kilitle:** `cloudflare-ips.sh` aynı listeyle UFW'de 80/443'ü sadece Cloudflare aralıklarına açsın, genel `80/tcp` ve `443/tcp` izinlerini kaldırsın. SSH (22) dokunulmadan kalsın. Script idempotent olsun ve listeyi haftalık güncelleyen bir timer'ı (`wpa-lite-cfips.timer`) olsun. **Uyarı:** Bu adım DNS kaydı Cloudflare'de "Proxied" (turuncu bulut) olmadan uygulanırsa site dışarıdan erişilemez. `DEPLOY.md`'de sırayı net yaz.
7. **Otomatik güvenlik güncellemeleri:** `lite/deploy/50-wpa-lite-unattended.conf`: `Unattended-Upgrade::Automatic-Reboot "true"` ve `Automatic-Reboot-Time "04:00"`. Çekirdek güncellemeleri böylece uygulanır, container'lar `restart: unless-stopped` ile geri gelir.

### D. Daha düşük öncelik (sadece belgele, kod yok)
8. `DEPLOY.md`'de "Bakım" bölümü:
   - Ayda bir `npm audit --omit=dev` (backend ve web).
   - UptimeRobot vb. ile `https://wpa.onuracar.dev/api/health` izleme.
   - İleride Turnstile eklenebileceği (frontend + backend, ayrı bir görev).
9. Yellow Lab'e URL gönderildiği bilgisinin Terms'te durduğunu kontrol et (`lite/web/src/pages/Terms.tsx`, sadece oku, değiştirme). Eksikse raporda belirt.

### E. `lite/deploy/DEPLOY.md`
Sunucuya ilk kurulumdan günlük işlere kadar sıralı adımlar:
- Sunucu sertleştirme (zaten yapıldı, kısa özet: deploy kullanıcısı, sshd `00-hardening.conf`, UFW, fail2ban, swap).
- Docker kurulumu.
- Kodun aktarılması.
- `.env`.
- `docker compose up -d --build`.
- egress script + unit'in kurulumu.
- Update timer.
- Caddy + Origin cert.
- Cloudflare DNS (proxied) ve **sonra** UFW kilidi.
- Doğrulama komutları:
  - Container içinden `curl -m 3 http://172.30.240.1` ve host IP'si zaman aşımına düşmeli, `curl -sI https://example.com` çalışmalı.
  - Web üzerinden `/api/health` 200 dönmeli.
- Geri alma: her adımın nasıl geri alınacağı (ör. `systemctl disable --now ...`, `iptables -D ...`).

### Bitti kriteri
- `cd lite/backend && npm test` yeşil (contact testleri kaldırılmış haliyle).
- Tüm `lite/deploy/*.sh` dosyaları `bash -n`'den geçiyor.
- `docker compose config` hatasız (Docker yoksa YAML'ı başka bir araçla doğrula ve raporla).
- `git status` sadece izin verilen dosyaları gösteriyor.
- Raporda: kaldırılan dosyalar, eklenen dosyalar, 4 motorun `CHROME_NO_SANDBOX`'ı okuduğunun kanıtı (dosya:satır), iptables kurallarının tam listesi, test çıktısı.
