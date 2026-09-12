import { tenantStore } from '@/modules/tenant/tenant.store';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { promptAclFingerprint, publicPromptSlots } from '@/modules/knowledge/prompt-visibility';
import { currentChunkScopes } from '@/modules/knowledge/knowledge.visibility';

it('current file and website metadata overrides revoked labels in a cached index', () => {
  const tid = tenantStore.createTenant('live-acl').id;
  const chunk = { fileId: 'f', visibilityScopes: ['kb:public'] };
  knowledgeStore.addFileMeta(tid, { fileId: 'f', name: 'f', chunks: 1, ingestedAt: '', visibilityScopes: [] }, {});
  expect(currentChunkScopes(tid, chunk)).toEqual([]);
  knowledgeStore.saveSource(tid, { ...knowledgeStore.getSource(tid), visibilityScopes: [] });
  expect(currentChunkScopes(tid, { visibilityScopes: ['kb:public'] })).toEqual([]);
});

it('legacy generated prompts are hidden; current prompts disappear after guest grants are revoked', () => {
  const tid = tenantStore.createTenant('prompt-live-acl').id;
  scopePolicy.setPolicy(tid, { groups: { '—': ['kb:public'] }, accounts: {} });
  const generated = { 'zh-Hant': '公開問題？', en: 'Public question?' };
  const manual = { 'zh-Hant': '聯絡我們？', en: 'Contact us?' };
  knowledgeStore.setMeta(tid, { status: 'ready', chunkCount: 1, suggestedPrompts: { website: { generated }, file: { manual } } });
  expect(publicPromptSlots(tid).website?.generated).toBeUndefined();
  const fingerprint = promptAclFingerprint(tid);
  knowledgeStore.setMeta(tid, { ...knowledgeStore.getMeta(tid), generatedPromptAcl: { website: fingerprint } });
  expect(publicPromptSlots(tid).website?.generated).toEqual(generated);
  scopePolicy.setPolicy(tid, { groups: {}, accounts: {} });
  expect(publicPromptSlots(tid).website?.generated).toBeUndefined();
  expect(publicPromptSlots(tid).file?.manual).toEqual(manual);
});

it('generated prompts are invalidated when file access is tightened', () => {
  const tid = tenantStore.createTenant('prompt-file-acl').id;
  const fingerprint = promptAclFingerprint(tid);
  knowledgeStore.setMeta(tid, { status: 'ready', chunkCount: 1, generatedPromptAcl: { file: fingerprint }, suggestedPrompts: { file: { generated: { 'zh-Hant': '問題？', en: 'Question?' } } } });
  expect(publicPromptSlots(tid).file?.generated).toBeDefined();
  knowledgeStore.addFileMeta(tid, { fileId: 'f', name: 'f', chunks: 1, ingestedAt: '', visibilityScopes: [] }, {});
  expect(publicPromptSlots(tid).file?.generated).toBeUndefined();
});
