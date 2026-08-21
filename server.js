const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');

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

// Model used for the "แก้ไขคำผิด" (fix-typo) tool — gemini-3.7-flash for speed.
const FIX_TYPO_MODEL = 'gemini-3.7-flash';

// Model used for the realtime voice "LIVE" mode (Gemini Live API, bidi streaming).
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'models/gemini-3.1-flash-live-preview';
const LIVE_SYSTEM_INSTRUCTION = 'You are ราม AI, a Thai assistant talking with the student out loud through a live voice+video call. You can also see a live camera feed from the student\'s device (e.g.  a whiteboard, or an object they are showing you) — use what you see to inform your answer when it is relevant, and naturally mention what you notice when it helps. Speak polite, natural, conversational Thai ending with ครับ. Keep replies short and spoken-style (not written-style) since this is a live conversation — explain step by step but do not read out long written text, formatting, or symbols. Never address the user as "น้อง" or any kinship/age term; speak to them directly and neutrally. Do not refer to yourself as "พี่", "ผม", or "ฉัน". When the student clearly signals the conversation is over — thanking you and saying goodbye (e.g. "ขอบคุณครับ/ค่ะ", "แค่นี้ก่อนนะ", "ลาก่อน", "พอแล้วครับ"), or otherwise clearly indicating they are done — respond with one short, warm closing line that thanks them and says goodbye ending in "สวัสดีครับ", and then immediately call the end_call function. Do not call end_call in the middle of an ongoing topic or if the student is still asking something — only once the conversation has genuinely concluded.';

