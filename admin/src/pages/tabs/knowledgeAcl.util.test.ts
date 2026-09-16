import { describe, it, expect } from 'vitest';
import {
  countFilesWithLabel,
  guestCorpusState,
  fileLabelState,
  isValidLabelId,
  kbScopeId,
  labelNameFor,
  sourceNeedsAclWarning,
  stripKbPrefix,
} from './knowledgeAcl.util';

describe('kbScopeId / stripKbPrefix', () => {
  it('往返一致', () => {
    expect(kbScopeId('hr')).toBe('kb:hr');
    expect(stripKbPrefix('kb:hr')).toBe('hr');
  });
  it('stripKbPrefix 對非 kb: 開頭原樣回傳（防禦性）', () => {
    expect(stripKbPrefix('hr')).toBe('hr');
  });
});

describe('isValidLabelId', () => {
  it('允許小寫英數與連字號', () => {
    expect(isValidLabelId('hr')).toBe(true);
    expect(isValidLabelId('hr-2024')).toBe(true);
  });
  it('拒絕大寫、冒號、空白、空字串', () => {
    expect(isValidLabelId('HR')).toBe(false);
    expect(isValidLabelId('hr:x')).toBe(false);
    expect(isValidLabelId('h r')).toBe(false);
    expect(isValidLabelId('')).toBe(false);
  });
});

describe('labelNameFor', () => {
  const labels = [{ id: 'hr', label: '人資' }];
  it('找得到時回傳顯示名稱', () => {
    expect(labelNameFor(labels, 'kb:hr')).toBe('人資');
  });
  it('標籤已被刪除（孤兒 scope）時退回 labelId，不留空白', () => {
    expect(labelNameFor(labels, 'kb:deleted')).toBe('deleted');
  });
});

describe('countFilesWithLabel', () => {
  it('只算掛了該標籤的檔案', () => {
    const files = [
      { visibilityScopes: ['kb:hr'] },
      { visibilityScopes: ['kb:hr', 'kb:it'] },
      { visibilityScopes: ['kb:it'] },
      { visibilityScopes: undefined },
    ];
    expect(countFilesWithLabel(files, 'hr')).toBe(2);
    expect(countFilesWithLabel(files, 'it')).toBe(2);
    expect(countFilesWithLabel(files, 'finance')).toBe(0);
  });
});

describe('fileLabelState', () => {
  it('undefined＝unlabeled（待辦）', () => {
    expect(fileLabelState(undefined)).toBe('unlabeled');
  });
  it('空陣列＝empty（已決定清空，不同於 unlabeled）', () => {
    expect(fileLabelState([])).toBe('empty');
  });
  it('非空陣列＝labeled', () => {
    expect(fileLabelState(['kb:hr'])).toBe('labeled');
  });
});


describe('sourceNeedsAclWarning', () => {
  it('未設定來源時不警示，即使 unlabeled 是 true', () => {
    expect(sourceNeedsAclWarning({ configured: false, unlabeled: true })).toBe(false);
  });
  it('有設定來源且未標記時才警示', () => {
    expect(sourceNeedsAclWarning({ configured: true, unlabeled: true })).toBe(true);
  });
  it('有設定來源但已標記則不警示', () => {
    expect(sourceNeedsAclWarning({ configured: true, unlabeled: false })).toBe(false);
  });
});


describe('guestCorpusState：公開推薦詞卡在哪一關', () => {
  it('訪客沒有任何標籤 → no-grant，即使來源與檔案都已標好', () => {
    // 這是實際踩過的狀態：標籤全標好、盤點面板全綠，推薦詞仍固定回 422
    expect(guestCorpusState({ scopes: [], source: true, files: 3 })).toBe('no-grant');
  });
  it('訪客有標籤但沒有語料掛在上面 → no-corpus', () => {
    expect(guestCorpusState({ scopes: ['kb:public'], source: false, files: 0 })).toBe('no-corpus');
  });
  it('網站來源對訪客可見 → ok（檔案一份都沒有也算）', () => {
    expect(guestCorpusState({ scopes: ['kb:public'], source: true, files: 0 })).toBe('ok');
  });
  it('只有檔案對訪客可見 → ok（沒設定網站來源的純檔案 RAG 租戶）', () => {
    expect(guestCorpusState({ scopes: ['kb:public'], source: false, files: 2 })).toBe('ok');
  });
});
