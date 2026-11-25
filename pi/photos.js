/*
 * The photo album: friends' photos copied from the wall calendar (Dragon
 * Touch, eCalendar app, /sdcard/CloudAlbum/) by photos-sync.sh on the Pi
 * host, then read by server.js for the TV and the touch app.
 *
 * One storage interface, so the place the files live can change without
 * touching server.js:
 *   store.list()            -> { rev, count, items: [{ id, w, h, month, added, video?, dur? }] }
 *                              newest first, at most MAX_LIST
 *   store.readOriginal(id)  -> { file, type, size } or null (a video's still frame)
 *   store.readThumb(id)     -> the same; the original when there is no thumb
 *   store.readClip(id)      -> a video's H.264 clip ({ file, type: 'video/mp4', size }), else null
 *   store.stat()            -> { count, lastRun, ok, newCount }
 * This file has the local-folder store (createLocalStore) over data/photos/:
 *   orig/        the files as pulled from the calendar
 *   thumb/       <id>.jpg (480 px wide), or <id>.<ext> (a copy) without ImageMagick
 *   clip/        <id>.mp4: a video (a "live photo") made small and H.264 by
 *                photos-sync.sh with ffmpeg (HEVC plays on neither the TV nor
 *                the tablet); <id>.bad when ffmpeg could not read it
 *   still/       <id>.jpg: the clip's first frame, shown before and after it plays
 *   index.json   { v: 1, items: [...] }, rebuilt by buildIndex (written atomically)
 *   state.json   { lastRun, ok, count, newCount } from the last sync
 * An R2 store (Cloudflare) will replace it later with the same four calls.
 *
 * Privacy: a photo's id is the first 12 hex digits of the SHA-1 of its file
 * name. File names never leave this file: not in the index, an answer or a
 * log line. Callers log counts only.
 *
 * Images: .webp .jpg .jpeg .png. Width and height come from the file's own
 * header (WebP VP8/VP8L/VP8X, JPEG SOF, PNG IHDR), month ("YYYY-MM") from the
 * file's modified time. Videos (.mp4 .mov .m4v) join the index only once
 * their clip and still exist (so without ffmpeg they simply wait): the item
 * gets video: 1, its size from the still and dur (seconds) from the clip's
 * mvhd box.
 *
 * CLI (run by photos-sync.sh): node photos.js index [dataDir] [--new N] [--ok 0|1]
 * rebuilds index.json and writes state.json; prints counts only.
 * Node 14 or newer, no npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LIST = 500;
const HEAD_BYTES = 512 * 1024; // a JPEG's EXIF block can push its SOF far in
const ID_RE = /^[0-9a-f]{12}$/;
const TYPES = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const VIDEO_EXT = { '.mp4': 1, '.mov': 1, '.m4v': 1 };

function idFor(name) {
  return crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 12);
}

function isId(v) {
  return typeof v === 'string' && ID_RE.test(v);
}

function typeOf(name) {
  return TYPES[path.extname(String(name)).toLowerCase()] || null;
}

function isVideo(name) {
  return VIDEO_EXT[path.extname(String(name)).toLowerCase()] === 1;
}

/* ---------- image headers ---------- */

