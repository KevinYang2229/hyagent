// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import KnowledgeRulesSection, { type RulesDraft, type RulesInfo } from './KnowledgeRulesSection';
import { toRulesPatch } from './persona.util';

afterEach(cleanup);

const INFO: RulesInfo = {
  member: { defaults: ['數字規則', '精簡規則', '出處規則'], locked: ['🔒防捏造', '🔒外部資料'], custom: null },
  guest: { defaults: ['數字規則', '精簡規則'], locked: ['🔒防捏造', '🔒不提文件名稱'], custom: null },
};

function Harness({ initial = { member: null, guest: null }, onChange, readonly }: { initial?: RulesDraft; onChange?: (v: RulesDraft) => void; readonly?: boolean }) {
  const [value, setValue] = useState<RulesDraft>(initial);
  return (
    <KnowledgeRulesSection
      info={INFO}
      value={value}
      readonly={readonly}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

const inputs = () => screen.getAllByRole('textbox', { name: /^規則 \d+$/ }) as HTMLInputElement[];

it('沒有自訂時顯示內建可改規則，鎖定規則列在下方且不能編輯', () => {
  render(<Harness />);
  expect(inputs().map((i) => i.value)).toEqual(['數字規則', '精簡規則', '出處規則']);
  const locked = screen.getByRole('list', { name: '鎖定的規則' });
  expect(within(locked).getByText('🔒防捏造')).toBeInTheDocument();
  expect(within(locked).queryByRole('textbox')).not.toBeInTheDocument();
});

it('切換到網站訪客顯示訪客的規則', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '網站訪客' }));
  expect(inputs().map((i) => i.value)).toEqual(['數字規則', '精簡規則']);
  expect(screen.getByText('🔒不提文件名稱')).toBeInTheDocument();
});

it('編輯第一條後，該側變成自訂陣列，另一側不變', () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  fireEvent.change(inputs()[0], { target: { value: '改過的規則' } });
  expect(onChange).toHaveBeenLastCalledWith({ member: ['改過的規則', '精簡規則', '出處規則'], guest: null });
});

it('新增、刪除、上下移', () => {
  const onChange = vi.fn();
  render(<Harness initial={{ member: ['A', 'B'], guest: null }} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: '新增規則' }));
  expect(onChange).toHaveBeenLastCalledWith({ member: ['A', 'B', ''], guest: null });
  fireEvent.click(screen.getByRole('button', { name: '刪除規則 3' }));
  expect(onChange).toHaveBeenLastCalledWith({ member: ['A', 'B'], guest: null });
  fireEvent.click(screen.getByRole('button', { name: '下移規則 1' }));
  expect(onChange).toHaveBeenLastCalledWith({ member: ['B', 'A'], guest: null });
  fireEvent.click(screen.getByRole('button', { name: '上移規則 2' }));
  expect(onChange).toHaveBeenLastCalledWith({ member: ['A', 'B'], guest: null });
});

it('達 20 條時停用新增；每條 maxLength 300', () => {
  render(<Harness initial={{ member: Array.from({ length: 20 }, (_, i) => `R${i}`), guest: null }} />);
  expect(screen.getByRole('button', { name: '新增規則' })).toBeDisabled();
  expect(inputs()[0]).toHaveAttribute('maxLength', '300');
});

it('還原預設：該側回到 null（用內建）', () => {
  const onChange = vi.fn();
  render(<Harness initial={{ member: ['自訂'], guest: ['訪客自訂'] }} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: '還原預設' }));
  expect(onChange).toHaveBeenLastCalledWith({ member: null, guest: ['訪客自訂'] });
});

it('唯讀時編輯控制項都停用', () => {
  render(<Harness readonly />);
  expect(inputs()[0]).toBeDisabled();
  expect(screen.getByRole('button', { name: '新增規則' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '還原預設' })).toBeDisabled();
});

it('toRulesPatch：null 維持 null；去掉空白項目；與內建相同視為 null', () => {
  expect(toRulesPatch({ member: null, guest: null }, INFO)).toEqual({ member: null, guest: null });
  expect(toRulesPatch({ member: [' A ', '  '], guest: null }, INFO)).toEqual({ member: ['A'], guest: null });
  expect(toRulesPatch({ member: ['數字規則', '精簡規則', '出處規則'], guest: [] }, INFO)).toEqual({ member: null, guest: [] });
});
