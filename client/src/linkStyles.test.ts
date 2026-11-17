/**
 * 回覆與欄位說明裡的連結必須看得出可以點。
 *
 * @hyagent/ui/index.css 有一條「未分層」的全域 `a { color: inherit; text-decoration: none }`。
 * CSS 的規則是未分層樣式永遠勝過任何 @layer 內的樣式（不看選擇器權重），所以連結樣式
 * 若寫在 @layer components 裡，顏色與底線一律被蓋掉——AI 回覆裡的網址看起來就是普通灰字。
 * 這裡鎖住：連結規則必須寫在 @layer 之外。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'index.css'), 'utf8');

/** 回傳選擇器第一次出現的位置所在的 @layer 名稱；不在任何 @layer 內回 null */
function layerOf(selector: string): string | null | undefined {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return undefined;
  const stack: (string | null)[] = [];
  const re = /@layer\s+([\w-]+)\s*\{|\{|\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) && m.index < at) {
    if (m[0] === '}') stack.pop();
    else stack.push(m[1] ?? null);
  }
  return stack.find((name) => name !== null) ?? null;
}

describe('連結樣式不放在 @layer 內（否則被 ui 的全域 a 重設蓋掉）', () => {
  it.each(['.md-body a', '.form-field-help a'])('%s 寫在 @layer 之外', (selector) => {
    expect(layerOf(selector)).toBeNull();
  });

  it('AI 回覆的連結有主色、底線，滑過時有變化，長網址會換行', () => {
    const at = css.indexOf('.md-body a {');
    const rule = css.slice(at, css.indexOf('}', at));
    expect(rule).toContain('color: var(--primary-color)');
    expect(rule).toContain('text-decoration-line: underline');
    expect(rule).toContain('overflow-wrap: anywhere');
    const hover = css.slice(css.indexOf('.md-body a:hover'), css.indexOf('}', css.indexOf('.md-body a:hover')));
    // ui 的全域 a:hover 會拿掉底線；滑過時要明寫保留
    expect(hover).toContain('text-decoration-line: underline');
  });
});
