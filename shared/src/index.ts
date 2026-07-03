/**
 * 前後端共用型別（single source of truth）。
 *
 * - 六層 Form Definition 的型別（canonical = schemas/<formId>/*.json）
 * - 對話 API 的 DTO 型別片段（SessionStatus / SubmissionInfo）
 *
 * server 透過 form.types / conversation.types 再匯出；client 直接 import。
 */

// ---- ① Data Schema（標準 JSON Schema 子集）----
export interface JsonSchemaProperty {
  type: string;
  enum?: (string | number)[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
  items?: JsonSchemaProperty;
  maxItems?: number;
  /** 巢狀物件屬性（items 為 object 時使用，如附件 metadata） */
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface DataSchema {
  $schema?: string;
  formId?: string;
  title?: string;
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean;
}

// ---- ② Field Schema（UI 元件 + 語意 metadata）----
export type FieldComponent =
  | 'Input'
  | 'Textarea'
  | 'Number'
  | 'Select'
  | 'DatePicker'
  | 'TimePicker'
  | 'Upload'
  | 'Checkbox';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldSpec {
  component: FieldComponent;
  label: string;
  placeholder?: string;
  options?: FieldOption[];
  help?: string;
}

export type FieldSchema = Record<string, FieldSpec>;

// ---- ③ Layout Schema（選用；有定義時前端依此分組／排序／多步驟渲染，無則扁平單頁）----
export interface LayoutSection {
  title?: string;
  fields: string[][];
}
export interface LayoutSchema {
  sections: LayoutSection[];
}

// ---- ④ Validation Schema（必填 + 跨欄商規）----
export type RuleOp = '>=' | '>' | '<=' | '<' | '==' | '!=';
export interface BusinessRule {
  id: string;
  type: 'compareField';
  field: string;
  op: RuleOp;
  other: string;
  message: string;
}
export interface ValidationSchema {
  required: string[];
  rules?: BusinessRule[];
}

// ---- ⑤ Workflow Schema（選用；有定義時送出後依關卡計算簽核進度，Demo 以時間自動推進）----
export interface WorkflowStep {
  type: string;
  name?: string;
  assigneeId?: string;
}
export interface WorkflowSchema {
  steps: WorkflowStep[];
}

// ---- ⑥ Agent Schema（對話蒐集策略）----
export interface AgentSchema {
  intent: string;
  description: string;
  examples?: string[];
  /** 意圖路由關鍵字：使用者未明確指定表單時，比對訊息命中數決定 formId */
  keywords?: string[];
  askOrder?: string[];
  fieldGuidance?: Record<string, string>;
  confirmationTemplate?: string;
}

// ---- ⑦ Policy Schema（optional seam：時數計算政策，可依地區覆寫）----
/** 單一地區的工時政策（計算請假時數用） */
export interface WorkTimePolicy {
  /** 上下班時間 HH:mm */
  workDay: { start: string; end: string };
  /** 午休（休息）區間 HH:mm，計算時數時排除 */
  lunchBreak?: { start: string; end: string };
  /** 週休日（0=日…6=六）；省略預設 [0,6]（六、日不計時數） */
  weekendDays?: number[];
}
export interface PolicySchema {
  /** 找不到地區時的後備政策 */
  default: WorkTimePolicy;
  /** 地區（如 台北/新竹）→ 覆寫政策 */
  regions?: Record<string, WorkTimePolicy>;
  /** 國定假日（YYYY-MM-DD，全地區共用）；計算時數時不計 */
  holidays?: string[];
}

// ---- ⑧ OA Schema（optional seam：送出至真 OA 系統的端點 + 欄位映射 + 回應解析）----
/** 送出請求映射：本系統來源欄位 → OA body 欄位 */
export interface OARequestMapping {
  /** `來源欄位名 → OA body 欄位名`；同時為 allowlist（只送出列出的欄位），值為 undefined 不帶 */
  fieldMap: Record<string, string>;
  /** 固定欄位（如 { FormType: "LEAVE" }），直接併入 body */
  constants?: Record<string, unknown>;
}
/** OA 回應解析映射：自原始回應取 id 與狀態 */
export interface OAResponseMapping {
  /** OA 回應中的請求 id 欄位名（缺值時 fallback `id`） */
  idField: string;
  /** OA 回應中的狀態欄位名；省略用 `status` */
  statusField?: string;
  /** OA 狀態字串 → 本系統狀態；未命中 fallback `pending` */
  statusMap?: Record<string, 'accepted' | 'pending' | 'rejected'>;
}
export interface OASchema {
  /** 真 OA 的端點路徑（接在 OA_BASE_URL 後） */
  endpoint: string;
  /** HTTP 方法；省略視為 POST */
  method?: 'POST' | 'PUT';
  request: OARequestMapping;
  response: OAResponseMapping;
}

// ---- 組合：一份 Definition ----
export interface Definition {
  formId: string;
  data: DataSchema;
  field: FieldSchema;
  layout?: LayoutSchema;
  validation: ValidationSchema;
  workflow?: WorkflowSchema;
  agent: AgentSchema;
  /** 時數計算政策（僅請假類表單有；其他表單可無） */
  policy?: PolicySchema;
  /** OA 送出映射（僅需真正送出至 OA 的表單才有） */
  oa?: OASchema;
}

// ---- slot-filling 用的衍生型別 ----
export type FormValues = Record<string, unknown>;

export interface FieldIssue {
  field: string;
  message: string;
}

export interface SlotStatus {
  /** 已填且有效的欄位 */
  filled: string[];
  /** 必填但尚未填 */
  missing: string[];
  /** 已填但驗證失敗（欄位級或跨欄商規） */
  invalid: FieldIssue[];
  /** 無 missing、無 invalid */
  isComplete: boolean;
}

// ---- 對話 API 共用 DTO 片段 ----
export type SessionStatus =
  | 'collecting'
  | 'confirming'
  | 'submitting'
  | 'submitted'
  | 'cancelled'
  | 'failed';

/** 單一簽核關卡狀態（由 workflow.steps 衍生） */
export interface ApprovalStep {
  /** 關卡名稱（取自 workflow step.name，缺省用 type） */
  name: string;
  /** 關卡類型（manager / hr …） */
  type: string;
  status: 'current' | 'pending' | 'approved' | 'rejected';
}

export interface SubmissionInfo {
  oaRequestId: string;
  status: string;
  /** 送出時間（ISO）；用於計算/查詢簽核進度 */
  submittedAt?: string;
  /** 簽核進度（依表單 workflow.steps 產生）；無 workflow 則不帶 */
  approvals?: ApprovalStep[];
}

/** 申請人（目前使用者）資訊，由後端使用者目錄解析 */
export interface Applicant {
  /** 帳號（userId） */
  id: string;
  name: string;
  department: string;
  title?: string;
  /** 所屬地區（如 台北/新竹）；決定工時政策，缺省用 policy.default */
  region?: string;
}

/** 假別剩餘時數（由 OA 連接器提供） */
export interface LeaveBalance {
  leaveType: string;
  remainingHours: number;
}

/**
 * 附件 metadata（存於表單值 attachments 陣列）。
 * 檔案內容由後端附件儲存區以 id 保管，前後端只往返這份輕量 metadata。
 */
export interface Attachment {
  /** 後端產生的識別碼 */
  id: string;
  /** 原始檔名 */
  name: string;
  /** MIME 類型 */
  mime: string;
  /** 檔案大小（bytes） */
  size: number;
  /** 使用者填寫的附件說明 */
  description?: string;
}

// ---- 租戶 widget 外觀（admin 後台設定、widget 端套用）----
export interface TenantAppearance {
  /** AI 助理顯示名稱；未設用 widget 內建預設（i18n app.aiName）。同時用於前端顯示與 AI 自稱 */
  assistantName?: string;
  /** 主色（hex，如 #0057ff）；未設用 widget 內建預設 */
  primaryColor?: string;
  /** 外觀模式 */
  theme?: 'light' | 'dark';
  /** 啟動按鈕位置：右下 / 左下 */
  position?: 'br' | 'bl';
  /** 啟動按鈕距側邊（左或右，依 position）距離（px）；未設用 widget 內建預設 20 */
  offsetX?: number;
  /** 啟動按鈕距底部距離（px）；未設用 widget 內建預設 20。可調高避開頁面既有的 go-to-top 等按鈕 */
  offsetY?: number;
  /** 自訂 logo 圖片 URL */
  logoUrl?: string;
  /** 對話開場歡迎語 */
  welcomeMessage?: string;
  /** 預設介面語言（如 zh-Hant） */
  defaultLocale?: string;
}
