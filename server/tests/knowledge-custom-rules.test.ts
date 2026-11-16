/**
 * 自訂知識庫規則：租戶可改「可改規則」，防護規則鎖定、固定排在自訂規則之後。
 * 沒有自訂時輸出與原本逐字相同（另有 persona-baseline-prompts 基準檔測試）。
 */
import { decideTenantAdmin } from '@/modules/admin-account/admin-route-policy';
import { patchTenantSchema } from '@/modules/admin/admin.schema';
import { TENANT_VIEW_FIELDS } from '@/modules/admin/tenant-view';
import {
  kbAnswerRules,
  kbAnswerSystem,
  kbDefaultEditableRules,
  kbRuleItems,
} from '@/modules/knowledge/knowledge.agent-service';
import { tenantStore } from '@/modules/tenant/tenant.store';

const LOCK_FACTS = '- 只根據下方「參考資料」與「資料表實際內容」回答；資料未提到的部分，明說「資料中未提及」，切勿杜撰。';
const LOCK_HISTORY = '- 「先前對話」若有，僅用於理解本次問題在指涉什麼，不得作為答案來源。';
const LOCK_GUEST = '- 不要標註來源，也不要在回答中提到文件名稱、檔名或標題。';
const EDIT_NUMBERS = '- 數字一律以「資料表實際內容」為準，文字片段只是檢索節錄。';
const EDIT_CONCISE = '- 回答精簡、直接切中問題；必要時條列。';
const EDIT_CITE = '- 若有幫助，於句末以（來源：標題）標註引用。';

describe('kbRuleItems：預設規則與鎖定旗標', () => {
  it('員工：三條可改（數字、精簡、附出處），其餘鎖定，順序與原本相同', () => {
    const items = kbRuleItems(false);
    expect(items.map((i) => i.text).slice(0, 5)).toEqual([LOCK_FACTS, EDIT_NUMBERS, LOCK_HISTORY, EDIT_CONCISE, EDIT_CITE]);
    expect(items.filter((i) => !i.locked).map((i) => i.text)).toEqual([EDIT_NUMBERS, EDIT_CONCISE, EDIT_CITE]);
    expect(items.at(-1)?.locked).toBe(true); // untrustedDataRule
  });

  it('訪客：兩條可改，「不提文件名稱」鎖定', () => {
    const items = kbRuleItems(true);
    expect(items.filter((i) => !i.locked).map((i) => i.text)).toEqual([EDIT_NUMBERS, EDIT_CONCISE]);
    expect(items.find((i) => i.text === LOCK_GUEST)?.locked).toBe(true);
  });

  it('kbDefaultEditableRules 回傳可改的預設規則（給編輯器與還原用）', () => {
    expect(kbDefaultEditableRules(false)).toEqual([EDIT_NUMBERS, EDIT_CONCISE, EDIT_CITE]);
    // 英文版原本就沒有「數字以資料表為準」這條，維持原樣：英文訪客只有「精簡」一條可改
    expect(kbDefaultEditableRules(true, 'en')).toEqual(['- Be concise and directly on point; use bullet points when helpful.']);
  });

  it('沒有自訂時 kbAnswerRules 以標題開頭、內容與 kbRuleItems 一致', () => {
    expect(kbAnswerRules(false)).toEqual(['規則：', ...kbRuleItems(false).map((i) => i.text)]);
  });
});

