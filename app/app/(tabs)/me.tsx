import { useAuth } from '@/auth/AuthProvider';
import { MeView } from '@/me/MeView';
import { useSettings } from '@/settings/SettingsProvider';

export default function Me() {
  const { user, logout } = useAuth();
  const { speakEnabled, setSpeakEnabled, serverUrl, setServerUrl } = useSettings();
  return (
    <MeView
      user={user}
      speakEnabled={speakEnabled}
      onToggleSpeak={(on) => void setSpeakEnabled(on)}
      serverUrl={serverUrl}
      onSaveServer={async (url) => {
        await setServerUrl(url);
        await logout();
      }}
      onLogout={() => void logout()}
    />
  );
}
