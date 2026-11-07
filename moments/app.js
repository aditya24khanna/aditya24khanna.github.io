/* Moments — a private photo/video memory log. No backend; IndexedDB only. */
'use strict';

const $ = (s) => document.querySelector(s);
const MAX_VIDEO_SEC = 30;
const MAX_PHOTO_EDGE = 2048;
const THUMB_EDGE = 640;
const HOLD_MS = 260;

/* =========================================================
   STORE — the only module that touches persistence.
   A sync adapter can wrap these five calls later.
   ========================================================= */
const store = (() => {
  let dbp;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('moments', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        const m = d.createObjectStore('memories', { keyPath: 'id' });
        m.createIndex('createdAt', 'createdAt');
        d.createObjectStore('media'); // key: id | id+':thumb'
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function tx(stores, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then((v) => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Transaction aborted'));
    });
  }
  return {
    async list({ includeDeleted = false } = {}) {
      const all = await tx(['memories'], 'readonly', (t) => req(t.objectStore('memories').getAll()));
      return all.filter((m) => includeDeleted || !m.deleted).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    get: (id) => tx(['memories'], 'readonly', (t) => req(t.objectStore('memories').get(id))),
    async put(memory, media) {
      return tx(['memories', 'media'], 'readwrite', (t) => {
        t.objectStore('memories').put(memory);
        if (media && media.blob) t.objectStore('media').put(media.blob, memory.id);
        if (media && media.thumb) t.objectStore('media').put(media.thumb, memory.id + ':thumb');
      });
    },
    getMedia: (id, thumb = false) => tx(['media'], 'readonly', (t) => req(t.objectStore('media').get(thumb ? id + ':thumb' : id))),
    // Soft delete keeps a tombstone for future sync; media is freed immediately.
    async remove(id, { hard = false } = {}) {
      return tx(['memories', 'media'], 'readwrite', async (t) => {
        const ms = t.objectStore('memories');
        if (hard) ms.delete(id);
        else {
          const m = await req(ms.get(id));
          if (m) ms.put({ ...m, deleted: true, caption: '', updatedAt: new Date().toISOString(), syncState: 'local' });
        }
        t.objectStore('media').delete(id);
        t.objectStore('media').delete(id + ':thumb');
      });
    },
    async clearAll() {
      return tx(['memories', 'media'], 'readwrite', (t) => { t.objectStore('memories').clear(); t.objectStore('media').clear(); });
    },
  };
})();

/* =========================================================
   STATE + URL CACHE
   ========================================================= */
const state = {
  memories: [],
  view: localStorage.getItem('moments.view') || 'feed',
  query: '',
  draft: null,        // { blob, thumb, type, mime, width, height, durationSec, createdAt, editingId }
  captionSource: { typed: false, voice: false },
  viewerIndex: -1,
  pendingDelete: null,
};
const urls = new Map();
async function mediaURL(id, thumb) {
  const key = thumb ? id + ':t' : id;
  if (urls.has(key)) return urls.get(key);
  const blob = await store.getMedia(id, thumb);
  if (!blob) return thumb ? mediaURL(id, false) : '';
  const u = URL.createObjectURL(blob);
  urls.set(key, u);
  return u;
}
function dropURLs(id) {
  for (const k of [id, id + ':t']) { if (urls.has(k)) { URL.revokeObjectURL(urls.get(k)); urls.delete(k); } }
}

/* =========================================================
   NAV
   ========================================================= */
const screens = ['feed', 'camera', 'compose', 'viewer'];
function show(name) {
  for (const s of screens) $('#' + s).classList.toggle('active', s === name);
  if (name !== 'camera') camera.stop();
  if (name !== 'compose') speech.stop();
  if (name !== 'viewer') { const v = $('#viewer-stage video'); if (v) v.pause(); $('#viewer-menu').hidden = true; }
  if (name === 'feed') feedVideos.resume(); else feedVideos.pauseAll();
}
function haptic(ms = 12) { if (navigator.vibrate) try { navigator.vibrate(ms); } catch (_) {} }

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = '';
  const span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
  if (action) {
    const b = document.createElement('button'); b.textContent = action.label;
    b.onclick = () => { action.fn(); t.classList.remove('show'); };
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2400);
}

