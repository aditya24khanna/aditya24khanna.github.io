/* Moments — a private photo/video memory log. No backend; IndexedDB only. */
'use strict';

// Set after the reminder worker is deployed (see moments-push/README.md). Empty = reminders hidden.
const CONFIG = { pushURL: 'https://moments-push.aditya24khanna.workers.dev' };

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
    // media: { blob, thumb, parts: [{blob, thumb}], voice: Blob | null (null = delete) }
    async put(memory, media) {
      return tx(['memories', 'media'], 'readwrite', (t) => {
        t.objectStore('memories').put(memory);
        const ms = t.objectStore('media');
        if (!media) return;
        if (media.blob) ms.put(media.blob, memory.id);
        if (media.thumb) ms.put(media.thumb, memory.id + ':thumb');
        (media.parts || []).forEach((pt, k) => {
          if (pt.blob) ms.put(pt.blob, `${memory.id}#${k + 1}`);
          if (pt.thumb) ms.put(pt.thumb, `${memory.id}#${k + 1}:thumb`);
        });
        if (media.voice) ms.put(media.voice, memory.id + ':voice');
        else if (media.voice === null) ms.delete(memory.id + ':voice');
      });
    },
    getMedia: (id, thumb = false) => tx(['media'], 'readonly', (t) => req(t.objectStore('media').get(thumb ? id + ':thumb' : id))),
    // Soft delete keeps a tombstone for future sync; media is freed immediately.
    async remove(id, { hard = false } = {}) {
      return tx(['memories', 'media'], 'readwrite', async (t) => {
        const ms = t.objectStore('memories');
        const m = await req(ms.get(id));
        if (hard) ms.delete(id);
        else if (m) ms.put({ ...m, deleted: true, caption: '', tags: [], mood: '', voice: undefined, updatedAt: new Date().toISOString(), syncState: 'local' });
        const md = t.objectStore('media');
        md.delete(id); md.delete(id + ':thumb'); md.delete(id + ':voice');
        const n = m && m.parts ? m.parts.length : 0;
        for (let k = 1; k <= n; k++) { md.delete(`${id}#${k}`); md.delete(`${id}#${k}:thumb`); }
      });
    },
    // Drafts: shots at __draft#k (+ :thumb), voice at __draft:voice. Old single-shot drafts used __draft.
    saveDraft: (shots, voice) => tx(['media'], 'readwrite', (t) => {
      const ms = t.objectStore('media');
      ms.delete(IDBKeyRange.bound('__draft', '__draft\uffff'));
      shots.forEach((sh, k) => {
        if (sh.blob) ms.put(sh.blob, `__draft#${k}`);
        if (sh.thumb) ms.put(sh.thumb, `__draft#${k}:thumb`);
      });
      if (voice && voice.blob) ms.put(voice.blob, '__draft:voice');
    }),
    async getDraft(n) {
      return tx(['media'], 'readonly', async (t) => {
        const ms = t.objectStore('media');
        if (n == null) return { shots: [{ blob: await req(ms.get('__draft')), thumb: await req(ms.get('__draft:thumb')) }], voice: null };
        const shots = [];
        for (let k = 0; k < n; k++) shots.push({ blob: await req(ms.get(`__draft#${k}`)), thumb: await req(ms.get(`__draft#${k}:thumb`)) });
        return { shots, voice: await req(ms.get('__draft:voice')) };
      });
    },
    clearDraft: () => tx(['media'], 'readwrite', (t) => { t.objectStore('media').delete(IDBKeyRange.bound('__draft', '__draft\uffff')); }),
    async clearAll() {
      return tx(['memories', 'media'], 'readwrite', (t) => { t.objectStore('memories').clear(); t.objectStore('media').clear(); });
    },
  };
})();

const MAX_SHOTS = 10;
const partKey = (m, p) => (p ? `${m.id}#${p}` : m.id);
const partCount = (m) => 1 + ((m && m.parts && m.parts.length) || 0);
const partInfo = (m, p) => (p ? m.parts[p - 1] : m);
const shotMeta = ({ blob, thumb, previewURL, thumbURL, ...meta }) => meta;
const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

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
  for (const k of [...urls.keys()]) {
    if (k === id || k.startsWith(id + ':') || k.startsWith(id + '#')) { URL.revokeObjectURL(urls.get(k)); urls.delete(k); }
  }
}

/* =========================================================
   METRICS — counted on this phone; anonymous events only if opted in.
   Never sends photos, videos or captions.
   ========================================================= */
const metrics = (() => {
  const KEY = 'moments.stats';
  let s;
  try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { s = {}; }
  if (!s.firstUse) s.firstUse = new Date().toISOString();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {} };
  save();
  function isoWeek(d = new Date()) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return t.getUTCFullYear() + '-W' + Math.ceil(((t - y0) / 864e5 + 1) / 7);
  }
  function mark(kind) {
    const w = isoWeek();
    s.weeks = s.weeks || {};
    s.weeks[w] = s.weeks[w] || { c: 0, r: 0 };
    s.weeks[w][kind]++;
  }
  const bump = (k) => { s[k] = (s[k] || 0) + 1; };
  const optedIn = () => localStorage.getItem('moments.metrics') === '1';
  function event(name) {
    if (!optedIn()) return;
    const gc = window.goatcounter;
    if (gc && gc.count) { try { gc.count({ path: 'moments/e/' + name, title: name, event: true }); } catch (_) {} }
  }
  const median = (a) => { if (!a || !a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  return {
    saved(m, secs) {
      bump('saves');
      if (m.type === 'video') bump('videos');
      if (m.caption) bump('captioned');
      const voiced = m.caption && (m.captionSource === 'voice' || m.captionSource === 'mixed');
      if (voiced) bump('voice');
      if (secs && secs < 600) { s.tts = (s.tts || []).slice(-29); s.tts.push(Math.round(secs * 10) / 10); }
      mark('c'); save();
      event('moment_saved');
      if (m.type === 'video') event('video_saved');
      if (voiced) event('voice_caption');
      if (secs && secs < 600) event(secs < 6 ? 'save_under_6s' : 'save_over_6s');
    },
    relived() { bump('relives'); mark('r'); save(); event('relive_opened'); },
    event, optedIn,
    setOptIn(v) { localStorage.setItem('moments.metrics', v ? '1' : '0'); if (v) event('metrics_on'); },
    summary() {
      const weeks = Object.values(s.weeks || {});
      return {
        saves: s.saves || 0, relives: s.relives || 0, voice: s.voice || 0,
        captionRate: s.saves ? Math.round(((s.captioned || 0) / s.saves) * 100) : null,
        medianSave: median(s.tts),
        rememberWeeks: weeks.filter((w) => w.c > 0 && w.r > 0).length,
        activeWeeks: weeks.filter((w) => w.c > 0).length,
      };
    },
  };
})();

/* =========================================================
   NAV
   ========================================================= */
const screens = ['feed', 'camera', 'compose', 'viewer', 'story'];
function show(name) {
  for (const s of screens) {
    const el = $('#' + s);
    el.classList.toggle('active', s === name);
    el.inert = s !== name; // hidden screens are out of reach for taps, keyboard and screen readers
    if (s === name) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', 'true');
  }
  $('#tabbar').inert = name !== 'feed';
  document.body.classList.toggle('on-feed', name === 'feed');
  if (name !== 'story' && typeof player !== 'undefined') player.halt();
  if (name !== 'camera') camera.stop();
  if (name !== 'compose') speech.stop();
  if (name !== 'viewer') { const v = $('#viewer-stage video'); if (v) v.pause(); $('#viewer-menu').hidden = true; }
  if (name !== 'viewer' && name !== 'compose' && typeof voicePlayer !== 'undefined') voicePlayer.stop();
  if (name === 'feed') feedVideos.resume(); else feedVideos.pauseAll();
}
function haptic(ms = 12) { if (navigator.vibrate) try { navigator.vibrate(ms); } catch (_) {} }

let toastTimer;
function toast(msg, action, ms) {
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
  toastTimer = setTimeout(() => t.classList.remove('show'), ms || (action ? 5000 : 2400));
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
const ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';
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
  const said = (m.captionSource === 'voice' || m.captionSource === 'mixed') && !m.voice;
  const n = partCount(m);
  const slides = n > 1
    ? `<div class="slides" tabindex="0" role="group" aria-label="${n} photos and videos, swipe to see more">${Array.from({ length: n }, (_, p) => `<div class="slide" data-p="${p}"><img alt="" decoding="async"></div>`).join('')}</div>
       <div class="dots">${Array.from({ length: n }, (_, p) => `<i class="${p ? '' : 'on'}"></i>`).join('')}</div>
       <span class="badge">1/${n}</span>`
    : `<img alt="" decoding="async">${m.type === 'video' ? `<span class="badge">${ICON_PLAY}${m.durationSec ? fmtDur(m.durationSec) : ''}</span>` : ''}`;
  const tags = (m.tags || []).length ? `<div class="card-tags">${m.tags.map((t) => '#' + escapeHTML(t)).join(' ')}</div>` : '';
  el.innerHTML = `
    <div class="card-media" style="--ar:${ar}">${slides}</div>
    <div class="card-body">
      <p class="card-caption ${m.caption ? '' : 'none'}">${m.caption ? highlight(m.caption, state.query.trim()) : 'No caption'}</p>
      ${tags}
      <div class="card-time">${timeLabel(d)}${m.mood ? `<span class="mood">${m.mood}</span>` : ''}${m.voice ? `<span class="vp">${ICON_MIC}${fmtSecs(m.voice.durationSec || 0)}</span>` : ''}${said ? `<span class="voice">· ${ICON_MIC}said</span>` : ''}${m.favorite ? `<span class="fav">${ICON_HEART}</span>` : ''}</div>
    </div>`;
  if (n > 1) {
    const sl = el.querySelector('.slides');
    sl.addEventListener('scroll', () => {
      const p = Math.round(sl.scrollLeft / sl.clientWidth);
      el.querySelectorAll('.dots i').forEach((dot, k) => dot.classList.toggle('on', k === p));
      el.querySelector('.badge').textContent = `${p + 1}/${n}`;
    }, { passive: true });
  }
  el.addEventListener('click', () => {
    const sl = el.querySelector('.slides');
    openViewer(m.id, undefined, sl ? Math.round(sl.scrollLeft / sl.clientWidth) : 0);
  });
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
    img.src = await mediaURL(id, true); // thumbnail first: fast and light
    e.target.querySelectorAll('.slide').forEach((sl) => {
      const p = Number(sl.dataset.p);
      if (p) mediaURL(partKey(m, p), true).then((u) => { sl.querySelector('img').src = u; });
    });
    if (state.view === 'feed') {
      if (m.type === 'video') feedVideos.observe(e.target);
      else upgrade.observe(e.target);
      far.observe(e.target);
    }
  }
}, { rootMargin: '600px 0px' });

// Swap in the full photo once a card is actually on screen.
const upgrade = new IntersectionObserver(async (entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    upgrade.unobserve(e.target);
    const id = e.target.dataset.id;
    const src = await mediaURL(id, false);
    const pre = new Image();
    pre.onload = () => { const img = e.target.querySelector('img'); if (img) { img.src = src; e.target.dataset.full = '1'; } };
    pre.src = src;
  }
}, { threshold: 0.35 });

