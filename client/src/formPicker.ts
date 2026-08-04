/**
 * 「要辦理什麼？」選單的顯示與預選決策。
 *
 * 抽成純函式而非寫在 App.tsx：這兩個判斷彼此咬合（不顯示 chip 就選不到表單，
 * 選不到表單就沒有範例提示），單獨看各自都「合理」、湊在一起才出事，值得獨立測試。
 * 與 knowledgePrompt.ts 同理——App 元件太肥、渲染成本高，不適合當測試入口。
 */

/**
 * 選單是否要出現。
 *
 * 門檻是「有東西可點」而非「表單多於一張」：先前用 formCount > 1（單張表單時選單多餘）
 * 配上「不預選」，讓只開通一張表單的租戶連 chip 都看不到、也就永遠選不到那張表單。
 */
export function shouldShowFormPicker(opts: {
  formCount: number;
  knowledgePromptCount: number;
}): boolean {
  return opts.formCount > 0 || opts.knowledgePromptCount > 0;
}

/**
 * 初始選取的表單：只認 embed 預選（?form=），其餘一律不預選。
 *
 * 單一表單曾經自動選取（怕該表單的範例提示永遠不出現），但那讓 chip 一進畫面就亮著、
 * 看起來像使用者已經挑過辦理項目。chip 現在只要 formCount > 0 就會顯示，
 * 使用者點一下即可拿到範例提示，不需要靠預選補救。
 */
export function pickInitialFormId(
  forms: { formId: string }[],
  preset: string | null,
): string | null {
  return preset && forms.some((f) => f.formId === preset) ? preset : null;
}
