/* Moments: printable photo book maker.
 * Builds a print-shop-ready PDF on the phone: 300 DPI pages, 3 mm bleed, crop marks,
 * TrimBox/BleedBox set. Nothing is uploaded. Uses globals from app.js. */
'use strict';

const BOOK = {
  BLEED: 3, SLUG: 6, DPI: 300, PREVIEW_DPI: 40, LOWRES_DPI: 150,
  SIZES: {
    '6x6': { label: '6 × 6 in', mm: '152 × 152 mm', W: 152.4, H: 152.4, margin: 11 },
    '8x8': { label: '8 × 8 in', mm: '203 × 203 mm', W: 203.2, H: 203.2, margin: 14 },
    a5: { label: 'A5 portrait', mm: '148 × 210 mm', W: 148, H: 210, margin: 12 },
  },
  THEMES: {
    classic: { bg: '#FFFFFF', ink: '#1E1E22', muted: '#6E6E76', serif: 'Georgia, "Times New Roman", "Noto Serif", serif', sans: '-apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif' },
    graph: { bg: '#FFFFFF', grid: '#DCE5F0', ink: '#14213D', muted: '#4A5672', hl: '#F4B740', red: '#C2452D', sans: '-apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif' },
  },
};

const bk = {
  step: 0, size: '8x8', theme: 'classic', layout: 'mix', text: 'both',
  source: 'all', albumId: '', from: '', to: '', picked: new Set(),
  title: '', subtitle: '', coverKey: '', titleTouched: false, subTouched: false,
  pdf: null, building: false, cancel: false,
};
const STEPS = ['Size', 'Moments', 'Cover', 'Layout', 'Review'];
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const niceDate = (d, withYear = true) => d.toLocaleDateString('en-GB', withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });

/* ---------------- selection ---------------- */
function bookMoments() {
  let list = state.memories;
  if (bk.source === 'album') list = bk.albumId ? albums.items(bk.albumId) : [];
  else if (bk.source === 'favs') list = list.filter((m) => m.favorite);
  else if (bk.source === 'range') {
    const from = bk.from ? new Date(bk.from + 'T00:00:00') : null, to = bk.to ? new Date(bk.to + 'T23:59:59') : null;
    list = list.filter((m) => { const d = new Date(m.createdAt); return (!from || d >= from) && (!to || d <= to); });
  } else if (bk.source === 'pick') list = list.filter((m) => bk.picked.has(m.id));
  return asc(list);
}
function bookShots(moments = bookMoments()) {
  const shots = []; let videos = 0;
  for (const m of moments) {
    let first = true;
    for (let p = 0; p < partCount(m); p++) {
      const info = partInfo(m, p);
      if (info.type !== 'photo') { videos++; continue; }
      shots.push({ m, p, key: partKey(m, p), w: info.width || 0, h: info.height || 0, first });
      first = false;
    }
  }
  return { shots, videos };
}
function defaultTitle() {
  if (bk.source === 'album') { const a = albums.get(bk.albumId); return a ? a.name : 'Our moments'; }
  if (bk.source === 'favs') return 'Favourite moments';
  const ms = bookMoments();
  if (ms.length) {
    const a = new Date(ms[0].createdAt), b = new Date(ms[ms.length - 1].createdAt);
    if (a.getFullYear() === b.getFullYear() && a.getMonth() === 0 && bk.source === 'range' && bk.from && bk.from.endsWith('-01-01')) return `${a.getFullYear()} in moments`;
  }
  return 'Our moments';
}
function defaultSubtitle() {
  const ms = bookMoments();
  if (!ms.length) return '';
  const a = new Date(ms[0].createdAt), b = new Date(ms[ms.length - 1].createdAt);
  if (dayKey(a) === dayKey(b)) return niceDate(a);
  if (a.getFullYear() === b.getFullYear()) return `${niceDate(a, false)} – ${niceDate(b)}`;
  return `${niceDate(a)} – ${niceDate(b)}`;
}
function refreshDefaults() {
  if (!bk.titleTouched) bk.title = defaultTitle();
  if (!bk.subTouched) bk.subtitle = defaultSubtitle();
  const { shots } = bookShots();
  if (!shots.find((s) => s.key === bk.coverKey)) {
    const fav = shots.find((s) => s.m.favorite);
    bk.coverKey = (fav || shots[0] || {}).key || '';
  }
}

/* ---------------- page plan ---------------- */
function planBook() {
  const { shots } = bookShots();
  const pages = [{ type: 'cover' }, { type: 'title' }];
  const per = { one: () => 1, grid: () => 4 };
  let i = 0, k = 0;
  const pattern = [1, 2, 3, 2];
  while (i < shots.length) {
    let n;
    if (bk.layout === 'mix') n = shots[i].m.favorite && shots[i].first ? 1 : pattern[k++ % pattern.length];
    else n = per[bk.layout]();
    const slots = shots.slice(i, i + n);
    pages.push({ type: 'photos', slots });
    i += slots.length;
  }
  pages.push({ type: 'end' });
  if (pages.length % 2 === 1) pages.splice(pages.length - 1, 0, { type: 'blank' }); // print shops want an even page count
  return pages;
}

