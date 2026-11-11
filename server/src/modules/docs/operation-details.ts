import { z } from 'zod';
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { env } from '@/config/env';
import { renderers } from '@/modules/report/report.render';

/** 沒有 validate() 的路由仍要讓 Swagger 讀者知道 path 參數該填什麼。 */
export function pathParamDescription(path: string, name: string): string | undefined {
  if (name === 'formId' && path.startsWith('/api/forms/')) return '表單代碼，見 GET /api/forms';
  if (name === 'id' && path.startsWith('/api/tasks/')) return '任務 id（即對話 id，UUID），見 GET /api/tasks';
  if (name === 'queryId' && path.endsWith('/stop')) return '要停止的查詢識別碼，即送訊息時帶的 x-query-id header';
  return undefined;
}

const UPLOAD_FIELD_DESCRIPTIONS = {
  file: '要上傳的檔案：PDF、JPEG/PNG/GIF/WebP 圖片、Word、Excel',
  audio: '錄音檔：m4a、aac、mp4、webm、wav',
  image: '要辨識的圖片：JPEG、PNG、WebP',
} as const;

/** 由前端產生的查詢識別碼，可用 POST /api/conversations/queries/{queryId}/stop 中途停止。 */
const queryIdHeaders = z.object({
  'x-query-id': z.string().uuid().optional().describe('本次查詢的識別碼（UUID），由呼叫端產生；之後可用 POST /api/conversations/queries/{queryId}/stop 停止這次 AI 回覆。省略時由伺服器產生，就無法中途停止'),
});

