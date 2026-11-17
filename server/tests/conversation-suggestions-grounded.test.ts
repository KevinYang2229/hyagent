/**
 * 推薦詞要有根據：產生器只看得到對話，不知道租戶知識庫有什麼。
 * - 閒聊／守門（自我介紹、說明能力、婉拒離題）→ 直接用知識庫的開場推薦問句（已依訪客可見內容生成，不會外洩）
 * - 其他回答 → 交給產生器，但要帶上使用者的提問，並禁止自行假設知識庫有哪些主題
 * 先前的 bug：HyRead（Gaze 閱讀器客服）問「你是什麼角色」，推薦詞卻是「差旅報帳」「特休」「員工手冊」。
 */
import type { LLMProvider } from '@/lib/llm/types';
import { generateSuggestions } from '@/modules/conversation/conversation.agent';
import type { Session } from '@/modules/conversation/conversation.types';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { promptAclFingerprint } from '@/modules/knowledge/prompt-visibility';
import { tenantStore } from '@/modules/tenant/tenant.store';

let seq = 0;

function tenantWithPrompts(withKnowledge = true): string {
  const t = tenantStore.createTenant(`suggest-grounded-${seq++}`);
  if (withKnowledge) tenantStore.updateTenant(t.id, { grantedScopes: ['service:knowledge'] });
  knowledgeStore.setMeta(t.id, {
    status: 'ready',
    chunkCount: 5,
    chunkCountBySource: { website: 0, file: 5 },
    suggestedPrompts: { file: { generated: { 'zh-Hant': 'Gaze 螢幕有殘影是正常的嗎？', en: 'Is screen ghosting on my Gaze reader normal?' } } },
  });
  const fp = promptAclFingerprint(t.id);
  knowledgeStore.setMeta(t.id, { ...knowledgeStore.getMeta(t.id), generatedPromptAcl: { file: fp } });
  return t.id;
}

function session(tenantId: string, locale?: string): Session {
  return {
    id: 's',
    tenantId,
    userId: '',
    formId: '',
    values: {},
    status: 'collecting',
    messages: [],
    createdAt: new Date().toISOString(),
    ...(locale ? { locale } : {}),
  } as Session;
}

function mockLLM(reply = '["追問一","追問二"]') {
  const createMessage = jest.fn().mockResolvedValue({ text: reply, toolCalls: [], stopReason: 'end_turn' });
  return { llm: { name: 'mock', createMessage } as unknown as LLMProvider, createMessage };
}

describe('閒聊／守門的回答：用知識庫開場推薦問句', () => {
  it('不呼叫產生器，直接回傳開場推薦問句', async () => {
    const { llm, createMessage } = mockLLM();
    const out = await generateSuggestions(llm, session(tenantWithPrompts()), '我是知識庫問答助理……', {
      serviceId: 'assistant',
      userText: '你是什麼角色',
    });
    expect(out).toEqual(['Gaze 螢幕有殘影是正常的嗎？']);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('英文介面用英文的開場推薦問句', async () => {
    const { llm } = mockLLM();
    const out = await generateSuggestions(llm, session(tenantWithPrompts(), 'en'), 'I am the assistant', {
      serviceId: 'assistant',
      userText: 'who are you',
    });
    expect(out).toEqual(['Is screen ghosting on my Gaze reader normal?']);
  });

  it('沒有開通知識庫時不用開場推薦問句，改交給產生器', async () => {
    const { llm, createMessage } = mockLLM();
    await generateSuggestions(llm, session(tenantWithPrompts(false)), '我可以協助填表', { serviceId: 'assistant', userText: '你是誰' });
    expect(createMessage).toHaveBeenCalled();
  });

  it('沒有開場推薦問句時改交給產生器', async () => {
    const { llm, createMessage } = mockLLM();
    const t = tenantStore.createTenant(`suggest-grounded-${seq++}`);
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:knowledge'] });
    await generateSuggestions(llm, session(t.id), '我是助理', { serviceId: 'assistant', userText: '你是誰' });
    expect(createMessage).toHaveBeenCalled();
  });
});

describe('其他回答：產生器只能根據對話內容', () => {
  it('帶上使用者的提問，並禁止自行假設知識庫或公司有哪些主題', async () => {
    const { llm, createMessage } = mockLLM();
    const out = await generateSuggestions(llm, session(tenantWithPrompts()), 'Gaze 的殘影是電子紙特性……', {
      serviceId: 'knowledge',
      userText: 'Gaze 有殘影正常嗎',
    });
    expect(out).toEqual(['追問一', '追問二']);
    const params = createMessage.mock.calls[0][0];
    expect(params.messages[0].content[0].text).toContain('使用者的提問：\n「Gaze 有殘影正常嗎」');
    expect(params.system).toContain('只能根據上面對話中出現過的內容');
    expect(params.system).not.toContain('OA 對話介面');
  });

  it('英文規則同樣禁止自行假設主題', async () => {
    const { llm, createMessage } = mockLLM('["Tell me more"]');
    await generateSuggestions(llm, session(tenantWithPrompts(), 'en'), 'Ghosting is normal…', { serviceId: 'knowledge', userText: 'is ghosting normal' });
    expect(createMessage.mock.calls[0][0].system).toContain('Only use what appears in the conversation above');
  });
});

describe('產生器的 prompt 同時要求「讓對話往前」，不要客套話', () => {
  // 合併 fix/suggestions-no-acknowledgement 時，這兩條規則在解衝突時被漏掉；解析時的過濾還在，但少了事前的指示
  it('中文規則：不要輸出「了解」「好的」「謝謝」這類短語', async () => {
    const { llm, createMessage } = mockLLM();
    await generateSuggestions(llm, session(tenantWithPrompts()), '殘影是電子紙特性', { serviceId: 'knowledge', userText: '有殘影正常嗎' });
    const system = createMessage.mock.calls[0][0].system as string;
    expect(system).toContain('每個選項都要讓對話往前');
    expect(system).toContain('不要輸出「了解」「好的」「謝謝」「收到」「知道了」');
    expect(system).toContain('只能根據上面對話中出現過的內容');
  });

  it('英文規則：Every option must move the conversation forward', async () => {
    const { llm, createMessage } = mockLLM('["Tell me more"]');
    await generateSuggestions(llm, session(tenantWithPrompts(), 'en'), 'Ghosting is normal', { serviceId: 'knowledge', userText: 'ghosting?' });
    const system = createMessage.mock.calls[0][0].system as string;
    expect(system).toContain('Every option must move the conversation forward');
    expect(system).toContain('Only use what appears in the conversation above');
  });
});
