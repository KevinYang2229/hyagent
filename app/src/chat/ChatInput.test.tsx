import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ChatInput } from './ChatInput';

describe('ChatInput', () => {
  it('送出成功清空輸入；失敗保留文字', async () => {
    const onSend = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await render(<ChatInput onSend={onSend} micAvailable={false} />);
    const input = screen.getByPlaceholderText('請說出或輸入你的需求…');
    await fireEvent.changeText(input, '查庫存');
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(screen.getByDisplayValue('查庫存')).toBeTruthy();
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(screen.queryByDisplayValue('查庫存')).toBeNull();
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
    expect(screen.getByDisplayValue('查庫存')).toBeTruthy();
  });

  it('onSend 拒絕時視為失敗並保留文字', async () => {
    const onSend = jest.fn().mockRejectedValue(new Error('boom'));
    await render(<ChatInput onSend={onSend} micAvailable={false} />);
    await fireEvent.changeText(screen.getByPlaceholderText('請說出或輸入你的需求…'), '查庫存');
    await act(async () => { await fireEvent.press(screen.getByLabelText('送出')); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue('查庫存')).toBeTruthy();
  });
});