/** Contracts not expressible by validate(): multipart files, downloads and authentication notes. */
export function applyOperationDetails(operation: RouteConfig): void {
  const { path, method } = operation;
  if (method === 'post' && (path === '/api/conversations' || path === '/api/conversations/{id}/messages')) {
    operation.request = { ...operation.request, headers: queryIdHeaders };
  }
  const upload = method === 'post' && (
    path.endsWith('/attachments') || path.endsWith('/knowledge/files') ||
    path === '/api/speech/transcribe' || path === '/api/vision/analyze'
  );
  if (upload) {
    const field = path.includes('/speech/') ? 'audio' : path.includes('/vision/') ? 'image' : 'file';
    const maxMb = path.endsWith('/knowledge/files') ? env.KNOWLEDGE_FILE_MAX_MB : field === 'image' ? 5 : 10;
    const fieldDescription = path.endsWith('/knowledge/files') ? '要加入知識庫的文件' : UPLOAD_FIELD_DESCRIPTIONS[field];
    const body = operation.request?.body?.content['application/json']?.schema;
    const properties = body instanceof z.ZodObject ? body.shape : {};
    operation.summary = field === 'audio' ? '語音轉文字' : field === 'image' ? '影像辨識' : path.endsWith('/knowledge/files') ? '上傳知識庫檔案' : '上傳對話附件';
    operation.request = {
      ...operation.request,
      body: {
        required: true,
        description: `單檔上限 ${maxMb} MB${path.endsWith('/knowledge/files') ? '，由 KNOWLEDGE_FILE_MAX_MB 設定；超限回 413' : '；不支援的格式或超限回 422'}`,
        content: { 'multipart/form-data': { schema: z.object({ ...properties, [field]: z.string().openapi({ type: 'string', format: 'binary', description: `${fieldDescription}，單檔上限 ${maxMb} MB` }) }) } },
      },
    };
    operation.responses[path.endsWith('/knowledge/files') ? '413' : '422'] = { description: '檔案大小超限或格式不符' };
  }
  if (method === 'get' && path.endsWith('/download')) {
    operation.responses['200'] = { description: '下載報告；Content-Disposition 提供檔名，可用格式依本部署的 renderer 決定。', content: Object.fromEntries(Object.values(renderers).map(({ contentType }) => [contentType, { schema: { type: 'string' as const, format: 'binary' } }])) };
  }
  if (path === '/api/auth/sso/exchange') operation.description = '以 assertion 換發 Session；租戶由 assertion 的 iss 決定，API Key 不參與身分判定。embedOrigin 僅在可信面板來源時採信。';
  if (path.startsWith('/api/admin')) operation.description = `${operation.description ?? ''}\n接受 x-admin-key 或後台登入的 Bearer JWT。租戶管理者僅能操作本租戶，並受分頁 hidden/read/write 權限限制；平台設定與管理者帳號管理僅限超級管理者。`.trim();
  if (path === '/api/admin/auth/login') {
    operation.summary = '後台登入（超級管理者／租戶管理者）';
    operation.description = '不需管理金鑰。省略 username 或使用 admin 時以 ADMIN_PASSWORD 登入；其他 username 使用租戶管理者帳號。回傳 data.token 與 data.me，後續請填入 adminBearerAuth。';
  }
  if (path === '/api/admin/me') operation.summary = '取得後台登入身分與分頁權限';
  if (path === '/api/admin/me/password') operation.summary = '租戶管理者修改自己的密碼';
  if (path.endsWith('/knowledge') && method === 'get') {
    operation.description += '\n回傳 data.fileMaxMb，供上傳介面顯示本部署的單檔上限。';
    operation.responses['200'] = { description: '來源、索引狀態、執行中工作與單檔上限', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { source: { type: 'object' }, meta: { type: 'object' }, runningJob: { type: 'object', nullable: true }, fileMaxMb: { type: 'number', example: env.KNOWLEDGE_FILE_MAX_MB } } } } } } } };
  }
  if (path.startsWith('/api/tenant/')) operation.description = '伺服器對伺服器自助設定；x-api-key 必須使用租戶秘密金鑰 sk_，公開金鑰 pk_ 不可使用。';
  if (path.startsWith('/api/admin/db-intelligence/')) {
    operation.description += '\n此端點將請求轉發至已登記的 Database Intelligence MCP 服務；body 與回應格式由該服務定義。';
    operation.request = {
      ...operation.request,
      query: z.object({ tenant_id: z.string().optional(), request_id: z.string().optional(), status: z.string().optional(), limit: z.string().optional(), dry_run: z.string().optional() }),
      ...(['put', 'patch', 'post'].includes(method) ? { body: { content: { 'application/json': { schema: z.object({}).passthrough() } } } } : {}),
    };
    operation.responses['502'] = { description: '上游服務無法連線、拒絕管理身分或回應錯誤' };
  }
  if (path === '/api/directory-sync/events') {
    operation.summary = '以簽章事件批次同步人員目錄';
    operation.description = 'Bearer 為同步專用 assertion（非使用者 Session），sub=directory-sync、aud=hyagent:directory-sync，body_sha256 必須符合實際傳送的原始 bytes。單批最多 500 筆、1 MB；詳細事件契約見 docs/HANDOFF-DIRECTORY-SYNC.md。錯誤為 { error, message, requestId }。';
    operation.request = { body: { required: true, content: { 'application/json': { schema: z.object({ events: z.array(z.record(z.unknown())).max(500) }) } } } };
    operation.responses.default = { description: '同步錯誤（扁平格式）', content: { 'application/json': { schema: { type: 'object', required: ['error', 'message', 'requestId'], properties: { error: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' } } } } } };
  }
  let status: string | undefined;
  if (method === 'post' && /\/(tenants|keys|webhooks|mcp-servers|forms|admin-accounts|custom-suggestions|labels|knowledge\/files)$/.test(path) && path.startsWith('/api/admin/')) status = '201';
  if (method === 'post' && path.endsWith('/knowledge/ingest')) status = '202';
  if (method === 'post' && (path === '/api/auth/guest' || path === '/api/auth/sso/exchange' || path === '/api/conversations' || path.endsWith('/attachments'))) status = '201';
  if ((method === 'post' && (path === '/api/auth/logout' || path.endsWith('/stop'))) || (method === 'delete' && /^\/api\/admin\/mcp-servers\/[^/]+$/.test(path))) status = '204';
  if (status) {
    delete operation.responses['200'];
    operation.responses[status] = { description: status === '201' ? '建立成功' : status === '202' ? '已建立背景工作，回傳 data.jobId 與 data.status' : '操作成功（無回應內容）' };
  }
}
