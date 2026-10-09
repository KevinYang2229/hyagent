/**
 * 根版面：品牌注入、資料快取、設定、訪客身分、HyAgent 對話、產品比較清單。
 * 這個 App 沒有登入：開場轉導頁（IntroView）在背景取得訪客 Session，動畫播完就進首頁；
 * 之後若失去身分（例如租戶關閉訪客使用），會回到轉導頁顯示原因並可重新連線。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { AuthProvider, useAuth } from '@hyagent/app-core/auth/AuthProvider';
import { AppBrandingProvider } from '@hyagent/app-core/branding/AppBranding';
import { ChatProvider } from '@hyagent/app-core/chat/ChatProvider';
import { SettingsProvider, useSettings } from '@hyagent/app-core/settings/SettingsProvider';
import { libOneBranding } from '@/brand/libOneBranding';
import { CompareProvider } from '@/catalog/CompareStore';
import { IntroView } from '@/chrome/IntroView';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });

function RootStack() {
  const { status, error, connect } = useAuth();
  const { serverUrl, setServerUrl } = useSettings();
  const [entered, setEntered] = useState(false);
  const onDone = useCallback(() => setEntered(true), []);
  const retry = useCallback(async (url: string) => {
    if (url.trim() && url !== serverUrl) await setServerUrl(url);
    await connect();
  }, [serverUrl, setServerUrl, connect]);

  if (!entered || status !== 'signedIn') {
    return (
      <IntroView
        connected={status === 'signedIn'}
        error={status === 'signedOut' ? error ?? '尚未連線，請重新連線。' : null}
        serverUrl={serverUrl}
        onRetry={(url) => void retry(url)}
        onDone={onDone}
      />
    );
  }
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AppBrandingProvider value={libOneBranding}>
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          <AuthProvider mode="guest">
            <StatusBar style="dark" />
            <ChatProvider>
              <CompareProvider>
                <RootStack />
              </CompareProvider>
            </ChatProvider>
          </AuthProvider>
        </SettingsProvider>
      </QueryClientProvider>
    </AppBrandingProvider>
  );
}
