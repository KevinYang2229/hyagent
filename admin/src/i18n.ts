/**
 * admin i18n 初始化（繁中 + English）。
 *
 * admin 後台本身介面為純中文、不做語系切換；此處只為了讓表單設計器的
 * 即時預覽 <SchemaFormPreview> 內、來自 @hyagent/ui 的 DatePicker /
 * TimePicker / FileUploader 等元件能正確顯示文案（這些元件以 react-i18next
 * 的 t() 取字，未初始化時會直接吐出 key）。
 *
 * 這組 key 與 client/src/i18n.ts 的 ui 元件區段同源；client 是 canonical，
 * 若日後 ui 元件新增 key，兩邊需一起補（理想上應抽進 @hyagent/ui 共用）。
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const zhHant = {
  common: { confirm: "確認", cancel: "取消", back: "返回" },
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
  common: { confirm: "Confirm", cancel: "Cancel", back: "Back" },
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
    weekdays: { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" },
  },
  timePicker: {
    selectTime: "Select time",
    hour: "Hour",
    minute: "Min",
    now: "Now",
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

void i18n.use(initReactI18next).init({
  resources: {
    "zh-Hant": { translation: zhHant },
    en: { translation: en },
  },
  lng: "zh-Hant",
  fallbackLng: "zh-Hant",
  interpolation: { escapeValue: false },
});

export default i18n;
