import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(scriptDir, '..', 'assets');

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function roundedSquare(x, y) {
  const radius = 0.23;
  const dx = Math.max(Math.abs(x) - (0.78 - radius), 0);
  const dy = Math.max(Math.abs(y) - (0.78 - radius), 0);
  return Math.hypot(dx, dy) <= radius;
}

function star(x, y) {
  return Math.abs(x) / 0.12 + Math.abs(y) / 0.54 <= 1
    || Math.abs(x) / 0.54 + Math.abs(y) / 0.12 <= 1;
}

function renderPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const samples = 3;
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    raw[row] = 0;
    for (let px = 0; px < size; px++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = ((px + (sx + 0.5) / samples) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / samples) / size) * 2 - 1;
          if (!roundedSquare(x, y)) continue;
          const gradient = Math.max(0, Math.min(1, (x + y + 2) / 4));
          let color = [111 - 35 * gradient, 101 - 34 * gradient, 255 - 22 * gradient];
          if (star(x, y)) color = [255, 255, 255];
          if (Math.hypot(x - 0.39, y + 0.39) < 0.075) color = [234, 209, 127];
          red += color[0];
          green += color[1];
          blue += color[2];
          alpha += 255;
        }
      }
      const count = samples * samples;
      const offset = row + 1 + px * 4;
      raw[offset] = Math.round(red / count);
      raw[offset + 1] = Math.round(green / count);
      raw[offset + 2] = Math.round(blue / count);
      raw[offset + 3] = Math.round(alpha / count);
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, png: renderPng(size) }));
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ size, png }, index) => {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header[entry + 2] = 0;
  header[entry + 3] = 0;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});

await mkdir(assetsDir, { recursive: true });
await writeFile(path.join(assetsDir, 'icon.png'), images.at(-1).png);
await writeFile(path.join(assetsDir, 'icon.ico'), Buffer.concat([header, ...images.map(({ png }) => png)]));
process.stdout.write('桌面图标已生成。\n');
