import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { ReplenishmentOrder, StoreTodaySummary } from '@/api/types';
import { productImageSource } from '@/brand/productImages';
import { OrderDetail } from './OrdersView';
import { formatArrival, formatCreatedAt } from './orders';
import { filterTasks, storeTasks, type TaskFilter } from './taskCenter';

const INK = '#132544';
const CATEGORIES = [
  { key: 'stock', title: '缺貨補貨', sub: '需盡快處理', icon: 'flame', color: '#FF3945', soft: '#FFF0F1' },
  { key: 'expiry', title: '即期品處理', sub: '確認商品效期', icon: 'timer-outline', color: '#FF9000', soft: '#FFF6E9' },
  { key: 'equipment', title: '設備維修', sub: '待排除', icon: 'build-outline', color: '#0089FF', soft: '#EBF6FF' },
  { key: 'promotion', title: '促銷活動', sub: '查看最新活動', icon: 'megaphone', color: '#00997C', soft: '#EBFAF4' },
] as const;

export interface TaskCenterViewProps {
  summary?: StoreTodaySummary;
  orders?: ReplenishmentOrder[];
  summaryLoading: boolean;
  ordersLoading: boolean;
  summaryError: boolean;
  ordersError: boolean;
  dateLabel: string;
  onRetry(): void;
  onAsk(question: string): void;
}

