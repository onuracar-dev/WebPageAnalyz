# WPA Lite — Sunucu Kurulum ve İşletim Kılavuzu (Deploy Guide)

Bu doküman, WPA Lite'ın üretim ortamındaki (Ubuntu 24.04 VDS) ilk kurulumundan günlük bakım ve geri alma adımlarına kadar tüm operasyonel prosedürlerini kapsar.

---

## 1. Mimari ve Güvenlik Modeli

WPA Lite, login, veritabanı, arka plan mesajlaşma kuyruğu ve dış e-posta sağlayıcısı (Resend/SMTP) bağımlılıkları olmayan, tamamen bellek içi çalışan hafif bir demo sürümüdür.

- **Chromium Sandbox Durumu:**
  Ubuntu 24.04 üzerinde unprivileged user namespace kısıtlamaları ve Docker'ın `no-new-privileges` bayrağı nedeniyle Chromium SUID/namespace sandbox'ı başlatılamamaktadır. Bu nedenle Chromium container içinde `CHROME_NO_SANDBOX=true` bayrağı ile çalıştırılır.
- **İletişim Formu Kararı:**
  Backend'de hiçbir gizli anahtar (API key, secret token) barındırılmaz. İletişim formu doğrudan frontend üzerinden `mailto:` bağlantısıyla sağlanır; backend'deki mail gönderme uç noktası tamamen kaldırılmıştır.
- **Ağ İzolasyonu ve Çıkış Engeli (Egress Firewall):**
  Sandbox'sız Chromium'un SSRF proxy'sini atlayıp yerel ağa veya sunucunun kendisine erişmesini engellemek için `DOCKER-USER` ve `INPUT` zincirlerinde çekirdek seviyesinde (iptables) sıkı bir çıkış engeli uygulanır.

---

## 2. Sunucu Ön Hazırlığı ve Sertleştirme (Özet)

Sunucuda önceden yapılmış olan temel sertleştirme adımları:
1. **İşletim Sistemi ve Donanım:** Ubuntu 24.04 LTS, 4 vCore, 6 GB RAM, 2 GB Swap.
2. **Kullanıcı:** `deploy` kullanıcısı oluşturulmuş ve `sudo` ile `docker` gruplarına eklenmiştir.
3. **SSH Sertleştirmesi (`/etc/ssh/sshd_config.d/00-hardening.conf`):**
   - Parola ile kimlik doğrulama kapalı (`PasswordAuthentication no`).
   - Root girişi kapalı (`PermitRootLogin no`).
   - Yalnızca SSH anahtarı ile erişim açık.
4. **Temel Güvenlik:** `ufw` ve `fail2ban` aktif. SSH (22/tcp) açık.

---

## 3. Kurulum Sırası (Adım Adım)

### Adım 1: Kodun Sunucuya Aktarılması
Depo sunucuda `/home/deploy/app/lite` dizininde konumlandırılır:
```bash
# deploy kullanıcısı olarak
mkdir -p /home/deploy/app
git clone <repo-url> /home/deploy/app
cd /home/deploy/app/lite
```

### Adım 2: Ortam Değişkenlerinin Hazırlanması
```bash
cp .env.example .env
```
`.env` dosyasını düzenleyin:
- `CONSENT_SALT`: `openssl rand -hex 32` komutuyla 64 karakterlik rastgele bir hex dize üretip yazın.
- `ALLOWED_ORIGIN`: `https://wpa.onuracar.dev`
- `TRUST_PROXY`: `1`
- `WEB_PORT`: `8081`

### Adım 3: Docker Compose ile Başlatma
```bash
docker compose up -d --build
```
`docker-compose.yml` yapılandırması:
- **Sabit Ağ:** `lite_net` (`172.30.240.0/24`), backend container'ına `172.30.240.10` IP'si atanır.
- **Kaynak Sınırları:** Backend için `cpus: "3"`, `mem_limit: 2500m`. Web için `cpus: "0.5"`, `mem_limit: 256m`.
- **Erişim:** Backend dış dünyaya port açmaz. Web container'ı `127.0.0.1:8081` üzerinde yerel dinleme yapar.

