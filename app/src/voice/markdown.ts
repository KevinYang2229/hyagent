/** 朗讀前去掉 markdown 符號；表格列整行不唸（表格本來就不唸）。 */
export function stripMarkdown(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l))
    .map((l) =>
      l
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*(?:[-*•]|\d+\.)\s+/, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}