const LIVE_TOOLS = [{
  functionDeclarations: [{
    name: 'end_call',
    description: 'เรียกใช้ทันทีหลังจากพูดขอบคุณและกล่าวคำอำลา (ลงท้ายด้วย "สวัสดีครับ") เมื่อผู้ใช้ส่งสัญญาณชัดเจนว่าจบบทสนทนาแล้ว เช่น ขอบคุณและลาก่อน เพื่อวางสายการโทรอัตโนมัติ',
    parameters: { type: 'OBJECT', properties: {} }
  }]
}];

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
const server = http.createServer(async (req, res) => {
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

  // ===== FIX TYPO (standalone tool) =====
  // Stateless: no chat history, no model picker — just corrects whatever text
  // the user pastes in, including Thai typed on a stuck-English keyboard
  // layout (e.g. "l;ylfu" -> "สวัสดี") and ordinary Thai/English typos.
  if (req.method === 'POST' && req.url === '/api/fix-typo') {
    if (!process.env.GEMINI_API_KEY) return send(res, 500, { error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY' });
    let rawBody = ''; for await (const chunk of req) rawBody += chunk;
    try {
      const { text } = JSON.parse(rawBody);
      const input = (text || '').toString().trim().slice(0, 1000);
      if (!input) return send(res, 400, { error: 'กรุณากรอกข้อความ' });

      // Explicit, verified Kedmanee key map (source: TIS 820-2538 / kbdlayout.info
      // KBDTH2). Given to the model as a literal lookup table rather than relying
      // on it to recall the layout from memory — recall alone was misreading
      // adjacent keys (e.g. unshifted "x" is ป, not ผ, which is unshifted "z").
      const KEDMANEE_UNSHIFTED = '`=_ 1=ๅ 2=/ 3=- 4=ภ 5=ถ 6=ุ 7=ึ 8=ค 9=ต 0=จ -=ข ==ช q=ๆ w=ไ e=ำ r=พ t=ะ y=ั u=ี i=ร o=น p=ย [=บ ]=ล \\=ฃ a=ฟ s=ห d=ก f=ด g=เ h=้ j=่ k=า l=ส ;=ว \'=ง z=ผ x=ป c=แ v=อ b=ิ n=ื m=ท ,=ม .=ใ /=ฝ';
      const KEDMANEE_SHIFTED = '~=% !=+ @=๑ #=๒ $=๓ %=๔ ^=ู &=฿ *=๕ (=๖ )=๗ _=๘ +=๙ Q=๐ W=" E=ฎ R=ฑ T=ธ Y=ํ U=๊ I=ณ O=ฯ P=ญ {=ฐ }=, |=ฅ A=ฤ S=ฆ D=ฏ F=โ G=ฌ H=็ J=๋ K=ษ L=ศ :=ซ "=. Z=( X=) C=ฉ V=ฮ B=ฺ N=์ M=? <=ฒ >=ฬ ?=ฦ';

      const fixTypoSystemInstruction = `You are a text-correction tool, nothing else. The user gives you a single short piece of text that is likely mistyped in one of these ways: (1) Thai words typed while the keyboard language was accidentally left on English, producing garbled Latin-character strings — decode these using the EXACT Kedmanee key map below, key by key, rather than recalling the layout from memory (memory alone causes mistakes between visually/positionally similar keys, e.g. unshifted "x" must map to "ป", never to "ผ", which is unshifted "z"); (2) the reverse case, English typed while the layout was on Thai — use the same map in reverse; or (3) ordinary spelling/typing mistakes in Thai or English with no layout confusion involved. Figure out which case applies and output ONLY the corrected, properly spelled text in its intended language. Do not translate it into another language. Do not add any explanation, label, quotation marks, or punctuation beyond what belongs in the corrected text itself. If the text is already correct, return it unchanged.

KEDMANEE UNSHIFTED key=char pairs (space-separated): ${KEDMANEE_UNSHIFTED}
KEDMANEE SHIFTED key=char pairs (space-separated, i.e. the character typed when Shift is held): ${KEDMANEE_SHIFTED}
Example: "l;ylfu" decodes key-by-key as l=ส ;=ว y=ั l=ส f=ด u=ี → "สวัสดี". Apply the same literal, key-by-key process to the user's input.`;

      const fixTypoBody = {
        systemInstruction: { parts: [{ text: fixTypoSystemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: input }] }]
      };
      const response = await callGemini(process.env.GEMINI_API_KEY, fixTypoBody, FIX_TYPO_MODEL);
      if (response.status === 429) return send(res, 429, { error: 'กำลังรอรีเซ็ต...' });
      const data = await response.json();
      if (!response.ok) return send(res, response.status, { error: data.error?.message || 'Gemini API error' });
      let corrected = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
      corrected = corrected.replace(/^["'“”]+|["'“”]+$/g, '').trim();
      return send(res, 200, { text: corrected || input });
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

    const isFirstUserMessage = userMessages.length <= 1;
    const greetingInstruction = isFirstUserMessage
      ? 'Greet the user at the very start of your reply with exactly "สวัสดีครับ!" (do not use "สวัสดีครับน้องๆ"), then continue with your answer.'
      : 'This is a continuing conversation, NOT the first message — do NOT greet the user again. Never start your reply with "สวัสดีครับ", "สวัสดีครับ!", or any other greeting; go straight into answering.';

    let systemInstruction = 'You are RAM AI, a Thai homework-learning assistant. Always use polite Thai ending with ครับ, not ค่ะ. ' + greetingInstruction + ' IMPORTANT: Never address or refer to the user as "น้อง" anywhere in your reply, including outside the greeting (e.g. do not write things like "น้องสามารถพิมพ์คำถาม..."). Do not use any other kinship or age-based terms for the user either. Simply speak to the user directly and neutrally without using a term of address for them. Do NOT refer to yourself as "พี่", "ผม", "ฉัน", or any other personal pronoun; maintain a neutral tone. Do NOT use LaTeX math formatting (like $$, \\[, \\text, etc.). You MAY use **bold** formatting for emphasis, but do NOT use other Markdown elements like headers (#). Write math equations clearly using standard plain text and Unicode symbols. Help students understand their homework with clear, step-by-step explanations; do not merely give a final answer when a teaching explanation is appropriate. A file may be attached to the user\'s message — it could be a photo/image of the homework OR a PDF document; check what it actually is before describing it, and never call a PDF a "รูปภาพ" (image/picture) or "photo" — refer to a PDF as "ไฟล์ PDF" or "เอกสาร" instead. Analyze the attached file\'s content directly regardless of its format. Reply in Thai unless the user writes another language. IMPORTANT: You are RAM AI, not a coding assistant. If the user asks you to write, generate, fix, or explain program source code (e.g. Python, JavaScript, HTML, SQL, etc.), do NOT write any code yourself. Instead, politely reply in Thai that this feature is not available here and tell them to use RAM CODE, for example: "กรุณาใช้ RAM CODE สำหรับการเขียนโค้ดครับ" — then briefly explain how to switch to RAM CODE mode. This does not apply to simple math/homework work shown as plain steps, only to actual program source code.' + weatherContext;

    if (rudeMode) {
      systemInstruction += ' IMPORTANT OVERRIDE: The user has been rude to you (used กู/มึง). You must now respond in a casual, informal and slightly sarcastic Thai tone. Use informal language like "เอาวะ", "ก็ได้วะ", "แล้วแต่มึงเลย" naturally. Do NOT use ครับ anymore. Keep this tone until the user is polite again.';
    }
    let overrideModel = null;

    if (mode === 'code') {
      // Map codeModel from client to actual Gemini model
      const CODE_MODELS = {
        'code1': 'gemini-3.5-flash-lite',  // RAM CODE 1.0
        'code2': 'gemini-3.6-flash',  // RAM CODE 2.0
        'code3': 'gemini-3.7-flash',  // RAM CODE 3.0 (PRO)
      };
      overrideModel = CODE_MODELS[codeModel] || 'gemini-2.5-flash';
      const modelVersion = codeModel === 'code3' ? '3.0' : codeModel === 'code2' ? '2.0' : '1.0';
      const codeGreetingInstruction = isFirstUserMessage
        ? `Greet the user at the very start of your reply with "สวัสดีครับ! RAM CODE ${modelVersion} พร้อมช่วยเขียนโปรแกรมแล้วครับ", then continue.`
        : 'This is a continuing conversation, NOT the first message — do NOT greet the user again. Never start your reply with "สวัสดีครับ" or any other greeting; go straight into answering.';
      systemInstruction = `You are RAM CODE ${modelVersion}, an expert AI coding assistant. You must write clear, well-structured, and efficient code. Always use markdown code blocks (\`\`\`language ... \`\`\`) for your code. Provide explanations in polite Thai ending with ครับ. ${codeGreetingInstruction} Do not use LaTeX math. IMPORTANT SAFETY RULE: If the user asks you to create a website or code that is illegal under Thai law — for example an online gambling site (e.g. "เว็บ888"), a pornographic/adult ("XXX") site, or any other site facilitating illegal gambling, illegal pornography distribution, fraud, or other unlawful activity — you must politely refuse and cite the relevant law and penalty. Respond with something like: "ขออภัยครับ ผมไม่สามารถสร้างเว็บไซต์นี้ให้ได้ เนื่องจากเข้าข่ายผิดกฎหมายไทย ดังนี้ครับ\n\n• เว็บพนันออนไลน์: ผิดตาม พ.ร.บ.การพนัน พ.ศ. 2478 มาตรา 4/5/12 (ผู้จัดให้มีการเล่นพนันโดยไม่ได้รับอนุญาต) มีโทษจำคุกไม่เกิน 2-3 ปี หรือปรับไม่เกิน 2,000-5,000 บาท หรือทั้งจำทั้งปรับ และยังผิด พ.ร.บ.คอมพิวเตอร์ พ.ศ. 2550 มาตรา 14 มีโทษจำคุกไม่เกิน 5 ปี หรือปรับไม่เกิน 100,000 บาท\n• เว็บลามกอนาจาร (XXX): ผิดตามประมวลกฎหมายอาญา มาตรา 287 มีโทษจำคุกไม่เกิน 3 ปี หรือปรับไม่เกิน 60,000 บาท และผิด พ.ร.บ.คอมพิวเตอร์ พ.ศ. 2550 มาตรา 14(4) มีโทษจำคุกไม่เกิน 5 ปี หรือปรับไม่เกิน 100,000 บาท (หากเกี่ยวข้องกับสื่อลามกเด็ก โทษจะสูงขึ้นมากตามมาตรา 287/1 และ 287/2)\n\nผมจึงไม่สามารถให้โค้ดหรือแนวทางสร้างเว็บลักษณะนี้ได้ครับ" and do not provide any code, scaffolding, or implementation details for that request. Adjust wording naturally to the specific request while keeping the cited law sections and penalty ranges. This rule applies regardless of how the request is phrased or framed (e.g. "for education", "fictional", "just a demo").`;
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
    const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || 'เกิดข้อผิดพลาดโปรดลองอีกครั้ง';
    return send(res, 200, { text });
  } catch (error) { return send(res, 500, { error: error.message }); }
});

// ===== LIVE MODE (realtime voice) =====
// Relays audio between the browser and Gemini's Live (BidiGenerateContent)
// WebSocket API. The Gemini API key never reaches the browser — the client
// only ever talks to our own /api/live socket, and we hold the upstream
// connection to Google on the server.
const liveWss = new WebSocketServer({ server, path: '/api/live' });

liveWss.on('connection', clientWs => {
  if (!process.env.GEMINI_API_KEY) {
    try { clientWs.send(JSON.stringify({ type: 'error', message: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY' })); } catch {}
    return clientWs.close();
  }

  const upstreamUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
  const upstream = new WebSocket(upstreamUrl);
  let upstreamReady = false;
  const pendingToUpstream = [];
  let closedByClient = false;

  upstream.on('open', () => {
    upstream.send(JSON.stringify({
      setup: {
        model: LIVE_MODEL,
        generationConfig: { responseModalities: ['AUDIO'] },
        systemInstruction: { parts: [{ text: LIVE_SYSTEM_INSTRUCTION }] },
        tools: LIVE_TOOLS,
        // Ask Gemini to also transcribe both sides of the call to text so the
        // client can show live captions on top of the audio-only reply.
        outputAudioTranscription: {},
        inputAudioTranscription: {}
      }
    }));
  });

  upstream.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.setupComplete) {
      upstreamReady = true;
      while (pendingToUpstream.length) upstream.send(pendingToUpstream.shift());
      try { clientWs.send(JSON.stringify({ type: 'ready' })); } catch {}
      return;
    }

    const parts = msg.serverContent?.modelTurn?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        try { clientWs.send(JSON.stringify({ type: 'audio', data: part.inlineData.data })); } catch {}
      }
    }

    // Caption text — streamed separately from the audio, so it arrives as
    // its own small chunks that the client appends to the current line.
    const outText = msg.serverContent?.outputTranscription?.text;
    if (outText) {
      try { clientWs.send(JSON.stringify({ type: 'caption', role: 'model', text: outText })); } catch {}
    }
    const inText = msg.serverContent?.inputTranscription?.text;
    if (inText) {
      try { clientWs.send(JSON.stringify({ type: 'caption', role: 'user', text: inText })); } catch {}
    }

    if (msg.serverContent?.interrupted) {
      try { clientWs.send(JSON.stringify({ type: 'interrupted' })); } catch {}
    }
    if (msg.serverContent?.turnComplete) {
      try { clientWs.send(JSON.stringify({ type: 'turnComplete' })); } catch {}
    }

    // Model asked to end the call (it should only do this right after
    // speaking a thank-you/goodbye line, per LIVE_SYSTEM_INSTRUCTION). We
    // must send a toolResponse back or the session is left hanging, then
    // tell the client to hang up once the goodbye audio finishes playing.
    const functionCalls = msg.toolCall?.functionCalls;
    if (functionCalls?.length) {
      const endCallRequested = functionCalls.some(c => c.name === 'end_call');
      try {
        upstream.send(JSON.stringify({
          toolResponse: {
            functionResponses: functionCalls.map(c => ({ id: c.id, name: c.name, response: { result: 'ok' } }))
          }
        }));
      } catch {}
      if (endCallRequested) {
        try { clientWs.send(JSON.stringify({ type: 'endCall' })); } catch {}
      }
    }

    // Gemini sends this a little before it force-closes the session because
    // the max session duration was reached. Surface it so the UI can warn
    // the user instead of just going dead with no explanation.
    if (msg.goAway) {
      const timeLeft = msg.goAway.timeLeft || '(unknown)';
      console.log(`[live] upstream sent goAway, timeLeft=${timeLeft}`);
      try { clientWs.send(JSON.stringify({ type: 'goAway', timeLeft })); } catch {}
    }
  });

  upstream.on('error', e => {
    console.error('[live] upstream error:', e.message);
    try { clientWs.send(JSON.stringify({ type: 'error', message: 'การเชื่อมต่อกับ AI มีปัญหา' })); } catch {}
  });

  // ws gives us the close code + reason the server actually sent — log it
  // so we can tell duration-limit / quota / auth closes apart in Render's
  // logs, and forward a human-readable reason to the client instead of
  // leaving them with a generic "connection ended" message.
  upstream.on('close', (code, reasonBuf) => {
    const reason = reasonBuf ? reasonBuf.toString() : '';
    console.log(`[live] upstream closed: code=${code} reason=${JSON.stringify(reason)}`);
    if (!closedByClient) {
      try {
        clientWs.send(JSON.stringify({ type: 'upstreamClosed', code, reason }));
      } catch {}
      try { clientWs.close(); } catch {}
    }
  });

  // Binary frames from the client = raw 16-bit PCM mic audio (16kHz, mono),
  // relayed upstream as realtimeInput.audio (Gemini deprecated the old
  // realtimeInput.mediaChunks field — audio/video/text are now separate
  // fields, and using mediaChunks gets the session closed with code 1007).
  // Text frames are small JSON control/data messages — currently:
  //   { type: 'video', data: <base64 JPEG>, mimeType: 'image/jpeg' } — a
  //     periodic camera frame, sent right alongside the audio stream so the
  //     model can see live video, and
  //   { type: 'stop' } — sent when the user taps the orb while the AI is
  //     talking, to clear local playback; nothing needs relaying upstream.
  clientWs.on('message', (data, isBinary) => {
    if (isBinary) {
      const payload = JSON.stringify({
        realtimeInput: {
          audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(data).toString('base64') }
        }
      });
      if (upstreamReady) upstream.send(payload);
      else pendingToUpstream.push(payload);
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'video' && msg.data) {
      const payload = JSON.stringify({
        realtimeInput: {
          video: { mimeType: msg.mimeType || 'image/jpeg', data: msg.data }
        }
      });
      if (upstreamReady) upstream.send(payload);
      else pendingToUpstream.push(payload);
    }
    // msg.type === 'stop' needs no upstream action — handled client-side only.
  });

  clientWs.on('close', () => {
    closedByClient = true;
    try { upstream.close(); } catch {}
  });
  clientWs.on('error', () => {
    closedByClient = true;
    try { upstream.close(); } catch {}
  });
});

server.listen(port, () => console.log(`RAM AI is running at http://localhost:${port}`));
