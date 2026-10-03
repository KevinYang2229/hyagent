/**
 * 影像辨識效果檢視（Demo 前調校提示詞用；會呼叫真實 LLM 與門市 MCP，產生費用）。
 *
 * 用法（server/ 目錄）：
 *   DATA_BACKEND=file MCP_SIGNING_KEY="<私鑰>" npx tsx scripts/vision-eval.ts <照片資料夾> <shelf|coupon> [租戶id] [使用者id]
 * 輸出：<照片資料夾>/vision-eval.html（每張照片疊上框選與結果 JSON）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { initMcpStore } from '@/modules/mcp/mcp.store';
import { analyzeCoupon, analyzeShelf } from '@/modules/vision/vision.service';
import type { VisionMediaType } from '@/modules/vision/vision.types';

const MIME: Record<string, VisionMediaType> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const COLOR: Record<string, string> = { out_of_stock: '#dc2626', expiring: '#f59e0b', misplaced: '#7c3aed', ok: '#16a34a' };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

async function main(): Promise<void> {
  const [dir, mode, tenantId = 'default', userId = 'kevin'] = process.argv.slice(2);
  if (!dir || (mode !== 'shelf' && mode !== 'coupon')) {
    console.error('用法：npx tsx scripts/vision-eval.ts <照片資料夾> <shelf|coupon> [租戶id] [使用者id]');
    process.exit(1);
  }
  await initMcpStore();
  const files = fs.readdirSync(dir).filter((f) => MIME[path.extname(f).toLowerCase()]);
  const sections: string[] = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const image = { mediaType: MIME[path.extname(f).toLowerCase()], data: buf };
    const started = Date.now();
    try {
      const out = mode === 'shelf' ? await analyzeShelf({ tenantId, userId }, image) : await analyzeCoupon({ tenantId, userId }, image);
      const boxes = out.mode === 'shelf'
        ? out.findings.map((x) => `<div class="box" style="left:${x.box.x * 100}%;top:${x.box.y * 100}%;width:${x.box.w * 100}%;height:${x.box.h * 100}%;border-color:${COLOR[x.status]}"><span style="background:${COLOR[x.status]}">${esc(x.name)}</span></div>`).join('')
        : '';
      sections.push(`<section><h2>${esc(f)}（${Date.now() - started}ms）</h2><div class="wrap"><img src="data:${image.mediaType};base64,${buf.toString('base64')}">${boxes}</div><pre>${esc(JSON.stringify(out, null, 2))}</pre></section>`);
      console.log(`✓ ${f}`);
    } catch (err) {
      sections.push(`<section><h2>${esc(f)}</h2><pre>錯誤：${esc((err as Error).message)}</pre></section>`);
      console.log(`✗ ${f}：${(err as Error).message}`);
    }
  }
  const html = `<!doctype html><meta charset="utf-8"><title>vision-eval</title><style>body{font-family:sans-serif;margin:24px}section{margin-bottom:40px}.wrap{position:relative;display:inline-block;max-width:900px}.wrap img{max-width:900px;display:block}.box{position:absolute;border:3px solid}.box span{color:#fff;font-size:12px;padding:1px 4px;position:absolute;top:-18px;left:-3px;white-space:nowrap}pre{background:#f4f4f5;padding:12px;max-width:900px;overflow:auto}</style>${sections.join('')}`;
  const out = path.join(dir, 'vision-eval.html');
  fs.writeFileSync(out, html);
  console.log(`輸出：${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
