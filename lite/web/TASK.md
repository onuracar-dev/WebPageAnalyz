# SPEC: WPA Lite — frontend (Claude yazıyor)

Backend: `lite/backend`. Canlı motor ilerlemesi Gemini'de, bkz. `lite/TASK.md` Revizyon 3.

## Kesin kurallar
1. Sadece `lite/` altında çalış. `backend/`, `frontend/`, `website/` ve kök dosyalara dokunma.
2. `lite/backend/engines/` altındaki kopyalanmış motor dosyalarına dokunma.
3. **Arc UI "Customer galaxy" bir Pro (ücretli) blok. Kodunu, markup'ını ya da asset'lerini kopyalama, indirmeye de çalışma.** Fikir referans olarak alınacak, galaksi sıfırdan yazılacak.
4. Uydurma metrik, "production-ready" ya da abartılı iddia yok. Sayfada gösterilen her sayı API'den gelmeli.
5. UI dili İngilizce (portföy yurt dışı başvuruları için kullanılıyor). Kod yorumları İngilizce.

---

## Adım 1: Frontend

### Stack
`lite/web/`: Vite + React + TypeScript + Tailwind (ana projedeki `website/` ile aynı aile). Galaksi için ek kütüphane yok, düz Canvas 2D. Animasyon için gerekirse sadece CSS ve `requestAnimationFrame`.
Dev'de Vite proxy ile `/api` → `http://localhost:8080`. Production'da nginx aynı origin'den hem static dosyaları hem `/api`'yi sunacak (CORS gerekmez).

### Görseller
Kaynaklar `lite/web/assets-src/scenes/` altında (Silent orchard koleksiyonu, CC0, Onur tarafından büyütüldü, 2752×1536 JPG):
| Dosya | Kompozisyon | Sahne |
|---|---|---|
| `orchard-path-center.jpg` | Ortada yol, iki yanda ağaçlar, üstte karanlık gökyüzü | **Giriş** |
| `orchard-trees-right.jpg` | Ağaçlar sağda, sol taraf boş | **Tarama** (timeline solda) |
| `orchard-trees-left.jpg` | Ağaçlar solda, sağ taraf boş | **Sonuç** (galaksi sağda) |

- `npm run images` scripti (sharp): her görseli AVIF + WebP olarak 1280, 1920 ve 2752 genişlikte `public/scenes/` altına üretsin. `assets-src` build'e girmesin. Üretilen dosya boyutlarını rapora yaz (ölçülmüş değer).
- `<picture>` / `image-set` ile doğru boyut seçilsin. Sadece giriş görseli `preload` edilsin, diğerleri giriş sahnesi açıldıktan sonra arka planda yüklensin.
- Mobilde `object-position`: tarama sahnesinde ağaçlar görünsün (sağa yakın), sonuç sahnesinde ağaçlar görünsün (sola yakın). İçerik görselin üstünde okunabilsin diye alt ve üst kısımlara hafif koyu gradient.
- `lite/web/CREDITS.md`: "Backgrounds: Silent orchard collection, VenustAI Backgrounds, CC0 (upscaled)." ve kaynak linki.

### Görsel dil
- Renkler görselden türetilsin, `:root` CSS değişkenleri olarak: zemin koyu mürdüm (~`#120810`), metin huş beyazı (~`#efe6e8`), ikincil metin sis pembesi (~`#b9a3ad`), vurgu gül (~`#c45a6e`). Değerleri görselin üstünde kontrast kontrolüyle ince ayarla. Gövde metni WCAG AA'yı geçmeli.
- Önem renkleri tema renginden ayrışmalı (koyu zeminde birbirinden net seçilsin): critical, high, medium, low, info. Sadece renge güvenme, rozetlerde metin de olsun.
- Tipografi (Google Fonts, OFL): başlıklar için zarif bir serif (öneri: Instrument Serif), arayüz için sans (öneri: Inter), teknik değerler (süre, rule id) için mono (öneri: JetBrains Mono). `font-display: swap`.
- Cam efekti varsa hafif tut (`backdrop-filter` + yarı saydam zemin). Görsel arka planı boğmasın.