### Adım 4: Çıkış Engeli (Egress Firewall) Kurulumu
Backend container'ının özel IP bloklarına ve sunucunun yerel IP'lerine doğrudan TCP/UDP bağlantısı açmasını engeller:
```bash
sudo cp deploy/egress-firewall.sh /usr/local/sbin/wpa-lite-egress-firewall
sudo chmod +x /usr/local/sbin/wpa-lite-egress-firewall
sudo cp deploy/wpa-lite-egress.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wpa-lite-egress.service
```

### Adım 5: Haftalık Otomatik Yeniden Build Timer'ı
Chromium paketinin güncel kalması için her hafta Pazar 04:30'da imajları `--no-cache` ile baştan derleyen sistemd timer'ını kurun:
```bash
sudo cp deploy/wpa-lite-update.service deploy/wpa-lite-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wpa-lite-update.timer
```

### Adım 6: Otomatik Güvenlik Güncellemeleri
Çekirdek veya kritik kütüphane güncellemeleri sonrasında sunucunun otomatik olarak yeniden başlatılması için:
```bash
sudo cp deploy/50-wpa-lite-unattended.conf /etc/apt/apt.conf.d/
```
*(Sunucu 04:00'te sessiz saatte reboot olur; container'lar `restart: unless-stopped` ile geri gelir ve `wpa-lite-egress.service` kuralları tekrar yükler).*

### Adım 7: Caddy Kurulumu ve Cloudflare Origin Certificate
Caddy resmi apt deposundan kurulur:
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

**Sertifika Dosyaları:**
Cloudflare panelinden (SSL/TLS → Origin Server) oluşturulan 15 yıllık Origin Certificate dosyalarını kaydedin:
- Sertifika: `/etc/caddy/certs/origin.pem`
- Özel Anahtar: `/etc/caddy/certs/origin.key`
```bash
sudo mkdir -p /etc/caddy/certs
sudo chmod 700 /etc/caddy/certs
# origin.pem ve origin.key dosyalarını kopyalayın
sudo chmod 600 /etc/caddy/certs/*
```
Cloudflare SSL/TLS şifreleme modunu **Full (strict)** olarak ayarlayın.

### Adım 8: Cloudflare IP'leri ve UFW Kilitlenmesi

> [!WARNING]
> **KRİTİK SIRA UYARISI:**
> DNS kaydı (`wpa.onuracar.dev`) Cloudflare panelinde **Proxied (Turuncu Bulut)** moduna alınmadan UFW kilitlenmemelidir! Aksi takdirde sunucuya doğrudan gelen 80/443 bağlantıları engellenir ve siteye dışarıdan ulaşılamaz.

1. Cloudflare DNS kaydını `wpa.onuracar.dev` → VDS Public IP olarak oluşturun ve **Proxied** (turuncu bulut) yapın.
2. Caddy yapılandırmasını yerleştirin:
   ```bash
   sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
   ```
3. Cloudflare IP güncelleme betiğini ve timer'ını kurun:
   ```bash
   sudo cp deploy/cloudflare-ips.sh /usr/local/sbin/wpa-lite-cloudflare-ips
   sudo chmod +x /usr/local/sbin/wpa-lite-cloudflare-ips
   sudo cp deploy/wpa-lite-cfips.service deploy/wpa-lite-cfips.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now wpa-lite-cfips.timer
   ```
4. Betiği ilk kez çalıştırarak Caddy snippet'ini (`/etc/caddy/cloudflare-ips.caddy`) üretin ve UFW'yi Cloudflare aralıklarına kilitleyin:
   ```bash
   sudo /usr/local/sbin/wpa-lite-cloudflare-ips
   ```
5. Caddy'yi başlatın ve durumunu kontrol edin:
   ```bash
   sudo systemctl restart caddy
   sudo systemctl status caddy
   ```

---

## 4. Doğrulama ve Test Komutları

