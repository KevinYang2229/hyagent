/** 帳號與設定：工作身分、AI 使用偏好與進階連線設定。 */
import { APP_IMAGES } from '@/brand/assets';
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, useWindowDimensions } from 'react-native';
import type { Applicant } from '@hyagent/shared';
import { normalizeServerUrl } from '@hyagent/app-core/api/config';
import { colors, radius, shadow } from '@hyagent/app-core/theme/tokens';

export function MeView({ user, speakEnabled, onToggleSpeak, serverUrl, onSaveServer, onLogout }: {
  user: Applicant | null;
  speakEnabled: boolean;
  onToggleSpeak(on: boolean): void;
  serverUrl: string;
  onSaveServer(url: string): Promise<void>;
  onLogout(): void;
}) {
  const wide = useWindowDimensions().width >= 768;
  const [server, setServer] = useState(serverUrl);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const changed = normalizeServerUrl(server) !== normalizeServerUrl(serverUrl) && server.trim() !== '';
  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    setError('');
    try { await onSaveServer(server); }
    catch { setError('儲存失敗，請稍後再試。'); }
    finally { setSaving(false); }
  };

  return <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={[styles.page, { paddingHorizontal: wide ? 30 : 16 }]}>
    <View style={styles.headingRow}>
      <View style={styles.headingIcon}><Ionicons name="settings-outline" size={27} color="#00866B" /></View>
      <View style={{ flex: 1 }}><Text style={styles.heading}>帳號與設定</Text><Text style={styles.subtitle}>查看工作身分，調整你的 AI 助理使用偏好。</Text></View>
    </View>
    <View style={[styles.columns, { flexDirection: wide ? 'row' : 'column' }]}>
      <View style={[styles.profile, wide && { flex: 0.9 }]}>
        <View style={styles.profileTop}><Text style={styles.eyebrow}>工作帳號</Text><View style={styles.status}><View style={styles.dot} /><Text style={styles.statusText}>已登入</Text></View></View>
        <View style={styles.identity}>
          <View style={styles.avatar}><Image source={APP_IMAGES.staffAvatar} style={{ width: 82, height: 82 }} resizeMode="contain" accessibilityLabel="店員頭像" /></View>
          <View style={{ flex: 1, gap: 6 }}><Text style={styles.name}>{user?.name || '尚未提供姓名'}</Text><Text style={styles.role}>{user?.title || '店員'}</Text></View>
        </View>
        <View style={styles.details}>
          <Detail label="所屬門市／部門" value={user?.department || '尚未提供'} icon="storefront-outline" />
          <Detail label="登入帳號" value={user?.id || '尚未提供'} icon="person-outline" />
          {user?.company ? <Detail label="公司" value={user.company} icon="business-outline" /> : null}
          {user?.region ? <Detail label="所屬地區" value={user.region} icon="location-outline" /> : null}
          {user?.email ? <Detail label="電子郵件" value={user.email} icon="mail-outline" /> : null}
        </View>
        <View style={styles.note}><Ionicons name="information-circle-outline" size={19} color="#00866B" /><Text style={styles.noteText}>工作身分由登入帳號提供；資料需要調整時，請聯絡管理員。</Text></View>
      </View>
      <View style={{ flex: 1.3, gap: 16 }}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>AI 使用偏好</Text>
          <Text style={styles.subtitle}>讓助理配合你的工作方式。</Text>
          <View style={styles.preference}>
            <View style={styles.settingIcon}><Ionicons name="volume-medium-outline" size={25} color="#00866B" /></View>
            <View style={{ flex: 1, gap: 5 }}><Text style={styles.label}>朗讀 AI 回覆</Text><Text style={styles.description}>自動朗讀助理的文字回覆，忙碌時也能聽取資訊。</Text></View>
            <Switch value={speakEnabled} onValueChange={onToggleSpeak} accessibilityLabel="朗讀 AI 回覆" trackColor={{ true: '#009D7B', false: '#DDE6E2' }} />
          </View>
          <View style={styles.preferenceState}><Text style={styles.stateText}>{speakEnabled ? '目前已開啟自動朗讀' : '目前以文字顯示回覆'}</Text><Text style={styles.description}>偏好會保存在這台裝置。</Text></View>
        </View>
        <View style={styles.card}>
          <Pressable onPress={() => setAdvanced(!advanced)} accessibilityRole="button" accessibilityLabel="進階連線設定" accessibilityState={{ expanded: advanced }} style={styles.advancedHeader}>
            <View style={styles.settingIcon}><Ionicons name="server-outline" size={24} color="#00866B" /></View>
            <View style={{ flex: 1, gap: 5 }}><Text style={styles.sectionTitle}>進階連線設定</Text><Text style={styles.description}>需要切換服務環境時再調整。</Text></View>
            <Ionicons name={advanced ? 'chevron-up' : 'chevron-down'} size={22} color={colors.textMuted} />
          </Pressable>
          {advanced ? <View style={styles.advancedBody}>
            <Text style={styles.label}>伺服器位址</Text>
            <TextInput style={styles.input} value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="伺服器位址" placeholder="https://example.com" />
            <Text style={styles.description}>儲存後會登出，請使用新的伺服器重新登入。</Text>
            {error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text> : null}
            <Pressable style={[styles.save, (!changed || saving) && { opacity: 0.4 }]} disabled={!changed || saving} onPress={() => void save()} accessibilityLabel="儲存伺服器位址" accessibilityRole="button" accessibilityState={{ disabled: !changed || saving, busy: saving }}><Text style={styles.saveText}>{saving ? '儲存中…' : '儲存並重新登入'}</Text></Pressable>
          </View> : null}
        </View>
        <View style={styles.session}>
          <View style={{ flex: 1, gap: 5 }}><Text style={styles.label}>結束使用</Text><Text style={styles.description}>共用裝置交接前，請登出你的帳號。</Text></View>
          <Pressable style={styles.logout} onPress={onLogout} accessibilityLabel="登出" accessibilityRole="button"><Ionicons name="log-out-outline" size={20} color={colors.danger} /><Text style={styles.logoutText}>登出</Text></Pressable>
        </View>
      </View>
    </View>
  </ScrollView>;
}

