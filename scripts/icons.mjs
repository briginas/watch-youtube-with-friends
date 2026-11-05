// Оригинальный векторный знак: два зрителя и общий play. PNG строятся из той же
// геометрии с supersampling, без внешних сервисов и библиотек.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const shapes = [
  { kind: 'rect', x: 16, y: 16, w: 96, h: 96, r: 25, color: '#18243b' },
  { kind: 'circle', x: 44, y: 43, r: 10, color: '#70dfeb' },
  { kind: 'circle', x: 84, y: 43, r: 10, color: '#bcadff' },
  { kind: 'rect', x: 31, y: 60, w: 66, h: 36, r: 10, color: '#70dfeb' },
  { kind: 'triangle', color: '#18243b' },
];
const svg = shapes.map(s => s.kind === 'rect' ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${s.color}"/>`
  : s.kind === 'circle' ? `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="${s.color}"/>`
  : `<path d="M59 67L77 78L59 89Z" fill="${s.color}"/>`).join('\n  ');
mkdirSync('assets', { recursive: true });
mkdirSync('public/icon', { recursive: true });
writeFileSync('assets/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">\n  ${svg}\n</svg>\n`);
function inside(s, x, y) {
  if (s.kind === 'circle') return (x - s.x) ** 2 + (y - s.y) ** 2 <= s.r ** 2;
  if (s.kind === 'triangle') return x >= 59 && x <= 77 && Math.abs(y - 78) <= (77 - x) * 11 / 18;
  const dx = Math.max(s.x + s.r - x, 0, x - (s.x + s.w - s.r));
  const dy = Math.max(s.y + s.r - y, 0, y - (s.y + s.h - s.r));
  return dx * dx + dy * dy <= s.r * s.r;
}
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data));
  return Buffer.concat([size, data, crc]);
}
for (const size of [16, 32, 48, 128]) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const rgba = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = (x + (sx + .5) / 4) * 128 / size, py = (y + (sy + .5) / 4) * 128 / size;
      const shape = shapes.findLast(s => inside(s, px, py));
      if (!shape) continue;
      const rgb = shape.color.slice(1).match(/../g).map(v => parseInt(v, 16));
      for (let i = 0; i < 3; i++) rgba[i] += rgb[i];
      rgba[3]++;
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    for (let i = 0; i < 3; i++) pixels[offset + i] = rgba[3] ? Math.round(rgba[i] / rgba[3]) : 0;
    pixels[offset + 3] = Math.round(rgba[3] * 255 / 16);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  writeFileSync(`public/icon/${size}.png`, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
}
console.log('SVG и PNG 16/32/48/128 готовы.');
