/**
 * 知識庫 admin controller：每租戶知識來源設定、觸發解析、查進度、測試查詢、清除索引。
 * 全部端點受 requireAdmin 保護（掛載於 admin.routes）。
 */
import type { Request, Response } from 'express';
import { AppError } from '@/utils/app-error';
import { assertValidLabelId, kbScopeId } from '@/modules/authz/scope-catalog';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { tenantStore } from '@/modules/tenant/tenant.store';
import type { IngestParams } from './ingest.service';
import { deleteIndex, loadIndexText } from './knowledge.index.repo';
import { ingestFile, removeFile } from './knowledge-file.service';
import { getJob, getRunningJobForTenant, startIngestJob } from './knowledge.job';
import { knowledgeStore, type KnowledgeFileMeta, type KnowledgeSource } from './knowledge.store';
import { regenerateSlot, type RegenerateFailure } from './knowledge.suggest';
import { splitChunksBySource, type SourceKey } from './prompt-slots';
import { pickRetriever } from './retriever.pick';
import { aclModeOf, setFileVisibility } from './knowledge.visibility';
import { listShadowStats } from './knowledge.acl-shadow.repo';

/**
 * 確認租戶存在，否則 404；本檔的區域慣例，比照 admin.controller.ts:40-44、
 * form.admin.controller.ts:18、llm-config.service.ts:36 三處各自定義的同名寫法
 * ——這三處都各自持有一份，是這個 repo 對「查無租戶」的既有約定，不為了 DRY 抽公用。
 *
 * 標籤 CRUD 會寫入 tenantStore（Tenant.knowledgeLabels），對不存在的租戶 id
 * 呼叫 updateTenant 會靜默 no-op（見其註解）；曾經改用「不存在就自動建立」的做法，
 * 但那會讓打錯字的租戶 id 也能建出一個沒有 scopesMigrated／grantedScopes／API key
 * 的空殼租戶，且下次開機會被 migrateTenantScopes 自動授權——比對不存在的租戶
 * 回 404 造成更大的破口，故改回沿用既有慣例：查無租戶就是 404，不做任何寫入。
 */
function ensureTenant(id: string) {
  const tenant = tenantStore.getTenant(id);
  if (!tenant) throw AppError.notFound('租戶不存在');
  return tenant;
}

/**
 * 以「移除舊筆＋新增新筆」取代單一 fileId 的 meta，語意上等同 upsert。
 *
 * knowledgeStore.addFileMeta 是 delta「新增」操作（見其註解），對已存在的 fileId
 * 直接呼叫只會把新舊兩筆一起塞進 files 陣列——之後任何用 fileId 找檔的呼叫端
 * （含 Array.prototype.find）都可能撈到舊的那筆，讓標籤異動看似沒生效。
 * 先移除同 fileId 舊筆再新增，才是這裡要的「更新」語意。
 */
function replaceFileMeta(tenantId: string, file: KnowledgeFileMeta): void {
  knowledgeStore.removeFileMeta(tenantId, file.fileId, {});
  knowledgeStore.addFileMeta(tenantId, file, {});
}

/**
 * 檢查 scopes 是否都是該租戶已知的可見性標籤；未知者集中回一個 400。
 *
 * 原本只有 setFileVisibilityHandler 有這道檢查，saveSource（網站來源的
 * visibilityScopes）沒有——同一個 sourceSchema 欄位，檔案端點驗、來源端點不驗，
 * 是同一條規則的兩處各寫一份、其中一份漏寫，不是刻意的行為差異，故抽成共用函式。
 */
function assertKnownScopes(tenantId: string, scopes: string[]): void {
  const valid = new Set(
    (tenantStore.getTenant(tenantId)?.knowledgeLabels ?? []).map((l) => kbScopeId(l.id)),
  );
  const bad = scopes.filter((s) => !valid.has(s));
  if (bad.length) throw AppError.badRequest(`未知的標籤：${bad.join('、')}`);
}