function Detail({ label, value, icon }: { label: string; value: string; icon: keyof typeof Ionicons.glyphMap }) {
  return <View style={styles.detail}><Ionicons name={icon} size={20} color="#00866B" /><View style={{ flex: 1, gap: 4 }}><Text style={styles.description}>{label}</Text><Text selectable style={styles.detailValue}>{value}</Text></View></View>;
}

const styles = StyleSheet.create({
  page: { paddingTop: 20, paddingBottom: 28, gap: 22, maxWidth: 1180, width: '100%', alignSelf: 'center' },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  headingIcon: { width: 54, height: 54, borderRadius: 18, backgroundColor: '#DAF7EF', alignItems: 'center', justifyContent: 'center' },
  heading: { fontSize: 28, fontWeight: '800', color: '#132544', marginBottom: 5 },
  subtitle: { fontSize: 14, lineHeight: 22, color: '#5B6B78' },
  columns: { gap: 20, alignItems: 'stretch' },
  profile: { backgroundColor: '#EDF9F4', borderRadius: radius.xl, padding: 22, borderWidth: 1, borderColor: '#D3ECE2', gap: 22 },
  profileTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  eyebrow: { color: '#00866B', fontSize: 15, fontWeight: '700' },
  status: { flexDirection: 'row', gap: 6, alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#009D7B' },
  statusText: { fontSize: 12, fontWeight: '600', color: '#00866B' },
  identity: { flexDirection: 'row', gap: 16, alignItems: 'center' },
  avatar: { width: 90, height: 90, borderRadius: 30, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 25, fontWeight: '800', color: '#132544' },
  role: { fontSize: 15, color: '#00866B', fontWeight: '600' },
  details: { backgroundColor: '#FFFFFF', borderRadius: 18, paddingHorizontal: 16 },
  detail: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  detailValue: { fontSize: 16, lineHeight: 23, color: '#132544', fontWeight: '600' },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  noteText: { flex: 1, fontSize: 13, lineHeight: 21, color: '#557266' },
  card: { backgroundColor: colors.surface, borderRadius: radius.xl, padding: 22, borderWidth: 1, borderColor: '#E2EEE8', ...shadow.card },
  sectionTitle: { fontSize: 19, color: '#132544', fontWeight: '800' },
  preference: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 22 },
  settingIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: '#E8F8F1', alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 16, fontWeight: '700', color: '#132544' },
  description: { fontSize: 13, lineHeight: 20, color: '#5B6B78' },
  preferenceState: { borderTopWidth: 1, borderTopColor: '#EEF3F0', paddingTop: 14, marginTop: 18, gap: 4 },
  stateText: { fontSize: 13, fontWeight: '600', color: '#00866B' },
  advancedHeader: { flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 48 },
  advancedBody: { marginTop: 20, paddingTop: 18, borderTopWidth: 1, borderTopColor: '#EEF3F0', gap: 10 },
  input: { borderWidth: 1, borderColor: '#D6E4DD', borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, color: colors.text, backgroundColor: '#F8FBF9' },
  save: { alignSelf: 'flex-end', backgroundColor: '#00866B', borderRadius: radius.md, paddingHorizontal: 20, paddingVertical: 13, marginTop: 4 },
  saveText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
  session: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 8, paddingVertical: 12 },
  logout: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: '#F1CEC8', backgroundColor: '#FFF9F8', borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 18 },
  logoutText: { color: colors.danger, fontSize: 15, fontWeight: '700' },
});
