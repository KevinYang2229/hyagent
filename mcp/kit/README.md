# @hyagent/mcp-kit

自建 MCP server 讓 HyAgent 的智慧代理呼叫時使用。提供：

- `createHyAgentVerifier`：驗 HyAgent 每請求簽發的 ES256 JWT（JWKS 取自 HyAgent 後端）。
- `createMcpHttpApp`：無狀態 Streamable HTTP app，已掛好驗證；工具 handler 用 `callerFrom(extra)` 取得呼叫者（`tenantId`、`userId`、`scopes`）。

## 寫一個工具的規範

1. **每個欄位都要 `.describe('...')`**：會成為 HyAgent 確認卡片的欄位標籤。
2. **唯讀工具標 `annotations: { readOnlyHint: true }`**；沒標的一律被 HyAgent 視為寫入，使用者確認後才會執行。
3. **回傳直接回答問題**：例如回「某時段是否有空」，不要丟整張表讓模型推論（模型會讀錯）。
4. **失敗回 `isError: true`** 並在文字裡說明原因，HyAgent 會讓 AI 如實轉述。
5. **用 `callerFrom(extra)` 做二次權限檢查與稽核**：知道是誰、替哪個租戶操作。

## 範例

```bash
HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json \
MCP_SERVER_ID=rooms PORT=4100 npm run example:rooms -w mcp/kit
```

在 HyAgent 後台「MCP 服務」登記 `serverId=rooms`、URL `http://localhost:4100/mcp`，並把 `mcp:rooms` 授予要使用的部門或帳號。
