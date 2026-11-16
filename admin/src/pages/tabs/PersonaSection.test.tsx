// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssistantPersona } from '@hyagent/shared';
import PersonaSection from './PersonaSection';
import { toPersonaPatch } from './persona.util';

afterEach(cleanup);

function optionLabels(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options).map((o) => o.textContent ?? '');
}

function Harness({ initial = {}, onChange }: { initial?: AssistantPersona; onChange?: (v: AssistantPersona) => void }) {
  const [value, setValue] = useState<AssistantPersona>(initial);
  return (
    <PersonaSection
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

it('員工下拉只列對內角色、訪客下拉只列對外角色', () => {
  render(<Harness />);
  const member = optionLabels(screen.getByLabelText('登入員工的角色'));
  const guest = optionLabels(screen.getByLabelText('網站訪客的角色'));
  expect(member).toContain('客服助理');
  expect(member).not.toContain('線上客服');
  expect(guest).toContain('線上客服');
  expect(guest).not.toContain('客服助理');
});

it('選角色後顯示該角色的一行說明', () => {
  render(<Harness />);
  fireEvent.change(screen.getByLabelText('登入員工的角色'), { target: { value: 'cs-assist' } });
  expect(screen.getByText('協助客服人員回答顧客：先給答案與出處，再附可轉述給顧客的話術')).toBeInTheDocument();
});

it('聯絡管道只出現在訪客區塊', () => {
  render(<Harness />);
  expect(screen.getAllByLabelText(/聯絡管道/)).toHaveLength(1);
  expect(screen.getByLabelText('網站訪客的聯絡管道')).toBeInTheDocument();
});

it('補充說明 maxLength 為 500 並顯示字數；聯絡管道為 200', () => {
  render(<Harness initial={{ member: { preset: 'hr', notes: '你好' } }} />);
  expect(screen.getByLabelText('登入員工的補充說明')).toHaveAttribute('maxLength', '500');
  expect(screen.getByLabelText('網站訪客的補充說明')).toHaveAttribute('maxLength', '500');
  expect(screen.getByLabelText('網站訪客的聯絡管道')).toHaveAttribute('maxLength', '200');
  expect(screen.getByText('2/500')).toBeInTheDocument();
});

it('修改後 onChange 帶出完整物件，另一側保留', () => {
  const onChange = vi.fn();
  render(<Harness initial={{ guest: { preset: 'cs', contact: '02-1234' } }} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('登入員工的角色'), { target: { value: 'hr' } });
  expect(onChange).toHaveBeenLastCalledWith({ member: { preset: 'hr' }, guest: { preset: 'cs', contact: '02-1234' } });
});

it('讀入既有設定時回填選項與文字', () => {
  render(<Harness initial={{ member: { preset: 'it', notes: '附上分機' }, guest: { preset: 'presales', contact: 'LINE @shop' } }} />);
  expect(screen.getByLabelText('登入員工的角色')).toHaveValue('it');
  expect(screen.getByLabelText('登入員工的補充說明')).toHaveValue('附上分機');
  expect(screen.getByLabelText('網站訪客的角色')).toHaveValue('presales');
  expect(screen.getByLabelText('網站訪客的聯絡管道')).toHaveValue('LINE @shop');
});

it('toPersonaPatch：預設且沒有文字的一側送 null，其餘去掉空白欄位', () => {
  expect(toPersonaPatch({})).toEqual({ member: null, guest: null });
  expect(toPersonaPatch({ member: { preset: 'default', notes: '  ' }, guest: { preset: 'cs', notes: '', contact: ' 02-1234 ' } }))
    .toEqual({ member: null, guest: { preset: 'cs', contact: '02-1234' } });
  expect(toPersonaPatch({ member: { preset: 'default', notes: '稱呼同事為夥伴' } }))
    .toEqual({ member: { preset: 'default', notes: '稱呼同事為夥伴' }, guest: null });
});

it('每側四個依功能覆寫的下拉，第一項是「沿用（目前角色）」', () => {
  render(<Harness initial={{ member: { preset: 'cs-assist' } }} />);
  const form = screen.getByLabelText('登入員工・填表的角色') as HTMLSelectElement;
  expect(form.options[0].textContent).toBe('沿用（客服助理）');
  expect(form).toHaveValue('');
  for (const name of ['知識庫問答', '智慧代理', '閒聊／守門']) {
    expect(screen.getByLabelText(`登入員工・${name}的角色`)).toBeInTheDocument();
    expect(screen.getByLabelText(`網站訪客・${name}的角色`)).toBeInTheDocument();
  }
});

it('選擇覆寫後帶出 services；選回沿用時移除該功能', () => {
  const onChange = vi.fn();
  render(<Harness initial={{ member: { preset: 'it' } }} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('登入員工・填表的角色'), { target: { value: 'hr' } });
  expect(onChange).toHaveBeenLastCalledWith({ member: { preset: 'it', services: { form: 'hr' } } });
  fireEvent.change(screen.getByLabelText('登入員工・填表的角色'), { target: { value: '' } });
  expect(onChange).toHaveBeenLastCalledWith({ member: { preset: 'it', services: {} } });
});

it('訪客的覆寫選單只列對外角色', () => {
  render(<Harness />);
  const labels = Array.from((screen.getByLabelText('網站訪客・知識庫問答的角色') as HTMLSelectElement).options).map((o) => o.textContent);
  expect(labels).toContain('售前顧問');
  expect(labels).not.toContain('HR 顧問');
});

it('toPersonaPatch：只有覆寫的一側也保留；空的覆寫表不送', () => {
  expect(toPersonaPatch({ member: { preset: 'default', services: { form: 'hr' } } })).toEqual({
    member: { preset: 'default', services: { form: 'hr' } },
    guest: null,
  });
  expect(toPersonaPatch({ member: { preset: 'hr', services: {} } })).toEqual({ member: { preset: 'hr' }, guest: null });
});