/* ---------------- geometry ---------------- */
function slotBoxes(n, g, textOn) {
  const f = g.W / 203.2, m = g.margin, gap = 5 * f;
  const x0 = m, y0 = m, w = g.W - 2 * m, h = g.H - 2 * m;
  const tBig = textOn ? 17 * f : 0, tSmall = textOn ? 10 * f : 0;
  const portrait = g.H > g.W * 1.1;
  if (n === 1) return [{ x: x0, y: y0, w, h: h - tBig, t: tBig, big: true }];
  if (n === 2) {
    if (portrait) { const hh = (h - gap - 2 * tSmall) / 2; return [{ x: x0, y: y0, w, h: hh, t: tSmall }, { x: x0, y: y0 + hh + tSmall + gap, w, h: hh, t: tSmall }]; }
    const ww = (w - gap) / 2, hh = Math.min(h - tSmall, ww * 1.3), yy = y0 + (h - hh - tSmall) / 2;
    return [{ x: x0, y: yy, w: ww, h: hh, t: tSmall }, { x: x0 + ww + gap, y: yy, w: ww, h: hh, t: tSmall }];
  }
  if (n === 3) {
    const topH = (h - gap - 2 * tSmall) * 0.58, botH = h - gap - 2 * tSmall - topH, ww = (w - gap) / 2;
    const yb = y0 + topH + tSmall + gap;
    return [{ x: x0, y: y0, w, h: topH, t: tSmall }, { x: x0, y: yb, w: ww, h: botH, t: tSmall }, { x: x0 + ww + gap, y: yb, w: ww, h: botH, t: tSmall }];
  }
  const ww = (w - gap) / 2, hh = (h - gap - 2 * tSmall) / 2;
  return [0, 1, 2, 3].map((j) => ({ x: x0 + (j % 2) * (ww + gap), y: y0 + Math.floor(j / 2) * (hh + tSmall + gap), w: ww, h: hh, t: tSmall }));
}
function slotDPI(slot, box) {
  if (!slot.w || !slot.h) return 999;
  const bw = box.w / 25.4, bh = box.h / 25.4;
  const scale = Math.max(bw / slot.w, bh / slot.h); // inches per source pixel after cover-crop
  return 1 / scale;
}
function lowResCount(pages, g) {
  const textOn = bk.text !== 'none';
  let n = 0;
  pages.forEach((pg) => {
    if (pg.type === 'photos') {
      const boxes = slotBoxes(pg.slots.length, g, textOn);
      pg.low = pg.slots.some((s, j) => slotDPI(s, boxes[j]) < BOOK.LOWRES_DPI);
      if (pg.low) n++;
    } else if (pg.type === 'cover') {
      const s = bookShots().shots.find((x) => x.key === bk.coverKey);
      pg.low = !!s && slotDPI(s, { w: g.W + 2 * BOOK.BLEED, h: g.H * 0.74 + BOOK.BLEED }) < BOOK.LOWRES_DPI;
      if (pg.low) n++;
    }
  });
  return n;
}