/** 由已存來源設定組出 ingest 參數；未設定起始網址則擋下 */
function ingestParamsFor(tenantId: string): IngestParams {
  const s = knowledgeStore.getSource(tenantId);
  if (!s.startUrl) throw AppError.unprocessable('尚未設定知識來源網址');
  return {
    tenantId,
    startUrl: s.startUrl,
    maxPages: s.maxPages,
    pathPrefix: s.pathPrefix,
    includePatterns: s.includePatterns,
    excludePatterns: s.excludePatterns,
    chunkChars: s.chunkChars,
    embeddingModel: s.embeddingModel,
  };
}

/**
 * 單格重生失敗 → HTTP 錯誤。四條失敗路徑的「該怎麼辦」完全不同，不可共用一句訊息：
 * no-visible-chunks 重試永遠不會成功（要去標可見性或切回 off），superseded 則是
 * 純粹的時序競爭、原地重按即可。先前一律回「請稍後再試」，把前者誤導成後者。
 */
function regenerateError(reason: RegenerateFailure, mode: 'off' | 'shadow' | 'on'): AppError {
  switch (reason) {
    case 'no-visible-chunks': {
      const label = mode === 'on' ? '啟用' : '觀察（shadow）';
      return AppError.unprocessable(
        `該來源有索引內容，但在「${label}」模式下沒有任何訪客看得到的內容可當語料`
          + '——推薦問句會經免登入的 widget 送給任何訪客，故未標記與非公開的內容一律排除。'
          + '請先標記檔案可見性、並確認訪客部門已獲對應的 kb: 授權，或切回「關閉」模式。'
          + '（重試不會改變結果）',
      );
    }
    case 'blank-material':
      return AppError.unprocessable('該來源的索引內容為空白，無法生成推薦詞');
    case 'superseded':
      return AppError.conflict('生成期間索引已被其他操作更新，請重新操作');
    case 'generation-failed':
      return AppError.unprocessable('推薦詞生成失敗，請稍後再試');
  }
}

