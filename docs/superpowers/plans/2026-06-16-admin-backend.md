# 管理後台（Admin Backend）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 oa-agent monorepo 新增獨立 `admin/` 管理後台（含密碼登入），讓管理者設定 widget 外觀（依租戶套用）、租戶、webhook。

**Architecture:** 後端 `server/` 擴充：密碼登入換發 admin JWT、`require-admin` 同時接受 `x-admin-key` 或 admin JWT、`Tenant.appearance` 欄位 + `PATCH /admin/tenants/:id` + 公開 `GET /widget/config` + webhook 啟用停用。前端新增 `admin/` workspace（Vite+React+TS+react-router-dom），沿用 `@oa-agent/ui`、`@oa-agent/shared`，所有資料經既有 `/api/v1/admin/*` REST。widget `client/` 讀 `/widget/config` 套用外觀。

**Tech Stack:** TypeScript、Express、Zod、jsonwebtoken、Vite、React 18、react-router-dom v6、Tailwind v4。後端測試沿用 repo 既有 smoke-script 模式（`tsx scripts/*-smoke.ts`，以 `check()` 斷言）；前端沿用 `npm run typecheck` + 手動執行驗證（repo 無前端測試框架）。

---

## File Structure

**server/（擴充）**

- Modify `server/src/config/env.ts` — 新增 `ADMIN_PASSWORD`
- Modify `server/src/utils/jwt.ts` — 新增 `signAdminToken()`
- Modify `server/src/middlewares/require-admin.ts` — 接受 admin Bearer JWT
- Create `server/src/modules/admin/admin.auth.controller.ts` — 密碼登入
- Modify `server/src/modules/admin/admin.routes.ts` — 掛 `/auth/login`（公開）、`PATCH /tenants/:id`、webhook PATCH
- Modify `server/src/modules/admin/admin.schema.ts` — 新增 login / patchTenant / toggleWebhook schema
- Modify `server/src/modules/admin/admin.controller.ts` — `updateTenant`、`setWebhookEnabled`
- Modify `server/src/modules/tenant/tenant.store.ts` — `updateTenant()`
- Modify `server/src/modules/webhook/webhook.store.ts` — `setDisabled()`
- Create `server/src/modules/widget/widget.controller.ts`、`widget.routes.ts` — 公開外觀讀取
- Modify `server/src/app.ts` — 掛 widget router
- Create `server/scripts/admin-smoke.ts` — 後端 smoke 測試
- Modify `shared/src/index.ts` — `TenantAppearance` 型別
- Modify `server/src/modules/tenant/tenant.types.ts` — `Tenant.appearance`

**client/（小幅，讓外觀生效 + 預覽可用）**

- Modify `client/src/embedConfig.ts`、`client/src/App.tsx` — 讀 `/widget/config` 並套用

**admin/（新 workspace）**

- `admin/package.json`、`vite.config.ts`、`tsconfig.json`、`tsconfig.node.json`、`index.html`、`.env` proxy
- `admin/src/main.tsx`、`App.tsx`（router）、`index.css`
- `admin/src/api.ts`（REST client）、`auth.tsx`（token + guard）
- `admin/src/pages/LoginPage.tsx`、`TenantsPage.tsx`、`TenantDetailPage.tsx`
- `admin/src/pages/tabs/AppearanceTab.tsx`、`SettingsTab.tsx`、`WebhookTab.tsx`、`UsageTab.tsx`
- Modify root `package.json` — workspaces 加 `admin`、scripts 加 `dev:admin`

---

## Task 1: `TenantAppearance` 型別與 `Tenant.appearance`

**Files:**

- Modify: `shared/src/index.ts`（檔尾新增）
- Modify: `server/src/modules/tenant/tenant.types.ts`

- [ ] **Step 1: 在 shared 新增型別**

在 `shared/src/index.ts` 檔案最後新增：

```ts
// ---- 租戶 widget 外觀（admin 後台設定、widget 端套用）----
export interface TenantAppearance {
  /** 主色（hex，如 #0057ff）；未設用 widget 內建預設 */
  primaryColor?: string;
  /** 外觀模式 */
  theme?: "light" | "dark";
  /** 啟動按鈕位置：右下 / 左下 */
  position?: "br" | "bl";
  /** 自訂 logo 圖片 URL */
  logoUrl?: string;
  /** 對話開場歡迎語 */
  welcomeMessage?: string;
  /** 預設介面語言（如 zh-Hant） */
  defaultLocale?: string;
}
```

- [ ] **Step 2: Tenant 型別加 appearance**

在 `server/src/modules/tenant/tenant.types.ts` 檔頂 import 區加入，並於 `Tenant` interface 內 `createdAt` 之前新增欄位：

```ts
import type { TenantAppearance } from "@oa-agent/shared";
```

```ts
  /** widget 外觀設定（admin 後台維護）；未設則 widget 用內建預設 */
  appearance?: TenantAppearance;
```

- [ ] **Step 3: 驗證型別正確**

Run: `npm run typecheck -w server`
Expected: 無錯誤（PASS）

- [ ] **Step 4: Commit**

```bash
git add shared/src/index.ts server/src/modules/tenant/tenant.types.ts
git commit -m "feat(tenant): 新增 TenantAppearance 型別與 Tenant.appearance 欄位"
```

---

## Task 2: `tenantStore.updateTenant()`

**Files:**

- Modify: `server/src/modules/tenant/tenant.store.ts`

- [ ] **Step 1: 在 tenantStore 物件內新增 updateTenant**

在 `server/src/modules/tenant/tenant.store.ts` 的 `export const tenantStore = {` 物件內，`createApiKey` 之後新增方法：

```ts
  /** 部分更新租戶（admin 後台用）；回 undefined 代表查無此租戶 */
  updateTenant(
    id: string,
    patch: Partial<Pick<Tenant, 'name' | 'allowedOrigins' | 'ssoSecret' | 'appearance'>>,
  ): Tenant | undefined {
    const tenant = tenants.get(id);
    if (!tenant) return undefined;
    const next: Tenant = {
      ...tenant,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.allowedOrigins !== undefined ? { allowedOrigins: patch.allowedOrigins } : {}),
      ...(patch.ssoSecret !== undefined ? { ssoSecret: patch.ssoSecret } : {}),
      ...(patch.appearance !== undefined
        ? { appearance: { ...tenant.appearance, ...patch.appearance } }
        : {}),
    };
    tenants.set(id, next);
    persist();
    return next;
  },
```

- [ ] **Step 2: 驗證型別**

Run: `npm run typecheck -w server`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/tenant/tenant.store.ts
git commit -m "feat(tenant): tenantStore 新增 updateTenant 部分更新"
```

---

## Task 3: `webhookStore.setDisabled()`

**Files:**

- Modify: `server/src/modules/webhook/webhook.store.ts`

- [ ] **Step 1: 在 webhookStore 物件內新增 setDisabled**

在 `server/src/modules/webhook/webhook.store.ts` 的 `webhookStore` 物件內 `remove` 之後新增：

```ts
  /** 啟用/停用端點：disabled=true 設 disabledAt，false 清除。回 undefined＝查無或不屬此租戶 */
  setDisabled(tenantId: string, id: string, disabled: boolean): WebhookEndpoint | undefined {
    const e = endpoints.get(id);
    if (!e || e.tenantId !== tenantId) return undefined;
    const next: WebhookEndpoint = { ...e };
    if (disabled) next.disabledAt = new Date().toISOString();
    else delete next.disabledAt;
    endpoints.set(id, next);
    persist();
    return next;
  },
