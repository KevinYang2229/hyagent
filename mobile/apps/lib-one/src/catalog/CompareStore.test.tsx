import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { CompareProvider, useCompare } from './CompareStore';

const wrapper = ({ children }: { children: ReactNode }) => <CompareProvider>{children}</CompareProvider>;

it('加入、取消、清除；滿三項時加入失敗', async () => {
  const { result } = await renderHook(() => useCompare(), { wrapper });
  await act(() => { result.current.toggle('a'); });
  await act(() => { result.current.toggle('b'); });
  await act(() => { result.current.toggle('c'); });
  let ok = true;
  await act(() => { ok = result.current.toggle('d'); });
  expect(ok).toBe(false);
  expect(result.current.ids).toEqual(['a', 'b', 'c']);
  await act(() => { result.current.toggle('b'); });
  expect(result.current.has('b')).toBe(false);
  await act(() => result.current.clear());
  expect(result.current.ids).toEqual([]);
});