/* =========================================================
   TIME FORMATTING
   ========================================================= */
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
function dayLabel(d) {
  const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return 'Today';
  if (dayKey(d) === dayKey(y)) return 'Yesterday';
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}
const timeLabel = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fullLabel = (d) => `${dayLabel(d)} · ${timeLabel(d)}`;
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
function agoLabel(d) {
  const now = new Date();
  const months = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
  if (months >= 12 && months % 12 === 0) return months === 12 ? '1 year ago' : `${months / 12} years ago`;
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

/* =========================================================
   FEED
   ========================================================= */
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>';
const ICON_MIC = '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/></svg>';

function escapeHTML(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function highlight(text, q) {
  const safe = escapeHTML(text);
  if (!q) return safe;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}
function visibleMemories() {
  const q = state.query.trim().toLowerCase();
  return q ? state.memories.filter((m) => m.caption.toLowerCase().includes(q)) : state.memories;
}

function cardEl(m) {
  const d = new Date(m.createdAt);
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = m.id;
  const ar = m.width && m.height ? Math.min(Math.max(m.width / m.height, 0.8), 1.91) : 0.8;
  const voice = m.captionSource === 'voice' || m.captionSource === 'mixed';
  el.innerHTML = `
    <div class="card-media" style="--ar:${ar}">
      <img alt="" decoding="async">
      ${m.type === 'video' ? `<span class="badge">${ICON_PLAY}${m.durationSec ? fmtDur(m.durationSec) : ''}</span>` : ''}
    </div>
    <div class="card-body">
      <p class="card-caption ${m.caption ? '' : 'none'}">${m.caption ? highlight(m.caption, state.query.trim()) : 'No caption'}</p>
      <div class="card-time">${timeLabel(d)}${voice ? `<span class="voice">· ${ICON_MIC}said</span>` : ''}</div>
    </div>`;
  el.addEventListener('click', () => openViewer(m.id));
  lazy.observe(el);
  return el;
}

// Lazy-load media as cards approach the viewport.
const lazy = new IntersectionObserver(async (entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    lazy.unobserve(e.target);
    const id = e.target.dataset.id;
    const m = state.memories.find((x) => x.id === id);
    if (!m) continue;
    const img = e.target.querySelector('img');
    const useThumb = state.view === 'grid' || m.type === 'video';
    img.src = await mediaURL(id, useThumb);
    if (m.type === 'video' && state.view === 'feed') feedVideos.observe(e.target);
  }
}, { rootMargin: '600px 0px' });

// Instagram-style: videos autoplay muted when mostly on screen.
const feedVideos = (() => {
  const playing = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const card = e.target;
      if (e.intersectionRatio >= 0.6 && $('#feed').classList.contains('active')) start(card);
      else stop(card);
    }
  }, { threshold: [0, 0.6] });
  async function start(card) {
    let v = card.querySelector('video');
    if (!v) {
      v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', '');
      v.src = await mediaURL(card.dataset.id, false);
      v.style.position = 'absolute'; v.style.inset = '0';
      card.querySelector('.card-media').insertBefore(v, card.querySelector('.badge'));
    }
    v.play().catch(() => {});
    playing.add(card);
  }
  function stop(card) { const v = card.querySelector('video'); if (v) v.pause(); playing.delete(card); }
  return {
    observe: (c) => io.observe(c),
    pauseAll: () => { for (const c of [...playing]) stop(c); },
    resume: () => { io.takeRecords(); for (const c of document.querySelectorAll('.card video')) { const card = c.closest('.card'); io.unobserve(card); io.observe(card); } },
    reset: () => { io.disconnect(); playing.clear(); },
  };
})();

function renderFeed() {
  feedVideos.reset();
  document.body.classList.toggle('grid', state.view === 'grid');
  $('#btn-view').setAttribute('aria-label', state.view === 'grid' ? 'Switch to feed view' : 'Switch to grid view');
  const list = $('#list');
  list.innerHTML = '';
  const items = visibleMemories();
  $('#empty').hidden = state.memories.length > 0;
  $('#no-results').hidden = !(state.memories.length && !items.length);
  let group, lastKey;
  const frag = document.createDocumentFragment();
  for (const m of items) {
    const d = new Date(m.createdAt);
    const k = dayKey(d);
    if (k !== lastKey) {
      group = document.createElement('div');
      group.className = 'day-group';
      const h = document.createElement('h3');
      h.className = 'day-head'; h.textContent = dayLabel(d);
      group.appendChild(h);
      frag.appendChild(group);
      lastKey = k;
    }
    group.appendChild(cardEl(m));
  }
  list.appendChild(frag);
  renderOnThisDay();
}

