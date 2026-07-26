/**
 * Dependency-free sample product image for the load seed. Generates a small
 * valid PNG (a concentric "part" icon on a light card) using only Node's
 * built-in zlib — no image library, no external fetch. Every seeded product
 * points at one uploaded copy of this so the catalog renders realistically
 * instead of showing the empty-image placeholder.
 */
import zlib from "node:zlib";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** Returns a PNG buffer: RGB, `size`×`size`, a teal bearing-style icon. */
export function samplePng(size = 400) {
  const W = size, H = size;
  const bg = [241, 245, 249];   // slate-100 card
  const teal = [13, 148, 136];  // teal-600
  const white = [255, 255, 255];
  const cx = W / 2, cy = H / 2;
  const rOuter = size * 0.34, rInner = size * 0.2, rDot = size * 0.07;

  const raw = Buffer.alloc(H * (1 + W * 3));
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let c = bg;
      if (d < rOuter) c = teal;
      if (d < rInner) c = white;
      if (d < rDot) c = teal;
      raw[o++] = c[0]; raw[o++] = c[1]; raw[o++] = c[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type 2 = truecolour (RGB)
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
