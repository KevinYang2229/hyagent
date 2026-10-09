/** 設定（由首頁右上角開啟）：朗讀 AI 顧問回覆、伺服器位址。App 沒有帳號，換伺服器後自動重新取得訪客身分。 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { normalizeServerUrl } from '@hyagent/app-core/api/config';
import { useAuth } from '@hyagent/app-core/auth/AuthProvider';
import { useSettings } from '@hyagent/app-core/settings/SettingsProvider';
import { sm } from '@/brand/theme';

export default function Settings() {
  const { connect } = useAuth();
  const { speakEnabled, setSpeakEnabled, serverUrl, setServerUrl } = useSettings();
  const [server, setServer] = useState(serverUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const changed = server.trim() !== '' && normalizeServerUrl(server) !== normalizeServerUrl(serverUrl);
  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    setError('');
    try {
      await setServerUrl(server);
      await connect();
    } catch {
      setError('儲存失敗，請稍後再試。');
      setSaving(false);
    }
  };
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>設定</Text>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel="關閉"><Ionicons name="close" size={26} color={sm.ink} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={[styles.card, styles.row]}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.value}>朗讀 AI 顧問回覆</Text>
            <Text style={styles.desc}>自動朗讀回覆內容，偏好保存在這台裝置。</Text>
          </View>
          <Switch value={speakEnabled} onValueChange={(on) => void setSpeakEnabled(on)} accessibilityLabel="朗讀 AI 顧問回覆" trackColor={{ true: sm.blue, false: sm.line }} />
        </View>
        <View style={styles.card}>
          <Text style={styles.value}>伺服器位址</Text>
          <TextInput style={styles.input} value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="伺服器位址" placeholder="https://example.com" />
          <Text style={styles.desc}>儲存後會重新連線到新的伺服器。</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Pressable style={[styles.save, (!changed || saving) && { opacity: 0.4 }]} disabled={!changed || saving} onPress={() => void save()} accessibilityRole="button" accessibilityState={{ disabled: !changed || saving, busy: saving }}>
            <Text style={styles.saveText}>{saving ? '連線中…' : '儲存並重新連線'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: sm.blueMist },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 12 },
  title: { fontSize: 25, fontWeight: '900', color: sm.ink },
  page: { padding: 20, gap: 14, width: '100%', maxWidth: 640, alignSelf: 'center' },
  card: { gap: 8, padding: 18, borderRadius: 18, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: sm.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  value: { fontSize: 18, fontWeight: '800', color: sm.ink },
  desc: { fontSize: 15, lineHeight: 22, color: sm.inkSoft },
  input: { borderWidth: 1, borderColor: sm.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 17, color: sm.ink, backgroundColor: sm.blueMist },
  error: { color: '#D93B30' },
  save: { alignSelf: 'flex-end', backgroundColor: sm.blueDark, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12 },
  saveText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
});
