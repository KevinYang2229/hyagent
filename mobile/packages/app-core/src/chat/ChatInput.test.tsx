import { createRef } from 'react';
import { TextInput } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ChatInput } from './ChatInput';

describe('ChatInput', () => {
  it('等待時顯示取消，完成後恢復送出按鈕', async () => {
    const onCancel = jest.fn();
    const onSend = jest.fn();
    const view = await render(<ChatInput onSend={onSend} micAvailable={false} disabled onCancel={onCancel} />);
    expect(screen.queryByLabelText('送出')).toBeNull();
    await fireEvent.press(screen.getByLabelText('取消回覆'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    await view.rerender(<ChatInput onSend={onSend} micAvailable={false} onCancel={onCancel} />);
    expect(screen.queryByLabelText('取消回覆')).toBeNull();
    expect(screen.getByLabelText('送出')).toBeTruthy();
  });

  it('送出後立即清空，失敗還原文字', async () => {
    const inputRef = createRef<TextInput>();
    const onSend = jest.fn(async () => {
      expect(clear).toHaveBeenCalledTimes(1);
      return false;
    });
    await render(<ChatInput onSend={onSend} micAvailable={false} inputRef={inputRef} />);
    const clear = jest.spyOn(inputRef.current!, 'clear').mockClear();
    await fireEvent.changeText(screen.getByPlaceholderText('請說出或輸入你的需求…'), '注音');
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(onSend).toHaveBeenCalledWith('注音');
    expect(screen.getByPlaceholderText('請說出或輸入你的需求…').props.defaultValue).toBe('注音');
  });

  it('送出等待期間的新文字不會被失敗結果覆蓋', async () => {
    const onSend = jest.fn().mockImplementationOnce(async () => {
      await fireEvent.changeText(screen.getByPlaceholderText('請說出或輸入你的需求…'), '接著查活動');
      return false;
    }).mockResolvedValue(true);
    await render(<ChatInput onSend={onSend} micAvailable={false} />);
    await fireEvent.changeText(screen.getByPlaceholderText('請說出或輸入你的需求…'), '查庫存');
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(onSend).toHaveBeenLastCalledWith('接著查活動');
  });

  it('重新編輯帶回草稿，可修改後送出', async () => {
    const onSend = jest.fn().mockResolvedValue(true);
    const view = await render(<ChatInput onSend={onSend} micAvailable={false} />);
    await view.rerender(<ChatInput onSend={onSend} micAvailable={false} editRequest={{ text: '原訊息', nonce: 1 }} />);
    const input = screen.getByPlaceholderText('請說出或輸入你的需求…');
    expect(input.props.defaultValue).toBe('原訊息');
    expect(input.props.value).toBeUndefined();
    await fireEvent.changeText(input, '修改訊息');
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(onSend).toHaveBeenCalledWith('修改訊息');
  });

  it('注音選字的 Enter 不送出，按送出才提交中文', async () => {
    const onSend = jest.fn().mockResolvedValue(true);
    await render(<ChatInput onSend={onSend} micAvailable={false} />);
    const input = screen.getByPlaceholderText('請說出或輸入你的需求…');
    expect(input.props.multiline).toBe(true);
    expect(input.props.submitBehavior).toBe('newline');
    await fireEvent.changeText(input, 'ㄓㄨ');
    await fireEvent(input, 'submitEditing', { nativeEvent: { text: 'ㄓㄨ' } });
    expect(onSend).not.toHaveBeenCalled();
    await fireEvent.changeText(input, '注音');
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(onSend).toHaveBeenCalledWith('注音');
  });

  it('送出成功清空輸入；失敗保留文字', async () => {
    const onSend = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await render(<ChatInput onSend={onSend} micAvailable={false} />);
    const input = screen.getByPlaceholderText('請說出或輸入你的需求…');
    await fireEvent.changeText(input, '查庫存');
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(input.props.value).toBeUndefined();
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(onSend).toHaveBeenCalledTimes(2);
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('查庫存');
  });

  it('麥克風可用時顯示並可按', async () => {
    const onMicPress = jest.fn();
    await render(<ChatInput onSend={jest.fn()} micAvailable onMicPress={onMicPress} />);
    await fireEvent.press(screen.getByLabelText('開始說話'));
    expect(onMicPress).toHaveBeenCalled();
  });

  it('送出中仍可編輯但不會送出；onSend 拒絕時保留文字', async () => {
    const onSend = jest.fn();
    await render(<ChatInput onSend={onSend} micAvailable={false} disabled />);
    const input = screen.getByPlaceholderText('請說出或輸入你的需求…');
    expect(input.props.editable).not.toBe(false);
    await fireEvent.changeText(input, '查庫存');
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.props.value).toBeUndefined();
  });

  it('onSend 拒絕時視為失敗並保留文字', async () => {
    const onSend = jest.fn().mockRejectedValue(new Error('boom'));
    await render(<ChatInput onSend={onSend} micAvailable={false} />);
    await fireEvent.changeText(screen.getByPlaceholderText('請說出或輸入你的需求…'), '查庫存');
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('查庫存');
  });
});
