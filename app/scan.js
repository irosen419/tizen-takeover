/*
 * Scan a barcode on the phone (the touch app only; the TV never loads this).
 *
 *   HUB_SCAN.register(id, { label(t), chip?(t), add(product, ctx, done(err)), note?(product, ctx, t), has?(product, ctx) })
 *                         where a scan can go. The grocery list registers
 *                         'grocery' (app/widgets/grocery.js), the pantry
 *                         'pantry' (app/widgets/pantry.js). add() gets the
 *                         opening view's ctx, which may belong to the other one.
 *   HUB_SCAN.open(ctx, { destination: 'grocery', destinations: ['pantry', 'grocery'], returnFocus: el })
 *                         destinations: an "Add to" chip on the card picks
 *                         one; the pick is remembered on this phone for the
 *                         view that opened Scan (localStorage, best effort),
 *                         else it starts on destination.
 *                         full-screen overlay: rear camera, torch when the
 *                         phone has one, a "type the number" box. A code is
 *                         looked up on the Pi (GET /products/lookup); found ->
 *                         confirm card -> add; not found -> a short form
 *                         (POST /products/save) -> the same card.
 *                         "Paste a list" takes many codes (a line or a comma
 *                         each): every one is looked up the same way and, when
 *                         found and not already there (dest.has), added; the
 *                         sheet lists each as added, already there, not found
 *                         (with "Add details"), not valid or failed.
 *
 *   HUB_SCAN.open(ctx, { edit: product, onSaved(product), returnFocus })
 *                         no camera: the form prefilled with a saved product's
 *                         brand, name, size and photo (POST /products/save).
 *
 * Detector: the browser's own BarcodeDetector when it reads EAN/UPC, else the
 * barcode-detector polyfill vendored in app/vendor/barcode-detector/ (ZXing
 * wasm), fetched only when Scan is first tapped, with the .wasm served by the
 * Pi (nothing from a CDN). window.HUB_SCAN_TEST = { detector, forcePolyfill }
 * is for dev/scan-test.js. The camera picture never leaves the phone; only the
 * number goes to the Pi. Product names and codes are never logged.
 * ctx (app/touch.js): t, call(method, url, body, timeoutMs), reduced, plus
 * whatever the destination needs (data, send, products).
 * Plain ES5; animation is transform and opacity only.
 */
