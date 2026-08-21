/**
 * 獨立的 Webhook 接收端服務（模擬「整合方接收 OA 回拋」的那一段）。
 *
 * 做了接收端該做的三件事：
 *   1. 驗章：用 SDK 的 constructWebhookEvent 以端點密鑰驗 HMAC + 防重放（內容竄改/過期一律拒）。
 *   2. 去重：用 event.id 去除重試造成的重複（冪等）。
 *   3. 快回 2xx：驗過就回 200，把「寫入對方系統」的動作當作後續處理（此處以 console 模擬）。
 *
 * 取得密鑰兩種方式：
 *   A. 直接設 WEBHOOK_SECRET（你先用管理 API 登記端點時拿到的 whsec_…）。
 *   B. 設 ADMIN_API_KEY + TENANT_ID → 啟動時自動向 OA 管理 API 登記本服務並取回 secret。
 *
 * 執行（從 repo 根目錄）：node examples/webhook-receiver/server.mjs → 看 console，並可開 http://localhost:4300 看收件匣
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constructWebhookEvent } from '@hyagent/sdk/server';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(DIR, '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
  console.log(`已載入 .env：${envPath}`);
}

const PORT = Number(process.env.PORT ?? 4300);
const OA_ORIGIN = process.env.OA_ORIGIN ?? 'http://localhost:3000';
const RECEIVER_URL = process.env.RECEIVER_URL ?? `http://localhost:${PORT}/webhook`;
const TOLERANCE_SEC = Number(process.env.TOLERANCE_SEC ?? 300);
let WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';

// 收件匣（記憶體）：供 GET / 檢視 + 去重
const received = [];
const seenIds = new Set();

/** 啟動時若給了 ADMIN_API_KEY + TENANT_ID，自動向 OA 管理 API 登記本服務、取回 secret */
async function autoRegister() {
  if (WEBHOOK_SECRET) {
    console.log('使用 .env 的 WEBHOOK_SECRET 驗章');
    return;
  }
  const adminKey = process.env.ADMIN_API_KEY;
  const tenantId = process.env.TENANT_ID;
  if (!adminKey || !tenantId) {
    console.warn('⚠️ 未設 WEBHOOK_SECRET，也未設 ADMIN_API_KEY + TENANT_ID → 將「不驗章」接收（僅供觀察）');
    return;
  }
  const base = `${OA_ORIGIN}/api/admin/tenants/${tenantId}/webhooks`;
  const adminHeaders = { 'content-type': 'application/json', 'x-admin-key': adminKey };
  try {
    // 冪等：先看有沒有指向本服務 URL 的既有端點 → 重用其 secret，並清掉多餘重複（避免重複投遞）
    const list = await (await fetch(base, { headers: adminHeaders })).json();
    const mine = (list.data ?? []).filter((e) => e.url === RECEIVER_URL && !e.disabledAt);
    if (mine.length > 0) {
      WEBHOOK_SECRET = mine[0].secret;
      for (const dup of mine.slice(1)) {
        await fetch(`${base}/${dup.id}`, { method: 'DELETE', headers: adminHeaders });
      }
      const cleaned = mine.length - 1;
      console.log(
        `重用既有 webhook 端點 id=${mine[0].id}${cleaned > 0 ? `（清掉 ${cleaned} 個重複）` : ''}`,
      );
      return;
    }
    // 沒有就新建
    const res = await fetch(base, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ url: RECEIVER_URL }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(json));
    WEBHOOK_SECRET = json.data.secret;
    console.log(`已自動登記 webhook 端點 id=${json.data.id}，取得 secret（${WEBHOOK_SECRET.slice(0, 10)}…）`);
  } catch (e) {
    console.warn('⚠️ 自動登記失敗：' + (e instanceof Error ? e.message : String(e)));
  }
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  // 收件匣頁面
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const rows = received
      .map(
        (e) =>
          `<tr><td>${e.at}</td><td>${e.type}</td><td>${e.formId}</td><td>${e.user}</td><td>${e.oaId}</td><td>${e.verified ? '✅' : '⚠️未驗'}</td></tr>`,
      )
      .join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Webhook 收件匣</title>
      <body style="font-family:system-ui;max-width:900px;margin:40px auto;padding:0 20px">
      <h1>Webhook 收件匣（${received.length}）</h1>
      <p>監聽 <code>${RECEIVER_URL}</code>；在示範網站送出表單即會出現於下表。</p>
      <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
      <tr><th>時間</th><th>事件</th><th>表單</th><th>使用者</th><th>OA單號</th><th>驗章</th></tr>
      ${rows || '<tr><td colspan="6">尚無事件</td></tr>'}</table></body>`);
    return;
  }

  // 接收 webhook
  if (req.method === 'POST' && req.url === '/webhook') {
    const raw = await readRawBody(req);
    let event;
    let verified = false;
    try {
      if (WEBHOOK_SECRET) {
        // 1) 驗章（用 SDK）；失敗會丟錯
        event = constructWebhookEvent({
          payload: raw,
          signature: req.headers['x-oa-signature'],
          timestamp: req.headers['x-oa-timestamp'],
          secret: WEBHOOK_SECRET,
          toleranceSec: TOLERANCE_SEC,
        });
        verified = true;
      } else {
        event = JSON.parse(raw); // 無 secret：僅觀察，不驗章
      }
    } catch (e) {
      console.error('❌ 驗章失敗，拒收：', e instanceof Error ? e.message : e);
      res.writeHead(400).end('invalid signature');
      return;
    }

    // 2) 去重（冪等）
    if (seenIds.has(event.id)) {
      console.log(`↩️ 重複事件 ${event.id}，已忽略`);
      res.writeHead(200).end('duplicate ignored');
      return;
    }
    seenIds.add(event.id);

    // 3) 處理（此處以 console 模擬「寫入對方系統」）
    const d = event.data ?? {};
    console.log('────────────────────────────');
    console.log(`📩 收到 ${event.type}${verified ? '（已驗章）' : '（未驗章）'}`);
    console.log(`   表單: ${d.formId}  使用者: ${d.userId}`);
    console.log(`   OA單號: ${d.submission?.oaRequestId}  狀態: ${d.submission?.status}`);
    console.log(`   欄位: ${JSON.stringify(d.values)}`);
    received.unshift({
      at: new Date().toLocaleTimeString(),
      type: event.type,
      formId: d.formId,
      user: d.userId,
      oaId: d.submission?.oaRequestId,
      verified,
    });

    // 4) 快回 2xx（重活應丟背景）
    res.writeHead(200).end('ok');
    return;
  }

  res.writeHead(404).end('not found');
});

await autoRegister();
server.listen(PORT, () => {
  console.log(`Webhook 接收端已啟動： ${RECEIVER_URL}`);
  console.log(`  收件匣頁面： http://localhost:${PORT}`);
  console.log(`  驗章模式： ${WEBHOOK_SECRET ? '開啟（有 secret）' : '關閉（無 secret，僅觀察）'}`);
});