function webpSize(b) {
  if (b.length < 16 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('ascii', 12, 16);
  if (b.length < (kind === 'VP8L' ? 25 : 30)) return null;
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  return null;
}

function pngSize(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // no length
    if (m === 0xd9 || m === 0xda) return null; // end, or image data before any SOF
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      if (i + 9 > b.length) return null;
      return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

// { w, h } from the first bytes of a WebP, JPEG or PNG file, or null.
function imageSize(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const s = webpSize(buf) || pngSize(buf) || jpegSize(buf);
  return s && s.w > 0 && s.h > 0 ? s : null;
}

// A clip's length in seconds (one decimal) from its moov/mvhd box, or 0.
// ffmpeg's +faststart puts moov near the start, inside the head we read.
function mp4Duration(b) {
  if (!Buffer.isBuffer(b)) return 0;
  function find(type, from, to) {
    let i = from;
    while (i + 8 <= to) {
      let size = b.readUInt32BE(i);
      let head = 8;
      if (size === 1) {
        if (i + 16 > to) return null;
        size = Number(b.readBigUInt64BE(i + 8));
        head = 16;
      } else if (size === 0) size = to - i;
      if (size < head) return null;
      if (b.toString('ascii', i + 4, i + 8) === type) return { start: i + head, end: Math.min(i + size, to) };
      i += size;
    }
    return null;
  }
  try {
    const moov = find('moov', 0, b.length);
    const mvhd = moov && find('mvhd', moov.start, moov.end);
    if (!mvhd) return 0;
    const v = b[mvhd.start];
    const scale = v === 1 ? b.readUInt32BE(mvhd.start + 20) : b.readUInt32BE(mvhd.start + 12);
    const dur = v === 1 ? Number(b.readBigUInt64BE(mvhd.start + 24)) : b.readUInt32BE(mvhd.start + 16);
    if (!scale || !dur) return 0;
    return Math.round(dur / scale * 10) / 10;
  } catch (e) { return 0; }
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------- the index ---------- */

function month(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeAtomic(file, value) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// { id: file name } for every image in a folder ({} when it is missing).
function namesById(dir) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  names.forEach((n) => {
    if (n[0] !== '.' && typeOf(n)) out[idFor(n)] = n;
  });
  return out;
}

// Reads orig/, writes index.json atomically. Keeps each known photo's
// "added" time. A file whose header cannot be read is skipped (counted).
function buildIndex(dir, now) {
  now = typeof now === 'number' ? now : Date.now();
  const origDir = path.join(dir, 'orig');
  const old = readJson(path.join(dir, 'index.json'));
  const added = {};
  if (old && Array.isArray(old.items)) old.items.forEach((i) => { if (i && isId(i.id) && typeof i.added === 'number') added[i.id] = i.added; });
  const byId = namesById(origDir);
  const rows = [];
  let skipped = 0;
  let waiting = 0;
  // Videos: in once their clip and still are made.
  let origNames = [];
  try { origNames = fs.readdirSync(origDir); } catch (e) { origNames = []; }
  origNames.forEach((n) => {
    if (n[0] === '.' || !isVideo(n)) return;
    const id = idFor(n);
    let st;
    let size = null;
    let dur = 0;
    try {
      st = fs.statSync(path.join(origDir, n));
      const clip = path.join(dir, 'clip', id + '.mp4');
      const still = path.join(dir, 'still', id + '.jpg');
      if (st.isFile() && fs.existsSync(clip) && fs.existsSync(still)) {
        size = imageSize(readHead(still));
        dur = mp4Duration(readHead(clip));
      }
    } catch (e) { size = null; }
    if (!size) {
      if (!fs.existsSync(path.join(dir, 'clip', id + '.bad'))) waiting++;
      return;
    }
    const item = { id: id, w: size.w, h: size.h, month: month(st.mtimeMs), added: added[id] || now, video: 1 };
    if (dur > 0) item.dur = dur;
    rows.push({ mtime: st.mtimeMs, item: item });
  });
  Object.keys(byId).forEach((id) => {
    const file = path.join(origDir, byId[id]);
    let st;
    let size;
    try {
      st = fs.statSync(file);
      size = st.isFile() ? imageSize(readHead(file)) : null;
    } catch (e) { size = null; }
    if (!size) { skipped++; return; }
    rows.push({ mtime: st.mtimeMs, item: { id: id, w: size.w, h: size.h, month: month(st.mtimeMs), added: added[id] || now } });
  });
  rows.sort((a, b) => b.mtime - a.mtime || b.item.added - a.item.added || (a.item.id < b.item.id ? -1 : 1));
  const items = rows.map((r) => r.item);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, 'index.json'), { v: 1, items: items });
  return { count: items.length, skipped: skipped, waiting: waiting };
}

function writeState(dir, st) {
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, 'state.json'), {
    lastRun: typeof st.lastRun === 'string' ? st.lastRun : new Date().toISOString(),
    ok: st.ok !== false,
    count: Number.isInteger(st.count) ? st.count : 0,
    newCount: Number.isInteger(st.newCount) ? st.newCount : 0
  });
}

/* ---------- the local-folder store ---------- */

