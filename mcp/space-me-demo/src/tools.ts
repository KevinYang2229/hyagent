import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HyAgentCaller } from '@hyagent/mcp-kit';
import type { RealtimeSource, Snapshot } from './data';

const id = z.string().trim().min(1).max(80);
export const INPUTS = {
  spaceme_realtime_overview: z.object({ siteId: id.optional().describe('場域 ID；library 或 office；省略查全部') }).strict(),
  spaceme_space_status: z.object({
    siteId: id.optional().describe('場域 ID'),
    keyword: z.string().trim().min(1).max(100).optional().describe('空間名稱、ID 或樓層關鍵字'),
    type: z.enum(['discussion', 'study', 'seating', 'meeting', 'office']).optional().describe('空間類型'),
    status: z.enum(['available', 'occupied', 'maintenance']).optional().describe('可使用、使用中、維護中'),
  }).strict(),
  spaceme_environment: z.object({ siteId: id.optional().describe('場域 ID'), spaceId: id.optional().describe('空間 ID；可先查空間狀態取得') }).strict(),
  spaceme_announcements: z.object({ siteId: id.optional().describe('場域 ID'), priority: z.enum(['normal', 'urgent']).optional().describe('公告優先等級') }).strict(),
};
export type ToolName = keyof typeof INPUTS;
export const TITLES: Record<ToolName, string> = {
  spaceme_realtime_overview: 'SpaceMe 即時資訊總覽',
  spaceme_space_status: '查詢空間使用狀態',
  spaceme_environment: '查詢空間環境數據',
  spaceme_announcements: '查詢有效公告',
};
export const DESCRIPTIONS: Record<ToolName, string> = {
  spaceme_realtime_overview: '顯示場域、空間數、可使用空間與空位、環境感測器狀態及有效公告數。預設是每分鐘更新的示範資料，不是真實場域；必須告知使用者資料來源與時間。',
  spaceme_space_status: '查詢圖書館或辦公空間目前狀態、容量、使用人數與可用席位，可依場域、空間類型、狀態與名稱篩選。維護中的空間不提供空位；結果不是預約保證。',
  spaceme_environment: '取得空間溫度（°C）、濕度（%）、CO₂（ppm）與感測器上線狀態。離線感測器數據是 null，不可宣稱為即時讀值。預設為模擬資料。',
  spaceme_announcements: '查詢目前已生效且未過期的公告，優先列出緊急公告；有效區間為 startsAt <= 現在 < endsAt。預設為示範公告。',
};
const STATUS = { available: '可使用', occupied: '使用中', maintenance: '維護中' };
const TYPE = { discussion: '討論室', study: '研究小間', seating: '座位區', meeting: '會議室', office: '辦公區' };
const error = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });
const table = (title: string, rows: string, columns: Array<{ key: string; label: string; unit?: string }>) => ({ type: 'table', title, rows, columns });
function result(snapshot: Snapshot, now: Date, data: Record<string, unknown>, display?: ReturnType<typeof table>): CallToolResult {
  const structuredContent = {
    ...data, source: snapshot.source, isDemo: snapshot.source === 'demo',
    notice: snapshot.source === 'demo' ? '示範資料，每分鐘模擬更新；不代表真實場域或感測器讀值' : 'API 資料；請依觀測時間判斷新鮮度',
    observedAt: snapshot.observedAt, queriedAt: now.toISOString(), timeZone: 'Asia/Taipei',
  };
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, ...(display ? { _meta: { 'hyagent/display': display } } : {}) };
}

