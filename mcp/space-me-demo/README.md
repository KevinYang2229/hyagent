# SpaceMe 即時資訊顯示 MCP

獨立的 Streamable HTTP MCP 服務，提供 SpaceMe AI 顧問查詢空間使用狀態、環境數據與公告。
目前使用**示範資料**，不連接真實感測器、預約系統或電子看板；每次查詢都明確標示來源、觀測時間與查詢時間。
這個服務提供按需查詢，不會自動向 App 或看板推播；若需要自動刷新，呼叫端需定時查詢。

| 工具 | 說明 | 查詢條件 |
| --- | --- | --- |
| `spaceme_realtime_overview` | 場域空間與席位、離線感測器、公告統計 | `siteId` |
| `spaceme_space_status` | 空間狀態、容量、使用人數與可用席位 | `siteId`、`keyword`、`type`、`status` |
| `spaceme_environment` | 溫度 °C、濕度 %、CO₂ ppm 與感測器狀態 | `siteId`、`spaceId` |
| `spaceme_announcements` | 目前有效的公告，緊急優先 | `siteId`、`priority` |

全部工具是唯讀，回傳 `structuredContent`、文字 JSON 與 `_meta["hyagent/display"]` 表格提示，沿用 [MCP 工具規格](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

## 啟動

在專案根目錄執行：

```bash
npm install
HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json \
MCP_SERVER_ID=space-me-demo PORT=4300 npm run dev:mcp:space-me
```

`.env.example` 是參考設定；啟動指令使用環境變數，不會自動讀 `.env`。

- MCP URL：`http://localhost:4300/mcp`
- 健康檢查：`http://localhost:4300/healthz`
- MCP 請求需要 HyAgent 簽發的 ES256 Bearer JWT；驗證 audience 與 JWT 重播。
- 系統身分可列出工具；查詢資料需要實際使用者身分。

在 HyAgent 後台「MCP 服務」新增 `serverId=space-me-demo` 與上述 MCP URL，啟用 HyAgent 身分簽章。
把 `mcp:space-me-demo` 與 `service:agent` 權限指派給 SpaceMe 的**訪客部門**。
若後端部署在容器或遠端主機，URL 要改成後端可以連到的地址，不能直接使用手機或其他容器的 localhost。
本次沒有自動修改後台設定，也沒有把示範查詢綁死到 App 靜態產品文案。

可向 AI 顧問詢問：

- 「顯示目前圖書館與辦公室的空間使用狀態」
- 「辦公室還有哪間會議室可以使用？」
- 「會議室 B 的環境感測器有上線嗎？」
- 「目前有什麼緊急公告？」

## 資料規則

- 場域：`library`（示範圖書館）與 `office`（示範智慧辦公室）。空間 ID 可先呼叫空間狀態取得。
- 空間類型：`discussion`、`study`、`seating`、`meeting`、`office`。
- 狀態：`available`、`occupied`、`maintenance`；維護中的空間可用席位為 0。
- 同一分鐘查詢的模擬資料相同，跨分鐘重新計算；查詢本身不寫入資料。
- 可用席位不代表可預約保證；使用中的會議室不提供剩餘席位。
- 離線感測器的讀值與觀測時間是 `null`，不以 0 或新的時間假冒即時數據。
- 公告以台北午夜產生相對日期；有效區間是 `startsAt <= now < endsAt`。
- 示範資料對所有租戶相同，只含虛構場域，沒有個人資料。不能把此策略沿用到正式租戶資料。

## 之後串真實 API

實作 `src/data.ts` 的 `RealtimeSource.snapshot({ caller, now })`，再注入：

```ts
const app = createSpaceMeDemoApp({ verifier, source: realSpaceMeSource });
```

API adapter 必須使用**驗證過的 `caller.tenantId`**做租戶隔離；工具不接受使用者指定的租戶 ID。
請回傳 `source: 'api'` 與真正的觀測時間，保留離線或過期資料的狀態，不能把查詢時間當成觀測時間。
adapter 應設置 API 逾時並驗證回傳資料；來源失敗會回傳工具錯誤，不回退成示範資料。

## 驗證

```bash
npm run typecheck -w mcp/space-me-demo
npm test -w mcp/space-me-demo
```

測試包含模擬更新、席位統計、組合篩選、離線讀值、公告生效與截止邊界、資料來源替換、JWT 驗證及實際 HTTP 的工具列出與呼叫。
