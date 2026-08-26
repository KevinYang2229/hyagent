/*
 * 知識庫檢索精準度評測：對評測集逐題跑 staticIndexRetriever，計算 hit@1/3/5 與 MRR。
 *
 * 需要已產生的 knowledge-index.json 與 OPENAI_API_KEY（query embedding）。
 * 評測集格式見 data/knowledge-eval.example.json；relevant 以 URL 片段比對。
 *
 * 執行：
 *   npx tsx scripts/knowledge-eval.ts [evalSetPath]
 *   （預設 data/knowledge-eval.json）
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hitAtK, mean, reciprocalRank } from '../src/modules/knowledge/eval.metrics';
import { staticIndexRetriever } from '../src/modules/knowledge/retriever.staticIndex';

interface EvalCase {
  question: string;
  expectUrlIncludes: string[];
}

const EVAL_PATH = resolve(process.cwd(), process.argv[2] ?? 'data/knowledge-eval.json');

function loadCases(): EvalCase[] {
  if (!existsSync(EVAL_PATH)) {
    console.error(`找不到評測集：${EVAL_PATH}（可複製 data/knowledge-eval.example.json）`);
    process.exit(1);
  }
  const parsed = JSON.parse(readFileSync(EVAL_PATH, 'utf8')) as { cases: EvalCase[] };
  return parsed.cases ?? [];
}

async function main(): Promise<void> {
  const cases = loadCases();
  console.log(`評測 ${cases.length} 題（索引來源見 KNOWLEDGE_INDEX_DIR 下的租戶索引檔）\n`);

  const rr: number[] = [];
  const h1: number[] = [];
  const h3: number[] = [];
  const h5: number[] = [];

  for (const c of cases) {
    const hits = await staticIndexRetriever.search({ tenantId: 'eval', userId: 'eval' }, c.question);
    // 命中名次（1-based）：檢索片段 URL 含任一 expect 片段者
    const hitRanks = hits
      .map((h, i) => (c.expectUrlIncludes.some((sub) => h.url?.toLowerCase().includes(sub.toLowerCase())) ? i + 1 : 0))
      .filter((r) => r > 0);

    rr.push(reciprocalRank(hitRanks));
    h1.push(hitAtK(hitRanks, 1));
    h3.push(hitAtK(hitRanks, 3));
    h5.push(hitAtK(hitRanks, 5));

    const flag = hitRanks.length ? `✓ rank ${Math.min(...hitRanks)}` : '✗ 未命中';
    console.log(`  ${flag}  ${c.question}`);
  }

  console.log('\n=== 彙總 ===');
  console.log(`hit@1 : ${(mean(h1) * 100).toFixed(1)}%`);
  console.log(`hit@3 : ${(mean(h3) * 100).toFixed(1)}%`);
  console.log(`hit@5 : ${(mean(h5) * 100).toFixed(1)}%`);
  console.log(`MRR   : ${mean(rr).toFixed(3)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
