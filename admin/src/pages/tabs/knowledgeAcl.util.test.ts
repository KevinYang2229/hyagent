import { describe, it, expect } from 'vitest';
import {
  countFilesWithLabel,
  fileLabelState,
  isValidLabelId,
  kbScopeId,
  labelNameFor,
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
