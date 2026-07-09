# WebPage Analyzer (v2.0)

## Project Snapshot

WebPage Analyzer is a full-stack audit dashboard that combines Lighthouse, YellowLabTools, Axe, and Gemini-powered remediation suggestions. It is useful as a portfolio project because it turns raw technical reports into an interactive workflow for performance, SEO, accessibility, and code-fix guidance.

- **Core idea:** scan a URL, aggregate multiple audit engines, and generate actionable AI repair notes.
- **Recent hardening:** frontend API calls now use `VITE_API_BASE_URL`, YellowLab polling has a timeout, and unused backend packages were removed.
- **Validation:** frontend `npm run lint`, frontend `npm run build`, and backend JavaScript syntax checks.
Gelişmiş Dashboard ve İnteraktif AI destekli Web Sayfası Analiz Aracı.

**Geliştirici:** [Onur Acar](https://github.com/onuracar-dev) | ✉️ onuracar.work@gmail.com

Bu proje, bir web sitesinin Performans, SEO ve Erişilebilirlik (Accessibility) metriklerini **Lighthouse, YellowLabTools ve Axe DevTools** kullanarak denetler ve "AI ile Çöz" butonu sayesinde **Gemini 2.5 Flash** kullanarak anında nokta atışı kod çözümleri sunar.

---

## 🚀 Başka Bir Cihazda Nasıl Çalıştırılır?

Bu projeyi farklı bir bilgisayara taşıdığınızda sorunsuz çalıştırmak için aşağıdaki adımları sırayla izleyin.

### 1. Gereksinimler
Bilgisayarınızda şunların kurulu olduğundan emin olun:
- **Node.js** (v18 veya üzeri önerilir): indirmek için [nodejs.org](https://nodejs.org/)
- **Git** (isteğe bağlı)
- Stabil bir internet bağlantısı (Test araçlarının sayfaları gezebilmesi için)

### 2. Bağımlılıkları (Kütüphaneleri) Yükleme
Proje iki klasörden (Backend ve Frontend) oluşur. İkisinin de kütüphanelerini ayrı ayrı indirmelisiniz.

**Backend Kütüphaneleri:**
Terminali (CMD veya PowerShell) açın ve `backend` klasörüne gidin, ardından şu komutu çalıştırın:
```bash
cd backend
npm install
```
*(Bu işlem Lighthouse, Express, Puppeteer, Axe ve Yellowlab kütüphanelerini indirecektir.)*

**Frontend Kütüphaneleri:**
Yeni bir terminal açın ve `frontend` klasörüne gidin, ardından şu komutu çalıştırın:
```bash
cd frontend
npm install
```
*(Bu işlem React, Vite, Framer Motion ve diğer arayüz araçlarını indirecektir.)*

### 3. Çevre Değişkenlerini (API Key) Ayarlama
Backend'in yapay zeka özelliklerini kullanabilmesi için Gemini API anahtarına ihtiyacı vardır. 
`backend` klasörünün içinde `.env` adında bir dosya oluşturun (eğer yoksa) ve içine şunları yazın:

```env
PORT=5000
GEMINI_API_KEY=BURAYA_KENDI_GEMINI_API_ANAHTARINIZI_YAZIN
```
*(Eğer bir API anahtarınız yoksa [Google AI Studio](https://aistudio.google.com/app/apikey) adresinden ücretsiz alabilirsiniz.)*

### 4. Projeyi Başlatma

Aynı anda hem Backend'i hem de Frontend'i çalıştırmalısınız.

**1. Terminal (Backend):**
```bash
cd backend
npm run start
```
*(Ekranda "Server is running on port 5000" yazısını görmelisiniz.)*

**2. Terminal (Frontend):**
```bash
cd frontend
npm run dev
```
*(Ekranda "Local: http://localhost:5173" yazısını görmelisiniz.)*

Her şey hazır! Tarayıcınızda `http://localhost:5173` adresine giderek analiz aracını kullanmaya başlayabilirsiniz.

---