function createLocalStore(opt) {
  const dir = opt.dir;
  const origDir = path.join(dir, 'orig');
  const thumbDir = path.join(dir, 'thumb');
  const indexFile = path.join(dir, 'index.json');
  let cache = { mtime: -1, view: { rev: '', count: 0, items: [] } };
  let names = { mtime: -1, byId: {} };
  let thumbs = { mtime: -1, byId: {} };

  function mtimeOf(p) {
    try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; }
  }

  // The index, read again only when the file changed.
  function view() {
    const m = mtimeOf(indexFile);
    if (m === cache.mtime) return cache.view;
    const raw = readJson(indexFile);
    const items = (raw && Array.isArray(raw.items) ? raw.items : []).filter((i) =>
      i && isId(i.id) && Number.isInteger(i.w) && Number.isInteger(i.h) && /^\d{4}-\d{2}$/.test(i.month)
    ).slice(0, MAX_LIST).map((i) => {
      const o = { id: i.id, w: i.w, h: i.h, month: i.month, added: typeof i.added === 'number' ? i.added : 0 };
      if (i.video === 1) {
        o.video = 1;
        if (typeof i.dur === 'number' && i.dur > 0 && i.dur < 3600) o.dur = i.dur;
      }
      return o;
    });
    const rev = items.length ? crypto.createHash('sha1').update(JSON.stringify(items)).digest('hex').slice(0, 12) : '';
    cache = { mtime: m, view: { rev: rev, count: items.length, items: items } };
    return cache.view;
  }

  function lookup(which, folder, id, byName) {
    const m = mtimeOf(folder);
    if (m !== which.mtime) {
      which.mtime = m;
      which.byId = byName ? namesById(folder) : thumbNames(folder);
    }
    return which.byId[id] || null;
  }

  // Thumbs are named "<id>.<ext>" already.
  function thumbNames(folder) {
    const out = {};
    let list = [];
    try { list = fs.readdirSync(folder); } catch (e) { return out; }
    list.forEach((n) => {
      const id = n.slice(0, 12);
      if (isId(id) && n[12] === '.' && typeOf(n)) out[id] = n;
    });
    return out;
  }

  function fileInfo(folder, name) {
    if (!name) return null;
    const file = path.join(folder, name);
    try {
      const st = fs.statSync(file);
      return st.isFile() ? { file: file, type: typeOf(name), size: st.size } : null;
    } catch (e) { return null; }
  }

  // Only ids in the index are served (a file pulled but not yet indexed waits).
  function known(id) {
    if (!isId(id)) return null;
    const items = view().items;
    for (let i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  // A video's still frame stands in for its original.
  function original(item) {
    if (item.video) return fileInfo(path.join(dir, 'still'), item.id + '.jpg');
    return fileInfo(origDir, lookup(names, origDir, item.id, true));
  }

  return {
    kind: 'local',
    list: async () => view(),
    readOriginal: async (id) => {
      const it = known(id);
      return it ? original(it) : null;
    },
    readThumb: async (id) => {
      const it = known(id);
      if (!it) return null;
      return fileInfo(thumbDir, lookup(thumbs, thumbDir, id, false)) || original(it);
    },
    readClip: async (id) => {
      const it = known(id);
      if (!it || !it.video) return null;
      const f = fileInfo(path.join(dir, 'clip'), id + '.mp4');
      if (f) f.type = 'video/mp4';
      return f;
    },
    stat: async () => {
      const s = readJson(path.join(dir, 'state.json')) || {};
      return {
        count: view().count,
        lastRun: typeof s.lastRun === 'string' ? s.lastRun : null,
        ok: typeof s.ok === 'boolean' ? s.ok : null,
        newCount: Number.isInteger(s.newCount) ? s.newCount : 0
      };
    }
  };
}

module.exports = {
  MAX_LIST: MAX_LIST,
  idFor: idFor,
  isId: isId,
  typeOf: typeOf,
  isVideo: isVideo,
  imageSize: imageSize,
  mp4Duration: mp4Duration,
  buildIndex: buildIndex,
  writeState: writeState,
  createLocalStore: createLocalStore
};

/* ---------- CLI: node photos.js index [dataDir] [--new N] [--ok 0|1] ---------- */

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] !== 'index') {
    process.stderr.write('Use: node photos.js index [dataDir] [--new N] [--ok 0|1]\n');
    process.exit(2);
  }
  let dataDir = path.join(__dirname, 'data');
  let newCount = 0;
  let ok = true;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--new') newCount = parseInt(args[++i], 10) || 0;
    else if (args[i] === '--ok') ok = args[++i] !== '0';
    else dataDir = path.resolve(args[i]);
  }
  const dir = path.join(dataDir, 'photos');
  try {
    const r = buildIndex(dir);
    writeState(dir, { lastRun: new Date().toISOString(), ok: ok, count: r.count, newCount: newCount });
    process.stdout.write('photos: ' + r.count + ' in the album, ' + newCount + ' new' + (r.skipped ? ', ' + r.skipped + ' unreadable' : '') +
      (r.waiting ? ', ' + r.waiting + ' video' + (r.waiting === 1 ? '' : 's') + ' not converted yet' : '') + '\n');
  } catch (e) {
    process.stderr.write('photos: index failed (' + (e.code || 'error') + ')\n');
    process.exit(1);
  }
}