export async function callRealtimeTool(name: string, input: unknown, context: { source: RealtimeSource; caller: HyAgentCaller; now: Date }): Promise<CallToolResult> {
  if (!Object.hasOwn(INPUTS, name)) return error('未知的 SpaceMe 工具');
  if (context.caller.system) return error('查詢即時資訊需要使用者身分');
  const parsed = INPUTS[name as ToolName].safeParse(input);
  if (!parsed.success) return error('查詢參數不合法，請使用工具宣告的欄位與有效值');
  let snapshot: Snapshot;
  try { snapshot = await context.source.snapshot({ caller: context.caller, now: context.now }); }
  catch { return error('即時資訊來源暫時無法使用，請稍後重試'); }
  const args = parsed.data;
  if (args.siteId && !snapshot.spaces.some((s) => s.siteId === args.siteId)) return error('找不到指定場域，請先查詢即時資訊總覽取得場域 ID');
  const spaces = snapshot.spaces.filter((s) => !args.siteId || s.siteId === args.siteId);
  const active = snapshot.announcements.filter((a) => (!args.siteId || a.siteId === args.siteId)
    && Date.parse(a.startsAt) <= context.now.getTime() && context.now.getTime() < Date.parse(a.endsAt));

  if (name === 'spaceme_realtime_overview') {
    const items = [...new Set(spaces.map((s) => s.siteId))].map((siteId) => {
      const siteSpaces = spaces.filter((s) => s.siteId === siteId);
      const sensors = snapshot.environment.filter((e) => e.siteId === siteId);
      return {
        siteId, siteName: siteSpaces[0].siteName, totalSpaces: siteSpaces.length,
        availableSpaces: siteSpaces.filter((s) => s.status === 'available').length,
        occupiedSpaces: siteSpaces.filter((s) => s.status === 'occupied').length,
        maintenanceSpaces: siteSpaces.filter((s) => s.status === 'maintenance').length,
        availableSeats: siteSpaces.reduce((sum, s) => sum + (s.status === 'available' ? Math.max(0, s.capacity - s.occupied) : 0), 0),
        onlineSensors: sensors.filter((e) => e.sensorStatus === 'online').length,
        offlineSensors: sensors.filter((e) => e.sensorStatus === 'offline').length,
        activeAnnouncements: active.filter((a) => a.siteId === siteId).length,
      };
    });
    return result(snapshot, context.now, { items }, table('即時資訊總覽（含來源時間）', 'items', [
      { key: 'siteName', label: '場域' }, { key: 'availableSpaces', label: '可使用空間' }, { key: 'availableSeats', label: '可用席位' },
      { key: 'maintenanceSpaces', label: '維護中' }, { key: 'offlineSensors', label: '離線感測器' }, { key: 'activeAnnouncements', label: '有效公告' },
    ]));
  }
  if (name === 'spaceme_space_status') {
    const filters = INPUTS.spaceme_space_status.parse(input);
    const items = spaces.filter((s) => (!filters.type || s.type === filters.type) && (!filters.status || s.status === filters.status)
      && (!filters.keyword || `${s.name} ${s.id} ${s.floor}`.toLowerCase().includes(filters.keyword.toLowerCase())))
      .map((s) => ({ ...s, statusLabel: STATUS[s.status], typeLabel: TYPE[s.type], availableSeats: s.status === 'available' ? Math.max(0, s.capacity - s.occupied) : 0 }));
    return result(snapshot, context.now, { items }, table('空間使用狀態', 'items', [
      { key: 'id', label: '空間 ID' }, { key: 'name', label: '空間' }, { key: 'floor', label: '樓層' }, { key: 'statusLabel', label: '狀態' },
      { key: 'capacity', label: '容量' }, { key: 'occupied', label: '使用人數' }, { key: 'availableSeats', label: '可用席位' }, { key: 'observedAt', label: '觀測時間' },
    ]));
  }
  if (name === 'spaceme_environment') {
    const { spaceId } = INPUTS.spaceme_environment.parse(input);
    if (spaceId && !spaces.some((s) => s.id === spaceId)) return error('找不到指定空間，或該空間不屬於指定場域');
    const items = snapshot.environment.filter((e) => (!args.siteId || e.siteId === args.siteId) && (!spaceId || e.spaceId === spaceId))
      .map((e) => ({ ...e, sensorStatusLabel: e.sensorStatus === 'online' ? '上線' : '離線' }));
    return result(snapshot, context.now, { items }, table('環境數據', 'items', [
      { key: 'spaceName', label: '空間' }, { key: 'temperatureC', label: '溫度', unit: '°C' }, { key: 'humidityPercent', label: '濕度', unit: '%' },
      { key: 'co2Ppm', label: 'CO₂', unit: 'ppm' }, { key: 'sensorStatusLabel', label: '感測器' }, { key: 'observedAt', label: '觀測時間' },
    ]));
  }
  const { priority } = INPUTS.spaceme_announcements.parse(input);
  const items = active.filter((a) => !priority || a.priority === priority)
    .sort((a, b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent') || b.startsAt.localeCompare(a.startsAt))
    .map((a) => ({ ...a, priorityLabel: a.priority === 'urgent' ? '緊急' : '一般' }));
  return result(snapshot, context.now, { items }, table('有效公告', 'items', [
    { key: 'title', label: '公告' }, { key: 'content', label: '內容' }, { key: 'priorityLabel', label: '優先等級' }, { key: 'endsAt', label: '有效截止' },
  ]));
}
