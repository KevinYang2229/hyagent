import { createHash } from 'node:crypto';
import { knowledgeStore } from './knowledge.store';
import { guestVisibilityScopesOf } from './knowledge.visibility';
import { SOURCE_KEYS, type SuggestedPromptSlots } from './prompt-slots';

/** Old caches have no fingerprint and must never be published after enabling ACL. */
export function promptAclFingerprint(tenantId: string): string {
  const source = knowledgeStore.getSource(tenantId);
  const files = knowledgeStore.getMeta(tenantId).files ?? [];
  return createHash('sha256').update(JSON.stringify({
    version: 1, guest: guestVisibilityScopesOf(tenantId).sort(),
    source: source.visibilityScopes ?? null, audience: source.audience ?? null,
    files: files.map((f) => [f.fileId, f.visibilityScopes ?? null]),
  })).digest('hex');
}

export function publicPromptSlots(tenantId: string): SuggestedPromptSlots {
  const meta = knowledgeStore.getMeta(tenantId);
  const fingerprint = promptAclFingerprint(tenantId);
  return Object.fromEntries(SOURCE_KEYS.map((key) => [key, {
    manual: meta.suggestedPrompts?.[key]?.manual,
    generated: meta.generatedPromptAcl?.[key] === fingerprint ? meta.suggestedPrompts?.[key]?.generated : undefined,
  }]));
}
