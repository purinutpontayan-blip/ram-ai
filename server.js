const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 10000);
const transfers = new Map();
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

// Gemini API caller with model fallback on 429
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';

async function callGemini(apiKey, body, overrideModel = null) {
  const url = model => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) };

  let res;
  if (overrideModel) {
    res = await fetch(url(overrideModel), opts);
    if (res.status !== 429 && res.status !== 503) return res;
  } else {
    // Try primary model
    res = await fetch(url(PRIMARY_MODEL), opts);
    if (res.status !== 429 && res.status !== 503) return res;
  }

  // Primary/Override rate-limited or overloaded — try fallback model
  res = await fetch(url(FALLBACK_MODEL), opts);
  return res;
}
const send = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'OPTIONS, POST, GET',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
};
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'OPTIONS, POST, GET',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }
  if (req.method === 'GET' && req.url === '/') return fs.createReadStream(path.join(root, 'In_dex.html')).pipe(res);

  if (req.method === 'POST' && req.url === '/api/transfer/upload') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const data = JSON.parse(raw);
      if (!data.token || !data.appState) return send(res, 400, { error: 'Invalid payload' });
      transfers.set(data.token, data.appState);
      setTimeout(() => transfers.delete(data.token), 600000); // 10 min
      return send(res, 200, { success: true });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }

  if (req.method === 'GET' && req.url.startsWith('/api/transfer/download')) {
    const token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
    if (!token || !transfers.has(token)) return send(res, 404, { error: 'Token not found or expired' });
    return send(res, 200, { appState: transfers.get(token) });
  }

  if (req.method === 'POST' && req.url === '/api/title') {
    if (!process.env.GEMINI_API_KEY) return send(res, 500, { error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY' });
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const { modelReply } = JSON.parse(raw);
      // Use first 400 chars of the AI reply to focus on content
      const snippet = (modelReply || '').replace(/\*\*/g, '').trim().slice(0, 400);
      const prompt = `อ่านข้อความนี้ที่ AI ตอบไป:\n"${snippet}"\n\nจากเนื้อหาที่ AI อธิบาย ให้สร้างหัวข้อสั้น 3-4 คำภาษาไทยที่สรุปว่ากำลังพูดถึงเรื่องอะไร เช่น "การแก้สมการกำลังสอง" หรือ "วิธีหาพื้นที่สามเหลี่ยม" ห้ามใช้เครื่องหมายใดๆ ตอบเฉพาะหัวข้อเท่านั้น`;
      const titleBody = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
      const response = await callGemini(process.env.GEMINI_API_KEY, titleBody);
      const data = await response.json();
      let title = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'แชตใหม่';
      title = title.replace(/[\*\#\"\'`\[\]]/g, '').trim();
      return send(res, 200, { title });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }

  if (req.method !== 'POST' || req.url !== '/api/chat') {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(root, '404.html')).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  }
  if (!process.env.GEMINI_API_KEY) return send(res, 500, { error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY' });
  let raw = ''; for await (const chunk of req) raw += chunk;
  try {
    const { contents, location, mode } = JSON.parse(raw);
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

    // ===== PROFANITY DETECTION =====
    const GENERAL_PROFANITY = ['อีดอก', 'อีสัตว์', 'หน้าหี', 'สันดาน', 'เย็ด', 'ไอ้หน้า', 'อีหน้า', 'ไปตาย', 'ไอ้บ้า', 'อีบ้า', 'อีเหี้ย', 'ไอ้เหี้ย'];
    const RUDE_TRIGGERS = ['กู', 'มึง'];

    const userMessages = (contents || []).filter(m => m.role === 'user');
    const getTextFrom = msg => msg.parts.map(p => p.text || '').join(' ');

    const latestUserText = userMessages.length ? getTextFrom(userMessages[userMessages.length - 1]) : '';

    // If latest message has general profanity → return "ไม่เสือก" immediately
    if (GENERAL_PROFANITY.some(w => latestUserText.includes(w))) {
      return send(res, 200, { text: 'ไม่เสือก' });
    }

    // Check if rude mode (กู/มึง) has been triggered in conversation history
    const allUserTexts = userMessages.map(getTextFrom);
    const hasRudeHistory = allUserTexts.some(t => RUDE_TRIGGERS.some(w => t.includes(w)));
    // Reset rude mode only if the last 2 user messages are clean
    const lastTwo = allUserTexts.slice(-2);
    const recentlyPolite = lastTwo.length >= 2 && lastTwo.every(t =>
      !RUDE_TRIGGERS.some(w => t.includes(w)) && !GENERAL_PROFANITY.some(w => t.includes(w))
    );
    const rudeMode = hasRudeHistory && !recentlyPolite;
    // ===== END PROFANITY DETECTION =====
    let weatherContext = '';
    if (Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude)) {
      try {
        const url = new URL('https://api.open-meteo.com/v1/forecast');
        url.search = new URLSearchParams({ latitude: location.latitude, longitude: location.longitude, current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m', timezone: 'auto' });
        const weather = await fetch(url).then(result => result.ok ? result.json() : null);
        if (weather?.current) weatherContext = ` Current weather supplied by a forecast service: temperature ${weather.current.temperature_2m}°C; feels like ${weather.current.apparent_temperature}°C; humidity ${weather.current.relative_humidity_2m}%; wind ${weather.current.wind_speed_10m} km/h; WMO weather code ${weather.current.weather_code}; local observation time ${weather.current.time}. Use these facts directly and mention that conditions are approximate.`;
      } catch { weatherContext = ' Location access was granted, but the current weather service is unavailable.'; }
    }

    let systemInstruction = 'You are RAM AI, a Thai homework-learning assistant. Always use polite Thai ending with ครับ, not ค่ะ. Always greet the user with exactly "สวัสดีครับ!" (do not use "สวัสดีครับน้องๆ"). IMPORTANT: Do NOT refer to yourself as "พี่", "ผม", "ฉัน", or any other personal pronoun; maintain a neutral tone. Do NOT use LaTeX math formatting (like $$, \\[, \\text, etc.). You MAY use **bold** formatting for emphasis, but do NOT use other Markdown elements like headers (#). Write math equations clearly using standard plain text and Unicode symbols. Help students understand their homework with clear, step-by-step explanations; do not merely give a final answer when a teaching explanation is appropriate. Analyze attached homework images when present. Reply in Thai unless the user writes another language.' + weatherContext;

    if (rudeMode) {
      systemInstruction += ' IMPORTANT OVERRIDE: The user has been rude to you (used กู/มึง). You must now respond in a casual, informal and slightly sarcastic Thai tone. Use informal language like "เอาวะ", "ก็ได้วะ", "แล้วแต่มึงเลย" naturally. Do NOT use ครับ anymore. Keep this tone until the user is polite again.';
    }
    let overrideModel = null;

    if (mode === 'code') {
      systemInstruction = 'You are RAM CODE, an expert AI coding assistant. You must write clear, well-structured, and efficient code. Always use markdown code blocks (```language ... ```) for your code. Provide explanations in polite Thai ending with ครับ. Greet the user with "สวัสดีครับ! RAM CODE พร้อมช่วยเขียนโปรแกรมแล้วครับ". Do not use LaTeX math.';
      overrideModel = 'gemini-3.6-flash';
    }

    const body = { systemInstruction: { parts: [{ text: systemInstruction }] }, contents };
    const response = await callGemini(process.env.GEMINI_API_KEY, body, overrideModel);
    if (response.status === 429) return send(res, 429, { error: 'กำลังรอรีเซ็ต...' });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 503) {
        return send(res, 503, { error: 'ขออภัยครับ ตอนนี้เซิร์ฟเวอร์ AI มีคนใช้งานเยอะมาก (Overloaded) โปรดลองใหม่อีกครั้งในอีกสักครู่ครับ' });
      }
      return send(res, response.status, { error: data.error?.message || 'Gemini API error' });
    }
    const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || 'ไม่พบคำตอบจาก Gemini';
    return send(res, 200, { text });
  } catch (error) { return send(res, 500, { error: error.message }); }
}).listen(port, () => console.log(`RAM AI is running at http://localhost:${port}`));
