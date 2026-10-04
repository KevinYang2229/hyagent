/** 我的：店員資訊、朗讀開關、伺服器位址（變更後需重新登入）、登出。 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { Applicant } from '@hyagent/shared';
import { normalizeServerUrl } from '@/api/config';
import { colors, font, radius, shadow, space } from '@/theme/tokens';

export function MeView({
  user, speakEnabled, onToggleSpeak, serverUrl, onSaveServer, onLogout,
}: {
  user: Applicant | null;
  speakEnabled: boolean;
  onToggleSpeak(on: boolean): void;
  serverUrl: string;
  onSaveServer(url: string): Promise<void>;
  onLogout(): void;
}) {
  const [server, setServer] = useState(serverUrl);
  const changed = normalizeServerUrl(server) !== serverUrl && server.trim() !== '';

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.card}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(user?.name ?? '?').slice(0, 1)}</Text>
        </View>
        <View>
          <Text style={styles.name}>{user?.name ?? ''}</Text>
          <Text style={styles.sub}>{[user?.department, user?.title ?? '店員'].filter(Boolean).join('・')}</Text>
          <Text style={styles.sub}>{`帳號：${user?.id ?? ''}`}</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={[styles.label, { flex: 1 }]}>朗讀 AI 回覆</Text>
        <Switch value={speakEnabled} onValueChange={onToggleSpeak} accessibilityLabel="朗讀 AI 回覆" trackColor={{ true: colors.primary }} />
      </View>

      <View style={[styles.card, { flexDirection: 'column', alignItems: 'stretch' }]}>
        <Text style={styles.label}>伺服器位址</Text>
        <TextInput
          style={styles.input}
          value={server}
          onChangeText={setServer}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="伺服器位址"
        />
        <Text style={styles.sub}>變更後需要重新登入。</Text>
        <Pressable
          style={[styles.save, !changed && { opacity: 0.4 }]}
          onPress={() => { if (changed) void onSaveServer(server); }}
          accessibilityLabel="儲存伺服器位址"
          accessibilityRole="button"
          accessibilityState={{ disabled: !changed }}
        >
          <Text style={styles.saveText}>儲存</Text>
        </Pressable>
      </View>

      <Pressable style={styles.logout} onPress={onLogout} accessibilityLabel="登出" accessibilityRole="button">
        <Text style={styles.logoutText}>登出</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.lg, gap: space.md, maxWidth: 640, width: '100%', alignSelf: 'center' },
  card: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, ...shadow.card },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: font.xxl, fontWeight: '800', color: colors.primaryDark },
  name: { fontSize: font.xl, fontWeight: '800', color: colors.text },
  sub: { fontSize: font.sm, color: colors.textMuted },
  label: { fontSize: font.md, fontWeight: '600', color: colors.text },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 12, fontSize: font.md, color: colors.text, marginVertical: space.sm },
  save: { alignSelf: 'flex-end', backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: space.xl, paddingVertical: 10, marginTop: space.sm },
  saveText: { color: '#fff', fontWeight: '700' },
  logout: { borderWidth: 1, borderColor: colors.danger, borderRadius: radius.lg, paddingVertical: 14, alignItems: 'center', marginTop: space.md },
  logoutText: { color: colors.danger, fontSize: font.lg, fontWeight: '700' },
});