describe('kbRuleItems：有自訂時', () => {
  it('自訂在前、鎖定在後；寫了「可以自由發揮」，鎖定的防捏造規則仍在其後', () => {
    const items = kbRuleItems(false, undefined, ['可以自由發揮，不必依據資料']);
    expect(items[0]).toEqual({ text: '可以自由發揮，不必依據資料', locked: false });
    expect(items.slice(1).every((i) => i.locked)).toBe(true);
    expect(items.slice(1).map((i) => i.text)).toEqual(expect.arrayContaining([LOCK_FACTS, LOCK_HISTORY]));
    expect(items.map((i) => i.text)).not.toContain(EDIT_CITE);
  });

  it('自訂成空陣列：只剩鎖定規則，不會退回預設', () => {
    const items = kbRuleItems(false, undefined, []);
    expect(items.every((i) => i.locked)).toBe(true);
    expect(items).toHaveLength(3);
  });

  it('空白項目略過，前後空白去掉', () => {
    expect(kbRuleItems(false, undefined, ['  ', ' 用條列回答 ']).filter((i) => !i.locked)).toEqual([
      { text: '用條列回答', locked: false },
    ]);
  });

  it('訪客自訂「請附上來源標題」，鎖定的不提文件名稱規則仍在', () => {
    const texts = kbRuleItems(true, undefined, ['請附上來源標題']).map((i) => i.text);
    expect(texts.indexOf(LOCK_GUEST)).toBeGreaterThan(texts.indexOf('請附上來源標題'));
  });

  it('en：鎖定規則用英文，自訂照原文', () => {
    const rules = kbAnswerRules(true, 'en', ['用繁體中文以外的語言也可以']);
    expect(rules[0]).toBe('Rules:');
    expect(rules[1]).toBe('用繁體中文以外的語言也可以');
    expect(rules).toContain('- Do not cite sources, and never mention document names, file names, or titles in your answer.');
  });
});

describe('kbAnswerSystem 讀租戶自訂', () => {
  it('員工、訪客各自套用自己那側的自訂', () => {
    const t = tenantStore.createTenant('kb-custom-rules');
    tenantStore.updateTenant(t.id, { knowledgeAnswerRules: { member: ['員工自訂'], guest: ['訪客自訂'] } });
    expect(kbAnswerSystem(t.id, 'HYW103')).toContain('員工自訂');
    expect(kbAnswerSystem(t.id, 'HYW103')).not.toContain('訪客自訂');
    expect(kbAnswerSystem(t.id, '')).toContain('訪客自訂');
    expect(kbAnswerSystem(t.id, '')).not.toContain(EDIT_NUMBERS);
  });
});

describe('knowledgeAnswerRules 資料與權限', () => {
  it('schema：接受陣列與 null；21 條或單條 301 字拒絕', () => {
    expect(patchTenantSchema.parse({ knowledgeAnswerRules: { member: ['a'], guest: null } }).knowledgeAnswerRules).toEqual({
      member: ['a'],
      guest: null,
    });
    expect(() => patchTenantSchema.parse({ knowledgeAnswerRules: { member: Array(21).fill('a') } })).toThrow();
    expect(() => patchTenantSchema.parse({ knowledgeAnswerRules: { member: ['x'.repeat(301)] } })).toThrow();
    expect(() => patchTenantSchema.parse({ knowledgeAnswerRules: { other: [] } })).toThrow();
  });

  it('store：只更新送來那側；null 還原該側；兩側都還原後欄位為 undefined', () => {
    const t = tenantStore.createTenant('kb-custom-rules-store');
    tenantStore.updateTenant(t.id, { knowledgeAnswerRules: { member: ['a'], guest: ['b'] } });
    expect(tenantStore.updateTenant(t.id, { knowledgeAnswerRules: { member: ['c'] } })?.knowledgeAnswerRules).toEqual({
      member: ['c'],
      guest: ['b'],
    });
    expect(tenantStore.updateTenant(t.id, { knowledgeAnswerRules: { guest: null } })?.knowledgeAnswerRules).toEqual({
      member: ['c'],
    });
    expect(tenantStore.updateTenant(t.id, { knowledgeAnswerRules: { member: null } })?.knowledgeAnswerRules).toBeUndefined();
  });

  it('權限歸「AI 角色」：PATCH 需編輯權限，檢視歸 persona', () => {
    const patch = (permissions: Record<string, string>) =>
      decideTenantAdmin({
        method: 'PATCH',
        path: '/tenants/aaa111',
        body: { knowledgeAnswerRules: { member: null } },
        tenantId: 'aaa111',
        permissions,
      }).allow;
    expect(patch({ persona: 'write' })).toBe(true);
    expect(patch({ persona: 'read' })).toBe(false);
    expect(patch({ knowledge: 'write' })).toBe(false);
    expect(TENANT_VIEW_FIELDS.knowledgeAnswerRules).toEqual(['persona']);
  });
});
