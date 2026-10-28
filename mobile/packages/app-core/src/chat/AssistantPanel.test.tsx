import { fireEvent, render, screen } from '@testing-library/react-native';
import { AssistantPanel } from './AssistantPanel';

const props = { mode: 'idle' as const, interaction: 'conversation' as const, compact: false, micAvailable: true, onMicPress: jest.fn(), onStopPress: jest.fn(), onKeyboard: jest.fn(), onCamera: jest.fn(), onInteractionChange: jest.fn() };

it('助理面板切換語音模式，保留開始錄音入口', async () => {
  await render(<AssistantPanel {...props} />);
  await fireEvent.press(screen.getByText('編輯後送出'));
  expect(props.onInteractionChange).toHaveBeenCalledWith('dictation');
  await fireEvent.press(screen.getByLabelText('開始說話'));
  expect(props.onMicPress).toHaveBeenCalledTimes(1);
});

it.each([false, true])('錄音中禁止切換，語音輸入顯示轉文字與音量（compact=%s）', async (compact) => {
  const onInteractionChange = jest.fn();
  await render(<AssistantPanel {...props} compact={compact} interaction="dictation" mode="recording" metering={-20} onInteractionChange={onInteractionChange} />);
  await fireEvent.press(screen.getByText('直接送出'));
  expect(onInteractionChange).not.toHaveBeenCalled();
  expect(screen.getByLabelText('收到聲音')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('停止並轉文字'));
  expect(props.onStopPress).toHaveBeenCalled();
});

it.each([false, true])('回覆中麥克風保留但停用，不切到「無麥克風」文案（compact=%s）', async (compact) => {
  const onMicPress = jest.fn();
  await render(<AssistantPanel {...props} compact={compact} busy onMicPress={onMicPress} />);
  const mic = screen.getByLabelText('回覆中');
  expect(mic.props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(mic);
  expect(onMicPress).not.toHaveBeenCalled();
  expect(screen.queryByText('用打字或拍照問我')).toBeNull();
  expect(screen.getByText('回覆完成後就能再說話')).toBeTruthy();
});