async function renderOnThisDay() {
  const box = $('#onthisday');
  const now = new Date();
  const hits = state.query ? [] : state.memories.filter((m) => {
    const d = new Date(m.createdAt);
    return d.getDate() === now.getDate() && (d.getFullYear() < now.getFullYear() || d.getMonth() < now.getMonth()) && d < now && dayKey(d) !== dayKey(now);
  });
  if (!hits.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<h3 class="otd-title">On this day</h3><div class="otd-strip"></div>';
  const strip = box.querySelector('.otd-strip');
  for (const m of hits.slice(0, 12)) {
    const b = document.createElement('button');
    b.className = 'otd-item';
    b.innerHTML = `<img alt=""><span>${agoLabel(new Date(m.createdAt))}</span>`;
    b.onclick = () => openViewer(m.id);
    strip.appendChild(b);
    b.querySelector('img').src = await mediaURL(m.id, true);
  }
}

async function reload() {
  state.memories = await store.list();
  renderFeed();
}

/* =========================================================
   MEDIA HELPERS
   ========================================================= */
function canvasToBlob(c, type = 'image/jpeg', q = 0.85) {
  return new Promise((res) => c.toBlob(res, type, q));
}
function fit(w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.round(w * s), Math.round(h * s)];
}
async function drawScaled(src, sw, sh, max, mirror = false) {
  const [w, h] = fit(sw, sh, max);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}
async function imageFileToDraft(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) {
    bmp = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file);
    });
  }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const big = await drawScaled(bmp, w, h, MAX_PHOTO_EDGE);
  const small = await drawScaled(bmp, w, h, THUMB_EDGE);
  return {
    type: 'photo', mime: 'image/jpeg',
    blob: await canvasToBlob(big), thumb: await canvasToBlob(small, 'image/jpeg', 0.78),
    width: big.width, height: big.height,
    createdAt: file.lastModified && Date.now() - file.lastModified < 864e5 * 3650 ? new Date(file.lastModified).toISOString() : new Date().toISOString(),
  };
}
function videoFileToDraft(file) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const u = URL.createObjectURL(file);
    let done = false;
    const finish = async () => {
      if (done) return; done = true;
      let thumb = null;
      try { thumb = await canvasToBlob(await drawScaled(v, v.videoWidth, v.videoHeight, THUMB_EDGE), 'image/jpeg', 0.78); } catch (_) {}
      URL.revokeObjectURL(u);
      res({
        type: 'video', mime: file.type || 'video/mp4', blob: file, thumb,
        width: v.videoWidth, height: v.videoHeight,
        durationSec: isFinite(v.duration) ? Math.round(v.duration) : undefined,
        createdAt: file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString(),
      });
    };
    v.onloadeddata = () => { v.currentTime = Math.min(0.2, (v.duration || 1) / 2); };
    v.onseeked = finish;
    v.onerror = () => rej(new Error('Could not read that video'));
    setTimeout(finish, 4000);
    v.src = u;
  });
}
async function fileToDraft(file) {
  if (!file) return;
  try {
    const draft = file.type.startsWith('video') ? await videoFileToDraft(file) : await imageFileToDraft(file);
    openCompose(draft);
  } catch (e) {
    toast("Couldn't open that file.");
  }
}

/* =========================================================
   CAMERA
   ========================================================= */
