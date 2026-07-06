/* 執行：npx tsx scripts/knowledge-ingest.ts [startUrl] [maxPages] [tenantId] */
import { env } from "../src/config/env";
import { runIngest } from "../src/modules/knowledge/ingest.service";

const startUrl = process.argv[2] ?? "https://hyweb-oa-react-five.vercel.app/";
const maxPages = Number(process.argv[3] ?? 100);
const tenantId = process.argv[4] ?? "default";

(async () => {
  if (!env.OPENAI_API_KEY) {
    console.error("缺 OPENAI_API_KEY");
    process.exit(1);
  }
  const idx = await runIngest(
    {
      tenantId,
      startUrl,
      maxPages,
      chunkChars: 800,
      embeddingModel: env.EMBEDDING_MODEL,
    },
    (p) => console.log(p.phase, p.pagesCrawled, p.embedded, "/", p.chunks),
  );
  console.log(`完成：${idx.chunks.length} chunks（租戶 ${tenantId}）`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
