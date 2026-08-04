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
 * 初始選取的表單：embed 預選（?form=）優先，其次單一表單自動選取。
 * 多張表單時維持不預選，讓使用者自己挑辦理項目。
 */
export function pickInitialFormId(
  forms: { formId: string }[],
  preset: string | null,
): string | null {
  if (preset && forms.some((f) => f.formId === preset)) return preset;
  return forms.length === 1 ? forms[0]!.formId : null;
}
