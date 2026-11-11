/**
 * Swagger 的端點摘要與說明（key 為「METHOD 路徑」，路徑參數用 OpenAPI 的 {name} 寫法）。
 *
 * openapi.ts 的 paths 已手寫的端點以那邊為準（會覆蓋這裡）；這裡補的是其餘端點，
 * 讓讀者一眼看出這支 API 做什麼、和相似的 API 差在哪。沒登記的端點 summary 只會顯示「METHOD 路徑」，
 * openapi-routes 測試會擋下這種情況。
 */
export interface OperationSummary {
  summary: string;
  description?: string;
}

const HEALTHZ: OperationSummary = {
  summary: '存活檢查（liveness）：服務有沒有在跑',
  description:
    '程序有回應就回 200，並附上目前使用的 LLM provider/model（前端「AI 已連線」燈號用）。不查資料庫、不呼叫 LLM，所以很快也不花錢。\n' +
    '要知道資料庫等依賴是否可用，請改打 readyz。\n' +
    '/healthz 與 /api/healthz 完全相同：Google Cloud Run 會攔截根路徑的 /healthz 並回 404，所以前端一律打 /api/healthz；根路徑保留給 Zeabur、K8s 等以 /healthz 做探針的平台。',
};

const READYZ: OperationSummary = {
  summary: '就緒檢查（readiness）：依賴是否可服務',
  description:
    '資料庫模式下會實際 ping 資料庫，連不上就回 503，讓 Zeabur、K8s 等平台暫停把流量導進來；檔案模式沒有外部依賴，一律回 ready。\n' +
    '和 healthz 的差別：healthz 只問「程序活著嗎」，readyz 問「現在能正常處理請求嗎」。\n' +
    '/readyz 與 /api/readyz 完全相同，雙路徑的原因同 healthz。',
};