const camera = (() => {
  let stream = null, facing = 'environment', recorder = null, chunks = [], recStart = 0, recTimer = null, holdTimer = null;
  let pressed = false, recThumb = null;
  const vf = $('#viewfinder');
  const ring = $('#ring-prog');
  const RING = 283;

  async function start() {
    stop();
    $('#cam-fallback').hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return fallback("This browser can't open the camera directly.");
    const video = { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
    } catch (e) {
      try { stream = await navigator.mediaDevices.getUserMedia({ video, audio: false }); }
      catch (e2) {
        return fallback(e2.name === 'NotAllowedError'
          ? 'Camera access is off. You can still use your phone’s camera app.'
          : 'No camera found here.');
      }
    }
    if (!$('#camera').classList.contains('active')) return stop();
    localStorage.setItem('moments.camOK', '1');
    vf.srcObject = stream;
    vf.classList.toggle('mirror', facing === 'user');
    try { await vf.play(); } catch (_) {}
  }
  function fallback(msg) {
    $('#cam-fallback-msg').textContent = msg;
    $('#cam-fallback').hidden = false;
  }
  function stop() {
    if (recorder && recorder.state === 'recording') { recorder.onstop = null; recorder.stop(); }
    recorder = null; resetRecUI();
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    vf.srcObject = null;
  }
  async function frameCanvas(max) {
    return drawScaled(vf, vf.videoWidth, vf.videoHeight, max, facing === 'user');
  }
  async function takePhoto() {
    if (!stream || !vf.videoWidth) return;
    haptic(15);
    const f = $('#cam-flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    const big = await frameCanvas(MAX_PHOTO_EDGE);
    const small = await frameCanvas(THUMB_EDGE);
    openCompose({
      type: 'photo', mime: 'image/jpeg',
      blob: await canvasToBlob(big), thumb: await canvasToBlob(small, 'image/jpeg', 0.78),
      width: big.width, height: big.height, createdAt: new Date().toISOString(),
    });
  }
  function pickMime() {
    // Prefer H.264 so saved videos play everywhere (incl. iPhone Photos); fall back gracefully.
    const opts = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4','video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return opts.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }
  async function startRec() {
    if (!stream || !window.MediaRecorder) return takePhoto();
    haptic(25);
    recThumb = await canvasToBlob(await frameCanvas(THUMB_EDGE), 'image/jpeg', 0.78);
    const mime = pickMime();
    chunks = [];
    try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined); }
    catch (_) { recorder = new MediaRecorder(stream); }
    recorder.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    recorder.onstop = finishRec;
    recorder.start(250);
    recStart = performance.now();
    $('#shutter').classList.add('recording');
    $('#rec-badge').hidden = false;
    $('#cam-hint').style.opacity = 0;
    tick();
  }
  function tick() {
    const s = (performance.now() - recStart) / 1000;
    ring.style.strokeDashoffset = RING * (1 - Math.min(s / MAX_VIDEO_SEC, 1));
    $('#rec-time').textContent = fmtDur(Math.floor(s));
    if (s >= MAX_VIDEO_SEC) return stopRec();
    recTimer = requestAnimationFrame(tick);
  }
  function stopRec() {
    if (recorder && recorder.state === 'recording') recorder.stop();
  }
  function resetRecUI() {
    cancelAnimationFrame(recTimer);
    $('#shutter').classList.remove('recording');
    $('#rec-badge').hidden = true;
    $('#cam-hint').style.opacity = '';
    ring.style.strokeDashoffset = RING;
  }
  function finishRec() {
    const dur = (performance.now() - recStart) / 1000;
    const type = (recorder && recorder.mimeType) || chunks[0]?.type || 'video/webm';
    resetRecUI();
    haptic(15);
    if (dur < 0.6) { toast('Hold a little longer for video.'); return; }
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    openCompose({
      type: 'video', mime: blob.type, blob, thumb: recThumb,
      width: vf.videoWidth, height: vf.videoHeight, durationSec: Math.round(dur),
      createdAt: new Date(Date.now() - dur * 1000).toISOString(),
    });
  }

  // Shutter: tap = photo, hold = video (Instagram/Snap pattern).
  const sh = $('#shutter');
  sh.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pressed = true;
    try { sh.setPointerCapture(e.pointerId); } catch (_) {}
    holdTimer = setTimeout(() => { if (pressed) startRec(); }, HOLD_MS);
  });
  const release = () => {
    if (!pressed) return;
    pressed = false;
    clearTimeout(holdTimer);
    if (recorder && recorder.state === 'recording') stopRec();
    else takePhoto();
  };
  sh.addEventListener('pointerup', release);
  sh.addEventListener('pointercancel', () => { pressed = false; clearTimeout(holdTimer); stopRec(); });
  sh.addEventListener('contextmenu', (e) => e.preventDefault());
  // Keyboard: space/enter = photo
  sh.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); takePhoto(); } });

  $('#cam-flip').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; haptic(); start(); };
  $('#cam-close').onclick = () => show('feed');
  $('#cam-gallery').onclick = () => $('#file-pick').click();
  $('#cam-fallback-gallery').onclick = () => $('#file-pick').click();
  $('#cam-native').onclick = () => $('#file-capture').click();

  return { start, stop };
})();

function openCamera() { show('camera'); camera.start(); }

/* =========================================================
   SPEECH (on-device / browser)
   ========================================================= */
