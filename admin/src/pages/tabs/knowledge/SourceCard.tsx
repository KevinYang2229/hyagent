import { useRef, useState } from "react";
import { Checkbox, Dialog, useToast } from "@hyagent/ui";
import { api, type IngestJob, type KnowledgeLabel, type KnowledgeMeta, type KnowledgeSource } from "../../../api";
import NumberField from "../../../components/NumberField";
import UnsavedBadge from "../../../components/UnsavedBadge";
import { kbScopeId } from "../knowledgeAcl.util";

const EMBEDDING_MODELS = ["text-embedding-3-large", "text-embedding-3-small"];
type SourceKind = "website" | "file";

/**
 * 知識庫可上傳的副檔名，需與 server 端 doc-parse 的 SUPPORTED_EXTENSIONS 一致。
 *
 * accept、拖放白名單與提示文案共用這一份：三處分開寫必然漂移——只放寬 accept 的話，
 * 檔案挑得到卻拖不進來，而且錯在前端，使用者連 server 的錯誤訊息都看不到。
 */
const KNOWLEDGE_EXTS = ["txt", "md", "htm", "html", "doc", "docx", "pdf", "xlsx"];
const KNOWLEDGE_ACCEPT = KNOWLEDGE_EXTS.map((e) => `.${e}`).join(",");
/** 顯示用：htm 與 html 對使用者是同一件事，只列一個 */
const KNOWLEDGE_EXT_LABELS = KNOWLEDGE_EXTS.filter((e) => e !== "html").map((e) =>
  e.toUpperCase(),
);

/**
 * 「建立知識來源」卡：網站或檔案來源、可查詢對象、解析參數；儲存網站設定、開始解析、清除索引。
 * 網站設定（src）由外層持有，才能在離開頁面前判斷是否有未儲存的修改。
 */
