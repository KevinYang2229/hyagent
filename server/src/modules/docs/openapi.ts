/**
 * OpenAPI 規格（curated）：涵蓋對外整合面的主要端點與三種認證機制。
 * 由 swagger-ui-express 在 /api/docs 提供互動式文件。
 *
 * 三種認證維度：
 *   - apiKeyAuth（x-api-key）：租戶公開/秘密金鑰，解析租戶、資料隔離。
 *   - bearerAuth（JWT）：終端使用者身分（登入或 SSO 換發後取得）。
 *   - adminKey（x-admin-key）：管理 API。
 */
export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "HyAgent API",
    version: "1.2.0",
    description:
      "對話式表單填寫 Agent 的整合 API（多租戶）。嵌入 widget、SDK、webhook 共用此 API。",
  },
  servers: [{ url: "/", description: "同源" }],
  components: {
    securitySchemes: {
      apiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "租戶金鑰 pk_/sk_",
      },
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      adminKey: { type: "apiKey", in: "header", name: "x-admin-key" },
    },
    schemas: {
      Turn: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: {
            type: "string",
            enum: [
              "collecting",
              "confirming",
              "submitting",
              "submitted",
              "cancelled",
              "failed",
            ],
          },
          values: { type: "object", additionalProperties: true },
          reply: { type: "string", nullable: true },
          suggestions: { type: "array", items: { type: "string" } },
        },
      },
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
  },
  security: [{ apiKeyAuth: [], bearerAuth: [] }],
  paths: {
    "/api/auth/login": {
      post: {
        tags: ["auth"],
        summary: "帳密登入 → access/refresh token",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["username", "password"],
                properties: {
                  username: { type: "string" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "OK" },
          "401": { description: "帳密錯誤" },
        },
      },
    },
    "/api/auth/sso/exchange": {
      post: {
        tags: ["auth"],
        summary: "SSO handoff：宿主 user token → 本系統 token",
        security: [{ apiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["userToken"],
                properties: { userToken: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": { description: "OK" },
          "401": { description: "token 無效" },
          "403": { description: "租戶未啟用 SSO" },
        },
      },
    },
    "/api/skills": {
      get: {
        tags: ["Skills"],
        summary: "查詢登入者的角色角色與有效 Agent Skill",
        description: "依 JWT 與租戶解析身分，忽略使用者篩選參數；沿用既有 Scope Policy。回應禁止快取，不授予新權限。",
        responses: {
          "200": { description: "data.roles 為本人獲指派的角色摘要；data.skills 為可用能力的 id、label、description。" },
          "401": { description: "未登入或租戶身分不符" },
        },
      },
    },
    "/api/knowledge/suggested-prompts": {
      get: {
        tags: ["Knowledge"],
        summary: "登入者視角的知識庫開場資料（開關與推薦問句）",
        description:
          "開關判準與對話守門同一套（serviceRegistry.enabledFor），涵蓋租戶層、部門零散授權、部門角色能力與帳號層；免登入的 /api/widget/config 只能用訪客部門判定，故登入後改讀此端點。推薦句本身仍為訪客可見語料生成的公開集合，不因登入而擴增。回應禁止快取。",
        responses: {
          "200": { description: "data: { knowledgeEnabled, suggestedPrompts }；未啟用時 suggestedPrompts 為空陣列" },
          "401": { description: "未登入或租戶身分不符" },
        },
      },
    },
    "/api/tasks": {
      get: {
        tags: ["tasks"],
        summary: "我的任務：未完成表單、已送申請與未過期報告",
        description: "依驗證過的使用者與租戶篩選，僅回清單 metadata；不觸發 LLM，月配額耗盡仍可查閱。",
        responses: {
          "200": { description: "data: { drafts, submissions, reports }；各分類依時間由新到舊排列" },
          "401": { description: "未認證或 SSO token 租戶不符" },
        },
      },
    },
    "/api/tasks/{id}": {
      get: {
        tags: ["tasks"], summary: "還原本人的表單任務（回傳同對話狀態，無 LLM 逐字稿）",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "data: { id, formId, status, values, submission? }" },
          "401": { description: "未認證或租戶不符" },
          "403": { description: "表單已無使用權限" },
          "404": { description: "不存在或非本人" },
        },
      },
    },
    "/api/tasks/{id}/cancel": {
      post: {
        tags: ["tasks"], summary: "取消本人的未完成表單",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "已取消，暫存附件已清除" },
          "401": { description: "未認證或租戶不符" },
          "403": { description: "表單已無使用權限" },
          "404": { description: "不存在或非本人" },
          "409": { description: "已送出、送出中或已取消，無法取消" },
        },
      },
    },
    "/api/conversations": {
      post: {
        tags: ["conversations"],
        summary: "建立對話（可帶首輪訊息）",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  formId: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "OK",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Turn" },
              },
            },
          },
          "401": { description: "未認證" },
        },
      },
    },
    "/api/conversations/{id}": {
      get: {
        tags: ["conversations"],
        summary: "取對話狀態",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "OK" },
          "404": { description: "不存在或跨租戶" },
        },
      },
    },
    "/api/conversations/{id}/messages": {
      post: {
        tags: ["conversations"],
        summary: "送一則訊息",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message"],
                properties: { message: { type: "string" } },
              },
            },
          },
        },
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/conversations/{id}/submit": {
      post: {
        tags: ["conversations"],
        summary: "確認送出",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "OK" },
          "422": { description: "欄位未完成" },
        },
      },
    },
    "/api/conversations/{id}/actions/{actionId}/confirm": {
      post: {
        tags: ["conversations"],
        summary: "確認執行待確認的寫入動作（不經 LLM）",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "actionId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "已執行（data.actionOk 表示成功與否）" },
          "403": { description: "權限已撤銷" },
          "409": { description: "ACTION_NOT_FOUND 或 ACTION_EXPIRED" },
        },
      },
    },
    "/api/conversations/{id}/actions/{actionId}/cancel": {
      post: {
        tags: ["conversations"],
        summary: "取消待確認的寫入動作",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "actionId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "已取消" },
          "409": { description: "ACTION_NOT_FOUND" },
        },
      },
    },
    "/api/forms": {
      get: {
        tags: ["forms"],
        summary: "列出可辦理的表單",
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/forms/{formId}": {
      get: {
        tags: ["forms"],
        summary: "取表單定義",
        parameters: [
          {
            name: "formId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/admin/tenants": {
      post: {
        tags: ["admin"],
        summary: "建立租戶（回傳一把公開金鑰）",
        security: [{ adminKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  allowedOrigins: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: { "201": { description: "OK" } },
      },
      get: {
        tags: ["admin"],
        summary: "列出租戶",
        security: [{ adminKey: [] }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/admin/tenants/{id}/webhooks": {
      post: {
        tags: ["admin"],
        summary: "登記 webhook 端點",
        security: [{ adminKey: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url"],
                properties: {
                  url: { type: "string" },
                  secret: { type: "string" },
                  events: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: { "201": { description: "OK" } },
      },
      get: {
        tags: ["admin"],
        summary: "列出 webhook 端點",
        security: [{ adminKey: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/admin/tenants/{id}/usage": {
      get: {
        tags: ["admin"],
        summary: "查租戶用量",
        security: [{ adminKey: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
  },
} as const;
