# @hyagent/store-demo

門市 Demo 用的自建 MCP 服務（假資料）：

| 工具 | 讀寫 | 說明 |
|---|---|---|
| `product_lookup` | 讀 | 商品名稱模糊比對（影像辨識補齊商品編號用） |
| `inventory_query` | 讀 | 庫存、建議補貨、到期日、是否即期（表格顯示） |
| `replenishment_create` | 寫 | 建立補貨單（確認卡片可勾選品項、改數量、選日期） |
| `promotion_list` | 讀 | 進行中的促銷活動（表格顯示） |
| `coupon_check` | 讀 | 依券號查優惠券狀態（表格顯示） |

資料在 `data/`，日期以「距今天幾天」儲存，執行時換算（台北時區），任何一天 Demo 都有即期品與有效券。
補貨單存在記憶體，重啟清空。商品圖片放在 `assets/`（見該資料夾說明）。

## 執行

```bash
HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json \
MCP_SERVER_ID=store-demo PUBLIC_BASE_URL=http://localhost:4200 PORT=4200 npm start -w mcp/store-demo
```

在 HyAgent 後台「MCP 服務」登記 `serverId=store-demo`、URL `http://localhost:4200/mcp`，
並在租戶權限分頁把 `mcp:store-demo` 指派給門市人員所在部門或帳號（另需 `service:agent`）。
