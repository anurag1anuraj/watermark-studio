/* Watermark Studio – watermark tool logic.
 * Everything runs in the browser. Files are never uploaded.
 * Core geometry + PDF logic is DOM-free and exposed as WatermarkCore for testing.
 */
(function (global) {
  'use strict';

  var MAX_BYTES = 50 * 1024 * 1024;   // 50 MB
  var MAX_PIXELS = 120e6;             // ~120 megapixels
  var MAX_SIDE = 16384;               // canvas side limit used by most browsers
  var MAX_TILES = 6000;               // watermark repetitions per page / image

  /* ---------- Geometry shared by PDF export and canvas preview/export ---------- */

  // Returns centres (y-down coordinates) of every watermark repetition, or null if too many.
  // angleDeg is measured counter-clockwise as seen on screen.
  function computeTiles(W, H, tw, th, gapX, gapY, angleDeg, mode) {
    var cx = W / 2, cy = H / 2;
    if (mode === 'single') return [{ x: cx, y: cy }];

    var a = angleDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    var stepX = Math.max(1, tw + gapX), stepY = Math.max(1, th + gapY);
    var reach = Math.hypot(W, H) / 2 + tw;
    var cols = Math.ceil(reach / stepX), rows = Math.ceil(reach / stepY);
    if ((2 * cols + 1) * (2 * rows + 1) > 400000) return null;

    var margin = tw / 2 + th;
    var out = [];
    for (var r = -rows; r <= rows; r++) {
      var offset = (Math.abs(r) % 2) * stepX / 2; // stagger alternate rows
      for (var q = -cols; q <= cols; q++) {
        var gx = q * stepX + offset, gy = r * stepY;
        var x = cx + gx * c + gy * s;
        var y = cy - gx * s + gy * c;
        if (x < -margin || x > W + margin || y < -margin || y > H + margin) continue;
        out.push({ x: x, y: y });
        if (out.length > MAX_TILES) return null;
      }
    }
    return out;
  }

  function hexToRgb01(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    var v = m ? parseInt(m[1], 16) : 0;
    return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
  }

  var TOO_MANY = 'The spacing and font size would create too many watermark repetitions. Increase the spacing or font size, or switch to a single watermark.';

  /* ---------- PDF (pdf-lib) ---------- */

  async function watermarkPdfBytes(bytes, cfg, lib) {
    var PDFDocument = lib.PDFDocument, StandardFonts = lib.StandardFonts, rgb = lib.rgb, degrees = lib.degrees;
    var doc;
    try {
      doc = await PDFDocument.load(bytes);
    } catch (e) {
      var msg = String((e && (e.name + ' ' + e.message)) || '');
      if (/encrypt|password/i.test(msg)) {
        throw new Error('This PDF is password-protected or encrypted. Remove the protection first, then try again.');
      }
      throw new Error('This PDF could not be read. The file may be corrupted or not a valid PDF.');
    }

    var font = await doc.embedFont(StandardFonts.Helvetica);
    var tw;
    try {
      tw = font.widthOfTextAtSize(cfg.text, cfg.size);
    } catch (e) {
      throw new Error('PDF watermarks support standard Latin characters only (letters, numbers and common punctuation). Remove unsupported characters and try again.');
    }

    var pages = doc.getPages();
    if (!pages.length) throw new Error('This PDF has no pages.');

    var col = hexToRgb01(cfg.color);
    var color = rgb(col.r, col.g, col.b);

    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var size = page.getSize(), W = size.width, H = size.height;
      var mb = page.getMediaBox();
      var rot = ((Math.round(page.getRotation().angle) % 360) + 360) % 360;
      if (rot % 90 !== 0) rot = 0;
      var sideways = rot === 90 || rot === 270;
      var vw = sideways ? H : W, vh = sideways ? W : H; // dimensions as displayed

      var tiles = computeTiles(vw, vh, tw, cfg.size, cfg.gapX, cfg.gapY, cfg.angle, cfg.mode);
      if (!tiles) throw new Error(TOO_MANY);

      var textAngle = cfg.angle + rot;
      var ta = textAngle * Math.PI / 180, tc = Math.cos(ta), ts = Math.sin(ta);
      var lx = tw / 2, ly = cfg.size * 0.3; // centre of text relative to its baseline origin

      for (var k = 0; k < tiles.length; k++) {
        var vx = tiles[k].x, vy = vh - tiles[k].y; // y-up, displayed orientation
        var px, py;
        if (rot === 90) { px = W - vy; py = vx; }
        else if (rot === 180) { px = W - vx; py = H - vy; }
        else if (rot === 270) { px = vy; py = H - vx; }
        else { px = vx; py = vy; }

        var ox = px - (lx * tc - ly * ts);
        var oy = py - (lx * ts + ly * tc);
        page.drawText(cfg.text, {
          x: mb.x + ox,
          y: mb.y + oy,
          size: cfg.size,
          font: font,
          color: color,
          opacity: cfg.opacity,
          rotate: degrees(textAngle)
        });
      }
    }
    return doc.save();
  }

  global.WatermarkCore = { computeTiles: computeTiles, watermarkPdfBytes: watermarkPdfBytes, hexToRgb01: hexToRgb01 };

  /* ---------- Everything below needs the page DOM ---------- */
  if (typeof document === 'undefined' || !document.getElementById('wmText')) return;

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  ['fileInput', 'dropzone', 'fileInfo', 'message', 'wmText', 'wmSize', 'wmColor', 'wmOpacity', 'wmAngle',
    'wmGapX', 'wmGapY', 'sizeOut', 'opacityOut', 'angleOut', 'gapXOut', 'gapYOut', 'previewCanvas',
    'previewEmpty', 'previewNote', 'downloadBtn', 'downloadLabel', 'spinner', 'resetBtn', 'clearBtn',
    'gapFields', 'previewWrap'
  ].forEach(function (id) { els[id] = $(id); });

  var missing = Object.keys(els).filter(function (k) { return !els[k]; });
  if (missing.length) { console.error('Watermark Studio: missing elements', missing); return; }

  var DEFAULTS = { text: 'CONFIDENTIAL', size: 48, color: '#4f46e5', opacity: 30, angle: 30, gapX: 40, gapY: 60, mode: 'repeat' };
  var state = { file: null, kind: null, img: null, imgUrl: null, pdf: null, busy: false, token: 0 };

  /* ----- Messages & busy state ----- */
  function showMessage(type, text) {
    var base = 'rounded-lg border px-4 py-3 text-sm ';
    var styles = {
      error: 'border-red-200 bg-red-50 text-red-800',
      success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
      info: 'border-indigo-200 bg-indigo-50 text-indigo-800'
    };
    els.message.className = base + styles[type];
    els.message.textContent = text;
    els.message.classList.remove('hidden');
  }
  function clearMessage() { els.message.classList.add('hidden'); els.message.textContent = ''; }

  function updateDownloadState() {
    els.downloadBtn.disabled = state.busy || !state.file;
    els.spinner.classList.toggle('hidden', !state.busy);
    els.downloadLabel.textContent = state.busy ? 'Processing…' : 'Apply watermark & download';
  }
  function setBusy(b) { state.busy = b; updateDownloadState(); }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ----- PDF library loader with fallbacks ----- */
  var pdfLibPromise = null;
  var PDF_LIB_URLS = [
    'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
    'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js'
  ];
  function loadPdfLib() {
    if (global.PDFLib) return Promise.resolve(global.PDFLib);
    if (pdfLibPromise) return pdfLibPromise;
    pdfLibPromise = (async function () {
      for (var i = 0; i < PDF_LIB_URLS.length; i++) {
        try {
          await new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = PDF_LIB_URLS[i];
            s.onload = resolve;
            s.onerror = function () { s.remove(); reject(new Error('load failed')); };
            document.head.appendChild(s);
          });
          if (global.PDFLib) return global.PDFLib;
        } catch (e) { /* try next source */ }
      }
      pdfLibPromise = null;
      throw new Error('The PDF library (pdf-lib) could not be loaded. PDF watermarking needs an internet connection to fetch it. Check your connection and try again. Image watermarking is not affected.');
    })();
    return pdfLibPromise;
  }

  /* ----- pdf.js loader (used only to draw the real page-1 preview) ----- */
  var pdfJsPromise = null;
  var PDFJS_BASES = [
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/'
  ];
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
  }
  function loadPdfJs() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (pdfJsPromise) return pdfJsPromise;
    pdfJsPromise = (async function () {
      for (var i = 0; i < PDFJS_BASES.length; i++) {
        try {
          await loadScript(PDFJS_BASES[i] + 'pdf.min.js');
          if (global.pdfjsLib) {
            global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASES[i] + 'pdf.worker.min.js';
            return global.pdfjsLib;
          }
        } catch (e) { /* try next source */ }
      }
      pdfJsPromise = null;
      throw new Error('pdf.js could not be loaded');
    })();
    return pdfJsPromise;
  }

  // Renders page 1 of the PDF into an offscreen canvas for the live preview.
  async function renderPdfPage(file, token) {
    try {
      var lib = await loadPdfJs();
      var data = new Uint8Array(await file.arrayBuffer());
      var pdf = await lib.getDocument({ data: data }).promise;
      var page = await pdf.getPage(1);
      var base = page.getViewport({ scale: 1 });
      var vp = page.getViewport({ scale: 700 / base.width });
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(vp.width));
      c.height = Math.max(1, Math.round(vp.height));
      var cctx = c.getContext('2d');
      cctx.fillStyle = '#ffffff';
      cctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: cctx, viewport: vp }).promise;
      if (pdf.destroy) pdf.destroy();
      if (token !== state.token || !state.pdf) return;
      state.pdf.page = c;
    } catch (e) {
      if (token !== state.token || !state.pdf) return;
      state.pdf.pageFailed = true;
    }
    schedulePreview();
  }

  /* ----- Settings ----- */
  function readConfig() {
    var modeEl = document.querySelector('input[name="wmMode"]:checked');
    return {
      text: els.wmText.value.replace(/[\r\n]+/g, ' ').trim(),
      size: Number(els.wmSize.value),
      color: els.wmColor.value,
      opacity: Number(els.wmOpacity.value) / 100,
      angle: Number(els.wmAngle.value),
      gapX: Number(els.wmGapX.value),
      gapY: Number(els.wmGapY.value),
      mode: modeEl ? modeEl.value : 'repeat'
    };
  }

  function syncOutputs() {
    els.sizeOut.textContent = els.wmSize.value;
    els.opacityOut.textContent = els.wmOpacity.value + '%';
    els.angleOut.textContent = els.wmAngle.value + '°';
    els.gapXOut.textContent = els.wmGapX.value;
    els.gapYOut.textContent = els.wmGapY.value;
    var single = readConfig().mode === 'single';
    els.wmGapX.disabled = single;
    els.wmGapY.disabled = single;
    els.gapFields.classList.toggle('opacity-50', single);
  }

  /* ----- Canvas drawing (images + PDF layout preview) ----- */
  function drawOnCanvas(ctx, W, H, cfg, unit) {
    var size = cfg.size * unit, gx = cfg.gapX * unit, gy = cfg.gapY * unit;
    ctx.save();
    ctx.font = size + 'px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cfg.color;
    ctx.globalAlpha = cfg.opacity;
    var tw = ctx.measureText(cfg.text).width;
    var tiles = computeTiles(W, H, tw, size, gx, gy, cfg.angle, cfg.mode);
    if (!tiles) { ctx.restore(); throw new Error(TOO_MANY); }
    var rad = -cfg.angle * Math.PI / 180; // canvas rotates clockwise for positive values
    for (var i = 0; i < tiles.length; i++) {
      ctx.save();
      ctx.translate(tiles[i].x, tiles[i].y);
      ctx.rotate(rad);
      ctx.fillText(cfg.text, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  /* ----- Live preview ----- */
  var rafId = 0;
  function schedulePreview() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(function () { rafId = 0; renderPreview(); });
  }

  function renderPreview() {
    var cv = els.previewCanvas;
    if (!state.file) {
      cv.classList.add('hidden');
      els.previewEmpty.classList.remove('hidden');
      els.previewWrap.classList.remove('checker');
      els.previewNote.textContent = '';
      return;
    }
    els.previewEmpty.classList.add('hidden');
    cv.classList.remove('hidden');
    var cfg = readConfig();
    var ctx = cv.getContext('2d');

    try {
      if (state.kind === 'image') {
        var img = state.img;
        var scale = Math.min(1, 1200 / img.naturalWidth);
        cv.width = Math.max(1, Math.round(img.naturalWidth * scale));
        cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        els.previewWrap.classList.add('checker');
        if (cfg.text) drawOnCanvas(ctx, cv.width, cv.height, cfg, cv.width / 800);
        els.previewNote.textContent = 'Live preview of your image. The download uses the full original resolution.';
      } else {
        var p = state.pdf;
        var cw = p.page ? p.page.width : 700;
        var ch = p.page ? p.page.height : Math.max(1, Math.round(p.h * (700 / p.w)));
        var k = cw / p.w;
        cv.width = cw;
        cv.height = ch;
        els.previewWrap.classList.remove('checker');
        if (p.page) {
          ctx.drawImage(p.page, 0, 0);
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, cv.width, cv.height);
          // Neutral placeholder lines used while the page loads, or if it cannot be drawn.
          ctx.fillStyle = '#e2e8f0';
          var lineH = Math.max(6, cv.height / 70), y = cv.height * 0.08;
          for (var n = 0; y < cv.height * 0.92; n++, y += lineH * 2.2) {
            var lw = cv.width * (n % 5 === 4 ? 0.45 : 0.84);
            ctx.fillRect(cv.width * 0.08, y, lw, lineH);
          }
        }
        if (cfg.text) drawOnCanvas(ctx, cv.width, cv.height, cfg, k);
        ctx.strokeStyle = '#cbd5e1';
        ctx.strokeRect(0.5, 0.5, cv.width - 1, cv.height - 1);
        if (p.page) {
          els.previewNote.textContent = 'Preview of page 1 of ' + p.pages + '. The watermark is added to every page when you download.';
        } else if (p.pageFailed) {
          els.previewNote.textContent = 'Your PDF page could not be drawn here (the preview library did not load or could not read this file), so a blank layout of page 1 of ' + p.pages +
            ' is shown. The download will still contain your real content with the watermark.';
        } else {
          els.previewNote.textContent = 'Loading page 1 preview… (layout of page 1 of ' + p.pages + ' shown meanwhile)';
        }
      }
    } catch (e) {
      els.previewNote.textContent = e.message || 'Preview could not be drawn.';
    }
  }

  /* ----- File loading ----- */
  var IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  var EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function resetFile() {
    state.token++;
    if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
    state.file = null; state.kind = null; state.img = null; state.imgUrl = null; state.pdf = null;
    els.fileInput.value = '';
    els.fileInfo.classList.add('hidden');
    els.fileInfo.textContent = '';
    els.clearBtn.classList.add('hidden');
    updateDownloadState();
    renderPreview();
  }

  function showFileInfo(file, extra) {
    els.fileInfo.textContent = '';
    var name = document.createElement('span');
    name.className = 'font-medium text-slate-900 break-all';
    name.textContent = file.name;
    var meta = document.createElement('span');
    meta.className = 'block text-slate-500';
    meta.textContent = formatBytes(file.size) + (extra ? ' · ' + extra : '');
    els.fileInfo.appendChild(name);
    els.fileInfo.appendChild(meta);
    els.fileInfo.classList.remove('hidden');
    els.clearBtn.classList.remove('hidden');
  }

  async function handleFile(file) {
    clearMessage();
    if (!file) return;

    if (file.size === 0) { showMessage('error', 'That file is empty (0 bytes).'); return; }
    if (file.size > MAX_BYTES) {
      showMessage('error', 'That file is ' + formatBytes(file.size) + '. The limit is ' + formatBytes(MAX_BYTES) + ' so your browser does not run out of memory.');
      return;
    }

    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var isPdf = file.type === 'application/pdf' || (!file.type && ext === 'pdf') || ext === 'pdf';
    var isImage = !!IMAGE_TYPES[file.type] || (!file.type && !!EXT_TYPES[ext]);
    if (!isPdf && !isImage) {
      showMessage('error', 'Unsupported file type. Please choose a PDF, JPG, PNG or WebP file.');
      return;
    }

    resetFile();
    var token = ++state.token;
    setBusy(true);

    try {
      if (isPdf) {
        var head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
        var headStr = String.fromCharCode.apply(null, head);
        if (headStr.indexOf('%PDF-') === -1) throw new Error('This file does not look like a valid PDF.');

        var lib = await loadPdfLib();
        var doc;
        try {
          doc = await lib.PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
        } catch (e) {
          if (/encrypt|password/i.test(String(e && (e.name + e.message)))) {
            throw new Error('This PDF is password-protected or encrypted. Remove the protection first, then try again.');
          }
          throw new Error('This PDF could not be read. The file may be corrupted.');
        }
        if (token !== state.token) return;
        var count = doc.getPageCount();
        if (!count) throw new Error('This PDF has no pages.');
        var first = doc.getPage(0), sz = first.getSize(), r = ((first.getRotation().angle % 360) + 360) % 360;
        var sideways = r === 90 || r === 270;
        state.file = file; state.kind = 'pdf';
        state.pdf = { pages: count, w: sideways ? sz.height : sz.width, h: sideways ? sz.width : sz.height, page: null, pageFailed: false };
        showFileInfo(file, count + (count === 1 ? ' page' : ' pages'));
        renderPdfPage(file, token); // async; redraws the preview when ready
      } else {
        var url = URL.createObjectURL(file);
        var img = await new Promise(function (resolve, reject) {
          var im = new Image();
          im.onload = function () { resolve(im); };
          im.onerror = function () { reject(new Error('This image could not be read. It may be corrupted or in an unsupported variant of the format.')); };
          im.src = url;
        });
        if (token !== state.token) { URL.revokeObjectURL(url); return; }
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { URL.revokeObjectURL(url); throw new Error('This image has no readable dimensions.'); }
        if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) {
          URL.revokeObjectURL(url);
          throw new Error('This image is too large (' + w + ' × ' + h + ' px) to process safely in a browser. Resize it first.');
        }
        state.file = file; state.kind = 'image'; state.img = img; state.imgUrl = url;
        showFileInfo(file, w + ' × ' + h + ' px');
      }
    } catch (e) {
      if (token === state.token) {
        showMessage('error', e.message || 'The file could not be opened.');
        resetFile();
        token = state.token; // resetFile bumps the token; keep this load's cleanup valid
      }
    } finally {
      if (token === state.token) setBusy(false);
    }
    renderPreview();
  }

  /* ----- Export ----- */
  function baseName(name) {
    var n = name.replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_').trim();
    return n || 'file';
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  async function exportImage(cfg) {
    var img = state.img, w = img.naturalWidth, h = img.naturalHeight;
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    if (!ctx) throw new Error('Your browser could not create a canvas for this image.');
    ctx.drawImage(img, 0, 0, w, h);
    drawOnCanvas(ctx, w, h, cfg, w / 800);

    var type = IMAGE_TYPES[state.file.type] ? state.file.type : (EXT_TYPES[(state.file.name.split('.').pop() || '').toLowerCase()] || 'image/png');
    var blob = await new Promise(function (resolve) { cv.toBlob(resolve, type, 0.95); });
    if (!blob) throw new Error('The watermarked image could not be created. It may be too large for this browser.');
    var outExt = IMAGE_TYPES[blob.type] || 'png';
    return { blob: blob, name: baseName(state.file.name) + '-watermarked.' + outExt };
  }

  async function exportPdf(cfg) {
    var lib = await loadPdfLib();
    var bytes = new Uint8Array(await state.file.arrayBuffer());
    var out = await watermarkPdfBytes(bytes, cfg, lib);
    return { blob: new Blob([out], { type: 'application/pdf' }), name: baseName(state.file.name) + '-watermarked.pdf' };
  }

  async function onDownload() {
    if (!state.file || state.busy) return;
    var cfg = readConfig();
    if (!cfg.text) {
      showMessage('error', 'Enter the watermark text first.');
      els.wmText.focus();
      return;
    }
    setBusy(true);
    showMessage('info', 'Processing your file. Large files can take a few seconds…');
    await sleep(40); // let the loading state paint
    try {
      var result = state.kind === 'pdf' ? await exportPdf(cfg) : await exportImage(cfg);
      saveBlob(result.blob, result.name);
      showMessage('success', 'Done. “' + result.name + '” (' + formatBytes(result.blob.size) + ') was downloaded. Your original file was not changed.');
    } catch (e) {
      showMessage('error', e && e.message ? e.message : 'Something went wrong while creating the watermarked file.');
    } finally {
      setBusy(false);
    }
  }

  /* ----- Defaults / events ----- */
  function applyDefaults() {
    els.wmText.value = DEFAULTS.text;
    els.wmSize.value = DEFAULTS.size;
    els.wmColor.value = DEFAULTS.color;
    els.wmOpacity.value = DEFAULTS.opacity;
    els.wmAngle.value = DEFAULTS.angle;
    els.wmGapX.value = DEFAULTS.gapX;
    els.wmGapY.value = DEFAULTS.gapY;
    var radio = document.querySelector('input[name="wmMode"][value="' + DEFAULTS.mode + '"]');
    if (radio) radio.checked = true;
    syncOutputs();
    schedulePreview();
  }

  ['wmText', 'wmSize', 'wmColor', 'wmOpacity', 'wmAngle', 'wmGapX', 'wmGapY'].forEach(function (id) {
    els[id].addEventListener('input', function () { syncOutputs(); schedulePreview(); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="wmMode"]'), function (r) {
    r.addEventListener('change', function () { syncOutputs(); schedulePreview(); });
  });

  els.fileInput.addEventListener('change', function () { handleFile(els.fileInput.files[0]); });
  els.downloadBtn.addEventListener('click', onDownload);
  els.resetBtn.addEventListener('click', applyDefaults);
  els.clearBtn.addEventListener('click', function () { clearMessage(); resetFile(); });

  ['dragenter', 'dragover'].forEach(function (ev) {
    els.dropzone.addEventListener(ev, function (e) { e.preventDefault(); els.dropzone.classList.add('dropzone-active'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    els.dropzone.addEventListener(ev, function (e) { e.preventDefault(); els.dropzone.classList.remove('dropzone-active'); });
  });
  els.dropzone.addEventListener('drop', function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      if (files.length > 1) showMessage('info', 'Only one file can be processed at a time. Using “' + files[0].name + '”.');
      handleFile(files[0]);
    }
  });

  applyDefaults();
  updateDownloadState();
  // Warm up pdf-lib in the background; failures are reported only when a PDF is used.
  loadPdfLib().catch(function () {});
})(typeof window !== 'undefined' ? window : globalThis);
