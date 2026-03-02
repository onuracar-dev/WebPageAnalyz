const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

async function listAllModels() {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    // Since there's no native listModels in the older SDK without passing it, actually listModels might not be exposed.
    // Let's just try to fetch via raw HTTP to be sure.
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    console.log(JSON.stringify(data.models.map(m => m.name), null, 2));
}

listAllModels().catch(console.error);