### Akış ve durumlar
Tek sayfa, üç sahne. Sahne geçişi **otomatik**: arka plan görselleri crossfade ve hafif yatay kaydırma ile değişir (~1.2 sn). Scroll ile değil durum değişince geçer. `prefers-reduced-motion`'da sadece kısa fade.

1. **Giriş (`orchard-path-center`)**
   - Ortada büyük serif başlık + tek satır açıklama (ne yaptığını dürüstçe anlat: "Runs Lighthouse, axe, Yellow Lab and WPA's own browser checks against a public URL.").
   - Tek bir URL input + "Scan" butonu. Altında zorunlu onay kutusu: "I own this site or I'm authorized to test it. I accept responsibility for this scan." + "Terms" linki. Onay yoksa buton disabled.
   - Küçük not: "Your URL is also sent to Yellow Lab Tools (third-party)."
   - Submit → `POST /api/scans` ve `consent.version` sabit olarak frontend'de (`2026-10-15`, backend'le aynı).
2. **Tarama (`orchard-trees-right`)**
   - Solda **engine timeline**: dikey liste, 7 motor. `/api/engines`'ten isim ve açıklama al. Her satırda durum (`pending` / `running` / `completed` / `failed` / `timed_out`), süre (mono) ve yellowLab için "external" rozeti. `running` satırda nabız animasyonu, bitenlerde tik ya da hata ikonu.
   - Üstte taranan URL ve geçen toplam süre sayacı.
   - Kuyruktaysa: "Position in queue: N". **Tahmini süre uydurma**, sadece sırayı göster.
   - Motorlar paralel lane'lerde çalıştığı için (yellowLab ayrı) timeline sıralı değil durum odaklı olsun.
3. **Sonuç (`orchard-trees-left`)**
   - Sağ tarafta **Findings galaxy** (aşağıda detay), solda özet paneli: önem bazında sayılar, motor durumları (hata/timeout olanlar görünür şekilde), "Scan another URL" butonu.
   - Galaksinin altında her zaman **düz bulgu listesi**: önem → kategori sıralı, açılır satırlar (title, severity, engine, description, remediation, evidence). Bu liste erişilebilirlik ve mobil için zorunlu, galaksi vitrin.
   - Bulgu yoksa boş galaksi yerine dürüst bir mesaj.

### Polling ve hata durumları
- Durum takibi **sadece** `GET /api/scans/:id` ile. POST'u asla tekrar atma (IP limiti saatte 3 ve cache cevapları da limitten düşüyor).
- `queued`/`running` iken 2 sn aralıkla poll et. Sekme gizliyken duraklat (`visibilitychange`). Ağ hatasında artan aralıkla tekrar dene (en fazla 10 sn).
- Scan id URL'de tutulsun (`?scan=<id>`). Sayfa yenilenince doğrudan GET ile devam etsin. 404 dönerse "This result expired (results are kept for 30 minutes)" deyip girişe dön.
- `200 cached: true` → doğrudan sonuç sahnesine geç, küçük bir "Recent result" etiketi göster.
- API hata kodlarının hepsi için insan dilinde mesaj (input altında, sahne değişmeden):
  `CONSENT_REQUIRED`, `URL_NOT_ALLOWED`, `RATE_LIMIT_EXCEEDED`, `QUEUE_FULL`, `HOST_COOLDOWN` (`retryAfterSeconds` ile geri sayım), `DAILY_LIMIT_REACHED`, `SCAN_NOT_FOUND`, ağ hatası.
- `failed` tarama: sonuç sahnesinde temizlenmiş `error` mesajı + "This host can be scanned again in ~10 minutes."

