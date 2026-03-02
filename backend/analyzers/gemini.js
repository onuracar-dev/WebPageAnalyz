const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs').promises;
const path = require('path');

async function solveIssueWithGemini(issue) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not defined in .env');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    let prompt = `
Sen uzman bir Frontend Geliştiricisi ve web performans danışmanısın.
Aşağıdaki sorun için benden istenen düzeltmeyi analiz et ve doğrudan kullanılabilir, kısa ve net bir çözüm/kod örneği sun.
Eğer sorun bir HTML/CSS/JS kodu içeriyorsa, lütfen düzeltilmiş halini markdown " \`\`\` " kod bloğu içinde paylaş.
Lütfen gereksiz uzun açıklamalardan kaçın ve sadece sorunun çözümüne odaklan.

Sorun Başlığı: ${issue.title}
Açıklama: ${issue.description || 'Belirtilmedi'}
Kaynak: ${issue.source}
`;

    if (issue.snippet) {
        prompt += `\nHatalı Kod Parçacığı (Snippet):\n\`\`\`html\n${issue.snippet}\n\`\`\`\n`;
    }

    try {
        console.log("Calling Gemini API for issue resolution...");
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (err) {
        console.error("Gemini API Error:", err);
        throw err;
    }
}

async function generateExecutiveSummary(scores) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not defined in .env');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `
Sen uzman bir Dijital Pazarlama Direktörü (CMO) ve İş Geliştirme Danışmanısın.
Bir web sitesinin teknik analizini tamamladık ve 100 üzerinden şu skorları elde ettik:
- Performans: ${scores.performance}
- SEO: ${scores.seo}
- Erişilebilirlik: ${scores.accessibility}
- En İyi Pratikler: ${scores.bestPractices}

Görev: Şirketin CEO'su ve üst yönetimi için bu teknik metrikleri "Ciro (Revenue), Dönüşüm Oranı (Conversion Rate), ve Müşteri Kaybı (Churn)" gibi iş dünyası (business) diline çevirerek 1-2 paragraflık vurucu bir "Yönetici Özeti (Executive Summary)" yaz.

Kurallar:
1. Teknik div, css, js terimlerine asla girme.
2. Amazon veya Google'ın araştırmaları gibi gerçekçi sektör standartlarına atıfta bulunarak (örneğin "hızdaki 1 saniyelik gecikme %7 dönüşüm kaybına yol açar") skorları değerlendir.
3. Çıktı çok profesyonel, Türkçe ve doğrudan aksiyona teşvik edici olsun.
4. Çıktıyı markdown formatında şekillendir (Koyu yazılar, madde imleri vb. kullanabilirsin ama çok uzatma).
`;

    try {
        console.log("Calling Gemini API for Executive Summary...");
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (err) {
        console.error("Gemini Executive Summary Error:", err);
        throw err;
    }
}

module.exports = { solveIssueWithGemini, generateExecutiveSummary };
