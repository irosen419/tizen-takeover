/*
 * Puts the Architecture page into the Layout Studio: node studio/build-architecture.js
 *
 * The page is written in studio/architecture/ (arch.css, arch.js, data.json). The
 * Studio is published as one file, so this copies those three into the marked
 * places in studio/layout-studio.html. Run it after editing any of them, then
 * `node dev/architecture-test.js`, then republish the Studio. Pass --check to
 * only report whether the Studio is up to date (exit 1 if not).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const html = path.join(dir, 'layout-studio.html');
const read = (f) => fs.readFileSync(path.join(dir, 'architecture', f), 'utf8');

function build() {
  let s = fs.readFileSync(html, 'utf8');
  const data = JSON.stringify(JSON.parse(read('data.json')));
  // "</" inside JSON in a script tag could end it early; "<!--" can start a comment.
  const safe = data.replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
  const parts = [
    ['/*ARCH-CSS-BEGIN*/', '/*ARCH-CSS-END*/', '\n' + read('arch.css') + '\n'],
    ['<!-- ARCH-MARKUP-BEGIN -->', '<!-- ARCH-MARKUP-END -->', '\n      <div id="archView" aria-label="Architecture"></div>\n      <script type="application/json" id="archData">' + safe + '</script>\n      '],
    ['<!-- ARCH-JS-BEGIN -->', '<!-- ARCH-JS-END -->', '\n<script>\n' + read('arch.js') + '</script>\n']
  ];
  parts.forEach(([a, b, body]) => {
    const i = s.indexOf(a), j = s.indexOf(b);
    if (i < 0 || j < i) throw new Error('marker missing: ' + a);
    s = s.slice(0, i + a.length) + body + s.slice(j);
  });
  return s;
}

const out = build();
if (process.argv.includes('--check')) {
  const same = out === fs.readFileSync(html, 'utf8');
  console.log(same ? 'Studio is up to date with studio/architecture/' : 'Studio is OUT OF DATE: run node studio/build-architecture.js');
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(html, out);
console.log('Studio updated (' + out.length + ' bytes)');
