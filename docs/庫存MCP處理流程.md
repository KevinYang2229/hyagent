# 庫存 MCP 處理流程

若 Markdown 預覽未顯示 Mermaid，可直接開啟獨立圖片：[處理流程圖](庫存MCP處理流程圖.svg)、[Client / Server 互動時序圖](庫存MCP互動時序圖.svg)。

依現有 `store-demo` 實作，呈現庫存查詢及使用者選擇補貨後的處理流程。HyAgent 後端內的 MCP Client 負責取得工具清單、發送工具呼叫及接收結果；庫存 MCP Server 負責提供工具、驗證呼叫身分及執行庫存業務。庫存查詢為唯讀，不需操作確認；建立補貨單須先確認。

## 庫存查詢與補貨處理流程圖

```mermaid
flowchart TD
    A[使用者詢問庫存或即期品] --> B{HyAgent 檢查租戶可見性與服務權限}
    B -->|未通過| X[拒絕使用並告知原因]
    B -->|通過| C[智慧代理辨識需求並整理查詢條件]
    C --> D[MCP Client 呼叫 inventory_query]
    D --> E[庫存 MCP Server 驗證身分並查詢庫存]
    E -->|成功| F[經 MCP Client 回傳結果，由 HyAgent 顯示庫存表格]
    E -->|失敗| Y[回報查詢失敗並記錄工具稽核]
    F --> G{使用者是否要求補貨}
    G -->|否| H[完成查詢]
    G -->|是| I[HyAgent 呈現可編輯補貨確認卡片]
    I --> J{使用者確認送出}
    J -->|取消| K[不執行補貨]
    J -->|確認| L[HyAgent 驗證權限與參數，經 MCP Client 呼叫 replenishment_create]
    L --> M[庫存 MCP Server 驗證身分與規則並建立補貨單]
    M -->|成功| N[經 MCP Client 回傳結果並記錄工具稽核]
    M -->|失敗| O[回報補貨失敗並記錄工具稽核]
```

## MCP Client 與 MCP Server 互動時序圖

```mermaid
sequenceDiagram
    actor U as 使用者
    participant H as HyAgent 智慧代理／權限與確認
    participant C as MCP Client（HyAgent 後端內）
    participant S as 庫存 MCP Server（store-demo）
    participant D as 庫存資料／補貨單

    Note over H,S: 準備階段：登記服務端點，設定租戶可見性與服務授權
    H->>C: 準備可用的 MCP 工具
    C->>S: tools/list（Streamable HTTP＋簽章 JWT）
    S->>S: 驗證 HyAgent 簽章身分
    S-->>C: 工具名稱、輸入規格與讀寫標記
    C-->>H: 提供授權範圍內的工具
    Note over C,S: 工具清單可快取，不需每次查詢重新取得

    U->>H: 詢問商品庫存或即期品
    H->>H: 檢查權限，辨識需求並整理參數
    alt 權限不足
        H-->>U: 拒絕使用並告知原因
    else 權限通過
        H->>C: 執行 inventory_query
        C->>S: tools/call（工具名稱、參數、簽章 JWT）
        S->>S: 驗證身分並處理查詢條件
        S->>D: 查詢庫存與到期資訊
        D-->>S: 庫存、建議補貨與到期資料
        S-->>C: 結構化結果與表格顯示資訊
        C-->>H: 傳回工具結果
        H-->>U: 顯示庫存表格與說明，記錄工具稽核

        opt 使用者要求補貨
            U->>H: 要求建立補貨單
            H-->>U: 顯示確認卡片，可修改品項、數量與日期
            alt 使用者取消
                U->>H: 取消
                H-->>U: 不執行補貨
            else 使用者確認
                U->>H: 確認送出
                H->>H: 重新驗證權限與確認後的參數
                H->>C: 執行 replenishment_create
                C->>S: tools/call（工具名稱、參數、簽章 JWT）
                S->>S: 驗證身分與補貨業務規則
                S->>D: 建立補貨單
                D-->>S: 補貨單結果
                S-->>C: 回傳工具結果
                C-->>H: 傳回補貨單結果
                H-->>U: 顯示結果，記錄工具稽核
            end
        end
    end
    Note over H,S: 工具失敗或服務逾時時，HyAgent 回報原因並記錄工具稽核
```

HyAgent 每次 MCP HTTP 請求以短效 ES256 JWT 傳遞租戶、使用者與權限；使用者須具 `service:agent` 與 `mcp:store-demo` 權限。庫存查詢也納入工具稽核。

圖中的 MCP Client 是 HyAgent 後端模組，MCP Server 是獨立提供庫存工具的服務；瀏覽器與 AI 模型不直接連線至 MCP Server。資料節點表示服務端使用的業務資料，現有 Demo 並未串接正式庫存資料庫。

目前 `store-demo` 使用示範資料，補貨單儲存於記憶體，重啟後不保留；正式導入須串接企業庫存系統與持久化儲存。建立補貨單不代表已完成採購、到貨或庫存更新。