const speech = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const ta = $('#caption');
  const btn = $('#mic');
  let rec = null, listening = false, base = '', finals = '';
  let lang = localStorage.getItem('moments.lang') || 'en-IN';
  const langBtn = $('#lang');
  const setLangUI = () => { langBtn.textContent = lang === 'hi-IN' ? 'हि' : 'EN'; langBtn.setAttribute('aria-label', lang === 'hi-IN' ? 'Dictation language: Hindi' : 'Dictation language: English'); };
  setLangUI();

  if (!SR) {
    btn.hidden = true; langBtn.hidden = true; $('#mic-hint').hidden = false;
  }

  function setUI(on) {
    listening = on;
    btn.setAttribute('aria-pressed', String(on));
    $('#mic-label').textContent = on ? 'Listening… tap to stop' : 'Say it';
    ta.classList.toggle('listening', on);
  }
  function start() {
    if (!SR || listening) return;
    rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    base = ta.value.trim();
    finals = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals += r[0].transcript.trim() + ' ';
        else interim += r[0].transcript;
      }
      const spoken = (finals + interim).trim();
      const text = (base ? base + ' ' : '') + (spoken ? spoken.charAt(0).toUpperCase() + spoken.slice(1) : '');
      ta.value = text.slice(0, 280);
      state.captionSource.voice = true;
      updateCount();
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Microphone access is off. You can type instead.');
      else if (e.error === 'network') toast('Dictation needs a connection on this browser.');
      else if (e.error !== 'no-speech' && e.error !== 'aborted') toast("Didn't catch that. Try again.");
    };
    rec.onend = () => { setUI(false); rec = null; };
    try { rec.start(); setUI(true); haptic(); } catch (_) { setUI(false); }
  }
  function stop() { if (rec) { try { rec.stop(); } catch (_) {} } setUI(false); }

  btn.onclick = () => (listening ? stop() : start());
  langBtn.onclick = () => {
    lang = lang === 'en-IN' ? 'hi-IN' : 'en-IN';
    localStorage.setItem('moments.lang', lang);
    setLangUI();
    if (listening) { stop(); setTimeout(start, 250); }
  };
  return { stop, supported: !!SR };
})();

/* =========================================================
   COMPOSE
   ========================================================= */
function updateCount() {
  const n = $('#caption').value.length;
  const c = $('#count');
  c.textContent = `${n}/280`;
  c.classList.toggle('near', n > 250);
}

async function openCompose(draft) {
  state.draft = draft;
  state.captionSource = { typed: false, voice: false };
  const box = $('#compose-media');
  box.innerHTML = '';
  let src;
  if (draft.editingId) src = await mediaURL(draft.editingId, false);
  else src = draft.previewURL = URL.createObjectURL(draft.blob);
  if (draft.type === 'video') {
    const v = document.createElement('video');
    v.src = src; v.playsInline = true; v.setAttribute('playsinline', ''); v.loop = true; v.muted = true; v.autoplay = true; v.controls = false;
    v.onclick = () => { v.muted = !v.muted; };
    box.appendChild(v);
    v.play().catch(() => {});
  } else {
    const i = document.createElement('img'); i.src = src; i.alt = ''; box.appendChild(i);
  }
  $('#caption').value = draft.caption || '';
  $('#compose-title').textContent = draft.editingId ? 'Edit caption' : 'New moment';
  $('#compose-cancel').textContent = draft.editingId ? 'Cancel' : 'Discard';
  $('#compose-when').textContent = fullLabel(new Date(draft.createdAt));
  updateCount();
  show('compose');
  // Focus without popping the keyboard over the preview on small phones.
  if (window.innerHeight > 700 && !speech.supported) setTimeout(() => $('#caption').focus(), 280);
}

function closeCompose() {
  if (state.draft && state.draft.previewURL) URL.revokeObjectURL(state.draft.previewURL);
  state.draft = null;
}

$('#caption').addEventListener('input', (e) => {
  if (e.isTrusted && e.inputType) state.captionSource.typed = true;
  updateCount();
});

$('#compose-save').onclick = async () => {
  const d = state.draft;
  if (!d) return;
  speech.stop();
  const caption = $('#caption').value.trim().slice(0, 280);
  const now = new Date().toISOString();
  const cs = state.captionSource;
  const source = cs.voice && cs.typed ? 'mixed' : cs.voice ? 'voice' : 'typed';
  $('#compose-save').disabled = true;
  try {
    if (d.editingId) {
      const m = await store.get(d.editingId);
      const updated = { ...m, caption, updatedAt: now, syncState: 'local',
        captionSource: caption === m.caption ? m.captionSource : (m.captionSource && m.captionSource !== source ? 'mixed' : source) };
      const i = state.memories.findIndex((x) => x.id === m.id);
      if (i > -1) state.memories[i] = updated;
      await store.put(updated);
      closeCompose();
      renderFeed();
      openViewer(m.id);
      toast('Caption updated');
    } else {
      const m = {
        id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)),
        createdAt: d.createdAt, updatedAt: now, deleted: false,
        type: d.type, mime: d.mime, caption, captionSource: caption ? source : 'typed',
        width: d.width || 0, height: d.height || 0,
        ...(d.durationSec ? { durationSec: d.durationSec } : {}),
        syncState: 'local',
      };
      // Optimistic: show in the feed straight away.
      state.memories.unshift(m);
      state.memories.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      urls.set(m.id, d.previewURL); d.previewURL = null;
      if (d.thumb) urls.set(m.id + ':t', URL.createObjectURL(d.thumb));
      const blob = d.blob, thumb = d.thumb;
      closeCompose();
      $('#feed').scrollTo({ top: 0 });
      show('feed');
      renderFeed();
      haptic(10);
      try { await store.put(m, { blob, thumb }); toast('Saved'); maybeAskPersist(); }
      catch (err) {
        state.memories = state.memories.filter((x) => x.id !== m.id);
        renderFeed();
        toast(err && err.name === 'QuotaExceededError' ? 'Phone storage is full. Export a backup and free space.' : "Couldn't save that moment.");
      }
    }
  } finally {
    $('#compose-save').disabled = false;
  }
};

