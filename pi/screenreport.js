/*
 * What each screen shows right now, as the screen itself reports it
 * (POST /screen/report from hub.js, every change and once a minute). Home
 * Assistant's Home Hub dashboard reads it with GET /api/screen (token):
 * the layout, what is open, and which animations can play there now.
 *
 * Kept in memory only (a restart forgets it until the next report). A screen
 * not heard from for STALE_MS counts as off. Nothing here is logged: the
 * report holds only ids and names from config.js, never personal data.
 *
 * Node 14 or newer, no npm packages. Tests: node pi/screenreport-test.js
 */
'use strict';

const KINDS = ['tv', 'tablet', 'browser'];
const PLACES = ['home', 'panel', 'nowplaying', 'visualizer', 'switcher', 'away'];
const SETS = ['wanderers', 'stage', 'corner', 'none'];
const MODES = ['panel', 'full'];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SCENE_RE = /^[a-z0-9-]{1,30}$/;
const STALE_MS = 150 * 1000;  // the screen reports every 60 s
const MAX_LIST = 40;
const MAX_NAME = 40;

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function cleanName(v) {
  if (typeof v !== 'string') return '';
  return Array.from(v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, MAX_NAME).join('');
}

function idOrNull(v, what) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !ID_RE.test(v)) throw bad('"' + what + '" must be an id');
  return v;
}

function oneOf(v, list, what, dflt) {
  if (v === undefined || v === null) return dflt;
  if (list.indexOf(v) < 0) throw bad('"' + what + '" must be one of ' + list.join(', '));
  return v;
}

function idList(v, re, what) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_LIST) throw bad('"' + what + '" must be a list of up to ' + MAX_LIST);
  const out = [];
  v.forEach((x) => {
    if (typeof x !== 'string' || !re.test(x)) throw bad('"' + what + '" holds a bad id');
    if (out.indexOf(x) < 0) out.push(x);
  });
  return out;
}

// The screen's report, checked. Throws a 400 error for anything off.
function normalize(body) {
  if (!isObj(body)) throw bad('the report must be a JSON object');
  const r = {
    kind: oneOf(body.kind, KINDS, 'kind', 'browser'),
    hub: cleanName(body.hub).slice(0, 20),
    place: oneOf(body.place, PLACES, 'place', 'home'),
    layout: null,
    layouts: [],
    widgets: idList(body.widgets, ID_RE, 'widgets'),
    open: idOrNull(body.open, 'open'),
    mode: oneOf(body.mode, MODES, 'mode', null),
    viz: body.viz === true,
    playing: body.playing === true,
    animations: 'none',
    scenes: [],
    last: null
  };
  if (body.layout !== undefined && body.layout !== null) {
    if (!isObj(body.layout)) throw bad('"layout" must be { id, name }');
    r.layout = { id: idOrNull(body.layout.id, 'layout.id') || '', name: cleanName(body.layout.name) };
  }
  if (body.layouts !== undefined && body.layouts !== null) {
    if (!Array.isArray(body.layouts) || body.layouts.length > MAX_LIST) throw bad('"layouts" must be a list of up to ' + MAX_LIST);
    body.layouts.forEach((l) => {
      if (!isObj(l)) throw bad('"layouts" holds a bad layout');
      const id = idOrNull(l.id, 'layouts.id');
      if (id) r.layouts.push({ id: id, name: cleanName(l.name) || id });
    });
  }
  if (body.animations !== undefined && body.animations !== null) {
    if (!isObj(body.animations)) throw bad('"animations" must be { set, scenes }');
    r.animations = oneOf(body.animations.set, SETS, 'animations.set', 'none');
    r.scenes = idList(body.animations.scenes, SCENE_RE, 'animations.scenes');
  }
  if (body.last !== undefined && body.last !== null) {
    const l = body.last;
    if (!isObj(l)) throw bad('"last" must be { scene, ok, why }');
    if (typeof l.scene !== 'string' || !SCENE_RE.test(l.scene)) throw bad('"last.scene" must be a scene id');
    r.last = { scene: l.scene, ok: l.ok === true, why: cleanName(l.why) };
    if (typeof l.ago === 'number' && isFinite(l.ago) && l.ago >= 0) r.last.ago = Math.round(l.ago);
  }
  return r;
}

// One store per server: the last report of each kind of screen.
function createStore(opt) {
  const o = opt || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const staleMs = typeof o.staleMs === 'number' ? o.staleMs : STALE_MS;
  const reports = {};

  function put(body) {
    const r = normalize(body);
    const first = !reports[r.kind] || now() - reports[r.kind].at > staleMs;
    reports[r.kind] = { at: now(), r: r };
    return { kind: r.kind, first: first };
  }

  // A flat answer for Home Assistant (each field one sensor away).
  function get(kind) {
    const k = KINDS.indexOf(kind) >= 0 ? kind : 'tv';
    const e = reports[k];
    const seen = e ? Math.round((now() - e.at) / 1000) : null;
    const on = !!e && now() - e.at <= staleMs && e.r.place !== 'away';
    const r = e ? e.r : null;
    return {
      ok: true,
      kind: k,
      on: on,
      seenSecondsAgo: seen,
      place: on ? r.place : 'off',
      layout: r && r.layout ? r.layout.id : '',
      layoutName: r && r.layout ? r.layout.name : '',
      layouts: r ? r.layouts : [],
      widgets: on ? r.widgets : [],
      open: on ? r.open : null,
      mode: on ? r.mode : null,
      viz: on && r.viz,
      playing: on && r.playing,
      animations: on ? r.animations : 'none',
      scenes: on ? r.scenes : [],
      last: r ? r.last : null,
      hub: r ? r.hub : ''
    };
  }

  return { put: put, get: get };
}

const PLACE_WORDS = {
  home: 'home screen', panel: 'a panel open', nowplaying: 'Now Playing', visualizer: 'the visualizer',
  switcher: 'the layout bar', away: 'another app'
};

// One line for ./hub screen and the mailbox's "screen".
function text(s) {
  if (!s.on) {
    if (s.seenSecondsAgo === null) return 'The ' + s.kind + ' has not reported yet (is Home Hub open on it, version with screen reports?).';
    return 'The ' + s.kind + ' hub is not showing (last heard ' + ago(s.seenSecondsAgo) + ' ago).';
  }
  let line = (s.layoutName || s.layout || 'Unknown layout') + ', ' + PLACE_WORDS[s.place];
  if (s.open && s.place === 'panel') line += ' (' + s.open + (s.mode === 'full' ? ', full screen' : '') + ')';
  if (s.playing) line += ', music playing';
  line += '. Animations: ' + (s.scenes.length ? s.scenes.join(', ') : 'none here') + '.';
  if (s.last) line += ' Last asked: ' + s.last.scene + ' ' + (s.last.ok ? 'played' : 'refused' + (s.last.why ? ' (' + s.last.why + ')' : '')) + '.';
  return line + ' Heard ' + ago(s.seenSecondsAgo) + ' ago.';
}

function ago(sec) {
  if (sec < 90) return sec + ' s';
  if (sec < 5400) return Math.round(sec / 60) + ' min';
  return Math.round(sec / 3600) + ' h';
}

module.exports = { KINDS, PLACES, SETS, SCENE_RE, ID_RE, STALE_MS, normalize, createStore, text };
