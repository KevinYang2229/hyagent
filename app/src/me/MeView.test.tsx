import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { MeView } from './MeView';

const user = { id: 'kevin', name: 'Kevin Yang', department: '門市', title: '店員' };

describe('MeView', () => {
  it('顯示使用者、切換朗讀、儲存伺服器、登出', async () => {
    const onToggleSpeak = jest.fn();
    const onSaveServer = jest.fn().mockResolvedValue(undefined);
    const onLogout = jest.fn();
    await render(<MeView user={user} speakEnabled onToggleSpeak={onToggleSpeak} serverUrl="http://a" onSaveServer={onSaveServer} onLogout={onLogout} />);
    expect(screen.getByText('Kevin Yang')).toBeTruthy();
    await fireEvent(screen.getByLabelText('朗讀 AI 回覆'), 'valueChange', false);
    expect(onToggleSpeak).toHaveBeenCalledWith(false);
    await fireEvent.changeText(screen.getByLabelText('伺服器位址'), 'http://b:3000');
    await act(async () => { fireEvent.press(screen.getByLabelText('儲存伺服器位址')); });
    expect(onSaveServer).toHaveBeenCalledWith('http://b:3000');
    await fireEvent.press(screen.getByLabelText('登出'));
    expect(onLogout).toHaveBeenCalled();
  });

  it('伺服器位址沒變 → 儲存鈕停用', async () => {
    const onSaveServer = jest.fn();
    await render(<MeView user={user} speakEnabled onToggleSpeak={jest.fn()} serverUrl="http://a" onSaveServer={onSaveServer} onLogout={jest.fn()} />);
    await act(async () => { fireEvent.press(screen.getByLabelText('儲存伺服器位址')); });
    expect(onSaveServer).not.toHaveBeenCalled();
  });
});