(function (root) {
  'use strict';

  var FORMATS = ['ean_13', 'upc_a', 'upc_e', 'ean_8'];
  var LOOKUP_TIMEOUT = 25000;   // the Pi may try three web sources, ~6 s each
  var FRAME_MS = 140;           // between detector passes
  var REPEAT_MS = 3000;         // the same code is ignored this long after a resume
  var MANY_MAX = 200;           // codes in one pasted list
  var WAIT_MS = 15000;          // after the Pi says "too many lookups"
  var WAIT_TRIES = 4;
  var PHOTO_MAX = 320;          // px, the longer side of a saved photo
  var PHOTO_BYTES = 150 * 1024;

  var script = document.currentScript;
  var BASE = (script && script.src ? script.src : location.href).replace(/[?#].*$/, '').replace(/[^\/]*$/, '');
  var VENDOR = BASE + 'vendor/barcode-detector/';

  var destinations = {};
  function register(id, dest) { destinations[id] = dest; }

  /* ---------- small helpers ---------- */

  var SVG = 'http://www.w3.org/2000/svg';
  var PATHS = {
    cross: 'M7 7l10 10M17 7L7 17',
    torch: 'M8 3h8v3l-2 4v10a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V10L8 6z M12 13v2',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3 M5.5 11h13v9h-13z M12 15v2',
    camera: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z M12 10a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z',
    plus: 'M12 5v14M5 12h14',
    check: 'M5 12.5l4.2 4.2L19 7',
    barcode: 'M3 7V5.5A1.5 1.5 0 0 1 4.5 4H7 M17 4h2.5A1.5 1.5 0 0 1 21 5.5V7 M21 17v1.5a1.5 1.5 0 0 1-1.5 1.5H17 M7 20H4.5A1.5 1.5 0 0 1 3 18.5V17 M7 8.5v7 M9.5 8.5v7 M12 8.5v7 M14 8.5v7 M17 8.5v7',
    bars: 'M5 6v12 M8 6v12 M10.5 6v12 M14 6v12 M16.5 6v12 M19 6v12'
  };

  function icon(name, cls) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'sc-ic' + (cls ? ' ' + cls : ''));
    var p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', PATHS[name]);
    s.appendChild(p);
    return s;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(cls, text, ic) {
    var b = el('button', cls);
    b.type = 'button';
    if (ic) b.appendChild(icon(ic));
    if (text != null) b.appendChild(el('span', 'sc-btn-word', text));
    return b;
  }

  function digits(s) { return String(s == null ? '' : s).replace(/\D+/g, ''); }

  function validLength(c) { return c.length === 8 || c.length === 12 || c.length === 13 || c.length === 14; }

  // A typed or pasted list -> [{ code, ok }] in order, repeats dropped (a UPC-A
  // and its EAN-13 form are one pack). Lines and commas split codes; spaces and
  // dashes inside one belong to it ("0 12345 67890 5"). A single line of codes
  // split by spaces only (a phone turns pasted lines into spaces) splits too.
  function parseCodes(text) {
    var parts = String(text == null ? '' : text).split(/[\r\n,;]+/);
    if (parts.length === 1) {
      var words = parts[0].split(/\s+/).filter(Boolean);
      var each = words.length > 1 && words.every(function (w) { return validLength(digits(w)); });
      if (each) parts = words;
    }
    var out = [], seen = {}, repeats = 0;
    parts.forEach(function (p) {
      var c = digits(p);
      if (!c) return;
      var k = c.replace(/^0+/, '');
      if (seen[k]) { repeats++; return; }
      seen[k] = 1;
      out.push({ code: c, ok: validLength(c) });
    });
    out.repeats = repeats;
    return out;
  }

  // 0 123456 789012 (EAN-13), 1234 5678 (EAN-8): how the numbers sit under the bars.
  function pretty(code) {
    var c = digits(code);
    if (c.length === 13) return c.charAt(0) + ' ' + c.slice(1, 7) + ' ' + c.slice(7);
    if (c.length === 12) return c.charAt(0) + ' ' + c.slice(1, 6) + ' ' + c.slice(6, 11) + ' ' + c.charAt(11);
    if (c.length === 8) return c.slice(0, 4) + ' ' + c.slice(4);
    return c;
  }

  // The list line for a product: "Brand Name", the brand left out when the
  // name starts with it as a whole word; cut to 60 (pi/products.js lineName).
  function startsWithWord(text, start) {
    if (!start) return false;
    var t = text.toLowerCase(), s = start.toLowerCase();
    return t === s || t.indexOf(s + ' ') === 0;
  }
  function line(p) {
    if (!p) return '';
    var b = String(p.brand || ''), n = String(p.name || '');
    var out = (startsWithWord(n, b) ? n : b + ' ' + n).replace(/^\s+|\s+$/g, '');
    var chars = out.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || []; // code points, as Array.from
    return chars.length > 60 ? chars.slice(0, 60).join('').replace(/^\s+|\s+$/g, '') : out;
  }

  function secure() { return root.isSecureContext !== false && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

  /* ---------- the detector ---------- */

  var detectorPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('the barcode reader did not load')); };
      document.head.appendChild(s);
    });
  }

  function polyfill() {
    var ready = root.BarcodeDetectionAPI ? Promise.resolve() : loadScript(VENDOR + 'barcode-detector.js');
    return ready.then(function () {
      var api = root.BarcodeDetectionAPI;
      if (!api || !api.BarcodeDetector) throw new Error('the barcode reader did not load');
      // The .wasm comes from the Pi, never the CDN the package defaults to.
      var wasm = VENDOR + 'zxing_reader.wasm';
      var opts = { overrides: { locateFile: function (p, prefix) { return /\.wasm$/.test(p) ? wasm : prefix + p; } }, fireImmediately: true };
      return Promise.resolve(api.prepareZXingModule(opts)).then(function () {
        return new api.BarcodeDetector({ formats: FORMATS });
      });
    });
  }

  function detector() {
    var hook = root.HUB_SCAN_TEST || {};
    if (hook.detector) return Promise.resolve(hook.detector);
    if (detectorPromise) return detectorPromise;
    var Native = root.BarcodeDetector;
    var native = !hook.forcePolyfill && Native && Native.getSupportedFormats ?
      Promise.resolve(Native.getSupportedFormats()).then(function (have) {
        for (var i = 0; i < FORMATS.length; i++) if (have.indexOf(FORMATS[i]) < 0) return null;
        return new Native({ formats: FORMATS });
      }, function () { return null; }) : Promise.resolve(null);
    detectorPromise = native.then(function (d) { return d || polyfill(); });
    detectorPromise.then(null, function () { detectorPromise = null; });
    return detectorPromise;
  }

  /* ---------- a photo for the not-found form ---------- */

  function shrinkPhoto(file, cb) {
    var reader = new FileReader();
    reader.onerror = function () { cb(null); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { cb(null); };
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return cb(null);
        var k = Math.min(1, PHOTO_MAX / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        var g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        var q = 0.7, url = c.toDataURL('image/jpeg', q);
        while (url.length * 0.75 > PHOTO_BYTES && q > 0.3) { q -= 0.15; url = c.toDataURL('image/jpeg', q); }
        cb(url.length * 0.75 > PHOTO_BYTES ? null : url);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  /* ---------- the overlay ---------- */

  // The last "Add to" pick per opening view, on this phone only.
  function recall(view) {
    try { return root.localStorage.getItem('hub.scan.dest.' + view) || ''; } catch (e) { return ''; }
  }
  function remember(view, id) {
    try { root.localStorage.setItem('hub.scan.dest.' + view, id); } catch (e) { /* private mode: not kept */ }
  }

  var current = null;

  function open(ctx, opts) {
    opts = opts || {};
    if (current) current.close();
    var T = ctx.t;
    var choices = [];
    (opts.destinations || []).forEach(function (id) { if (destinations[id] && choices.indexOf(id) < 0) choices.push(id); });
    var destId = opts.destination || choices[0] || 'grocery';
    var picked = choices.length > 1 ? recall(ctx.id) : '';
    if (picked && choices.indexOf(picked) >= 0) destId = picked;
    var dest = destinations[destId];
    var destLabel = dest && dest.label ? dest.label(T) : '';
    var state = 'scan', stream = null, track = null, det = null, timer = null, toastTimer = null;
    var busy = false, closed = false, torchOn = false, lastCode = '', lastAt = 0, found = null;
    var grab = document.createElement('canvas');

    var box = el('div', 'sc');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', T('scan.title', 'Scan a barcode'));

    // The camera, full bleed, with the window to aim through.
    var stage = el('div', 'sc-stage');
    var video = el('video', 'sc-video');
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.muted = true;
    video.autoplay = true;
    stage.appendChild(video);
    var frame = el('div', 'sc-frame');
    ['tl', 'tr', 'bl', 'br'].forEach(function (c) { frame.appendChild(el('span', 'sc-corner is-' + c)); });
    frame.appendChild(el('span', 'sc-line'));
    stage.appendChild(frame);
    var aim = el('p', 'sc-aim', T('scan.starting', 'Opening the camera…'));
    aim.setAttribute('aria-live', 'polite');
    stage.appendChild(aim);
    var msg = el('div', 'sc-msg');
    stage.appendChild(msg);
    box.appendChild(stage);

    var top = el('header', 'sc-top');
    var closeBtn = button('sc-round sc-close', null, 'cross');
    closeBtn.setAttribute('aria-label', T('scan.close', 'Close'));
    var title = el('div', 'sc-title');
    title.appendChild(el('span', 'sc-title-word', opts.edit ? T('scan.editHead', 'Edit product') : T('scan.title', 'Scan a barcode')));
    var titleDest = el('span', 'sc-title-dest', destLabel);
    if (destLabel && !opts.edit) title.appendChild(titleDest);
    var torchBtn = button('sc-round sc-torch', null, 'torch');
    torchBtn.setAttribute('aria-label', T('scan.torchOn', 'Turn the light on'));
    torchBtn.setAttribute('aria-pressed', 'false');
    torchBtn.style.visibility = 'hidden';
    top.appendChild(closeBtn);
    top.appendChild(title);
    top.appendChild(torchBtn);
    box.appendChild(top);

    // Type the number: for torn labels, and when there is no camera.
    var dock = el('form', 'sc-dock');
    dock.setAttribute('autocomplete', 'off');
    dock.noValidate = true;
    var typeId = 'sc-type-' + Math.floor(Math.random() * 1e6);
    var typeLabel = el('label', 'sc-dock-label', T('scan.typeLabel', 'Or type the number'));
    typeLabel.setAttribute('for', typeId);
    var typeRow = el('div', 'sc-dock-row');
    var typeIn = el('input', 'sc-input sc-type');
    typeIn.id = typeId;
    typeIn.type = 'text';
    typeIn.setAttribute('inputmode', 'numeric');
    typeIn.setAttribute('enterkeyhint', 'search');
    typeIn.setAttribute('maxlength', '400');
    typeIn.placeholder = T('scan.typePlaceholder', 'Digits under the bars');
    var lookBtn = el('button', 'sc-btn sc-look', T('scan.lookUp', 'Look up'));
    lookBtn.type = 'submit';
    typeRow.appendChild(typeIn);
    typeRow.appendChild(lookBtn);
    // Many at once: a box for a pasted list, one code a line or comma between.
    var manyId = 'sc-many-' + Math.floor(Math.random() * 1e6);
    var manyWrap = el('div', 'sc-many');
    var manyIn = el('textarea', 'sc-input sc-many-in');
    manyIn.id = manyId;
    manyIn.rows = 4;
    manyIn.setAttribute('inputmode', 'numeric');
    manyIn.setAttribute('autocapitalize', 'none');
    manyIn.setAttribute('autocorrect', 'off');
    manyIn.setAttribute('spellcheck', 'false');
    manyIn.placeholder = T('scan.manyPlaceholder', 'One code on each line, or commas between');
    var manyGo = el('button', 'sc-btn sc-primary sc-many-go', T('scan.manyGo', 'Check and add all'));
    manyGo.type = 'button';
    manyWrap.appendChild(manyIn);
    manyWrap.appendChild(manyGo);
    var typeMsg = el('p', 'sc-dock-msg');
    typeMsg.setAttribute('aria-live', 'polite');
    var manyToggle = el('button', 'sc-link sc-many-toggle', T('scan.manyOpen', 'Paste a list of codes'));
    manyToggle.type = 'button';
    manyToggle.setAttribute('aria-expanded', 'false');
    dock.appendChild(typeLabel);
    dock.appendChild(typeRow);
    dock.appendChild(manyWrap);
    dock.appendChild(typeMsg);
    dock.appendChild(manyToggle);
    box.appendChild(dock);

    var sheet = el('section', 'sc-sheet');
    sheet.setAttribute('aria-live', 'polite');
    box.appendChild(sheet);

    var toast = el('div', 'sc-toast');
    toast.setAttribute('role', 'status');
    box.appendChild(toast);

    document.body.appendChild(box);
    document.body.className += ' sc-open';
    // Next frame: the overlay rises in (transform and opacity).
    box.getBoundingClientRect();
    box.className = 'sc is-on' + (ctx.reduced && ctx.reduced() ? ' is-calm' : '');
    closeBtn.focus();

    /* --- states --- */

    function setState(s) {
      state = s;
      box.setAttribute('data-state', s);
      sheet.className = 'sc-sheet' + (s === 'scan' ? '' : ' is-on');
      dock.setAttribute('aria-hidden', s === 'scan' ? 'false' : 'true');
      if (s === 'scan') { sheet.innerHTML = ''; schedule(); }
    }

    function say(text, kind) {
      typeMsg.textContent = text || '';
      typeMsg.className = 'sc-dock-msg' + (kind ? ' is-' + kind : '');
    }

    function showToast(text, bad) {
      toast.textContent = '';
      if (!bad) toast.appendChild(icon('check'));
      toast.appendChild(el('span', '', text));
      toast.className = 'sc-toast is-on' + (bad ? ' is-bad' : '');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.className = 'sc-toast' + (bad ? ' is-bad' : ''); }, bad ? 4500 : 1800);
    }

    function cameraMessage(kind) {
      var text = kind === 'insecure' ? T('scan.insecure', 'The camera only works on the hub’s secure address (https). You can still type the number below.') :
        kind === 'denied' ? T('scan.denied', 'The camera is blocked. Allow it in the browser’s settings, or type the number below.') :
        kind === 'reader' ? T('scan.noReader', 'The barcode reader didn’t load. Type the number below.') :
        T('scan.noCamera', 'No camera found. Type the number below.');
      msg.innerHTML = '';
      msg.appendChild(icon(kind === 'insecure' ? 'lock' : 'camera', 'sc-msg-ic'));
      msg.appendChild(el('p', 'sc-msg-text', text));
      box.className = box.className.replace(/ is-nocam/g, '') + ' is-nocam';
      aim.textContent = '';
      box.setAttribute('data-camera', kind);
    }

    /* --- the camera --- */

    function startCamera() {
      if (!secure()) { cameraMessage(root.isSecureContext === false ? 'insecure' : 'none'); return; }
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      }).then(function (s) {
        if (closed) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = s;
        track = s.getVideoTracks()[0] || null;
        video.srcObject = s;
        var p = video.play();
        if (p && p.then) p.then(null, function () { /* autoplay refused: the stream still draws */ });
        try {
          var caps = track && track.getCapabilities ? track.getCapabilities() : {};
          if (caps && caps.torch) torchBtn.style.visibility = '';
        } catch (e) { /* no capabilities: no torch */ }
        box.setAttribute('data-camera', 'on');
        aim.textContent = T('scan.loading', 'Getting the reader ready…');
        return detector().then(function (d) {
          det = d;
          if (!closed) aim.textContent = T('scan.aim', 'Point at the barcode');
          schedule();
        }, function () { cameraMessage('reader'); });
      }, function (e) {
        if (closed) return;
        cameraMessage(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'denied' : 'none');
      });
    }

    function stopCamera() {
      if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* gone */ } });
      stream = null; track = null;
      try { video.srcObject = null; } catch (e) { /* old engine */ }
    }

    // The middle band of the picture, where the window is, at most 960 px wide.
    function frameSource() {
      var vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh || video.readyState < 2) return null;
      var sw = Math.round(vw * 0.9), sh = Math.round(vh * 0.6);
      var k = Math.min(1, 960 / sw);
      grab.width = Math.round(sw * k);
      grab.height = Math.round(sh * k);
      grab.getContext('2d').drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, grab.width, grab.height);
      return grab;
    }

    function schedule() {
      if (timer || closed || !det || state !== 'scan') return;
      timer = setTimeout(tick, FRAME_MS);
    }

    function tick() {
      timer = null;
      if (closed || state !== 'scan' || busy || !det) return;
      var src = frameSource();
      if (!src) { schedule(); return; }
      busy = true;
      Promise.resolve(det.detect(src)).then(function (list) {
        busy = false;
        if (closed || state !== 'scan') return;
        for (var i = 0; list && i < list.length; i++) {
          var code = digits(list[i].rawValue);
          if (code.length < 8) continue;
          var same = code.replace(/^0+/, ''); // UPC-A and its EAN-13 form are one pack
          if (same === lastCode && Date.now() - lastAt < REPEAT_MS) continue;
          lastCode = same; lastAt = Date.now();
          try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { /* no buzz */ }
          lookup(code, list[i].format);
          return;
        }
        schedule();
      }, function () { busy = false; schedule(); });
    }

    torchBtn.addEventListener('click', function () {
      if (!track || !track.applyConstraints) return;
      torchOn = !torchOn;
      track.applyConstraints({ advanced: [{ torch: torchOn }] }).then(null, function () { torchOn = false; paintTorch(); });
      paintTorch();
    });
    function paintTorch() {
      torchBtn.setAttribute('aria-pressed', torchOn ? 'true' : 'false');
      torchBtn.setAttribute('aria-label', torchOn ? T('scan.torchOff', 'Turn the light off') : T('scan.torchOn', 'Turn the light on'));
      torchBtn.className = 'sc-round sc-torch' + (torchOn ? ' is-lit' : '');
    }

    /* --- lookup, confirm, the not-found form --- */

    function codeLine(code) {
      var c = el('p', 'sc-code');
      c.appendChild(icon('bars'));
      c.appendChild(el('span', 'sc-code-digits', pretty(code)));
      return c;
    }

    function lookup(code, format) {
      setState('looking');
      say('');
      var s = el('div', 'sc-looking');
      s.appendChild(el('span', 'sc-spin'));
      s.appendChild(el('p', 'sc-looking-word', T('scan.looking', 'Looking it up…')));
      sheet.appendChild(s);
      sheet.appendChild(codeLine(code));
      var url = '/products/lookup?upc=' + encodeURIComponent(code) + (format ? '&format=' + encodeURIComponent(format) : '');
      ctx.call('GET', url, undefined, LOOKUP_TIMEOUT).then(function (j) {
        if (closed || state !== 'looking') return;
        if (j.found && j.product) showFound(j.product);
        else showForm(j.upc || code);
      }, function (e) {
        if (closed) return;
        var why = e && e.message || '';
        setState('scan');
        say(/valid barcode/i.test(why) ? T('scan.invalid', 'That isn’t a valid barcode number.') : T('scan.failed', 'Couldn’t look it up: {why}', { why: why }), 'bad');
      });
    }

    function photoBox(p, big) {
      var ph = el('div', 'sc-photo' + (big ? ' is-big' : ''));
      if (p && p.image) {
        var img = el('img');
        img.alt = '';
        img.onerror = function () { ph.innerHTML = ''; ph.className += ' is-none'; ph.appendChild(icon('bars')); };
        img.src = p.image;
        ph.appendChild(img);
      } else {
        ph.className += ' is-none';
        ph.appendChild(icon('bars'));
      }
      return ph;
    }

    function showFound(p) {
      found = p;
      setState('found');
      sheet.innerHTML = '';
      var card = el('div', 'sc-card');
      card.appendChild(photoBox(p, true));
      var text = el('div', 'sc-card-text');
      if (p.brand) text.appendChild(el('p', 'sc-brand', p.brand));
      text.appendChild(el('h2', 'sc-name', p.name || p.brand || pretty(p.upc)));
      var meta = el('p', 'sc-meta');
      if (p.size) meta.appendChild(el('span', 'sc-size', p.size));
      meta.appendChild(el('span', 'sc-meta-code', pretty(p.upc)));
      text.appendChild(meta);
      card.appendChild(text);
      sheet.appendChild(card);
      if (choices.length > 1) sheet.appendChild(destChips(p));
      var note = dest && dest.note ? dest.note(p, ctx, T) : '';
      if (note) sheet.appendChild(el('p', 'sc-note', note));
      var add = button('sc-btn sc-primary sc-add', T('scan.addTo', 'Add to {dest}', { dest: destLabel }), 'plus');
      add.disabled = !dest;
      add.addEventListener('click', function () { addFound(); });
      sheet.appendChild(add);
      var row = el('div', 'sc-pair');
      var again = button('sc-btn sc-quiet sc-again', T('scan.another', 'Scan another'));
      var done = button('sc-btn sc-quiet sc-done', T('scan.done', 'Done'));
      again.addEventListener('click', function () { resume(); });
      done.addEventListener('click', function () { close(); });
      row.appendChild(again);
      row.appendChild(done);
      sheet.appendChild(row);
      add.focus();
    }

    // "Add to: Groceries | Pantry": switching redraws the card for that place.
    function destChips(p) {
      var row = el('div', 'sc-dests');
      row.setAttribute('role', 'group');
      var word = el('span', 'sc-dests-word', T('scan.addToLabel', 'Add to'));
      word.id = 'sc-dests-' + Math.floor(Math.random() * 1e6);
      row.setAttribute('aria-labelledby', word.id);
      row.appendChild(word);
      choices.forEach(function (id) {
        var d = destinations[id];
        var b = button('sc-dest' + (id === destId ? ' is-on' : ''), d.chip ? d.chip(T) : d.label(T));
        b.setAttribute('aria-pressed', id === destId ? 'true' : 'false');
        b.setAttribute('data-dest', id);
        b.addEventListener('click', function () {
          if (id === destId) return;
          destId = id;
          dest = destinations[id];
          destLabel = dest.label ? dest.label(T) : '';
          titleDest.textContent = destLabel;
          remember(ctx.id, id);
          showFound(p);
          var again = sheet.querySelector('.sc-dest[data-dest="' + id + '"]');
          if (again) again.focus();
        });
        row.appendChild(b);
      });
      return row;
    }

    function addFound() {
      if (!found || !dest) return;
      var p = found;
      dest.add(p, ctx, function (err) {
        if (err && !closed) showToast(T('scan.addFailed', 'That didn’t save: {why}', { why: err }), true);
      });
      showToast(T('scan.added', 'Added to {dest}', { dest: destLabel }));
      resume();
    }

    function resume() {
      found = null;
      if (dock.className.indexOf('is-many') >= 0) setMany(false, true);
      lastAt = Date.now();
      setState('scan');
      if (!det) typeIn.focus();
    }

    function field(labelText, cls, value, extra) {
      var wrap = el('label', 'sc-field ' + cls);
      wrap.appendChild(el('span', 'sc-field-label', labelText));
      var input = el('input', 'sc-input');
      input.type = 'text';
      input.value = value || '';
      input.setAttribute('autocapitalize', 'words');
      if (extra) input.setAttribute('maxlength', String(extra));
      wrap.appendChild(input);
      return { wrap: wrap, input: input };
    }

    function showForm(code, pre) {
      setState('form');
      sheet.innerHTML = '';
      var head = el('div', 'sc-form-head');
      head.appendChild(el('h2', 'sc-form-title', pre ? T('scan.editTitle', 'Fix the details') : T('scan.newTitle', 'New to the hub')));
      head.appendChild(el('p', 'sc-form-text', pre ? T('scan.editText', 'Add the brand or a photo; the list updates.') : T('scan.newText', 'Tell it once; the next scan finds it.')));
      sheet.appendChild(head);
      sheet.appendChild(codeLine(code));
      var form = el('form', 'sc-form');
      form.noValidate = true;
      form.setAttribute('autocomplete', 'off');
      var brand = field(T('scan.brand', 'Brand'), 'is-brand', pre ? pre.brand : '', 40);
      var name = field(T('scan.name', 'Product'), 'is-name', pre ? pre.name : '', 80);
      var size = field(T('scan.size', 'Size (optional)'), 'is-size', pre ? pre.size : '', 30);
      size.input.placeholder = T('scan.sizePlaceholder', 'e.g. 12 oz');
      size.input.setAttribute('autocapitalize', 'none');
      form.appendChild(brand.wrap);
      form.appendChild(name.wrap);
      form.appendChild(size.wrap);

      var photo = null;
      var pick = el('div', 'sc-pick');
      var file = el('input', 'sc-file');
      file.type = 'file';
      file.accept = 'image/*';
      file.setAttribute('capture', 'environment');
      file.setAttribute('tabindex', '-1');
      file.setAttribute('aria-hidden', 'true');
      var thumb = el('div', 'sc-photo is-none');
      thumb.appendChild(icon('camera'));
      if (pre && pre.image) {
        var cur = el('img');
        cur.alt = '';
        cur.onload = function () { if (photo) return; thumb.innerHTML = ''; thumb.className = 'sc-photo'; thumb.appendChild(cur); };
        cur.src = pre.image;
      }
      var pickBtn = button('sc-btn sc-quiet sc-pick-btn', T('scan.photo', 'Add a photo (optional)'));
      pick.appendChild(thumb);
      pick.appendChild(pickBtn);
      pick.appendChild(file);
      form.appendChild(pick);
      pickBtn.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f) return;
        shrinkPhoto(f, function (url) {
          if (!url) { formMsg.textContent = T('scan.photoFailed', 'That photo couldn’t be used.'); return; }
          photo = url;
          thumb.innerHTML = '';
          thumb.className = 'sc-photo';
          var img = el('img');
          img.alt = '';
          img.src = url;
          thumb.appendChild(img);
          pickBtn.lastChild.textContent = T('scan.photoChange', 'Change the photo');
        });
      });

      var formMsg = el('p', 'sc-form-msg');
      formMsg.setAttribute('aria-live', 'polite');
      form.appendChild(formMsg);
      var save = el('button', 'sc-btn sc-primary sc-save', T('scan.save', 'Save'));
      save.type = 'submit';
      form.appendChild(save);
      var cancel = button('sc-btn sc-quiet sc-cancel', T('scan.cancel', 'Cancel'));
      cancel.addEventListener('click', function () { if (opts.edit) close(); else if (!leaveForm()) resume(); });
      form.appendChild(cancel);
      sheet.appendChild(form);

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var b = brand.input.value.replace(/\s+/g, ' ').replace(/^ | $/g, '');
        var n = name.input.value.replace(/\s+/g, ' ').replace(/^ | $/g, '');
        var z = size.input.value.replace(/\s+/g, ' ').replace(/^ | $/g, '');
        if (!n) {
          formMsg.textContent = T('scan.needName', 'Fill in the product’s name.');
          name.input.focus();
          return;
        }
        save.disabled = true;
        save.textContent = T('scan.saving', 'Saving…');
        formMsg.textContent = '';
        var body = { upc: code, brand: b, name: n };
        if (z) body.size = z;
        if (photo) body.photo = photo;
        ctx.call('POST', '/products/save', body, LOOKUP_TIMEOUT).then(function (j) {
          if (closed) return;
          if (opts.edit) {
            var saved = j.product || { upc: code, brand: b, name: n, size: z, image: '' };
            close();
            if (opts.onSaved) opts.onSaved(saved);
            return;
          }
          var made = j.product || { upc: code, brand: b, name: n, size: z, image: '' };
          if (bulk && bulk.formRow) {
            // From the list: add the new product there, then back to the list.
            var row = bulk.formRow;
            row.product = made;
            dest.add(made, ctx, function (e2) {
              if (closed) return;
              if (e2) { row.status = 'error'; row.why = String(e2); } else row.status = 'added';
              leaveForm();
            });
            return;
          }
          showFound(made);
        }, function (err) {
          if (closed) return;
          save.disabled = false;
          save.textContent = T('scan.save', 'Save');
          formMsg.textContent = T('scan.saveFailed', 'That didn’t save: {why}', { why: err && err.message || '' });
        });
      });
      brand.input.focus();
    }

    /* --- many codes at once --- */

    var bulk = null;   // { rows, running, stopped, repeats, formRow }

    var STATUS_ICON = { added: 'check', have: 'check', missing: 'cross', invalid: 'cross', error: 'cross' };
    function statusText(r) {
      switch (r.status) {
        case 'added': return T('scan.rowAdded', 'Added');
        case 'have': return T('scan.rowHave', 'Already in {dest}', { dest: destLabel });
        case 'missing': return T('scan.rowMissing', 'Not found');
        case 'invalid': return T('scan.rowInvalid', 'Not a valid barcode');
        case 'error': return T('scan.rowError', 'Couldn’t look it up: {why}', { why: r.why || '' });
        case 'checking': return T('scan.rowChecking', 'Checking…');
        case 'waiting': return T('scan.rowWaiting', 'Too many lookups; waiting a moment…');
        default: return T('scan.rowQueued', 'Waiting');
      }
    }

    function counts() {
      var c = { added: 0, have: 0, missing: 0, invalid: 0, error: 0, left: 0 };
      bulk.rows.forEach(function (r) {
        if (c[r.status] !== undefined) c[r.status]++; else c.left++;
      });
      return c;
    }

    function renderBulk() {
      if (!bulk) return;
      var keep = sheet.scrollTop;
      sheet.innerHTML = '';
      var c = counts();
      var total = bulk.rows.length, done = total - c.left;
      var head = el('div', 'sc-form-head');
      head.appendChild(el('h2', 'sc-form-title', bulk.running ?
        T('scan.bulkRunning', 'Checking {i} of {n}', { i: Math.min(done + 1, total), n: total }) :
        T('scan.bulkDone', 'Checked {n}', { n: total })));
      var bits = [];
      if (c.added) bits.push(T('scan.sumAdded', '{n} added', { n: c.added }));
      if (c.have) bits.push(T('scan.sumHave', '{n} already in {dest}', { n: c.have, dest: destLabel }));
      if (c.missing) bits.push(T('scan.sumMissing', '{n} not found', { n: c.missing }));
      if (c.invalid) bits.push(T('scan.sumInvalid', '{n} not valid', { n: c.invalid }));
      if (c.error) bits.push(T('scan.sumError', '{n} failed', { n: c.error }));
      var sum = el('p', 'sc-form-text sc-bulk-sum', bits.join(' · ') || T('scan.rowQueued', 'Waiting'));
      sum.setAttribute('role', 'status');
      head.appendChild(sum);
      if (bulk.repeats) head.appendChild(el('p', 'sc-form-text sc-bulk-repeats', T('scan.sumRepeats', 'Skipped {n} repeated', { n: bulk.repeats })));
      sheet.appendChild(head);

      var list = el('ul', 'sc-bulk');
      bulk.rows.forEach(function (r) {
        var li = el('li', 'sc-bulk-row is-' + r.status);
        var badge = el('span', 'sc-bulk-badge');
        if (STATUS_ICON[r.status]) badge.appendChild(icon(STATUS_ICON[r.status]));
        else if (r.status === 'checking' || r.status === 'waiting') badge.appendChild(el('span', 'sc-spin'));
        li.appendChild(badge);
        var text = el('div', 'sc-bulk-text');
        text.appendChild(el('p', 'sc-bulk-name', r.product ? (line(r.product) || pretty(r.code)) : pretty(r.code)));
        text.appendChild(el('p', 'sc-bulk-state', (r.product ? pretty(r.code) + ' · ' : '') + statusText(r)));
        li.appendChild(text);
        if (r.status === 'missing' && !bulk.running) {
          var det = button('sc-bulk-details', T('scan.rowDetails', 'Add details'));
          det.addEventListener('click', function () { bulk.formRow = r; showForm(r.code); });
          li.appendChild(det);
        }
        list.appendChild(li);
      });
      sheet.appendChild(list);

      var actions = el('div', 'sc-pair sc-bulk-actions');
      if (bulk.running) {
        var stop = button('sc-btn sc-quiet sc-bulk-stop', T('scan.bulkStop', 'Stop'));
        stop.addEventListener('click', function () { bulk.stopped = true; stop.disabled = true; });
        actions.appendChild(stop);
      } else {
        if (c.error) {
          var retry = button('sc-btn sc-quiet sc-bulk-retry', T('scan.bulkRetry', 'Try the failed ones again'));
          retry.addEventListener('click', function () {
            bulk.rows.forEach(function (r) { if (r.status === 'error') { r.status = 'queued'; r.why = ''; } });
            runBulk();
          });
          actions.appendChild(retry);
        }
        var more = button('sc-btn sc-quiet sc-bulk-more', T('scan.bulkMore', 'Add more'));
        more.addEventListener('click', function () { bulk = null; resume(); });
        var fin = button('sc-btn sc-primary sc-bulk-done', T('scan.done', 'Done'));
        fin.addEventListener('click', function () { close(); });
        actions.appendChild(more);
        actions.appendChild(fin);
      }
      sheet.appendChild(actions);
      sheet.scrollTop = keep;
    }

    function nap(ms) {
      return new Promise(function (resolve) {
        var t0 = Date.now();
        (function wait() {
          if (closed || bulk.stopped || Date.now() - t0 >= ms) return resolve();
          setTimeout(wait, 250);
        })();
      });
    }

    function checkRow(r, tries) {
      r.status = 'checking';
      renderBulk();
      var url = '/products/lookup?upc=' + encodeURIComponent(r.code);
      return ctx.call('GET', url, undefined, LOOKUP_TIMEOUT).then(function (j) {
        if (closed) return;
        if (!j.found || !j.product) { r.status = 'missing'; return; }
        r.product = j.product;
        if (dest && dest.has && dest.has(j.product, ctx)) { r.status = 'have'; return; }
        return new Promise(function (resolve) {
          dest.add(j.product, ctx, function (err) {
            if (err) { r.status = 'error'; r.why = String(err); } else r.status = 'added';
            resolve();
          });
        });
      }, function (e) {
        if (closed) return;
        var why = e && e.message || '';
        if (/valid barcode/i.test(why)) { r.status = 'invalid'; return; }
        if (/too many/i.test(why) && tries < WAIT_TRIES && !bulk.stopped) {
          r.status = 'waiting';
          renderBulk();
          return nap(WAIT_MS).then(function () { if (!closed && !bulk.stopped) return checkRow(r, tries + 1); r.status = 'queued'; });
        }
        r.status = 'error';
        r.why = why;
      });
    }

    function runBulk() {
      var run = bulk;
      run.running = true;
      run.stopped = false;
      setState('bulk');
      renderBulk();
      var i = 0;
      (function next() {
        if (closed || bulk !== run) return;
        while (i < run.rows.length && run.rows[i].status !== 'queued') i++;
        if (run.stopped || i >= run.rows.length) {
          run.running = false;
          renderBulk();
          var again = sheet.querySelector('.sc-bulk-done');
          if (again) again.focus();
          return;
        }
        var r = run.rows[i];
        if (!r.ok) { r.status = 'invalid'; next(); return; }
        checkRow(r, 0).then(function () { renderBulk(); next(); });
      })();
    }

    function startBulk(list) {
      if (!list.length) { say(T('scan.invalid', 'That isn’t a valid barcode number.'), 'bad'); return; }
      if (list.length > MANY_MAX) { say(T('scan.manyTooMany', 'That’s a lot at once. Paste up to {n} codes.', { n: MANY_MAX }), 'bad'); return; }
      if (!dest) return;
      say('');
      manyIn.value = '';
      typeIn.value = '';
      typeIn.blur();
      manyIn.blur();
      bulk = { rows: list.map(function (p) { return { code: p.code, ok: p.ok, status: 'queued', product: null }; }), running: false, stopped: false, repeats: list.repeats || 0, formRow: null };
      runBulk();
    }

    function leaveForm() {
      var row = bulk && bulk.formRow;
      if (!row) return false;
      bulk.formRow = null;
      setState('bulk');
      renderBulk();
      return true;
    }

    function setMany(on, quiet) {
      dock.className = 'sc-dock' + (on ? ' is-many' : '');
      manyToggle.textContent = on ? T('scan.manyClose', 'Type one number instead') : T('scan.manyOpen', 'Paste a list of codes');
      manyToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
      typeLabel.textContent = on ? T('scan.manyLabel', 'Paste your codes') : T('scan.typeLabel', 'Or type the number');
      typeLabel.setAttribute('for', on ? manyId : typeId);
      say('');
      if (!quiet) (on ? manyIn : typeIn).focus();
    }
    manyToggle.addEventListener('click', function () { setMany(dock.className.indexOf('is-many') < 0); });
    manyGo.addEventListener('click', function () { startBulk(parseCodes(manyIn.value)); });

    /* --- wiring --- */

    dock.addEventListener('submit', function (e) {
      e.preventDefault();
      var many = parseCodes(typeIn.value);
      if (many.length > 1) { startBulk(many); return; }
      var code = digits(typeIn.value);
      if (code.length !== 8 && code.length !== 12 && code.length !== 13 && code.length !== 14) {
        say(T('scan.invalid', 'That isn’t a valid barcode number.'), 'bad');
        return;
      }
      typeIn.value = '';
      typeIn.blur();
      lookup(code, '');
    });

    closeBtn.addEventListener('click', function () { close(); });
    function onKey(e) {
      if (e.key !== 'Escape' && e.keyCode !== 27) return;
      if (state === 'form' && leaveForm()) return;
      if (state === 'bulk' && bulk && !bulk.running) { bulk = null; resume(); return; }
      if (!opts.edit && (state === 'found' || state === 'form')) resume(); else close();
    }
    document.addEventListener('keydown', onKey);

    function close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      if (toastTimer) clearTimeout(toastTimer);
      document.removeEventListener('keydown', onKey);
      stopCamera();
      document.body.className = document.body.className.replace(/ ?\bsc-open\b/g, '');
      if (box.parentNode) box.parentNode.removeChild(box);
      if (current === api) current = null;
      if (opts.returnFocus && opts.returnFocus.focus) { try { opts.returnFocus.focus(); } catch (e) { /* gone */ } }
    }

    var api = { close: close, lookup: lookup, state: function () { return state; }, destination: function () { return destId; } };
    current = api;
    if (opts.edit) {
      box.className += ' is-edit';
      showForm(opts.edit.upc, opts.edit);
    } else {
      setState('scan');
      startCamera();
    }
    return api;
  }

  root.HUB_SCAN = {
    destinations: destinations,
    register: register,
    open: open,
    close: function () { if (current) current.close(); },
    detector: detector,
    pretty: pretty,
    line: line,
    FORMATS: FORMATS
  };
})(window);
