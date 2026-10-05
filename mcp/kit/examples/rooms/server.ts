/**
 * 範例：會議室 MCP server（一讀一寫）。示範：
 *  - 欄位一律寫 describe（會成為 HyAgent 確認卡片的標籤）
 *  - 讀工具標 readOnlyHint: true；寫工具不標（HyAgent 視為寫入、需使用者確認）
 *  - 回傳直接回答問題，不要丟整張表讓模型推
 * 執行：HYAGENT_JWKS_URL=http://localhost:3000/.well-known/hyagent-mcp-jwks.json \
 *       MCP_SERVER_ID=rooms PORT=4100 npm run example:rooms -w mcp/kit
 */
import { z } from 'zod';
import { callerFrom, createHyAgentVerifier, createMcpHttpApp } from '../../src';

const ROOMS = ['大會議室 A', '小會議室 B', '視訊室 C'] as const;
const FREE: Record<(typeof ROOMS)[number], string[]> = {
  '大會議室 A': ['09:00-10:00', '14:00-16:00'],
  '小會議室 B': ['10:00-12:00', '15:00-17:00'],
  '視訊室 C': ['13:00-14:00'],
};
const bookings: { id: string; room: string; date: string; start: string; end: string; title: string; by: string }[] = [];

function inPeriod(slot: string, period: 'morning' | 'afternoon' | 'all'): boolean {
  const startHour = Number(slot.slice(0, 2));
  if (period === 'morning') return startHour < 12;
  if (period === 'afternoon') return startHour >= 12;
  return true;
}

const verifier = createHyAgentVerifier({
  jwksUrl: process.env.HYAGENT_JWKS_URL ?? 'http://localhost:3000/.well-known/hyagent-mcp-jwks.json',
  audience: process.env.MCP_SERVER_ID ?? 'rooms',
  rejectReplay: true,
});

const app = createMcpHttpApp({
  name: 'rooms',
  version: '0.1.0',
  verifier,
  register(server) {
    server.registerTool(
      'rooms_availability',
      {
        title: '查詢會議室空檔',
        description: '查詢指定日期、時段（上午／下午／整天）各會議室的空閒時段；有指定會議室時只回該間。',
        inputSchema: {
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('日期（YYYY-MM-DD）'),
          period: z.enum(['morning', 'afternoon', 'all']).default('all').describe('時段'),
          room: z.enum(ROOMS).optional().describe('會議室'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ date, period, room }) => {
        const rooms = room ? [room] : [...ROOMS];
        const available = rooms
          .map((r) => ({ room: r, slots: FREE[r].filter((s) => inPeriod(s, period)) }))
          .filter((r) => r.slots.length > 0);
        const data = { date, period, available, anyAvailable: available.length > 0 };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      },
    );

    server.registerTool(
      'rooms_book',
      {
        title: '預約會議室',
        description: '預約指定會議室的時段。時段必須在該會議室的空閒時段內。',
        inputSchema: {
          room: z.enum(ROOMS).describe('會議室'),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('日期（YYYY-MM-DD）'),
          start: z.string().regex(/^\d{2}:\d{2}$/).describe('開始時間（HH:MM）'),
          end: z.string().regex(/^\d{2}:\d{2}$/).describe('結束時間（HH:MM）'),
          title: z.string().min(1).describe('會議名稱'),
        },
      },
      async ({ room, date, start, end, title }, extra) => {
        const caller = callerFrom(extra);
        const fits = FREE[room].some((slot) => {
          const [s, e] = slot.split('-');
          return start >= s && end <= e && start < end;
        });
        if (!fits) {
          return { isError: true, content: [{ type: 'text', text: `${room} 在 ${date} ${start}-${end} 沒有空` }] };
        }
        const booking = { id: `B-${bookings.length + 1}`, room, date, start, end, title, by: caller.userId };
        bookings.push(booking);
        return { content: [{ type: 'text', text: JSON.stringify(booking) }], structuredContent: booking };
      },
    );
  },
});

const port = Number(process.env.PORT ?? 4100);
app.listen(port, () => console.log(`rooms MCP server on http://localhost:${port}/mcp`));