export const operationSummaries: Record<string, OperationSummary> = {
  // ── 健康檢查 ──
  'GET /healthz': HEALTHZ,
  'GET /api/healthz': HEALTHZ,
  'GET /readyz': READYZ,
  'GET /api/readyz': READYZ,

  // ── MCP ──
  'GET /.well-known/hyagent-mcp-jwks.json': {
    summary: 'MCP 驗章公鑰（JWKS）',
    description: 'HyAgent 呼叫 MCP server 時會帶簽章過的 JWT，MCP server 用這裡的公鑰驗章。公開、不需登入，可快取 5 分鐘；未啟用 MCP 簽章時回 404。',
  },

  // ── 登入身分 ──
  'POST /api/auth/refresh': {
    summary: '用 refresh token 換新的 access token',
    description: 'access token 過期時呼叫。refresh token 會輪替：換發後舊的 refresh token 即失效，請改存新回傳的那組。',
  },
  'GET /api/auth/me': {
    summary: '取得目前登入者資料',
    description: '前端重新整理頁面時用來還原登入狀態。',
  },
  'POST /api/auth/logout': {
    summary: '登出：結束目前的 Session',
    description: '撤銷這次 SSO／訪客 Session（hyas_ token）。帳密登入的 JWT 無法在伺服器端撤銷，打這支不會報錯，回 204 即可，前端自行丟棄 token。',
  },

  // ── 對話 ──
  'PUT /api/conversations/{id}/replies/{replyId}/feedback': {
    summary: '對 AI 回覆按讚／倒讚',
    description: '同一則回覆重複送出會覆蓋前一次評價。倒讚可附原因與補充說明，後台「回饋」分頁可查。不呼叫 LLM、不計入用量。',
  },
  'DELETE /api/conversations/{id}/replies/{replyId}/feedback': {
    summary: '收回對 AI 回覆的評價',
  },
  'POST /api/conversations/queries/{queryId}/stop': {
    summary: '中途停止正在產生的 AI 回覆',
    description: 'queryId 是送訊息時帶的 x-query-id header。只停止這一輪回覆，對話與已填的表單內容都保留；要放棄整份表單請用 POST /api/conversations/{id}/cancel。',
  },
  'PATCH /api/conversations/{id}/fields': {
    summary: '直接修改表單欄位值（不經 AI）',
    description: '確認畫面上使用者手動改欄位時用。不呼叫 LLM、不計入用量；要讓 AI 理解一段話再填欄位，請改用 POST /api/conversations/{id}/messages。',
  },
  'POST /api/conversations/{id}/cancel': {
    summary: '放棄這份對話中的表單',
    description: '對話畫面的「取消」用。和其他取消的差別：POST /api/conversations/{id}/actions/{actionId}/cancel 只作廢一張待確認的寫入卡片，對話繼續；POST /api/conversations/queries/{queryId}/stop 只停止這一輪 AI 回覆。從「我的任務」清單取消請用 POST /api/tasks/{id}/cancel。',
  },
  'DELETE /api/conversations/{id}/attachments/{attachmentId}': {
    summary: '刪除對話中已上傳的附件',
  },

  // ── 前台其他功能 ──
  'POST /api/tools/{toolId}/invoke': {
    summary: '直接呼叫唯讀工具（不經 AI）',
    description: '給 App 首頁摘要、列表、掃條碼查詢等畫面直接取資料用，不呼叫 LLM。只能呼叫唯讀工具；寫入動作一律走確認流程（POST /api/conversations/{id}/actions/propose → confirm）。需有使用智慧代理的權限。',
  },
  'GET /api/notifications': {
    summary: '我的通知清單',
  },
  'POST /api/notifications/read': {
    summary: '將通知標為已讀',
    description: '一次可標 1–100 筆，id 取自 GET /api/notifications。',
  },
  'GET /api/reports/{id}': {
    summary: '查詢報告產生進度',
    description: '報告為非同步產生，前端輪詢這支直到狀態為完成，再用 GET /api/reports/{id}/download 下載。只能查自己產生的報告。',
  },
  'GET /api/reports/{id}/download': {
    summary: '下載自己產生的報告',
    description: '可用 format 指定格式。後台下載任一使用者的報告請用 GET /api/admin/tenants/{id}/reports/{reportId}/download。',
  },
  'GET /api/leave/balances': {
    summary: '查詢各假別剩餘時數',
    description: '請假畫面顯示「今年度剩餘 N 小時」用。',
  },
  'GET /api/widget/config': {
    summary: '取得嵌入式 Widget 的外觀與開關設定',
    description: '公開、不需登入，以 ?key=pk_ 指定租戶。因為只能用訪客身分判斷，登入後的知識庫開關與推薦問句請改讀 GET /api/knowledge/suggested-prompts。',
  },
  'GET /api/tenant/llm-config': {
    summary: '讀取本租戶的 AI 模型設定（自助）',
    description: '給整合方工程師自己呼叫，只接受 sk_ 秘密金鑰（pk_ 會出現在瀏覽器，不能拿來讀設定）。金鑰只回遮罩。後台代租戶操作請用 /api/admin/tenants/{id}/llm-config。',
  },
  'PUT /api/tenant/llm-config': {
    summary: '更新本租戶的 AI 模型設定（自助）',
    description: '可自備 LLM API key（BYO key）。只接受 sk_ 秘密金鑰。後台代租戶操作請用 PUT /api/admin/tenants/{id}/llm-config。',
  },

  // ── 後台：租戶管理者帳號（僅超級管理者） ──
  'GET /api/admin/tenants/{id}/admin-accounts': {
    summary: '列出租戶的後台管理者帳號',
  },
  'POST /api/admin/tenants/{id}/admin-accounts': {
    summary: '建立租戶管理者帳號',
    description: '帳號名稱全平台不可重複，重複回 409。',
  },
  'PATCH /api/admin/tenants/{id}/admin-accounts/{accountId}': {
    summary: '修改租戶管理者的名稱、狀態或分頁權限',
    description: '改為停用時，該帳號已登入的 token 立即失效。改密碼請用 PUT …/password。',
  },
  'PUT /api/admin/tenants/{id}/admin-accounts/{accountId}/password': {
    summary: '重設租戶管理者的密碼',
    description: '由超級管理者代為重設，重設後該帳號已登入的 token 立即失效。管理者自己改密碼請用 PUT /api/admin/me/password。',
  },
  'DELETE /api/admin/tenants/{id}/admin-accounts/{accountId}': {
    summary: '刪除租戶管理者帳號',
  },

  // ── 後台：人員目錄 ──
  'GET /api/admin/tenants/{id}/users': {
    summary: '取得租戶的完整人員目錄',
  },
  'PUT /api/admin/tenants/{id}/users': {
    summary: '整份取代人員目錄（批次匯入用）',
    description: '送出的清單會取代整份目錄，沒列到的人會被移除。只新增一人請用 POST、只改一人請用 PATCH，避免拿到舊資料覆蓋掉別人剛做的修改。由目錄同步管理的人員不可在此修改。',
  },
  'POST /api/admin/tenants/{id}/users': {
    summary: '新增一位人員',
    description: '以伺服器上的最新目錄為準附加一筆，不會覆蓋其他人。',
  },
  'PATCH /api/admin/tenants/{id}/users/{userId}': {
    summary: '修改一位人員的資料',
    description: '沒帶的欄位不變；email 傳 null 代表清除。帳號（userId）不可修改，因為權限、代理人等設定都以帳號為 key。',
  },
  'DELETE /api/admin/tenants/{id}/users/{userId}': {
    summary: '刪除一位人員',
    description: '同時從其他人的代理人名單移除；該帳號的帳密登入 token 立即失效。',
  },

  // ── 後台：部門 ──
  'GET /api/admin/tenants/{id}/departments': {
    summary: '列出部門與各部門人數、授權數',
    description: '部門不是獨立資料，而是由人員目錄與權限政策中出現過的部門名稱彙整而來。',
  },
  'PATCH /api/admin/tenants/{id}/departments/{name}': {
    summary: '部門改名（連同權限設定一起改）',
    description: '人員目錄與權限政策中的部門名稱會一起改，避免權限對不上。改成已存在的部門名稱時，兩邊的權限會合併。網站訪客、未指定部門這兩個系統部門不可改名，也不可當改名目標。',
  },
  'DELETE /api/admin/tenants/{id}/departments/{name}': {
    summary: '刪除部門（連同其權限設定）',
    description: '同時移除權限政策中該部門的授權，避免之後出現同名部門時舊授權靜默生效。系統部門不可刪除。',
  },

  // ── 後台：目錄同步 ──
  'GET /api/admin/tenants/{id}/directory-sync': {
    summary: '查看目錄同步設定與同步金鑰',
  },
  'PATCH /api/admin/tenants/{id}/directory-sync': {
    summary: '開關目錄同步與 SSO 自動建檔',
    description: 'directorySyncEnabled：是否接受外部系統推送人員資料；ssoAutoProvision：SSO 登入時是否自動把不在目錄的人建檔。',
  },
  'POST /api/admin/tenants/{id}/directory-sync/keys': {
    summary: '登記目錄同步用的公鑰',
    description: '外部系統推送人員資料時以對應私鑰簽章。新登記回 201；同一把公鑰重複登記回 200。和 assertion-keys（SSO 登入用）是分開的兩組金鑰。',
  },
  'POST /api/admin/tenants/{id}/directory-sync/keys/{kid}/revoke': {
    summary: '撤銷目錄同步公鑰',
  },

  // ── 後台：平台層 ──
  'GET /api/admin/audit': {
    summary: '平台層操作稽核',
    description: '建立／刪除租戶、MCP 服務等平台設定的變更紀錄。單一租戶內的操作紀錄請用 GET /api/admin/tenants/{id}/audit。',
  },
  'GET /api/admin/skills': {
    summary: 'Skill Library：平台所有能力與各租戶啟用狀態（唯讀）',
  },
  'GET /api/admin/scopes': {
    summary: '列出所有權限 scope（設定權限政策時的選項）',
  },
  'GET /api/admin/mcp-servers': {
    summary: '列出已登記的 MCP 服務',
  },
  'POST /api/admin/mcp-servers': {
    summary: '登記 MCP 服務',
  },
  'PATCH /api/admin/mcp-servers/{serverId}': {
    summary: '修改 MCP 服務設定',
  },
  'DELETE /api/admin/mcp-servers/{serverId}': {
    summary: '刪除 MCP 服務',
  },
  'POST /api/admin/mcp-servers/{serverId}/refresh': {
    summary: '重新抓取 MCP 服務的工具清單',
    description: 'MCP 服務新增或修改工具後，按這個讓 HyAgent 重新讀取。',
  },

  // ── 後台：Database Intelligence（轉發到該 MCP 服務的 /admin，資料存在客戶端） ──
  'GET /api/admin/db-intelligence/{serverId}/data-sources': {
    summary: '列出資料庫資料來源',
    description: '附 Catalog 摘要與連線字串是否已設定。',
  },
  'PUT /api/admin/db-intelligence/{serverId}/data-sources/{id}': {
    summary: '新增或修改資料庫資料來源',
    description: '不接收資料庫密碼，只填存放連線字串的環境變數名稱（connectionEnv）。',
  },
  'DELETE /api/admin/db-intelligence/{serverId}/data-sources/{id}': {
    summary: '刪除資料庫資料來源',
  },
  'POST /api/admin/db-intelligence/{serverId}/data-sources/{id}/connection-test': {
    summary: '測試資料庫連線',
    description: '回報資料庫版本、是否預設唯讀，以及帳號仍可寫入的物件（正常應為空）。',
  },
  'POST /api/admin/db-intelligence/{serverId}/data-sources/{id}/schema-sync': {
    summary: '掃描資料庫結構並回傳差異',
    description: '只讀系統目錄、不讀資料列。新的資料表／欄位預設不可查詢，需在 Catalog 審核後開放。',
  },
  'GET /api/admin/db-intelligence/{serverId}/data-sources/{id}/catalog': {
    summary: '取得資料庫 Catalog（供審核）',
    description: 'Catalog 是 AI 可以查詢的資料表、欄位與說明清單，含資料庫原始註解。',
  },
  'PATCH /api/admin/db-intelligence/{serverId}/data-sources/{id}/catalog': {
    summary: '套用 Catalog 審核結果',
    description: '決定哪些資料表、欄位開放給 AI 查詢。',
  },
  'GET /api/admin/db-intelligence/{serverId}/tenants/{tenantId}/policies': {
    summary: '取得租戶的資料存取政策',
    description: '政策決定「哪些角色可以查哪些資料」。角色與人員的對應請看 principals。',
  },
  'PUT /api/admin/db-intelligence/{serverId}/tenants/{tenantId}/policies': {
    summary: '整份取代租戶的資料存取政策',
    description: '回傳與 Catalog 對不上的警告。',
  },
  'GET /api/admin/db-intelligence/{serverId}/tenants/{tenantId}/principals': {
    summary: '取得租戶的資料查詢使用者目錄',
    description: '每位使用者的角色與資料列範圍屬性（例如只能看自己部門）。和 policies 的差別：policies 定義角色能查什麼，principals 定義每個人是什麼角色。',
  },
  'PUT /api/admin/db-intelligence/{serverId}/tenants/{tenantId}/principals': {
    summary: '整份取代租戶的資料查詢使用者目錄',
  },
  'POST /api/admin/db-intelligence/{serverId}/query/preview': {
    summary: '預覽查詢會產生的 SQL（不執行）',
    description: '以指定使用者身分預覽 Query Plan 的 SQL、參數與套用的政策，用來確認權限設定是否正確。',
  },
  'GET /api/admin/db-intelligence/{serverId}/audit': {
    summary: '資料庫查詢稽核',
    description: 'AI 實際執行過的資料庫查詢紀錄（MCP 服務記憶體保留最近 5000 筆）。和 /api/admin/audit 的差別：那邊記的是後台設定變更。',
  },

  // ── 後台：租戶 ──
  'GET /api/admin/tenants/{id}': {
    summary: '取得單一租戶的完整設定',
  },
  'PATCH /api/admin/tenants/{id}': {
    summary: '修改租戶設定（名稱、允許來源、外觀、月配額等）',
    description: '只更新有帶的欄位。',
  },
  'DELETE /api/admin/tenants/{id}': {
    summary: '刪除租戶',
  },
  'POST /api/admin/tenants/{id}/keys': {
    summary: '為租戶新增 API 金鑰',
    description: 'type=publishable 產生 pk_ 公開金鑰（可放在瀏覽器／Widget）；type=secret 產生 sk_ 秘密金鑰（只能放在伺服器端，可呼叫 /api/tenant 自助設定）。',
  },
  'GET /api/admin/tenants/{id}/audit': {
    summary: '租戶層操作稽核',
    description: '這個租戶內的設定變更紀錄。平台層變更請用 GET /api/admin/audit。',
  },

  // ── 後台：SSO（Identity Assertion） ──
  'GET /api/admin/tenants/{id}/assertion-keys': {
    summary: '列出 SSO 驗章公鑰',
    description: '客戶系統以私鑰簽發 Identity Assertion，HyAgent 用這裡登記的公鑰驗章後換發 Session。',
  },
  'POST /api/admin/tenants/{id}/assertion-keys': {
    summary: '登記 SSO 驗章公鑰',
  },
  'POST /api/admin/tenants/{id}/assertion-keys/{kid}/revoke': {
    summary: '撤銷 SSO 驗章公鑰',
  },
  'PATCH /api/admin/tenants/{id}/assertion-settings': {
    summary: '調整 SSO 時效設定',
    description: '允許的時鐘誤差、Assertion 有效時間、換發後 Session 的有效時間。',
  },
  'GET /api/admin/tenants/{id}/sessions': {
    summary: '列出租戶的登入 Session',
  },
  'POST /api/admin/tenants/{id}/sessions/revoke': {
    summary: '強制登出某位使用者的所有 Session',
    description: '依使用者 sub 撤銷其全部 Session。只撤銷單一 Session 請用 DELETE …/sessions/{sessionId}。',
  },
  'DELETE /api/admin/tenants/{id}/sessions/{sessionId}': {
    summary: '撤銷單一 Session',
  },

  // ── 後台：Webhook ──
  'DELETE /api/admin/tenants/{id}/webhooks/{webhookId}': {
    summary: '刪除 webhook 端點',
  },
  'PATCH /api/admin/tenants/{id}/webhooks/{webhookId}': {
    summary: '啟用或暫停 webhook 端點',
    description: '暫停後保留設定，不再推送事件；要永久移除請用 DELETE。',
  },

  // ── 後台：回饋 ──
  'GET /api/admin/tenants/{id}/feedback/stats': {
    summary: 'AI 回覆評價統計（讚／倒讚數、倒讚原因、各能力分布）',
  },
  'GET /api/admin/tenants/{id}/feedback': {
    summary: 'AI 回覆評價清單（游標分頁）',
  },
  'PATCH /api/admin/tenants/{id}/feedback/{feedbackId}': {
    summary: '更新評價的處理狀態',
  },

  // ── 後台：AI 模型設定 ──
  'GET /api/admin/tenants/{id}/llm-config': {
    summary: '讀取租戶的 AI 模型設定（後台代操作）',
    description: '與 GET /api/tenant/llm-config 讀同一份設定；差別在這支用後台身分、可指定任一租戶。',
  },
  'PUT /api/admin/tenants/{id}/llm-config': {
    summary: '更新租戶的 AI 模型設定（後台代操作）',
    description: '與 PUT /api/tenant/llm-config 寫同一份設定；差別在這支用後台身分、可指定任一租戶。',
  },

  // ── 後台：報告 ──
  'GET /api/admin/tenants/{id}/reports': {
    summary: '查詢租戶內所有報告（時間區間＋關鍵字）',
  },
  'GET /api/admin/tenants/{id}/reports/{reportId}/download': {
    summary: '後台下載任一使用者的報告',
    description: '不限本人產生的報告，下載行為會記入稽核。使用者下載自己的報告請用 GET /api/reports/{id}/download。',
  },

  // ── 後台：權限政策 ──
  'GET /api/admin/tenants/{id}/policy': {
    summary: '取得租戶的權限政策',
    description: '包含租戶開放的 scope、各部門與帳號的授權、能力套餐（角色）。',
  },
  'PUT /api/admin/tenants/{id}/policy': {
    summary: '整份取代租戶的權限政策',
  },

  // ── 後台：表單設計 ──
  'GET /api/admin/tenants/{id}/forms': {
    summary: '列出租戶的表單定義',
  },
  'POST /api/admin/tenants/{id}/forms': {
    summary: '建立表單定義',
  },
  'GET /api/admin/tenants/{id}/forms/{formId}': {
    summary: '取得單一表單定義',
  },
  'PUT /api/admin/tenants/{id}/forms/{formId}': {
    summary: '更新表單定義',
  },
  'DELETE /api/admin/tenants/{id}/forms/{formId}': {
    summary: '刪除表單定義',
  },
  'GET /api/admin/tenants/{id}/forms/{formId}/export': {
    summary: '匯出表單定義（轉成 schema 檔內容）',
  },

  // ── 後台：知識庫 ──
  'GET /api/admin/tenants/{id}/knowledge': {
    summary: '知識庫總覽：來源設定、已建檔案、進行中的爬取工作',
  },
  'DELETE /api/admin/tenants/{id}/knowledge': {
    summary: '清除整個知識庫索引',
    description: '刪除這個租戶所有已建立的知識庫內容。只刪單一檔案請用 DELETE …/knowledge/files/{fileId}。',
  },
  'PUT /api/admin/tenants/{id}/knowledge/source': {
    summary: '儲存網站爬取來源設定（不立即爬取）',
    description: '只存設定。要開始爬取請呼叫 POST …/knowledge/ingest。',
  },
  'POST /api/admin/tenants/{id}/knowledge/ingest': {
    summary: '開始爬取網站並建立索引',
    description: '非同步執行，回 202 與 jobId，用 GET …/knowledge/jobs/{jobId} 查進度。可在 body 帶覆寫的來源設定，會先存起來再執行。',
  },
  'GET /api/admin/tenants/{id}/knowledge/jobs/{jobId}': {
    summary: '查詢知識庫爬取進度',
  },
  'POST /api/admin/tenants/{id}/knowledge/query-test': {
    summary: '測試知識庫查詢（看會命中哪些內容）',
    description: '與實際問答走同一套檢索。可用 asUserId 以某位使用者的權限試查；未指定時以網站訪客身分查詢。以他人身分查詢會記入稽核。',
  },
  'POST /api/admin/tenants/{id}/knowledge/suggestion': {
    summary: '重新產生 AI 自動推薦問句',
    description: '平時索引變動會自動產生，這是補救入口（例如當時產生失敗）。會等產生完成才回應。和 custom-suggestions 的差別：這裡是 AI 依知識庫內容自動產生的問句；custom-suggestions 是管理者自己新增的問句。',
  },
  'PUT /api/admin/tenants/{id}/knowledge/suggestion': {
    summary: '手動覆寫某一格自動推薦問句',
    description: 'manual 傳 null 代表恢復使用 AI 自動產生的內容。',
  },
  'POST /api/admin/tenants/{id}/knowledge/custom-suggestions': {
    summary: '新增自訂推薦問句',
    description: '由管理者自行撰寫的推薦問句，與 AI 自動產生的問句分開管理。',
  },
  'PUT /api/admin/tenants/{id}/knowledge/custom-suggestions/{promptId}': {
    summary: '修改自訂推薦問句',
  },
  'DELETE /api/admin/tenants/{id}/knowledge/custom-suggestions/{promptId}': {
    summary: '刪除自訂推薦問句',
  },
  'DELETE /api/admin/tenants/{id}/knowledge/files/{fileId}': {
    summary: '刪除知識庫中的單一檔案',
  },
  'GET /api/admin/tenants/{id}/knowledge/labels': {
    summary: '列出知識庫可見性標籤',
    description: '標籤用來控制哪些人看得到哪些知識庫檔案。',
  },
  'POST /api/admin/tenants/{id}/knowledge/labels': {
    summary: '新增可見性標籤',
  },
  'PATCH /api/admin/tenants/{id}/knowledge/labels/{labelId}': {
    summary: '修改可見性標籤的顯示名稱',
  },
  'DELETE /api/admin/tenants/{id}/knowledge/labels/{labelId}': {
    summary: '刪除可見性標籤',
  },
  'PATCH /api/admin/tenants/{id}/knowledge/files/{fileId}/visibility': {
    summary: '設定檔案的可見性標籤（誰看得到）',
    description: '傳空陣列代表明確設定為「誰都不能看」，和從未設定過不同。',
  },
  'GET /api/admin/tenants/{id}/knowledge/acl-report': {
    summary: '知識庫權限盤點報表',
    description: '分開列出「從未標記」（待處理）與「已明確設定誰都不能看」的檔案，網站來源也列為獨立一項。',
  },
  'GET /api/admin/tenants/{id}/knowledge/access-logs': {
    summary: '敏感文件存取紀錄（由新到舊，游標分頁）',
  },
  'PATCH /api/admin/tenants/{id}/knowledge/access-log-settings': {
    summary: '調整存取紀錄保存天數',
    description: '立即生效。縮短天數時，下一次每日清除會刪掉更多舊紀錄。',
  },
};