export const knowledgeAdminController = {
  async get(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    res.json({
      data: {
        source: knowledgeStore.getSource(tenantId),
        meta: knowledgeStore.getMeta(tenantId),
        runningJob: getRunningJobForTenant(tenantId) ?? null,
      },
    });
  },

  async saveSource(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const body = req.body as Omit<KnowledgeSource, 'updatedAt'>;
    if (body.visibilityScopes) assertKnownScopes(tenantId, body.visibilityScopes);
    const saved = knowledgeStore.saveSource(tenantId, body);
    res.json({ data: saved });
  },

  async ingest(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const body = req.body as Partial<KnowledgeSource>;
    // 有帶覆寫參數時先存起來，再依最終設定啟動 job
    if (body.startUrl) {
      if (body.visibilityScopes) assertKnownScopes(tenantId, body.visibilityScopes);
      knowledgeStore.saveSource(tenantId, {
        ...knowledgeStore.getSource(tenantId),
        ...body,
      } as Omit<KnowledgeSource, 'updatedAt'>);
    }
    const job = startIngestJob(ingestParamsFor(tenantId));
    res.status(202).json({ data: { jobId: job.id, status: job.status } });
  },

  async job(req: Request, res: Response): Promise<void> {
    const job = getJob(String(req.params.jobId));
    if (!job || job.tenantId !== String(req.params.id)) throw AppError.notFound('job not found');
    res.json({ data: job });
  },

  /**
   * 測試查詢：必須與問答走同一條 pickRetriever，否則在 db 模式下會靜默回 0 命中
   * ——而這正是操作者用來驗證遷移成功的工具，不能自己有一套檢索器選法。
   */
  async queryTest(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const { question, asUserId } = req.body as { question: string; asUserId?: string };
    const retriever = await pickRetriever(tenantId);
    // 管理者權限最大，用自身身分試查永遠成功、等於沒測到。
    // 權限上線後管理者最需要回答的是「HR 的小明看不看得到這份」。
    const userId = asUserId ?? (req.user?.sub ?? 'admin');
    const hits = await retriever.search({ tenantId, userId }, question);
    res.json({
      data: {
        hits: hits.map((h) => ({
          title: h.title,
          url: h.url,
          score: h.score,
          snippet: h.content.slice(0, 160),
        })),
      },
    });
  },

  async remove(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    await deleteIndex(tenantId);
    knowledgeStore.setMeta(tenantId, { status: 'none', chunkCount: 0, chunkCountBySource: { website: 0, file: 0 } });
    res.json({ data: { ok: true } });
  },

  /**
   * 手動重新生成指定來源的開場推薦詞。
   *
   * 平時由索引異動自動觸發，這是補救入口：索引建立於本功能上線前、或當時生成失敗的租戶。
   * 這裡 await 而非 void 觸發——管理者按了按鈕就要看到結果。
   */
  async refreshSuggestion(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const { source } = req.body as { source: SourceKey };
    // 比照上傳／刪檔：爬網進行中不要另外發動生成，兩邊的世代競爭沒有意義
    if (getRunningJobForTenant(tenantId)) {
      throw AppError.conflict('解析任務進行中，請待完成後再重新生成');
    }
    // loadIndexText：重生推薦問句只需要文字，載入向量會在 chunks 上千時撞 statement timeout
    const idx = await loadIndexText(tenantId);
    if (!idx || splitChunksBySource(idx.chunks)[source].length === 0) {
      throw AppError.unprocessable('該來源尚無索引內容');
    }

    const outcome = await regenerateSlot(tenantId, source, idx);
    // 失敗時 meta 會留著舊句，不能改讀 meta 充數；一律據實回報並說明原因
    if (!outcome.ok) throw regenerateError(outcome.reason, aclModeOf(tenantId));
    res.json({ data: { source, slot: knowledgeStore.getMeta(tenantId).suggestedPrompts?.[source] } });
  },

  /** 設定或清除某格的手動推薦詞；manual 為 null 代表恢復自動 */
  async setSuggestionManual(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const { source, manual } = req.body as {
      source: SourceKey;
      manual: { 'zh-Hant': string; en: string } | null;
    };
    // schema 只做 trim 正規化，非空檢查放這裡：空白視為格式錯誤，回 400 而非 zod 驗證失敗慣用的 422
    if (manual && !manual['zh-Hant']) {
      throw AppError.badRequest('zh-Hant 不可為空白');
    }
    const meta = knowledgeStore.getMeta(tenantId);
    const slots = { ...(meta.suggestedPrompts ?? {}) };
    const slot = { ...(slots[source] ?? {}) };
    if (manual) slot.manual = manual;
    else delete slot.manual;
    // 兩者皆空的格位不留下來，避免 meta 累積空物件
    if (slot.generated || slot.manual) slots[source] = slot;
    else delete slots[source];
    knowledgeStore.setMeta(tenantId, { ...meta, suggestedPrompts: slots });
    res.json({ data: { source, slot: slots[source] } });
  },

  /** 上傳單一檔案（multipart field: file）：解析→切塊→embed→附加索引 */
  async uploadFile(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    // 索引檔無鎖：爬網 job 進行中同時附加會有 read-modify-write 競態（可能默默蓋掉彼此的 chunks），
    // 比照「重複爬網」守門以 409 擋下，待 job 結束再上傳。
    if (getRunningJobForTenant(tenantId)) {
      throw AppError.conflict('解析任務進行中，請待完成後再上傳檔案');
    }
    if (!req.file) throw AppError.badRequest('缺少上傳檔案（欄位 file）');
    // multer/busboy 依 RFC 把 Content-Disposition 的檔名當 latin1 解，UTF-8 檔名（如中文）需轉回來
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const fileMeta = await ingestFile(tenantId, originalName, req.file.buffer);
    res.status(201).json({ data: fileMeta });
  },

  /** 刪除已上傳檔案：索引與 meta 一併移除；查無回 404 */
  async deleteFile(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    // 同上：爬網進行中不允許動索引（競態守門）
    if (getRunningJobForTenant(tenantId)) {
      throw AppError.conflict('解析任務進行中，請待完成後再刪除檔案');
    }
    const fileId = String(req.params.fileId);
    const removed = await removeFile(tenantId, fileId);
    if (!removed) throw AppError.notFound('檔案不存在');
    res.json({ data: { fileId } });
  },

  /** 列出該租戶已建立的可見性標籤 */
  async listLabels(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    res.json({ data: tenantStore.getTenant(tenantId)?.knowledgeLabels ?? [] });
  },

  /**
   * 建立可見性標籤：id 格式錯誤回 400（格式檢查與租戶是否存在無關，故先做）；
   * 查無租戶回 404；id 已存在回 400。
   */
  async createLabel(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const { id, label } = req.body as { id: string; label: string };
    assertValidLabelId(id);
    ensureTenant(tenantId);
    const cur = tenantStore.getTenant(tenantId)?.knowledgeLabels ?? [];
    if (cur.some((l) => l.id === id)) throw AppError.badRequest(`標籤已存在：${id}`);
    tenantStore.updateTenant(tenantId, { knowledgeLabels: [...cur, { id, label }] });
    res.status(201).json({ data: { id, label } });
  },

  /** 更新標籤顯示名稱；查無租戶或查無此標籤皆回 404 */
  async updateLabel(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const labelId = String(req.params.labelId);
    const { label } = req.body as { label: string };
    ensureTenant(tenantId);
    const cur = tenantStore.getTenant(tenantId)?.knowledgeLabels ?? [];
    if (!cur.some((l) => l.id === labelId)) throw AppError.notFound(`標籤不存在：${labelId}`);
    tenantStore.updateTenant(tenantId, {
      knowledgeLabels: cur.map((l) => (l.id === labelId ? { ...l, label } : l)),
    });
    res.json({ data: { id: labelId, label } });
  },

  /**
   * 刪除標籤：使用中的文件回到「未標記（鎖住）」，**不得變公開**
   * ——刪除操作絕不能是提權操作。
   *
   * 先 ensureTenant 才動手：對查無租戶的 id（例如打錯字）發 DELETE，
   * 若不先擋，會在完全查不到任何受影響檔案、也查不到任何標籤的情況下，
   * 仍把「查無」的空結果寫回 tenantStore——一個語意上該是 no-op 的請求，
   * 變成有持久化副作用的動作，故先確認租戶存在，不存在直接 404、不寫入。
   */
  /**
   * 刪標籤：清檔案 meta 與兩張表的投影（見上方迴圈），並一併從 scopePolicy 移除
   * 該 scope 的部門／帳號／套餐授權——不清的話，這些授權在 getPolicy 的 prune 之下
   * 後台看不見（孤兒），但資料仍在，隔天重建同名標籤（hr、finance 這類顯而易見的
   * id 正是最可能發生的操作）就會讓舊授權原封不動靜默復活，且從未在後台顯示過。
   * 設計「刪除操作絕不能是提權操作」——刪除本身不是，但「刪除 + 同名重建」是，
   * 這裡是那個縫的補丁。revokedGrants 回報給後台，可提示「同時撤銷了 N 筆部門／
   * 帳號授權」。
   */
  async deleteLabel(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const labelId = String(req.params.labelId);
    ensureTenant(tenantId);
    const scope = kbScopeId(labelId);
    const meta = knowledgeStore.getMeta(tenantId);
    const affected = (meta.files ?? []).filter((f) => (f.visibilityScopes ?? []).includes(scope));

    for (const f of affected) {
      const next = (f.visibilityScopes ?? []).filter((s) => s !== scope);
      // 順序：先寫 DB 投影，再寫記憶體真相來源。DB 是比較可能失敗的一端，
      // 先寫它可以確保失敗時記憶體還沒動、請求誠實回 500、狀態維持一致；
      // 反過來則會出現「管理者以為已收緊權限，但檢索端投影還是舊值」的視窗。
      await setFileVisibility(tenantId, f.fileId, next);
      replaceFileMeta(tenantId, { ...f, visibilityScopes: next });
    }
    const revokedGrants = scopePolicy.revokeScope(tenantId, scope);
    const cur = tenantStore.getTenant(tenantId)?.knowledgeLabels ?? [];
    tenantStore.updateTenant(tenantId, { knowledgeLabels: cur.filter((l) => l.id !== labelId) });
    res.json({ data: { affectedFiles: affected.length, revokedGrants } });
  },

  /**
   * 標註檔案可見性；未知標籤或查無檔案皆回錯誤。
   *
   * 不呼叫 ensureTenant：本端點不寫入 tenantStore，只讀 knowledgeLabels 做驗證，
   * 查無租戶時 valid 自然是空集合，任何非空 scopes 都會被判定為未知標籤而回 400，
   * 沒有 deleteLabel 那種「查無仍會持久化寫入」的破口，故沿用既有行為即可。
   */
  async setFileVisibilityHandler(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const fileId = String(req.params.fileId);
    const { scopes } = req.body as { scopes: string[] };
    assertKnownScopes(tenantId, scopes);

    const meta = knowledgeStore.getMeta(tenantId);
    const file = (meta.files ?? []).find((f) => f.fileId === fileId);
    if (!file) throw AppError.notFound(`查無檔案：${fileId}`);

    // 順序同 deleteLabel：先 DB 投影、後記憶體真相來源（原本這裡兩者順序相反，已修正統一）。
    await setFileVisibility(tenantId, fileId, scopes);
    replaceFileMeta(tenantId, { ...file, visibilityScopes: scopes });
    res.json({ data: { fileId, scopes } });
  },

  /**
   * ACL 盤點：unlabeled（NULL＝從未標記，待辦）與 explicitlyEmpty（[]＝已決定誰都不能看）
   * 分開列，兩者查詢效果相同但語意不同。
   */
  async aclReport(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.params.id);
    const files = knowledgeStore.getMeta(tenantId).files ?? [];
    /*
     * 網站來源的可見性標籤是整個來源一組（KnowledgeSource.visibilityScopes），不是逐檔
     * ——盤面只掃 meta.files 結構上看不到它。失效情境：租戶主力語料是爬來的官網，
     * 管理者把所有「檔案」都標好，面板顯示「未標記 0 筆」，切 on 後整個網站語料的
     * visibility_scopes 卻是 NULL、對所有人消失，而盤點報表從頭到尾沒說過一句話。
     * 這裡把來源當成一筆獨立項目列出，讓遷移進度指標不會說謊。
     * configured=false（未設定 startUrl，本來就沒有網站語料）時 unlabeled/explicitlyEmpty
     * 一律回 false——沒有內容就沒有「待標記」這件事，避免空租戶被算進待辦清單。
     */
    const source = knowledgeStore.getSource(tenantId);
    const sourceConfigured = !!source.startUrl;
    res.json({
      data: {
        mode: aclModeOf(tenantId),
        unlabeled: files.filter((f) => f.visibilityScopes === undefined),
        explicitlyEmpty: files.filter((f) => f.visibilityScopes?.length === 0),
        source: {
          configured: sourceConfigured,
          unlabeled: sourceConfigured && source.visibilityScopes === undefined,
          explicitlyEmpty: sourceConfigured && source.visibilityScopes?.length === 0,
        },
        shadowStats: await listShadowStats(tenantId),
        shadowCaveat:
          'shadow 以候選池內的結果估算，會低估影響，有兩個獨立來源：'
          + '(1) 候選池被無權文件佔滿而未進入 top-k 的有權文件不會被計入；'
          + '(2) shadow 差集計算以 file_id 為 key（見 retriever.pgvector.ts），'
          + 'file_id 為 NULL 的網站來源 chunk 一律被濾掉、完全不進入統計——'
          + '若主力語料是爬來的網站內容，shadow 對整個網站語料回報的影響恆為零，'
          + '不代表切到 on 後真的零影響。回報零影響不等於切換 on 後零影響。',
      },
    });
  },
};
