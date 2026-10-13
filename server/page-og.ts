/**
 * The preview picture Messages and other apps show beside a page link.
 *
 * It is drawn here, in memory, rather than shipped as a file under `public/`:
 * everything the static handler serves sits behind the sign-in gate, and a
 * link preview is fetched by a bot that has no session.
 */
import { deflateSync } from "node:zlib";

const WIDTH = 1200;
const HEIGHT = 630;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

type Rgb = [number, number, number];
const GREEN: Rgb = [31, 111, 92];
const DEEP: Rgb = [22, 82, 68];
const WHITE: Rgb = [255, 255, 255];
const LINE: Rgb = [226, 224, 215];
const MINT: Rgb = [228, 241, 236];

function pixel(x: number, y: number): Rgb {
  // The card, with a row of poll-style options inside it.
  const inCard = x >= 150 && x < 1050 && y >= 110 && y < 520;
  if (!inCard) return y > 540 ? DEEP : GREEN;
  if (y >= 150 && y < 190 && x >= 190 && x < 620) return GREEN;
  for (let row = 0; row < 3; row += 1) {
    const top = 240 + row * 82;
    if (y >= top && y < top + 56 && x >= 190 && x < 1010) {
      const fill = [0.72, 0.5, 0.3][row];
      return x < 190 + 820 * fill ? MINT : LINE;
    }
  }
  return WHITE;
}

let cached: Buffer | null = null;

export function pageOgImage(): Buffer {
  if (cached) return cached;
  const stride = WIDTH * 3 + 1;
  const raw = Buffer.alloc(stride * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const offset = y * stride;
    raw[offset] = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset + 1 + x * 3] = r;
      raw[offset + 2 + x * 3] = g;
      raw[offset + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  cached = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return cached;
}
