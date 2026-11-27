/*
 * The shared Govee config: what the lights look like and how to talk to them
 * on the local network. Every look (music lights now; storm, Octane and the
 * static moods later) uses this one file, so the numbers live in one place.
 *
 * No addresses here, ever: the engine reads GOVEE_LAMP_IP and GOVEE_BARS_IP
 * from pi/.env. Home Assistant holds UDP 4002 (where Govee devices answer a
 * scan), so nothing here scans or binds a port: frames go out from an
 * unbound socket to each light's port 4003.
 *
 * Geometry (counted on the real lights, 2026-11-27):
 *   lamp  H6076 floor lamp: 7 sections, numbered bottom to top (segments 0-6,
 *         about 12 bulbs each; the cloud API says 15, only 7 are real).
 *   bars  H6056 Flow Plus: 12 sections, 0-5 the left bar and 6-11 the right
 *         bar, each top to bottom. One device, one address.
 *
 * A section color is a "ptReal" frame: 33 05 15 01 RR GG BB 00 00 00 00 00
 * mask_lo mask_hi, padded to 19 bytes, then one XOR byte, base64. One
 * message carries up to 6 frames. Ten updates a second per light is the safe
 * speed (tested; the cloud limit is far lower and not used).
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const PORT = 4003;
const MAX_FPS = 10;
const FRAMES_PER_MESSAGE = 6;

const LIGHTS = {
  lamp: { key: 'lamp', sku: 'H6076', name: 'Floor lamp', sections: 7, order: 'bottom to top', env: 'GOVEE_LAMP_IP', haEnv: ['LIGHTS_HA_LAMP', 'SOUNDLIGHTS_HA_LAMP'] },
  bars: { key: 'bars', sku: 'H6056', name: 'Light bars', sections: 12, order: '0-5 left, 6-11 right, top to bottom', env: 'GOVEE_BARS_IP', haEnv: ['LIGHTS_HA_BARS'] }
};

// How the bars' 12 sections sit in a line for a look that travels: up the
// left bar (5..0 is bottom to top), then down the right (6..11). The lamp is
// already a line, bottom to top.
const PATHS = {
  lamp: [0, 1, 2, 3, 4, 5, 6],
  bars: [5, 4, 3, 2, 1, 0, 6, 7, 8, 9, 10, 11]
};

// Shades that read right on these lights at about 40% brightness.
const SHADES = {
  emerald: [0, 120, 20],
  lime: [90, 255, 0],
  mint: [40, 255, 90],
  gold: [255, 150, 0],
  warmWhite: [255, 190, 110]
};

const byte = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));

// 19 bytes plus the XOR of them, as base64.
function packet(bytes) {
  const b = bytes.slice(0, 19);
  while (b.length < 19) b.push(0);
  let x = 0;
  for (let i = 0; i < 19; i++) { b[i] = byte(b[i]); x ^= b[i]; }
  b.push(x);
  return Buffer.from(b).toString('base64');
}

function mask(sections) {
  let m = 0;
  sections.forEach((i) => { if (i >= 0 && i < 16) m |= 1 << i; });
  return m;
}

// One ptReal frame: these sections in this color.
function segmentFrame(rgb, sections) {
  const m = mask(sections);
  return packet([0x33, 0x05, 0x15, 0x01, rgb[0], rgb[1], rgb[2], 0, 0, 0, 0, 0, m & 0xff, (m >> 8) & 0xff]);
}

function message(cmd, data) {
  return Buffer.from(JSON.stringify({ msg: { cmd: cmd, data: data } }));
}

const turn = (on) => message('turn', { value: on ? 1 : 0 });
const brightness = (pct) => message('brightness', { value: Math.max(1, Math.min(100, Math.round(pct))) });
const colorwc = (rgb) => message('colorwc', { color: { r: byte(rgb[0]), g: byte(rgb[1]), b: byte(rgb[2]) }, colorTemInKelvin: 0 });

// Colors for every section of one light (index = section number) as the
// fewest messages: same colors share a frame, up to 6 frames a message.
function sectionMessages(colors) {
  const groups = [];
  const seen = {};
  colors.forEach((c, i) => {
    const rgb = [byte(c[0]), byte(c[1]), byte(c[2])];
    const k = rgb.join(',');
    if (seen[k] === undefined) { seen[k] = groups.length; groups.push({ rgb: rgb, sections: [] }); }
    groups[seen[k]].sections.push(i);
  });
  const frames = groups.map((g) => segmentFrame(g.rgb, g.sections));
  const out = [];
  for (let i = 0; i < frames.length; i += FRAMES_PER_MESSAGE) {
    out.push(message('ptReal', { command: frames.slice(i, i + FRAMES_PER_MESSAGE) }));
  }
  return out;
}

// Read each light's address from the .env settings. Missing: left out.
function addressesFromEnv(env) {
  const out = {};
  Object.keys(LIGHTS).forEach((k) => {
    const ip = String((env && env[LIGHTS[k].env]) || '').trim();
    if (/^[0-9a-fA-F:.]{3,45}$/.test(ip)) out[k] = ip;
  });
  return out;
}

module.exports = {
  PORT: PORT,
  MAX_FPS: MAX_FPS,
  FRAMES_PER_MESSAGE: FRAMES_PER_MESSAGE,
  LIGHTS: LIGHTS,
  PATHS: PATHS,
  SHADES: SHADES,
  packet: packet,
  mask: mask,
  segmentFrame: segmentFrame,
  message: message,
  turn: turn,
  brightness: brightness,
  colorwc: colorwc,
  sectionMessages: sectionMessages,
  addressesFromEnv: addressesFromEnv
};
