import type { HyAgentCaller } from '@hyagent/mcp-kit';

export type SpaceStatus = 'available' | 'occupied' | 'maintenance';
export type SpaceType = 'discussion' | 'study' | 'seating' | 'meeting' | 'office';
export interface Space {
  id: string;
  siteId: string;
  siteName: string;
  name: string;
  type: SpaceType;
  floor: string;
  capacity: number;
  occupied: number;
  status: SpaceStatus;
  observedAt: string;
}
export interface Environment {
  spaceId: string;
  spaceName: string;
  siteId: string;
  temperatureC: number | null;
  humidityPercent: number | null;
  co2Ppm: number | null;
  sensorStatus: 'online' | 'offline';
  observedAt: string | null;
}
export interface Announcement {
  id: string;
  siteId: string;
  title: string;
  content: string;
  priority: 'normal' | 'urgent';
  startsAt: string;
  endsAt: string;
}
export interface Snapshot {
  source: 'demo' | 'api';
  observedAt: string;
  spaces: Space[];
  environment: Environment[];
  announcements: Announcement[];
}
/** 真實 API 實作必須以已驗證的 caller.tenantId 限制資料範圍，不接受工具輸入的租戶 ID。 */
export interface RealtimeSource {
  snapshot(context: { caller: HyAgentCaller; now: Date }): Promise<Snapshot>;
}

const SEEDS: Omit<Space, 'occupied' | 'observedAt'>[] = [
  { id: 'L-D01', siteId: 'library', siteName: '示範圖書館', name: '討論室 A', type: 'discussion', floor: '2F', capacity: 8, status: 'available' },
  { id: 'L-D02', siteId: 'library', siteName: '示範圖書館', name: '討論室 B', type: 'discussion', floor: '2F', capacity: 6, status: 'occupied' },
  { id: 'L-S01', siteId: 'library', siteName: '示範圖書館', name: '研究小間', type: 'study', floor: '3F', capacity: 1, status: 'available' },
  { id: 'L-SEAT', siteId: 'library', siteName: '示範圖書館', name: '自習室', type: 'seating', floor: '3F', capacity: 60, status: 'available' },
  { id: 'O-M01', siteId: 'office', siteName: '示範智慧辦公室', name: '會議室 A', type: 'meeting', floor: '5F', capacity: 12, status: 'available' },
  { id: 'O-M02', siteId: 'office', siteName: '示範智慧辦公室', name: '會議室 B', type: 'meeting', floor: '5F', capacity: 6, status: 'maintenance' },
  { id: 'O-SEAT', siteId: 'office', siteName: '示範智慧辦公室', name: '彈性辦公區', type: 'office', floor: '5F', capacity: 24, status: 'available' },
];

/** 每分鐘重新計算的模擬數據；不代表任何真實預約、門禁或感測器。 */
export function createDemoSource(): RealtimeSource {
  return {
    async snapshot({ now }) {
      const tick = Math.floor(now.getTime() / 60_000);
      const observedAt = new Date(tick * 60_000).toISOString();
      const phase = ((tick % 4) + 4) % 4;
      const spaces = SEEDS.map((seed, index): Space => {
        const status = seed.id === 'L-D01' && phase % 2 === 1 ? 'occupied' : seed.status;
        const occupied = status === 'maintenance' ? 0 : status === 'occupied' ? seed.capacity
          : seed.type === 'seating' || seed.type === 'office' ? Math.min(seed.capacity, Math.floor(seed.capacity * 0.45) + phase + index) : 0;
        return { ...seed, status, occupied, observedAt };
      });
      const environment = spaces.map((space, index): Environment => {
        const offline = space.status === 'maintenance';
        return {
          spaceId: space.id, spaceName: space.name, siteId: space.siteId,
          temperatureC: offline ? null : Number((23.5 + (index % 3) * 0.6 + phase * 0.1).toFixed(1)),
          humidityPercent: offline ? null : 48 + index + phase,
          co2Ppm: offline ? null : 550 + space.occupied * 15 + phase * 10,
          sensorStatus: offline ? 'offline' : 'online', observedAt: offline ? null : observedAt,
        };
      });
      const dayStart = Math.floor((now.getTime() + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000;
      const at = (days: number) => new Date(dayStart + days * 86_400_000).toISOString();
      return {
        source: 'demo', observedAt, spaces, environment,
        announcements: [
          { id: 'A-LIB', siteId: 'library', title: '空間使用提醒', content: '討論室使用完畢請保持整潔，離開前確認個人物品。', priority: 'normal', startsAt: at(-1), endsAt: at(1) },
          { id: 'A-OFFICE', siteId: 'office', title: '會議室 B 維護中', content: '會議室 B 暫停使用，請改用會議室 A。', priority: 'urgent', startsAt: at(0), endsAt: at(1) },
          { id: 'A-EXPIRED', siteId: 'library', title: '已結束的展示', content: '昨日展示活動已結束。', priority: 'normal', startsAt: at(-2), endsAt: at(0) },
          { id: 'A-FUTURE', siteId: 'office', title: '明日展示', content: '明日起安排智慧辦公空間展示。', priority: 'normal', startsAt: at(1), endsAt: at(2) },
        ],
      };
    },
  };
}