$('#compose-cancel').onclick = () => {
  const d = state.draft;
  if (d && d.editingId) { const id = d.editingId; closeCompose(); openViewer(id); return; }
  const dirty = $('#caption').value.trim().length > 0;
  if (dirty && !confirm('Discard this moment?')) return;
  closeCompose();
  openCamera();
};

/* =========================================================
   VIEWER
   ========================================================= */
async function openViewer(id) {
  const list = visibleMemories();
  state.viewerIndex = list.findIndex((m) => m.id === id);
  if (state.viewerIndex < 0) return;
  show('viewer');
  await paintViewer(0);
}
async function paintViewer(dir) {
  const list = visibleMemories();
  const m = list[state.viewerIndex];
  if (!m) return show('feed');
  const stage = $('#viewer-stage');
  const old = stage.firstElementChild;
  if (old && old.tagName === 'VIDEO') old.pause();
  let el;
  if (m.type === 'video') {
    el = document.createElement('video');
    el.playsInline = true; el.setAttribute('playsinline', ''); el.controls = true; el.autoplay = true; el.loop = true;
    el.poster = await mediaURL(m.id, true);
  } else {
    el = document.createElement('img'); el.alt = m.caption || 'Moment';
  }
  el.src = await mediaURL(m.id, false);
  if (dir) { el.style.opacity = 0; el.style.transform = `translateX(${dir * 40}px)`; }
  stage.innerHTML = '';
  stage.appendChild(el);
  if (dir) requestAnimationFrame(() => { el.style.opacity = 1; el.style.transform = 'none'; });
  if (m.type === 'video') el.play().catch(() => {});
  $('#viewer-when').textContent = fullLabel(new Date(m.createdAt));
  const cap = $('#viewer-caption');
  cap.textContent = m.caption;
  cap.hidden = !m.caption;
  $('#viewer-menu').hidden = true;
}
function step(dir) {
  const n = visibleMemories().length;
  const next = state.viewerIndex + dir;
  if (next < 0 || next >= n) { haptic(5); return; }
  state.viewerIndex = next;
  paintViewer(dir);
}
(() => {
  const stage = $('#viewer-stage');
  let x0 = null, y0 = null, t0 = 0;
  stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) step(dx < 0 ? 1 : -1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx) && Date.now() - t0 < 600) show('feed'); // swipe down to close
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (!$('#viewer').classList.contains('active')) return;
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'Escape') show('feed');
  });
})();
$('#viewer-close').onclick = () => show('feed');
$('#viewer-more').onclick = (e) => { e.stopPropagation(); $('#viewer-menu').hidden = !$('#viewer-menu').hidden; };
$('#viewer').addEventListener('click', (e) => { if (!e.target.closest('#viewer-menu, #viewer-more')) $('#viewer-menu').hidden = true; });
$('#viewer-edit').onclick = () => {
  const m = visibleMemories()[state.viewerIndex];
  if (!m) return;
  openCompose({ editingId: m.id, type: m.type, caption: m.caption, createdAt: m.createdAt });
};
$('#viewer-save-file').onclick = async () => {
  const m = visibleMemories()[state.viewerIndex];
  if (!m) return;
  const blob = await store.getMedia(m.id);
  const name = `moment-${m.createdAt.slice(0, 10)}.${extFor(m.mime)}`;
  const file = new File([blob], name, { type: m.mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name);
};
$('#viewer-delete').onclick = async () => {
  const list = visibleMemories();
  const m = list[state.viewerIndex];
  if (!m) return;
  haptic(20);
  // Hide immediately; commit after the undo window.
  if (state.pendingDelete) await commitDelete();
  state.pendingDelete = { memory: m, timer: setTimeout(commitDelete, 5200) };
  state.memories = state.memories.filter((x) => x.id !== m.id);
  renderFeed();
  const remaining = visibleMemories();
  if (remaining.length) { state.viewerIndex = Math.min(state.viewerIndex, remaining.length - 1); paintViewer(0); }
  else show('feed');
  toast('Moment deleted', { label: 'Undo', fn: undoDelete });
};
async function commitDelete() {
  const p = state.pendingDelete;
  if (!p) return;
  clearTimeout(p.timer);
  state.pendingDelete = null;
  dropURLs(p.memory.id);
  await store.remove(p.memory.id);
}
function undoDelete() {
  const p = state.pendingDelete;
  if (!p) return;
  clearTimeout(p.timer);
  state.pendingDelete = null;
  state.memories.push(p.memory);
  state.memories.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  renderFeed();
  if ($('#viewer').classList.contains('active')) openViewer(p.memory.id);
}
window.addEventListener('pagehide', () => { if (state.pendingDelete) commitDelete(); });

/* =========================================================
   ZIP (store-only, no compression; enough for our own backups)
   ========================================================= */
const zip = (() => {
  const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  const enc = new TextEncoder();
  function dosTime(d) {
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  }
  async function build(files, onProgress) {
    const parts = [], central = [];
    let offset = 0;
    const { time, date } = dosTime(new Date());
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const data = f.data instanceof Blob ? new Uint8Array(await f.data.arrayBuffer()) : enc.encode(f.data);
      const name = enc.encode(f.name);
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + data.length;
      onProgress && onProgress(i + 1, files.length);
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }
  async function read(blob) {
    const tailLen = Math.min(blob.size, 65557);
    const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a zip file');
    const count = tail.getUint16(eocd + 10, true);
    const cdSize = tail.getUint32(eocd + 12, true);
    const cdOff = tail.getUint32(eocd + 16, true);
    const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    const out = new Map();
    let p = 0;
    for (let i = 0; i < count; i++) {
      const method = cd.getUint16(p + 10, true);
      const csize = cd.getUint32(p + 20, true);
      const nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
      const lho = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nlen));
      p += 46 + nlen + xlen + clen;
      if (method !== 0) continue; // only our own uncompressed backups
      const lh = new DataView(await blob.slice(lho, lho + 30).arrayBuffer());
      const start = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      out.set(name, blob.slice(start, start + csize));
    }
    return out;
  }
  return { build, read };
})();

