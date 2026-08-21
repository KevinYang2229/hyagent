/**
 * 一鍵觸發：送出一張測試表單（免 LLM），用來驗證 webhook 回拋。
 *
 * 流程：SSO 換 token → 建對話 → 用 PATCH /fields 直接填欄位（不經 LLM）→ submit。
 * 送出成功後，OA 會把 form.submitted 投遞到該租戶登記的 webhook 端點（即 server.mjs 那支）。
 *
 * 執行（從 repo 根目錄，需 OA backend 在跑）：
 *   node examples/webhook-receiver/trigger.mjs
 * 然後重新整理收件匣 http://localhost:4300/ 看新紀錄。
 *
 * 設定沿用同目錄 .env：OA_ORIGIN / TENANT_PK / TENANT_SSO_SECRET / DEMO_USER_ID / DEMO_USER_NAME
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signUserToken } from "@hyagent/sdk/server";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(DIR, ".env");
if (fs.existsSync(envPath) && typeof process.loadEnvFile === "function")
  process.loadEnvFile(envPath);

const OA = process.env.OA_ORIGIN ?? "http://localhost:3000";
const PK =
  process.env.TENANT_PK ??
  "pk_3dc8a9721d103efb0972aac2c0ef79d237698f765178fc6a";
const SSO_SECRET = process.env.TENANT_SSO_SECRET ?? "test-secret1234567890";
const USER_ID = process.env.DEMO_USER_ID ?? "hyweb";
const USER_NAME = process.env.DEMO_USER_NAME ?? "測試員";

const J = (h = {}) => ({
  "content-type": "application/json",
  "x-api-key": PK,
  ...h,
});

// 取 14 天後的日期（YYYY-MM-DD）作為請假日
function futureDate(days = 14) {
  const d = new Date(Date.now() + days * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function main() {
  // 1) SSO 換發本系統 token
  const userToken = signUserToken({
    sub: USER_ID,
    name: USER_NAME,
    secret: SSO_SECRET,
  });
  const exRes = await fetch(`${OA}/api/auth/sso/exchange`, {
    method: "POST",
    headers: J(),
    body: JSON.stringify({ userToken }),
  });
  const ex = await exRes.json();
  if (!ex.data?.accessToken) throw new Error("SSO 失敗：" + JSON.stringify(ex));
  const auth = J({ authorization: "Bearer " + ex.data.accessToken });

  // 2) 建對話（不帶 message → 不觸發 LLM）
  const conv = await (
    await fetch(`${OA}/api/conversations`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ formId: "leave-request" }),
    })
  ).json();
  const id = conv.data?.id;
  if (!id) throw new Error("建立對話失敗：" + JSON.stringify(conv));

  // 3) 直接填欄位（一張年假；deputy 取自登入者的最愛名單）
  const day = futureDate();
  const fields = {
    leaveType: "annual",
    startDate: day,
    startTime: "09:00",
    endDate: day,
    endTime: "18:00",
    reason: "一鍵觸發測試（" + new Date().toLocaleString() + "）",
    deputy: "陳冠廷(HYW042)",
  };
  const upd = await (
    await fetch(`${OA}/api/conversations/${id}/fields`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ fields }),
    })
  ).json();
  if (upd.data?.status !== "confirming") {
    throw new Error(
      "欄位未完成，無法送出：" + JSON.stringify(upd.data?.rejected ?? upd),
    );
  }

  // 4) 送出 → 觸發 webhook
  const sub = await (
    await fetch(`${OA}/api/conversations/${id}/submit`, {
      method: "POST",
      headers: auth,
    })
  ).json();
  if (!sub.data?.submission)
    throw new Error("送出失敗：" + JSON.stringify(sub));

  console.log(`✅ 已送出，OA 單號 ${sub.data.submission.oaRequestId}`);
  console.log("   → 重新整理收件匣 http://localhost:4300/ 查看 webhook 紀錄");
}

main().catch((e) => {
  console.error("❌ 觸發失敗：", e instanceof Error ? e.message : e);
  console.error("   （請確認 OA backend 在 " + OA + " 運行中）");
  process.exit(1);
});
