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
    await fireEvent.press(screen.getByLabelText('進階連線設定'));
    await fireEvent.changeText(screen.getByLabelText('伺服器位址'), 'http://b:3000');
    await act(async () => { fireEvent.press(screen.getByLabelText('儲存伺服器位址')); });
    expect(onSaveServer).toHaveBeenCalledWith('http://b:3000');
    await fireEvent.press(screen.getByLabelText('登出'));
    expect(onLogout).toHaveBeenCalled();
  });

  it('進階設定預設收合，儲存失敗可重試', async () => {
    const onSaveServer = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    await render(<MeView user={user} speakEnabled={false} onToggleSpeak={jest.fn()} serverUrl="http://a" onSaveServer={onSaveServer} onLogout={jest.fn()} />);
    expect(screen.getByText('帳號與設定')).toBeTruthy();
    expect(screen.getByText('目前以文字顯示回覆')).toBeTruthy();
    expect(screen.queryByLabelText('伺服器位址')).toBeNull();
    await fireEvent.press(screen.getByLabelText('進階連線設定'));
    await fireEvent.changeText(screen.getByLabelText('伺服器位址'), 'http://b');
    await act(async () => { fireEvent.press(screen.getByLabelText('儲存伺服器位址')); });
    expect(screen.getByText('儲存失敗，請稍後再試。')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('儲存伺服器位址')); });
    expect(onSaveServer).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('儲存失敗，請稍後再試。')).toBeNull();
  });

  it('伺服器位址沒變 → 儲存鈕停用', async () => {
    const onSaveServer = jest.fn();
    await render(<MeView user={user} speakEnabled onToggleSpeak={jest.fn()} serverUrl="http://a" onSaveServer={onSaveServer} onLogout={jest.fn()} />);
    await fireEvent.press(screen.getByLabelText('進階連線設定'));
    await act(async () => { fireEvent.press(screen.getByLabelText('儲存伺服器位址')); });
    expect(onSaveServer).not.toHaveBeenCalled();
  });
});