```

- [ ] **Step 2: 驗證型別**

Run: `npm run typecheck -w server`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/webhook/webhook.store.ts
git commit -m "feat(webhook): webhookStore 新增 setDisabled 啟用停用"
```

---

## Task 4: `ADMIN_PASSWORD` env + `signAdminToken()`

**Files:**

- Modify: `server/src/config/env.ts:?`（`ADMIN_API_KEY` 那行之後）
- Modify: `server/src/utils/jwt.ts`
- Modify: `server/.env.example`

- [ ] **Step 1: env 新增 ADMIN_PASSWORD**

在 `server/src/config/env.ts` 的 `ADMIN_API_KEY: z.string().default(''),` 之後新增：

```ts
  // 後台登入密碼（換發 admin JWT 用）；留空＝停用後台登入（回 403）。與 ADMIN_API_KEY 分開避免主控金鑰外洩瀏覽器。
  ADMIN_PASSWORD: z.string().default(''),
```

- [ ] **Step 2: jwt 新增 signAdminToken**

在 `server/src/utils/jwt.ts` 的 `signRefreshToken` 之後新增：

```ts
/** 後台管理 token：role=admin，效期較長（8h）。與一般 access token 同密鑰，由 role 區分。 */
export function signAdminToken(): string {
  return jwt.sign(
    { sub: "admin", role: "admin", via: "password" } satisfies JwtPayload,
    env.JWT_ACCESS_SECRET,
    {
      expiresIn: "8h",
    } as SignOptions,
  );
}
```

- [ ] **Step 3: .env.example 補說明**

在 `server/.env.example` 的 `ADMIN_API_KEY` 附近新增一行：

```
# 後台登入密碼；留空＝停用後台登入。建議 openssl rand -hex 24
ADMIN_PASSWORD=
```

- [ ] **Step 4: 驗證型別**

Run: `npm run typecheck -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/config/env.ts server/src/utils/jwt.ts server/.env.example
git commit -m "feat(admin): 新增 ADMIN_PASSWORD 與 signAdminToken"
```

---

## Task 5: `require-admin` 接受 admin Bearer JWT

**Files:**

- Modify: `server/src/middlewares/require-admin.ts`

- [ ] **Step 1: 改寫 requireAdmin（雙模式）**

將 `server/src/middlewares/require-admin.ts` 整檔替換為：

```ts
/**
 * requireAdmin：保護管理 API。通過條件為以下任一：
 *   1. x-admin-key header 等於 env.ADMIN_API_KEY（機器對機器，向後相容）
 *   2. Authorization: Bearer <admin JWT>（role=admin，後台登入換發）
 *
 * 安全預設：ADMIN_API_KEY 與 ADMIN_PASSWORD 都未設時，管理 API 一律 403（停用）。
 */
import type { NextFunction, Request, Response } from "express";
import { env } from "@/config/env";
import { AppError } from "@/utils/app-error";
import { verifyAccessToken } from "@/utils/jwt";

export function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!env.ADMIN_API_KEY && !env.ADMIN_PASSWORD) {
    throw AppError.forbidden(
      "管理 API 未啟用（未設定 ADMIN_API_KEY / ADMIN_PASSWORD）",
    );
  }

  // 模式 1：x-admin-key
  const key = req.header("x-admin-key");
  if (key && env.ADMIN_API_KEY && key === env.ADMIN_API_KEY) {
    next();
    return;
  }

  // 模式 2：admin Bearer JWT
  const auth = req.header("authorization") ?? "";
  const [scheme, token] = auth.split(" ");
  if (scheme === "Bearer" && token) {
    try {
      const payload = verifyAccessToken(token);
      if (payload.role === "admin") {
        next();
        return;
      }
    } catch {
      // 落到下方統一拒絕
    }
  }

  throw AppError.unauthorized("需要有效的管理金鑰或登入");
}
```

- [ ] **Step 2: 驗證型別**

