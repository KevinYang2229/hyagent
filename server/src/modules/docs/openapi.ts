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
    title: "OA Agent API",
    version: "1.0.0",
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
                required: ["userId", "password"],
                properties: {
                  userId: { type: "string" },
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
                  ssoSecret: { type: "string" },
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