export function TaskCenterView(props: TaskCenterViewProps) {
  const { width, height } = useWindowDimensions();
  const wide = width >= 768;
  const scale = wide ? Math.min(width / 1024, height / 720, 1.3) : 1;
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [selected, setSelected] = useState<ReplenishmentOrder | null>(null);
  const tasks = useMemo(() => storeTasks(props.summary, props.orders), [props.summary, props.orders]);
  const visible = filterTasks(tasks, filter, null);
  const categoryTasks = tasks;
  const counts = { all: categoryTasks.length, pending: categoryTasks.filter((task) => task.status === 'pending').length, submitted: categoryTasks.filter((task) => task.status === 'submitted').length };
  const pendingCount = props.summary ? props.summary.lowStock.count + props.summary.expiring.count + props.summary.equipmentAlerts.count : undefined;
  const submittedCount = props.summary?.replenishmentsToday.count;
  const total = pendingCount !== undefined && submittedCount !== undefined ? pendingCount + submittedCount : undefined;
  const fraction = total ? (submittedCount ?? 0) / total : 0;
  const loading = props.summaryLoading || props.ordersLoading;
  const errors = props.summaryError || props.ordersError;


  return <ScrollView style={styles.page} scrollEnabled={!wide} showsVerticalScrollIndicator={!wide} contentContainerStyle={wide ? { flex: 1 } : { flexGrow: 1 }}>
    <View style={[styles.hero, wide ? { height: 238 * scale, flexDirection: 'row', paddingHorizontal: 28 * scale, gap: 18 * scale } : { padding: 16, gap: 14, alignItems: 'stretch' }]}>
      <View style={[styles.welcome, wide ? { flex: 1, height: 238 * scale, gap: 12 * scale } : { height: 220, gap: 4 }]}>
        <View style={[styles.heroArt, { width: (wide ? 290 : 150) * scale, height: (wide ? 238 : 220) * scale }]}>
          <Image source={require('../../assets/brand/mascot-tasks.png')} resizeMode="contain" accessibilityLabel="Open醬拿著工作板陪你完成任務" style={{ position: 'absolute', width: (wide ? 390 : 250) * scale, height: (wide ? 300 : 260) * scale, transform: [{ scaleX: -1 }], left: (wide ? -52 : -54) * scale, bottom: (wide ? -42 : -22) * scale }} />
        </View>
        <View style={[styles.intro, { flex: 1, gap: wide ? 14 : 10 }]}>
          <Text style={[styles.heading, { fontSize: wide ? 38 * scale : 27, paddingHorizontal: wide ? 14 : 10, paddingVertical: wide ? 8 : 6 }]}>任務中心</Text>
          <Text style={[styles.subtitle, { fontSize: wide ? 19 * scale : 14, lineHeight: wide ? 28 * scale : 23 }]}>Open醬幫你整理今天{'\n'}需要處理的事項！</Text>
          <Text style={[styles.encouragement, { fontSize: wide ? 15 * scale : 12 }]}>一起完成今天的任務吧！</Text>
        </View>
      </View>
      <View style={[styles.progress, wide ? { width: 216 * scale, padding: 20 * scale, gap: 14 * scale } : { width: '100%', padding: 16, gap: 10 }]}>
        <Text style={styles.date}>{props.dateLabel}</Text>
        <Text style={styles.progressTitle}>今日進度</Text>
        <View style={styles.progressRow}>
          <View style={[styles.ring, { width: 74 * scale, height: 74 * scale }]} accessibilityLabel={total !== undefined ? `今日已送出 ${submittedCount} 筆補貨單，待處理 ${pendingCount} 項警示` : '今日進度尚未載入'}>
            {Array.from({ length: 72 }, (_, index) => {
              const angle = index / 72 * Math.PI * 2;
              const radius = 33 * scale;
              return <View key={index} style={{ position: 'absolute', width: 5 * scale, height: 7 * scale, borderRadius: 2 * scale, backgroundColor: index / 72 < fraction ? '#009D7B' : '#BDE8D9', left: 37 * scale + Math.sin(angle) * radius - 2.5 * scale, top: 37 * scale - Math.cos(angle) * radius - 3.5 * scale, transform: [{ rotate: `${index / 72 * 360}deg` }] }} />;
            })}
            <Text style={styles.ringText}>{submittedCount ?? '–'}/{total ?? '–'}</Text>
          </View>
          <View style={{ flex: 1, gap: 7 }}>
            <Text style={styles.progressHint}>補貨已送出</Text>
            <View style={styles.track}><View style={[styles.fill, { width: `${fraction * 100}%` }]} /></View>
            <Text style={styles.progressHint}>{pendingCount ?? '–'} 項待處理</Text>
          </View>
        </View>
      </View>
    </View>
    <View style={[styles.listSection, !wide && { flex: undefined, minHeight: 240 }, { paddingHorizontal: wide ? 28 * scale : 16, paddingTop: 20 * scale }]}>
      <View style={[styles.listHead, !wide && { alignItems: 'flex-start', flexDirection: 'column' }]}>
        <Text style={styles.listTitle}>我的任務</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          {([['all', '全部', '#009D7B', '#E8F7F1'], ['pending', '待處理', '#FF8900', '#FFF4E5'], ['submitted', '已送出', '#0085ED', '#E8F4FF']] as const).map(([key, label, color, soft]) => <Pressable key={key} accessibilityRole="button" accessibilityLabel={`${label}任務`} accessibilityState={{ selected: filter === key }} onPress={() => setFilter(key)} style={[styles.filter, { backgroundColor: filter === key ? color : soft }]}><Text style={{ color: filter === key ? '#fff' : color, fontWeight: '700' }}>{label} ({counts[key]})</Text></Pressable>)}
          <View style={[styles.filter, { backgroundColor: '#F1F3F7' }]}><Text style={{ color: '#8290A6' }}>已完成 —</Text></View>
        </ScrollView>
      </View>
      {errors ? <Pressable accessibilityRole="button" accessibilityLabel="重試任務資料" onPress={props.onRetry} style={styles.error}><Text style={{ color: '#B75021' }}>部分任務資料暫時無法取得，點此重試</Text></Pressable> : null}
      <ScrollView style={wide ? { flex: 1 } : undefined} scrollEnabled={wide} contentContainerStyle={{ gap: 10, paddingBottom: 24 }}>
        {loading && tasks.length === 0 ? <ActivityIndicator color="#009D7B" style={{ marginTop: 24 }} /> : null}
        {!loading && !errors && visible.length === 0 ? <View style={styles.empty}><Ionicons name="checkmark-circle-outline" size={42} color="#009D7B" /><Text style={styles.emptyText}>{tasks.length === 0 ? '目前沒有待處理事項或補貨單' : '這個分類目前沒有任務'}</Text><Pressable accessibilityRole="button" onPress={() => props.onAsk('請幫我整理今天門市需要處理的事項')}><Text style={{ color: '#008568', fontWeight: '700' }}>讓 Open醬幫我查看</Text></Pressable></View> : null}
        {visible.map((task) => {
          const tone = CATEGORIES.find((card) => card.key === task.category)!;
          const image = task.productName ? productImageSource({ name: task.productName, productId: task.order?.items[0]?.productId }) : undefined;
          return <Pressable key={task.id} accessibilityRole="button" accessibilityLabel={task.order ? `補貨單 ${task.order.id}` : `處理 ${task.title}`} onPress={() => task.order ? setSelected(task.order) : props.onAsk(task.question!)} style={[styles.task, !wide && { flexWrap: 'wrap' }]}>
            <View style={[styles.thumbnail, { backgroundColor: tone.soft }]}>
              {image ? <Image source={image} resizeMode="contain" style={{ width: '100%', height: '100%' }} /> : <Ionicons name={tone.icon} size={40} color={tone.color} />}
              <View style={[styles.taskBadge, { backgroundColor: task.status === 'submitted' ? '#009D7B' : tone.color }]}><Text style={styles.taskBadgeText}>{task.status === 'submitted' ? '已送出' : task.category === 'stock' ? '缺貨' : task.category === 'expiry' ? '即期' : '異常'}</Text></View>
            </View>
            <View style={{ flex: 1, minWidth: 120, gap: 8 }}><Text style={styles.taskTitle} numberOfLines={2}>{task.title}</Text><Text style={styles.taskDetail} numberOfLines={2}>{task.detail}</Text><View style={styles.tags}><Text style={[styles.tag, { color: tone.color, backgroundColor: tone.soft }]}>{task.order ? '庫存補貨' : tone.title}</Text><Text style={[styles.tag, { color: '#7B879A', backgroundColor: '#F1F4F7' }]}>{task.status === 'pending' ? '待處理' : `${task.order!.itemCount} 項商品`}</Text></View></View>
            <View style={{ gap: 5, width: wide ? 150 : undefined }}><Text style={styles.taskTime}>{task.order ? `到貨 ${formatArrival(task.order.arrivalDate)}` : '今日待辦'}</Text>{task.order ? <Text style={styles.taskTime}>{formatCreatedAt(task.order.createdAt)}</Text> : null}</View>
            <View style={[styles.taskAction, { backgroundColor: task.status === 'pending' ? tone.color : '#E8F7F1' }]}><Text style={{ color: task.status === 'pending' ? '#fff' : '#008568', fontWeight: '800', fontSize: 16 }}>{task.order ? '查看明細' : '立即處理'}</Text></View>
            {wide ? <Ionicons name="chevron-forward" size={24} color="#A9B1C0" /> : null}
          </Pressable>;
        })}
      </ScrollView>
    </View>
    <Modal transparent visible={Boolean(selected)} animationType="fade" onRequestClose={() => setSelected(null)}><View style={styles.modalOverlay}><View style={styles.modalCard}><ScrollView>{selected ? <OrderDetail order={selected} onClose={() => setSelected(null)} /> : null}</ScrollView></View></View></Modal>
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0 },
  hero: { alignItems: 'center', justifyContent: 'space-between' },
  welcome: { flexDirection: 'row', alignItems: 'center' },
  intro: { minWidth: 0 }, heading: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.94)', borderRadius: 14, overflow: 'hidden', color: '#102747', fontWeight: '900' }, subtitle: { color: '#183250', fontWeight: '800', textShadowColor: '#FFFFFF', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 }, encouragement: { color: '#176953', fontWeight: '800', textShadowColor: '#FFFFFF', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 5 },
  heroArt: { position: 'relative', justifyContent: 'flex-end' },
  progress: { backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 22, alignSelf: 'center' },
  date: { color: '#8792A5', fontSize: 14, fontWeight: '600' }, progressTitle: { color: INK, fontSize: 20, fontWeight: '800' },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, ring: { position: 'relative', borderRadius: 60, alignItems: 'center', justifyContent: 'center' }, ringText: { color: INK, fontSize: 19, fontWeight: '800' }, progressHint: { color: '#7C8A9E', fontSize: 11 }, track: { backgroundColor: '#D4EFE7', height: 10, borderRadius: 6, overflow: 'hidden' }, fill: { height: '100%', backgroundColor: '#00A380', borderRadius: 6 },
  listSection: { flex: 1, minHeight: 0, marginTop: 16, backgroundColor: 'rgba(249,252,254,0.96)' }, listHead: { flexDirection: 'row', alignItems: 'center', gap: 20, marginBottom: 14 }, listTitle: { color: INK, fontWeight: '800', fontSize: 22 }, filters: { gap: 12, alignItems: 'center' }, filter: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 9 },
  task: { flexDirection: 'row', alignItems: 'center', gap: 18, padding: 14, backgroundColor: '#fff', borderRadius: 20 }, thumbnail: { width: 130, height: 86, borderRadius: 12, alignItems: 'center', justifyContent: 'center', position: 'relative' }, taskBadge: { position: 'absolute', top: 4, right: 4, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7 }, taskBadgeText: { color: '#fff', fontWeight: '800', fontSize: 14 }, taskTitle: { color: INK, fontWeight: '800', fontSize: 19 }, taskDetail: { color: '#8B95A6', fontSize: 13 }, tags: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' }, tag: { fontWeight: '700', fontSize: 12, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, overflow: 'hidden' }, taskTime: { color: '#8894A8', fontSize: 13 }, taskAction: { paddingVertical: 13, paddingHorizontal: 20, borderRadius: 12 }, error: { padding: 12, marginBottom: 12, borderRadius: 12, backgroundColor: '#FFF1DE' }, empty: { alignItems: 'center', padding: 30, gap: 14 }, emptyText: { color: '#718096', fontSize: 16 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', alignItems: 'center', padding: 24 }, modalCard: { width: '100%', maxWidth: 600, maxHeight: '85%', backgroundColor: '#fff', borderRadius: 24, padding: 24 },
});