Run: `npm run typecheck -w server`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/src/middlewares/require-admin.ts
git commit -m "feat(admin): require-admin 同時接受 x-admin-key 或 admin JWT"
```

---

## Task 6: 後台登入端點 `POST /admin/auth/login`

**Files:**

- Modify: `server/src/modules/admin/admin.schema.ts`
- Create: `server/src/modules/admin/admin.auth.controller.ts`
- Modify: `server/src/modules/admin/admin.routes.ts`

- [ ] **Step 1: schema 新增 adminLoginSchema**

在 `server/src/modules/admin/admin.schema.ts` 的 import 之後（其他 schema 之間）新增，並於檔尾型別匯出區加上對應 type：

```ts
export const adminLoginSchema = z.object({
  password: z.string().min(1),
});
```

檔尾型別匯出區新增：

```ts
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
```

- [ ] **Step 2: 建立 auth controller**

Create `server/src/modules/admin/admin.auth.controller.ts`：

```ts
/**
 * 後台登入：以單一管理密碼換發 admin JWT。
 * 安全預設：ADMIN_PASSWORD 未設時停用（回 403），避免空密碼即可登入。
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "@/config/env";
import { AppError } from "@/utils/app-error";
import { signAdminToken } from "@/utils/jwt";
import type { AdminLoginInput } from "./admin.schema";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export const adminAuthController = {
  async login(req: Request, res: Response): Promise<void> {
    if (!env.ADMIN_PASSWORD) {
      throw AppError.forbidden("後台登入未啟用（未設定 ADMIN_PASSWORD）");
    }
    const { password } = req.body as AdminLoginInput;
    if (!safeEqual(password, env.ADMIN_PASSWORD)) {
      throw AppError.unauthorized("密碼錯誤");
    }
    res.status(200).json({ data: { token: signAdminToken() } });
  },
};
```

- [ ] **Step 3: 路由掛載（login 在 requireAdmin 之前 = 公開）**

在 `server/src/modules/admin/admin.routes.ts`，於 `const router = Router();` 之後、`router.use(requireAdmin);` **之前**插入：

```ts
import { adminAuthController } from "./admin.auth.controller";
import { adminLoginSchema } from "./admin.schema";
```

並在 `router.use(requireAdmin);` 之前加：

```ts
// 公開：後台登入（在 requireAdmin 之前註冊，故不受其保護）
router.post(
  "/auth/login",
  validate({ body: adminLoginSchema }),
  asyncHandler(adminAuthController.login),
);
```

（`validate`、`asyncHandler` 已在該檔 import。）

- [ ] **Step 4: 驗證型別**

Run: `npm run typecheck -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/admin/admin.schema.ts server/src/modules/admin/admin.auth.controller.ts server/src/modules/admin/admin.routes.ts
git commit -m "feat(admin): 新增後台密碼登入端點 POST /admin/auth/login"
```

---

## Task 7: `PATCH /admin/tenants/:id`

**Files:**

- Modify: `server/src/modules/admin/admin.schema.ts`
- Modify: `server/src/modules/admin/admin.controller.ts`
- Modify: `server/src/modules/admin/admin.routes.ts`

- [ ] **Step 1: schema 新增 patchTenantSchema**

在 `server/src/modules/admin/admin.schema.ts` 新增（`createTenantSchema` 之後）：

```ts
export const appearanceSchema = z.object({
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  theme: z.enum(["light", "dark"]).optional(),
  position: z.enum(["br", "bl"]).optional(),
  logoUrl: z.string().url().optional().or(z.literal("")),
  welcomeMessage: z.string().max(200).optional(),
  defaultLocale: z.string().max(20).optional(),
});

export const patchTenantSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    allowedOrigins: z.array(z.string().trim().min(1)).optional(),
    ssoSecret: z.string().min(16).optional(),
    appearance: appearanceSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "至少需提供一個欄位" });
```

檔尾型別匯出區新增：

```ts
export type PatchTenantInput = z.infer<typeof patchTenantSchema>;
```

- [ ] **Step 2: controller 新增 updateTenant**

在 `server/src/modules/admin/admin.controller.ts` 的 `adminController` 物件內 `listTenants` 之後新增：

```ts
  async updateTenant(req: Request, res: Response): Promise<void> {
    ensureTenant(String(req.params.id));
    const patch = req.body as PatchTenantInput;
    const updated = tenantStore.updateTenant(String(req.params.id), patch);
    res.status(200).json({ data: updated });
  },
```

並在該檔頂 import 加上型別：

```ts
import type {
  CreateKeyInput,
  CreateTenantInput,
  CreateWebhookInput,
  PatchTenantInput,
} from "./admin.schema";
```

（取代原本只有三型別的那行 import。）

- [ ] **Step 3: 路由掛載**

在 `server/src/modules/admin/admin.routes.ts` 的 import 區把 `patchTenantSchema` 加進既有 `./admin.schema` 的 import 清單，並在 `router.get('/tenants', ...)` 之後新增：

```ts
router.patch(
  "/tenants/:id",
  validate({ params: tenantParamSchema, body: patchTenantSchema }),
  asyncHandler(adminController.updateTenant),
);
```

- [ ] **Step 4: 驗證型別**

Run: `npm run typecheck -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/admin/admin.schema.ts server/src/modules/admin/admin.controller.ts server/src/modules/admin/admin.routes.ts
git commit -m "feat(admin): 新增 PATCH /admin/tenants/:id 更新租戶與外觀"
```

---

## Task 8: Webhook 啟用停用端點 `PATCH …/webhooks/:webhookId`

**Files:**

- Modify: `server/src/modules/admin/admin.schema.ts`
- Modify: `server/src/modules/admin/admin.controller.ts`
- Modify: `server/src/modules/admin/admin.routes.ts`

- [ ] **Step 1: schema 新增 toggleWebhookSchema**

在 `server/src/modules/admin/admin.schema.ts` 新增（`createWebhookSchema` 之後）：

```ts
export const toggleWebhookSchema = z.object({
  disabled: z.boolean(),
});
```

檔尾型別匯出區新增：

```ts
export type ToggleWebhookInput = z.infer<typeof toggleWebhookSchema>;
```

- [ ] **Step 2: controller 新增 setWebhookEnabled**

在 `server/src/modules/admin/admin.controller.ts` 的 `deleteWebhook` 之後新增：

```ts
  async setWebhookEnabled(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const { disabled } = req.body as ToggleWebhookInput;
    const updated = webhookStore.setDisabled(tenant.id, String(req.params.webhookId), disabled);
    if (!updated) throw AppError.notFound('Webhook 不存在');
    res.status(200).json({ data: updated });
  },
```

並把 `ToggleWebhookInput` 加進該檔頂 `./admin.schema` 的型別 import 清單。

- [ ] **Step 3: 路由掛載**

在 `server/src/modules/admin/admin.routes.ts` 把 `toggleWebhookSchema` 加進 `./admin.schema` import，並在 `router.delete('/tenants/:id/webhooks/:webhookId', ...)` 之後新增：

```ts
router.patch(
  "/tenants/:id/webhooks/:webhookId",
  validate({ params: webhookParamSchema, body: toggleWebhookSchema }),
  asyncHandler(adminController.setWebhookEnabled),
);
```

- [ ] **Step 4: 驗證型別**

Run: `npm run typecheck -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/admin/admin.schema.ts server/src/modules/admin/admin.controller.ts server/src/modules/admin/admin.routes.ts
git commit -m "feat(admin): 新增 webhook 啟用停用端點"
```

---

## Task 9: 公開外觀讀取端點 `GET /api/v1/widget/config`

**Files:**

- Create: `server/src/modules/widget/widget.controller.ts`
- Create: `server/src/modules/widget/widget.routes.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: controller**

Create `server/src/modules/widget/widget.controller.ts`：

```ts
/**
 * 公開 widget 設定：依 resolveTenant 解出的租戶回外觀。
 * widget iframe 載入時讀取（帶 ?key=pk_…）；未設外觀則回內建預設。
 */
import type { Request, Response } from "express";
import type { TenantAppearance } from "@oa-agent/shared";

const DEFAULT_APPEARANCE: Required<
  Pick<TenantAppearance, "theme" | "position">
> = {
  theme: "light",
  position: "br",
};

export const widgetController = {
  async getConfig(req: Request, res: Response): Promise<void> {
    const appearance: TenantAppearance = {
      ...DEFAULT_APPEARANCE,
      ...(req.tenant?.appearance ?? {}),
    };
    res.status(200).json({ data: { appearance } });
  },
};
```

- [ ] **Step 2: routes**

Create `server/src/modules/widget/widget.routes.ts`：

```ts
import { Router } from "express";
import { asyncHandler } from "@/utils/async-handler";
import { widgetController } from "./widget.controller";

const router = Router();

// 公開（不需登入）；租戶由上游 resolveTenant 以 ?key=pk_ 解析
router.get("/config", asyncHandler(widgetController.getConfig));

export const widgetRouter = router;
```

- [ ] **Step 3: 掛載到 app（公開，需 resolveTenant 解租戶）**

在 `server/src/app.ts` 的 import 區（`adminRouter` import 附近）新增：

```ts
import { widgetRouter } from "@/modules/widget/widget.routes";
```

在 `app.use('/api/v1/admin', adminRouter);` 之前新增：

```ts
// 公開 widget 設定：resolveTenant 以 ?key=pk_ 解租戶，無 requireAuth（widget 載入即可讀外觀）
app.use("/api/v1/widget", resolveTenant, widgetRouter);
```

- [ ] **Step 4: 驗證型別**

Run: `npm run typecheck -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/widget/ server/src/app.ts
git commit -m "feat(widget): 新增公開外觀讀取端點 GET /api/v1/widget/config"
```

---

## Task 10: 後端 smoke 測試（auth / patch / widget / webhook）

**Files:**

- Create: `server/scripts/admin-smoke.ts`

此測試用 supertest（已是 devDep）直接打 Express app，不需起 server / API key。

- [ ] **Step 1: 寫測試腳本（先寫、預期會失敗或部分通過）**

Create `server/scripts/admin-smoke.ts`：

```ts
/* 後台 API smoke：登入、PATCH 租戶外觀、公開 widget config、webhook 啟用停用。
   執行：ADMIN_PASSWORD=test1234 ANTHROPIC_API_KEY=x npx tsx scripts/admin-smoke.ts */
import request from "supertest";
import { createApp } from "../src/app";

const app = createApp();
let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures += 1;
}

