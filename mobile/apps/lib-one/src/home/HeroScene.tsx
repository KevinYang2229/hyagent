/**
 * 首頁長景（照 lib-one.com 首頁的分層插畫）：圖書館線稿背景與綠色弧線橫跨全幅、延伸出畫面兩側，
 * 人物各自去背疊在上面，依可用空間等比縮放、底部對齊排開。
 * 素材在 assets/scene：library.jpg（背景）、flow.png（弧線）、child／space／staff.png（三組人物，同一比例尺輸出）。
 */
import { LinearGradient } from 'expo-linear-gradient';
import { Image, StyleSheet, View, type ImageSourcePropType } from 'react-native';
import { lib } from '@/brand/theme';

export type SceneId = 'child' | 'space' | 'staff';

/** 人物圖的原始像素（同一比例尺），用來維持彼此的相對大小 */
const SCENES: Record<SceneId, { source: ImageSourcePropType; w: number; h: number; label: string }> = {
  child: { source: require('../../assets/scene/child.png'), w: 752, h: 813, label: '學生使用桌上型自助借還書機' },
  space: { source: require('../../assets/scene/space.png'), w: 731, h: 1088, label: '讀者使用直立式座位預約機' },
  staff: { source: require('../../assets/scene/staff.png'), w: 1193, h: 876, label: '館員在館員工作站服務' },
};
const LIBRARY = require('../../assets/scene/library.jpg');
const FLOW = require('../../assets/scene/flow.png');
const FLOW_RATIO = 396 / 3000;
const LIBRARY_RATIO = 724 / 2172;

/** 一列人物在 (width × height) 內的擺放：等比縮放到放得下，左右平均分配空間 */
export function placeScenes(ids: SceneId[], width: number, height: number) {
  const gap = 0.06;
  const naturalW = ids.reduce((sum, id) => sum + SCENES[id].w, 0);
  const tallest = Math.max(...ids.map((id) => SCENES[id].h));
  const k = Math.min(height / tallest, (width * (1 - gap * (ids.length - 1))) / naturalW);
  const used = naturalW * k;
  const space = ids.length > 1 ? (width - used) / (ids.length - 1) : 0;
  let x = ids.length > 1 ? 0 : (width - used) / 2;
  return ids.map((id) => {
    const w = SCENES[id].w * k;
    const h = SCENES[id].h * k;
    const placed = { id, left: x, width: w, height: h };
    x += w + space;
    return placed;
  });
}

export function HeroScene({ width, height, scenes, sceneLeft, sceneTop, sceneHeight, flowTop, readableLeft = 0 }: {
  /** 整個長景的寬高（滿版） */
  width: number;
  height: number;
  scenes: SceneId[];
  /** 人物區塊的左緣、上緣與高度（人物底部對齊 sceneTop + sceneHeight） */
  sceneLeft: number;
  sceneTop: number;
  sceneHeight: number;
  /** 弧線的上緣 */
  flowTop: number;
  /** 左側要給標語閱讀的寬度：背景在這段淡一些 */
  readableLeft?: number;
}) {
  const placed = placeScenes(scenes, width - sceneLeft - 12, sceneHeight);
  const bgH = Math.max(height, width * LIBRARY_RATIO);
  // 標語在左時弧線放大右移：第一個圈移出畫面左側，第二個圈落在人物附近
  const flowShift = readableLeft > 0 ? 0.55 : 0.04;
  const flowW = width * (readableLeft > 0 ? 1.6 : 1.08);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { height }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {/* 背景：圖書館線稿滿版，上下淡入頁面底色 */}
      <Image source={LIBRARY} style={{ position: 'absolute', left: 0, top: 0, width, height: bgH, opacity: 0.55 }} resizeMode="cover" />
      <LinearGradient colors={[lib.greenMist, 'rgba(243,248,243,0)']} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: height * 0.18 }} />
      <LinearGradient colors={['rgba(243,248,243,0)', lib.greenMist]} style={{ position: 'absolute', left: 0, right: 0, top: height * 0.62, height: height * 0.38 + 2 }} />
      {/* 綠色弧線：比畫面寬、兩端延伸出畫面；往右偏，讓繞圈的地方落在人物那側，不壓到標語 */}
      <Image source={FLOW} style={{ position: 'absolute', left: -width * flowShift, top: flowTop, width: flowW, height: flowW * FLOW_RATIO }} resizeMode="stretch" />
      {readableLeft > 0 ? (
        <LinearGradient
          colors={['rgba(243,248,243,0.85)', 'rgba(243,248,243,0.6)', 'rgba(243,248,243,0)']}
          locations={[0, 0.7, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: readableLeft }}
        />
      ) : null}

      {placed.map((p) => (
        <Image
          key={p.id}
          source={SCENES[p.id].source}
          style={{ position: 'absolute', left: sceneLeft + p.left, top: sceneTop + sceneHeight - p.height, width: p.width, height: p.height }}
          resizeMode="contain"
          accessibilityLabel={SCENES[p.id].label}
        />
      ))}
    </View>
  );
}