### 1. Çıkış Engeli (Egress Firewall) Doğrulaması
Backend container'ı içinden TCP bağlantı denemeleri:
```bash
# Dış internete erişim AÇIK olmalı:
docker compose exec backend curl -sI -m 5 https://example.com
# HTTP/2 200 döner.

# Docker ağ geçidine erişim ENGELLİ olmalı (zaman aşımı):
docker compose exec backend curl -m 3 http://172.30.240.1:22
# curl: (28) Connection timed out

# Host public IP'sine erişim ENGELLİ olmalı (zaman aşımı):
docker compose exec backend curl -m 3 http://<HOST_PUBLIC_IP>:22
# curl: (28) Connection timed out

# AWS/Cloud metadata IP'sine erişim ENGELLİ olmalı:
docker compose exec backend curl -m 3 http://169.254.169.254
# curl: (28) Connection timed out
```

> [!NOTE]
> **Bilinen İstisna:**
> Aynı Docker bridge ağındaki `web` container'ına (`http://172.30.240.x:8080`) erişim açık kalır; çünkü bridge içi yerel trafik `DOCKER-USER` zincirine düşmez. Nginx yalnızca statik dosya sunup API proxy'si yaptığından ve backend'e yeni bir yetki sağlamadığından bu durum bilinçli bir istisna olarak kabul edilmiştir.

### 2. Canlı Sağlık ve Tarama Kontrolü
```bash
# Yerel Caddy üzerinden sağlık kontrolü:
curl -s http://127.0.0.1:8081/api/health
# {"ok":true,"queue":{"running":0,"waiting":0},"dailyRemaining":200}

# Dış alan adı üzerinden Cloudflare üzerinden sağlık kontrolü:
curl -s https://wpa.onuracar.dev/api/health
# {"ok":true,"queue":{"running":0,"waiting":0},"dailyRemaining":200}
```

---

## 5. Doğrulanmış Sunucu Ölçüm Sonuçları (2026-10-16)

VDS üzerinde `CHROME_NO_SANDBOX=true` ile gerçekleştirilen gerçek testler:
- **`example.com` Taraması:**
  - 7/7 motor başarıyla tamamlandı (`completed`), süre: 26 sn.
  - Ölçülen tepe değerler (`docker stats`): 543 MiB RAM, %250 CPU.
- **`www.onuracar.dev` Taraması:**
  - 7/7 motor başarıyla tamamlandı (`completed`), süre: 98 sn.
  - Ölçülen tepe değerler (`docker stats`): 1.07 GiB RAM, %357 CPU.
- **Bellek Limiti:** Ölçülen tepe değerler doğrultusunda backend container bellek limiti `2500m` olarak ayarlanmıştır.

---

## 6. Rutin Bakım Prosedürleri

1. **Aylık Bağımlılık Güvenlik Denetimi:**
   ```bash
   cd /home/deploy/app/lite/backend && npm audit --omit=dev
   cd /home/deploy/app/lite/web && npm audit --omit=dev
   ```
2. **Uptime & Sağlık İzleme:**
   UptimeRobot veya benzeri bir harici izleme servisi ile `https://wpa.onuracar.dev/api/health` uç noktası 5 dakikalık aralıklarla yoklanmalıdır.
3. **Turnstile Entegrasyonu (Gelecek Görev):**
   Kötüye kullanımı sınırlandırmak için ileride Cloudflare Turnstile bot koruması frontend ve backend tarafında devreye alınabilir.

---

## 7. Geri Alma (Rollback) Adımları

Gerektiğinde uygulanan adımları geri almak için:

### Çıkış Engelini Kaldırma:
```bash
sudo systemctl disable --now wpa-lite-egress.service
sudo /usr/local/sbin/wpa-lite-egress-firewall --remove
```

### UFW Cloudflare Kilidini Kaldırma ve 80/443'ü Genel Erişime Açma:
```bash
sudo systemctl disable --now wpa-lite-cfips.timer
sudo /usr/local/sbin/wpa-lite-cloudflare-ips --remove
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw reload
```

### Caddy'yi Durdurma:
```bash
sudo systemctl stop caddy
sudo systemctl disable caddy
```

### Docker Container'larını Kapatma:
```bash
cd /home/deploy/app/lite
docker compose down
```
