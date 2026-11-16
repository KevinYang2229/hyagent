/**
 * 建議回覆不得出現「了解」「謝謝」這類客套、無後續動作的短語：
 * 使用者點了也只是結束話題，對話不會往前。模型不一定守規則，解析時再濾一次。
 */
import { parseSuggestions } from '@/modules/conversation/conversation.agent';

describe('parseSuggestions：濾掉客套與確認收到的短語', () => {
  it.each([
    '了解', '了解了', '我了解了', '明白', '知道了', '好的', '好', '收到', 'OK', '沒問題',
    '謝謝', '謝謝你', '感謝', '多謝', '好的，謝謝！', '了解，謝謝', '謝謝～', '👍',
    '🙏️', '👍🏻', 'Thanks', 'Thank you!', 'Got it', 'ok', 'Okay.', 'Understood', 'Thanks, got it',
  ])('濾掉「%s」', (s) => {
    expect(parseSuggestions(JSON.stringify([s, '特休可以分次請嗎？']))).toEqual(['特休可以分次請嗎？']);
  });

  it('保留提問、具體回答與表單動作', () => {
    const kept = ['特休怎麼計算？', '明天上午', '確認送出', '修改日期', '取消', '不需要', 'Change date'];
    expect(parseSuggestions(JSON.stringify(kept))).toEqual(kept.slice(0, 3));
  });

  it.each([
    ['特休怎麼算？謝謝', '特休怎麼算？'],
    ['請幫我查詢，謝謝', '請幫我查詢'],
    ['請幫我查詢謝謝', '請幫我查詢'],
    ['幫我改成下週一，好的，謝謝！', '幫我改成下週一'],
    ['病假要附證明嗎？感謝您～', '病假要附證明嗎？'],
    ['確認送出，謝謝', '確認送出'],
    ['了解，我要改成下週一', '我要改成下週一'],
    ['好的，那病假呢？', '那病假呢？'],
    ['謝謝，那病假呢？', '那病假呢？'],
    ['Change the date, thanks!', 'Change the date'],
    ['Got it, what about sick leave?', 'what about sick leave?'],
  ])('切掉開頭或結尾的客套話：「%s」→「%s」', (input, expected) => {
    expect(parseSuggestions(JSON.stringify([input]))).toEqual([expected]);
  });

  it.each(['怎麼請假比較好', '我想了解', '這樣申請可以嗎', '要找誰比較明白', 'Book it ok'])(
    '內容本身含客套字時不誤切：「%s」',
    (s) => {
      const expected = s === 'Book it ok' ? 'Book it' : s;
      expect(parseSuggestions(JSON.stringify([s]))).toEqual([expected]);
    },
  );

  it('切掉客套話後與其他選項重複時只留一個', () => {
    expect(parseSuggestions('["確認送出","確認送出，謝謝","修改日期"]')).toEqual(['確認送出', '修改日期']);
  });

  it('先過濾再取前三個，客套詞不占名額', () => {
    expect(parseSuggestions('["謝謝","了解","A 怎麼辦？","B 怎麼辦？","C 怎麼辦？"]')).toEqual(['A 怎麼辦？', 'B 怎麼辦？', 'C 怎麼辦？']);
  });
});
