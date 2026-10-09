// 產生 App 圖示：藍底白色機器人頭（RobotHead 的平面版）。不需要任何套件，直接寫 PNG。
//   node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encode(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// 圓角矩形的 signed distance（單位：畫布比例 0..1）
function roundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const ellipse = (px, py, cx, cy, rx, ry) => (Math.hypot((px - cx) / rx, (py - cy) / ry) - 1) * Math.min(rx, ry);

/** 機器人頭（圓頂頭盔、深色面罩、圓形藍眼、白色耳盤，與 RobotHead 同造型），scale 1 時約佔畫布寬 0.8 */
function robotLayers(scale) {
  const s = (v) => 0.5 + (v - 0.5) * scale;
  const k = scale;
  return [
    { color: hex('#E3EAF5'), d: (x, y) => roundRect(x, y, s(0.12), s(0.52), 0.07 * k, 0.12 * k, 0.07 * k) },
    { color: hex('#E3EAF5'), d: (x, y) => roundRect(x, y, s(0.88), s(0.52), 0.07 * k, 0.12 * k, 0.07 * k) },
    { color: hex('#FFFFFF'), d: (x, y) => roundRect(x, y, 0.5, s(0.5), 0.35 * k, 0.33 * k, 0.32 * k) },
    { color: hex('#0D1634'), d: (x, y) => roundRect(x, y, 0.5, s(0.48), 0.27 * k, 0.16 * k, 0.15 * k) },
    { color: hex('#2F7BFF'), d: (x, y) => ellipse(x, y, s(0.39), s(0.47), 0.058 * k, 0.058 * k) },
    { color: hex('#2F7BFF'), d: (x, y) => ellipse(x, y, s(0.61), s(0.47), 0.058 * k, 0.058 * k) },
    { color: hex('#FFFFFF'), d: (x, y) => ellipse(x, y, s(0.375), s(0.452), 0.016 * k, 0.016 * k) },
    { color: hex('#FFFFFF'), d: (x, y) => ellipse(x, y, s(0.595), s(0.452), 0.016 * k, 0.016 * k) },
  ];
}

function draw(size, { background, scale }) {
  const buf = Buffer.alloc(size * size * 4);
  const layers = robotLayers(scale);
  const aa = 1.2 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      let [r, g, b, a] = [0, 0, 0, 0];
      if (background) {
        // 左上亮藍到右下深藍的漸層
        const t = (x + y) / 2;
        const c0 = hex('#4F8BFF');
        const c1 = hex('#1F4FD8');
        [r, g, b] = c0.map((v, i) => v + (c1[i] - v) * t);
        a = 1;
      }
      for (const layer of layers) {
        const cover = Math.min(1, Math.max(0, 0.5 - layer.d(x, y) / aa));
        if (cover <= 0) continue;
        const na = cover + a * (1 - cover);
        [r, g, b] = layer.color.map((v, i) => (v * cover + [r, g, b][i] * a * (1 - cover)) / na);
        a = na;
      }
      const o = (py * size + px) * 4;
      buf[o] = Math.round(r);
      buf[o + 1] = Math.round(g);
      buf[o + 2] = Math.round(b);
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return encode(size, size, buf);
}

writeFileSync(join(out, 'icon.png'), draw(1024, { background: true, scale: 1 }));
// Android 自適應圖示：前景只用中間 66% 安全區
writeFileSync(join(out, 'android-icon-foreground.png'), draw(1024, { background: false, scale: 0.62 }));
writeFileSync(join(out, 'splash-icon.png'), draw(512, { background: true, scale: 1 }));
writeFileSync(join(out, 'favicon.png'), draw(48, { background: true, scale: 1 }));
console.log('已輸出 icon.png、android-icon-foreground.png、splash-icon.png、favicon.png');
