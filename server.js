const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');

const root = __dirname;
const port = Number(process.env.PORT || 10000);
const transfers = new Map();

// sessionToken -> { email, name, picture, expiresAt }
// Persisted to disk so logins survive a server restart (e.g. Render free-tier
// spinning the process down after inactivity) — otherwise everyone's session
// token would silently become invalid (401) even though the browser still
// thinks it's logged in. NOTE: on Render's free tier the disk itself is
// ephemeral — a redeploy or a cold start after sleep wipes this file, which
// will also produce a 401. That's expected; the user just needs to log in
// again. A paid plan with a persistent disk mounted here removes this.
const SESSIONS_FILE = path.join(root, 'data', 'sessions.json');
function loadSessions() {
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [token, session] of Object.entries(raw)) {
      if (session.expiresAt > now) map.set(token, session);
    }
  } catch { /* no file yet, or unreadable — start empty */ }
  return map;
}
function saveSessions() {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (e) { console.error('Failed to save sessions:', e); }
}
const sessions = loadSessions();

const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

// Load the configured Web OAuth client ID before constructing the verifier.
// Client IDs are public, but never fall back to a stale/deleted ID.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

function requireAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (session) { sessions.delete(token); saveSessions(); }
    return null;
  }
  return session;
}

// ===== Redeem codes (PRO unlock) =====
// โค้ดทั้งหมดจัดการผ่าน Google Sheet เท่านั้น — ไม่มีโค้ดฝังอยู่ในไฟล์นี้
//
// ----- Google Sheet setup (ไม่ต้องใช้ API key) -----
//   1. เปิดชีต → Share → เปลี่ยนเป็น "Anyone with the link" → Viewer
//   2. Sheet layout — แถวที่ 1 เป็น header (จะถูกข้าม), ข้อมูลเริ่มแถวที่ 2:
//        A: code          e.g. RAM_AI_V1.0
//        B: days          e.g. 15            (PRO days granted)
//        C: maxUses       e.g. 100           (เว้นว่าง = ไม่จำกัด)
//        D: start         e.g. 2026-08-20T09:00:00+07:00   (เว้นว่าง = ใช้ default ด้านล่าง)
//        E: end           e.g. 2026-08-25T23:59:59+07:00   (เว้นว่าง = ใช้ default ด้านล่าง)
//      รูปแบบวันที่: YYYY-MM-DDTHH:mm:ss+07:00
//   3. ตั้งค่า environment variables บนเซิร์ฟเวอร์:
//        REDEEM_SHEET_ID  = ID ที่อยู่ใน URL ของชีต (…/spreadsheets/d/THIS_PART/edit)
//        REDEEM_SHEET_GID = optional, default '0' (แท็บแรกของชีต) — ถ้าโค้ดอยู่แท็บอื่น
//                            ให้เปิดแท็บนั้นแล้วดูเลข gid= ท้าย URL ในเบราว์เซอร์
//      ใช้ gid (เลข ID ของแท็บ) แทนชื่อแท็บ เพราะเชื่อถือได้กว่า — ชื่อแท็บที่พิมพ์ผิด/ไม่ตรง
//      เป๊ะๆ เป็นสาเหตุที่พบบ่อยที่สุดที่ทำให้ดึงโค้ดได้ 0 รายการ
//   4. แก้ไขแถวในชีตได้ตลอดเวลา — ระบบจะดึงใหม่ภายใน ~1 นาที ไม่ต้อง redeploy
//   NOTE: ถ้าไม่ได้ตั้งค่า REDEEM_SHEET_ID หรือดึงชีตไม่สำเร็จ จะไม่มีโค้ดใดใช้งานได้เลย
//   DEBUG: ดู Render → Logs หลังกดปลดล็อก จะเห็นบรรทัด [redeem] บอกว่าดึงโค้ดได้กี่ตัว
//          และโค้ดที่ผู้ใช้กรอกตรงกับที่มีอยู่หรือไม่

// Fallback window — ใช้เฉพาะกรณีแถวในชีตไม่ได้กรอก start/end
const REDEEM_DEFAULT_START = new Date('2026-08-14T00:00:00+07:00').getTime();
const REDEEM_DEFAULT_END = new Date('2026-08-18T23:59:59+07:00').getTime();

const REDEEM_SHEET_GID = process.env.REDEEM_SHEET_GID || '0';
const REDEEM_SHEET_CACHE_MS = 60 * 1000; // re-fetch the sheet at most once a minute
let redeemCodesCache = null;
let redeemCodesCacheAt = 0;

// Minimal CSV line parser — handles quoted fields with embedded commas/quotes,
// which is all Google's CSV export produces. Trims every field to kill stray
// whitespace that would otherwise make a code fail to match.
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields.map(f => f.trim());
}

