/** 登入：帳號密碼；伺服器位址可展開修改（區網 Demo 用）。 */
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { errorMessage } from '@/api/errors';
import { useAuth } from '@/auth/AuthProvider';
import { Mascot } from '@/brand/Mascot';
import { useSettings } from '@/settings/SettingsProvider';
import { colors, font, radius, shadow, space } from '@/theme/tokens';

export default function Login() {
  const { login } = useAuth();
  const { serverUrl, setServerUrl } = useSettings();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(serverUrl);
  const [showServer, setShowServer] = useState(!serverUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      if (server !== serverUrl) await setServerUrl(server);
      await login(username.trim(), password);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.page}>
      <View style={styles.card}>
        <Mascot pose="wave" size={120} />
        <Text style={styles.title}>門市小幫手</Text>
        <Text style={styles.subtitle}>歡迎回來！請先登入</Text>
        <TextInput style={styles.input} placeholder="帳號" autoCapitalize="none" autoCorrect={false} value={username} onChangeText={setUsername} />
        <TextInput style={styles.input} placeholder="密碼" secureTextEntry value={password} onChangeText={setPassword} onSubmitEditing={submit} />
        {showServer ? (
          <TextInput
            style={styles.input}
            placeholder="伺服器位址，例如 http://192.168.1.10:3000"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={server}
            onChangeText={setServer}
          />
        ) : (
          <Pressable onPress={() => setShowServer(true)}>
            <Text style={styles.link}>伺服器設定</Text>
          </Pressable>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        <Pressable style={[styles.button, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>登入</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  card: { width: '100%', maxWidth: 420, backgroundColor: colors.surface, borderRadius: radius.xl, padding: space.xl, alignItems: 'center', gap: space.md, ...shadow.card },
  title: { fontSize: font.xxl, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: font.md, color: colors.textMuted, marginBottom: space.sm },
  input: { alignSelf: 'stretch', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 12, fontSize: font.md, color: colors.text },
  link: { color: colors.primaryDark, fontSize: font.sm },
  error: { alignSelf: 'stretch', color: colors.danger, fontSize: font.sm },
  button: { alignSelf: 'stretch', backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: font.lg, fontWeight: '700' },
});