### Findings galaxy (kendi implementasyonumuz)
- Canvas 2D, `devicePixelRatio` en fazla 2. `IntersectionObserver` ile ekran dışındayken ve sekme gizliyken döngü dursun.
- Her bulgu bir yıldız. Yarıçap önem derecesine göre (critical en büyük), renk önem rengi, hafif glow. 40-50 bulguda da dolu görünsün: yıldızlar büyük, etrafta dekoratif soluk toz parçacıkları olabilir (bulgu değil, tıklanamaz, sayılmaz).
- Üstte sekmeler: **Category / Engine / Severity**. Sekme değişince yıldızlar yay (spring) fiziğiyle yeni küme merkezlerine akar. Her kümenin altında etiket + sayı.
- Boşta yıldızlar küme içinde yavaşça süzülür.
- Hover (masaüstü) → title tooltip. Tıklama/tap → panelde bulgu detayı, yıldız vurgulanır. Esc seçimi kaldırır.
- Klavye: sekmeler `tablist`; canvas `role="application"` + `aria-label` özet metni; sol/sağ ok kümeler arası, yukarı/aşağı ok küme içindeki bulgular (önem sırasına göre), Enter detay, Esc temizle. Seçimler `aria-live="polite"` ile duyurulsun.
- `prefers-reduced-motion`: animasyonsuz, doğrudan yerleşim.
- Layout hesapları (küme merkezleri, yarıçap ölçeği, spring adımı) saf fonksiyonlarda olsun ki test edilebilsin.
- Mobil (<768px): galaksi tam genişlik ~440px yükseklik, özet paneli altına. Pinch zoom gerekmez. Dokunma sayfa kaydırmayı engellemesin.

### Sayfalar
- `/terms`: kısa ve dürüst: ne yapılıyor, kullanıcının sorumluluğu, Yellow Lab'e URL gönderildiği, IP'nin sadece salt'lı hash'inin loglandığı, sonuçların 30 dk bellekte tutulup silindiği, hesap ve çerez olmadığı.
- `/about`: ne olduğu (WebPage Analyzer'ın açık demo sürümü), hangi motorların dahil ve hariç olduğu, tarama trafiğinin bu sunucudan geldiği, kaynak kod linki. **Abuse iletişim adresi için `TODO(onur): contact email` placeholder bırak, adres uydurma.**
- Router olarak hafif bir çözüm yeter (ör. hash yerine basit path, nginx'te `try_files` ile).

### Erişilebilirlik ve kalite
- Klavyeyle baştan sona kullanılabilir. Focus halkası görünür. Form label'ları gerçek `<label>`.
- Lighthouse'u kendi sitemizde çalıştır ve gerçek skorları rapora yaz (ölçülmüş değer, ortam bilgisiyle). Hedef koymuyoruz, sonucu dürüstçe raporla.
- `index.html`: title, description, Open Graph (og-image olarak giriş görselinin 1200px WebP'si), favicon.

### Testler
- **Vitest:** polling state machine (queued → running → completed, 404, failed, network retry), hata kodu → mesaj eşlemesi, galaksi layout saf fonksiyonları (küme sayısı, her bulgu bir kümede, reduced-motion'da doğrudan hedef konum).
- **Playwright** (API `page.route` ile mock'lanır, gerçek tarama yok): onay kutusu işaretlenmeden buton disabled; submit → tarama sahnesi → timeline güncelleniyor → sonuç sahnesi ve liste görünüyor; `HOST_COOLDOWN` mesajı ve geri sayım; 375px genişlikte yatay scroll yok.

### Bitti kriteri
- [ ] `cd lite/web && npm ci && npm run build && npm test && npx playwright test` yeşil.
- [ ] Backend + `npm run dev` ile `https://example.com` gerçek taramasında üç sahne de görülüyor (Kaspersky HTTPS taraması kapalı olmalı).
- [ ] `git status` sadece `lite/` altında değişiklik gösteriyor.
- [ ] Rapor: değişen dosya listesi, test çıktıları, üretilen görsel boyutları, kendi sitemizin Lighthouse sonuçları, masaüstü ve 375px ekran görüntüleri (her sahne için).

### Kapsam dışı (sonraki görevler)
Turnstile, Docker/nginx/VDS kurulumu, domain, analytics (eklenmeyecek).
