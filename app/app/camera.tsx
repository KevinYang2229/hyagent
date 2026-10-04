/** 相機（全螢幕）：貨架／優惠券拍照辨識，或掃優惠券條碼；也可從相簿選照片。 */
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorMessage } from '@/api/errors';
import { storeTool } from '@/api/storeTools';
import { useApi } from '@/auth/AuthProvider';
import { Mascot } from '@/brand/Mascot';
import { colors, font, radius, space } from '@/theme/tokens';
import { fromCouponCheck, fromVision, type CouponCheck } from '@/vision/coupon';
import { prepareImage } from '@/vision/prepareImage';
import { createScanGate } from '@/vision/scanGate';
import type { Photo } from '@/vision/types';
import { visionErrorHint } from '@/vision/visionErrors';
import { useVisionResults } from '@/vision/VisionResultStore';

type Mode = 'shelf' | 'coupon' | 'barcode';
const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: 'shelf', label: '貨架', hint: '把整排貨架放進框內' },
  { key: 'coupon', label: '優惠券', hint: '把整張優惠券放進框內' },
  { key: 'barcode', label: '掃條碼', hint: '對準優惠券條碼' },
];

export default function Camera() {
  const params = useLocalSearchParams<{ mode?: Mode }>();
  const [mode, setMode] = useState<Mode>(params.mode && MODES.some((m) => m.key === params.mode) ? params.mode : 'shelf');
  const [permission, requestPermission] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const gate = useRef(createScanGate()).current;
  const capture_ = useRef(createScanGate()).current;
  const api = useApi();
  const vision = useVisionResults();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 拍照／選圖共用：同步取得鎖後才 await，連點只會處理一次。 */
  async function capture(getPhoto: () => Promise<Photo | null>) {
    if (!capture_.tryAcquire()) return;
    const kind = mode === 'coupon' ? 'coupon' : 'shelf';
    setBusy(true);
    setError(null);
    let navigated = false;
    try {
      const src = await getPhoto();
      if (!src) return;
      const photo = await prepareImage(src);
      const res = await api.analyzeImage(kind, { uri: photo.uri, name: 'photo.jpg', type: 'image/jpeg' });
      if (res.mode === 'shelf') {
        vision.setShelf({ photo, result: res });
        navigated = true;
        router.replace('/chat/shelf-result');
      } else {
        vision.setCoupon({ photo, view: fromVision(res) });
        navigated = true;
        router.replace('/chat/coupon-result');
      }
    } catch (e) {
      setError(visionErrorHint(e, kind));
    } finally {
      setBusy(false);
      if (!navigated) capture_.release();
    }
  }

  function shoot() {
    void capture(async () => {
      const pic = await cam.current?.takePictureAsync({ quality: 0.8 });
      return pic ? { uri: pic.uri, width: pic.width, height: pic.height } : null;
    });
  }

  function pick() {
    void capture(async () => {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      const a = !r.canceled ? r.assets[0] : undefined;
      return a ? { uri: a.uri, width: a.width, height: a.height } : null;
    });
  }

  async function onScanned({ data }: { data: string }) {
    if (mode !== 'barcode' || !data || !gate.tryAcquire(data)) return;
    setBusy(true);
    setError(null);
    try {
      const { result } = await api.invokeTool<CouponCheck>(storeTool('coupon_check'), { code: data });
      vision.setCoupon({ view: fromCouponCheck(result) });
      router.replace('/chat/coupon-result');
    } catch (e) {
      setError(errorMessage(e));
      gate.release({ cooldownMs: 2500 });
    } finally {
      setBusy(false);
    }
  }

  if (!permission) return <View style={styles.black} />;
  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.permission}>
        <Mascot pose="wave" size={120} />
        <Text style={styles.permTitle}>需要相機權限</Text>
        <Text style={styles.permText}>拍貨架與優惠券需要使用相機。</Text>
        {permission.canAskAgain ? (
          <Pressable style={styles.permBtn} onPress={() => void requestPermission()} accessibilityRole="button">
            <Text style={styles.permBtnText}>允許使用相機</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.permBtn} onPress={() => void Linking.openSettings()} accessibilityRole="button">
            <Text style={styles.permBtnText}>前往設定</Text>
          </Pressable>
        )}
        <Pressable onPress={() => router.back()} accessibilityRole="button">
          <Text style={{ color: colors.textMuted, fontSize: font.md }}>返回</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const meta = MODES.find((m) => m.key === mode)!;
  return (
    <View style={styles.black}>
      <CameraView
        ref={cam}
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr', 'code128', 'code39', 'ean13', 'ean8'] }}
        onBarcodeScanned={mode === 'barcode' && !busy ? onScanned : undefined}
      />
      <SafeAreaView style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <View style={styles.top}>
          <View style={{ width: 30 }} />
          <View style={styles.modes}>
            {MODES.map((m) => (
              <Pressable
                key={m.key}
                onPress={() => { setMode(m.key); setError(null); gate.release(); }}
                style={[styles.mode, mode === m.key && styles.modeOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: mode === m.key }}
              >
                <Text style={[styles.modeText, mode === m.key && styles.modeTextOn]}>{m.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={{ width: 30 }} />
        </View>
        <View style={styles.frameWrap} pointerEvents="none">
          <View style={[styles.frame, mode === 'barcode' && styles.frameBarcode]}>
            <Text style={styles.frameHint}>{meta.hint}</Text>
          </View>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.bottom}>
          <Pressable onPress={pick} style={styles.album} accessibilityLabel="從相簿選擇" accessibilityRole="button" disabled={mode === 'barcode' || busy}>
            <Ionicons name="images-outline" size={26} color={mode === 'barcode' ? 'rgba(255,255,255,0.3)' : '#fff'} />
          </Pressable>
          {mode !== 'barcode' ? (
            <Pressable onPress={shoot} style={styles.shutter} accessibilityLabel="拍照" accessibilityRole="button">
              <View style={styles.shutterInner} />
            </Pressable>
          ) : (
            <View style={styles.shutterPlaceholder} />
          )}
          <View style={styles.album} />
        </View>
      </SafeAreaView>
      {busy ? (
        <View style={styles.busy} pointerEvents="none">
          <Mascot pose="wave" size={96} />
          <ActivityIndicator color="#fff" />
          <Text style={styles.busyText}>Open醬看看…</Text>
        </View>
      ) : null}
      <SafeAreaView style={styles.closeWrap} pointerEvents="box-none">
        <Pressable onPress={() => router.back()} accessibilityLabel="關閉" accessibilityRole="button" hitSlop={12} style={styles.close}>
          <Ionicons name="close" size={30} color="#fff" />
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  closeWrap: { position: 'absolute', top: 0, left: 0, right: 0 },
  close: { paddingHorizontal: space.lg, paddingTop: space.sm, alignSelf: 'flex-start' },
  black: { flex: 1, backgroundColor: '#000' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.sm },
  modes: { flexDirection: 'row', gap: 4, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: radius.pill, padding: 4 },
  mode: { paddingHorizontal: space.lg, paddingVertical: 8, borderRadius: radius.pill },
  modeOn: { backgroundColor: '#fff' },
  modeText: { color: '#fff', fontSize: font.md, fontWeight: '600' },
  modeTextOn: { color: colors.primaryDark },
  frameWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: { width: '78%', height: '62%', borderWidth: 2, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.75)', borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  frameBarcode: { height: 140 },
  frameHint: { color: '#fff', fontSize: font.md, backgroundColor: 'rgba(0,0,0,0.35)', paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.md, overflow: 'hidden' },
  error: { alignSelf: 'center', color: '#fff', backgroundColor: colors.danger, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.md, overflow: 'hidden', marginBottom: space.md },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingBottom: space.xl },
  album: { width: 52, height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.15)' },
  shutter: { width: 80, height: 80, borderRadius: 40, borderWidth: 5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff' },
  shutterPlaceholder: { width: 80, height: 80 },
  busy: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', gap: space.md },
  busyText: { color: '#fff', fontSize: font.lg, fontWeight: '700' },
  permission: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  permTitle: { fontSize: font.xl, fontWeight: '800', color: colors.text },
  permText: { fontSize: font.md, color: colors.textMuted },
  permBtn: { backgroundColor: colors.primary, borderRadius: radius.lg, paddingHorizontal: space.xl, paddingVertical: 14 },
  permBtnText: { color: '#fff', fontSize: font.lg, fontWeight: '700' },
});
