/**
 * 模擬「真 OA 系統」的最小後端，供 OA_CONNECTOR=http 的開發與驗收使用。
 *
 * 用途：串接真 OA 前，讓開發者不必等對方系統開通就能端到端跑完 chat → submit，
 * 並直接檢視「依 oa.schema.json 映射後實際送出的 body」。
 *
 * 行為刻意通用：**接受任何 POST/PUT 路徑**並回 { requestId, status }，
 * 因為端點路徑由各表單的 schemas/<formId>/oa.schema.json 決定，隨時可能改。
 *
 * 執行（從 repo 根目錄）：node presale/oa-mock/server.mjs → http://localhost:4100
 * 設定見同目錄 .env（server 會自動載入）：PORT / MOCK_STATUS / MOCK_FAIL_STATUS / MOCK_DELAY_MS
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// 自動載入同目錄的 .env（Node 20.12+ 內建，零依賴）
const envPath = path.join(DIR, '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
  console.log(`已載入 .env：${envPath}`);
}

const PORT = Number(process.env.PORT ?? 4100);
/** 送出成功時回的狀態字串。改成 oa.schema statusMap 沒列的值，可驗證「未命中 fallback pending」 */
const MOCK_STATUS = process.env.MOCK_STATUS ?? 'accepted';
/** 設了就一律回這個 HTTP 狀態碼（如 400 / 500），用來驗證連接器的錯誤路徑 */
const MOCK_FAIL_STATUS = process.env.MOCK_FAIL_STATUS ? Number(process.env.MOCK_FAIL_STATUS) : 0;
/** 回應前延遲毫秒數。設 >15000 可驗證連接器的 15 秒逾時 */
const MOCK_DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? 0);
/** 需要認證時設定；設了就要求 Authorization: Bearer <值>（對應 server 的 OA_API_KEY） */
const MOCK_REQUIRE_TOKEN = process.env.MOCK_REQUIRE_TOKEN ?? '';

/** 收到的送出紀錄（記憶體）；GET /__requests 可取回檢視 */
const received = [];
let seq = 0;

/** demo 額度：涵蓋請假表單支援的 6 種假別 */
const LEAVE_BALANCES = [
  { leaveType: 'annual', remainingHours: 80 },
  { leaveType: 'personal', remainingHours: 56 },
  { leaveType: 'sick', remainingHours: 240 },
  { leaveType: 'official', remainingHours: 40 },
  { leaveType: 'funeral', remainingHours: 64 },
  { leaveType: 'marriage', remainingHours: 64 },
];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ __unparsable: raw });
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  // ── 除錯：檢視目前為止收到的所有送出 ──
  if (req.method === 'GET' && pathname === '/__requests') {
    return json(res, 200, { count: received.length, requests: received });
  }
  if (req.method === 'DELETE' && pathname === '/__requests') {
    received.length = 0;
    return json(res, 200, { ok: true });
  }

  // ── 額度查詢：路徑寫死在 http.connector.ts 的 LEAVE_BALANCE_PATH ──
  if (req.method === 'GET' && pathname === '/api/leave-balances') {
    const userId = url.searchParams.get('userId') ?? '(未帶)';
    console.log(`[oa-mock] GET 額度查詢  userId=${userId}`);
    return json(res, 200, LEAVE_BALANCES);
  }

  // ── 送出：接受任何 POST/PUT 路徑（端點由 oa.schema.json 決定）──
  if (req.method === 'POST' || req.method === 'PUT') {
    const body = await readBody(req);

    if (MOCK_REQUIRE_TOKEN) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${MOCK_REQUIRE_TOKEN}`) {
        console.log(`[oa-mock] ✗ 認證失敗  ${req.method} ${pathname}  authorization=${auth || '(無)'}`);
        return json(res, 401, { message: 'invalid token' });
      }
    }

    const requestId = `OA-${String(++seq).padStart(6, '0')}`;
    received.push({ at: new Date().toISOString(), method: req.method, path: pathname, requestId, body });

    console.log(`\n[oa-mock] ${req.method} ${pathname} → ${requestId}`);
    console.log('  收到的 body（＝ oa.schema fieldMap 映射後的結果）：');
    console.log(JSON.stringify(body, null, 2).split('\n').map((l) => '    ' + l).join('\n'));

    if (MOCK_DELAY_MS > 0) await sleep(MOCK_DELAY_MS);

    if (MOCK_FAIL_STATUS) {
      console.log(`  ↳ 依 MOCK_FAIL_STATUS 回 ${MOCK_FAIL_STATUS}`);
      return json(res, MOCK_FAIL_STATUS, { message: `mock failure ${MOCK_FAIL_STATUS}`, requestId: null });
    }

    // 回應形狀對應 oa.schema.json 的 response.idField / statusField
    return json(res, 200, { requestId, status: MOCK_STATUS });
  }

  json(res, 404, { message: `no mock handler for ${req.method} ${pathname}` });
});

server.listen(PORT, () => {
  console.log(`模擬 OA 系統已啟動： http://localhost:${PORT}`);
  console.log(`  送出：任何 POST/PUT 路徑 → { requestId: "OA-000001", status: "${MOCK_STATUS}" }`);
  console.log(`  額度：GET /api/leave-balances?userId=…`);
  console.log(`  檢視：GET /__requests（DELETE 可清空）`);
  if (MOCK_FAIL_STATUS) console.log(`  ⚠ MOCK_FAIL_STATUS=${MOCK_FAIL_STATUS}：送出一律失敗`);
  if (MOCK_DELAY_MS) console.log(`  ⚠ MOCK_DELAY_MS=${MOCK_DELAY_MS}：回應前延遲`);
  if (MOCK_REQUIRE_TOKEN) console.log(`  ⚠ 需帶 Authorization: Bearer <OA_API_KEY>`);
  console.log('\n  接上 server：OA_CONNECTOR=http OA_BASE_URL=http://localhost:' + PORT + ' npm run dev -w server');
});
