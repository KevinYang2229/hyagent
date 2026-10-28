# 網站來源的瀏覽器渲染解析

## 解析容量與錯誤處理

為控制 Node 記憶體，單頁 HTML 限制 2 MiB、每次任務的抽取文字限制 200 萬字元、去重後片段限制 1000 筆。接近 Node heap 上限時也會提早停止並回報「可用記憶體不足」。這些情況均不提交部分索引；既有索引資料保留。最大頁數包含無正文或載入失敗的造訪頁，避免無正文頁造成無限爬取。

爬取連結在入列前去重，候選佇列最多為最大頁數的十倍；每頁切段完成即釋放原文。瀏覽器端先移除不需索引的 script、style、SVG 與 iframe，並檢查大小後才將 HTML 傳回 Node。靜態模式以串流限制解壓後 HTML 大小，不依賴 content-length。

超量時可降低最大頁數，或使用路徑前綴拆小來源範圍。爬取完成的日誌包含頁數、片段數與當時 heap 用量，供比對出錯階段。

## 使用方式

若網站以 JavaScript 載入統計數字或正文，可在「知識庫 → 網站來源」勾選「瀏覽器渲染後解析」，儲存後重新解析。既有來源預設維持直接解析 HTML。

頁面 DOM 載入後預設額外等待 1500 毫秒，可設定 0–10000 毫秒。每頁導航上限為 30 秒；解析使用渲染後的 HTML 抽正文、連結，再沿用切段、向量化與權限流程。來源的頁數、路徑及網址篩選仍有效。修改這項設定需要重新解析，不會自動更新既有索引。

每次任務建立獨立的無痕瀏覽器環境，結束後關閉。只支援不需登入的內容，不會使用後台管理者的 cookies 或 sessionStorage，也不會自動登入。起始頁跳轉至登入頁、渲染失敗或沒有可解析文字時，任務失敗並保留原有索引資料；其他子頁失敗會記錄並略過。

圖表必須有可抽取的 HTML 文字。純圖片、canvas、SVG 圖表，以及必須點選或捲動才出現的內容，不保證收錄。可提供相應的文字表格或上傳資料檔案。

部署需要 Chromium/Chrome。`Dockerfile.server` 已安裝 Chromium，並設定 `KNOWLEDGE_BROWSER_EXECUTABLE=/usr/bin/chromium`。其他環境可設定此變數；未指定時會尋找既有 PDF 瀏覽器路徑、Linux Chromium 或 macOS Google Chrome。

瀏覽器回歸測試（需安裝 Chromium/Chrome）：

```sh
RUN_KNOWLEDGE_BROWSER_TESTS=1 npm run test -w server -- --runInBand tests/knowledge-browser-live.test.ts
```

測試使用本機 HTTP fixture，模擬延遲 JavaScript 產生展覽預登人數、動態連結與登入跳轉，embedding 使用替身，不呼叫模型服務。
