/*
 * A plain placeholder sprite sheet for testing drop-in characters
 * (app/agents.js, docs/agents.md "Drop-in sprite sheets"). No art: each
 * frame is a grey block with a light bar whose height is the frame's
 * number, so a test (or a person) can see which frame shows.
 *
 *   node dev/agents-sheet-sample.js <folder>   writes sheet.png and character.json there
 *   require('./agents-sheet-sample').sheet(o)  a PNG Buffer
 *   require('./agents-sheet-sample').manifest  the character.json that goes with it
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FRAME = { w: 24, h: 40 };
const COLS = 4;
const ROWS = 2;

// The character.json for the sample sheet: skate is row 0 (4 frames),
// crouch is row 1 (4 frames), everything else falls back to skate.
const manifest = {
  name: 'Sample',
  faces: 'right',
  scale: 3,
  frame: { w: FRAME.w, h: FRAME.h },
  poses: {
    skate: { file: 'sheet.png', row: 0, frames: 4, fps: 8 },
    crouch: { file: 'sheet.png', row: 1, frames: 4, fps: 4 }
  },
  hand: { x: 18, y: 38 }
};

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// RGBA PNG: COLS x ROWS frames; transparent round the block, so the
// see-through edges are tested too.
function sheet() {
  const W = FRAME.w * COLS;
  const H = FRAME.h * ROWS;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const fx = x % FRAME.w;
      const fy = y % FRAME.h;
      const n = Math.floor(y / FRAME.h) * COLS + Math.floor(x / FRAME.w);
      const o = y * (W * 4 + 1) + 1 + x * 4;
      const inBlock = fx >= 3 && fx < FRAME.w - 3 && fy >= 4;
      if (!inBlock) continue;
      const bar = fx >= 8 && fx < 16 && fy >= FRAME.h - 4 - (n + 1) * 3;
      const g = bar ? 230 : 90 + (n % COLS) * 20;
      raw[o] = g; raw[o + 1] = g; raw[o + 2] = g; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { sheet: sheet, manifest: manifest, FRAME: FRAME, COLS: COLS, ROWS: ROWS };

if (require.main === module) {
  const out = process.argv[2];
  if (!out) { console.log('usage: node dev/agents-sheet-sample.js <folder>'); process.exit(1); }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'sheet.png'), sheet());
  fs.writeFileSync(path.join(out, 'character.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('wrote ' + path.join(out, 'sheet.png') + ' and character.json');
}