export default function SourceCard({
  tenantId, src, dirty, meta, job, labels, departments,
  onChange, onSaved, onJobStarted, onReload, onReloadAcl, onIndexCleared, onError,
}: {
  tenantId: string;
  src: KnowledgeSource;
  /** 網站設定是否有未儲存的修改 */
  dirty: boolean;
  meta: KnowledgeMeta;
  job: IngestJob | null;
  labels: KnowledgeLabel[];
  departments: string[];
  onChange: (patch: Partial<KnowledgeSource>) => void;
  /** 設定已寫入後端：外層據此更新目前值與「已儲存」基準 */
  onSaved: (saved: KnowledgeSource) => void;
  /** 網站解析工作已建立：外層負責輪詢進度 */
  onJobStarted: (job: IngestJob) => void;
  onReload: () => Promise<void>;
  onReloadAcl: () => Promise<void>;
  onIndexCleared: () => void;
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const update = onChange;
  const [savingSource, setSavingSource] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false); // 拖放上傳區的 drag-over 高亮
  // 來源設定：先選網站或檔案，再填完參數，最後由同一顆「開始解析」依類型處理。
  const [sourceKind, setSourceKind] = useState<SourceKind>("website");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 清除索引是不可逆操作：先開確認框，輸入「清除」才放行
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearTyped, setClearTyped] = useState("");

  const running = !!job && ["queued", "crawling", "embedding"].includes(job.status);
  const parsing = running || uploading;
  const lockedModel = meta.model;
  const audienceValid = src.audience?.mode !== "departments" || !!src.audience.departments?.length;
  const canParse =
    audienceValid &&
    !parsing &&
    src.chunkChars > 0 &&
    (sourceKind === "website" ? !!src.startUrl : !!pendingFile);

  const saveSourceSettings = async () => {
    setSavingSource(true);
    try {
      const saved = await api.saveKnowledgeSource(tenantId, src);
      onSaved(saved);
      await onReloadAcl();
      toast.success("已儲存網站設定");
    } catch (e) {
      onError(e);
    } finally {
      setSavingSource(false);
    }
  };

  const parseSource = async () => {
    if (sourceKind === "file" && !pendingFile) {
      toast.error("請先選擇要解析的檔案");
      return;
    }
    setUploading(sourceKind === "file");
    try {
      await api.saveKnowledgeSource(tenantId, src);
      onSaved(src);
      if (sourceKind === "website") {
        const { jobId, status } = await api.startKnowledgeIngest(tenantId);
        onJobStarted({
          id: jobId,
          tenantId,
          status: status as IngestJob["status"],
          pagesCrawled: 0,
          chunks: 0,
          embedded: 0,
          startedAt: new Date().toISOString(),
        });
      } else if (pendingFile) {
        const m = await api.uploadKnowledgeFile(tenantId, pendingFile);
        toast.success(`已匯入 ${m.chunks} 個段落`);
        setPendingFile(null);
        await onReload();
      }
    } catch (e) {
      onError(e);
    } finally {
      setUploading(false);
    }
  };

  const clear = async () => {
    setConfirmingClear(false);
    setClearTyped("");
    try {
      await api.deleteKnowledge(tenantId);
      await onReload();
      onIndexCleared();
    } catch (e) {
      onError(e);
    }
  };

  /** 選檔只帶入來源；chunk/model 等參數在同一區塊確認後，再按「開始解析」。 */
  const pickFile = (file: File) => {
    setSourceKind("file");
    setPendingFile(file);
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">建立知識來源<UnsavedBadge dirty={dirty} /></div>
            <div className="card-desc">
              選擇網站或檔案，設定參數後解析成此租戶專屬的知識索引，供 AI 回答時檢索。
            </div>
          </div>
        </div>
        <div className="card-body">
          <div className="tabs kb-source-tabs" role="tablist" aria-label="知識來源類型">
            <button
              type="button"
              className={`tab ${sourceKind === "website" ? "active" : ""}`}
              onClick={() => setSourceKind("website")}
              disabled={parsing}
            >
              網站
            </button>
            <button
              type="button"
              className={`tab ${sourceKind === "file" ? "active" : ""}`}
              onClick={() => setSourceKind("file")}
              disabled={parsing}
            >
              檔案
            </button>
          </div>

          {sourceKind === "website" ? (
            <div className="form-grid">
              <div className="field">
                <label className="field-label">起始網址</label>
                <input
                  className="input"
                  value={src.startUrl}
                  onChange={(e) => update({ startUrl: e.target.value })}
                  placeholder="https://www.example.com/"
                  disabled={parsing}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="website-audience">網站可查詢對象</label>
                <select id="website-audience" className="select"
                  value={src.audience?.mode ?? ((src.visibilityScopes?.length ?? 0) > 0 ? "labels" : "disabled")}
                  disabled={parsing || savingSource}
                  onChange={(e) => update({
                    audience: { mode: e.target.value as NonNullable<KnowledgeSource["audience"]>["mode"], departments: src.audience?.departments ?? [] },
                    visibilityScopes: (src.visibilityScopes ?? []).filter((scope) => scope !== "kb:__website_access"),
                  })}>
                  <option value="disabled">暫不開放</option>
                  <option value="public">所有人（包含訪客）</option>
                  <option value="departments">指定部門</option>
                  <option value="labels">進階：使用可見性標籤</option>
                </select>
                {src.audience?.mode === "public" && <span className="field-hint">儲存後，所有人都可查詢此網站內容，也可用於公開開場推薦詞。</span>}
                {src.audience?.mode === "departments" && <>
                  <div className="kb-label-options" role="group" aria-label="可查詢網站的部門">
                    {departments.map((department) => <label key={department}>
                      <Checkbox checked={src.audience?.departments?.includes(department) ?? false} disabled={parsing || savingSource}
                        onChange={(e) => update({ audience: { mode: "departments", departments: e.target.checked
                          ? [...(src.audience?.departments ?? []), department]
                          : (src.audience?.departments ?? []).filter((value) => value !== department) } })} />
                      <span>{department}</span>
                    </label>)}
                  </div>
                  <span className="field-hint">至少選擇一個部門。訪客與其他部門無法查詢；不需另外設定標籤授權。</span>
                  {departments.length === 0 && <span className="field-hint">尚無可選部門，請先設定人員目錄或部門權限。</span>}
                </>}
                {(src.audience?.mode === "labels" || (!src.audience && !!src.visibilityScopes?.length)) && <>
                  <div className="kb-label-options" role="group" aria-label="網站可見性標籤">
                    {labels.map((label) => <label key={label.id}>
                      <Checkbox checked={(src.visibilityScopes ?? []).includes(kbScopeId(label.id))} disabled={parsing || savingSource}
                        onChange={(e) => update({ visibilityScopes: e.target.checked
                          ? [...(src.visibilityScopes ?? []), kbScopeId(label.id)]
                          : (src.visibilityScopes ?? []).filter((scope) => scope !== kbScopeId(label.id)) })} />
                      <span>{label.label}</span>
                    </label>)}
                  </div>
                  <span className="field-hint">沿用標籤與部門授權。請到「權限」把相同標籤加進角色；未選標籤時無人可查詢。</span>
                </>}
                {(src.audience?.mode === "disabled" || (!src.audience && !src.visibilityScopes?.length)) && <span className="field-hint">保留網站內容，但暫不提供任何人查詢。</span>}
                <span className="field-hint">僅套用到整個網站來源，不會變更檔案的可見範圍。儲存後生效，不需重新解析。</span>
              </div>
              <div className="field">
                <label className="field-label">最大頁數</label>
                <NumberField
                  value={src.maxPages}
                  onChange={(maxPages) => update({ maxPages })}
                  min={1}
                  max={1000}
                  disabled={parsing}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="website-render-javascript">
                  <Checkbox id="website-render-javascript" checked={src.renderJavaScript ?? false}
                    disabled={parsing || savingSource}
                    onChange={(e) => update({ renderJavaScript: e.target.checked })} />
                  瀏覽器渲染後解析
                </label>
                <span className="field-hint">適用於以 JavaScript 載入內容的網站，解析時間較長。僅讀取未登入即可瀏覽的內容，不會沿用你的登入狀態。變更後需重新解析。</span>
              </div>
              {src.renderJavaScript && <div className="field">
                <label className="field-label">內容載入等待時間（毫秒）
                <NumberField value={src.renderWaitMs ?? 1500}
                  min={0} max={10000} disabled={parsing || savingSource}
                  onChange={(renderWaitMs) => update({ renderWaitMs })} />
                </label>
                <span className="field-hint">頁面載入後額外等待動態資料，預設 1500 毫秒，最多 10000 毫秒。</span>
              </div>}
              <div className="field">
                <label className="field-label">路徑前綴（選填）</label>
                <input
                  className="input"
                  value={src.pathPrefix ?? ""}
                  onChange={(e) =>
                    update({ pathPrefix: e.target.value || undefined })
                  }
                  placeholder="/mp"
                  disabled={parsing}
                />
              </div>
            </div>
          ) : (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept={KNOWLEDGE_ACCEPT}
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) pickFile(file);
                  e.target.value = ""; // 允許再次上傳同一檔
                }}
              />
              <div
                role="button"
                tabIndex={0}
                aria-label="上傳檔案"
                className={`kdrop${dragOver ? " kdrop--over" : ""}${uploading ? " kdrop--busy" : ""}`}
                onClick={() => !parsing && fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (!parsing && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!parsing) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (parsing) return;
                  const file = e.dataTransfer.files?.[0];
                  if (!file) return;
                  const ext = file.name
                    .slice(file.name.lastIndexOf(".") + 1)
                    .toLowerCase();
                  if (!KNOWLEDGE_EXTS.includes(ext)) {
                    toast.error(`僅支援 ${KNOWLEDGE_EXT_LABELS.join("、")} 檔案`);
                    return;
                  }
                  pickFile(file);
                }}
              >
                {uploading ? (
                  <>
                    <span className="kdrop-spinner" aria-hidden />
                    <div className="kdrop-title">正在解析並建立索引…</div>
                    <div className="kdrop-sub">大型檔案可能需要數十秒</div>
                  </>
                ) : (
                  <>
                    <svg
                      className="kdrop-icon"
                      width="32"
                      height="32"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2" />
                      <path d="M12 12v9" />
                      <path d="m8 17 4-4 4 4" />
                    </svg>
                    <div className="kdrop-title">
                      {pendingFile ? pendingFile.name : "拖曳檔案到這裡，或點擊選擇"}
                    </div>
                    <div className="kdrop-sub">
                      {pendingFile
                        ? `${Math.max(1, Math.round(pendingFile.size / 1024))} KB，支援重新點擊更換檔案`
                        : // 括號內改點名弱的一端：xlsx 與 docx 同屬保留得到結構的格式，
                          // 再寫「DOCX 準確度最佳」就不對了
                          `支援 ${KNOWLEDGE_EXT_LABELS.join("・")}，單檔上限 10MB（DOC、PDF 取不到文件結構，檢索準確度較低）`}
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          <div className="kb-param-block">
            <div className="form-grid">
              <div className="field">
                <label className="field-label">段落長度（chunk，字元）</label>
                <NumberField
                  value={src.chunkChars}
                  onChange={(chunkChars) => update({ chunkChars })}
                  min={200}
                  max={4000}
                  disabled={parsing}
                />
                <span className="field-hint">文件會切成段落供檢索。越長脈絡越完整，但命中較不精準；一般建議 800–1200。</span>
              </div>
              <div className="field">
                <label className="field-label">向量模型（embedding）</label>
                {lockedModel ? (
                  <>
                    <input className="input" value={lockedModel} disabled />
                    <span className="field-hint">
                      同一索引須沿用既有模型；要換模型請先清除索引
                    </span>
                  </>
                ) : (
                  <select
                    className="select"
                    value={src.embeddingModel}
                    onChange={(e) => update({ embeddingModel: e.target.value })}
                    disabled={parsing}
                  >
                    {EMBEDDING_MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                )}
                <span className="field-hint">把文字轉成向量以進行語意檢索（找意思相近、不只字面相同的段落）。</span>
              </div>
              <div className="field">
                <label className="field-label">AI 重新排序（rerank）</label>
                <label
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <Checkbox
                    checked={src.rerank}
                    onChange={(e) => update({ rerank: e.target.checked })}
                    disabled={parsing}
                  />
                  <span className="field-hint">
                    先找出候選段落，再請 AI 依問題重新排序。答案較精準，但每次查詢多一次 AI 呼叫（較慢、費用較高）。
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div className="form-actions">
            {sourceKind === "website" && (
              <button
                type="button"
                className="btn"
                onClick={saveSourceSettings}
                disabled={parsing || savingSource || !src.startUrl.trim() || !audienceValid}
              >
                {savingSource ? "儲存中…" : "儲存網站設定（不重新解析）"}
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={parseSource}
              disabled={!canParse || savingSource}
            >
              {parsing ? "解析中…" : "開始解析"}
            </button>
            <button
              className="btn btn-danger"
              onClick={() => setConfirmingClear(true)}
              disabled={parsing || meta.status === "none"}
            >
              清除索引
            </button>
          </div>
        </div>
      </div>

      <Dialog
        isOpen={confirmingClear}
        title="清除整個知識庫索引？"
        confirmText="清除索引"
        confirmVariant="danger"
        confirmDisabled={clearTyped.trim() !== "清除"}
        onClose={() => { setConfirmingClear(false); setClearTyped(""); }}
        onConfirm={() => void clear()}
      >
        <p style={{ marginTop: 0 }}>
          將刪除 {meta.chunkCount ?? 0} 個段落（含 {meta.files?.length ?? 0} 份檔案與網站內容），所有人會立即查不到這些知識，無法復原。
          要恢復必須重新上傳檔案並重新解析網站。
        </p>
        <label className="field">
          <span className="field-label">請輸入「清除」以確認</span>
          <input className="input" value={clearTyped} onChange={(e) => setClearTyped(e.target.value)} autoFocus />
        </label>
      </Dialog>
    </>
  );
}
