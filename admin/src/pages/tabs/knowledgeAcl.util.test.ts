import { describe, it, expect } from 'vitest';
import {
  buildAclOnConfirmMessage,
  countFilesWithLabel,
  fileLabelState,
  isValidLabelId,
  kbScopeId,
  labelNameFor,
  needsAclOnConfirm,
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

describe('needsAclOnConfirm', () => {
  it('只有切到 on 需要二次確認', () => {
    expect(needsAclOnConfirm('on')).toBe(true);
    expect(needsAclOnConfirm('off')).toBe(false);
    expect(needsAclOnConfirm('shadow')).toBe(false);
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

describe('buildAclOnConfirmMessage', () => {
  it('列出未標記／明確清空的數字', () => {
    const msg = buildAclOnConfirmMessage({
      unlabeledCount: 3,
      explicitlyEmptyCount: 1,
      source: { configured: true, unlabeled: false },
    });
    expect(msg).toContain('未標記文件：3 份');
    expect(msg).toContain('明確清空文件：1 份');
    expect(msg).not.toContain('網站來源尚未標記');
  });
  it('來源未標記時附加網站來源警示，失效情境是「檔案 0 未標記」也要看到這句', () => {
    const msg = buildAclOnConfirmMessage({
      unlabeledCount: 0,
      explicitlyEmptyCount: 0,
      source: { configured: true, unlabeled: true },
    });
    expect(msg).toContain('未標記文件：0 份');
    expect(msg).toContain('網站來源尚未標記');
  });
  it('沒有設定來源時不附加來源警示', () => {
    const msg = buildAclOnConfirmMessage({
      unlabeledCount: 0,
      explicitlyEmptyCount: 0,
      source: { configured: false, unlabeled: true },
    });
    expect(msg).not.toContain('網站來源尚未標記');
  });
});