async function fetchCodesFromSheet() {
  const sheetId = process.env.REDEEM_SHEET_ID;
  if (!sheetId) return null; // Sheet integration not configured — caller falls back to empty table

  // Public CSV export by gid (numeric tab ID) — works without any API key as
  // long as the sheet is shared "Anyone with the link" → Viewer. Using gid
  // instead of a sheet name avoids silent mismatches from name typos/casing.
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${encodeURIComponent(REDEEM_SHEET_GID)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Sheets CSV export error: ${res.status}`);
  let csvText = await res.text();
  csvText = csvText.replace(/^\uFEFF/, ''); // strip BOM if present — Google sometimes adds it

  const lines = csvText.split(/\r?\n/).filter(l => l.trim() !== '');
  const dataLines = lines.slice(1); // skip header row

  const codes = {};
  for (const line of dataLines) {
    const [code, days, maxUses, start, end] = parseCsvLine(line);
    if (!code) continue;
    codes[code.toUpperCase()] = {
      days: Number(days) || 0,
      maxUses: (maxUses !== undefined && maxUses !== '') ? Number(maxUses) : null,
      start: start || undefined,
      end: end || undefined,
    };
  }
  if (Object.keys(codes).length === 0) {
    // Debug aid: show what we actually got back so a mis-set gid is obvious in logs.
    console.log(`[redeem] Sheet fetch returned ${lines.length} raw line(s); first line: ${JSON.stringify(lines[0] || '(empty)')}`);
  }
  console.log(`[redeem] Loaded ${Object.keys(codes).length} code(s) from Sheet (gid=${REDEEM_SHEET_GID}):`, Object.keys(codes));
  return codes;
}

// Returns the current code table, cached for REDEEM_SHEET_CACHE_MS.
// ไม่มี fallback ไปตารางฝังไฟล์ — ถ้าชีตใช้ไม่ได้ ถือว่าไม่มีโค้ดใดใช้งานได้ชั่วคราว
async function getRedeemCodes() {
  const now = Date.now();
  if (redeemCodesCache && (now - redeemCodesCacheAt) < REDEEM_SHEET_CACHE_MS) {
    return redeemCodesCache;
  }
  try {
    const fromSheet = await fetchCodesFromSheet();
    redeemCodesCache = fromSheet || {};
    redeemCodesCacheAt = now;
    return redeemCodesCache;
  } catch (e) {
    console.error('Failed to load redeem codes from Google Sheet:', e.message);
    redeemCodesCache = {};
    redeemCodesCacheAt = now;
    return redeemCodesCache;
  }
}

// Usage is persisted to disk so counts survive server restarts.
const REDEEM_DATA_FILE = path.join(root, 'data', 'redeem-usage.json');
function loadRedeemUsage() {
  try { return JSON.parse(fs.readFileSync(REDEEM_DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveRedeemUsage(usage) {
  try {
    fs.mkdirSync(path.dirname(REDEEM_DATA_FILE), { recursive: true });
    fs.writeFileSync(REDEEM_DATA_FILE, JSON.stringify(usage, null, 2));
  } catch (e) { console.error('Failed to save redeem usage:', e); }
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

  if (req.method === 'GET' && req.url === '/api/config') {
    return send(res, 200, { googleClientId: GOOGLE_CLIENT_ID });
  }

  if (req.method === 'POST' && req.url === '/api/auth/google') {
    if (!process.env.GOOGLE_CLIENT_ID) return send(res, 500, { error: 'ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID' });
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const { credential } = JSON.parse(raw);
      if (!credential) return send(res, 400, { error: 'Missing credential' });
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      const sessionToken = crypto.randomUUID();
      sessions.set(sessionToken, {
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
        expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7 // 7 วัน
      });
      saveSessions();
      return send(res, 200, {
        success: true,
        token: sessionToken,
        user: { email: payload.email, name: payload.name, picture: payload.picture }
      });
    } catch (e) {
      return send(res, 401, { error: 'Invalid Google token' });
    }
  }

  if (req.method === 'POST' && req.url === '/api/auth/logout') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token) { sessions.delete(token); saveSessions(); }
    return send(res, 200, { success: true });
  }

  if (req.method === 'GET' && req.url === '/api/auth/me') {
    const user = requireAuth(req);
    if (!user) return send(res, 401, { error: 'Not authenticated' });
    return send(res, 200, { user: { email: user.email, name: user.name, picture: user.picture } });
  }

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

  if (req.method === 'POST' && req.url === '/api/redeem') {
    const user = requireAuth(req);
    if (!user) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบด้วย Google ก่อนใช้โค้ดครับ' });
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const { code } = JSON.parse(raw);
      const normalized = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!normalized) return send(res, 400, { error: 'กรุณากรอกโค้ดก่อนครับ' });

      const codesTable = await getRedeemCodes();
      console.log(`[redeem] User submitted code: "${normalized}" — available: [${Object.keys(codesTable).join(', ')}]`);
      const cfg = codesTable[normalized];
      if (!cfg) return send(res, 400, { error: 'โค้ดไม่ถูกต้อง กรุณาตรวจสอบอีกครั้งครับ' });

      const start = cfg.start ? new Date(cfg.start).getTime() : REDEEM_DEFAULT_START;
      const end = cfg.end ? new Date(cfg.end).getTime() : REDEEM_DEFAULT_END;
      const now = Date.now();
      const thaiDate = ms => new Date(ms).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      if (now < start) return send(res, 400, { error: `โค้ดนี้ยังไม่ถึงเวลาเปิดใช้งานครับ (เปิดใช้ ${thaiDate(start)})` });
      if (now > end) return send(res, 400, { error: `โค้ดนี้หมดอายุแล้วครับ (หมดอายุเมื่อ ${thaiDate(end)})` });

      const usage = loadRedeemUsage();
      const entry = usage[normalized] || { users: {} };

      // Same user redeeming again — return their existing expiry instead of counting them twice
      if (entry.users[user.email]) {
        return send(res, 200, { success: true, expiry: entry.users[user.email], alreadyRedeemed: true });
      }

      const usedCount = Object.keys(entry.users).length;
      if (cfg.maxUses != null && usedCount >= cfg.maxUses) {
        return send(res, 400, { error: `ขออภัยครับ โค้ดนี้ถูกใช้ครบ ${cfg.maxUses} คนแล้ว` });
      }

      const expiry = now + cfg.days * 24 * 60 * 60 * 1000;
      entry.users[user.email] = expiry;
      usage[normalized] = entry;
      saveRedeemUsage(usage);

      return send(res, 200, {
        success: true,
        expiry,
        remaining: cfg.maxUses != null ? Math.max(0, cfg.maxUses - Object.keys(entry.users).length) : null
      });
    } catch (e) { return send(res, 500, { error: e.message }); }
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
    const { contents, location, mode, codeModel, aiModel } = JSON.parse(raw);
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

    let systemInstruction = 'You are RAM AI, a Thai homework-learning assistant. Always use polite Thai ending with ครับ, not ค่ะ. Always greet the user with exactly "สวัสดีครับ!" (do not use "สวัสดีครับน้องๆ"). IMPORTANT: Never address or refer to the user as "น้อง" anywhere in your reply, including outside the greeting (e.g. do not write things like "น้องสามารถพิมพ์คำถาม..."). Do not use any other kinship or age-based terms for the user either. Simply speak to the user directly and neutrally without using a term of address for them. Do NOT refer to yourself as "พี่", "ผม", "ฉัน", or any other personal pronoun; maintain a neutral tone. Do NOT use LaTeX math formatting (like $$, \\[, \\text, etc.). You MAY use **bold** formatting for emphasis, but do NOT use other Markdown elements like headers (#). Write math equations clearly using standard plain text and Unicode symbols. Help students understand their homework with clear, step-by-step explanations; do not merely give a final answer when a teaching explanation is appropriate. Analyze attached homework images when present. Reply in Thai unless the user writes another language.' + weatherContext;

    if (rudeMode) {
      systemInstruction += ' IMPORTANT OVERRIDE: The user has been rude to you (used กู/มึง). You must now respond in a casual, informal and slightly sarcastic Thai tone. Use informal language like "เอาวะ", "ก็ได้วะ", "แล้วแต่มึงเลย" naturally. Do NOT use ครับ anymore. Keep this tone until the user is polite again.';
    }
    let overrideModel = null;

    if (mode === 'code') {
      // Map codeModel from client to actual Gemini model
      const CODE_MODELS = {
        'code1': 'gemini-3-flash',  // RAM CODE 1.0
        'code2': 'gemini-3.6-flash',  // RAM CODE 2.0
        'code3': 'gemini-3.7-flash',  // RAM CODE 3.0 (PRO)
      };
      overrideModel = CODE_MODELS[codeModel] || 'gemini-2.5-flash';
      const modelVersion = codeModel === 'code3' ? '3.0' : codeModel === 'code2' ? '2.0' : '1.0';
      systemInstruction = `You are RAM CODE ${modelVersion}, an expert AI coding assistant. You must write clear, well-structured, and efficient code. Always use markdown code blocks (\`\`\`language ... \`\`\`) for your code. Provide explanations in polite Thai ending with ครับ. Greet the user with "สวัสดีครับ! RAM CODE ${modelVersion} พร้อมช่วยเขียนโปรแกรมแล้วครับ". Do not use LaTeX math.`;
    } else {
      // Map aiModel from client to actual Gemini model (RAM AI mode)
      const AI_MODELS = {
        'ai1': 'gemini-3.5-flash-lite', // RAM AI 1.5
        'ai2': 'gemini-3.5-flash',      // RAM AI 2.0
        'ai3': 'gemini-3.6-flash',      // RAM AI 3.5 (PRO)
        'ai4': 'gemini-3.7-flash',      // RAM AI 4.0 (PRO)
      };
      overrideModel = AI_MODELS[aiModel] || AI_MODELS['ai2'];
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
