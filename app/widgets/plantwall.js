/*
 * Plant wall (plantwall): the front elevation of the plant wall lights, the
 * three paintings with the four vases, the wires, every LED and its labels,
 * copied from Ian's "Plant Wall Lighting" page (the part its Full screen
 * button shows: no couch, table or legend). A still drawing: nothing here
 * talks to WLED.
 *
 * LED numbers follow the live WLED setup (2026-11-27): the left (guitar)
 * string is LEDs 0-49 on output 1, the drum strip 50-113 and the right (mic)
 * string 114-163 on output 2. The page's own labels still carry the older
 * order; LABELS below holds the new one.
 *
 * The drawing is one SVG, 8 px to the inch, viewBox VB. It fills the tile
 * (centred, never stretched); OK opens it full screen and Back closes it.
 * Words come from i18n (key 'plantwall.<key>'); a label that would run past
 * its room (data-w, in drawing px) is shrunk to fit after each draw, so the
 * longer Spanish never spills out of the label boxes.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var VB = '-24 26 888 304';   // x from -24 so the left-hand sizes fit in Spanish too

  var EN = {
    title: 'Plant wall lights',
    aria: 'Front elevation of the plant wall lights: three paintings, four vases and 164 LEDs',
    p1: 'Painting 1, guitar',
    p2: 'Painting 2, drums',
    p3: 'Painting 3, mic',
    ctrl: 'WLED controller',
    w20: '20 in',
    h28: '28 in',
    up: '52.25 in',
    floor: 'off floor',
    aisle: '14.25 in aisle',
    drop: '12 in',
    v1: 'Vase 1', v2: 'Vase 2', v3: 'Vase 3', v4: 'Vase 4',
    guitar: 'Guitar tail',
    tail: '21 LEDs, 4 in apart',
    leds: 'LEDs {a} to {b}',
    drum: 'Drum strip',
    drumSub: '64 LEDs, 1.3 in apart',
    mic: 'Mic tail',
    out: 'OUT {n}'
  };
  var S = EN;

  function I18N() {
    var L = window.HUB_I18N;
    return L && typeof L.t === 'function' ? L : null;
  }
  function localize() {
    var L = I18N();
    try { S = L && typeof L.localize === 'function' ? L.localize(EN, 'plantwall') : EN; } catch (e) { S = EN; }
    if (widget) widget.title = S.title;   // the hub reads it for the panel head
  }
  var widget = null;
  localize();

  function fill(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, function (all, n) {
      return vars && vars.hasOwnProperty(n) ? String(vars[n]) : all;
    });
  }

  /* ---------- the drawing ---------- */

  // Generated from the page's SVG (rounded to 0.1 px). Paintings, controller,
  // size lines, vases, wires, leaves, the drum strip's run, corners and
  // D-rings, the raceway's top (cut at the drawing's foot).
  var SHAPES =
    '<rect x="80" y="62" width="160" height="224" class="art"/>' +
    '<rect x="88" y="70" width="144" height="208" class="artin"/>' +
    '<rect x="354" y="62" width="160" height="224" class="art"/>' +
    '<rect x="362" y="70" width="144" height="208" class="artin"/>' +
    '<rect x="628" y="62" width="160" height="224" class="art"/>' +
    '<rect x="636" y="70" width="144" height="208" class="artin"/>' +
    '<rect x="361" y="262" width="12.5" height="17" rx="2" class="ctrl"/>' +
    '<path d="M434,286 L434,276 L373.5,276" class="pwr hidp"/>' +
    '<line x1="80" y1="46" x2="240" y2="46" class="dim"/>' +
    '<line x1="80" y1="41" x2="80" y2="51" class="dim"/>' +
    '<line x1="240" y1="41" x2="240" y2="51" class="dim"/>' +
    '<line x1="66" y1="62" x2="66" y2="286" class="dim"/>' +
    '<line x1="61" y1="62" x2="71" y2="62" class="dim"/>' +
    '<line x1="61" y1="286" x2="71" y2="286" class="dim"/>' +
    '<line x1="240" y1="302" x2="354" y2="302" class="dim"/>' +
    '<line x1="240" y1="297" x2="240" y2="307" class="dim"/>' +
    '<line x1="354" y1="297" x2="354" y2="307" class="dim"/>' +
    '<line x1="514" y1="302" x2="628" y2="302" class="dim"/>' +
    '<line x1="514" y1="297" x2="514" y2="307" class="dim"/>' +
    '<line x1="628" y1="297" x2="628" y2="307" class="dim"/>' +
    '<ellipse cx="297" cy="126" rx="20.5" ry="18.8" class="glass"/>' +
    '<path d="M278.5,128 A18.5,16.8 0 0 0 315.5,128 Z" class="water"/>' +
    '<rect x="289" y="103.2" width="16" height="6" rx="2" class="neck"/>' +
    '<circle cx="283.5" cy="139.8" r="2.6" class="pebble"/>' +
    '<circle cx="286.9" cy="136.8" r="2.6" class="pebble"/>' +
    '<circle cx="290.3" cy="139.8" r="2.6" class="pebble"/>' +
    '<circle cx="293.6" cy="136.8" r="2.6" class="pebble"/>' +
    '<circle cx="297" cy="139.8" r="2.6" class="pebble"/>' +
    '<circle cx="300.4" cy="136.8" r="2.6" class="pebble"/>' +
    '<circle cx="303.7" cy="139.8" r="2.6" class="pebble"/>' +
    '<circle cx="307.1" cy="136.8" r="2.6" class="pebble"/>' +
    '<circle cx="310.5" cy="139.8" r="2.6" class="pebble"/>' +
    '<ellipse cx="297" cy="222" rx="20.5" ry="18.8" class="glass"/>' +
    '<path d="M278.5,224 A18.5,16.8 0 0 0 315.5,224 Z" class="water"/>' +
    '<rect x="289" y="199.2" width="16" height="6" rx="2" class="neck"/>' +
    '<circle cx="283.5" cy="235.8" r="2.6" class="pebble"/>' +
    '<circle cx="286.9" cy="232.8" r="2.6" class="pebble"/>' +
    '<circle cx="290.3" cy="235.8" r="2.6" class="pebble"/>' +
    '<circle cx="293.6" cy="232.8" r="2.6" class="pebble"/>' +
    '<circle cx="297" cy="235.8" r="2.6" class="pebble"/>' +
    '<circle cx="300.4" cy="232.8" r="2.6" class="pebble"/>' +
    '<circle cx="303.7" cy="235.8" r="2.6" class="pebble"/>' +
    '<circle cx="307.1" cy="232.8" r="2.6" class="pebble"/>' +
    '<circle cx="310.5" cy="235.8" r="2.6" class="pebble"/>' +
    '<path d="M367,262 L367,96" class="wire hiddenwire ch1"/>' +
    '<path d="M367,96 L300,96 L300,103.2 L300,128" class="wire ch1"/>' +
    '<path d="M294,128 L294,103.2 L294,98.2 L266.5,98.2 L266.5,194.2 L294,194.2 L294,224" class="wire ch1"/>' +
    '<ellipse cx="287" cy="99.2" rx="7" ry="3.6" transform="rotate(-35 287 99.2)" class="leaf"/>' +
    '<ellipse cx="311" cy="92.2" rx="7" ry="3.6" transform="rotate(35 311 92.2)" class="leaf"/>' +
    '<ellipse cx="279" cy="144.8" rx="7" ry="3.6" transform="rotate(-35 279 144.8)" class="leaf"/>' +
    '<ellipse cx="307" cy="153.8" rx="7" ry="3.6" transform="rotate(35 307 153.8)" class="leaf"/>' +
    '<ellipse cx="283" cy="162.8" rx="7" ry="3.6" transform="rotate(-35 283 162.8)" class="leaf"/>' +
    '<ellipse cx="287" cy="195.2" rx="7" ry="3.6" transform="rotate(-35 287 195.2)" class="leaf"/>' +
    '<ellipse cx="311" cy="188.2" rx="7" ry="3.6" transform="rotate(35 311 188.2)" class="leaf"/>' +
    '<ellipse cx="279" cy="240.8" rx="7" ry="3.6" transform="rotate(-35 279 240.8)" class="leaf"/>' +
    '<ellipse cx="307" cy="249.8" rx="7" ry="3.6" transform="rotate(35 307 249.8)" class="leaf"/>' +
    '<ellipse cx="283" cy="258.8" rx="7" ry="3.6" transform="rotate(-35 283 258.8)" class="leaf"/>' +
    '<ellipse cx="315" cy="267.8" rx="7" ry="3.6" transform="rotate(35 315 267.8)" class="leaf"/>' +
    '<ellipse cx="287" cy="276.8" rx="7" ry="3.6" transform="rotate(-35 287 276.8)" class="leaf"/>' +
    '<ellipse cx="571" cy="126" rx="20.5" ry="18.8" class="glass"/>' +
    '<path d="M552.5,128 A18.5,16.8 0 0 0 589.5,128 Z" class="water"/>' +
    '<rect x="563" y="103.2" width="16" height="6" rx="2" class="neck"/>' +
    '<circle cx="557.5" cy="139.8" r="2.6" class="pebble"/>' +
    '<circle cx="560.9" cy="136.8" r="2.6" class="pebble"/>' +
    '<circle cx="564.3" cy="139.8" r="2.6" class="pebble"/>' +
    '<circle cx="567.6" cy="136.8" r="2.6" class="pebble"/>' +
    '<circle cx="571" cy="139.8" r="2.6" class="pebble"/>' +
    '<circle cx="574.4" cy="136.8" r="2.6" class="pebble"/>' +
    '<circle cx="577.7" cy="139.8" r="2.6" class="pebble"/>' +
    '<circle cx="581.1" cy="136.8" r="2.6" class="pebble"/>' +
    '<circle cx="584.5" cy="139.8" r="2.6" class="pebble"/>' +
    '<ellipse cx="571" cy="222" rx="20.5" ry="18.8" class="glass"/>' +
    '<path d="M552.5,224 A18.5,16.8 0 0 0 589.5,224 Z" class="water"/>' +
    '<rect x="563" y="199.2" width="16" height="6" rx="2" class="neck"/>' +
    '<circle cx="557.5" cy="235.8" r="2.6" class="pebble"/>' +
    '<circle cx="560.9" cy="232.8" r="2.6" class="pebble"/>' +
    '<circle cx="564.3" cy="235.8" r="2.6" class="pebble"/>' +
    '<circle cx="567.6" cy="232.8" r="2.6" class="pebble"/>' +
    '<circle cx="571" cy="235.8" r="2.6" class="pebble"/>' +
    '<circle cx="574.4" cy="232.8" r="2.6" class="pebble"/>' +
    '<circle cx="577.7" cy="235.8" r="2.6" class="pebble"/>' +
    '<circle cx="581.1" cy="232.8" r="2.6" class="pebble"/>' +
    '<circle cx="584.5" cy="235.8" r="2.6" class="pebble"/>' +
    '<path d="M574,128 L574,103.2 L574,98.2 L601.5,98.2 L601.5,194.2 L574,194.2 L574,224" class="wire ch2"/>' +
    '<ellipse cx="581" cy="99.2" rx="7" ry="3.6" transform="rotate(-35 581 99.2)" class="leaf"/>' +
    '<ellipse cx="557" cy="92.2" rx="7" ry="3.6" transform="rotate(35 557 92.2)" class="leaf"/>' +
    '<ellipse cx="589" cy="144.8" rx="7" ry="3.6" transform="rotate(-35 589 144.8)" class="leaf"/>' +
    '<ellipse cx="561" cy="153.8" rx="7" ry="3.6" transform="rotate(35 561 153.8)" class="leaf"/>' +
    '<ellipse cx="585" cy="162.8" rx="7" ry="3.6" transform="rotate(-35 585 162.8)" class="leaf"/>' +
    '<ellipse cx="581" cy="195.2" rx="7" ry="3.6" transform="rotate(-35 581 195.2)" class="leaf"/>' +
    '<ellipse cx="557" cy="188.2" rx="7" ry="3.6" transform="rotate(35 557 188.2)" class="leaf"/>' +
    '<ellipse cx="589" cy="240.8" rx="7" ry="3.6" transform="rotate(-35 589 240.8)" class="leaf"/>' +
    '<ellipse cx="561" cy="249.8" rx="7" ry="3.6" transform="rotate(35 561 249.8)" class="leaf"/>' +
    '<ellipse cx="585" cy="258.8" rx="7" ry="3.6" transform="rotate(-35 585 258.8)" class="leaf"/>' +
    '<ellipse cx="553" cy="267.8" rx="7" ry="3.6" transform="rotate(35 553 267.8)" class="leaf"/>' +
    '<ellipse cx="581" cy="276.8" rx="7" ry="3.6" transform="rotate(-35 581 276.8)" class="leaf"/>' +
    '<rect x="356" y="64" width="156" height="220" rx="2" class="striprun"/>' +
    '<path d="M505.7,64 L512,64 L512,70.3" class="lconn"/>' +
    '<path d="M360.7,64 Q356,64 356,68.3" class="bridge"/>' +
    '<path d="M505.7,284 L512,284 L512,277.7" class="lconn"/>' +
    '<path d="M356,120.8 L356,124 L360.5,127.5 L360.5,144.6 L356,144.6" class="bridge"/>' +
    '<rect x="354.6" y="130.5" width="4.8" height="12.5" rx="2" class="dring"/>' +
    '<path d="M512,120.8 L512,124 L506.5,127.5 L506.5,144.6 L512,144.6" class="bridge"/>' +
    '<rect x="508.6" y="130.5" width="4.8" height="12.5" rx="2" class="dring"/>' +
    '<path d="M294,224 L294,216 L234,216" class="wire hiddenwire ch1"/>' +
    '<path d="M234,216 L234,216 L234,184.5 L234,153 L234,121.5 L234,90 L224.5,68 L193,68 L161.5,68 L130,68 L98.5,68 L86,87 L86,118.5 L86,150 L86,181.4 L86,212.9 L86,244.4 L86,275.9 L113.4,280 L144.9,280 L176.4,280 L207.9,280" class="wire hiddenwire ch1"/>' +
    '<path d="M574,224 L574,216 L634,216" class="wire hiddenwire ch2"/>' +
    '<path d="M634,216 L634,216 L634,184.5 L634,153 L634,121.5 L634,90 L643.5,68 L675,68 L706.5,68 L738,68 L769.5,68 L782,87 L782,118.5 L782,150 L782,181.4 L782,212.9 L782,244.4 L782,275.9 L754.6,280 L723.1,280 L691.6,280 L660.1,280" class="wire hiddenwire ch2"/>' +
    '<path d="M364,279 L364,281 L360.7,281 L360.7,284" class="feed f2 thin"/>' +
    '<path d="M356,279.7 L358,282 L380,282 L382,279.5 L502,279.5 L502,183.2" class="feed f2 thin"/>' +
    '<path d="M502,183.2 L502,128 A14,14 0 1 0 498,137.8 L498,96 L568,96 L568,112" class="wire hiddenwire ch2"/>' +
    '<line x1="720" y1="126" x2="720" y2="222" class="dim"/>' +
    '<line x1="715" y1="126" x2="725" y2="126" class="dim"/>' +
    '<line x1="715" y1="222" x2="725" y2="222" class="dim"/>' +
    '<rect x="429" y="286" width="10" height="44" rx="3" class="raceway"/>' +
    '<line x1="434" y1="330" x2="434" y2="286" class="pwr"/>';

  // Lit fairy-string LEDs: x,y,glow radius
  var LIT =
    '285,133.1,7 288,135.1,7 292.2,136.3,7 297,136.8,7 301.8,136.3,7 306,135.1,7 309,133.1,7 285,229.1,7 ' +
    '288,231.1,7 292.2,232.3,7 297,232.8,7 301.8,232.3,7 306,231.1,7 309,229.1,7 281.5,98.2,7 ' +
    '266.5,127.9,7 266.5,172.5,7 289.5,194.2,7 559,133.1,7 562,135.1,7 566.2,136.3,7 571,136.8,7 ' +
    '575.8,136.3,7 580,135.1,7 583,133.1,7 559,229.1,7 562,231.1,7 566.2,232.3,7 571,232.8,7 ' +
    '575.8,232.3,7 580,231.1,7 583,229.1,7 586.5,98.2,7 601.5,127.9,7 601.5,172.5,7 578.5,194.2,7 ' +
    '234,216,6 234,184.5,6 234,153,6 234,121.5,6 234,90,6 224.5,68,6 193,68,6 161.5,68,6 130,68,6 ' +
    '98.5,68,6 86,87,6 86,118.5,6 86,150,6 86,181.4,6 86,212.9,6 86,244.4,6 86,275.9,6 113.4,280,6 ' +
    '144.9,280,6 176.4,280,6 207.9,280,6 634,216,6 634,184.5,6 634,153,6 634,121.5,6 634,90,6 643.5,68,6 ' +
    '675,68,6 706.5,68,6 738,68,6 769.5,68,6 782,87,6 782,118.5,6 782,150,6 782,181.4,6 782,212.9,6 ' +
    '782,244.4,6 782,275.9,6 754.6,280,6 723.1,280,6 691.6,280,6 660.1,280,6 ';

  // Dark LEDs (wire runs): x,y
  var DARK =
    '367,256 367,229 367,199 367,169 367,139 367,109 349,96 319,96 300,107 274,216 254,216 594,216 ' +
    '614,216 502,172 502,146 496.1,116.6 474.2,125.6 491.7,141.5 498,117 505.1,96 533.3,96 561.5,96 ';

  // The 64 drum strip LEDs: x,y
  var STRIP =
    '366,284 376.5,284 387,284 397.5,284 408,284 418.5,284 429,284 439.5,284 450,284 460.5,284 471,284 ' +
    '481.5,284 492,284 502.5,284 512,274.5 512,264 512,253.5 512,243 512,232.5 512,222 512,211.5 512,201 ' +
    '512,190.5 512,180 512,169.5 512,159 512,148.5 512,115.5 512,105 512,94.5 512,84 512,73.5 502.5,64 ' +
    '492,64 481.5,64 471,64 460.5,64 450,64 439.5,64 429,64 418.5,64 408,64 397.5,64 387,64 376.5,64 ' +
    '366,64 356,73.5 356,84 356,94.5 356,105 356,115.5 356,148.5 356,159 356,169.5 356,180 356,190.5 ' +
    '356,201 356,211.5 356,222 356,232.5 356,243 356,253.5 356,264 356,274.5 ';

  // Numbered markers from the page: x, y, number
  var MARKS = [[380,112,1],[244.5,174,2],[327,262,3],[478,243,4]];

  /* The labels: [key, x, y, class, anchor, room (data-w, px; 0 = no limit), vars].
     Room is the label box's width less a little padding, or the gap the
     label sits in. */
  var LABELS = [
    ['p1', 160, 92, 'artlbl', 'middle', 140],
    ['p2', 434, 92, 'artlbl', 'middle', 140],
    ['p3', 708, 92, 'artlbl', 'middle', 140],
    ['ctrl', 377, 259, 'hid', 'start', 90],  // 9 px higher than on the page, clear of OUT 2,
    ['w20', 160, 40, 'dimt', 'middle', 150],
    ['h28', 60, 174, 'dimt', 'end', 80],
    ['up', 60, 290, 'dimt', 'end', 80],
    ['floor', 60, 304, 'mut', 'end', 80],
    ['aisle', 297, 318, 'dimt', 'middle', 200],
    ['aisle', 571, 318, 'dimt', 'middle', 200],
    ['v1', 232, 130, 'vname', 'end', 0],
    ['v2', 232, 226, 'vname', 'end', 0],
    ['v3', 636, 130, 'vname', 'start', 0],
    ['v4', 636, 226, 'vname', 'start', 0],
    ['guitar', 160, 240, 'cnt', 'middle', 132],
    ['tail', 160, 254, 'dimt sm', 'middle', 132],
    ['leds', 160, 267, 'mut sm2', 'middle', 132, { a: 29, b: 49 }],
    ['drum', 434, 181, 'cnt', 'middle', 132],
    ['drumSub', 434, 195, 'dimt sm', 'middle', 132],
    ['leds', 434, 208, 'mut sm2', 'middle', 132, { a: 50, b: 113 }],
    ['mic', 708, 240, 'cnt', 'middle', 132],
    ['tail', 708, 254, 'dimt sm', 'middle', 132],
    ['leds', 708, 267, 'mut sm2', 'middle', 132, { a: 143, b: 163 }],
    // The left string is output 1 now, the drum strip and right string output 2.
    ['out', 372, 230, 'tag1', 'start', 0, { n: 1 }],
    ['out', 498, 271, 'tag2', 'end', 0, { n: 2 }],
    ['drop', 724, 178, 'dimt', 'start', 52]
  ];
  // Label boxes; the drum one is 20 px wider than on the page, for Spanish.
  var BOXES = [[90, 227, 140, 46], [364, 168, 140, 46], [638, 227, 140, 46]];

  function pairs(list, n) {
    var out = [], bits = list.replace(/^\s+|\s+$/g, '').split(/\s+/);
    for (var i = 0; i < bits.length; i++) {
      var p = bits[i].split(',');
      out.push(p.slice(0, n));
    }
    return out;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function markup() {
    var h = [], i, p;
    h.push('<svg xmlns="' + SVGNS + '" class="pw-svg" viewBox="' + VB + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + esc(S.aria) + '">');
    h.push('<defs><radialGradient id="pw-glow"><stop offset="0" class="pw-g0"/><stop offset="1" class="pw-g1"/></radialGradient></defs>');
    h.push(SHAPES);
    var lit = pairs(LIT, 3);
    for (i = 0; i < lit.length; i++) {
      p = lit[i];
      h.push('<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + p[2] + '" fill="url(#pw-glow)"/><circle cx="' + p[0] + '" cy="' + p[1] + '" r="2.3" class="ledon"/>');
    }
    var dark = pairs(DARK, 2);
    for (i = 0; i < dark.length; i++) h.push('<circle cx="' + dark[i][0] + '" cy="' + dark[i][1] + '" r="2.6" class="leddark"/>');
    var strip = pairs(STRIP, 2);
    for (i = 0; i < strip.length; i++) h.push('<circle cx="' + strip[i][0] + '" cy="' + strip[i][1] + '" r="1.9" class="ledstrip"/>');
    for (i = 0; i < BOXES.length; i++) {
      p = BOXES[i];
      h.push('<rect x="' + p[0] + '" y="' + p[1] + '" width="' + p[2] + '" height="' + p[3] + '" rx="5" class="lblbg"/>');
    }
    for (i = 0; i < LABELS.length; i++) {
      p = LABELS[i];
      h.push('<text x="' + p[1] + '" y="' + p[2] + '" class="lbl ' + p[3] + '" text-anchor="' + p[4] + '"' +
        (p[5] ? ' data-w="' + p[5] + '"' : '') + '>' + esc(fill(S[p[0]], p[6])) + '</text>');
    }
    for (i = 0; i < MARKS.length; i++) {
      p = MARKS[i];
      h.push('<g class="mk"><circle cx="' + p[0] + '" cy="' + p[1] + '" r="10"/><text x="' + p[0] + '" y="' + (p[1] + 4) + '" text-anchor="middle">' + p[2] + '</text></g>');
    }
    h.push('</svg>');
    return h.join('');
  }

  // Shrink any label that runs past its room. Lengths are in drawing units,
  // so this holds at any tile size; it needs the drawing on the page.
  function fit(root) {
    var list = root.querySelectorAll ? root.querySelectorAll('text[data-w]') : [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i], room = Number(t.getAttribute('data-w')), len = 0;
      try { len = t.getComputedTextLength(); } catch (e) { len = 0; }
      if (!len || len <= room) continue;
      var size = parseFloat(window.getComputedStyle(t).fontSize) || 12;
      t.style.fontSize = (Math.floor(size * room / len * 10) / 10) + 'px';
    }
  }

  function draw(el, cls) {
    el.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'pw-box ' + cls;
    box.innerHTML = markup();
    el.appendChild(box);
    fit(box);
    // A tile drawn before it is on screen measures nothing: try once more.
    setTimeout(function () { fit(box); }, 0);
  }

  widget = {
    id: 'plantwall',
    title: S.title,
    icon: 'bulb',
    head: false,
    openMode: 'full',

    init: function (ctx) {
      var L = I18N();
      if (L && typeof L.onChange === 'function') {
        L.onChange(function () {
          localize();
          ctx.redrawTile();
          if (ctx.isOpen()) ctx.redrawPanel();
        });
      }
    },

    renderTile: function (el) {
      draw(el, 'is-tile');
    },

    renderPanel: function (el) {
      draw(el, 'is-full');
    }
  };
  return widget;
})());