async function main() {
  // 1. 登入：錯誤密碼 401
  const bad = await request(app)
    .post("/api/v1/admin/auth/login")
    .send({ password: "wrong" });
  check("錯誤密碼回 401", bad.status === 401);

  // 2. 登入：正確密碼回 token
  const ok = await request(app)
    .post("/api/v1/admin/auth/login")
    .send({ password: "test1234" });
  check("正確密碼回 200", ok.status === 200);
  const token: string = ok.body?.data?.token ?? "";
  check("回傳 admin token", token.length > 0);
  const bearer = `Bearer ${token}`;

  // 3. 用 admin JWT 列租戶（驗證 require-admin 接受 JWT）
  const list = await request(app)
    .get("/api/v1/admin/tenants")
    .set("authorization", bearer);
  check("JWT 可列租戶", list.status === 200 && Array.isArray(list.body?.data));

  // 4. 建租戶
  const created = await request(app)
    .post("/api/v1/admin/tenants")
    .set("authorization", bearer)
    .send({ name: "SmokeCo", allowedOrigins: ["https://smoke.test"] });
  check("建租戶 201", created.status === 201);
  const tenantId: string = created.body?.data?.tenant?.id ?? "";
  const pk: string = created.body?.data?.publishableKey ?? "";

  // 5. PATCH 外觀
  const patched = await request(app)
    .patch(`/api/v1/admin/tenants/${tenantId}`)
    .set("authorization", bearer)
    .send({ appearance: { primaryColor: "#0057ff", theme: "dark" } });
  check("PATCH 外觀 200", patched.status === 200);
  check(
    "外觀已寫入",
    patched.body?.data?.appearance?.primaryColor === "#0057ff",
  );

  // 6. 公開 widget config 讀回外觀（帶 pk）
  const cfg = await request(app).get(`/api/v1/widget/config?key=${pk}`);
  check("widget config 200", cfg.status === 200);
  check("config 回 dark theme", cfg.body?.data?.appearance?.theme === "dark");

  // 7. webhook 建立 + 停用
  const wh = await request(app)
    .post(`/api/v1/admin/tenants/${tenantId}/webhooks`)
    .set("authorization", bearer)
    .send({ url: "https://smoke.test/hook" });
  check("建 webhook 201", wh.status === 201);
  const whId: string = wh.body?.data?.id ?? "";
  const toggled = await request(app)
    .patch(`/api/v1/admin/tenants/${tenantId}/webhooks/${whId}`)
    .set("authorization", bearer)
    .send({ disabled: true });
  check(
    "停用 webhook 200",
    toggled.status === 200 && !!toggled.body?.data?.disabledAt,
  );

  console.log(
    failures === 0 ? "\nADMIN SMOKE PASS" : `\nADMIN SMOKE FAIL (${failures})`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: 確認 `createApp` 為具名匯出**

Run: `grep -n "createApp\|export" server/src/app.ts`
Expected: 看到 `export function createApp` 或 `export const createApp`。若 app.ts 匯出名稱不同（如 `export default`），把腳本第 3 行改成對應 import（例如 `import createApp from '../src/app';`）。

- [ ] **Step 3: 執行 smoke**

Run: `cd server && ADMIN_PASSWORD=test1234 ANTHROPIC_API_KEY=x npx tsx scripts/admin-smoke.ts`
Expected: 全部 `✓` 且結尾 `ADMIN SMOKE PASS`。若某項 `✗`，回到對應 Task 修正後重跑。

- [ ] **Step 4: Commit**

```bash
git add server/scripts/admin-smoke.ts
git commit -m "test(admin): 新增後台 API smoke 測試"
```

---

## Task 11: widget 端套用後端外觀

**Files:**

- Modify: `client/src/embedConfig.ts`
- Modify: `client/src/App.tsx`

讓 widget 載入時讀 `/api/v1/widget/config` 取得後端外觀，與 `data-*` 參數合併（優先序：data-\* > 後端 > 預設），最低限度套用 `theme` 與 `primaryColor`。這也讓 admin「外觀」分頁的即時預覽 iframe 會反映設定。

- [ ] **Step 1: embedConfig 新增 fetchAppearance**

在 `client/src/embedConfig.ts` 檔尾新增：

```ts
import type { TenantAppearance } from "@oa-agent/shared";

/**
 * 讀後端外觀（依 apiKey 對應租戶）。失敗或未帶 key 回 {}。
 * 與 data-* 合併由呼叫端處理：data-* 優先。
 */
export async function fetchAppearance(): Promise<TenantAppearance> {
  if (!embedConfig.apiKey) return {};
  try {
    const url = `/api/v1/widget/config?key=${encodeURIComponent(embedConfig.apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) return {};
    const json = (await res.json()) as {
      data?: { appearance?: TenantAppearance };
    };
    return json.data?.appearance ?? {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 2: App 套用主色與主題**

在 `client/src/App.tsx`：找到既有套用 `embedConfig.theme` / locale 的 effect（搜尋 `embedConfig`）。新增一個 effect 讀後端外觀並套用 `primaryColor`（寫入 CSS 變數 `--primary-color`，即 `ui/src/styles.css` 既有 token）與 `theme`（data-\* 未指定時才用後端值）：

```tsx
import { useEffect } from "react";
import { embedConfig, fetchAppearance } from "./embedConfig";

// ...在元件內：
useEffect(() => {
  let cancelled = false;
  void fetchAppearance().then((a) => {
    if (cancelled) return;
    if (a.primaryColor)
      document.documentElement.style.setProperty(
        "--primary-color",
        a.primaryColor,
      );
    const theme = embedConfig.theme ?? a.theme; // data-* 優先
    if (theme) document.documentElement.dataset.theme = theme;
  });
  return () => {
    cancelled = true;
  };
}, []);
```

> 注意：若 App.tsx 既有 theme 套用邏輯已用不同機制（如 class 而非 `dataset.theme`），改成與既有一致的方式套用 `theme`，但 `primaryColor` 一律寫 `--primary-color` CSS 變數。實作前先讀 App.tsx 既有 theme 處理，跟著它的慣例。

- [ ] **Step 3: 驗證型別**

Run: `npm run typecheck -w client`
Expected: PASS

- [ ] **Step 4: 手動驗證（外觀生效）**

Run（兩個終端）：`npm run dev:server`（帶 `ADMIN_PASSWORD=test1234`）、`npm run dev:client`
操作：用 Task 10 建立的租戶 pk，開 `http://localhost:5173/?embed=1&key=<pk>`，確認主色/主題反映後端 PATCH 的值。
Expected: 主色變為設定值。

- [ ] **Step 5: Commit**

```bash
git add client/src/embedConfig.ts client/src/App.tsx
git commit -m "feat(widget): 載入時讀後端外觀並套用主色與主題"
```

---

## Task 12: 建立 `admin/` workspace 骨架

**Files:**

- Create: `admin/package.json`、`admin/index.html`、`admin/vite.config.ts`、`admin/tsconfig.json`、`admin/tsconfig.node.json`
- Create: `admin/src/main.tsx`、`admin/src/App.tsx`、`admin/src/index.css`
- Modify: root `package.json`

- [ ] **Step 1: package.json**

Create `admin/package.json`：

```json
{
  "name": "oa-agent-admin",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@oa-agent/shared": "*",
    "@oa-agent/ui": "*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.13",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "tailwindcss": "^4.1.13",
    "typescript": "^5.6.3",
    "vite": "^5.4.11"
  }
}
```

- [ ] **Step 2: vite.config.ts（dev port 5174，proxy /api 到 3000）**

Create `admin/vite.config.ts`：

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: { exclude: ["@oa-agent/shared", "@oa-agent/ui"] },
  server: {
    port: 5174,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/healthz": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
```

- [ ] **Step 3: tsconfig（沿用 client 設定）**

Create `admin/tsconfig.json`（內容同 `client/tsconfig.json`）：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 4: index.html**

Create `admin/index.html`：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HyAgent 管理後台</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: index.css（沿用設計系統 token）**

Create `admin/src/index.css`：

```css
@import "tailwindcss";
@import "@oa-agent/ui/index.css";

body {
  margin: 0;
  font-family:
    system-ui,
    -apple-system,
    "Noto Sans TC",
    sans-serif;
}
```

- [ ] **Step 6: main.tsx + 暫時 App（佔位，下一個 task 換成 router）**

Create `admin/src/main.tsx`：

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Create `admin/src/App.tsx`（暫時佔位）：

```tsx
export default function App() {
  return <div style={{ padding: 24 }}>OA Agent 管理後台</div>;
}
```

- [ ] **Step 7: root package.json 加入 workspace 與 script**

在 root `package.json` 的 `"workspaces"` 陣列加入 `"admin"`（放在 `"client"` 之後）；在 `"scripts"` 加入：

```json
    "dev:admin": "npm run dev -w admin",
```

並把 `build` 改為：

```json
    "build": "npm run build -w server && npm run build -w client && npm run build -w admin",
```

`typecheck` 結尾加 `&& npm run typecheck -w admin`。

- [ ] **Step 8: 安裝相依並驗證**

Run: `npm install`
Run: `npm run typecheck -w admin`
Expected: PASS（佔位 App 應無型別錯誤）

- [ ] **Step 9: Commit**

```bash
git add admin/ package.json package-lock.json
git commit -m "feat(admin): 建立 admin 後台 workspace 骨架"
```

---

## Task 13: admin REST client 與 auth 守衛

**Files:**

- Create: `admin/src/api.ts`
- Create: `admin/src/auth.tsx`

- [ ] **Step 1: api.ts（統一掛 Bearer、處理 401）**

Create `admin/src/api.ts`：

```ts
import type { TenantAppearance } from "@oa-agent/shared";

const TOKEN_KEY = "oa-admin-token";

export const tokenStore = {
  get: (): string | null => sessionStorage.getItem(TOKEN_KEY),
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export interface Tenant {
  id: string;
  name: string;
  allowedOrigins: string[];
  ssoSecret?: string;
  appearance?: TenantAppearance;
  createdAt: string;
}
export interface ApiKey {
  key: string;
  tenantId: string;
  type: "publishable" | "secret";
  createdAt: string;
  revokedAt?: string;
}
export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  events?: string[];
  createdAt: string;
  disabledAt?: string;
}
export interface Usage {
  conversations: number;
  messages: number;
  submissions: number;
}

/** 401 時拋出，UI 攔截導回登入 */
export class UnauthorizedError extends Error {}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    tokenStore.clear();
    throw new UnauthorizedError("未授權");
  }
  const json = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json.data as T;
}

export const api = {
  login: (password: string) =>
    req<{ token: string }>("POST", "/admin/auth/login", { password }),

  listTenants: () => req<Tenant[]>("GET", "/admin/tenants"),
  createTenant: (input: {
    name: string;
    allowedOrigins?: string[];
    ssoSecret?: string;
  }) =>
    req<{ tenant: Tenant; publishableKey: string }>(
      "POST",
      "/admin/tenants",
      input,
    ),
  updateTenant: (
    id: string,
    patch: Partial<
      Pick<Tenant, "name" | "allowedOrigins" | "ssoSecret" | "appearance">
    >,
  ) => req<Tenant>("PATCH", `/admin/tenants/${id}`, patch),

  createKey: (id: string, type: "publishable" | "secret") =>
    req<ApiKey>("POST", `/admin/tenants/${id}/keys`, { type }),

  listWebhooks: (id: string) =>
    req<WebhookEndpoint[]>("GET", `/admin/tenants/${id}/webhooks`),
  createWebhook: (id: string, input: { url: string; secret?: string }) =>
    req<WebhookEndpoint>("POST", `/admin/tenants/${id}/webhooks`, input),
  toggleWebhook: (id: string, webhookId: string, disabled: boolean) =>
    req<WebhookEndpoint>(
      "PATCH",
      `/admin/tenants/${id}/webhooks/${webhookId}`,
      { disabled },
    ),
  deleteWebhook: (id: string, webhookId: string) =>
    req<{ id: string }>("DELETE", `/admin/tenants/${id}/webhooks/${webhookId}`),

  getUsage: (id: string) => req<Usage>("GET", `/admin/tenants/${id}/usage`),
};
```

> 注意：`createTenant` 後端目前回 `{ tenant, publishableKey }`，`listTenants` 回 `Tenant[]`，`getUsage` 回 usageStore 形狀。若 `Usage` 欄位名與 `usageStore.get()` 不同，以後端實際回傳為準調整介面（執行前 `grep -n "" server/src/modules/usage/usage.store.ts` 確認欄位）。

- [ ] **Step 2: auth.tsx（context + guard hook）**

Create `admin/src/auth.tsx`：

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, tokenStore } from "./api";

interface AuthCtx {
  authed: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean>(() => !!tokenStore.get());

  const login = useCallback(async (password: string) => {
    const { token } = await api.login(password);
    tokenStore.set(token);
    setAuthed(true);
  }, []);

  const logout = useCallback(() => {
    tokenStore.clear();
    setAuthed(false);
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({ authed, login, logout }),
    [authed, login, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth 必須在 AuthProvider 內使用");
  return v;
}
```

- [ ] **Step 3: 驗證型別**

Run: `npm run typecheck -w admin`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add admin/src/api.ts admin/src/auth.tsx
git commit -m "feat(admin): 新增 REST client 與 auth context"
```

---

## Task 14: 路由、登入頁、租戶清單頁

**Files:**

- Modify: `admin/src/App.tsx`
- Create: `admin/src/pages/LoginPage.tsx`、`admin/src/pages/TenantsPage.tsx`

- [ ] **Step 1: App.tsx 換成 router + guard**

覆寫 `admin/src/App.tsx`：

```tsx
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import LoginPage from "./pages/LoginPage";
import TenantsPage from "./pages/TenantsPage";
import TenantDetailPage from "./pages/TenantDetailPage";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { authed } = useAuth();
  const loc = useLocation();
  if (!authed)
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <TenantsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/tenants/:id"
            element={
              <RequireAuth>
                <TenantDetailPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
```

- [ ] **Step 2: LoginPage**

Create `admin/src/pages/LoginPage.tsx`：

```tsx
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input } from "@oa-agent/ui";
import { useAuth } from "../auth";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setErr(null);
    setBusy(true);
    try {
      await login(password);
      navigate("/", { replace: true });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "登入失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: "15vh auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>OA Agent 管理後台</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>請輸入管理密碼登入</p>
      <form onSubmit={submit}>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="管理密碼"
        />
        {err && <p style={{ color: "#c00", marginTop: 8 }}>{err}</p>}
        <div style={{ marginTop: 16 }}>
          <Button type="submit" disabled={busy}>
            {busy ? "登入中…" : "登入"}
          </Button>
        </div>
      </form>
    </div>
  );
}
```

> 注意：`Input` 的 props 請依 `@oa-agent/ui` 的 `InputProps` 為準（執行前看 `ui/src/components/common/Input/Input.tsx`）。若它不接受原生 `type`/`onChange`，改用其對應 props 或暫時用原生 `<input>`。`Button` 同理。

- [ ] **Step 3: TenantsPage（清單 + 建立）**

Create `admin/src/pages/TenantsPage.tsx`：

```tsx
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Input } from "@oa-agent/ui";
import { api, UnauthorizedError, type Tenant } from "../api";
import { useAuth } from "../auth";

export default function TenantsPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function handleErr(e: unknown) {
    if (e instanceof UnauthorizedError) {
      logout();
      navigate("/login", { replace: true });
      return;
    }
    setErr(e instanceof Error ? e.message : "發生錯誤");
  }

  async function load() {
    try {
      setTenants(await api.listTenants());
    } catch (e) {
      handleErr(e);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (!name.trim()) return;
    try {
      const { publishableKey } = await api.createTenant({ name: name.trim() });
      setName("");
      setNewKey(publishableKey);
      await load();
    } catch (e) {
      handleErr(e);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h1 style={{ fontSize: 22 }}>租戶</h1>
        <Button
          variant="secondary"
          onClick={() => {
            logout();
            navigate("/login");
          }}
        >
          登出
        </Button>
      </div>

      {err && <p style={{ color: "#c00" }}>{err}</p>}
      {newKey && (
        <p style={{ background: "#eef", padding: 8, borderRadius: 6 }}>
          已建立，公開金鑰：<code>{newKey}</code>（請妥善保存）
        </p>
      )}

      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新租戶名稱"
        />
        <Button onClick={create}>建立租戶</Button>
      </div>

      <ul style={{ listStyle: "none", padding: 0 }}>
        {tenants.map((t) => (
          <li
            key={t.id}
            style={{ padding: "10px 0", borderBottom: "1px solid #eee" }}
          >
            <Link to={`/tenants/${t.id}`}>{t.name}</Link>
            <span style={{ color: "#999", marginLeft: 8, fontSize: 12 }}>
              {t.id}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: 驗證型別**

Run: `npm run typecheck -w admin`
Expected: PASS（`TenantDetailPage` 尚未建立會報缺檔 → 先建空殼：見 Task 15 Step 1，可先建立空殼再 typecheck）

- [ ] **Step 5: Commit**

```bash
git add admin/src/App.tsx admin/src/pages/LoginPage.tsx admin/src/pages/TenantsPage.tsx
git commit -m "feat(admin): 路由 + 登入頁 + 租戶清單頁"
```

---

## Task 15: 租戶詳情頁殼 + 分頁切換

**Files:**

- Create: `admin/src/pages/TenantDetailPage.tsx`

- [ ] **Step 1: TenantDetailPage（載入租戶 + 四分頁）**

Create `admin/src/pages/TenantDetailPage.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, UnauthorizedError, type Tenant } from "../api";
import { useAuth } from "../auth";
import AppearanceTab from "./tabs/AppearanceTab";
import SettingsTab from "./tabs/SettingsTab";
import WebhookTab from "./tabs/WebhookTab";
import UsageTab from "./tabs/UsageTab";

type TabKey = "appearance" | "settings" | "webhook" | "usage";
const TABS: { key: TabKey; label: string }[] = [
  { key: "appearance", label: "外觀" },
  { key: "settings", label: "設定" },
  { key: "webhook", label: "Webhook" },
  { key: "usage", label: "用量" },
];

export default function TenantDetailPage() {
  const { id = "" } = useParams();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [tab, setTab] = useState<TabKey>("appearance");
  const [err, setErr] = useState<string | null>(null);

  const handleErr = useCallback(
    (e: unknown) => {
      if (e instanceof UnauthorizedError) {
        logout();
        navigate("/login", { replace: true });
        return;
      }
      setErr(e instanceof Error ? e.message : "發生錯誤");
    },
    [logout, navigate],
  );

  const reload = useCallback(async () => {
    try {
      const list = await api.listTenants();
      const found = list.find((t) => t.id === id) ?? null;
      setTenant(found);
    } catch (e) {
      handleErr(e);
    }
  }, [id, handleErr]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (err) return <p style={{ padding: 24, color: "#c00" }}>{err}</p>;
  if (!tenant) return <p style={{ padding: 24 }}>載入中…</p>;

  return (
    <div style={{ maxWidth: 880, margin: "40px auto", padding: 24 }}>
      <Link to="/">← 租戶清單</Link>
      <h1 style={{ fontSize: 22, margin: "8px 0" }}>{tenant.name}</h1>

      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid #eee",
          marginBottom: 16,
        }}
      >
        {TABS.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            style={{
              padding: "8px 14px",
              border: "none",
              background: "none",
              cursor: "pointer",
              borderBottom:
                tab === tb.key
                  ? "2px solid var(--primary-color, #0057ff)"
                  : "2px solid transparent",
              fontWeight: tab === tb.key ? 600 : 400,
            }}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === "appearance" && (
        <AppearanceTab tenant={tenant} onSaved={reload} onError={handleErr} />
      )}
      {tab === "settings" && (
        <SettingsTab tenant={tenant} onSaved={reload} onError={handleErr} />
      )}
      {tab === "webhook" && (
        <WebhookTab tenantId={tenant.id} onError={handleErr} />
      )}
      {tab === "usage" && <UsageTab tenantId={tenant.id} onError={handleErr} />}
    </div>
  );
}
```

- [ ] **Step 2: 先建立四個分頁空殼讓型別通過**

Create 以下四檔（暫時佔位，後續 task 補實作）：

`admin/src/pages/tabs/AppearanceTab.tsx`：

```tsx
import type { Tenant } from "../../api";
export default function AppearanceTab(_: {
  tenant: Tenant;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  return <div>外觀（待實作）</div>;
}
```

`admin/src/pages/tabs/SettingsTab.tsx`：

```tsx
import type { Tenant } from "../../api";
export default function SettingsTab(_: {
  tenant: Tenant;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  return <div>設定（待實作）</div>;
}
```

`admin/src/pages/tabs/WebhookTab.tsx`：

```tsx
export default function WebhookTab(_: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  return <div>Webhook（待實作）</div>;
}
```

`admin/src/pages/tabs/UsageTab.tsx`：

```tsx
export default function UsageTab(_: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  return <div>用量（待實作）</div>;
}
```

- [ ] **Step 3: 驗證型別**

Run: `npm run typecheck -w admin`
Expected: PASS

- [ ] **Step 4: 手動驗證登入 → 清單 → 詳情**

Run（三終端或背景）：`ADMIN_PASSWORD=test1234 ANTHROPIC_API_KEY=x npm run dev:server`、`npm run dev:admin`
操作：開 `http://localhost:5174`，用 `test1234` 登入 → 看到租戶清單 → 點租戶 → 看到四個分頁切換。
Expected: 流程順、未登入會被導到 /login。

- [ ] **Step 5: Commit**

```bash
git add admin/src/pages/TenantDetailPage.tsx admin/src/pages/tabs/
git commit -m "feat(admin): 租戶詳情頁殼與分頁切換"
```

---

## Task 16: 外觀分頁（表單 + 即時預覽）

**Files:**

- Modify: `admin/src/pages/tabs/AppearanceTab.tsx`

- [ ] **Step 1: 實作 AppearanceTab**

覆寫 `admin/src/pages/tabs/AppearanceTab.tsx`：

```tsx
import { useMemo, useState } from "react";
import type { TenantAppearance } from "@oa-agent/shared";
import { Button } from "@oa-agent/ui";
import { api, type Tenant } from "../../api";

const POSITIONS = [
  { v: "br", label: "右下" },
  { v: "bl", label: "左下" },
] as const;

export default function AppearanceTab({
  tenant,
  onSaved,
  onError,
}: {
  tenant: Tenant;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [form, setForm] = useState<TenantAppearance>(tenant.appearance ?? {});
  const [busy, setBusy] = useState(false);

  function set<K extends keyof TenantAppearance>(k: K, v: TenantAppearance[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    setBusy(true);
    try {
      await api.updateTenant(tenant.id, { appearance: form });
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  // 即時預覽：嵌入 widget client（5173），帶 pk + 表單暫存的 theme（query 優先於後端）
  const previewSrc = useMemo(() => {
    const params = new URLSearchParams({ embed: "1" });
    if (form.theme) params.set("theme", form.theme);
    if (form.defaultLocale) params.set("locale", form.defaultLocale);
    // 預覽用任一 pk：此處用 tenant 第一把公開金鑰較準；簡化為不帶 key 看版型
    return `http://localhost:5173/?${params.toString()}`;
  }, [form.theme, form.defaultLocale]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          主色
          <input
            type="color"
            value={form.primaryColor ?? "#0057ff"}
            onChange={(e) => set("primaryColor", e.target.value)}
            style={{ display: "block", marginTop: 4 }}
          />
        </label>

        <label>
          主題
          <select
            value={form.theme ?? "light"}
            onChange={(e) =>
              set("theme", e.target.value as TenantAppearance["theme"])
            }
            style={{ display: "block", marginTop: 4 }}
          >
            <option value="light">淺色</option>
            <option value="dark">深色</option>
          </select>
        </label>

        <label>
          按鈕位置
          <select
            value={form.position ?? "br"}
            onChange={(e) =>
              set("position", e.target.value as TenantAppearance["position"])
            }
            style={{ display: "block", marginTop: 4 }}
          >
            {POSITIONS.map((p) => (
              <option key={p.v} value={p.v}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Logo URL
          <input
            type="url"
            value={form.logoUrl ?? ""}
            onChange={(e) => set("logoUrl", e.target.value)}
            placeholder="https://…/logo.png"
            style={{ display: "block", marginTop: 4, width: "100%" }}
          />
        </label>

        <label>
          歡迎語
          <input
            type="text"
            value={form.welcomeMessage ?? ""}
            onChange={(e) => set("welcomeMessage", e.target.value)}
            maxLength={200}
            style={{ display: "block", marginTop: 4, width: "100%" }}
          />
        </label>

        <label>
          預設語言
          <input
            type="text"
            value={form.defaultLocale ?? ""}
            onChange={(e) => set("defaultLocale", e.target.value)}
            placeholder="zh-Hant"
            style={{ display: "block", marginTop: 4 }}
          />
        </label>

        <div>
          <Button onClick={save} disabled={busy}>
            {busy ? "儲存中…" : "儲存外觀"}
          </Button>
        </div>
      </div>

      <div>
        <p style={{ fontSize: 12, color: "#888" }}>即時預覽（widget）</p>
        <iframe
          title="widget-preview"
          src={previewSrc}
          style={{
            width: 340,
            height: 520,
            border: "1px solid #ddd",
            borderRadius: 8,
          }}
        />
        <p style={{ fontSize: 11, color: "#aaa" }}>
          需同時執行 widget client（5173）。主色預覽以儲存後套用為準。
        </p>
      </div>
    </div>
  );
}
```

> 注意：即時預覽需 widget client 在 5173 執行。預覽主要反映 `theme`/版型；`primaryColor` 因走後端 `/widget/config`，儲存後重整 iframe 才完整反映（可接受的 MVP 行為）。

- [ ] **Step 2: 驗證型別**

Run: `npm run typecheck -w admin`
Expected: PASS

- [ ] **Step 3: 手動驗證**

操作（server+admin+client 都跑著）：在外觀分頁改主色/主題 → 儲存 → 回 widget `?embed=1&key=<pk>` 重整，確認套用。
Expected: 設定有寫入並反映。

- [ ] **Step 4: Commit**

```bash
git add admin/src/pages/tabs/AppearanceTab.tsx
git commit -m "feat(admin): 外觀分頁（表單 + 即時預覽）"
```

---

## Task 17: 設定分頁（名稱 / 來源 / SSO / API Keys）

**Files:**

- Modify: `admin/src/pages/tabs/SettingsTab.tsx`

- [ ] **Step 1: 實作 SettingsTab**

覆寫 `admin/src/pages/tabs/SettingsTab.tsx`：

```tsx
import { useState } from "react";
import { Button } from "@oa-agent/ui";
import { api, type ApiKey, type Tenant } from "../../api";

export default function SettingsTab({
  tenant,
  onSaved,
  onError,
}: {
  tenant: Tenant;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState(tenant.name);
  const [origins, setOrigins] = useState(
    (tenant.allowedOrigins ?? []).join("\n"),
  );
  const [ssoSecret, setSsoSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [newKeys, setNewKeys] = useState<ApiKey[]>([]);

  async function save() {
    setBusy(true);
    try {
      const allowedOrigins = origins
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const patch: Parameters<typeof api.updateTenant>[1] = {
        name: name.trim(),
        allowedOrigins,
      };
      if (ssoSecret.trim().length >= 16) patch.ssoSecret = ssoSecret.trim();
      await api.updateTenant(tenant.id, patch);
      setSsoSecret("");
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function genKey(type: "publishable" | "secret") {
    try {
      const k = await api.createKey(tenant.id, type);
      setNewKeys((ks) => [k, ...ks]);
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        maxWidth: 560,
      }}
    >
      <label>
        名稱
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ display: "block", width: "100%", marginTop: 4 }}
        />
      </label>

      <label>
        允許嵌入來源（每行一個，<code>*</code> 代表全放行）
        <textarea
          value={origins}
          onChange={(e) => setOrigins(e.target.value)}
          rows={4}
          style={{ display: "block", width: "100%", marginTop: 4 }}
        />
      </label>

      <label>
        SSO 共享密鑰（留空＝不變更；需 ≥16 字元）
        <input
          type="password"
          value={ssoSecret}
          onChange={(e) => setSsoSecret(e.target.value)}
          placeholder={
            tenant.ssoSecret ? "（已設定，輸入以覆蓋）" : "（未設定）"
          }
          style={{ display: "block", width: "100%", marginTop: 4 }}
        />
      </label>

      <div>
        <Button onClick={save} disabled={busy}>
          {busy ? "儲存中…" : "儲存設定"}
        </Button>
      </div>

      <hr />
      <div>
        <h3 style={{ fontSize: 16 }}>API Keys</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" onClick={() => genKey("publishable")}>
            產生公開金鑰 pk_
          </Button>
          <Button variant="secondary" onClick={() => genKey("secret")}>
            產生秘密金鑰 sk_
          </Button>
        </div>
        {newKeys.length > 0 && (
          <ul style={{ marginTop: 8 }}>
            {newKeys.map((k) => (
              <li key={k.key} style={{ fontFamily: "monospace", fontSize: 13 }}>
                <button
                  onClick={() => void navigator.clipboard.writeText(k.key)}
                  title="複製"
                >
                  📋
                </button>{" "}
                {k.key}
              </li>
            ))}
          </ul>
        )}
        <p style={{ fontSize: 12, color: "#888" }}>
          金鑰僅在產生當下顯示完整字串，請立即保存。
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 驗證型別**

Run: `npm run typecheck -w admin`
Expected: PASS

- [ ] **Step 3: 手動驗證**

操作：改名稱/來源儲存後重整詳情頁確認保留；產生 pk/sk 確認顯示與複製。
Expected: 更新成功、金鑰可產生。

- [ ] **Step 4: Commit**

```bash
git add admin/src/pages/tabs/SettingsTab.tsx
git commit -m "feat(admin): 設定分頁（名稱/來源/SSO/API Keys）"
```

---

## Task 18: Webhook 分頁（列表 / 新增 / 啟用停用 / 刪除）

**Files:**

- Modify: `admin/src/pages/tabs/WebhookTab.tsx`

- [ ] **Step 1: 實作 WebhookTab**

覆寫 `admin/src/pages/tabs/WebhookTab.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import { Button } from "@oa-agent/ui";
import { api, type WebhookEndpoint } from "../../api";

export default function WebhookTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const [list, setList] = useState<WebhookEndpoint[]>([]);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");

  const load = useCallback(async () => {
    try {
      setList(await api.listWebhooks(tenantId));
    } catch (e) {
      onError(e);
    }
  }, [tenantId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!url.trim()) return;
    try {
      await api.createWebhook(tenantId, {
        url: url.trim(),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      });
      setUrl("");
      setSecret("");
      await load();
    } catch (e) {
      onError(e);
    }
  }

  async function toggle(w: WebhookEndpoint) {
    try {
      await api.toggleWebhook(tenantId, w.id, !w.disabledAt);
      await load();
    } catch (e) {
      onError(e);
    }
  }

  async function remove(w: WebhookEndpoint) {
    try {
      await api.deleteWebhook(tenantId, w.id);
      await load();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://接收端/hook"
          style={{ flex: 1 }}
        />
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="簽章密鑰（選填）"
        />
        <Button onClick={add}>新增</Button>
      </div>

      <ul style={{ listStyle: "none", padding: 0 }}>
        {list.map((w) => (
          <li
            key={w.id}
            style={{ padding: "10px 0", borderBottom: "1px solid #eee" }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: 13,
                  color: w.disabledAt ? "#999" : "#222",
                }}
              >
                {w.url} {w.disabledAt ? "（已停用）" : ""}
              </span>
              <span style={{ display: "flex", gap: 8 }}>
                <Button variant="secondary" onClick={() => toggle(w)}>
                  {w.disabledAt ? "啟用" : "停用"}
                </Button>
                <Button variant="secondary" onClick={() => remove(w)}>
                  刪除
                </Button>
              </span>
            </div>
            <div style={{ fontSize: 11, color: "#aaa" }}>
              secret: {w.secret}
            </div>
          </li>
        ))}
        {list.length === 0 && (
          <li style={{ color: "#999" }}>尚無 webhook 端點</li>
        )}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: 驗證型別**

Run: `npm run typecheck -w admin`
Expected: PASS

- [ ] **Step 3: 手動驗證**

操作：新增端點 → 看到 secret → 停用/啟用切換 → 刪除。
Expected: 各動作後列表正確更新。

- [ ] **Step 4: Commit**

```bash
git add admin/src/pages/tabs/WebhookTab.tsx
git commit -m "feat(admin): webhook 分頁（列表/新增/啟用停用/刪除）"
```

---

## Task 19: 用量分頁（唯讀）

**Files:**

- Modify: `admin/src/pages/tabs/UsageTab.tsx`

- [ ] **Step 1: 實作 UsageTab**

覆寫 `admin/src/pages/tabs/UsageTab.tsx`：

```tsx
import { useEffect, useState } from "react";
import { api, type Usage } from "../../api";

export default function UsageTab({
  tenantId,
  onError,
}: {
  tenantId: string;
  onError: (e: unknown) => void;
}) {
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getUsage(tenantId)
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [tenantId, onError]);

  if (!usage) return <p style={{ color: "#999" }}>載入中…</p>;

  const items: { label: string; value: number }[] = [
    { label: "對話數", value: usage.conversations ?? 0 },
    { label: "訊息數", value: usage.messages ?? 0 },
    { label: "送出數", value: usage.submissions ?? 0 },
  ];

  return (
    <div style={{ display: "flex", gap: 24 }}>
      {items.map((it) => (
        <div
          key={it.label}
          style={{
            padding: 16,
            border: "1px solid #eee",
            borderRadius: 8,
            minWidth: 120,
          }}
        >
          <div style={{ fontSize: 12, color: "#888" }}>{it.label}</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}
```

> 注意：`Usage` 欄位名須與 `usageStore.get()` 回傳一致。執行前 `grep -n "conversations\|messages\|submissions\|return" server/src/modules/usage/usage.store.ts` 確認；若不同，同步調整 `api.ts` 的 `Usage` 介面與此處欄位。

- [ ] **Step 2: 驗證型別**

Run: `npm run typecheck -w admin`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add admin/src/pages/tabs/UsageTab.tsx
git commit -m "feat(admin): 用量分頁（唯讀）"
```

---

## Task 20: 全域驗證與收尾

**Files:**

- Modify: `README.md` 或 `INTEGRATION.md`（補後台說明，選一）

- [ ] **Step 1: 全 workspace typecheck**

Run: `npm run typecheck`
Expected: 全部 PASS（ui / sdk / server / client / admin）

- [ ] **Step 2: 後端 smoke 全綠**

Run: `cd server && ADMIN_PASSWORD=test1234 ANTHROPIC_API_KEY=x npx tsx scripts/admin-smoke.ts`
Expected: `ADMIN SMOKE PASS`

- [ ] **Step 3: 全建置**

Run: `npm run build`
Expected: server + client + admin 皆建置成功

- [ ] **Step 4: 文件補一段後台用法**

在 `INTEGRATION.md` 的「三、快速啟用」之後新增小節，說明：

- 設 `ADMIN_PASSWORD` 啟用後台登入
- `npm run dev:admin` 開後台（http://localhost:5174）
- 後台可設定 widget 外觀 / 租戶 / webhook

````markdown
## 四、管理後台（admin）

```bash
export ADMIN_PASSWORD=$(openssl rand -hex 24)
npm run dev:server   # 後端 3000
npm run dev:admin    # 後台 5174
# 瀏覽器開 http://localhost:5174，以 ADMIN_PASSWORD 登入
```
````

後台分頁：**外觀**（依租戶套用，widget 載入時讀 `/api/v1/widget/config`）、**設定**（名稱/來源/SSO/API Keys）、**Webhook**（端點 CRUD + 啟用停用）、**用量**（唯讀）。

````

- [ ] **Step 5: Commit**

```bash
git add README.md INTEGRATION.md
git commit -m "docs(admin): 補管理後台啟用與使用說明"
````

---

## Self-Review Notes（撰寫者已檢查）

- **Spec 覆蓋**：外觀（Task 1/2/9/11/16）、租戶設定（Task 7/17）、webhook（Task 3/8/18）、登入頁（Task 4/5/6/14）、admin workspace（Task 12-15/19）、向後相容（Task 5 雙模式、Task 11 data-\* 優先）、測試（Task 10 後端 smoke、各前端 typecheck+手動）。
- **型別一致**：`TenantAppearance`、`Tenant`、`api.ts` 介面跨 task 名稱一致；`updateTenant`/`setDisabled`/`signAdminToken`/`requireAdmin` 簽章前後一致。
- **已知需執行時確認的銜接點**（已在對應 task 標注 grep 指示，非佔位）：(a) `app.ts` 的 `createApp` 匯出名稱；(b) `usageStore.get()` 欄位名 → `Usage` 介面；(c) `@oa-agent/ui` 的 `Input`/`Button` props；(d) `App.tsx` 既有 theme 套用慣例。
