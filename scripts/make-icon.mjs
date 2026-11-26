// Generates build/icon.png (512x512): a rounded teal-to-blue tile with a rising trend line.
// Pure Node (zlib) PNG encoder so no image tooling is needed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const N = 512;
const px = Buffer.alloc(N * N * 4);
const mix = (a, b, t) => a + (b - a) * t;
const teal = [34, 211, 197];
const blue = [59, 158, 255];
const radius = 110;

function insideRounded(x, y) {
  const r = radius;
  const cx = x < r ? r : x > N - 1 - r ? N - 1 - r : x;
  const cy = y < r ? r : y > N - 1 - r ? N - 1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Trend polyline points (x, y) in pixel space.
const pts = [
  [90, 370],
  [180, 300],
  [240, 335],
  [330, 215],
  [380, 250],
  [430, 140],
];
function distToSegment(x, y, [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    if (!insideRounded(x, y)) continue;
    const t = (x + y) / (2 * N);
    let [r, g, b] = [mix(teal[0], blue[0], t), mix(teal[1], blue[1], t), mix(teal[2], blue[2], t)];
    // Dark inner panel.
    const inset = 38;
    if (x > inset && x < N - inset && y > inset && y < N - inset) [r, g, b] = [mix(14, 20, t), mix(24, 34, t), mix(34, 48, t)];
    // Grid lines.
    if (x > inset && x < N - inset && y > inset && y < N - inset && (y - inset) % 86 === 0) [r, g, b] = [40, 58, 78];
    // Trend line with soft edge.
    let d = Infinity;
    for (let k = 0; k < pts.length - 1; k++) d = Math.min(d, distToSegment(x, y, pts[k], pts[k + 1]));
    const w = 15;
    if (d < w + 1.5) {
      const a = Math.max(0, Math.min(1, w + 1.5 - d));
      const lr = mix(teal[0], 120, (x - 90) / 340);
      const lg = mix(teal[1], 240, (x - 90) / 340);
      const lb = mix(teal[2], 200, (x - 90) / 340);
      [r, g, b] = [mix(r, lr, a), mix(g, lg, a), mix(b, lb, a)];
    }
    // End-point dot.
    const dd = Math.hypot(x - 430, y - 140);
    if (dd < 30) {
      const a = Math.max(0, Math.min(1, 30 - dd));
      [r, g, b] = [mix(r, 255, a), mix(g, 255, a), mix(b, 255, a)];
    }
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out}`);
