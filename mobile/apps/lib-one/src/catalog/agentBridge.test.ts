import { askAboutProduct, askToCompare, compareCell, compareRows, parseCompareIds, productsMentioned } from './agentBridge';
import { getProduct } from './catalog';

describe('productsMentioned', () => {
  it('依回覆中出現的順序列出產品、不重複', () => {
    const text = '推薦「智慧預約取書櫃」，另外直立式自助借還書機與桌上型自助借還書機也適合；直立式適合大館。';
    expect(productsMentioned(text).map((p) => p.id)).toEqual(['pickup-locker', 'kiosk', 'desktop-kiosk']);
  });

  it('英文名稱不分大小寫', () => {
    expect(productsMentioned('The self-service kiosk supports RFID.').map((p) => p.id)).toEqual(['kiosk']);
  });

  it('名稱有包含關係時只算長的那個', () => {
    expect(productsMentioned('Desktop Self-Service Kiosk 與 Desktop Space Kiosk').map((p) => p.id)).toEqual(['desktop-kiosk', 'desktop-space-kiosk']);
    expect(productsMentioned('Space Kiosk 和 Desktop Space Kiosk 都可以').map((p) => p.id)).toEqual(['space-kiosk', 'desktop-space-kiosk']);
  });

  it('沒有提到產品時回空陣列', () => {
    expect(productsMentioned('您好，請問館舍規模多大？')).toEqual([]);
  });
});

describe('比較', () => {
  it('parseCompareIds 略過不存在與重複的 id，最多三項', () => {
    expect(parseCompareIds('kiosk,nope,kiosk,desktop-kiosk').map((p) => p.id)).toEqual(['kiosk', 'desktop-kiosk']);
    expect(parseCompareIds(['kiosk', 'desktop-kiosk', 'pickup-locker', 'charging-cabinet'])).toHaveLength(3);
    expect(parseCompareIds(undefined)).toEqual([]);
  });

  it('compareCell：true 顯示勾、false／缺少顯示無、字串照寫', () => {
    expect(compareCell(true)).toEqual({ kind: 'yes' });
    expect(compareCell(false)).toEqual({ kind: 'no' });
    expect(compareCell(undefined)).toEqual({ kind: 'no' });
    expect(compareCell('小巧')).toEqual({ kind: 'text', text: '小巧' });
  });

  it('compareRows 只列出至少一項產品有寫的欄位', () => {
    const rows = compareRows(parseCompareIds('workstation,rfid-workstation')).map((r) => r.key);
    expect(rows).toEqual(['category', 'form', 'rfid', 'barcode']);
  });
});

it('問 HyAgent 的句子帶入產品名稱', () => {
  const kiosk = getProduct('kiosk')!;
  const desk = getProduct('desktop-kiosk')!;
  expect(askAboutProduct(kiosk)).toContain('直立式自助借還書機');
  expect(askToCompare([kiosk, desk])).toContain('「直立式自助借還書機」、「桌上型自助借還書機」');
});
