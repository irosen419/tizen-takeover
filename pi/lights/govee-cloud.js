/*
 * Govee's cloud API, only for snapshots: a "Snapshot" saved in the Govee Home
 * app (an animated app scene, colors and all) can be fired from a preset.
 * Snapshots cannot be made from here; you save them in the app and the Pi
 * finds them by name.
 *
 *   GET  /router/api/v1/user/devices     each device's capabilities; snapshots
 *        are the options of type devices.capabilities.dynamic_scene, instance
 *        "snapshot" ({ name, value })
 *   POST /router/api/v1/device/control   { sku, device, capability: { type,
 *        instance: "snapshot", value } }
 *
 * The device ids and option values come from that list at run time, never
 * from the repo. Lights are matched by model (govee.LIGHTS sku). The key is
 * GOVEE_API_KEY in pi/.env. Govee allows about 10 control calls a minute per
 * device, so calls to one light are kept at least MIN_GAP_MS apart (a newer
 * request replaces one still waiting) and the list is read at most every
 * LIST_EVERY_MS.
 *
 * Logs never carry the key, a device id or a snapshot name.
 * Node 14 or newer, no npm packages.
 */
'use strict';

const https = require('https');
const crypto = require('crypto');
const govee = require('./govee');

const HOST = 'openapi.api.govee.com';
const MIN_GAP_MS = 6500;
const LIST_EVERY_MS = 10 * 60 * 1000;
const NAME_MAX = 60;

function defaultHttp(method, path, body, key) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      host: HOST, path: path, method: method, timeout: 8000,
      headers: Object.assign({ 'Govee-API-Key': key, Accept: 'application/json' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {})
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size < 512 * 1024) chunks.push(c); });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { j = null; }
        if (res.statusCode === 429) { reject(new Error('Govee says slow down')); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('Govee answered ' + res.statusCode)); return; }
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Govee did not answer')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}

// From the devices list: per light key, { device, sku, snapshots: [{ name, value }] }.
function readDevices(reply) {
  const list = reply && Array.isArray(reply.data) ? reply.data : [];
  const out = {};
  Object.keys(govee.LIGHTS).forEach((k) => {
    const d = list.find((x) => x && x.sku === govee.LIGHTS[k].sku && typeof x.device === 'string');
    if (!d) return;
    const caps = Array.isArray(d.capabilities) ? d.capabilities : [];
    const snap = caps.find((c) => c && c.type === 'devices.capabilities.dynamic_scene' && c.instance === 'snapshot');
    const opts = snap && snap.parameters && Array.isArray(snap.parameters.options) ? snap.parameters.options : [];
    out[k] = {
      device: d.device,
      sku: d.sku,
      snapshots: opts.filter((o) => o && typeof o.name === 'string' && o.value !== undefined)
        .map((o) => ({ name: o.name.slice(0, NAME_MAX), value: o.value }))
    };
  });
  return out;
}

const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function createCloud(opt) {
  const o = opt || {};
  const key = String(o.key || '').trim();
  const request = o.http || ((m, p, b) => defaultHttp(m, p, b, key));
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const wait = o.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let devices = null;
  let listedAt = -Infinity;
  let listing = null;
  const lastCall = {};
  const queued = {};

  async function list(force) {
    if (!key) return {};
    if (!force && devices && now() - listedAt < LIST_EVERY_MS) return devices;
    if (listing) return listing;
    listing = request('GET', '/router/api/v1/user/devices').then((r) => {
      devices = readDevices(r);
      listedAt = now();
      return devices;
    }).catch((e) => {
      log('music lights: cannot read the Govee snapshots (' + e.message + ')');
      listedAt = now() - LIST_EVERY_MS + 60000;   // try again in a minute
      return devices || {};
    }).then((d) => { listing = null; return d; });
    return listing;
  }

  // Snapshot names per light, for ./hub lights snapshots.
  async function snapshotNames(force) {
    const d = await list(force);
    const out = {};
    Object.keys(d).forEach((k) => { out[k] = d[k].snapshots.map((s) => s.name); });
    return out;
  }

  // Fire a snapshot on one light (by name). Resolves true, or false with a
  // log line (no name). A newer call for the same light replaces a waiting one.
  async function fire(k, name) {
    if (!key) { log('music lights: a preset uses a Govee snapshot but GOVEE_API_KEY is not set'); return false; }
    const ticket = {};
    queued[k] = ticket;
    let d = await list(false);
    let s = d[k] && d[k].snapshots.find((x) => same(x.name, name));
    if (!s) { d = await list(true); s = d[k] && d[k].snapshots.find((x) => same(x.name, name)); }
    if (!s) { log('music lights: the ' + govee.LIGHTS[k].name.toLowerCase() + ' has no Govee snapshot by that name (./hub lights snapshots)'); return false; }
    const gap = (lastCall[k] || -Infinity) + MIN_GAP_MS - now();
    if (gap > 0) await wait(gap);
    if (queued[k] !== ticket) return false;            // replaced by a newer one
    lastCall[k] = now();
    try {
      await request('POST', '/router/api/v1/device/control', {
        requestId: crypto.randomBytes(8).toString('hex'),
        payload: { sku: d[k].sku, device: d[k].device, capability: { type: 'devices.capabilities.dynamic_scene', instance: 'snapshot', value: s.value } }
      });
      return true;
    } catch (e) {
      log('music lights: Govee did not take the snapshot for the ' + govee.LIGHTS[k].name.toLowerCase() + ' (' + e.message + ')');
      return false;
    }
  }

  return { configured: !!key, list: list, snapshotNames: snapshotNames, fire: fire };
}

module.exports = { HOST: HOST, MIN_GAP_MS: MIN_GAP_MS, LIST_EVERY_MS: LIST_EVERY_MS, NAME_MAX: NAME_MAX, readDevices: readDevices, createCloud: createCloud };