function extFor(mime) {
  if (!mime) return 'bin';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime')) return 'mov';
  return mime.split('/')[1] || 'bin';
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function exportBackup() {
  const all = await store.list();
  if (!all.length) return toast('Nothing to back up yet.');
  toast('Preparing backup…');
  const files = [{ name: 'memories.json', data: JSON.stringify({ app: 'moments', version: 1, exportedAt: new Date().toISOString(), memories: all }, null, 2) }];
  for (const m of all) {
    const b = await store.getMedia(m.id); if (b) files.push({ name: `media/${m.id}.${extFor(m.mime)}`, data: b });
    const t = await store.getMedia(m.id, true); if (t) files.push({ name: `media/${m.id}_thumb.jpg`, data: t });
  }
  const blob = await zip.build(files);
  const name = `moments-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  const file = new File([blob], name, { type: 'application/zip' });
  if (/iPhone|iPad|Android/i.test(navigator.userAgent) && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); toast(`Backup ready: ${all.length} moments`); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name);
  toast(`Backup saved: ${all.length} moments`);
}

async function importBackup(file) {
  try {
    const entries = await zip.read(file);
    const json = entries.get('memories.json');
    if (!json) throw new Error('No memories.json');
    const data = JSON.parse(await json.text());
    if (data.app !== 'moments' || !Array.isArray(data.memories)) throw new Error('Not a Moments backup');
    const existing = new Map((await store.list({ includeDeleted: true })).map((m) => [m.id, m]));
    let added = 0, updated = 0;
    for (const m of data.memories) {
      const cur = existing.get(m.id);
      if (cur && cur.updatedAt >= m.updatedAt) continue;
      const blob = entries.get(`media/${m.id}.${extFor(m.mime)}`);
      if (!blob && !m.deleted) continue;
      const thumb = entries.get(`media/${m.id}_thumb.jpg`);
      await store.put({ ...m, syncState: 'local' }, {
        blob: blob ? new Blob([blob], { type: m.mime }) : null,
        thumb: thumb ? new Blob([thumb], { type: 'image/jpeg' }) : null,
      });
      cur ? updated++ : added++;
    }
    await reload();
    toast(added || updated ? `Imported ${added} new${updated ? `, ${updated} updated` : ''}` : 'Everything was already here.');
  } catch (e) {
    toast("That file isn't a Moments backup.");
  }
}

/* =========================================================
   SETTINGS
   ========================================================= */
const fmtBytes = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? Math.round(b / 1e6) + ' MB' : Math.round(b / 1e3) + ' KB';
async function openSheet() {
  $('#scrim').hidden = false; $('#sheet').hidden = false;
  $('#opt-camfirst').checked = localStorage.getItem('moments.camFirst') !== '0';
  if (navigator.storage && navigator.storage.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    $('#storage-line').textContent = `${state.memories.length} moments · ${fmtBytes(usage)} used of ${fmtBytes(quota)}`;
    $('#storage-meter').style.width = quota ? Math.max(1, (usage / quota) * 100) + '%' : '0';
  } else $('#storage-line').textContent = `${state.memories.length} moments`;
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  $('#persist-btn').hidden = persisted || !(navigator.storage && navigator.storage.persist);
  $('#persist-line').textContent = persisted ? 'On. The browser won’t clear them to save space.' : 'Ask the browser not to clear them.';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  $('#install-row').hidden = standalone || !(installPrompt || ios);
  if (ios) { $('#install-line').textContent = 'Tap Share, then "Add to Home Screen".'; $('#install-btn').hidden = true; }
}
function closeSheet() { $('#scrim').hidden = true; $('#sheet').hidden = true; }

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
$('#install-btn').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null; $('#install-row').hidden = true;
};
async function maybeAskPersist() {
  if (state.memories.length === 3 && navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (_) {}
  }
}
$('#persist-btn').onclick = async () => {
  const ok = await navigator.storage.persist();
  toast(ok ? 'Your moments are protected.' : 'The browser said no. Installing the app usually helps.');
  openSheet();
};
$('#export-btn').onclick = () => { closeSheet(); exportBackup(); };
$('#import-btn').onclick = () => $('#file-import').click();
$('#file-import').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { closeSheet(); importBackup(f); } };
$('#opt-camfirst').onchange = (e) => localStorage.setItem('moments.camFirst', e.target.checked ? '1' : '0');
$('#clear-btn').onclick = async () => {
  if (!confirm('Delete every moment on this phone? Export a backup first if you want to keep them.')) return;
  await store.clearAll();
  for (const k of [...urls.keys()]) { URL.revokeObjectURL(urls.get(k)); }
  urls.clear();
  closeSheet();
  await reload();
  toast('All moments deleted');
};
$('#scrim').onclick = closeSheet;
(() => { // swipe the sheet down to close
  const s = $('#sheet'); let y0 = null;
  s.addEventListener('touchstart', (e) => { if (s.scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
  s.addEventListener('touchend', (e) => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 80) closeSheet(); y0 = null; }, { passive: true });
})();

/* =========================================================
   FEED CONTROLS
   ========================================================= */
$('#fab').onclick = () => { haptic(); openCamera(); };
$('#btn-view').onclick = () => {
  state.view = state.view === 'grid' ? 'feed' : 'grid';
  localStorage.setItem('moments.view', state.view);
  renderFeed();
};
$('#btn-settings').onclick = openSheet;
$('#btn-search').onclick = () => {
  $('#searchbar').hidden = false; document.body.classList.add('searching');
  $('#q').focus();
};
$('#search-cancel').onclick = () => {
  $('#searchbar').hidden = true; document.body.classList.remove('searching');
  $('#q').value = ''; state.query = ''; renderFeed();
};
let qTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.query = e.target.value; renderFeed(); }, 120);
});
for (const id of ['#file-pick', '#file-capture']) {
  $(id).onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; fileToDraft(f); };
}
// Hardware/browser back button returns to the feed instead of leaving the app.
history.replaceState({ s: 'feed' }, '');
const _show = show;
show = function (name) { // eslint-disable-line no-func-assign
  const onFeedEntry = history.state && history.state.s === 'feed';
  if (name !== 'feed' && onFeedEntry) history.pushState({ s: name }, '');
  if (name === 'feed' && !onFeedEntry) history.back(); // keep one history entry per trip away from the feed
  _show(name);
};
window.addEventListener('popstate', () => {
  if (!$('#sheet').hidden) { closeSheet(); history.pushState({ s: 'feed' }, ''); return; }
  if (state.draft && !state.draft.editingId) closeCompose();
  _show('feed');
});

/* =========================================================
   BOOT
   ========================================================= */
(async function boot() {
  try { await reload(); } catch (e) { toast('Storage is unavailable in this browser mode.'); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Fast path: open straight to camera if allowed before and the user wants it.
  const wantCam = localStorage.getItem('moments.camFirst') !== '0' && localStorage.getItem('moments.camOK') === '1';
  if (wantCam && navigator.permissions && navigator.permissions.query) {
    try {
      const p = await navigator.permissions.query({ name: 'camera' });
      if (p.state === 'granted') openCamera();
    } catch (_) {}
  }
})();
