/**
 * i18n 初始化（繁體中文 + English）。
 *
 * 涵蓋：app 介面字串、表單畫面、以及 @oa-agent/ui 的 Dialog / DatePicker 所需 key。
 * 語系切換用 i18n.changeLanguage('zh-Hant' | 'en')，並記憶在 localStorage。
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const LANG_KEY = "oa-lang";

const zhHant = {
  common: { confirm: "確認", cancel: "取消" },
  datePicker: {
    selectDate: "選擇日期",
    today: "今天",
    headerMonth: "{{year}} 年 {{month}}",
    headerYear: "{{year}} 年",
    months: {
      1: "1 月",
      2: "2 月",
      3: "3 月",
      4: "4 月",
      5: "5 月",
      6: "6 月",
      7: "7 月",
      8: "8 月",
      9: "9 月",
      10: "10 月",
      11: "11 月",
      12: "12 月",
    },
    weekdays: { 0: "日", 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六" },
  },
  timePicker: {
    selectTime: "選擇時間",
    hour: "時",
    minute: "分",
    now: "現在",
  },
  app: {
    title: "OA Agent",
    greeting: "你好，我是 {{name}}。直接用自然語言描述你的需求即可 👋",
    aiName: "AI 小幫手",
    conn: {
      checking: "連線中…",
      online: "已連線",
      offline: "未連線",
    },
    user: "使用者",
    statusLabel: "狀態",
    statusInitial: "尚未開始",
    status: {
      collecting: "蒐集中",
      confirming: "待確認",
      submitting: "送出中",
      submitted: "已送出",
      cancelled: "已取消",
      failed: "失敗",
    },
    reset: "重新開始",
    close: "關閉",
    confirm: "確認",
    cancel: "取消",
    send: "送出",
    typing: "AI 回覆中…",
    copyMsg: "複製",
    copiedMsg: "已複製",
    editMsg: "編輯",
    inputPlaceholder: "描述你的需求，例如：我下週一到週二要請特休，家裡有事",
    filledFields: "已填欄位",
    result: "送出結果",
    collapsePane: "收合面板",
    expandPane: "展開面板",
    paneLabel: "表單明細",
    formPickerHint: "要辦理什麼？",
    // 知識庫推薦 chip 的「後備」句：正常情況由後端依租戶索引內容生成（widget config 的
    // suggestedPrompts）。僅在未建索引、生成失敗或語系無對應時才會顯示這裡的內容。
    // 注意 App.tsx 只渲染第一句，後兩句目前不會出現。
    knowledgePrompts: ["公司有哪些產品或服務？", "聯絡電話與地址在哪？", "相關規定與常見問題"],
    quickHint: "不知道怎麼開始？試試：",
    quickPrompts: [
      "我下週一到週二請特休，家裡有事",
      "明天下午請兩小時病假",
      "查我特休還剩多少時數",
    ],
    oaNo: "OA 單號",
    statusField: "狀態",
    viewForm: "檢視請假單",
    noData: "開始對話後，這裡會即時顯示你已填好的欄位 ✍️",
    notSubmitted: "送出後這裡會顯示 OA 單號與審核狀態",
    restarted: "已重新開始，請輸入新的需求。",
    sessionExpired:
      "對話連線已重置（伺服器可能重新啟動或逾時），已清空目前進度。請直接輸入需求重新開始。",
    cancelledMsg: "已取消這張表單。可按「重新開始」建立新的需求。",
    submittedMsg: "已送出 ✅ OA 單號：{{id}}",
    submittedHint:
      "這張表單已完成。若要申請其他表單（如外出登記、請假等），請按「重新開始」或直接輸入新的需求。",
    cancelFailed: "取消失敗：",
    loadFormFailed: "無法載入表單畫面：",
    requestFailed: "請求失敗",
    theme: "主題",
    language: "語言",
    menu: "選單",
    itemsCount: "{{count}} 個項目",
  },
  auth: {
    subtitle: "請登入以使用 {{name}}",
    username: "帳號",
    password: "密碼",
    login: "登入",
    loggingIn: "登入中…",
    loginFailed: "登入失敗",
    logout: "登出",
    errorTitle: "無法登入",
    ssoFailed: "自動登入失敗，請確認網站金鑰（pk）與 SSO 設定是否正確，再重試。",
    sessionError: "連線失效：可能是網站金鑰（pk）不正確或伺服器無法連線。請重試或聯絡管理員。",
    retry: "重試",
    // devHint: "測試帳號：hyweb ，密碼：********",
  },
  settings: {
    title: "設定",
    appearance: "外觀模式",
    fontSize: "系統字級",
    fontSmaller: "縮小字級",
    fontLarger: "放大字級",
    language: "切換語言",
  },
  form: {
    confirmTitle: "請確認{{title}}",
    totalHours: "共計 {{hours}} 小時",
    remainingHours: "今年度剩餘 {{hours}} 小時",
    submitted: "已送出",
    hint: "請核對並可直接修改，確認無誤後送出。",
    complete: "完成",
    submit: "確認送出",
    submitting: "送出中…",
    incomplete: "尚有必填欄位未完成，請補齊後再送出。",
    next: "下一步",
    previous: "上一步",
    steps: "表單步驟",
    step: "步驟 {{index}}",
    requiredMissing: "請先填寫必填欄位：{{fields}}",
    selectPlaceholder: "請選擇…",
  },
  fileUploader: {
    defaultTitle: "附件清單",
    defaultFormats: "支援 pdf、jpg、png、docx、xlsx，單檔上限 10MB",
    none: "無附件",
    pickOrDrop: "點擊或拖曳檔案到此上傳",
    emptyHint: "可一次選擇多個檔案",
    addMore: "新增附件",
    uploading: "上傳中…",
    uploadError: "上傳失敗",
    descriptionPlaceholder: "附件說明",
    deleteFile: "移除附件",
  },
};

const en = {
  common: { confirm: "Confirm", cancel: "Cancel" },
  // 內建表單的推薦 chip（標題／tooltip 描述／範例）英文；中文模式由 App 以 server 值作 defaultValue 回退。
  // key 為 formId；租戶自訂表單無此鍵時自動回退 server 標題。
  forms: {
    "leave-request": {
      title: "Leave Request",
      description:
        "Employee leave application; needs the applicant, deputy, leave type, start/end date & time, and reason",
      examples: [
        "I'd like to take sick leave",
        "I'll take annual leave next Mon–Tue",
        "Personal leave tomorrow afternoon",
        "I'd like three days of bereavement leave",
      ],
    },
    "outing-registration": {
      title: "Outing Registration",
      description:
        "Employee outing registration; needs the person, subject, departure and destination, outing & return date/time, and whether reimbursement is needed",
      examples: [
        "I want to register an outing",
        "I'm visiting a client this afternoon",
        "Help me fill out an outing form",
        "I have an off-site meeting tomorrow, please register it",
      ],
    },
    "business-trip-domestic": {
      title: "Domestic Trip Expense Claim",
      description:
        "Domestic business-trip expense reimbursement; needs company, purpose, dates, route, and expenses (taxi, HSR, transit, private car, lodging, meals, parking, carpool) with HSR carbon emissions",
      examples: [
        "I want to claim domestic trip expenses",
        "Help me file a domestic trip reimbursement",
        "I need to file expenses after my trip",
        "Claim the fare for last week's Hsinchu trip",
      ],
    },
  },
  datePicker: {
    selectDate: "Select date",
    today: "Today",
    headerMonth: "{{month}} {{year}}",
    headerYear: "{{year}}",
    months: {
      1: "Jan",
      2: "Feb",
      3: "Mar",
      4: "Apr",
      5: "May",
      6: "Jun",
      7: "Jul",
      8: "Aug",
      9: "Sep",
      10: "Oct",
      11: "Nov",
      12: "Dec",
    },
    weekdays: {
      0: "Sun",
      1: "Mon",
      2: "Tue",
      3: "Wed",
      4: "Thu",
      5: "Fri",
      6: "Sat",
    },
  },
  timePicker: {
    selectTime: "Select time",
    hour: "Hour",
    minute: "Min",
    now: "Now",
  },
  app: {
    title: "OA Agent",
    greeting:
      "Hi, I'm {{name}}. Just describe your request in your own words 👋",
    aiName: "AI Assistant",
    conn: {
      checking: "Connecting…",
      online: "Connected",
      offline: "Offline",
    },
    user: "User",
    statusLabel: "Status",
    statusInitial: "Not started",
    status: {
      collecting: "Collecting",
      confirming: "Awaiting confirm",
      submitting: "Submitting",
      submitted: "Submitted",
      cancelled: "Cancelled",
      failed: "Failed",
    },
    reset: "Restart",
    close: "Close",
    confirm: "Confirm",
    cancel: "Cancel",
    send: "Send",
    typing: "AI is replying…",
    copyMsg: "Copy",
    copiedMsg: "Copied",
    editMsg: "Edit",
    inputPlaceholder:
      "Describe your request, e.g. I need annual leave next Mon–Tue for personal reasons",
    filledFields: "Filled fields",
    result: "Submission",
    collapsePane: "Collapse panel",
    expandPane: "Expand panel",
    paneLabel: "Details",
    formPickerHint: "What would you like to do?",
    // Fallback prompts for the knowledge chip; normally generated per tenant from the
    // indexed content (see suggestedPrompts in widget config). Only the first is rendered.
    knowledgePrompts: ["What products or services do you offer?", "Contact phone & address", "Policies & FAQ"],
    quickHint: "Not sure where to start? Try:",
    quickPrompts: [
      "I'll take annual leave next Mon–Tue for family matters",
      "Two hours of sick leave tomorrow afternoon",
      "How many annual leave hours do I have left?",
    ],
    oaNo: "OA No.",
    statusField: "Status",
    viewForm: "View form",
    noData:
      "Once you start chatting, your filled fields appear here in real time ✍️",
    notSubmitted: "After submitting, the OA number and status will show here",
    restarted: "Restarted. Please enter a new request.",
    sessionExpired:
      "The conversation was reset (the server may have restarted or timed out); current progress was cleared. Just type your request to start over.",
    cancelledMsg:
      "This form has been cancelled. Click “Restart” to begin a new request.",
    submittedMsg: "Submitted ✅ OA No.: {{id}}",
    submittedHint:
      "This form is complete. To apply for another form (e.g. outing registration, leave), click “Restart” or just type a new request.",
    cancelFailed: "Cancel failed: ",
    loadFormFailed: "Failed to load form view: ",
    requestFailed: "Request failed",
    theme: "Theme",
    language: "Language",
    menu: "Menu",
    itemsCount: "{{count}} item(s)",
  },
  auth: {
    subtitle: "Sign in to use {{name}}",
    username: "Account",
    password: "Password",
    login: "Sign in",
    loggingIn: "Signing in…",
    loginFailed: "Sign-in failed",
    logout: "Sign out",
    errorTitle: "Unable to sign in",
    ssoFailed:
      "Auto sign-in failed. Please verify the site key (pk) and SSO settings, then retry.",
    sessionError:
      "Session ended: the site key (pk) may be incorrect or the server is unreachable. Please retry or contact your admin.",
    retry: "Retry",
    // devHint: "Test accounts: hyweb, password: ********",
  },
  settings: {
    title: "Settings",
    appearance: "Appearance",
    fontSize: "Font size",
    fontSmaller: "Smaller font",
    fontLarger: "Larger font",
    language: "Language",
  },
  form: {
    confirmTitle: "Confirm {{title}}",
    totalHours: "Total {{hours}} hours",
    remainingHours: "{{hours}} hours remaining this year",
    submitted: "Submitted",
    hint: "Please review and edit if needed, then submit.",
    complete: "Done",
    submit: "Confirm & submit",
    submitting: "Submitting…",
    incomplete:
      "Some required fields are incomplete. Please complete them before submitting.",
    next: "Next",
    previous: "Previous",
    steps: "Form steps",
    step: "Step {{index}}",
    requiredMissing: "Please complete required fields: {{fields}}",
    selectPlaceholder: "Select…",
  },
  fileUploader: {
    defaultTitle: "Attachments",
    defaultFormats: "Supports pdf, jpg, png, docx, xlsx · max 10MB each",
    none: "No attachments",
    pickOrDrop: "Click or drag files here to upload",
    emptyHint: "You can select multiple files",
    addMore: "Add files",
    uploading: "Uploading…",
    uploadError: "Upload failed",
    descriptionPlaceholder: "Description",
    deleteFile: "Remove attachment",
  },
};

// 嵌入（widget iframe）模式不讀本地記憶：iframe 與第一方 App 同源、共用 localStorage，
// 會把 App 端切過的語系帶進 widget。嵌入時改由 data-locale / 租戶 defaultLocale / 預設決定。
const isEmbed =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("embed") === "1";
const stored =
  !isEmbed && typeof localStorage !== "undefined"
    ? localStorage.getItem(LANG_KEY)
    : null;

void i18n.use(initReactI18next).init({
  resources: {
    "zh-Hant": { translation: zhHant },
    en: { translation: en },
  },
  lng: stored ?? "zh-Hant",
  fallbackLng: "zh-Hant",
  interpolation: { escapeValue: false },
});

// persist=false：套用「預設語系」（data-locale / 租戶 defaultLocale）時不寫本地記憶，
// 以免被誤認為使用者的明確選擇、擋掉日後的預設覆寫。使用者由選單切換時才 persist。
export function changeLanguage(lng: string, persist = true): void {
  void i18n.changeLanguage(lng);
  if (persist && typeof localStorage !== "undefined")
    localStorage.setItem(LANG_KEY, lng);
}

export default i18n;