// Release full-size media for cards far off screen, so memory stays flat on long feeds.
const far = new IntersectionObserver(async (entries) => {
  for (const e of entries) {
    if (e.isIntersecting) continue;
    const card = e.target, id = card.dataset.id;
    const v = card.querySelector('video');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
    if (card.dataset.full || v) {
      delete card.dataset.full;
      const img = card.querySelector('img');
      if (img) img.src = await mediaURL(id, true);
      if (state.viewerId !== id && urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
      const m = state.memories.find((x) => x.id === id);
      if (m && m.type !== 'video') upgrade.observe(card);
    }
  }
}, { rootMargin: '2500px 0px' });

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
      const holder = card.querySelector('.slide') || card.querySelector('.card-media');
      holder.insertBefore(v, holder.querySelector('.badge'));
    }
    v.play().catch(() => {});
    playing.add(card);
  }
  function stop(card) { const v = card.querySelector('video'); if (v) v.pause(); playing.delete(card); }
  return {
    observe: (c) => io.observe(c),
    pauseAll: () => { for (const c of [...playing]) stop(c); },
    resume: () => { io.takeRecords(); for (const c of document.querySelectorAll('.card video')) { const card = c.closest('.card'); io.unobserve(card); io.observe(card); } },
    reset: () => { io.disconnect(); playing.clear(); upgrade.disconnect(); far.disconnect(); },
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
  renderRail();
  updateRing();
  if (state.tab === 'calendar') renderCalendar();
  if (state.tab === 'search') renderSearch();
  if (state.tab === 'collections') renderAlbums();
  updateBanner();
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
async function filesToShots(files) {
  const list = [...files].slice(0, MAX_SHOTS);
  if (!list.length) return;
  const shots = [];
  for (const f of list) {
    try { shots.push(f.type.startsWith('video') ? await videoFileToDraft(f) : await imageFileToDraft(f)); } catch (_) {}
  }
  if (!shots.length) { toast("Couldn't open that file."); return; }
  if (state.adding && state.draft) { shots.forEach((sh) => deliverCapture(sh)); return; }
  openCompose({ ...shots[0], shots });
}
// Every capture lands here: a new moment, or one more shot for the moment being composed.
function deliverCapture(shot) {
  if (state.adding && state.draft) {
    const d = state.draft;
    if (d.shots.length >= MAX_SHOTS) { toast(`Up to ${MAX_SHOTS} per moment`); }
    else { d.shots.push(shot); state.composePart = d.shots.length - 1; }
    state.adding = false;
    persistDraft();
    renderComposeMedia();
    show('compose');
    return;
  }
  openCompose(shot);
}
function closeCamera() {
  if (state.adding && state.draft) { state.adding = false; show('compose'); return; }
  show('feed');
}

/* =========================================================
   CAMERA
   ========================================================= */
const camera = (() => {
  let stream = null, facing = 'environment', recorder = null, chunks = [], recStart = 0, recTimer = null, holdTimer = null;
  let pressed = false, recThumb = null, locked = false, downY = 0;
  let track = null, caps = {}, zoom = 1, torchOn = false;
  let rec2 = null; // canvas pipeline for recording with digital zoom
  const DIGITAL_MAX = 4;
  const digital = () => !caps.zoom; // no hardware zoom: crop in software instead
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
    try { await vf.play(); } catch (_) {}
    setupTrack();
  }
  function setupTrack() {
    track = stream && stream.getVideoTracks()[0];
    caps = (track && track.getCapabilities) ? track.getCapabilities() : {};
    zoom = (track && track.getSettings && track.getSettings().zoom) || 1;
    if (digital()) zoom = 1;
    applyPreview();
    torchOn = false;
    const tb = $('#cam-torch');
    tb.hidden = !caps.torch;
    tb.setAttribute('aria-pressed', 'false');
    $('#cam-spacer').hidden = !!caps.torch;
    $('#cam-hint').textContent = 'Tap for photo \u00b7 hold for video \u00b7 pinch to zoom';
  }
  // Preview transform: mirror for the front camera, plus scale when zoom is digital.
  function applyPreview() {
    const sc = digital() ? zoom : 1;
    vf.classList.remove('mirror');
    vf.style.transform = `${facing === 'user' ? 'scaleX(-1) ' : ''}scale(${sc})`;
  }
  async function setZoom(z) {
    if (!track) return;
    const lo = caps.zoom ? caps.zoom.min : 1, hi = caps.zoom ? caps.zoom.max : DIGITAL_MAX;
    z = Math.min(hi, Math.max(lo, z));
    zoom = z;
    const zl = $('#zoom-label');
    zl.hidden = false; zl.textContent = (Math.round(z * 10) / 10) + '\u00d7';
    clearTimeout(setZoom.t); setZoom.t = setTimeout(() => { zl.hidden = true; }, 900);
    if (digital()) { applyPreview(); return; }
    try { await track.applyConstraints({ advanced: [{ zoom: z }] }); } catch (_) {}
  }
  async function focusAt(x, y, px, py) {
    const r = $('#focus-ring');
    r.style.left = px + 'px'; r.style.top = py + 'px';
    r.classList.remove('go'); void r.offsetWidth; r.classList.add('go');
    if (!track) return;
    const modes = caps.focusMode || [];
    const c = {};
    if (modes.includes('single-shot')) c.focusMode = 'single-shot';
    else if (modes.includes('manual')) c.focusMode = 'manual';
    c.pointsOfInterest = [{ x: facing === 'user' ? 1 - x : x, y }];
    try { await track.applyConstraints({ advanced: [c] }); } catch (_) {}
    if (modes.includes('continuous')) setTimeout(() => { track && track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); }, 3000);
  }
  function fallback(msg) {
    $('#cam-fallback-msg').textContent = msg;
    $('#cam-fallback').hidden = false;
  }
  function stop() {
    if (recorder && recorder.state === 'recording') { recorder.onstop = null; recorder.stop(); }
    recorder = null; resetRecUI();
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    stopRec2();
    track = null; caps = {}; torchOn = false; zoom = 1;
    vf.style.transform = '';
    vf.srcObject = null;
  }
  // Crop of the sensor frame that matches what the preview shows at the current zoom.
  function cropRect() {
    const vw = vf.videoWidth, vh = vf.videoHeight;
    const z = digital() ? zoom : 1;
    const cw = vw / z, ch = vh / z;
    return { sx: (vw - cw) / 2, sy: (vh - ch) / 2, cw, ch };
  }
  async function frameCanvas(max) {
    const { sx, sy, cw, ch } = cropRect();
    const [w, h] = fit(cw, ch, max);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (facing === 'user') { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(vf, sx, sy, cw, ch, 0, 0, w, h);
    return c;
  }
  // When zoom is digital, record from a canvas that draws the cropped frame.
  function zoomedStream() {
    const { cw, ch } = cropRect();
    const [w, h] = fit(cw, ch, 1280);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const mirror = facing === 'user';
    let raf;
    const draw = () => {
      const r = cropRect(); // follows pinch changes during recording
      ctx.save();
      if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
      ctx.drawImage(vf, r.sx, r.sy, r.cw, r.ch, 0, 0, w, h);
      ctx.restore();
      raf = requestAnimationFrame(draw);
    };
    draw();
    const out = c.captureStream(30);
    stream.getAudioTracks().forEach((t) => out.addTrack(t));
    rec2 = { stop: () => { cancelAnimationFrame(raf); out.getVideoTracks().forEach((t) => t.stop()); }, w, h };
    return out;
  }
  function stopRec2() { if (rec2) { rec2.stop(); rec2 = null; } }
  async function takePhoto() {
    if (!stream || !vf.videoWidth) return;
    haptic(15);
    const f = $('#cam-flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    const big = await frameCanvas(MAX_PHOTO_EDGE);
    const small = await frameCanvas(THUMB_EDGE);
    deliverCapture({
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
    const src = digital() && zoom > 1.05 && HTMLCanvasElement.prototype.captureStream ? zoomedStream() : stream;
    try { recorder = new MediaRecorder(src, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined); }
    catch (_) { recorder = new MediaRecorder(src); }
    recorder.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    recorder.onstop = finishRec;
    recorder.start(250);
    recStart = performance.now();
    $('#shutter').classList.add('recording');
    $('#rec-badge').hidden = false;
    $('#lock-text').textContent = 'Slide up to lock';
    $('#lock-hint').hidden = !pressed;
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
    locked = false;
    $('#lock-hint').hidden = true;
    $('#lock-hint').classList.remove('locked');
    $('#shutter').classList.remove('recording');
    $('#rec-badge').hidden = true;
    $('#cam-hint').style.opacity = '';
    ring.style.strokeDashoffset = RING;
  }
  function finishRec() {
    const dur = (performance.now() - recStart) / 1000;
    const type = (recorder && recorder.mimeType) || chunks[0]?.type || 'video/webm';
    const dims = rec2 ? { width: rec2.w, height: rec2.h } : { width: vf.videoWidth, height: vf.videoHeight };
    stopRec2();
    resetRecUI();
    haptic(15);
    if (dur < 0.6) { toast('Hold a little longer for video.'); return; }
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    deliverCapture({
      type: 'video', mime: blob.type, blob, thumb: recThumb,
      ...dims, durationSec: Math.round(dur),
      createdAt: new Date(Date.now() - dur * 1000).toISOString(),
    });
  }

  // Shutter: tap = photo, hold = video (Instagram/Snap pattern).
  const sh = $('#shutter');
  sh.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (locked && recorder && recorder.state === 'recording') { stopRec(); return; } // tap to stop a locked recording
    pressed = true;
    downY = e.clientY;
    try { sh.setPointerCapture(e.pointerId); } catch (_) {}
    holdTimer = setTimeout(() => { if (pressed) startRec(); }, HOLD_MS);
  });
  // Slide up while recording to lock: let go and it keeps recording.
  sh.addEventListener('pointermove', (e) => {
    if (!pressed || locked || !recorder || recorder.state !== 'recording') return;
    if (e.clientY - downY < -70) {
      locked = true;
      haptic(20);
      $('#lock-hint').classList.add('locked');
      $('#lock-text').textContent = 'Locked \u00b7 tap to stop';
      metrics.event('video_locked');
    }
  });
  const release = () => {
    if (!pressed) return;
    pressed = false;
    clearTimeout(holdTimer);
    if (locked) return;
    if (recorder && recorder.state === 'recording') stopRec();
    else takePhoto();
  };
  sh.addEventListener('pointerup', release);
  sh.addEventListener('pointercancel', () => { pressed = false; clearTimeout(holdTimer); if (!locked) stopRec(); });
  sh.addEventListener('contextmenu', (e) => e.preventDefault());
  // Keyboard: space/enter = photo
  sh.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); takePhoto(); } });

  const flip = () => { facing = facing === 'user' ? 'environment' : 'user'; haptic(); start(); };
  $('#cam-flip').onclick = flip;
  $('#cam-torch').onclick = async () => {
    if (!track || !caps.torch) return;
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (_) { torchOn = false; }
    $('#cam-torch').setAttribute('aria-pressed', String(torchOn));
    haptic();
  };

  // Viewfinder gestures: tap = focus, double-tap = flip, pinch = zoom, swipe left = back to feed.
  const cam = $('#camera');
  let t0 = null, pinch = null, lastTap = 0, tapTimer = null;
  const isControl = (el) => el.closest('button, .cam-controls, .cam-fallback');
  cam.addEventListener('touchstart', (e) => {
    if (isControl(e.target)) return;
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: zoom };
      t0 = null;
    } else if (e.touches.length === 1) {
      t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    }
  }, { passive: true });
  // Stop the browser zooming the whole page (which pushes the shutter off screen).
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => cam.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  cam.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  cam.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      setZoom(pinch.z * (d / pinch.d));
    }
  }, { passive: true });
  cam.addEventListener('touchend', (e) => {
    if (pinch) { if (e.touches.length < 2) pinch = null; return; }
    if (!t0 || isControl(e.target)) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - t0.x, dy = p.clientY - t0.y, dt = Date.now() - t0.t;
    t0 = null;
    if (dx < -70 && Math.abs(dy) < 60 && dt < 600) { closeCamera(); return; }
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12 || dt > 400) return;
    const now = Date.now();
    if (now - lastTap < 280) { clearTimeout(tapTimer); lastTap = 0; flip(); return; }
    lastTap = now;
    const rect = cam.getBoundingClientRect();
    tapTimer = setTimeout(() => focusAt(p.clientX / rect.width, p.clientY / rect.height, p.clientX, p.clientY), 280);
  }, { passive: true });
  // Mouse wheel zoom on desktop
  cam.addEventListener('wheel', (e) => { setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9)); }, { passive: true });
  $('#cam-close').onclick = () => closeCamera();
  $('#cam-gallery').onclick = () => $('#file-pick').click();
  $('#cam-fallback-gallery').onclick = () => $('#file-pick').click();
  $('#cam-native').onclick = () => $('#file-capture').click();

  return { start, stop };
})();

function openCamera() {
  if (!state.captureStart) state.captureStart = performance.now();
  show('camera'); camera.start();
}

/* =========================================================
   SPEECH (on-device / browser)
   ========================================================= */