/* ---------------- drawing (units: mm in trim coordinates) ---------------- */
function wrapLines(ctx, text, maxW, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  for (const wd of words) {
    const t = line ? line + ' ' + wd : wd;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = wd; if (lines.length === maxLines) { line = ''; break; } }
    else line = t;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && lines.join(' ').length < words.join(' ').length) {
    let last = lines[maxLines - 1];
    while (ctx.measureText(last + '…').width > maxW && last.includes(' ')) last = last.replace(/\s+\S*$/, '');
    lines[maxLines - 1] = last + '…';
  }
  // very long single words: hard-break
  return lines.map((l) => { while (ctx.measureText(l).width > maxW && l.length > 4) l = l.slice(0, -2) + '…'; return l; });
}
function coverDraw(ctx, bmp, x, y, w, h) {
  const bw = bmp.width, bh = bmp.height;
  const s = Math.max(w / bw, h / bh);
  const sw = w / s, sh = h / s;
  ctx.drawImage(bmp, (bw - sw) / 2, (bh - sh) / 2, sw, sh, x, y, w, h);
}
function gridBG(ctx, g, th) {
  ctx.fillStyle = th.bg; ctx.fillRect(-BOOK.BLEED, -BOOK.BLEED, g.W + 2 * BOOK.BLEED, g.H + 2 * BOOK.BLEED);
  if (!th.grid) return;
  ctx.strokeStyle = th.grid; ctx.lineWidth = 0.25;
  for (let x = 0; x <= g.W + 0.1; x += 5) { ctx.beginPath(); ctx.moveTo(x, -BOOK.BLEED); ctx.lineTo(x, g.H + BOOK.BLEED); ctx.stroke(); }
  for (let y = 0; y <= g.H + 0.1; y += 5) { ctx.beginPath(); ctx.moveTo(-BOOK.BLEED, y); ctx.lineTo(g.W + BOOK.BLEED, y); ctx.stroke(); }
}
function photoFrame(ctx, bmp, b, th, themeName) {
  if (themeName === 'graph') {
    ctx.fillStyle = th.ink; ctx.fillRect(b.x + 1.2, b.y + 1.2, b.w, b.h);
    if (bmp) coverDraw(ctx, bmp, b.x, b.y, b.w, b.h); else { ctx.fillStyle = '#E6ECF4'; ctx.fillRect(b.x, b.y, b.w, b.h); }
    ctx.strokeStyle = th.ink; ctx.lineWidth = 0.5; ctx.strokeRect(b.x, b.y, b.w, b.h);
  } else if (bmp) coverDraw(ctx, bmp, b.x, b.y, b.w, b.h);
  else { ctx.fillStyle = '#EEE'; ctx.fillRect(b.x, b.y, b.w, b.h); }
}
function slotText(ctx, slot, b, th, themeName, g) {
  if (bk.text === 'none' || !b.t || !slot.first) return;
  const f = g.W / 203.2;
  const showDate = bk.text === 'both' || bk.text === 'dates';
  const showCap = (bk.text === 'both' || bk.text === 'captions') && slot.m.caption;
  const d = new Date(slot.m.createdAt);
  const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) + (slot.m.mood ? '  ' + slot.m.mood : '');
  const big = !!b.big;
  let y = b.y + b.h + (big ? 5.5 : 3.6) * f;
  ctx.textBaseline = 'top';
  const center = themeName === 'classic' && big;
  ctx.textAlign = center ? 'center' : 'left';
  const tx = center ? b.x + b.w / 2 : b.x;
  if (showDate) {
    const size = (big ? 2.9 : 2.3) * f;
    ctx.font = `700 ${size}px ${themeName === 'classic' ? th.sans : th.sans}`;
    const label = themeName === 'classic' ? dateStr.toUpperCase() : dateStr;
    if (themeName === 'graph') {
      const wv = Math.min(ctx.measureText(label).width + 2.4 * f, b.w);
      ctx.fillStyle = th.hl; ctx.fillRect(tx - 0.2, y - 0.6 * f, wv, size + 1.2 * f);
      ctx.fillStyle = th.ink;
      ctx.fillText(label, tx + 1.2 * f, y);
    } else {
      ctx.fillStyle = th.muted;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${0.25 * f}px`;
      ctx.fillText(label, tx, y);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
    y += size + 1.8 * f;
  }
  if (showCap) {
    const size = (big ? 3.9 : 2.9) * f;
    ctx.font = themeName === 'classic' ? `italic 400 ${size}px ${th.serif}` : `600 ${size}px ${th.sans}`;
    ctx.fillStyle = th.ink;
    const maxLines = big ? 2 : (b.t > 9 * f ? 2 : 1);
    const avail = b.y + b.h + b.t - y;
    const lines = wrapLines(ctx, slot.m.caption, b.w, Math.max(1, Math.min(maxLines, Math.floor(avail / (size * 1.25)))));
    lines.forEach((l, j) => ctx.fillText(l, tx, y + j * size * 1.25));
  }
}
async function drawPage(ctx, pg, g, getBmp, pageNo, total, info) {
  const th = BOOK.THEMES[bk.theme], themeName = bk.theme, f = g.W / 203.2;
  gridBG(ctx, g, themeName === 'graph' ? th : { bg: th.bg });
  ctx.textBaseline = 'alphabetic';
  if (pg.type === 'cover') {
    const bmp = bk.coverKey ? await getBmp(bk.coverKey) : null;
    if (themeName === 'classic') {
      const ph = g.H * 0.74;
      if (bmp) coverDraw(ctx, bmp, -BOOK.BLEED, -BOOK.BLEED, g.W + 2 * BOOK.BLEED, ph + BOOK.BLEED);
      ctx.fillStyle = th.ink; ctx.textAlign = 'center';
      ctx.font = `400 ${10.5 * f}px ${th.serif}`;
      const lines = wrapLines(ctx, bk.title || 'Our moments', g.W - 2 * g.margin, 2);
      const ty = ph + (g.H - ph) * (lines.length > 1 ? 0.36 : 0.46);
      lines.forEach((l, j) => ctx.fillText(l, g.W / 2, ty + j * 11.5 * f));
      if (bk.subtitle) { ctx.font = `400 ${3.6 * f}px ${th.sans}`; ctx.fillStyle = th.muted; ctx.fillText(bk.subtitle, g.W / 2, ty + (lines.length - 1) * 11.5 * f + 8.5 * f); }
    } else {
      const b = { x: g.margin, y: g.margin, w: g.W - 2 * g.margin, h: g.H * 0.6 };
      photoFrame(ctx, bmp, b, th, themeName);
      ctx.textAlign = 'left'; ctx.fillStyle = th.ink;
      ctx.font = `800 ${11 * f}px ${th.sans}`;
      const lines = wrapLines(ctx, bk.title || 'Our moments', g.W - 2 * g.margin, 2);
      let ty = b.y + b.h + 16 * f;
      lines.forEach((l, j) => {
        const w = ctx.measureText(l).width;
        ctx.fillStyle = th.hl; ctx.fillRect(g.margin, ty + j * 12 * f - 3 * f, w, 3.2 * f);
        ctx.fillStyle = th.ink; ctx.fillText(l, g.margin, ty + j * 12 * f);
      });
      ty += (lines.length - 1) * 12 * f;
      if (bk.subtitle) { ctx.font = `600 ${4 * f}px ${th.sans}`; ctx.fillStyle = th.muted; ctx.fillText(bk.subtitle, g.margin, ty + 10 * f); }
    }
  } else if (pg.type === 'title') {
    ctx.textAlign = 'center';
    const cy = g.H * 0.44;
    ctx.fillStyle = th.ink;
    ctx.font = themeName === 'classic' ? `400 ${8.5 * f}px ${th.serif}` : `800 ${8.5 * f}px ${th.sans}`;
    const lines = wrapLines(ctx, bk.title || 'Our moments', g.W - 2 * g.margin, 3);
    lines.forEach((l, j) => {
      if (themeName === 'graph') { const w = ctx.measureText(l).width; ctx.fillStyle = th.hl; ctx.fillRect(g.W / 2 - w / 2, cy + j * 10 * f - 2.4 * f, w, 2.8 * f); ctx.fillStyle = th.ink; }
      ctx.fillText(l, g.W / 2, cy + j * 10 * f);
    });
    const yb = cy + (lines.length - 1) * 10 * f + 10 * f;
    ctx.fillStyle = th.muted; ctx.font = `400 ${3.4 * f}px ${th.sans}`;
    if (bk.subtitle) ctx.fillText(bk.subtitle, g.W / 2, yb);
    ctx.fillText(`${info.moments} moment${info.moments === 1 ? '' : 's'}`, g.W / 2, yb + 6 * f);
    if (themeName === 'classic') { ctx.strokeStyle = th.muted; ctx.lineWidth = 0.2; ctx.beginPath(); ctx.moveTo(g.W / 2 - 8 * f, cy - 12 * f); ctx.lineTo(g.W / 2 + 8 * f, cy - 12 * f); ctx.stroke(); }
  } else if (pg.type === 'photos') {
    const boxes = slotBoxes(pg.slots.length, g, bk.text !== 'none');
    for (let j = 0; j < pg.slots.length; j++) {
      const s = pg.slots[j], b = boxes[j];
      photoFrame(ctx, await getBmp(s.key), b, th, themeName);
      slotText(ctx, s, b, th, themeName, g);
    }
  } else if (pg.type === 'end') {
    ctx.textAlign = 'center'; ctx.fillStyle = th.muted;
    ctx.font = `400 ${3.2 * f}px ${themeName === 'classic' ? th.serif : th.sans}`;
    ctx.fillText('Made with Moments', g.W / 2, g.H * 0.5);
    ctx.font = `400 ${2.6 * f}px ${th.sans}`;
    ctx.fillText(new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), g.W / 2, g.H * 0.5 + 5 * f);
  }
  // page numbers on photo pages (inside the safe area)
  if (pg.type === 'photos' && pageNo) {
    ctx.textAlign = pageNo % 2 ? 'right' : 'left';
    ctx.fillStyle = th.muted; ctx.font = `400 ${2.3 * f}px ${th.sans}`;
    ctx.fillText(String(pageNo), pageNo % 2 ? g.W - g.margin : g.margin, g.H - g.margin * 0.42);
  }
}
function pageCanvas(g, dpi) {
  const pxPerMm = dpi / 25.4;
  const c = document.createElement('canvas');
  c.width = Math.round((g.W + 2 * BOOK.BLEED) * pxPerMm);
  c.height = Math.round((g.H + 2 * BOOK.BLEED) * pxPerMm);
  const ctx = c.getContext('2d');
  ctx.setTransform(pxPerMm, 0, 0, pxPerMm, BOOK.BLEED * pxPerMm, BOOK.BLEED * pxPerMm);
  return { c, ctx };
}
function bitmapLoader(thumbs) {
  const cache = new Map();
  return async (key) => {
    if (cache.has(key)) return cache.get(key);
    let blob = thumbs ? await store.getMedia(key, true) : null;
    if (!blob) blob = await store.getMedia(key);
    let bmp = null;
    try { bmp = blob ? await createImageBitmap(blob) : null; } catch (_) { bmp = null; }
    cache.set(key, bmp);
    if (cache.size > 12) { const [k0, b0] = cache.entries().next().value; if (b0 && b0.close) b0.close(); cache.delete(k0); }
    return bmp;
  };
}

/* ---------------- PDF writer ---------------- */
function pdfText(s) {
  // UTF-16BE hex string so any script works in document metadata
  let hex = 'FEFF';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) { const v = cp - 0x10000; hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0'); }
    else hex += cp.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}
function buildPDF(pageImgs, g, title) {
  const pt = (mm) => (mm * 72) / 25.4, r = (n) => n.toFixed(3);
  const W = pt(g.W), H = pt(g.H), b = pt(BOOK.BLEED), s = pt(BOOK.SLUG);
  const MW = W + 2 * (b + s), MH = H + 2 * (b + s);
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let pos = 0;
  const add = (x) => { const p = typeof x === 'string' ? enc.encode(x) : x; parts.push(p); pos += p instanceof Blob ? p.size : p.length; };
  const obj = (n, body) => { offsets[n] = pos; add(`${n} 0 obj\n${body}\nendobj\n`); };
  add('%PDF-1.4\n'); add(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const n = pageImgs.length;
  const pageObj = (i) => 4 + i * 3;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageImgs.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${n} >>`);
  const now = new Date(), d2 = (x) => String(x).padStart(2, '0');
  obj(3, `<< /Title ${pdfText(title)} /Creator ${pdfText('Moments photo book maker')} /Producer ${pdfText('Moments')} /CreationDate (D:${now.getFullYear()}${d2(now.getMonth() + 1)}${d2(now.getDate())}${d2(now.getHours())}${d2(now.getMinutes())}${d2(now.getSeconds())}) >>`);
  // crop marks sit in the slug, outside the bleed, at each trim corner
  const xL = s + b, xR = s + b + W, yB = s + b, yT = s + b + H, gapPt = 1.2;
  const marks = [
    [xL, 0, xL, s - gapPt], [xR, 0, xR, s - gapPt], [xL, MH - s + gapPt, xL, MH], [xR, MH - s + gapPt, xR, MH],
    [0, yB, s - gapPt, yB], [0, yT, s - gapPt, yT], [MW - s + gapPt, yB, MW, yB], [MW - s + gapPt, yT, MW, yT],
  ].map(([x1, y1, x2, y2]) => `${r(x1)} ${r(y1)} m ${r(x2)} ${r(y2)} l S`).join('\n');
  pageImgs.forEach((img, i) => {
    const po = pageObj(i), co = po + 1, io = po + 2;
    obj(po, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${r(MW)} ${r(MH)}] /BleedBox [${r(s)} ${r(s)} ${r(MW - s)} ${r(MH - s)}] /TrimBox [${r(xL)} ${r(yB)} ${r(xR)} ${r(yT)}] /Resources << /XObject << /Im0 ${io} 0 R >> >> /Contents ${co} 0 R >>`);
    const content = `q ${r(W + 2 * b)} 0 0 ${r(H + 2 * b)} ${r(s)} ${r(s)} cm /Im0 Do Q\nq 0.25 w 0 0 0 RG\n${marks}\nQ\n`;
    obj(co, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream`);
    offsets[io] = pos;
    add(`${io} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.blob.size} >>\nstream\n`);
    add(img.blob);
    add('\nendstream\nendobj\n');
  });
  const total = 4 + n * 3;
  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) x += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`;
  add(x);
  add(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/* ---------------- wizard ---------------- */
function openBook(preset = {}) {
  Object.assign(bk, { step: 0, pdf: null, building: false, cancel: false, titleTouched: false, subTouched: false, picked: new Set() });
  const first = state.memories.length ? new Date(state.memories[state.memories.length - 1].createdAt) : new Date();
  bk.from = isoDate(first); bk.to = isoDate(new Date());
  bk.source = 'all'; bk.albumId = (albums.list()[0] || {}).id || '';
  Object.assign(bk, preset);
  if (preset.title) bk.titleTouched = true;
  refreshDefaults();
  show('book');
  renderBook();
  metrics.event('book_started');
}
function bookSummary() {
  const { shots } = bookShots();
  const pages = planBook().length;
  const g = BOOK.SIZES[bk.size];
  return `${shots.length} photo${shots.length === 1 ? '' : 's'} · ${pages} pages · ${g.label}`;
}
const LAY_SVG = {
  one: '<svg class="lay" viewBox="0 0 60 54"><rect x="12" y="4" width="36" height="40" rx="1"/></svg>',
  mix: '<svg class="lay" viewBox="0 0 60 54"><rect x="4" y="4" width="24" height="40" rx="1"/><rect x="32" y="4" width="24" height="18" rx="1"/><rect x="32" y="26" width="24" height="18" rx="1"/></svg>',
  grid: '<svg class="lay" viewBox="0 0 60 54"><rect x="10" y="4" width="18" height="19" rx="1"/><rect x="32" y="4" width="18" height="19" rx="1"/><rect x="10" y="26" width="18" height="19" rx="1"/><rect x="32" y="26" width="18" height="19" rx="1"/></svg>',
};
function bookOpt(group, val, inner, on, extra = '') { return `<button class="b-opt${on ? ' on' : ''}${extra}" data-g="${group}" data-v="${val}">${inner}</button>`; }
function renderBook() {
  const body = $('#book-body');
  $('#book-step-k').textContent = `Step ${bk.step + 1} of ${STEPS.length}`;
  $('#book-step-t').textContent = ['Pick a size', 'Choose the moments', 'Cover', 'Layout and look', 'Review and build'][bk.step];
  $('#book-dots').innerHTML = STEPS.map((_, i) => `<i class="${i <= bk.step ? 'on' : ''}"></i>`).join('');
  $('#book-back').setAttribute('aria-label', bk.step ? 'Previous step' : 'Close the book maker');
  const next = $('#book-next');
  next.disabled = false; next.hidden = false;
  next.textContent = bk.step === STEPS.length - 1 ? (bk.pdf ? 'Done' : 'Build PDF') : 'Next';
  const { shots, videos } = bookShots();
  $('#book-sum').textContent = bookSummary();
  let h = '';
  if (bk.step === 0) {
    h += '<p class="b-q">Book size</p><p class="b-help">Every PDF is print-shop ready: 3 mm bleed and crop marks included.</p><div class="b-opts">';
    for (const [k, g] of Object.entries(BOOK.SIZES)) {
      const scale = 46 / Math.max(g.W, g.H);
      h += bookOpt('size', k, `<span class="shape" style="width:${Math.round(g.W * scale)}px;height:${Math.round(g.H * scale)}px"></span><b>${g.label}</b><span>${g.mm}</span>`, bk.size === k);
    }
    h += '</div>';
  } else if (bk.step === 1) {
    const al = albums.list(), favs = state.memories.filter((m) => m.favorite).length;
    h += '<p class="b-q">Which moments go in?</p><div class="b-opts list">';
    h += bookOpt('source', 'all', `<b>Everything</b><span>All ${state.memories.length} moments</span>`, bk.source === 'all');
    h += bookOpt('source', 'range', '<b>A date range</b><span>From and to dates</span>', bk.source === 'range');
    h += bookOpt('source', 'album', `<b>An album</b><span>${al.length ? al.length + ' album' + (al.length > 1 ? 's' : '') : 'No albums yet'}</span>`, bk.source === 'album', al.length ? '' : ' disabled');
    h += bookOpt('source', 'favs', `<b>Favourites</b><span>${favs} favourite${favs === 1 ? '' : 's'}</span>`, bk.source === 'favs', favs ? '' : ' disabled');
    h += bookOpt('source', 'pick', '<b>Hand-pick</b><span>Tap the ones you want</span>', bk.source === 'pick');
    h += '</div>';
    if (bk.source === 'range') h += `<div class="b-row"><input class="b-input" type="date" id="bk-from" value="${bk.from}" aria-label="From"><input class="b-input" type="date" id="bk-to" value="${bk.to}" aria-label="To"></div>`;
    if (bk.source === 'album') h += `<div class="b-row"><select class="b-input" id="bk-album" aria-label="Album">${al.map((a) => `<option value="${a.id}"${a.id === bk.albumId ? ' selected' : ''}>${escapeHTML(a.name)} (${albums.items(a.id).length})</option>`).join('')}</select></div>`;
    if (bk.source === 'pick') h += `<div class="b-row"><button class="pill-btn small ghost" id="bk-all">Select all</button><button class="pill-btn small ghost" id="bk-none">Clear</button></div><div class="b-pick" id="bk-pick"></div>`;
    h += `<p class="b-help" style="margin-top:12px">${shots.length} photo${shots.length === 1 ? '' : 's'} selected.${videos ? ` ${videos} video${videos > 1 ? 's' : ''} left out (videos don't print).` : ''}</p>`;
    next.disabled = shots.length === 0;
  } else if (bk.step === 2) {
    h += `<p class="b-q">Title</p><input class="b-input" id="bk-title" maxlength="60" value="${escapeHTML(bk.title)}" placeholder="Our moments">`;
    h += `<p class="b-q">Subtitle <span style="font-weight:600;color:var(--ink-3)">(optional)</span></p><input class="b-input" id="bk-sub" maxlength="80" value="${escapeHTML(bk.subtitle)}" placeholder="Dates, a place, a line">`;
    h += '<p class="b-q">Cover photo</p><div class="b-cover" id="bk-cover"></div>';
  } else if (bk.step === 3) {
    h += '<p class="b-q">Layout</p><div class="b-opts">';
    h += bookOpt('layout', 'one', `${LAY_SVG.one}<b>One per page</b><span>Big and calm</span>`, bk.layout === 'one');
    h += bookOpt('layout', 'mix', `${LAY_SVG.mix}<b>Mix</b><span>1, 2 or 3 per page; favourites get a page</span>`, bk.layout === 'mix');
    h += bookOpt('layout', 'grid', `${LAY_SVG.grid}<b>Grid</b><span>4 per page, fewer pages</span>`, bk.layout === 'grid');
    h += '</div><p class="b-q">Captions and dates</p><div class="b-seg">';
    for (const [k, l] of [['both', 'Captions + dates'], ['captions', 'Captions only'], ['dates', 'Dates only'], ['none', 'Photos only']]) h += `<button class="${bk.text === k ? 'on' : ''}" data-g="text" data-v="${k}">${l}</button>`;
    h += '</div><p class="b-q">Look</p><div class="b-opts two">';
    h += bookOpt('theme', 'classic', '<b>Clean classic</b><span>White pages, serif captions</span>', bk.theme === 'classic');
    h += bookOpt('theme', 'graph', '<b>Graph Paper</b><span>Grid paper, ink frames, highlighter dates</span>', bk.theme === 'graph');
    h += '</div>';
  } else {
    const g = BOOK.SIZES[bk.size], pages = planBook(), low = lowResCount(pages, g);
    const lay = { one: 'One per page', mix: 'Mix', grid: 'Grid' }[bk.layout], txt = { both: 'Captions + dates', captions: 'Captions only', dates: 'Dates only', none: 'Photos only' }[bk.text];
    h += `<div class="b-sumlist">
      <div><span>Size</span><b>${g.label} (${g.mm})</b></div>
      <div><span>Moments</span><b>${bookMoments().length} moments, ${shots.length} photos</b></div>
      <div><span>Pages</span><b>${pages.length} (even, cover included)</b></div>
      <div><span>Layout</span><b>${lay} · ${txt}</b></div>
      <div><span>Look</span><b>${bk.theme === 'classic' ? 'Clean classic' : 'Graph Paper'}</b></div>
      <div><span>Title</span><b>${escapeHTML(bk.title || 'Our moments')}</b></div></div>`;
    if (low) h += `<div class="b-warn${low > pages.length / 3 ? ' red' : ''}"><b>${low} page${low > 1 ? 's' : ''} may print soft.</b> Those photos are under ${BOOK.LOWRES_DPI} DPI at this size. Try a smaller size, the Grid layout, or swap those photos.</div>`;
    h += '<p class="b-q">Preview</p><div class="b-preview" id="bk-preview"></div>';
    h += `<ul class="b-print-notes">
      <li>Trim size ${g.mm}, with 3 mm bleed on every side and crop marks. Tell the print shop: <b>trim at the marks, PDF has bleed</b>.</li>
      <li>Pages are 300 DPI images, ${pages.length} pages including the cover. Most shops print the first page as the cover.</li>
      <li>Made on this phone. Nothing is uploaded.</li></ul>`;
    h += '<div class="b-progress" id="bk-progress" hidden><b id="bk-prog-t">Building…</b><div class="meter"><span id="bk-prog-bar"></span></div><button class="text-btn" id="bk-cancel">Cancel</button></div>';
    h += `<div class="b-done" id="bk-done"${bk.pdf ? '' : ' hidden'}><button class="pill-btn" id="bk-download">Download PDF</button><button class="pill-btn ghost" id="bk-share">Share</button></div>`;
  }
  body.innerHTML = h;
  body.scrollTop = 0;
  if (bk.step === 1 && bk.source === 'pick') renderPick();
  if (bk.step === 2) renderCoverPick();
  if (bk.step === 4) renderPreview();
}
function renderPick() {
  const box = $('#bk-pick'); if (!box) return;
  const list = asc(state.memories.filter((m) => partInfo(m, 0).type === 'photo' || (m.parts || []).some((p) => p.type === 'photo')));
  box.innerHTML = '';
  for (const m of list) {
    const b = document.createElement('button');
    b.className = bk.picked.has(m.id) ? 'on' : '';
    b.setAttribute('aria-label', (m.caption || dayLabel(new Date(m.createdAt))) + (bk.picked.has(m.id) ? ', selected' : ''));
    b.innerHTML = '<img alt="">';
    mediaURL(m.id, true).then((u) => { b.querySelector('img').src = u; });
    b.onclick = () => { bk.picked.has(m.id) ? bk.picked.delete(m.id) : bk.picked.add(m.id); b.classList.toggle('on'); haptic(5); refreshDefaults(); syncStepState(); };
    box.appendChild(b);
  }
}
function syncStepState() {
  const { shots, videos } = bookShots();
  $('#book-sum').textContent = bookSummary();
  if (bk.step === 1) {
    $('#book-next').disabled = shots.length === 0;
    const help = [...document.querySelectorAll('#book-body .b-help')].pop();
    if (help) help.textContent = `${shots.length} photo${shots.length === 1 ? '' : 's'} selected.${videos ? ` ${videos} video${videos > 1 ? 's' : ''} left out (videos don't print).` : ''}`;
  }
}
function renderCoverPick() {
  const box = $('#bk-cover'); if (!box) return;
  const { shots } = bookShots();
  const ordered = [...shots.filter((s) => s.m.favorite), ...shots.filter((s) => !s.m.favorite)].slice(0, 60);
  box.innerHTML = '';
  for (const s of ordered) {
    const b = document.createElement('button');
    b.className = s.key === bk.coverKey ? 'on' : '';
    b.setAttribute('aria-label', 'Use as cover' + (s.m.caption ? ': ' + s.m.caption : ''));
    b.innerHTML = '<img alt="">';
    mediaURL(s.key, true).then((u) => { b.querySelector('img').src = u; });
    b.onclick = () => { bk.coverKey = s.key; box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
    box.appendChild(b);
  }
}
let previewToken = 0;
async function renderPreview() {
  const box = $('#bk-preview'); if (!box) return;
  const my = ++previewToken;
  const g = BOOK.SIZES[bk.size], pages = planBook();
  lowResCount(pages, g);
  const getBmp = bitmapLoader(true);
  const info = { moments: bookMoments().length };
  const firstPages = pages.slice(0, 9);
  for (let i = 0; i < firstPages.length; i++) {
    if (my !== previewToken) return;
    const { c, ctx } = pageCanvas(g, BOOK.PREVIEW_DPI);
    await drawPage(ctx, firstPages[i], g, getBmp, i, pages.length, info);
    const fig = document.createElement('figure');
    fig.appendChild(c);
    const label = firstPages[i].type === 'cover' ? 'Cover' : firstPages[i].type === 'title' ? 'Title page' : `Page ${i + 1}`;
    fig.insertAdjacentHTML('beforeend', `<figcaption>${label}</figcaption>${firstPages[i].low ? '<span class="lowres">May print soft</span>' : ''}`);
    box.appendChild(fig);
  }
  if (pages.length > firstPages.length) box.insertAdjacentHTML('beforeend', `<p class="b-help" style="grid-column:1/-1">+ ${pages.length - firstPages.length} more pages</p>`);
}
async function buildBook() {
  if (bk.building) return;
  bk.building = true; bk.cancel = false; bk.pdf = null;
  const g = BOOK.SIZES[bk.size], pages = planBook();
  const prog = $('#bk-progress'); prog.hidden = false;
  $('#book-next').disabled = true;
  const getBmp = bitmapLoader(false);
  const info = { moments: bookMoments().length };
  const imgs = [];
  try {
    for (let i = 0; i < pages.length; i++) {
      if (bk.cancel) throw new Error('cancelled');
      $('#bk-prog-t').textContent = `Building page ${i + 1} of ${pages.length}…`;
      $('#bk-prog-bar').style.width = Math.round((i / pages.length) * 100) + '%';
      const { c, ctx } = pageCanvas(g, BOOK.DPI);
      await drawPage(ctx, pages[i], g, getBmp, i, pages.length, info);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
      imgs.push({ blob, w: c.width, h: c.height });
      c.width = c.height = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
    $('#bk-prog-t').textContent = 'Putting the PDF together…';
    bk.pdf = buildPDF(imgs, g, bk.title || 'Our moments');
    $('#bk-prog-bar').style.width = '100%';
    $('#bk-prog-t').textContent = `Ready: ${pages.length} pages, ${(bk.pdf.size / 1e6).toFixed(1)} MB`;
    $('#bk-cancel').hidden = true;
    $('#bk-done').hidden = false;
    metrics.event('book_built');
    haptic([15, 40, 15]);
  } catch (e) {
    prog.hidden = true;
    toast(e.message === 'cancelled' ? 'Book cancelled' : 'Couldn’t build the book. Try fewer photos or a smaller size.');
  }
  bk.building = false;
  $('#book-next').disabled = false;
  $('#book-next').textContent = bk.pdf ? 'Done' : 'Build PDF';
}
const bookFileName = () => `moments-book-${bk.size}-${(bk.title || 'moments').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'moments'}.pdf`;

/* ---------------- events ---------------- */
$('#book-body').addEventListener('click', async (e) => {
  const o = e.target.closest('[data-g]');
  if (o) {
    const g = o.dataset.g, v = o.dataset.v;
    if (g === 'size') bk.size = v;
    if (g === 'source') { bk.source = v; if (v === 'pick' && !bk.picked.size) bookMoments(); bk.titleTouched = false; bk.subTouched = false; refreshDefaults(); }
    if (g === 'layout') bk.layout = v;
    if (g === 'text') bk.text = v;
    if (g === 'theme') bk.theme = v;
    haptic(6); renderBook(); return;
  }
  if (e.target.id === 'bk-all') { asc(state.memories).forEach((m) => bk.picked.add(m.id)); refreshDefaults(); renderBook(); }
  if (e.target.id === 'bk-none') { bk.picked.clear(); refreshDefaults(); renderBook(); }
  if (e.target.id === 'bk-cancel') bk.cancel = true;
  if (e.target.id === 'bk-download' && bk.pdf) { download(bk.pdf, bookFileName()); toast('PDF saved'); }
  if (e.target.id === 'bk-share' && bk.pdf) {
    const file = new File([bk.pdf], bookFileName(), { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: bk.title }); } catch (_) {} }
    else { download(bk.pdf, bookFileName()); toast('PDF saved'); }
  }
});
$('#book-body').addEventListener('change', (e) => {
  if (e.target.id === 'bk-from') bk.from = e.target.value;
  if (e.target.id === 'bk-to') bk.to = e.target.value;
  if (e.target.id === 'bk-album') bk.albumId = e.target.value;
  if (['bk-from', 'bk-to', 'bk-album'].includes(e.target.id)) { bk.titleTouched = false; bk.subTouched = false; refreshDefaults(); renderBook(); }
});
$('#book-body').addEventListener('input', (e) => {
  if (e.target.id === 'bk-title') { bk.title = e.target.value; bk.titleTouched = true; }
  if (e.target.id === 'bk-sub') { bk.subtitle = e.target.value; bk.subTouched = true; }
});
$('#book-next').onclick = () => {
  if (bk.step < STEPS.length - 1) { bk.step++; bk.pdf = null; renderBook(); return; }
  if (bk.pdf) { show('feed'); return; }
  buildBook();
};
$('#book-back').onclick = () => { if (bk.building) return; if (bk.step === 0) { show('feed'); return; } bk.step--; bk.pdf = null; renderBook(); };
$('#book-close').onclick = () => { if (bk.building) { bk.cancel = true; } show('feed'); };

// Entry points
$('#print-card').onclick = () => openBook();
$('#col-print').onclick = () => { const c = albums.get(state.openAlbum); if (c) openBook({ source: 'album', albumId: c.id, step: 0 }); };
$('#year-print').onclick = () => { const y = new Date().getFullYear(); openBook({ source: 'range', from: `${y}-01-01`, to: isoDate(new Date()), title: `${y} in moments` }); };

window.__moments = Object.assign(window.__moments || {}, { book: { bk, planBook, buildPDF, openBook, slotDPI } });
