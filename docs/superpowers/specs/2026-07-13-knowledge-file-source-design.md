# 知識庫檔案來源（上傳 txt/md/PDF/Word）— 設計

**日期**：2026-07-13
**狀態**：設計（已與使用者確認方向）
**動機**：知識庫目前只有「網站爬取」單一來源；公司規章實務多為 PDF/Word 檔，需可直接上傳餵入。

## 決策紀錄

| # | 決策 | 選定 |
|---|---|---|
| D1 | 支援格式 | **txt / md / PDF / Word(docx)**。PDF 用 `pdf-parse`、docx 用 `mammoth`（成熟解析庫）；txt/md 零依賴。掃描型 PDF（抽不出文字）如實回 422 提示。 |
| D2 | 與網站來源關係 | **並存**：檔案 chunk 與網站 chunk 進**同一份租戶索引**（檢索端零改動），chunk 以 `fileId` 標注出處；**網站重爬不得沖掉檔案 chunk**、刪除檔案只移除該檔 chunk。 |
| D3 | 處理方式 | 檔案解析快，**同步 ingest**（上傳→解析→切塊→embed→附加進索引），不走爬蟲 job。 |
| D4 | 原始檔 | **不保存原始檔**，只留解析後的 chunks + 檔案 metadata（名稱/塊數/時間），要更新就重新上傳。 |

## 架構

### 資料模型
- `IndexedChunk` 加選填 `fileId?: string`（檔案來源的 chunk；`url` 欄位放 `file://<檔名>`、`title` 放檔名，檢索/rerank/顯示零改動）。
- knowledge meta store 加 `files: { fileId, name, chunks, ingestedAt }[]`。

### 後端流程
1. **上傳 ingest**（`POST /api/admin/tenants/:id/knowledge/files`，multipart，multer 記憶體、上限 10MB）：
   - 依副檔名解析成純文字：txt/md 直讀、pdf→`pdf-parse`、docx→`mammoth`；抽出文字 < 20 字 → 422「無可抽取文字（可能為掃描檔/空檔）」。
   - 沿用既有 chunk 切塊（`chunkChars`，取來源設定或預設）與 embedding（**模型以現有索引的 `model` 為準**，無索引時用來源設定/預設——避免同索引混模型）。
   - chunks 附加進租戶索引（無索引則建立）；寫 meta.files。
2. **刪除檔案**（`DELETE .../knowledge/files/:fileId`）：索引移除該 `fileId` 的 chunks + meta 移除該檔。
3. **網站重爬保留檔案 chunk**：ingest job 寫索引時，把既有索引中帶 `fileId` 的 chunks **搬運保留**（只重建網站部分）。
4. `GET .../knowledge` 回應加 `files` 清單。

### admin UI（KnowledgeTab）
- 新增「**檔案來源**」區塊：上傳按鈕（accept .txt/.md/.pdf/.docx）+ 已上傳清單（檔名/塊數/時間/刪除）。上傳中顯示進度、錯誤（如掃描檔）toast 呈現。

## 安全/品質
- admin 端點沿用 requireAdmin；檔案大小/型別白名單雙重檢查（副檔名 + mimetype）。
- 解析錯誤不得留半套狀態（先解析成功再動索引/meta）。
- 索引模型一致性守則（D2/上述模型選擇）避免向量不可比。

## 測試策略
- 解析 dispatcher：txt/md 直讀路徑單元測試；pdf/docx 以依賴庫行為為準（typecheck + 手動驗證；不造二進位 fixture）。
- pipeline：上傳 txt → 索引出現帶 `fileId` 的 chunks、meta.files 有紀錄；刪除 → chunks/meta 移除；**網站重爬後檔案 chunk 仍在**（核心回歸）。
- embedding 沿用既有測試的 mock/stub 模式（比照 knowledge-ingest.test）。
- 全部新建租戶隔離。

## 非目標（v1）
- 掃描 PDF 的 OCR。
- 原始檔下載/版本管理（重傳即更新）。
- Excel/CSV（表格轉文字品質另議）。