const speech = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const ta = $('#caption');
  const btn = $('#mic');
  let rec = null, listening = false, base = '', finals = '';
  let aRec = null, aStream = null, aChunks = [], aStart = 0, aMime = '';
  const canRecord = () => !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && localStorage.getItem('moments.voiceConflict') !== '1';
  async function startAudio() {
    if (!canRecord()) return;
    try {
      aStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!listening) { aStream.getTracks().forEach((t) => t.stop()); aStream = null; return; }
      aMime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
      aRec = new MediaRecorder(aStream, aMime ? { mimeType: aMime, audioBitsPerSecond: 48000 } : undefined);
      aChunks = [];
      aRec.ondataavailable = (e) => e.data && e.data.size && aChunks.push(e.data);
      aRec.start(250);
      aStart = performance.now();
    } catch (_) { aRec = null; if (aStream) { aStream.getTracks().forEach((t) => t.stop()); aStream = null; } }
  }
  function stopAudio(deliver) {
    const r = aRec, st = aStream, dur = (performance.now() - aStart) / 1000;
    aRec = null; aStream = null;
    if (!r) return;
    r.onstop = () => {
      if (st) st.getTracks().forEach((t) => t.stop());
      if (!deliver || dur < 1) return;
      const type = (r.mimeType || aMime || 'audio/webm').split(';')[0];
      onVoiceRecorded({ blob: new Blob(aChunks, { type }), mime: type, durationSec: Math.round(dur) });
    };
    try { r.stop(); } catch (_) { if (st) st.getTracks().forEach((t) => t.stop()); }
  }
  let lang = localStorage.getItem('moments.lang') || 'en-IN';
  const langBtn = $('#lang');
  const setLangUI = () => { langBtn.textContent = lang === 'hi-IN' ? 'हि' : 'EN'; langBtn.setAttribute('aria-label', lang === 'hi-IN' ? 'Dictation language: Hindi' : 'Dictation language: English'); };
  setLangUI();
  if (!SR) { btn.hidden = true; langBtn.hidden = true; $('#mic-hint').hidden = false; }

  const label = (t) => { $('#mic-label').textContent = t; };
  function setUI(on) {
    listening = on;
    btn.setAttribute('aria-pressed', String(on));
    ta.classList.toggle('listening', on);
    if (!on) { label('Hold to talk'); btn.classList.remove('holding'); }
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
      ta.value = ((base ? base + ' ' : '') + (spoken ? spoken.charAt(0).toUpperCase() + spoken.slice(1) : '')).slice(0, 280);
      state.captionSource.voice = true;
      updateCount();
      saveDraftCaption();
    };
    rec.onerror = (e) => {
      // Some phones can't transcribe and record at once: drop the recording, keep the words.
      if (e.error === 'audio-capture' && aRec) {
        localStorage.setItem('moments.voiceConflict', '1');
        stopAudio(false);
        toast('This phone can\u2019t record and transcribe together. Keeping the words only.');
        setTimeout(start, 300);
        return;
      }
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Microphone access is off. You can type instead.');
      else if (e.error === 'network') toast('Dictation needs a connection on this browser.');
      else if (e.error !== 'no-speech' && e.error !== 'aborted') toast("Didn't catch that. Try again.");
    };
    rec.onend = () => { setUI(false); rec = null; stopAudio(true); };
    try { rec.start(); setUI(true); label('Listening\u2026'); haptic(); startAudio(); } catch (_) { setUI(false); }
  }
  function stop() { if (rec) { try { rec.stop(); } catch (_) {} } else stopAudio(true); setUI(false); }

  // Hold = talk while held (WhatsApp-style). Short tap = keep listening until tapped again.
  let pressT = 0;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (listening) { stop(); pressT = 0; haptic(); return; }
    try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    pressT = performance.now();
    btn.classList.add('holding');
    start();
  });
  const release = () => {
    btn.classList.remove('holding');
    if (!pressT) return;
    const held = performance.now() - pressT;
    pressT = 0;
    if (held > 450) { stop(); haptic(); }
    else if (listening) label('Listening · tap to stop');
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => { if (e.detail === 0) (listening ? stop() : start()); }); // keyboard
  langBtn.onclick = () => {
    lang = lang === 'en-IN' ? 'hi-IN' : 'en-IN';
    localStorage.setItem('moments.lang', lang);
    setLangUI();
    if (listening) { stop(); setTimeout(start, 250); }
  };
  return { stop, supported: !!SR, cancelAudio: () => stopAudio(false) };
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

const DRAFT_KEY = 'moments.draft';
const MOODS = ['😊', '😂', '😍', '🥹', '😌', '🤩', '😢', '😤'];
function draftMeta(d) {
  const { blob, thumb, previewURL, shots, voice, ...meta } = d;
  return {
    ...meta,
    shots: (shots || []).map(shotMeta),
    voiceMeta: voice && !voice.existing ? { mime: voice.mime, durationSec: voice.durationSec } : null,
  };
}
let draftCapTimer;
function writeDraftMeta() {
  const d = state.draft;
  if (!d || d.editingId) return;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draftMeta(d), caption: $('#caption').value, cs: state.captionSource })); } catch (_) {}
}
function saveDraftCaption() {
  clearTimeout(draftCapTimer);
  draftCapTimer = setTimeout(writeDraftMeta, 300);
}
// Media + metadata, after shots or the voice change.
function persistDraft() {
  const d = state.draft;
  if (!d || d.editingId) return;
  writeDraftMeta();
  store.saveDraft(d.shots, d.voice && !d.voice.existing ? d.voice : null).catch(() => {});
}

async function openCompose(draft) {
  if (!draft.editingId && !draft.shots) {
    const { blob, thumb, type, mime, width, height, durationSec, createdAt } = draft;
    draft.shots = [{ blob, thumb, type, mime, width, height, durationSec, createdAt }];
  }
  draft.tags = draft.tags || [];
  draft.collections = draft.collections || [];
  draft.mood = draft.mood || '';
  state.draft = draft;
  state.composePart = 0;
  state.captionSource = draft.cs || { typed: false, voice: false };
  $('#caption').value = draft.caption || '';
  $('#compose-save').textContent = draft.editingId ? 'Save changes' : 'Save moment';
  $('#compose-cancel').setAttribute('aria-label', draft.editingId ? 'Cancel editing' : 'Discard');
  $('#compose-when').textContent = fullLabel(new Date(draft.createdAt));
  $('#voice-ask').hidden = true;
  $('#mood-pop').hidden = true; $('#tag-entry').hidden = true;
  updateCount();
  await renderComposeMedia();
  renderMetaChips();
  show('compose');
  // Autosave the draft so a killed app or an accidental back never loses the moment.
  if (!draft.editingId && !draft.restored) persistDraft();
}

async function renderComposeMedia() {
  const d = state.draft;
  if (!d) return;
  const box = $('#compose-media');
  const old = box.querySelector('video'); if (old) old.pause();
  box.innerHTML = '';
  let src, type;
  if (d.editingId) {
    const m = state.memories.find((x) => x.id === d.editingId);
    const p = Math.min(state.composePart, partCount(m) - 1);
    src = await mediaURL(partKey(m, p), false);
    type = partInfo(m, p).type;
  } else {
    const sh = d.shots[Math.min(state.composePart, d.shots.length - 1)];
    sh.previewURL = sh.previewURL || URL.createObjectURL(sh.blob);
    src = sh.previewURL; type = sh.type;
  }
  if (type === 'video') {
    const v = document.createElement('video');
    v.src = src; v.playsInline = true; v.setAttribute('playsinline', ''); v.loop = true; v.muted = true; v.autoplay = true;
    v.onclick = () => { v.muted = !v.muted; };
    box.appendChild(v);
    v.play().catch(() => {});
  } else {
    const i = document.createElement('img'); i.src = src; i.alt = ''; box.appendChild(i);
  }
  // Shot strip: tap to preview, x to remove, + to add another shot.
  const strip = $('#compose-strip');
  strip.innerHTML = '';
  if (d.editingId) {
    const m = state.memories.find((x) => x.id === d.editingId);
    const n = partCount(m);
    if (n > 1) for (let p = 0; p < n; p++) {
      const b = document.createElement('button');
      b.className = 'shot' + (p === state.composePart ? ' sel' : '');
      b.innerHTML = '<img alt="">';
      mediaURL(partKey(m, p), true).then((u) => { b.querySelector('img').src = u; });
      b.onclick = () => { state.composePart = p; renderComposeMedia(); };
      strip.appendChild(b);
    }
    return;
  }
  d.shots.forEach((sh, k) => {
    const b = document.createElement('div');
    b.className = 'shot' + (k === state.composePart ? ' sel' : '');
    sh.thumbURL = sh.thumbURL || (sh.thumb ? URL.createObjectURL(sh.thumb) : (sh.previewURL || URL.createObjectURL(sh.blob)));
    b.innerHTML = `<img alt="">${sh.type === 'video' ? '<span class="vid">▶</span>' : ''}${d.shots.length > 1 && k === state.composePart ? '<button class="x" aria-label="Remove this shot">✕</button>' : ''}`;
    b.querySelector('img').src = sh.thumbURL;
    b.onclick = (e) => {
      if (e.target.closest('.x')) {
        const [gone] = d.shots.splice(k, 1);
        if (gone.previewURL) URL.revokeObjectURL(gone.previewURL);
        state.composePart = Math.max(0, Math.min(k, d.shots.length - 1));
        persistDraft(); renderComposeMedia(); return;
      }
      state.composePart = k; renderComposeMedia();
    };
    strip.appendChild(b);
  });
  if (d.shots.length < MAX_SHOTS) {
    const add = document.createElement('button');
    add.className = 'shot add';
    add.setAttribute('aria-label', 'Add another shot');
    add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    add.onclick = () => { speech.stop(); state.adding = true; openCamera(); };
    strip.appendChild(add);
  }
}

// Mood, tags, albums and the kept voice recording, shown as chips above the caption.
function renderMetaChips() {
  const d = state.draft;
  if (!d) return;
  const box = $('#meta-chips');
  const parts = [];
  if (d.voice) parts.push(`<span class="tagchip voice"><button data-a="play" aria-label="Play voice">▶</button>Voice ${fmtSecs(d.voice.durationSec || 0)}<button data-a="rmvoice" aria-label="Remove voice">✕</button></span>`);
  for (const t of d.tags) parts.push(`<span class="tagchip">#${escapeHTML(t)}<button data-a="rmtag" data-v="${escapeHTML(t)}" aria-label="Remove tag">✕</button></span>`);
  for (const id of d.collections) { const c = albums.get(id); if (c) parts.push(`<span class="tagchip col">${escapeHTML(c.name)}<button data-a="rmcol" data-v="${id}" aria-label="Remove from album">✕</button></span>`); }
  box.innerHTML = parts.join('');
  const mb = $('#mood-btn');
  mb.textContent = d.mood ? `${d.mood} Mood` : '🙂 Mood';
  mb.classList.toggle('on', !!d.mood);
  $('#tag-btn').classList.toggle('on', d.tags.length > 0);
  $('#colpick-btn').classList.toggle('on', d.collections.length > 0);
}
$('#meta-chips').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = state.draft; if (!d) return;
  const a = b.dataset.a, v = b.dataset.v;
  if (a === 'rmtag') d.tags = d.tags.filter((t) => t !== v);
  if (a === 'rmcol') d.collections = d.collections.filter((c) => c !== v);
  if (a === 'rmvoice') { d.voice = null; d.voiceRemoved = true; voicePlayer.stop(); persistDraft(); }
  if (a === 'play') {
    const src = d.voice.existing ? await mediaURL(`${d.editingId}:voice`, false) : (d.voice.url = d.voice.url || URL.createObjectURL(d.voice.blob));
    voicePlayer.toggle(src);
    return;
  }
  writeDraftMeta(); renderMetaChips();
});
// Mood
$('#mood-pop').innerHTML = MOODS.map((m) => `<button data-m="${m}" aria-label="Mood ${m}">${m}</button>`).join('');
$('#mood-btn').onclick = () => {
  $('#tag-entry').hidden = true;
  const pop = $('#mood-pop'); pop.hidden = !pop.hidden;
  pop.querySelectorAll('button').forEach((b) => b.classList.toggle('on', state.draft && b.dataset.m === state.draft.mood));
};
$('#mood-pop').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || !state.draft) return;
  state.draft.mood = state.draft.mood === b.dataset.m ? '' : b.dataset.m;
  $('#mood-pop').hidden = true; haptic(8);
  writeDraftMeta(); renderMetaChips();
});
// Tags
const normTag = (t) => t.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 24);
$('#tag-btn').onclick = () => { $('#mood-pop').hidden = true; const te = $('#tag-entry'); te.hidden = !te.hidden; if (!te.hidden) $('#tag-input').focus(); };
function addTagFromInput() {
  const d = state.draft; const inp = $('#tag-input');
  const parts = inp.value.split(/[,\s]+/).map(normTag).filter(Boolean);
  inp.value = '';
  if (!d || !parts.length) return;
  for (const t of parts) if (!d.tags.includes(t) && d.tags.length < 5) d.tags.push(t);
  writeDraftMeta(); renderMetaChips();
}
$('#tag-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTagFromInput(); if (e.key === 'Enter') $('#tag-entry').hidden = true; }
});
$('#tag-input').addEventListener('blur', addTagFromInput);
// Albums
$('#colpick-btn').onclick = () => {
  const d = state.draft; if (!d) return;
  openPicker(d.collections, (ids) => { d.collections = ids; writeDraftMeta(); renderMetaChips(); });
};

