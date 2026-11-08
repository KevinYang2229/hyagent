import { useEffect, useState } from "react";
import { Checkbox, useToast } from "@hyagent/ui";
import { api, type KnowledgeFileMeta, type KnowledgeLabel } from "../../../api";
import { fileLabelState, kbScopeId, labelNameFor, stripKbPrefix } from "../knowledgeAcl.util";
import { useConfirm } from "../../../components/confirm";
import { useUnsavedChanges } from "../../../components/unsaved";

const pageSize = 5;

/**
 * 「來源與檔案」子頁的已匯入檔案清單：搜尋、依標記狀態篩選、分頁、編輯可見性標籤、刪除。
 * focusFileId：其他子頁（可見範圍與標籤）要求開啟某份檔案的標籤編輯時由外層帶入，處理完呼叫 onFocusHandled。
 */
export default function FilesCard({ tenantId, files, labels, focusFileId, onFocusHandled, onReload, onError }: {
  tenantId: string;
  files: KnowledgeFileMeta[];
  labels: KnowledgeLabel[];
  focusFileId: string | null;
  onFocusHandled: () => void;
  /** 檔案或可見性異動後重新載入索引與 ACL 盤點 */
  onReload: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [fileSearch, setFileSearch] = useState("");
  const [fileFilter, setFileFilter] = useState("all");
  const [filePage, setFilePage] = useState(1);
  // 檔案可見性多選編輯：editingFileId 為 null 代表沒有檔案在編輯中
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editScopes, setEditScopes] = useState<string[]>([]); // labelId（未加 kb: 前綴）
  const [savingVisibility, setSavingVisibility] = useState(false);
  const editingFile = files.find((f) => f.fileId === editingFileId);
  const sameScopes = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  useUnsavedChanges(`知識庫：「${editingFile?.name ?? ''}」的標籤`, !!editingFile && !sameScopes(editScopes, (editingFile.visibilityScopes ?? []).map(stripKbPrefix)));

  const sortedFiles = [...files].sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
  const filteredFiles = sortedFiles.filter((file) =>
    file.name.toLocaleLowerCase().includes(fileSearch.trim().toLocaleLowerCase()) &&
    (fileFilter === "all" || fileLabelState(file.visibilityScopes) === fileFilter),
  );
  const pageCount = Math.max(1, Math.ceil(filteredFiles.length / pageSize));
  const currentPage = Math.min(filePage, pageCount);
  const visibleFiles = filteredFiles.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const startEditFile = (f: KnowledgeFileMeta) => {
    setEditingFileId(f.fileId);
    setEditScopes((f.visibilityScopes ?? []).map(stripKbPrefix));
  };

  // 其他子頁要求開啟某份檔案：清掉搜尋與篩選、翻到該檔案所在頁、開啟編輯並捲過去
  useEffect(() => {
    if (!focusFileId) return;
    const index = sortedFiles.findIndex((file) => file.fileId === focusFileId);
    if (index >= 0) {
      setFileSearch("");
      setFileFilter("all");
      setFilePage(Math.floor(index / pageSize) + 1);
      startEditFile(sortedFiles[index]);
      requestAnimationFrame(() => document.getElementById(`kb-file-${focusFileId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    }
    onFocusHandled();
    // 只在收到新的開啟要求時處理；sortedFiles 每次 render 都是新陣列，不列入依賴
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFileId]);

  const toggleEditScope = (labelId: string) =>
    setEditScopes((cur) =>
      cur.includes(labelId) ? cur.filter((x) => x !== labelId) : [...cur, labelId],
    );

  const saveFileVisibility = async (f: KnowledgeFileMeta) => {
    setSavingVisibility(true);
    try {
      const scopes = editScopes.map(kbScopeId);
      await api.setKnowledgeFileVisibility(tenantId, f.fileId, scopes);
      setEditingFileId(null);
      await onReload();
      toast.success("已更新可見性");
    } catch (e) {
      onError(e);
    } finally {
      setSavingVisibility(false);
    }
  };

  const removeFile = async (f: KnowledgeFileMeta) => {
    if (!(await confirm({ title: `刪除檔案「${f.name}」？`, message: `此檔案的 ${f.chunks} 個段落會從索引移除，所有人都查不到；要恢復需重新上傳。` }))) return;
    try {
      await api.deleteKnowledgeFile(tenantId, f.fileId);
      await onReload();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <section className="card" aria-label="已匯入檔案">
      <div className="card-head">
        <div>
          <div className="card-title">已匯入檔案 <span className="row-sub">共 {sortedFiles.length} 份</span></div>
          <div className="card-desc">依匯入時間由新到舊排列，每頁顯示 {pageSize} 份。</div>
        </div>
      </div>
      <div className="card-body kb-file-toolbar">
        <input className="input" aria-label="搜尋檔案名稱" placeholder="搜尋檔案名稱…" value={fileSearch}
          onChange={(e) => { setFileSearch(e.target.value); setFilePage(1); }} />
        <select className="select" aria-label="篩選檔案可見性設定" value={fileFilter}
          onChange={(e) => { setFileFilter(e.target.value); setFilePage(1); }}>
          <option value="all">全部設定狀態</option>
          <option value="unlabeled">待設定標籤</option>
          <option value="labeled">已設定標籤</option>
          <option value="empty">不開放</option>
        </select>
      </div>
      <ul className="list">
        {visibleFiles.map((f) => {
          const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
          const scopes = f.visibilityScopes ?? [];
          const state = fileLabelState(f.visibilityScopes);
          return (
            <li key={f.fileId} id={`kb-file-${f.fileId}`} className="kb-file-item">
              <div className="kb-file-heading">
                <span className="kfile-ext" data-ext={ext}>{ext}</span>
                <div className="row-main">
                  <div className="row-title">{f.name}</div>
                  <div className="row-sub">{f.chunks} 個段落 · {new Date(f.ingestedAt).toLocaleString("zh-TW")}</div>
                </div>
              </div>
              <div className="kb-file-labels">
                <div className="row-sub">可見性標籤 · 仍需部門授權</div>
                <div className="kb-label-chips">
                  {state !== "labeled" ? <span className="kb-label-chip kb-label-chip--warn">
                    {state === "unlabeled" ? "待設定標籤（無人可查詢）" : "不開放（標籤已清空）"}
                  </span> : scopes.slice(0, 3).map((scope) => (
                    <span key={scope} className="kb-label-chip">{labelNameFor(labels, scope)}</span>
                  ))}
                </div>
                {scopes.length > 3 && <details className="kb-file-more-labels">
                  <summary>另有 {scopes.length - 3} 個標籤</summary>
                  <div className="kb-label-chips">{scopes.slice(3).map((scope) => (
                    <span key={scope} className="kb-label-chip">{labelNameFor(labels, scope)}</span>
                  ))}</div>
                </details>}
              </div>
              <div className="kb-file-actions">
                <button type="button" className="btn btn-sm" disabled={savingVisibility}
                  onClick={() => editingFileId === f.fileId ? setEditingFileId(null) : startEditFile(f)}>
                  {editingFileId === f.fileId ? "收合編輯" : "編輯標籤"}
                </button>
                <button type="button" className="btn btn-danger btn-sm" disabled={savingVisibility}
                  aria-label={`刪除 ${f.name}`} onClick={() => removeFile(f)}>刪除檔案</button>
              </div>
              {editingFileId === f.fileId && <div className="kb-file-editor">
                <div className="row-title">選擇可見性標籤 <span className="row-sub">已選 {editScopes.length} 個</span></div>
                <div className="kb-label-options" role="group" aria-label="可見性標籤選項">
                  {labels.map((label) => <label key={label.id}>
                    <Checkbox checked={editScopes.includes(label.id)} disabled={savingVisibility} onChange={() => toggleEditScope(label.id)} />
                    <span>{label.label}</span>
                  </label>)}
                  {labels.length === 0 && <div className="row-sub">請先到「可見範圍與標籤」子頁新增標籤。</div>}
                </div>
                {editScopes.length === 0 && <div className="row-sub">未選擇任何標籤，儲存後無人可查詢。</div>}
                <div className="kb-file-actions">
                  <button type="button" className="btn btn-primary btn-sm" disabled={savingVisibility} onClick={() => saveFileVisibility(f)}>{savingVisibility ? "儲存中…" : "儲存標籤"}</button>
                  <button type="button" className="btn btn-sm" disabled={savingVisibility} onClick={() => setEditingFileId(null)}>取消</button>
                </div>
              </div>}
            </li>
          );
        })}
        {visibleFiles.length === 0 && <li className="empty">{sortedFiles.length ? "找不到符合條件的檔案，請調整搜尋或篩選。" : "尚未匯入檔案。"}</li>}
      </ul>
      <nav className="kb-file-pagination" aria-label="檔案清單分頁">
        <span className="row-sub" aria-live="polite">共 {filteredFiles.length} 份 · 第 {currentPage} / {pageCount} 頁</span>
        <div className="kb-file-actions">
          <button type="button" className="btn btn-sm" disabled={currentPage <= 1 || savingVisibility} onClick={() => setFilePage(currentPage - 1)}>上一頁</button>
          <button type="button" className="btn btn-sm" disabled={currentPage >= pageCount || savingVisibility} onClick={() => setFilePage(currentPage + 1)}>下一頁</button>
        </div>
      </nav>
    </section>
  );
}