// Voice recording: asked each time before it is kept.
let pendingVoice = null;
function onVoiceRecorded(v) {
  if (!state.draft || !$('#compose').classList.contains('active')) return;
  pendingVoice = v;
  $('#voice-ask-dur').textContent = fmtSecs(v.durationSec);
  $('#voice-ask').hidden = false;
}
$('#voice-keep').onclick = () => {
  const d = state.draft; if (!d || !pendingVoice) return;
  if (d.voice && d.voice.url) URL.revokeObjectURL(d.voice.url);
  d.voice = pendingVoice; d.voiceRemoved = false; pendingVoice = null;
  $('#voice-ask').hidden = true;
  metrics.event('voice_kept');
  persistDraft(); renderMetaChips();
};
$('#voice-drop').onclick = () => { pendingVoice = null; $('#voice-ask').hidden = true; metrics.event('voice_declined'); };

const voicePlayer = (() => {
  let a = null, onEnd = null;
  function stop() { if (a) { a.pause(); a = null; } if (onEnd) { onEnd(); onEnd = null; } }
  function play(src, done) {
    stop();
    a = new Audio(src); onEnd = done || null;
    a.onended = stop;
    a.play().catch(() => stop());
    return a;
  }
  return { play, stop, toggle: (src, done) => (a ? stop() : play(src, done)), playing: () => !!a };
})();

function closeCompose({ keepDraft = false } = {}) {
  const d = state.draft;
  speech.cancelAudio && speech.cancelAudio();
  voicePlayer.stop();
  if (d && d.shots) d.shots.forEach((sh) => { if (sh.previewURL) URL.revokeObjectURL(sh.previewURL); if (sh.thumbURL && sh.thumb) URL.revokeObjectURL(sh.thumbURL); delete sh.previewURL; delete sh.thumbURL; });
  if (d && !d.editingId && keepDraft) { clearTimeout(draftCapTimer); writeDraftMeta(); }
  if (d && !d.editingId && !keepDraft) {
    localStorage.removeItem(DRAFT_KEY);
    store.clearDraft().catch(() => {});
  }
  $('#voice-ask').hidden = true; pendingVoice = null;
  state.draft = null; state.adding = false;
}

async function loadDraft() {
  let meta;
  try { meta = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (_) { meta = null; }
  if (!meta) return null;
  const legacy = !Array.isArray(meta.shots);
  const got = await store.getDraft(legacy ? null : meta.shots.length).catch(() => null);
  if (!got || !got.shots.length || !got.shots[0].blob) { localStorage.removeItem(DRAFT_KEY); return null; }
  const shots = legacy
    ? [{ blob: got.shots[0].blob, thumb: got.shots[0].thumb, type: meta.type, mime: meta.mime, width: meta.width, height: meta.height, durationSec: meta.durationSec, createdAt: meta.createdAt }]
    : meta.shots.map((sm, k) => ({ ...sm, ...got.shots[k] })).filter((sh) => sh.blob);
  const voice = got.voice && meta.voiceMeta ? { blob: got.voice, ...meta.voiceMeta } : null;
  const { voiceMeta, ...rest } = meta;
  return { ...rest, shots, voice, restored: true };
}
async function offerDraft() {
  const d = await loadDraft();
  if (!d) return false;
  toast('You have an unsaved moment', { label: 'Open', fn: () => openCompose(d) }, 9000);
  return true;
}

// Keep the caption panel above the on-screen keyboard (iOS doesn't resize the layout).
if (window.visualViewport) {
  const vv = window.visualViewport;
  const upd = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', (kb > 80 ? kb : 0) + 'px');
  };
  vv.addEventListener('resize', upd);
  vv.addEventListener('scroll', upd);
}

$('#caption').addEventListener('input', (e) => {
  if (e.isTrusted && e.inputType) state.captionSource.typed = true;
  updateCount();
  saveDraftCaption();
});

$('#compose-save').onclick = async () => {
  const d = state.draft;
  if (!d) return;
  speech.stop();
  voicePlayer.stop();
  if (!$('#tag-entry').hidden) addTagFromInput();
  const caption = $('#caption').value.trim().slice(0, 280);
  const now = new Date().toISOString();
  const cs = state.captionSource;
  const source = cs.voice && cs.typed ? 'mixed' : cs.voice ? 'voice' : 'typed';
  const meta = { mood: d.mood || '', tags: d.tags || [], collections: d.collections || [] };
  $('#compose-save').disabled = true;
  try {
    if (d.editingId) {
      const m = await store.get(d.editingId);
      const updated = { ...m, ...meta, caption, updatedAt: now, syncState: 'local',
        captionSource: caption === m.caption ? m.captionSource : (m.captionSource && m.captionSource !== source ? 'mixed' : source) };
      let voiceBlob;
      if (d.voice && !d.voice.existing) { updated.voice = { mime: d.voice.mime, durationSec: d.voice.durationSec }; voiceBlob = d.voice.blob; }
      else if (d.voiceRemoved) { delete updated.voice; voiceBlob = null; }
      const i = state.memories.findIndex((x) => x.id === m.id);
      if (i > -1) state.memories[i] = updated;
      await store.put(updated, voiceBlob !== undefined ? { voice: voiceBlob } : undefined);
      if (voiceBlob !== undefined) dropURLs(m.id + ':voice');
      const list = state.viewerList;
      closeCompose();
      renderFeed();
      openViewer(m.id, list && list.map((x) => (x.id === m.id ? updated : x)), state.viewerPart || 0);
      toast('Saved');
    } else {
      const shots = d.shots;
      const main = shots[0];
      const m = {
        id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)),
        createdAt: main.createdAt || d.createdAt, updatedAt: now, deleted: false,
        type: main.type, mime: main.mime, caption, captionSource: caption ? source : 'typed',
        width: main.width || 0, height: main.height || 0,
        ...(main.durationSec ? { durationSec: main.durationSec } : {}),
        ...(shots.length > 1 ? { parts: shots.slice(1).map((sh) => { const { createdAt, ...pm } = shotMeta(sh); return pm; }) } : {}),
        ...(d.voice ? { voice: { mime: d.voice.mime, durationSec: d.voice.durationSec } } : {}),
        ...meta,
        syncState: 'local',
      };
      const daysBefore = captureDaysInWeek(startOfWeek()).size;
      // Optimistic: show in the feed straight away.
      state.memories.unshift(m);
      state.memories.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      shots.forEach((sh, k) => {
        const key = partKey(m, k);
        urls.set(key, sh.previewURL || URL.createObjectURL(sh.blob)); sh.previewURL = null;
        if (sh.thumb) { urls.set(key + ':t', URL.createObjectURL(sh.thumb)); }
      });
      const media = { blob: main.blob, thumb: main.thumb, parts: shots.slice(1).map((sh) => ({ blob: sh.blob, thumb: sh.thumb })), voice: d.voice ? d.voice.blob : undefined };
      closeCompose();
      $('#feed').scrollTo({ top: 0 });
      if (state.tab !== 'home') setTab('home');
      show('feed');
      renderFeed();
      haptic(10);
      const secs = state.captureStart ? (performance.now() - state.captureStart) / 1000 : 0;
      state.captureStart = null;
      try {
        await store.put(m, media);
        const daysAfter = captureDaysInWeek(startOfWeek()).size;
        if (daysBefore < WEEK_GOAL && daysAfter >= WEEK_GOAL && new Date(m.createdAt) >= startOfWeek()) {
          toast(`Week filled: ${WEEK_GOAL} days of moments`, null, 3200);
          haptic([20, 50, 20]);
          metrics.event('week_filled');
        } else toast('Saved');
        metrics.saved(m, secs);
        if (shots.length > 1) metrics.event('multi_shot_saved');
        if (m.mood) metrics.event('mood_set');
        if (m.tags.length) metrics.event('tags_set');
        if (m.collections.length) metrics.event('added_to_album');
        maybeAskPersist();
        updateBanner();
      }
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
  if (d && d.editingId) { const id = d.editingId, list = state.viewerList; closeCompose(); openViewer(id, list, state.viewerPart || 0); return; }
  const dirty = $('#caption').value.trim().length > 0 || (d && (d.shots.length > 1 || d.voice || d.tags.length));
  if (dirty && !confirm('Discard this moment?')) return;
  closeCompose();
  state.captureStart = performance.now();
  openCamera();
};

/* =========================================================
   VIEWER
   ========================================================= */
const relivedThisSession = new Set();
const vlist = () => state.viewerList || visibleMemories();
const vcur = () => vlist()[state.viewerIndex];
async function openViewer(id, list, part = 0) {
  state.viewerList = list || visibleMemories();
  state.viewerIndex = state.viewerList.findIndex((m) => m.id === id);
  if (state.viewerIndex < 0) { state.viewerList = state.memories; state.viewerIndex = state.memories.findIndex((m) => m.id === id); }
  if (state.viewerIndex < 0) return;
  state.viewerPart = part;
  show('viewer');
  await paintViewer(0);
}
async function paintViewer(dir) {
  const m = vcur();
  if (!m) return show('feed');
  voicePlayer.stop();
  const n = partCount(m);
  state.viewerPart = Math.max(0, Math.min(state.viewerPart || 0, n - 1));
  const p = state.viewerPart, info = partInfo(m, p), key = partKey(m, p);
  state.viewerId = m.id;
  if (Date.now() - new Date(m.createdAt).getTime() > 864e5 && !relivedThisSession.has(m.id)) {
    relivedThisSession.add(m.id);
    metrics.relived();
  }
  const stage = $('#viewer-stage');
  const old = stage.firstElementChild;
  if (old && old.tagName === 'VIDEO') old.pause();
  let el;
  if (info.type === 'video') {
    el = document.createElement('video');
    el.playsInline = true; el.setAttribute('playsinline', ''); el.controls = true; el.autoplay = true; el.loop = true;
    el.poster = await mediaURL(key, true);
  } else {
    el = document.createElement('img'); el.alt = m.caption || 'Moment';
  }
  el.src = await mediaURL(key, false);
  if (dir) { el.style.opacity = 0; el.style.transform = `translateX(${dir * 40}px)`; }
  stage.innerHTML = '';
  stage.appendChild(el);
  if (dir) requestAnimationFrame(() => { el.style.opacity = 1; el.style.transform = 'none'; });
  if (info.type === 'video') el.play().catch(() => {});
  $('#viewer-dots').innerHTML = n > 1 ? Array.from({ length: n }, (_, k) => `<i class="${k === p ? 'on' : ''}"></i>`).join('') : '';
  $('#viewer-when').textContent = fullLabel(new Date(m.createdAt)) + (m.mood ? ' ' + m.mood : '');
  $('#viewer-fav').setAttribute('aria-pressed', String(!!m.favorite));
  const vp = $('#viewer-voice');
  vp.hidden = !m.voice; vp.classList.remove('playing');
  if (m.voice) $('#viewer-voice-t').textContent = fmtSecs(m.voice.durationSec || 0);
  const cap = $('#viewer-caption');
  const tags = (m.tags || []).map((t) => '#' + t).join(' ');
  cap.textContent = [m.caption, tags].filter(Boolean).join('\n');
  cap.hidden = !cap.textContent;
  $('#viewer-menu').hidden = true;
  $('#viewer-card').hidden = info.type !== 'photo';
  $('#viewer-rmvoice').hidden = !m.voice;
}
// Within a moment's shots first, then on to the next moment.
function step(dir) {
  const m = vcur();
  const n = partCount(m);
  const np = (state.viewerPart || 0) + dir;
  if (m && np >= 0 && np < n) { state.viewerPart = np; paintViewer(dir); return; }
  const list = vlist();
  const next = state.viewerIndex + dir;
  if (next < 0 || next >= list.length) { haptic(5); return; }
  state.viewerIndex = next;
  state.viewerPart = dir > 0 ? 0 : partCount(list[next]) - 1;
  paintViewer(dir);
}
$('#viewer-voice').onclick = async () => {
  const m = vcur(); if (!m || !m.voice) return;
  const vp = $('#viewer-voice');
  if (voicePlayer.playing()) { voicePlayer.stop(); return; }
  vp.classList.add('playing');
  voicePlayer.play(await mediaURL(`${m.id}:voice`, false), () => vp.classList.remove('playing'));
};
(() => {
  const stage = $('#viewer-stage');
  let x0 = null, y0 = null, t0 = 0;
  stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) { // double-tap = favourite
      const now = Date.now();
      if (now - (stage._lastTap || 0) < 300) { stage._lastTap = 0; const m = vcur(); if (m) toggleFav(m.id); }
      else stage._lastTap = now;
      return;
    }
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
$('#viewer-fav').onclick = () => { const m = vcur(); if (m) toggleFav(m.id); };
$('#viewer-stage').addEventListener('dblclick', () => { const m = vcur(); if (m) toggleFav(m.id); });
$('#viewer-more').onclick = (e) => { e.stopPropagation(); $('#viewer-menu').hidden = !$('#viewer-menu').hidden; };
$('#viewer-menu').addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(() => { $('#viewer-menu').hidden = true; }, 0); });
$('#viewer').addEventListener('click', (e) => { if (!e.target.closest('#viewer-menu, #viewer-more')) $('#viewer-menu').hidden = true; });
$('#viewer-edit').onclick = () => {
  const m = vcur();
  if (!m) return;
  state.composePart = state.viewerPart || 0;
  openCompose({ editingId: m.id, type: m.type, caption: m.caption, createdAt: m.createdAt,
    mood: m.mood || '', tags: [...(m.tags || [])], collections: [...(m.collections || [])],
    voice: m.voice ? { existing: true, ...m.voice } : null }).then(() => { state.composePart = state.viewerPart || 0; renderComposeMedia(); });
};
$('#viewer-share').onclick = () => { const m = vcur(); if (m) shareMoment(m); };
$('#viewer-card').onclick = () => { const m = vcur(); if (m) shareCard(m, state.viewerPart || 0); };
$('#viewer-addcol').onclick = () => {
  const m = vcur(); if (!m) return;
  openPicker(m.collections || [], async (ids) => {
    const added = ids.some((x) => !(m.collections || []).includes(x));
    m.collections = ids; m.updatedAt = new Date().toISOString(); m.syncState = 'local';
    await store.put(m);
    if (added) { toast('Added to album'); metrics.event('added_to_album'); }
  });
};
$('#viewer-rmvoice').onclick = async () => {
  const m = vcur(); if (!m || !m.voice) return;
  if (!confirm('Remove the voice recording from this moment?')) return;
  voicePlayer.stop();
  delete m.voice; m.updatedAt = new Date().toISOString(); m.syncState = 'local';
  await store.put(m, { voice: null });
  dropURLs(m.id + ':voice');
  paintViewer(0); renderFeed();
  toast('Voice recording removed');
};
$('#viewer-save-file').onclick = async () => {
  const m = vcur();
  if (!m) return;
  const p = state.viewerPart || 0, info = partInfo(m, p);
  const blob = await store.getMedia(partKey(m, p));
  const name = `moment-${m.createdAt.slice(0, 10)}${p ? '-' + (p + 1) : ''}.${extFor(info.mime)}`;
  const file = new File([blob], name, { type: info.mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name);
};
$('#viewer-delete').onclick = async () => {
  const m = vcur();
  if (!m) return;
  haptic(20);
  // Hide immediately; commit after the undo window.
  if (state.pendingDelete) await commitDelete();
  state.pendingDelete = { memory: m, timer: setTimeout(commitDelete, 5200) };
  state.memories = state.memories.filter((x) => x.id !== m.id);
  if (state.viewerList) state.viewerList = state.viewerList.filter((x) => x.id !== m.id);
  renderFeed();
  if (state.tab === 'search') renderSearch();
  if (state.tab === 'collections') renderAlbums();
  state.viewerPart = 0;
  const remaining = vlist();
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
  const files = [{ name: 'memories.json', data: JSON.stringify({ app: 'moments', version: 2, exportedAt: new Date().toISOString(), albums: albums.list(), memories: all }, null, 2) }];
  for (const m of all) {
    const b = await store.getMedia(m.id); if (b) files.push({ name: `media/${m.id}.${extFor(m.mime)}`, data: b });
    const t = await store.getMedia(m.id, true); if (t) files.push({ name: `media/${m.id}_thumb.jpg`, data: t });
    for (let k = 1; k < partCount(m); k++) {
      const pb = await store.getMedia(`${m.id}#${k}`); if (pb) files.push({ name: `media/${m.id}_p${k}.${extFor(m.parts[k - 1].mime)}`, data: pb });
      const pt = await store.getMedia(`${m.id}#${k}`, true); if (pt) files.push({ name: `media/${m.id}_p${k}_thumb.jpg`, data: pt });
    }
    if (m.voice) { const vb = await store.getMedia(`${m.id}:voice`); if (vb) files.push({ name: `media/${m.id}_voice.${extFor(m.voice.mime)}`, data: vb }); }
  }
  const blob = await zip.build(files);
  const name = `moments-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  const file = new File([blob], name, { type: 'application/zip' });
  if (/iPhone|iPad|Android/i.test(navigator.userAgent) && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); markBackup(); toast(`Backup ready: ${all.length} moments`); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name);
  markBackup();
  toast(`Backup saved: ${all.length} moments`);
}
function markBackup() {
  localStorage.setItem('moments.lastBackup', String(Date.now()));
  metrics.event('backup_exported');
  updateBanner();
}

async function importBackup(file) {
  try {
    const entries = await zip.read(file);
    const json = entries.get('memories.json');
    if (!json) throw new Error('No memories.json');
    const data = JSON.parse(await json.text());
    if (data.app !== 'moments' || !Array.isArray(data.memories)) throw new Error('Not a Moments backup');
    if (Array.isArray(data.albums)) albums.merge(data.albums);
    const existing = new Map((await store.list({ includeDeleted: true })).map((m) => [m.id, m]));
    let added = 0, updated = 0;
    for (const m of data.memories) {
      const cur = existing.get(m.id);
      if (cur && cur.updatedAt >= m.updatedAt) continue;
      const blob = entries.get(`media/${m.id}.${extFor(m.mime)}`);
      if (!blob && !m.deleted) continue;
      const thumb = entries.get(`media/${m.id}_thumb.jpg`);
      const parts = (m.parts || []).map((pm, k) => {
        const pb = entries.get(`media/${m.id}_p${k + 1}.${extFor(pm.mime)}`), pt = entries.get(`media/${m.id}_p${k + 1}_thumb.jpg`);
        return { blob: pb ? new Blob([pb], { type: pm.mime }) : null, thumb: pt ? new Blob([pt], { type: 'image/jpeg' }) : null };
      });
      const vb = m.voice ? entries.get(`media/${m.id}_voice.${extFor(m.voice.mime)}`) : null;
      await store.put({ ...m, syncState: 'local' }, {
        blob: blob ? new Blob([blob], { type: m.mime }) : null,
        thumb: thumb ? new Blob([thumb], { type: 'image/jpeg' }) : null,
        parts,
        voice: vb ? new Blob([vb], { type: m.voice.mime }) : undefined,
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
   BANNERS — one at a time: iOS install (data safety) > backup > Android install
   ========================================================= */
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const snoozed = (k) => Number(localStorage.getItem('moments.snooze.' + k) || 0) > Date.now();
const snooze = (k, days) => localStorage.setItem('moments.snooze.' + k, String(Date.now() + days * 864e5));
const daysSince = (t) => Math.floor((Date.now() - t) / 864e5);
let bannerKey = null;

function pickBanner() {
  const n = state.memories.length;
  const last = Number(localStorage.getItem('moments.lastBackup') || 0);
  if (isIOS && !isStandalone() && !snoozed('ios')) {
    return { key: 'ios', warn: true, days: 2,
      title: 'Install to keep your moments safe',
      sub: 'Safari clears sites you don\u2019t visit for a week. The home-screen app is kept.',
      action: 'How', fn: showHowto };
  }
  if (n >= 5 && (!last || daysSince(last) >= 30) && !snoozed('backup')) {
    return { key: 'backup', days: 7,
      title: `Back up your ${n} moments`,
      sub: last ? `Last backup was ${daysSince(last)} days ago.` : 'One file, saved wherever you like.',
      action: 'Export', fn: exportBackup };
  }
  if (installPrompt && !isStandalone() && n >= 2 && !snoozed('install')) {
    return { key: 'install', days: 7,
      title: 'Add Moments to your home screen',
      sub: 'Opens straight to the camera and works offline.',
      action: 'Install', fn: doInstall };
  }
  return null;
}
function updateBanner() {
  const b = pickBanner();
  const el = $('#banner');
  if (!b) { el.hidden = true; bannerKey = null; return; }
  bannerKey = b.key;
  el.hidden = false;
  el.classList.toggle('warn', !!b.warn);
  $('#banner-title').textContent = b.title;
  $('#banner-sub').textContent = b.sub;
  $('#banner-action').textContent = b.action;
  $('#banner-action').onclick = b.fn;
  $('#banner-close').onclick = () => { snooze(b.key, b.days); updateBanner(); };
}
function showHowto() {
  $('#howto-note').hidden = state.memories.length === 0;
  $('#howto').hidden = false; $('#scrim').hidden = false;
}
function hideHowto() { $('#howto').hidden = true; if ($('#sheet').hidden) $('#scrim').hidden = true; }
$('#howto-ok').onclick = hideHowto;
async function doInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  const choice = await installPrompt.userChoice.catch(() => null);
  if (choice && choice.outcome === 'accepted') metrics.event('install_accepted');
  installPrompt = null;
  updateBanner();
}

/* =========================================================
   SETTINGS
   ========================================================= */
const fmtBytes = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? Math.round(b / 1e6) + ' MB' : Math.round(b / 1e3) + ' KB';
async function openSheet() {
  reminders.initUI();
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
  const last = Number(localStorage.getItem('moments.lastBackup') || 0);
  $('#backup-line').textContent = last
    ? `Last backup: ${daysSince(last) === 0 ? 'today' : daysSince(last) === 1 ? 'yesterday' : daysSince(last) + ' days ago'}.`
    : 'No backup yet. One .zip with every photo, video and caption.';
  $('#opt-metrics').checked = metrics.optedIn();
  renderStats();
}
function renderStats() {
  const s = metrics.summary();
  const cells = [
    [s.saves, 'moments saved'],
    [s.relives, 'old moments relived'],
    [s.medianSave != null ? s.medianSave.toFixed(1) + ' s' : '\u2013', 'median time to save'],
    [s.captionRate != null ? s.captionRate + '%' : '\u2013', 'with a caption'],
    [s.voice, 'captions spoken'],
    [s.rememberWeeks, 'weeks you saved and relived'],
  ];
  $('#stats').innerHTML = cells.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
}
function closeSheet() { $('#scrim').hidden = true; $('#sheet').hidden = true; }

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; updateBanner(); });
$('#install-btn').onclick = async () => { await doInstall(); $('#install-row').hidden = true; };
$('#opt-metrics').onchange = (e) => { metrics.setOptIn(e.target.checked); toast(e.target.checked ? 'Thanks. Only counts are shared.' : 'Usage counts are off.'); };
window.addEventListener('appinstalled', () => { metrics.event('installed'); updateBanner(); });
async function maybeAskPersist() {
  if (!(navigator.storage && navigator.storage.persist)) return;
  try { if (!(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (_) {}
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
$('#scrim').onclick = () => { closeSheet(); hideHowto(); };
(() => { // swipe the sheet down to close
  const s = $('#sheet'); let y0 = null;
  s.addEventListener('touchstart', (e) => { if (s.scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
  s.addEventListener('touchend', (e) => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 80) closeSheet(); y0 = null; }, { passive: true });
})();

/* =========================================================
   FEED CONTROLS
   ========================================================= */
$('#fab').onclick = () => { haptic(); state.captureStart = performance.now(); openCamera(); };
(() => { // Instagram-style: swipe right anywhere on the feed to open the camera
  const feed = $('#feed');
  let t0 = null;
  feed.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('.otd-strip, .searchbar, .banner, input, textarea, .slides, .filters, .rail, .heat-wrap')) { t0 = null; return; }
    t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  feed.addEventListener('touchend', (e) => {
    if (!t0 || !$('#feed').classList.contains('active')) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - t0.x, dy = p.clientY - t0.y, dt = Date.now() - t0.t;
    t0 = null;
    if (dx > 70 && Math.abs(dy) < 45 && dt < 600) { haptic(); state.captureStart = performance.now(); openCamera(); }
  }, { passive: true });
})();
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
  $(id).onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length && !state.captureStart) state.captureStart = performance.now(); filesToShots(fs); };
}

/* =========================================================
   WEEKLY RING — 3 capture days a week; skipping a day costs nothing
   ========================================================= */
const WEEK_GOAL = 3;
function startOfWeek(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function captureDaysInWeek(ws) {
  const we = new Date(ws); we.setDate(ws.getDate() + 7);
  const set = new Set();
  for (const m of state.memories) { const d = new Date(m.createdAt); if (d >= ws && d < we) set.add((d.getDay() + 6) % 7); }
  return set;
}
function updateRing() {
  const days = captureDaysInWeek(startOfWeek());
  const n = Math.min(days.size, WEEK_GOAL);
  const C = 2 * Math.PI * 15;
  const fg = $('#rm-fg');
  fg.style.strokeDasharray = C;
  fg.style.strokeDashoffset = C * (1 - n / WEEK_GOAL);
  $('#rm-text').textContent = `${days.size}/${WEEK_GOAL}`;
  const rm = $('#ring-mini');
  rm.classList.toggle('full', days.size >= WEEK_GOAL);
  rm.hidden = state.memories.length === 0;
  rm.setAttribute('aria-label', `${days.size} of ${WEEK_GOAL} days this week`);
}
$('#ring-mini').onclick = () => setTab('calendar');

/* =========================================================
   STORIES — what to relive, grouped
   ========================================================= */
const asc = (a) => [...a].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
function storyGroups() {
  const now = new Date(), tk = dayKey(now);
  const ms = state.memories;
  const ws = startOfWeek();
  const today = ms.filter((m) => dayKey(new Date(m.createdAt)) === tk);
  const week = ms.filter((m) => new Date(m.createdAt) >= ws);
  const otd = ms.filter((m) => { const d = new Date(m.createdAt); return d.getDate() === now.getDate() && dayKey(d) !== tk && d < now; });
  const ya = new Date(now); ya.setFullYear(now.getFullYear() - 1);
  const yearAgo = ms.filter((m) => Math.abs(new Date(m.createdAt) - ya) <= 3 * 864e5 && !otd.includes(m));
  const favs = ms.filter((m) => m.favorite).slice(0, 30);
  const groups = [
    { key: 'today', title: 'Today', items: asc(today) },
    { key: 'week', title: now.getDay() === 0 ? 'Your week' : 'This week', items: asc(week), reel: true },
    { key: 'otd', title: 'On this day', items: asc(otd) },
    { key: 'yearago', title: 'A year ago', items: asc(yearAgo) },
    { key: 'favs', title: 'Favourites', items: favs, reel: true },
  ];
  return groups.filter((g) => g.items.length && !(g.key === 'week' && g.items.length === today.length && now.getDay() !== 0));
}
const sigOf = (g) => g.items.length + ':' + (g.items[g.items.length - 1] || {}).id;
function seenMap() { try { return JSON.parse(localStorage.getItem('moments.seen')) || {}; } catch (_) { return {}; } }
function markSeen(g) { const m = seenMap(); m[g.key] = sigOf(g); try { localStorage.setItem('moments.seen', JSON.stringify(m)); } catch (_) {} }

async function renderRail() {
  const rail = $('#rail');
  rail.innerHTML = '';
  if (state.query || !state.memories.length) return;
  const groups = storyGroups();
  const seen = seenMap();
  if (!groups.find((g) => g.key === 'today')) {
    const b = document.createElement('button');
    b.className = 'bubble';
    b.innerHTML = '<div class="bubble-ring"><div class="bubble-plus"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></div></div><span>Add today</span>';
    b.onclick = () => { haptic(); state.captureStart = performance.now(); openCamera(); };
    rail.appendChild(b);
  }
  for (const g of groups) {
    const b = document.createElement('button');
    b.className = 'bubble' + (seen[g.key] === sigOf(g) ? '' : ' unseen');
    b.setAttribute('aria-label', `${g.title}: ${g.items.length} moment${g.items.length > 1 ? 's' : ''}`);
    b.innerHTML = `<div class="bubble-ring"><img alt=""></div><span>${g.title}</span>`;
    b.onclick = () => player.open(g);
    rail.appendChild(b);
    const cover = g.key === 'favs' ? g.items[0] : g.items[g.items.length - 1];
    mediaURL(cover.id, true).then((u) => { b.querySelector('img').src = u; });
  }
}

/* =========================================================
   STORY PLAYER — tap to advance, hold to pause, double-tap to favourite
   ========================================================= */
const player = (() => {
  let g = null, segs = [], i = 0, raf = 0, start = 0, elapsed = 0, dur = 5000, paused = false, vid = null, token = 0, aud = null;
  const stage = $('#story-stage');
  const PHOTO_MS = 5000, MAX_VIDEO_MS = 15000;

  async function open(group, startIndex = 0) {
    g = group; i = startIndex;
    segs = group.items.flatMap((m) => Array.from({ length: partCount(m) }, (_, p) => ({ m, p })));
    markSeen(group);
    $('#story-title').textContent = group.title;
    $('#story-reel').hidden = !(group.reel && group.items.length >= 3 && window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);
    $('#story-bars').innerHTML = segs.map(() => '<i><b></b></i>').join('');
    show('story');
    metrics.event('story_opened');
    await play();
  }
  function bars() {
    const bs = $('#story-bars').children;
    for (let k = 0; k < bs.length; k++) bs[k].firstChild.style.width = k < i ? '100%' : '0';
  }
  async function play() {
    cancelAnimationFrame(raf);
    const my = ++token;
    if (vid) { vid.pause(); vid = null; }
    if (aud) { aud.pause(); aud = null; }
    const seg = g && segs[i];
    if (!seg) return close();
    const m = seg.m, part = seg.p, info = partInfo(m, part), key = partKey(m, part);
    bars();
    if (Date.now() - new Date(m.createdAt).getTime() > 864e5 && !relivedThisSession.has(m.id)) { relivedThisSession.add(m.id); metrics.relived(); }
    $('#story-when').textContent = fullLabel(new Date(m.createdAt));
    $('#story-caption').textContent = m.caption || '';
    const src = await mediaURL(key, false);
    if (my !== token) return;
    stage.innerHTML = '';
    if (info.type === 'video') {
      const v = document.createElement('video');
      v.playsInline = true; v.setAttribute('playsinline', ''); v.src = src;
      v.poster = await mediaURL(key, true);
      stage.appendChild(v);
      vid = v;
      v.muted = false;
      try { await v.play(); } catch (_) { v.muted = true; v.play().catch(() => {}); }
      dur = Math.min((info.durationSec || 10) * 1000, MAX_VIDEO_MS);
      v.onended = () => { if (my === token) next(); };
    } else {
      const img = document.createElement('img'); img.alt = m.caption || 'Moment'; img.src = src;
      stage.appendChild(img);
      try { await img.decode(); } catch (_) {}
      dur = PHOTO_MS;
      // The moment's own voice plays over its first photo.
      if (part === 0 && m.voice) {
        aud = new Audio(await mediaURL(`${m.id}:voice`, false));
        aud.play().catch(() => {});
        dur = Math.min(Math.max((m.voice.durationSec || 0) * 1000 + 400, PHOTO_MS), MAX_VIDEO_MS);
      }
    }
    if (my !== token) return;
    elapsed = 0; start = performance.now(); paused = false;
    tick();
    const nx = segs[i + 1]; if (nx) mediaURL(partKey(nx.m, nx.p), partInfo(nx.m, nx.p).type === 'video'); // warm the next one
  }
  function tick() {
    if (!g) return;
    if (!paused) {
      const t = elapsed + (performance.now() - start);
      const bar = $('#story-bars').children[i];
      if (bar) bar.firstChild.style.width = Math.min(t / dur, 1) * 100 + '%';
      if (t >= dur) return next();
    }
    raf = requestAnimationFrame(tick);
  }
  function pause() { if (paused || !g) return; elapsed += performance.now() - start; paused = true; if (vid) vid.pause(); if (aud) aud.pause(); }
  function resume() { if (!paused || !g) return; start = performance.now(); paused = false; if (vid) vid.play().catch(() => {}); if (aud) aud.play().catch(() => {}); }
  function next() { if (!g) return; if (i < segs.length - 1) { i++; play(); } else close(); }
  function prev() { if (!g) return; if (i > 0) i--; play(); }
  function halt() { cancelAnimationFrame(raf); token++; if (vid) { vid.pause(); vid = null; } if (aud) { aud.pause(); aud = null; } stage.innerHTML = ''; g = null; }
  function close() { halt(); show('feed'); renderRail(); }

  // Gestures
  let down = null, holdT = null, holding = false, lastTap = 0, tapT = null;
  stage.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: Date.now() };
    holding = false;
    holdT = setTimeout(() => { holding = true; pause(); }, 200);
  });
  // Movement means a swipe, not a hold: cancel the pause.
  stage.addEventListener('pointermove', (e) => {
    if (!down || down.moved) return;
    if (Math.abs(e.clientX - down.x) > 12 || Math.abs(e.clientY - down.y) > 12) {
      down.moved = true;
      clearTimeout(holdT);
      if (holding) { holding = false; resume(); }
    }
  });
  stage.addEventListener('pointerup', (e) => {
    clearTimeout(holdT);
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    const moved = down.moved;
    down = null;
    if (holding && !moved) { holding = false; resume(); return; }
    holding = false;
    if (dy > 90 && Math.abs(dy) > Math.abs(dx)) { close(); return; }
    if (Math.abs(dx) > 60) { dx < 0 ? next() : prev(); return; }
    const now = Date.now();
    if (now - lastTap < 260) {
      clearTimeout(tapT); lastTap = 0;
      const sg = g && segs[i]; if (sg) toggleFav(sg.m.id, true);
      return;
    }
    lastTap = now;
    const x = e.clientX / stage.clientWidth;
    tapT = setTimeout(() => (x < 0.33 ? prev() : next()), 260);
  });
  stage.addEventListener('pointercancel', () => { clearTimeout(holdT); if (holding) { holding = false; resume(); } down = null; });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('dragstart', (e) => e.preventDefault()); // image drag would cancel the gesture
  $('#story-close').onclick = close;
  $('#story-reel').onclick = () => { if (g) { pause(); makeReel(g).finally(() => resume()); } };
  document.addEventListener('keydown', (e) => {
    if (!g) return;
    if (e.key === 'ArrowRight') next();
    if (e.key === 'ArrowLeft') prev();
    if (e.key === 'Escape') close();
    if (e.key === ' ') { e.preventDefault(); paused ? resume() : pause(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  return { open, close, halt, pause, resume, isOpen: () => !!g };
})();

/* =========================================================
   FAVOURITES
   ========================================================= */
async function toggleFav(id, burst = false) {
  const m = state.memories.find((x) => x.id === id);
  if (!m) return;
  m.favorite = !m.favorite;
  m.updatedAt = new Date().toISOString();
  m.syncState = 'local';
  haptic(m.favorite ? 20 : 8);
  if (m.favorite && (burst || $('#viewer').classList.contains('active'))) {
    const hb = $('#story').classList.contains('active') ? $('#heart-burst') : null;
    if (hb) { hb.classList.remove('go'); void hb.offsetWidth; hb.classList.add('go'); }
  }
  $('#viewer-fav').setAttribute('aria-pressed', String(m.favorite));
  const t = document.querySelector(`.card[data-id="${CSS.escape(id)}"] .card-time`);
  if (t) { const f = t.querySelector('.fav'); if (m.favorite && !f) t.insertAdjacentHTML('beforeend', `<span class="fav">${ICON_HEART}</span>`); if (!m.favorite && f) f.remove(); }
  if (m.favorite) metrics.event('favourite');
  try { await store.put(m); } catch (_) { toast("Couldn't save that."); }
}

/* =========================================================
   TABS + CALENDAR
   ========================================================= */
state.tab = 'home';
state.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
function setTab(t) {
  if (t !== 'home' && !$('#searchbar').hidden) $('#search-cancel').click();
  state.tab = t;
  $('#home-view').hidden = t !== 'home';
  $('#cal-view').hidden = t !== 'calendar';
  $('#search-view').hidden = t !== 'search';
  $('#col-view').hidden = t !== 'collections';
  document.body.classList.toggle('on-cal', t === 'calendar');
  document.body.classList.toggle('on-search', t === 'search');
  document.body.classList.toggle('on-cols', t === 'collections');
  if (t === 'search') { renderSearch(); metrics.event('search_opened'); }
  if (t === 'collections') { state.openAlbum = null; renderAlbums(); }
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === t);
  $('#feed').scrollTo({ top: 0 });
  if (t === 'calendar') { renderCalendar(); metrics.event('calendar_opened'); }
}
for (const b of document.querySelectorAll('.tab')) b.onclick = () => { haptic(6); setTab(b.dataset.tab); };

function byDay() {
  const map = new Map();
  for (const m of state.memories) {
    const k = dayKey(new Date(m.createdAt));
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m);
  }
  return map;
}
function openDay(date, items) {
  player.open({ key: 'day:' + dayKey(date), title: dayLabel(date), items: asc(items) });
}
function renderCalendar() {
  const now = new Date();
  const map = byDay();
  // week card
  const ws = startOfWeek();
  const days = captureDaysInWeek(ws);
  const n = days.size;
  const C = 2 * Math.PI * 50;
  const fg = $('#rb-fg');
  fg.style.strokeDasharray = C;
  fg.style.strokeDashoffset = C * (1 - Math.min(n, WEEK_GOAL) / WEEK_GOAL);
  $('.week-card').classList.toggle('full', n >= WEEK_GOAL);
  $('#week-num').textContent = n >= WEEK_GOAL ? `${n} days · week filled` : `${n} of ${WEEK_GOAL} days`;
  $('#week-sub').textContent = n === 0 ? `Capture a moment on ${WEEK_GOAL} days this week.`
    : n < WEEK_GOAL ? `${WEEK_GOAL - n} more day${WEEK_GOAL - n > 1 ? 's' : ''} to fill your week.`
    : 'Anything more this week is a bonus.';
  const todayIdx = (now.getDay() + 6) % 7;
  $('#week-dots').innerHTML = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
    .map((l, k) => `<i class="${days.has(k) ? 'on' : ''}${k === todayIdx ? ' today' : ''}">${l}</i>`).join('');

  // month grid
  const first = state.calMonth;
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const oldest = state.memories.length ? new Date(state.memories[state.memories.length - 1].createdAt) : now;
  const minMonth = new Date(oldest.getFullYear(), oldest.getMonth(), 1);
  $('#cal-title').textContent = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  $('#cal-next').disabled = first >= thisMonth;
  $('#cal-prev').disabled = first <= minMonth;
  const grid = $('#cal-grid');
  grid.innerHTML = '';
  const lead = (first.getDay() + 6) % 7;
  for (let k = 0; k < lead; k++) { const e = document.createElement('div'); e.className = 'cal-day blank'; grid.appendChild(e); }
  const dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  for (let day = 1; day <= dim; day++) {
    const date = new Date(first.getFullYear(), first.getMonth(), day);
    const items = map.get(dayKey(date));
    const cell = document.createElement(items ? 'button' : 'div');
    cell.className = 'cal-day' + (items ? ' has' : '') + (date > now ? ' future' : '') + (dayKey(date) === dayKey(now) ? ' today' : '');
    cell.innerHTML = `<span>${day}</span>` + (items && items.length > 1 ? `<span class="n">${items.length}</span>` : '');
    if (items) {
      cell.setAttribute('aria-label', `${dayLabel(date)}: ${items.length} moment${items.length > 1 ? 's' : ''}`);
      const img = document.createElement('img'); img.alt = '';
      cell.prepend(img);
      const cover = asc(items)[0];
      mediaURL(cover.id, true).then((u) => { img.src = u; });
      cell.onclick = () => openDay(date, items);
    }
    grid.appendChild(cell);
  }

  // last 12 months heatmap (53 weeks, Monday rows)
  const heat = $('#heat');
  heat.innerHTML = '';
  const start = startOfWeek(); start.setDate(start.getDate() - 52 * 7);
  const frag = document.createDocumentFragment();
  for (let w = 0; w < 53; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(start); date.setDate(start.getDate() + w * 7 + d);
      const i = document.createElement('i');
      if (date > now) { i.className = 'pad'; frag.appendChild(i); continue; }
      const items = map.get(dayKey(date));
      const c = items ? items.length : 0;
      i.className = 'l' + Math.min(c, 3) + (dayKey(date) === dayKey(now) ? ' today' : '');
      i.title = `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}: ${c}`;
      if (items) i.onclick = () => openDay(date, items);
      frag.appendChild(i);
    }
  }
  heat.appendChild(frag);
  const wrap = heat.parentElement; wrap.scrollLeft = wrap.scrollWidth;
}
$('#cal-prev').onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); renderCalendar(); };
$('#cal-next').onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); renderCalendar(); };

/* =========================================================
   REEL — a story turned into a shareable video, made on this phone
   ========================================================= */
function pickRecMime() {
  const opts = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return opts.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}
let reelCancel = false;
$('#reel-cancel').onclick = () => { reelCancel = true; };
async function makeReel(group) {
  const items = group.items;
  let shots = items.flatMap((m) => Array.from({ length: partCount(m) }, (_, p) => ({ m, p })));
  if (shots.length > 24) { const st = shots.length / 24; shots = Array.from({ length: 24 }, (_, k) => shots[Math.floor(k * st)]); }
  const ov = $('#reel-overlay');
  ov.hidden = false; reelCancel = false;
  $('#reel-msg').textContent = group.key === 'week' ? 'Making your week…' : 'Making your video…';
  const c = $('#reel-canvas'), ctx = c.getContext('2d'), W = c.width, H = c.height;
  const ink = '#14213D', hl = '#F4B740', font = getComputedStyle(document.body).fontFamily;

  // Load media first so the recording has no stalls
  const assets = [];
  for (const { m, p } of shots) {
    const info = partInfo(m, p);
    const src = await mediaURL(partKey(m, p), false);
    if (info.type === 'video') {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = src;
      await new Promise((res) => { v.onloadeddata = res; v.onerror = res; setTimeout(res, 3000); });
      assets.push({ m, v });
    } else {
      const img = new Image(); img.src = src;
      try { await img.decode(); } catch (_) {}
      assets.push({ m, img });
    }
  }
  const first = new Date(items[0].createdAt), last = new Date(items[items.length - 1].createdAt);
  const fmtD = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const range = dayKey(first) === dayKey(last) ? fmtD(first) : `${fmtD(first)} – ${fmtD(last)}`;
  const segs = [{ kind: 'title', d: 1800 }, ...assets.map((a) => ({ kind: a.v ? 'video' : 'photo', a, d: a.v ? Math.min((a.v.duration && isFinite(a.v.duration) ? a.v.duration : 3) * 1000, 3500) : 2600 })), { kind: 'end', d: 1600 }];
  const total = segs.reduce((x, s) => x + s.d, 0);

  const mime = pickRecMime();
  const stream = c.captureStream(30);
  const chunks = [];
  let rec;
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 3_000_000 } : undefined); }
  catch (_) { rec = new MediaRecorder(stream); }
  rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  const stopped = new Promise((res) => { rec.onstop = res; });

  function cover(src, sw, sh, scale = 1) {
    if (!sw || !sh) return;
    const s = Math.max(W / sw, H / sh) * scale;
    const w = sw * s, h = sh * s;
    ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
  }
  function wrap(text, maxW, maxLines) {
    const words = text.split(/\s+/); const lines = []; let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; if (lines.length === maxLines) break; }
      else line = t;
    }
    if (lines.length < maxLines && line) lines.push(line);
    if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '…');
    return lines;
  }
  function overlay(m) {
    const g = ctx.createLinearGradient(0, H * 0.55, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.72)');
    ctx.fillStyle = g; ctx.fillRect(0, H * 0.55, W, H * 0.45);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic';
    if (m.caption) {
      ctx.font = `600 40px ${font}`;
      const lines = wrap(m.caption, W - 96, 4);
      lines.forEach((l, k) => ctx.fillText(l, 48, H - 120 - (lines.length - 1 - k) * 52));
    }
    ctx.font = `700 26px ${font}`; ctx.globalAlpha = 0.85;
    ctx.fillText(new Date(m.createdAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }), 48, H - 64);
    ctx.globalAlpha = 1;
  }
  function card(big, small) {
    ctx.fillStyle = ink; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = hl; ctx.fillRect(48, H / 2 + 20, 140, 14);
    ctx.fillStyle = '#fff'; ctx.font = `800 76px ${font}`; ctx.fillText(big, 48, H / 2);
    ctx.font = `600 34px ${font}`; ctx.globalAlpha = 0.85; ctx.fillText(small, 48, H / 2 + 90); ctx.globalAlpha = 1;
  }

  rec.start(500);
  let k = 0, segStart = performance.now(), doneBefore = 0;
  const begin = (s) => { if (s && s.kind === 'video') { s.a.v.currentTime = 0; s.a.v.play().catch(() => {}); } };
  begin(segs[0]);
  await new Promise((resolve) => {
    function frame() {
      if (reelCancel) return resolve();
      const s = segs[k];
      const t = performance.now() - segStart;
      if (s.kind === 'title') card(group.title, range);
      else if (s.kind === 'end') card('Moments', `${items.length} moment${items.length > 1 ? 's' : ''} · ${range}`);
      else {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = Math.min(1, t / 250);
        if (s.kind === 'photo') cover(s.a.img, s.a.img.naturalWidth, s.a.img.naturalHeight, 1 + 0.08 * (t / s.d));
        else cover(s.a.v, s.a.v.videoWidth, s.a.v.videoHeight);
        ctx.globalAlpha = 1;
        overlay(s.a.m);
      }
      const pct = Math.min(100, Math.round(((doneBefore + Math.min(t, s.d)) / total) * 100));
      $('#reel-pct').textContent = pct + '%';
      $('#reel-bar').style.width = pct + '%';
      if (t >= s.d) {
        if (s.kind === 'video') s.a.v.pause();
        doneBefore += s.d; k++; segStart = performance.now();
        if (k >= segs.length) return resolve();
        begin(segs[k]);
      }
      requestAnimationFrame(frame);
    }
    frame();
  });
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  assets.forEach((a) => { if (a.v) { a.v.pause(); a.v.removeAttribute('src'); } });
  ov.hidden = true;
  if (reelCancel) { toast('Video cancelled'); return; }
  const type = (rec.mimeType || 'video/webm').split(';')[0];
  const blob = new Blob(chunks, { type });
  const name = `moments-${group.key}-${new Date().toISOString().slice(0, 10)}.${extFor(type)}`;
  metrics.event('reel_made');
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name);
  toast('Video saved');
}

/* =========================================================
   REMINDERS — one push a day at the user's time; the phone picks the words
   ========================================================= */
const reminders = (() => {
  const supported = () => !!CONFIG.pushURL && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const b64u = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (ch) => ch.charCodeAt(0)); };
  async function post(path, body) {
    const r = await fetch(CONFIG.pushURL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('push ' + r.status);
  }
  const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  function initUI() {
    const row = $('#reminder-row');
    if (!CONFIG.pushURL) { row.hidden = true; return; }
    row.hidden = false;
    const cb = $('#opt-reminder');
    cb.checked = localStorage.getItem('moments.reminder') === '1';
    $('#reminder-time').value = localStorage.getItem('moments.reminderTime') || '20:00';
    if (!supported() || (isIOS && !isStandalone())) {
      cb.disabled = true; $('#reminder-time').disabled = true;
      $('#reminder-line').textContent = isIOS && !isStandalone() ? 'Install the app to turn on reminders.' : 'This browser can’t show reminders.';
    }
  }
  async function enable() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications are blocked for this site.'); return false; }
    const reg = await navigator.serviceWorker.ready;
    const key = (await (await fetch(CONFIG.pushURL + '/vapid')).text()).trim();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(key) });
    await post('/subscribe', { sub: sub.toJSON(), time: $('#reminder-time').value, tz: tz() });
    localStorage.setItem('moments.reminder', '1');
    metrics.event('reminder_on');
    return true;
  }
  async function disable() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await post('/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    localStorage.setItem('moments.reminder', '0');
  }
  const fmt = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  $('#opt-reminder').onchange = async (e) => {
    const cb = e.target;
    cb.disabled = true;
    try {
      if (cb.checked) { const ok = await enable(); cb.checked = ok; if (ok) toast(`Reminder set for ${fmt($('#reminder-time').value)}`); }
      else { await disable(); toast('Reminder off'); }
    } catch (_) { cb.checked = !cb.checked; toast('Couldn’t reach the reminder service. Try again later.'); }
    cb.disabled = false;
  };
  $('#reminder-time').onchange = async (e) => {
    localStorage.setItem('moments.reminderTime', e.target.value);
    if (localStorage.getItem('moments.reminder') !== '1') return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await post('/subscribe', { sub: sub.toJSON(), time: e.target.value, tz: tz() }); toast(`Reminder moved to ${fmt(e.target.value)}`); }
    } catch (_) { toast('Couldn’t update the reminder.'); }
  };
  return { initUI };
})();


/* =========================================================
   ALBUMS (collections) — names live here; moments carry album ids
   ========================================================= */
const albums = (() => {
  const KEY = 'moments.collections';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (_) { return []; } };
  const save = (l) => { try { localStorage.setItem(KEY, JSON.stringify(l)); } catch (_) {} };
  return {
    list: load,
    get: (id) => load().find((c) => c.id === id),
    create(name) {
      name = name.trim().slice(0, 40);
      if (!name) return null;
      const l = load();
      const dup = l.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (dup) return dup;
      const c = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, createdAt: new Date().toISOString() };
      l.push(c); save(l);
      metrics.event('album_created');
      return c;
    },
    rename(id, name) { const l = load(); const c = l.find((x) => x.id === id); if (c && name.trim()) { c.name = name.trim().slice(0, 40); save(l); } },
    async remove(id) {
      save(load().filter((c) => c.id !== id));
      for (const m of state.memories) {
        if ((m.collections || []).includes(id)) { m.collections = m.collections.filter((x) => x !== id); m.updatedAt = new Date().toISOString(); await store.put(m); }
      }
    },
    merge(incoming) { const l = load(); for (const c of incoming) if (c && c.id && !l.find((x) => x.id === c.id)) l.push(c); save(l); },
    items: (id) => state.memories.filter((m) => (m.collections || []).includes(id)),
  };
})();

// Album picker sheet: tick albums, or create one. onDone(ids) on close.
let pickerSel = [], pickerDone = null;
function openPicker(selected, onDone) {
  pickerSel = [...selected]; pickerDone = onDone;
  $('#picker-input').value = '';
  renderPicker();
  $('#scrim').hidden = false; $('#picker').hidden = false;
}
function renderPicker() {
  const l = albums.list();
  $('#picker-list').innerHTML = l.length
    ? l.map((c) => `<button class="pick${pickerSel.includes(c.id) ? ' on' : ''}" data-id="${c.id}"><span class="box"></span>${escapeHTML(c.name)}</button>`).join('')
    : '<p class="picker-empty">No albums yet. Name your first one below.</p>';
}
$('#picker-list').addEventListener('click', (e) => {
  const b = e.target.closest('.pick'); if (!b) return;
  const id = b.dataset.id;
  pickerSel = pickerSel.includes(id) ? pickerSel.filter((x) => x !== id) : [...pickerSel, id];
  haptic(6); renderPicker();
});
function pickerCreate() {
  const c = albums.create($('#picker-input').value);
  $('#picker-input').value = '';
  if (c && !pickerSel.includes(c.id)) pickerSel.push(c.id);
  renderPicker();
}
$('#picker-create').onclick = pickerCreate;
$('#picker-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pickerCreate(); } });
function closePicker() {
  if ($('#picker').hidden) return;
  if ($('#picker-input').value.trim()) pickerCreate();
  $('#picker').hidden = true;
  if ($('#sheet').hidden && $('#howto').hidden) $('#scrim').hidden = true;
  const cb = pickerDone; pickerDone = null;
  if (cb) cb(pickerSel);
}
$('#picker-done').onclick = closePicker;
$('#scrim').addEventListener('click', closePicker);

function thumbGrid(box, list, onOpen) {
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const m of list) {
    const b = document.createElement('button');
    b.className = 'res';
    const icons = [partCount(m) > 1 ? `<span>${partCount(m)}</span>` : '', m.type === 'video' ? '<span>▶</span>' : '', m.voice ? '<span>🎙</span>' : ''].join('');
    b.innerHTML = `<img alt=""><div class="ri">${icons}</div>`;
    b.setAttribute('aria-label', m.caption || dayLabel(new Date(m.createdAt)));
    mediaURL(m.id, true).then((u) => { b.querySelector('img').src = u; });
    b.onclick = () => onOpen(m);
    frag.appendChild(b);
  }
  box.appendChild(frag);
}

function renderAlbums() {
  const showDetail = !!state.openAlbum && albums.get(state.openAlbum);
  $('#col-list').hidden = !!showDetail;
  $('#col-detail').hidden = !showDetail;
  $('#col-menu').hidden = true;
  if (showDetail) {
    const c = albums.get(state.openAlbum);
    const items = albums.items(c.id);
    $('#col-name').textContent = c.name;
    $('#col-count').textContent = `${items.length} moment${items.length === 1 ? '' : 's'}`;
    $('#col-play').disabled = !items.length;
    $('#col-reel').hidden = items.length < 3 || !(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);
    $('#col-empty').hidden = items.length > 0;
    thumbGrid($('#col-items'), items, (m) => openViewer(m.id, items));
    return;
  }
  const grid = $('#col-grid');
  grid.innerHTML = '';
  for (const c of albums.list()) {
    const items = albums.items(c.id);
    const b = document.createElement('button');
    b.className = 'col-card';
    b.innerHTML = `<div class="col-cover">${items.length ? '<img alt="">' : '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="m21 17-5-5-9 9"/></svg>'}</div><b>${escapeHTML(c.name)}</b><span>${items.length} moment${items.length === 1 ? '' : 's'}</span>`;
    if (items.length) mediaURL(items[0].id, true).then((u) => { b.querySelector('img').src = u; });
    b.onclick = () => { state.openAlbum = c.id; renderAlbums(); $('#feed').scrollTo({ top: 0 }); };
    grid.appendChild(b);
  }
  const nb = document.createElement('button');
  nb.className = 'col-card new';
  nb.innerHTML = '<div class="col-cover"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></div><b>New album</b><span>Trips, firsts, food…</span>';
  nb.onclick = () => {
    const name = prompt('Name your album');
    if (name && albums.create(name)) renderAlbums();
  };
  grid.appendChild(nb);
}
$('#col-back').onclick = () => { state.openAlbum = null; renderAlbums(); };
$('#col-menu-btn').onclick = () => { $('#col-menu').hidden = !$('#col-menu').hidden; };
$('#col-rename').onclick = () => {
  const c = albums.get(state.openAlbum); if (!c) return;
  const name = prompt('Rename album', c.name);
  if (name) { albums.rename(c.id, name); renderAlbums(); }
};
$('#col-delete').onclick = async () => {
  const c = albums.get(state.openAlbum); if (!c) return;
  if (!confirm(`Delete the album “${c.name}”? Its moments stay in your feed.`)) return;
  await albums.remove(c.id);
  state.openAlbum = null; renderAlbums(); renderFeed();
  toast('Album deleted');
};
$('#col-play').onclick = () => {
  const c = albums.get(state.openAlbum); if (!c) return;
  const items = asc(albums.items(c.id));
  if (items.length) player.open({ key: 'album:' + c.id, title: c.name, items, reel: true });
};
$('#col-reel').onclick = () => {
  const c = albums.get(state.openAlbum); if (!c) return;
  makeReel({ key: 'album', title: c.name, items: asc(albums.items(c.id)) });
};

/* =========================================================
   SEARCH — captions, #tags, mood and quick filters
   ========================================================= */
state.filters = new Set();
function searchResults() {
  const q = $('#sq').value.trim().toLowerCase();
  const tq = q.startsWith('#') ? q.slice(1) : null;
  return state.memories.filter((m) => {
    if (q) {
      const inTags = (m.tags || []).some((t) => (tq != null ? t.startsWith(tq) : t.includes(q)));
      if (!(inTags || (tq == null && m.caption.toLowerCase().includes(q)))) return false;
    }
    for (const f of state.filters) {
      if (f === 'voice' && !m.voice) return false;
      if (f === 'video' && m.type !== 'video' && !(m.parts || []).some((pt) => pt.type === 'video')) return false;
      if (f === 'fav' && !m.favorite) return false;
      if (f.startsWith('mood:') && m.mood !== f.slice(5)) return false;
      if (f.startsWith('tag:') && !(m.tags || []).includes(f.slice(4))) return false;
    }
    return true;
  });
}
function renderSearch() {
  const moods = [...new Set(state.memories.map((m) => m.mood).filter(Boolean))];
  const tagCounts = new Map();
  for (const m of state.memories) for (const t of m.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
  const chips = [
    ['fav', '♥ Favourites'], ['voice', '🎙 Voice'], ['video', '▶ Videos'],
    ...moods.map((m) => ['mood:' + m, m]),
    ...topTags.map((t) => ['tag:' + t, '#' + t]),
  ];
  $('#filters').innerHTML = chips.map(([k, l]) => `<button class="filter${state.filters.has(k) ? ' on' : ''}" data-k="${escapeHTML(k)}">${escapeHTML(l)}</button>`).join('');
  const res = searchResults();
  const active = $('#sq').value.trim() || state.filters.size;
  $('#s-empty').hidden = res.length > 0;
  $('#s-empty').textContent = state.memories.length ? 'Nothing matches.' : 'Your moments will show up here.';
  thumbGrid($('#results'), res, (m) => openViewer(m.id, res));
  $('#results').setAttribute('aria-label', active ? `${res.length} results` : 'All moments');
}
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('.filter'); if (!b) return;
  const k = b.dataset.k;
  state.filters.has(k) ? state.filters.delete(k) : state.filters.add(k);
  haptic(6); renderSearch();
});
let sqTimer;
$('#sq').addEventListener('input', () => { clearTimeout(sqTimer); sqTimer = setTimeout(renderSearch, 120); });

/* =========================================================
   SHARE — the original files, or a Moments card
   ========================================================= */
async function shareMoment(m) {
  const files = [];
  for (let p = 0; p < partCount(m); p++) {
    const info = partInfo(m, p);
    const blob = await store.getMedia(partKey(m, p));
    if (blob) files.push(new File([blob], `moment-${m.createdAt.slice(0, 10)}${p ? '-' + (p + 1) : ''}.${extFor(info.mime)}`, { type: info.mime }));
  }
  if (!files.length) return;
  const text = m.caption || '';
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, text }); metrics.event('shared'); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  files.forEach((f) => download(f, f.name));
  metrics.event('shared');
  toast(files.length > 1 ? 'Saved the files' : 'Saved the file');
}
async function shareCard(m, p = 0) {
  const info = partInfo(m, p);
  if (info.type !== 'photo') return;
  const img = new Image();
  img.src = await mediaURL(partKey(m, p), false);
  try { await img.decode(); } catch (_) {}
  const W = 1080, H = 1350, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const font = getComputedStyle(document.body).fontFamily;
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#DCE5F0'; ctx.lineWidth = 2;
  for (let x = 0; x <= W; x += 45) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 45) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const px = 70, py = 70, pw = W - 140, ph = 900;
  ctx.fillStyle = '#14213D'; ctx.fillRect(px + 10, py + 10, pw, ph);
  ctx.save(); ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
  const sc = Math.max(pw / img.naturalWidth, ph / img.naturalHeight);
  const w = img.naturalWidth * sc, h = img.naturalHeight * sc;
  ctx.drawImage(img, px + (pw - w) / 2, py + (ph - h) / 2, w, h);
  ctx.restore();
  ctx.strokeStyle = '#14213D'; ctx.lineWidth = 5; ctx.strokeRect(px, py, pw, ph);
  ctx.fillStyle = '#14213D'; ctx.textBaseline = 'alphabetic';
  let y = py + ph + 95;
  if (m.caption) {
    ctx.font = `600 46px ${font}`;
    const words = m.caption.split(/\s+/); const lines = []; let line = '';
    for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (ctx.measureText(t).width > pw && line) { lines.push(line); line = wd; } else line = t; }
    if (line) lines.push(line);
    const shown = lines.slice(0, 3);
    if (lines.length > 3) shown[2] = shown[2].replace(/\s*\S*$/, '…');
    shown.forEach((l, k) => ctx.fillText(l, px, y + k * 58));
    y += shown.length * 58;
  }
  ctx.font = `700 30px ${font}`; ctx.fillStyle = '#4A5672';
  ctx.fillText(new Date(m.createdAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + (m.mood ? '  ' + m.mood : ''), px, H - 60);
  ctx.font = `800 34px ${font}`; ctx.fillStyle = '#14213D';
  const mark = 'Moments', mw = ctx.measureText(mark).width;
  ctx.fillStyle = '#F4B740'; ctx.fillRect(W - px - mw, H - 72, mw, 14);
  ctx.fillStyle = '#14213D'; ctx.fillText(mark, W - px - mw, H - 60);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  const file = new File([blob], `moment-card-${m.createdAt.slice(0, 10)}.jpg`, { type: 'image/jpeg' });
  metrics.event('shared_card');
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text: m.caption || '' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, file.name);
  toast('Card saved');
}

// A reminder (or its notification) asks us to open somewhere specific.
function handleOpen(where) {
  if (where === 'camera') { state.captureStart = performance.now(); openCamera(); return; }
  const gs = storyGroups();
  const g = gs.find((x) => x.key === where) || gs.find((x) => x.key === 'week') || gs[0];
  if (g) player.open(g);
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.open) { metrics.event('reminder_opened'); handleOpen(e.data.open); }
  });
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
  if (state.draft && !state.draft.editingId) {
    closeCompose({ keepDraft: true });
    _show('feed');
    toast('Kept as a draft', { label: 'Open', fn: async () => { const dr = await loadDraft(); if (dr) openCompose(dr); } }, 5000);
    return;
  }
  _show('feed');
});

/* =========================================================
   BOOT
   ========================================================= */
document.body.classList.add('on-feed');
(async function boot() {
  try { await reload(); } catch (e) { toast('Storage is unavailable in this browser mode.'); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (isStandalone() && !localStorage.getItem('moments.standaloneSeen')) {
    localStorage.setItem('moments.standaloneSeen', '1');
    metrics.event('opened_installed');
  }
  const openParam = new URLSearchParams(location.search).get('open');
  if (openParam) {
    history.replaceState({ s: 'feed' }, '', location.pathname);
    metrics.event('reminder_opened');
    handleOpen(openParam);
    return;
  }
  if (await offerDraft()) return; // don't jump to the camera over an unsaved moment
  // Fast path: open straight to camera if allowed before and the user wants it.
  const wantCam = localStorage.getItem('moments.camFirst') !== '0' && localStorage.getItem('moments.camOK') === '1';
  if (wantCam && navigator.permissions && navigator.permissions.query) {
    try {
      const p = await navigator.permissions.query({ name: 'camera' });
      if (p.state === 'granted') { state.captureStart = performance.now(); openCamera(); }
    } catch (_) {}
  }
})();
