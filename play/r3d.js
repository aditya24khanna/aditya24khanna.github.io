// Pothole Dash — 3D renderer (Three.js r160, self-hosted in ./vendor).
// The game simulation lives in index.html and is untouched by this file. This module only reads the
// world state through window.PD and draws it. If anything here fails, the game keeps its 2D renderer.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const L = 3.5;               // metres per lane width (world unit)
const TILE = 5.5;            // road texture repeat length, in lanes (5 lane dashes)
const hash = i => { let x = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const X = x => (x - 1.5) * L;          // lane coordinate -> metres across
const Zm = z => -z * L;                // depth ahead (lanes) -> metres (forward is -Z)

function makeCanvas(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); draw(g, w, h); return c; }
function tex(canvas, { repeat = [1, 1], srgb = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso; return t;
}
function rnd(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------- procedural textures
function asphaltCanvas() {
  return makeCanvas(512, 940, (g, w, h) => {
    const r = rnd(7);
    g.fillStyle = '#4a4c50'; g.fillRect(0, 0, w, h);
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 34; d[i] += n; d[i + 1] += n; d[i + 2] += n + 1; }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < 900; i++) { g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.18)'; g.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2); }
    // wheel tracks: slightly darker, smoother bands inside each lane
    for (let l = 0; l < 3; l++) for (const off of [0.28, 0.72]) { g.fillStyle = 'rgba(20,20,22,0.13)'; g.fillRect((l + off) * w / 3 - 9, 0, 18, h); }
    // tar patches
    for (let i = 0; i < 7; i++) { g.fillStyle = r() < 0.6 ? 'rgba(30,31,34,0.55)' : 'rgba(110,108,104,0.35)'; const pw = 40 + r() * 110, ph = 30 + r() * 120; g.fillRect(r() * (w - pw), r() * (h - ph), pw, ph); }
    // cracks
    g.strokeStyle = 'rgba(15,15,16,0.65)'; g.lineWidth = 1.6;
    for (let i = 0; i < 14; i++) { let x = r() * w, y = r() * h; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 50; y += (r() - 0.2) * 40; g.lineTo(x, y); } g.stroke(); }
    // oil stains in lane centres
    for (let i = 0; i < 6; i++) { const cx = (Math.floor(r() * 3) + 0.5) * w / 3, cy = r() * h; const gr = g.createRadialGradient(cx, cy, 2, cx, cy, 30); gr.addColorStop(0, 'rgba(10,10,12,0.45)'); gr.addColorStop(1, 'rgba(10,10,12,0)'); g.fillStyle = gr; g.fillRect(cx - 32, cy - 32, 64, 64); }
    // faded lane dashes: 5 per tile, 0.55 lane long
    const dash = h / 5;
    for (const lx of [1, 2]) for (let k = 0; k < 5; k++) {
      if (r() < 0.12) continue;
      g.fillStyle = `rgba(236,232,220,${0.55 + r() * 0.35})`; g.fillRect(lx * w / 3 - 4, k * dash + 6, 8, dash * 0.5);
      g.fillStyle = 'rgba(74,76,80,0.5)'; for (let s = 0; s < 6; s++) g.fillRect(lx * w / 3 - 4 + r() * 6, k * dash + 6 + r() * dash * 0.5, 3, 3);
    }
    g.fillStyle = 'rgba(236,232,220,0.42)'; g.fillRect(5, 0, 5, h); g.fillRect(w - 10, 0, 5, h);
  });
}
function noiseCanvas(seed, w = 256, h = 256, amp = 120) {
  return makeCanvas(w, h, (g) => { const r = rnd(seed), img = g.createImageData(w, h), d = img.data; for (let i = 0; i < d.length; i += 4) { const n = 128 + (r() - 0.5) * amp; d[i] = d[i + 1] = d[i + 2] = n; d[i + 3] = 255; } g.putImageData(img, 0, 0); });
}
function kerbCanvas() { return makeCanvas(64, 256, (g, w, h) => { g.fillStyle = '#e8bf2c'; g.fillRect(0, 0, w, h / 2); g.fillStyle = '#1c1d20'; g.fillRect(0, h / 2, w, h / 2); const r = rnd(3); for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.25})`; g.fillRect(r() * w, r() * h, 2, 2); } }); }
function pathCanvas() {
  return makeCanvas(256, 256, (g, w, h) => {
    const r = rnd(11), n = 4, s = w / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = 180 + (r() - 0.5) * 26, broken = r() < 0.12;
      g.fillStyle = broken ? '#7d776d' : `rgb(${v},${v - 6},${v - 18})`; g.fillRect(i * s, j * s, s, s);
      if (r() < 0.3) { g.strokeStyle = 'rgba(40,34,26,0.5)'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(i * s + r() * s, j * s); g.lineTo(i * s + r() * s, j * s + s); g.stroke(); }
    }
    g.strokeStyle = 'rgba(60,52,40,0.45)'; g.lineWidth = 2;
    for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, h); g.moveTo(0, i * s); g.lineTo(w, i * s); g.stroke(); }
  });
}
const FACADE = ['#dcc39a', '#c3d2bd', '#e4b59c', '#b9c6d6', '#ebdcbc', '#cbb6d6', '#d8d1c4', '#e9c886', '#f0e6d2', '#a9c4c0'];
const SIGNC = ['#b8352a', '#1f6fb2', '#e0a21a', '#2e8b57', '#7d3c98', '#d35400', '#0f766e', '#c0185b'];
function floorsCanvas(seed, lit) {
  // two storeys tall, so lit windows don't repeat every floor
  return makeCanvas(256, 320, (g, w, h) => {
    const r = rnd(seed), base = FACADE[seed % FACADE.length];
    g.fillStyle = lit ? '#000' : base; g.fillRect(0, 0, w, h);
    if (!lit) { const n = g.getImageData(0, 0, w, h), d = n.data; for (let i = 0; i < d.length; i += 4) { const k = (r() - 0.5) * 14; d[i] += k; d[i + 1] += k; d[i + 2] += k; } g.putImageData(n, 0, 0); g.fillStyle = 'rgba(70,50,30,0.12)'; for (let i = 0; i < 6; i++) g.fillRect(r() * w, 0, 3 + r() * 6, h); }
    const fh = h / 2;
    for (let f = 0; f < 2; f++) for (const wx of [0.12, 0.58]) {
      const x = wx * w, y = f * fh + fh * 0.22, ww = w * 0.3, wh = fh * 0.5;
      if (lit) { if (hash(seed * 31 + f * 7 + (wx > 0.5 ? 1 : 0)) > 0.42) { const c = r() < 0.7 ? '#ffcf7a' : '#cfe6ff'; g.fillStyle = c; g.fillRect(x + 3, y + 3, ww - 6, wh - 6); } continue; }
      g.fillStyle = '#e9e4da'; g.fillRect(x - 4, y - 4, ww + 8, wh + 8);
      const gl = g.createLinearGradient(0, y, 0, y + wh); gl.addColorStop(0, '#8fa6b8'); gl.addColorStop(1, '#3f5262'); g.fillStyle = gl; g.fillRect(x, y, ww, wh);
      g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(x + ww * 0.1, y + 3, ww * 0.12, wh - 6);
      g.fillStyle = '#d9d4ca'; g.fillRect(x + ww / 2 - 1.5, y, 3, wh);
      if (r() < 0.45) { g.fillStyle = '#ececec'; g.fillRect(x + ww + 6, y + wh * 0.25, 22, 16); g.fillStyle = '#9a9a9a'; for (let k = 0; k < 4; k++) g.fillRect(x + ww + 8, y + wh * 0.25 + 3 + k * 3, 18, 1); }
      if (r() < 0.5) { g.strokeStyle = '#4a4a4a'; g.lineWidth = 2; g.strokeRect(x - 6, y + wh * 0.62, ww + 12, wh * 0.45); for (let k = 0; k < 8; k++) { g.beginPath(); g.moveTo(x - 6 + k * (ww + 12) / 7, y + wh * 0.62); g.lineTo(x - 6 + k * (ww + 12) / 7, y + wh * 1.07); g.stroke(); } }
    }
    if (!lit) { g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, fh - 4, w, 4); g.fillRect(0, h - 4, w, 4); }
  });
}
function shopCanvas(seed, lit) {
  // six shop types: general store, tea stall, fruit, sarees, pharmacy, shutter
  return makeCanvas(256, 200, (g, w, h) => {
    const r = rnd(seed * 3 + 1), sc = SIGNC[seed % SIGNC.length], type = seed % 6;
    g.fillStyle = lit ? '#000' : FACADE[(seed + 3) % FACADE.length]; g.fillRect(0, 0, w, h);
    if (!lit){ const n = g.getImageData(0, 0, w, h), d = n.data; for (let i = 0; i < d.length; i += 4){ const k = (r() - 0.5) * 16; d[i] += k; d[i + 1] += k; d[i + 2] += k; } g.putImageData(n, 0, 0); }
    // signboard with pseudo-lettering
    const signCol = type === 4 ? '#1e8a4a' : sc;
    g.fillStyle = lit ? (type === 5 ? '#000' : signCol) : signCol; g.fillRect(6, 10, w - 12, 48);
    g.fillStyle = lit ? 'rgba(255,255,255,0.95)' : '#fff';
    if (type === 4){ g.fillRect(24, 22, 24, 8); g.fillRect(32, 14, 8, 24); }
    for (let k = 0, x = type === 4 ? 60 : 22; k < 6 && x < w - 40; k++) { const ww = 14 + r() * 26; g.fillRect(x, 22, ww, 9 + r() * 12); x += ww + 8; }
    if (!lit){ g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(6, 56, w - 12, 3); }
    const ox = 18, oy = 70, ow = w - 36, oh = h - 76;
    if (type === 5){
      if (lit) return;
      g.fillStyle = '#8b8c8e'; g.fillRect(ox, oy, ow, oh);
      g.fillStyle = 'rgba(0,0,0,0.22)'; for (let y = oy + 4; y < h - 6; y += 7) g.fillRect(ox, y, ow, 2);
      g.fillStyle = 'rgba(40,40,40,0.5)'; g.font = 'bold 18px sans-serif'; g.fillText(['NO PARKING', 'TO LET', 'CLOSED'][seed % 3], 40, 140);
      g.strokeStyle = 'rgba(30,30,30,0.35)'; g.lineWidth = 2; g.beginPath(); for (let i = 0; i < 3; i++){ const x = 60 + r() * 140, y = 90 + r() * 80; g.moveTo(x, y); g.quadraticCurveTo(x + 20, y - 15, x + 40, y + 5); } g.stroke();
      return;
    }
    if (lit){ const gl = g.createLinearGradient(0, oy, 0, h); gl.addColorStop(0, '#ffe0a0'); gl.addColorStop(1, '#b06a2c'); g.fillStyle = gl; g.fillRect(ox, oy, ow, oh); return; }
    g.fillStyle = '#3a2f27'; g.fillRect(ox, oy, ow, oh);
    if (type === 0){       // general store: shelves of packets
      for (let k = 0; k < 4; k++) { g.fillStyle = '#6b5643'; g.fillRect(ox + 6, oy + 12 + k * 26, ow - 12, 4); for (let q = 0; q < 10; q++) { g.fillStyle = SIGNC[Math.floor(r() * SIGNC.length)]; g.fillRect(ox + 10 + q * 20 + r() * 6, oy - 2 + k * 26, 10, 14); } }
      for (let q = 0; q < 8; q++){ g.fillStyle = SIGNC[Math.floor(r() * SIGNC.length)]; g.fillRect(ox + q * 27, oy, 6, 26); }  // hanging sachet strips
    } else if (type === 1){ // tea stall: counter, glasses, kettle
      g.fillStyle = '#5b4636'; g.fillRect(ox, oy + oh * 0.55, ow, oh * 0.45);
      g.fillStyle = '#c9ccd0'; for (let q = 0; q < 9; q++) g.fillRect(ox + 14 + q * 22, oy + oh * 0.55 - 14, 9, 14);
      g.fillStyle = '#9aa0a6'; g.beginPath(); g.ellipse(ox + ow - 40, oy + oh * 0.45, 18, 14, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f2e6c8'; g.font = 'bold 14px sans-serif'; g.fillText('CHAI · KAAPI', ox + 16, oy + oh * 0.8);
    } else if (type === 2){ // fruit crates
      for (let k = 0; k < 3; k++) for (let q = 0; q < 5; q++){ const cx = ox + 10 + q * 42, cy = oy + 20 + k * 36; g.fillStyle = '#8a6a43'; g.fillRect(cx, cy + 14, 36, 16); const fc = ['#e94f37', '#f4b740', '#7cb342', '#ff9f1c', '#8e3b8a'][(q + k) % 5]; g.fillStyle = fc; for (let f = 0; f < 6; f++){ g.beginPath(); g.arc(cx + 6 + (f % 3) * 12, cy + 10 + Math.floor(f / 3) * 6, 5, 0, Math.PI * 2); g.fill(); } }
    } else if (type === 3){ // sarees on display
      for (let q = 0; q < 9; q++){ const c = ['#c2185b', '#f4b740', '#2e86c1', '#16a085', '#8e44ad', '#e67e22', '#d32f2f'][q % 7]; g.fillStyle = c; g.fillRect(ox + 6 + q * 24, oy + 6, 18, oh - 12); g.fillStyle = 'rgba(255,215,120,0.8)'; g.fillRect(ox + 6 + q * 24, oy + oh - 20, 18, 4); }
    } else {                // pharmacy: white shelves
      g.fillStyle = '#e8ecee'; g.fillRect(ox + 4, oy + 4, ow - 8, oh - 8);
      for (let k = 0; k < 4; k++){ g.fillStyle = '#b8c2c8'; g.fillRect(ox + 8, oy + 26 + k * 26, ow - 16, 3); for (let q = 0; q < 14; q++){ g.fillStyle = ['#ffffff', '#cfe8ff', '#ffe0e0', '#e0ffe8'][q % 4]; g.fillRect(ox + 12 + q * 15, oy + 12 + k * 26, 10, 13); } }
    }
    g.fillStyle = 'rgba(255,220,150,0.18)'; g.fillRect(ox, oy, ow, oh);
  });
}
function awningCanvas(seed) {
  return makeCanvas(128, 128, (g, w, h) => { const pairs = [['#c0392b', '#f5efe0'], ['#1f6fb2', '#f5efe0'], ['#2e8b57', '#f2e3b3'], ['#e0a21a', '#ffffff'], ['#7d3c98', '#f5efe0'], ['#d35400', '#f5efe0']]; const [a, b] = pairs[seed % pairs.length]; for (let x = 0; x < w; x += 16){ g.fillStyle = (x / 16) % 2 ? a : b; g.fillRect(x, 0, 16, h); } g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, h - 10, w, 10); });
}
const HOARDINGS = [['FILTER KAAPI', '₹20 · SINCE 1962'], ['2BHK NEAR METRO*', '*METRO COMING SOON'], ['LEARN AI IN 7 DAYS', 'GUARANTEED JOB?'], ['DOSA CORNER', 'OPEN TILL MIDNIGHT'], ['TECH PARK →', 'ONLY 3 KM · ONLY 90 MIN'], ['SILK SAREES', 'WEDDING SALE'], ['CRICKET TONIGHT', '7:30 PM · BIG SCREEN'], ['DRIVE SAFE', 'POTHOLES AHEAD. ALWAYS.']];
const HOARD_BG = ['#f4b740', '#14213d', '#c0392b', '#0f766e', '#ffffff', '#7d3c98', '#1f6fb2', '#2e8b57'];
function hoardingCanvas(i) {
  return makeCanvas(512, 200, (g, w, h) => {
    const bg = HOARD_BG[i % HOARD_BG.length], light = bg === '#ffffff' || bg === '#f4b740';
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = light ? '#14213d' : '#ffffff'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = 'bold 62px "Bebas Neue", Impact, sans-serif'; g.fillText(HOARDINGS[i][0], 28, 80);
    g.font = 'bold 26px "Hanken Grotesk", sans-serif'; g.globalAlpha = 0.85; g.fillText(HOARDINGS[i][1], 30, 148); g.globalAlpha = 1;
    g.fillStyle = light ? 'rgba(20,33,61,0.15)' : 'rgba(255,255,255,0.15)'; g.fillRect(0, h - 14, w, 14);
  });
}
function blobCanvas() { return makeCanvas(128, 128, (g) => { const gr = g.createRadialGradient(64, 64, 2, 64, 64, 62); gr.addColorStop(0, 'rgba(0,0,0,0.9)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); }); }
function textCanvas(lines, { w = 512, h = 160, bg = '#0b6b3a', fg = '#fff', border = true, font = 'bold 64px "Hanken Grotesk", sans-serif' } = {}) {
  return makeCanvas(w, h, (g) => {
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
    if (border) { g.strokeStyle = fg; g.lineWidth = 6; g.strokeRect(10, 10, w - 20, h - 20); }
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font;
    const n = lines.length; lines.forEach((t, i) => { let s = t; while (g.measureText(s).width > w - 50 && s.length > 3) s = s.slice(0, -1); g.fillText(s, w / 2, h / 2 + (i - (n - 1) / 2) * (h / (n + 0.6))); });
  });
}
function stripeCanvas(c1 = '#f2c230', c2 = '#1b1b1b') { return makeCanvas(128, 64, (g, w, h) => { g.fillStyle = c1; g.fillRect(0, 0, w, h); g.fillStyle = c2; for (let x = -h; x < w + h; x += 32) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 16, h); g.lineTo(x + 16 + h, 0); g.lineTo(x + h, 0); g.fill(); } }); }
function cloudCanvas(seed) { return makeCanvas(256, 128, (g, w, h) => { const r = rnd(seed); for (let i = 0; i < 26; i++) { const x = w * (0.15 + r() * 0.7), y = h * (0.35 + r() * 0.35), rr = 18 + r() * 34; const gr = g.createRadialGradient(x, y, 0, x, y, rr); gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2); } }); }
function glowCanvas() { return makeCanvas(64, 64, (g) => { const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }); }
function skylineCanvas() {
  return makeCanvas(2048, 256, (g, w, h) => {
    const r = rnd(21); let x = 0;
    while (x < w) { const bw = 20 + r() * 70, bh = 30 + Math.pow(r(), 2) * 200; g.fillStyle = `rgba(255,255,255,${0.55 + r() * 0.45})`; g.fillRect(x, h - bh, bw, bh); if (r() < 0.15) { g.fillRect(x + bw / 2 - 2, h - bh - 30, 4, 30); } x += bw + r() * 8; }
  });
}

// ---------------------------------------------------------------- materials (shared)
function M(color, o = {}) { return new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.75, metalness: 0 }, o)); }
function E(color, intensity = 2) { return new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: intensity, roughness: 0.4 }); }

export function create(PD) {
  const glc = document.getElementById('gl');
  const stage = document.getElementById('stage');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: glc, antialias: false, powerPreference: 'high-performance', alpha: false });
  } catch (e) { return null; }
  if (!renderer || !renderer.getContext()) return null;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const coarse = matchMedia('(pointer: coarse)').matches;
  const rbCache = new Map();
  function rgeo(w, h, d, r) { const k = w + ',' + h + ',' + d + ',' + r; if (!rbCache.has(k)) rbCache.set(k, new RoundedBoxGeometry(w, h, d, 3, Math.max(0.001, Math.min(r, w / 2 - 0.002, h / 2 - 0.002, d / 2 - 0.002)))); return rbCache.get(k); }
  function rb(w, h, d, r, mat, x = 0, y = 0, z = 0, parent) { const m = new THREE.Mesh(rgeo(w, h, d, r), mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; if (parent) parent.add(m); return m; }
  const blobTex = (() => { const t = new THREE.CanvasTexture(blobCanvas()); return t; })();
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.6, color: 0x000000 });
  const blobGeo = new THREE.PlaneGeometry(1, 1); blobGeo.rotateX(-Math.PI / 2);
  function blob(w, d, op) { const m = new THREE.Mesh(blobGeo, op ? blobMat.clone() : blobMat); if (op) m.material.opacity = op; m.scale.set(w, 1, d); m.position.y = 0.025; m.renderOrder = 2; m.name = 'blob'; return m; }
  const qPin = new URLSearchParams(location.search).get('q');
  let quality = qPin != null ? clamp(+qPin | 0, 0, 2) : (coarse ? 1 : 2);   // 0 low, 1 medium, 2 high; ?q= pins it
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 600);
  scene.fog = new THREE.FogExp2(0xffc79a, 0.006);

  // ---------------- sky
  const skyU = {
    top: { value: new THREE.Color('#2f5f9a') }, horizon: { value: new THREE.Color('#ffb070') }, ground: { value: new THREE.Color('#6d5a4a') },
    sunDir: { value: new THREE.Vector3(-0.35, 0.12, -1).normalize() }, sunColor: { value: new THREE.Color('#ffd29a') }, sunStrength: { value: 1.0 }, night: { value: 0 }
  };
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyU,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }',
    fragmentShader: `uniform vec3 top, horizon, ground, sunDir, sunColor; uniform float sunStrength, night; varying vec3 vDir;
      float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      void main(){ float y = vDir.y; vec3 c = y > 0.0 ? mix(horizon, top, pow(clamp(y,0.0,1.0), 0.55)) : mix(horizon, ground, clamp(-y*6.0,0.0,1.0));
        float s = max(dot(vDir, sunDir), 0.0);
        c += sunColor * (pow(s, 600.0)*14.0 + pow(s, 24.0)*0.55 + pow(s, 4.0)*0.18) * sunStrength;
        if (night > 0.5 && y > 0.05){ vec2 g = floor(vDir.xz/(vDir.y+0.3)*300.0); float st = step(0.9975, h21(g)); c += vec3(st)*0.9*(1.0-sunStrength); }
        gl_FragColor = vec4(c, 1.0); }`
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), skyMat); scene.add(sky);
  // environment map for reflections (rebuilt when the sky changes)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); const envSky = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), skyMat); envScene.add(envSky);
  let envRT = null, envKey = '';
  function rebuildEnv(key) { if (key === envKey) return; envKey = key; const old = envRT; envRT = pmrem.fromScene(envScene, 0.02); scene.environment = envRT.texture; if (old) old.dispose(); }

  // clouds and skyline
  const cloudTex = [1, 2, 3].map(s => tex(cloudCanvas(s), { srgb: true }));
  const clouds = [];
  for (let i = 0; i < 10; i++) {
    const m = new THREE.SpriteMaterial({ map: cloudTex[i % 3], transparent: true, depthWrite: false, fog: false, opacity: 0.8 });
    const s = new THREE.Sprite(m); const sc = 70 + hash(i) * 90; s.scale.set(sc, sc * 0.45, 1);
    s.userData = { a: hash(i * 3) * Math.PI * 0.9 - Math.PI * 0.45, h: 35 + hash(i * 5) * 50, d: 260 + hash(i * 7) * 120, sp: 0.002 + hash(i * 9) * 0.004 };
    scene.add(s); clouds.push(s);
  }
  const skylineMat = new THREE.MeshBasicMaterial({ map: tex(skylineCanvas()), transparent: true, color: 0x8796a8, fog: false, depthWrite: false });
  const skyline = new THREE.Mesh(new THREE.PlaneGeometry(900, 110), skylineMat); skyline.position.set(0, 42, -360); scene.add(skyline);

  // ---------------- lights
  const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x6a5440, 0.9); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffc488, 2.6);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  const sc = sun.shadow.camera; sc.left = -22; sc.right = 22; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 160;
  scene.add(sun); scene.add(sun.target);
  const lampLights = [];
  for (let i = 0; i < 4; i++) { const p = new THREE.PointLight(0xffb866, 0, 26, 1.6); scene.add(p); lampLights.push(p); }
  const headlight = new THREE.SpotLight(0xfff0d0, 0, 60, 0.5, 0.5, 1.2); scene.add(headlight); scene.add(headlight.target);
  const riderFill = new THREE.PointLight(0x9fb6e8, 0, 9, 1.4); scene.add(riderFill);   // soft back light so the rider reads at night

  // ---------------- ground
  const asphaltTex = tex(asphaltCanvas(), { repeat: [1, 1] });
  const bumpTex = tex(noiseCanvas(5), { srgb: false, repeat: [3, 12] });
  const RL = 34;           // road length drawn, in lanes
  asphaltTex.repeat.set(1, RL / TILE);
  const roadMat = new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.88, metalness: 0.0, bumpMap: bumpTex, bumpScale: 0.6, envMapIntensity: 0.6 });
  const road = new THREE.Mesh(new THREE.PlaneGeometry(3 * L, RL * L), roadMat);
  road.rotation.x = -Math.PI / 2; road.position.set(0, 0, Zm(RL / 2 - 4)); road.receiveShadow = true; scene.add(road);
  const kerbTex = tex(kerbCanvas(), { repeat: [1, RL] });
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.7 });
  const pathTex = tex(pathCanvas(), { repeat: [2, RL / 0.84] });
  const pathMat = new THREE.MeshStandardMaterial({ map: pathTex, roughness: 0.9, envMapIntensity: 0.4 });
  const KH = 0.22;
  for (const side of [-1, 1]) {
    const kerb = new THREE.Mesh(new THREE.BoxGeometry(0.12 * L, KH, RL * L), kerbMat);
    kerb.position.set(side < 0 ? X(-0.06) : X(3.06), KH / 2, Zm(RL / 2 - 4)); kerb.receiveShadow = true; scene.add(kerb);
    const path = new THREE.Mesh(new THREE.BoxGeometry(1.05 * L, KH, RL * L), pathMat);
    path.position.set(side < 0 ? X(-0.645) : X(3.645), KH / 2 - 0.005, Zm(RL / 2 - 4)); path.receiveShadow = true; scene.add(path);
  }
  const dirt = new THREE.Mesh(new THREE.PlaneGeometry(200, RL * L * 3), M('#6f6252', { roughness: 1 }));
  dirt.rotation.x = -Math.PI / 2; dirt.position.set(0, -0.02, Zm(RL)); dirt.receiveShadow = true; scene.add(dirt);

  // ---------------- buildings (procedural, recycled by road position)
  const BLEN = 2.3, BW = 9;           // building length (lanes), depth (m)
  const floorMats = {}, shopMats = [];
  for (let v = 0; v < 12; v++) {
    const t = tex(shopCanvas(v, false)), e = tex(shopCanvas(v, true));
    shopMats.push(new THREE.MeshStandardMaterial({ map: t, emissiveMap: e, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.8 }));
  }
  const floorTex = []; for (let v = 0; v < 8; v++) floorTex.push([tex(floorsCanvas(v + 1, false)), tex(floorsCanvas(v + 1, true))]);
  function floorMat(v, floors) {
    const k = v + '_' + floors; if (floorMats[k]) return floorMats[k];
    const [t, e] = floorTex[v]; const tt = t.clone(), ee = e.clone(); tt.needsUpdate = ee.needsUpdate = true; tt.repeat.set(1, floors / 2); ee.repeat.set(1, floors / 2);
    return (floorMats[k] = new THREE.MeshStandardMaterial({ map: tt, emissiveMap: ee, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.85 }));
  }
  const wallMats = FACADE.map(c => M(c, { roughness: 0.95 }));
  const roofMat = M('#7c766c', { roughness: 1 });
  const tankMat = M('#1d1f22', { roughness: 0.6 });
  const tankGeo = new THREE.CylinderGeometry(0.7, 0.7, 1.4, 12);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const buildings = new Map();
  const awnGeo = new THREE.PlaneGeometry(1.6, 1); awnGeo.rotateX(-Math.PI / 2);
  const awnMats = [0, 1, 2, 3, 4, 5].map(i => new THREE.MeshStandardMaterial({ map: tex(awningCanvas(i)), roughness: 0.9, side: THREE.DoubleSide }));
  const signMats = [0, 1, 2, 3, 4, 5].map(i => { const c = textCanvas([['MEDICALS', 'TAILORS', 'MOBILES', 'DARSHINI', 'XEROX', 'BAKERY'][i]], { w: 128, h: 256, bg: SIGNC[i + 1], fg: '#ffffff', border: false, font: 'bold 30px "Hanken Grotesk", sans-serif' }); const t = tex(c); return new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0, roughness: 0.5 }); });
  const hoardMats = HOARDINGS.map((_, i) => { const t = tex(hoardingCanvas(i)); return new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0, roughness: 0.6 }); });
  const frameMat = M('#3b3f45', { metalness: 0.6, roughness: 0.5 });
  const hoardLampMat = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xfff0c0, emissiveIntensity: 0 });
  const BIKE_COL = ['#c0392b', '#1f1f22', '#2e86c1', '#f5f5f5', '#7f8c8d', '#16a085'];
  function makeBike(col) {
    const g = new THREE.Group(), paint = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.35, clearcoat: 0.8 }), blk = M('#151515', { roughness: 0.6 });
    const tg = new THREE.TorusGeometry(0.2, 0.06, 8, 18); tg.rotateY(Math.PI / 2);
    for (const z of [-0.55, 0.5]) { const t = new THREE.Mesh(tg, tyreMat); t.position.set(0, 0.26, z); g.add(t); }
    rb(0.36, 0.32, 0.7, 0.12, paint, 0, 0.6, 0.25, g); rb(0.34, 0.6, 0.16, 0.07, paint, 0, 0.66, -0.45, g); rb(0.32, 0.08, 0.5, 0.04, blk, 0, 0.8, 0.22, g);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.6, 6), blk); bar.rotation.z = Math.PI / 2; bar.position.set(0, 1.0, -0.45); g.add(bar);
    g.add(blob(0.7, 1.6, 0.45)); return g;
  }
  function makeBuilding(i, side) {
    const k = i * 2 + (side > 0 ? 1 : 0), v = Math.floor(hash(k * 11) * 8), floors = 2 + Math.floor(hash(k * 13) * 5);
    const g = new THREE.Group(), len = BLEN * L * 0.97, GF = 4.2, FH = 3.2, H = GF + floors * FH;
    const wall = wallMats[v % wallMats.length];
    const faceIdx = side < 0 ? 0 : 1;   // +X face for left buildings, -X for right
    const gm = [wall, wall, roofMat, wall, wall, wall]; gm[faceIdx] = shopMats[(v + k) % shopMats.length];
    const gb = new THREE.Mesh(boxGeo, gm); gb.scale.set(BW, GF, len); gb.position.y = GF / 2;
    const um = [wall, wall, roofMat, wall, wall, wall]; um[faceIdx] = floorMat(v, floors);
    const ub = new THREE.Mesh(boxGeo, um); ub.scale.set(BW, floors * FH, len); ub.position.y = GF + floors * FH / 2;
    const cornice = new THREE.Mesh(boxGeo, roofMat); cornice.scale.set(BW + 0.4, 0.35, len + 0.2); cornice.position.y = H;
    for (const m of [gb, ub, cornice]) { m.castShadow = quality > 1; m.receiveShadow = true; g.add(m); }
    if (hash(k * 17) < 0.7) { const t = new THREE.Mesh(tankGeo, tankMat); t.position.set((hash(k * 19) - 0.5) * 4, H + 0.9, (hash(k * 23) - 0.5) * len * 0.6); g.add(t); }
    const dir = side < 0 ? 1 : -1, face = dir * BW / 2;     // local x of the road-facing wall
    if (hash(k * 29) < 0.6) {                                  // striped awning over the shop
      const aw = new THREE.Mesh(awnGeo, awnMats[Math.floor(hash(k * 31) * awnMats.length)]); aw.scale.set(1, 1, len * 0.86);
      aw.position.set(face + dir * 0.75, 3.55, 0); aw.rotation.z = dir * -0.38; aw.castShadow = true; aw.receiveShadow = true; g.add(aw);
      const val = new THREE.Mesh(boxGeo, aw.material); val.scale.set(0.04, 0.28, len * 0.86); val.position.set(face + dir * 1.45, 3.15, 0); g.add(val);
    }
    if (hash(k * 37) < 0.4) {                                  // signboard sticking out over the footpath
      const sg = rb(0.14, 1.5, 0.75, 0.04, shopMats[(v + k + 5) % shopMats.length], face + dir * 0.55, 6.0, len * (hash(k * 41) - 0.5) * 0.6, g);
      sg.material = signMats[(k + v) % signMats.length];
    }
    if (hash(k * 43) < 0.24) {                                 // rooftop hoarding facing the road
      const hb = new THREE.Group(); hb.position.set(face - dir * 1.2, H + 0.35, 0); hb.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2; g.add(hb);
      const hm = hoardMats[Math.floor(hash(k * 47) * hoardMats.length)];
      const board = new THREE.Mesh(new THREE.PlaneGeometry(len * 0.82, len * 0.82 * 0.39), hm); board.position.y = 2.6; hb.add(board);
      const back = new THREE.Mesh(boxGeo, frameMat); back.scale.set(len * 0.84, len * 0.84 * 0.4, 0.12); back.position.set(0, 2.6, -0.08); back.castShadow = true; hb.add(back);
      for (const lx of [-0.35, 0.35]) { const leg = new THREE.Mesh(boxGeo, frameMat); leg.scale.set(0.12, 2.6, 0.12); leg.position.set(lx * len, 1.3, -0.1); hb.add(leg); }
      const lampBar = new THREE.Mesh(boxGeo, hoardLampMat); lampBar.scale.set(len * 0.7, 0.08, 0.25); lampBar.position.set(0, 2.6 + len * 0.17 + 0.25, 0.25); hb.add(lampBar);
    }
    const nb = Math.floor(hash(k * 53) * 3);                   // parked two-wheelers on the footpath
    for (let b = 0; b < nb; b++) { const bk = getProto('bike' + ((k + b) % BIKE_COL.length), () => makeBike(BIKE_COL[(k + b) % BIKE_COL.length])).clone(); bk.position.set(face + dir * 1.0, KH, (b - (nb - 1) / 2) * 1.6 + (hash(k * 59) - 0.5)); bk.rotation.y = dir * 0.9 + (hash(k + b) - 0.5) * 0.3; g.add(bk); }
    g.position.x = side < 0 ? X(-1.05) - BW / 2 : X(4.05) + BW / 2;
    g.userData = { i, side, H };
    scene.add(g); return g;
  }

  // ---------------- street furniture
  const poleMat = M('#5d6166', { roughness: 0.5, metalness: 0.6 });
  const lampHeadMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xffc070, emissiveIntensity: 0, roughness: 0.3 });
  function makeLamp() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 7, 8), poleMat); pole.position.y = 3.5; pole.castShadow = true; g.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.1), poleMat); arm.position.set(0.9, 6.95, 0); g.add(arm);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.32), lampHeadMat); head.position.set(1.75, 6.85, 0); g.add(head);
    g.userData.head = head; return g;
  }
  const lamps = new Map();
  const treeMats = ['#35652f', '#3f7a3a', '#4b8a3f', '#5a9a49', '#6aa553'].map(c => M(c, { roughness: 0.85 }));
  const trunkMat = M('#5f4630', { roughness: 1 });
  const canopyGeo = new THREE.IcosahedronGeometry(1, 2);
  (() => { const p = canopyGeo.attributes.position, v = new THREE.Vector3(); for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); const n = 1 + (hash((Math.round(v.x * 50) * 73856093) ^ (Math.round(v.y * 50) * 19349663) ^ (Math.round(v.z * 50) * 83492791)) - 0.5) * 0.32; p.setXYZ(i, v.x * n, v.y * n, v.z * n); } canopyGeo.computeVertexNormals(); })();
  function makeTree(seed) {
    const g = new THREE.Group(), s = 0.9 + hash(seed) * 0.6;
    g.add(blob(6 * s, 6 * s, 0.32));
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, 4.6, 8), trunkMat); trunk.position.y = 2.3; trunk.castShadow = true; g.add(trunk);
    for (const sx of [-1, 1]) { const br = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.13, 2.4, 6), trunkMat); br.position.set(sx * 0.6, 4.6, 0); br.rotation.z = -sx * 0.7; br.castShadow = true; g.add(br); }
    for (let i = 0; i < 9; i++) { const c = new THREE.Mesh(canopyGeo, treeMats[Math.floor(hash(seed * 7 + i) * treeMats.length)]); const a = i / 9 * Math.PI * 2 + hash(seed + i); const rr = (i % 3 === 0 ? 0.8 : 1.9) * s; c.position.set(Math.cos(a) * rr, 5.2 + hash(seed + i * 3) * 1.6, Math.sin(a) * rr * 0.8); const k = (1.3 + hash(seed + i * 5) * 0.9) * s; c.scale.set(k * 1.4, k * 0.85, k * 1.3); c.castShadow = true; c.receiveShadow = true; g.add(c); }
    return g;
  }
  // utility poles with sagging cables; every few spans a cable with bunting crosses the road
  const POLE_GAP = 5.5, POLE_H = 8.2, cableMat = new THREE.LineBasicMaterial({ color: 0x1b1b1d }), cablePoles = new Map();
  function sagLine(x0, y0, z0, x1, y1, z1, sag, n = 14) { const pts = []; for (let i = 0; i <= n; i++) { const t = i / n; pts.push(new THREE.Vector3(lerp(x0, x1, t), lerp(y0, y1, t) - sag * 4 * t * (1 - t), lerp(z0, z1, t))); } return new THREE.BufferGeometry().setFromPoints(pts); }
  const sideCables = [0, 0.35, -0.35].map((dx, i) => sagLine(dx, POLE_H - 0.3 - i * 0.25, 0, dx, POLE_H - 0.3 - i * 0.25, -POLE_GAP * L, 0.55 + i * 0.12));
  const crossW = X(3.98) - X(-0.98);
  const crossCable = sagLine(0, POLE_H - 0.6, 0, crossW, POLE_H - 0.6, 0, 1.3, 24);
  const buntingGeo = (() => { const pos = [], col = [], c = new THREE.Color(), cols = ['#e63946', '#f4b740', '#2a9d8f', '#ffffff', '#ff7f11', '#6a4c93']; for (let i = 1; i < 26; i++) { const t = i / 26, x = crossW * t, y = POLE_H - 0.6 - 1.3 * 4 * t * (1 - t) - 0.02, w = 0.22; pos.push(x - w, y, 0, x + w, y, 0, x, y - 0.45, 0); c.set(cols[i % cols.length]); for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b); } const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); gg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); gg.computeVertexNormals(); return gg; })();
  const buntingMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 });
  const utilMat = M('#8a8c8e', { roughness: 0.8 }), boxMat = M('#5a5f63', { roughness: 0.6, metalness: 0.3 });
  function makeUtilPole(i) {
    const g = new THREE.Group();
    for (const side of [-1, 1]) {
      const pg = new THREE.Group(); pg.position.x = side < 0 ? X(-0.98) : X(3.98); g.add(pg);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, POLE_H, 6), utilMat); pole.position.y = POLE_H / 2; pole.castShadow = true; pg.add(pole);
      const arm = new THREE.Mesh(boxGeo, utilMat); arm.scale.set(1.0, 0.08, 0.08); arm.position.y = POLE_H - 0.25; pg.add(arm);
      if (hash(i * 3 + side) < 0.3) { const tb = new THREE.Mesh(boxGeo, boxMat); tb.scale.set(0.5, 0.7, 0.4); tb.position.set(0, POLE_H - 2.2, 0); tb.castShadow = true; pg.add(tb); }
      for (const cg of sideCables) pg.add(new THREE.Line(cg, cableMat));
    }
    if (i % 3 === 0) { const c = new THREE.Line(crossCable, cableMat); c.position.x = X(-0.98); g.add(c); if (i % 6 === 0) { const b = new THREE.Mesh(buntingGeo, buntingMat); b.position.x = X(-0.98); g.add(b); } }
    return g;
  }
  const signTexCache = new Map();
  function signTex(text) { if (!signTexCache.has(text)) signTexCache.set(text, tex(textCanvas([text], { font: 'bold 54px "Hanken Grotesk", sans-serif' }))); return signTexCache.get(text); }
  function makeSign(text) {
    const g = new THREE.Group();
    for (const dx of [-1.3, 1.3]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.6, 6), poleMat); p.position.set(dx, 1.8, 0); g.add(p); }
    const b = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.0, 0.08), [M('#0b5f34'), M('#0b5f34'), M('#0b5f34'), M('#0b5f34'), new THREE.MeshStandardMaterial({ map: signTex(text), roughness: 0.5 }), M('#888')]);
    b.position.y = 3.3; b.castShadow = true; g.add(b); return g;
  }
  // metro viaduct (metro roads)
  const viaduct = new THREE.Group();
  const DH = 9.5;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.3, RL * L * 1.6), M('#b9b4bd', { roughness: 0.8 })); deck.position.set(X(-0.9), DH, Zm(RL * 0.8 - 4)); deck.castShadow = true; deck.receiveShadow = true; viaduct.add(deck);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.35, RL * L * 1.6), new THREE.MeshStandardMaterial({ color: 0x7d4ca8, emissive: 0x7d4ca8, emissiveIntensity: 0.25 })); stripe.position.set(X(-0.9) + 2.13, DH + 0.2, deck.position.z); viaduct.add(stripe);
  const parapet = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.1, RL * L * 1.6), M('#c9c4cc')); parapet.position.set(X(-0.9) + 2.0, DH + 1.2, deck.position.z); viaduct.add(parapet);
  scene.add(viaduct);
  const pierGeo = new THREE.BoxGeometry(1.5, DH, 1.5), pierCapGeo = new THREE.BoxGeometry(4.6, 1.0, 2.0), pierMat = M('#c4c0b8', { roughness: 0.85 });
  const piers = new Map();
  function makePier() { const g = new THREE.Group(); const p = new THREE.Mesh(pierGeo, pierMat); p.position.y = DH / 2; p.castShadow = true; p.receiveShadow = true; g.add(p); const c = new THREE.Mesh(pierCapGeo, pierMat); c.position.y = DH - 0.6; g.add(c); g.position.x = X(-0.9); return g; }
  // metro train on the viaduct
  const train = new THREE.Group();
  const carMat = M('#eeeeee', { roughness: 0.35, metalness: 0.3 }), carStripe = new THREE.MeshStandardMaterial({ color: 0x7d4ca8, roughness: 0.4 }), winMat = new THREE.MeshStandardMaterial({ color: 0x1a2430, roughness: 0.1, metalness: 0.5, emissive: 0xfff2c8, emissiveIntensity: 0 });
  for (let c = 0; c < 3; c++) { const car = new THREE.Mesh(new THREE.BoxGeometry(2.8, 3.0, 20), carMat); car.position.set(0, 1.5, -c * 20.6); train.add(car); const s = new THREE.Mesh(new THREE.BoxGeometry(2.85, 0.5, 20), carStripe); s.position.set(0, 0.7, -c * 20.6); train.add(s); const w = new THREE.Mesh(new THREE.BoxGeometry(2.86, 0.9, 18), winMat); w.position.set(0, 2.0, -c * 20.6); train.add(w); }
  train.position.set(X(-0.9), DH + 0.65, 999); viaduct.add(train);
  let trainZ = 999, trainT = 8;

  // ---------------- vehicles and hazards
  const glowTex = tex(glowCanvas());
  const plateCache = new Map();
  function plateMat(text, bg, fg) { const k = text + bg; if (!plateCache.has(k)) plateCache.set(k, new THREE.MeshStandardMaterial({ map: tex(textCanvas([text], { w: 256, h: 64, bg, fg, border: false, font: 'bold 40px "JetBrains Mono", monospace' })), roughness: 0.5 })); return plateCache.get(k); }
  const tailMat = () => new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2010, emissiveIntensity: 1.2, roughness: 0.3 });
  const tyreMat = M('#141414', { roughness: 0.9 }), rimMat = M('#9aa0a6', { metalness: 0.8, roughness: 0.3 });
  const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 16); wheelGeo.rotateZ(Math.PI / 2);
  function wheel(r = 0.32, w = 0.22) { const m = new THREE.Mesh(wheelGeo, tyreMat); m.scale.set(w / 0.22, r / 0.32, r / 0.32); m.castShadow = true; return m; }
  function boxM(w, h, d, mat, x = 0, y = 0, z = 0, parent) { const m = new THREE.Mesh(boxGeo, mat); m.scale.set(w, h, d); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; if (parent) parent.add(m); return m; }

  function makeScooter() {
    const g = new THREE.Group();
    const body = new THREE.MeshPhysicalMaterial({ color: 0xf4b740, roughness: 0.26, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.06 });
    const black = M('#18181a', { roughness: 0.55 }), leather = M('#1d1b1a', { roughness: 0.42 }), chrome = new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 1, roughness: 0.14 });
    const jacket = M('#1b2a52', { roughness: 0.8 }), jeans = M('#2b3a5a', { roughness: 0.9 }), shoe = M('#e8e4dc', { roughness: 0.7 }), glove = M('#141414', { roughness: 0.6 }), bagM = M('#3a4250', { roughness: 0.65 }), strapM = M('#22262c', { roughness: 0.7 });
    const refl = new THREE.MeshStandardMaterial({ color: 0xd9dee3, emissive: 0xd9dee3, emissiveIntensity: 0.04, metalness: 0.7, roughness: 0.22 });
    g.add(blob(1.0, 2.1, 0.62));
    const tyreG = new THREE.TorusGeometry(0.2, 0.075, 12, 28); tyreG.rotateY(Math.PI / 2);
    const hubG = new THREE.CylinderGeometry(0.12, 0.12, 0.1, 18); hubG.rotateZ(Math.PI / 2);
    const wheels = [];
    for (const z of [-0.66, 0.58]) {
      const w = new THREE.Group(); const t = new THREE.Mesh(tyreG, tyreMat); t.castShadow = true; w.add(t); w.add(new THREE.Mesh(hubG, chrome));
      for (let k = 0; k < 5; k++) { const sp = boxM(0.03, 0.26, 0.04, black, 0, 0, 0, w); sp.rotation.x = k / 5 * Math.PI; }
      w.position.set(0, 0.275, z); g.add(w); wheels.push(w);
    }
    rb(0.5, 0.4, 0.8, 0.16, body, 0, 0.66, 0.34, g);                 // rear cowl
    rb(0.34, 0.18, 0.5, 0.07, body, 0, 0.52, 0.62, g);                // tail
    rb(0.36, 0.06, 0.62, 0.03, black, 0, 0.38, -0.1, g);              // floorboard
    rb(0.46, 0.8, 0.22, 0.1, body, 0, 0.76, -0.53, g);                // front apron
    rb(0.3, 0.12, 0.44, 0.05, body, 0, 0.4, -0.66, g);                // front fender
    rb(0.44, 0.11, 0.72, 0.05, leather, 0, 0.91, 0.33, g);            // seat
    rb(0.5, 0.15, 0.22, 0.07, body, 0, 1.15, -0.55, g);               // handlebar cover
    const rail = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.016, 6, 16, Math.PI), chrome); rail.rotation.set(-Math.PI / 2, 0, 0); rail.position.set(0, 0.93, 0.66); g.add(rail);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.76, 8), black); bar.rotation.z = Math.PI / 2; bar.position.set(0, 1.16, -0.5); g.add(bar);
    for (const sx of [-1, 1]) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.28, 5), chrome); st.position.set(sx * 0.27, 1.31, -0.53); st.rotation.z = -sx * 0.3; g.add(st);
      const mir = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10), black); mir.scale.set(1.35, 0.8, 0.35); mir.position.set(sx * 0.31, 1.44, -0.53); g.add(mir);
      rb(0.06, 0.035, 0.04, 0.012, new THREE.MeshStandardMaterial({ color: 0x553300, emissive: 0xffa020, emissiveIntensity: 0.6 }), sx * 0.19, 0.62, 0.86, g);
    }
    const tl = rb(0.22, 0.07, 0.05, 0.02, tailMat(), 0, 0.64, 0.86, g); g.userData.tail = tl;
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.085), plateMat('KA 01 PD 26', '#ffffff', '#111')); pl.position.set(0, 0.49, 0.876); g.add(pl);
    rb(0.18, 0.1, 0.04, 0.015, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3d6, emissiveIntensity: 1.5 }), 0, 1.0, -0.65, g);
    // rider: seated, leaning a little into the bars
    const cap = (r, l, mat, x, y, z, rx = 0, rz = 0) => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, l, 4, 12), mat); m.position.set(x, y, z); m.rotation.set(rx, 0, rz); m.castShadow = true; g.add(m); return m; };
    for (const sx of [-1, 1]) {
      cap(0.085, 0.3, jeans, sx * 0.15, 0.98, 0.07, 1.44);           // thigh
      cap(0.07, 0.4, jeans, sx * 0.17, 0.71, -0.16, 0.17);           // shin
      rb(0.11, 0.08, 0.24, 0.035, shoe, sx * 0.17, 0.45, -0.24, g);   // shoe on the floorboard
      cap(0.064, 0.24, jacket, sx * 0.28, 1.49, -0.02, 0.89, sx * 0.12);   // upper arm
      cap(0.056, 0.26, jacket, sx * 0.31, 1.28, -0.32, 1.0, sx * 0.05);    // forearm
      const gl = new THREE.Mesh(new THREE.SphereGeometry(0.058, 12, 8), glove); gl.position.set(sx * 0.33, 1.17, -0.49); g.add(gl);
    }
    cap(0.17, 0.14, jeans, 0, 1.03, 0.3, Math.PI / 2, 0).scale.set(1.15, 1, 1);
    const torso = cap(0.2, 0.32, jacket, 0, 1.34, 0.21, -0.25); torso.scale.set(1.12, 1, 0.8);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.05, 24, 1, true), refl); band.scale.set(1.12, 1, 0.8); band.position.set(0, 1.24, 0.235); band.rotation.x = -0.25; g.add(band);
    cap(0.1, 0.34, jacket, 0, 1.6, 0.14, 0, Math.PI / 2);          // shoulders
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.12, 10), M('#8d5b3e', { roughness: 0.7 })); neck.position.set(0, 1.72, 0.12); g.add(neck);
    const bag = rb(0.36, 0.44, 0.18, 0.07, bagM, 0, 1.38, 0.42, g); bag.rotation.x = -0.25;
    rb(0.2, 0.06, 0.02, 0.008, refl, 0, 1.3, 0.53, g).rotation.x = -0.25;
    for (const sx of [-1, 1]) { const s1 = rb(0.05, 0.5, 0.03, 0.012, strapM, sx * 0.13, 1.45, 0.33, g); s1.rotation.x = -0.25; }
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.17, 28, 18), body); helmet.position.set(0, 1.86, 0.1); helmet.scale.set(1, 1.04, 1.15); helmet.castShadow = true; g.add(helmet);
    const stripeH = new THREE.Mesh(new THREE.TorusGeometry(0.172, 0.022, 8, 32, Math.PI), M('#14213d', { roughness: 0.4 })); stripeH.rotation.y = Math.PI / 2; stripeH.position.copy(helmet.position); stripeH.scale.set(1.04, 1.04, 1.15); g.add(stripeH);
    rb(0.16, 0.05, 0.06, 0.02, black, 0, 1.97, 0.28, g).rotation.x = 0.5;   // rear spoiler
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.173, 24, 10, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.28), new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.04, metalness: 0.9 })); visor.position.copy(helmet.position); visor.scale.copy(helmet.scale); visor.rotation.y = Math.PI; g.add(visor);
    g.userData.wheels = wheels;
    return g;
  }
  function makeAuto() {
    const g = new THREE.Group(), green = M('#2f8f3e', { roughness: 0.45, metalness: 0.15 }), yellow = M('#f2c230', { roughness: 0.45, metalness: 0.15 }), canopy = M('#18191b', { roughness: 0.8 });
    const fw = wheel(0.24, 0.12); fw.position.set(0, 0.24, -1.05); g.add(fw);
    for (const sx of [-0.58, 0.58]) { const w = wheel(0.26, 0.14); w.position.set(sx, 0.26, 0.6); g.add(w); }
    g.add(blob(1.9, 3.2));
    rb(1.3, 0.62, 1.6, 0.14, green, 0, 0.62, 0.25, g); rb(1.31, 0.12, 1.61, 0.05, yellow, 0, 0.98, 0.25, g);
    rb(0.7, 0.75, 0.7, 0.16, green, 0, 0.7, -0.85, g); boxM(0.9, 0.5, 0.08, M('#9cc7d8', { roughness: 0.1, metalness: 0.4 }), 0, 1.35, -0.62, g);
    const can = rb(1.36, 0.8, 1.95, 0.12, canopy, 0, 1.45, 0.12, g); const rt = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.68, 1.95, 16, 1, false, 0, Math.PI), canopy); rt.rotation.set(Math.PI / 2, 0, Math.PI / 2); rt.scale.set(1, 1, 0.35); rt.position.set(0, 1.85, 0.12); rt.castShadow = true; g.add(rt);
    boxM(0.7, 0.36, 0.02, M('#47505b', { roughness: 0.15, metalness: 0.5 }), 0, 1.5, 1.105, g);
    const tl = tailMat(); g.userData.tailMat = tl;
    boxM(0.12, 0.08, 0.03, tl, -0.55, 0.62, 1.06, g); boxM(0.12, 0.08, 0.03, tl, 0.55, 0.62, 1.06, g);
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.13), plateMat('KA 05 3378', '#f4d03f', '#111')); p.position.set(0, 0.5, 1.056); g.add(p);
    return g;
  }
  const routeTex = tex(textCanvas(['500D  SILK BOARD'], { w: 512, h: 64, bg: '#111', fg: '#ffb020', border: false, font: 'bold 40px "JetBrains Mono", monospace' }));
  const bmtcTex = tex(textCanvas(['BMTC'], { w: 256, h: 96, bg: '#b8322a', fg: '#fff', border: false, font: 'bold 64px "Hanken Grotesk", sans-serif' }));
  const busGlass = new THREE.MeshStandardMaterial({ color: 0x26323e, roughness: 0.05, metalness: 0.6, emissive: 0xffe2a8, emissiveIntensity: 0 });
  function makeBus() {
    const g = new THREE.Group(), cream = M('#efe8d6', { roughness: 0.5, metalness: 0.1 }), red = M('#b8322a', { roughness: 0.5 }), glass = busGlass;
    for (const z of [-3.6, 3.2]) for (const sx of [-1.12, 1.12]) { const w = wheel(0.52, 0.32); w.position.set(sx, 0.52, z); g.add(w); }
    g.add(blob(3.4, 12.5));
    rb(2.5, 2.6, 11, 0.3, cream, 0, 1.75, 0, g); rb(2.53, 0.8, 11.03, 0.2, red, 0, 0.85, 0, g);
    boxM(2.54, 1.0, 10.2, glass, 0, 2.15, -0.2, g);
    const rear = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.9), glass); rear.position.set(0, 2.15, 5.51); g.add(rear);
    const rs = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.3), new THREE.MeshStandardMaterial({ map: routeTex, emissive: 0xffffff, emissiveMap: routeTex, emissiveIntensity: 1.4 })); rs.position.set(0, 2.85, 5.512); g.add(rs);
    const bt = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.45), new THREE.MeshStandardMaterial({ map: bmtcTex })); bt.position.set(0, 1.0, 5.512); g.add(bt);
    const tl = tailMat(); boxM(0.2, 0.3, 0.04, tl, -1.05, 1.0, 5.5, g); boxM(0.2, 0.3, 0.04, tl, 1.05, 1.0, 5.5, g);
    return g;
  }
  const waterTex = tex(textCanvas(['DRINKING', 'WATER'], { w: 256, h: 256, bg: '#1f5a96', fg: '#fff', border: false, font: 'bold 44px "Hanken Grotesk", sans-serif' }));
  function makeTanker() {
    const g = new THREE.Group(), blue = new THREE.MeshPhysicalMaterial({ color: 0x2d6fb5, roughness: 0.35, metalness: 0.2, clearcoat: 0.6 }), cab = M('#e7e2d6', { roughness: 0.5 }), dark = M('#262626');
    for (const z of [-1.9, 1.3, 2.3]) for (const sx of [-0.95, 0.95]) { const w = wheel(0.46, 0.28); w.position.set(sx, 0.46, z); g.add(w); }
    boxM(2.1, 0.3, 6.2, dark, 0, 0.75, 0.2, g);
    g.add(blob(3.0, 7.8));
    rb(2.2, 2.0, 1.7, 0.22, cab, 0, 1.75, -2.4, g); boxM(2.0, 0.8, 0.05, M('#2d3a48', { roughness: 0.1, metalness: 0.5 }), 0, 2.2, -3.26, g);
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 4.4, 24), blue); tank.rotation.x = Math.PI / 2; tank.position.set(0, 1.95, 0.9); tank.castShadow = true; g.add(tank);
    const cap = new THREE.Mesh(new THREE.CircleGeometry(1.0, 24), new THREE.MeshStandardMaterial({ map: waterTex, roughness: 0.4 })); cap.position.set(0, 1.95, 3.105); g.add(cap);
    const tl = tailMat(); boxM(0.2, 0.15, 0.04, tl, -0.95, 0.8, 3.3, g); boxM(0.2, 0.15, 0.04, tl, 0.95, 0.8, 3.3, g);
    return g;
  }
  function makeCow() {
    const g = new THREE.Group(), hide = M('#ece6da', { roughness: 0.95 }), dark = M('#b5ab9b'), horn = M('#d6ccb8', { roughness: 0.6 });
    g.add(blob(1.3, 2.4, 0.5));
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.1, 6, 12), hide); body.rotation.x = Math.PI / 2; body.position.y = 1.05; body.castShadow = true; g.add(body);
    const hump = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), hide); hump.position.set(0, 1.45, -0.45); g.add(hump);
    for (const [x, z] of [[-0.25, -0.55], [0.25, -0.55], [-0.25, 0.55], [0.25, 0.55]]) boxM(0.13, 0.75, 0.13, dark, x, 0.38, z, g);
    const head = new THREE.Group(); head.position.set(0, 1.3, -0.95); g.add(head);
    boxM(0.32, 0.36, 0.5, hide, 0, 0, -0.15, head); boxM(0.24, 0.2, 0.12, M('#cfae9a'), 0, -0.1, -0.42, head);
    for (const sx of [-1, 1]) { const h = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.36, 6), horn); h.position.set(sx * 0.14, 0.3, 0); h.rotation.z = -sx * 0.4; head.add(h); }
    const tail = boxM(0.04, 0.6, 0.04, dark, 0, 0.9, 0.85, g); tail.rotation.x = 0.15;
    return g;
  }
  const stripeTex = tex(stripeCanvas());
  const metroTex = tex(textCanvas(['METRO WORK', 'SLOW DOWN'], { w: 256, h: 128, bg: '#ffffff', fg: '#1b1b1b', border: false, font: 'bold 34px "Hanken Grotesk", sans-serif' }));
  const blinkMat = new THREE.MeshStandardMaterial({ color: 0x553300, emissive: 0xffa020, emissiveIntensity: 2 });
  function makeBarricade() {
    const g = new THREE.Group(), leg = M('#2b2b2b', { metalness: 0.5, roughness: 0.5 });
    g.add(blob(3.2, 0.9, 0.45));
    for (const sx of [-1.2, 1.2]) { const a = boxM(0.08, 1.2, 0.08, leg, sx, 0.6, -0.15, g); a.rotation.x = 0.25; const b = boxM(0.08, 1.2, 0.08, leg, sx, 0.6, 0.15, g); b.rotation.x = -0.25; }
    boxM(2.8, 0.55, 0.06, new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.6 }), 0, 0.95, 0, g);
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.5), new THREE.MeshStandardMaterial({ map: metroTex, roughness: 0.6 })); p.position.set(0, 0.95, 0.035); g.add(p);
    for (const sx of [-1.25, 1.25]) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), blinkMat); l.position.set(sx, 1.35, 0); g.add(l); }
    return g;
  }
  const pillarNumCache = new Map();
  function makePillar(no) {
    const g = new THREE.Group(), conc = M('#bdb9b0', { roughness: 0.92 });
    g.add(blob(2.6, 2.6, 0.55));
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.82, 6, 20), conc); p.position.y = 3; p.castShadow = true; p.receiveShadow = true; g.add(p);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.84, 0.84, 1.1, 20, 1, true), new THREE.MeshStandardMaterial({ map: (() => { const t = stripeTex.clone(); t.needsUpdate = true; t.repeat.set(4, 1); return t; })(), roughness: 0.6 })); band.position.y = 0.55; g.add(band);
    const rebar = M('#7a4426', { metalness: 0.6, roughness: 0.6 });
    for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; const r = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.4, 4), rebar); r.position.set(Math.cos(a) * 0.62, 6.65, Math.sin(a) * 0.62); r.rotation.z = (hash(no + i) - 0.5) * 0.3; g.add(r); }
    if (!pillarNumCache.has(no)) pillarNumCache.set(no, new THREE.MeshStandardMaterial({ map: tex(textCanvas(['P-' + no], { w: 256, h: 96, bg: '#ffffff', fg: '#222', border: false, font: 'bold 54px "JetBrains Mono", monospace' })) }));
    const num = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.3), pillarNumCache.get(no)); num.position.set(0, 1.9, 0.83); g.add(num);
    return g;
  }
  const holeMat = new THREE.MeshStandardMaterial({ color: 0x141312, roughness: 1 }), rimMat2 = new THREE.MeshStandardMaterial({ color: 0x6b6459, roughness: 1 }), muddy = new THREE.MeshStandardMaterial({ color: 0x3d3a33, roughness: 0.05, metalness: 0.5 });
  const sprayMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, fog: true });
  const holeNumCache = new Map();
  function jagged(r, pts, sx, sz) { const s = new THREE.Shape(); pts.forEach((k, i) => { const a = i / pts.length * Math.PI * 2; const x = Math.cos(a) * r * k * sx, y = Math.sin(a) * r * k * sz; i ? s.lineTo(x, y) : s.moveTo(x, y); }); s.closePath(); const g = new THREE.ShapeGeometry(s); g.rotateX(-Math.PI / 2); return g; }
  function makePothole(o) {
    const g = new THREE.Group(), r = o.r * L;
    const rim = new THREE.Mesh(jagged(r, o.pts.map(k => k * 1.18), 1, 0.95), rimMat2); rim.position.y = 0.012; rim.receiveShadow = true; g.add(rim);
    const hole = new THREE.Mesh(jagged(r, o.pts, 1, 0.8), (o.mark % 2) ? muddy : holeMat); hole.position.y = 0.02; g.add(hole);
    const inner = new THREE.Mesh(jagged(r * 0.6, o.pts, 1, 0.7), holeMat); inner.position.set(r * 0.05, 0.024, r * 0.08); g.add(inner);
    if (o.mark) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r * 1.5, r * 1.5 + 0.07, 40), sprayMat); ring.rotation.x = -Math.PI / 2; ring.scale.set(1, 0.85, 1); ring.position.y = 0.03; g.add(ring);
      if (!holeNumCache.has(o.mark)) holeNumCache.set(o.mark, new THREE.MeshBasicMaterial({ map: tex(textCanvas([String(o.mark)], { w: 256, h: 96, bg: null, fg: '#ffffff', border: false, font: 'bold 72px "JetBrains Mono", monospace' })), transparent: true, opacity: 0.9 }));
      const n = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.52), holeNumCache.get(o.mark)); n.rotation.x = -Math.PI / 2; n.position.set(0, 0.03, r * 1.5 + 0.55); g.add(n);
    }
    return g;
  }
  const puddleMat = new THREE.MeshStandardMaterial({ color: 0x2a3440, roughness: 0.02, metalness: 0.85, envMapIntensity: 1.4 });
  const foamMat = M('#f7f7f2', { roughness: 0.9 });
  function makePuddle(o) {
    const g = new THREE.Group();
    if (o.foam) { for (let i = 0; i < 9; i++) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.35 + hash(i + o.rx * 99) * 0.3, 10, 8), foamMat); b.scale.y = 0.35; b.position.set((hash(i * 3) - 0.5) * o.rx * L * 1.4, 0.06, (hash(i * 5) - 0.5) * o.ry * L * 1.4); b.castShadow = true; g.add(b); } return g; }
    const pts = Array.from({ length: 18 }, (_, i) => 1 + 0.08 * Math.sin(i * 1.7 + o.rx * 20));
    const p = new THREE.Mesh(jagged(1, pts, o.rx * L, o.ry * L), puddleMat); p.position.y = 0.015; g.add(p);
    return g;
  }
  const steel = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, metalness: 1, roughness: 0.18 });
  function makeCoffee() {
    const g = new THREE.Group(), inner = new THREE.Group(); g.add(inner);
    const bowl = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.28, 0.02), new THREE.Vector2(0.34, 0.16), new THREE.Vector2(0.33, 0.17)], 20), steel); inner.add(bowl);
    const cup = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(0, 0.05), new THREE.Vector2(0.13, 0.05), new THREE.Vector2(0.17, 0.5), new THREE.Vector2(0.16, 0.51)], 20), steel); inner.add(cup);
    const froth = new THREE.Mesh(new THREE.CircleGeometry(0.155, 16), M('#e5cfaa')); froth.rotation.x = -Math.PI / 2; froth.position.y = 0.49; inner.add(froth);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffc040, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8 })); glow.scale.set(1.8, 1.8, 1); glow.position.y = 0.3; g.add(glow);
    return g;
  }
  function makeRepair() {
    const g = new THREE.Group(), inner = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: 0x0a3a1e, emissive: 0x2ee07a, emissiveIntensity: 1.6 });
    boxM(0.6, 0.18, 0.18, m, 0, 0, 0, inner); boxM(0.18, 0.6, 0.18, m, 0, 0, 0, inner); g.add(inner);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x40ff90, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.7 })); glow.scale.set(1.7, 1.7, 1); g.add(glow);
    return g;
  }
  const SHIRT = ['#c0392b', '#2e86c1', '#f4d03f', '#c2185b', '#16a085', '#e67e22', '#f5f5f5'];
  const skinMat = M('#8d5b3e', { roughness: 0.7 }), hairMat = M('#1c1712');
  function makePed(col) {
    const g = new THREE.Group(), shirt = M(SHIRT[col % SHIRT.length], { roughness: 0.85 }), pants = M(col % 2 ? '#2c3e50' : '#5d4e3c');
    const legs = []; g.add(blob(0.7, 0.7, 0.5));
    for (const sx of [-0.1, 0.1]) { const pivot = new THREE.Group(); pivot.position.set(sx, 0.85, 0); const leg = boxM(0.13, 0.85, 0.13, pants, 0, -0.42, 0, pivot); g.add(pivot); legs.push(pivot); }
    if (col === 3) { const sari = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.0, 12, 1, true), shirt); sari.position.y = 0.55; sari.castShadow = true; g.add(sari); }
    rb(0.4, 0.6, 0.24, 0.08, shirt, 0, 1.15, 0, g);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), skinMat); head.position.y = 1.62; head.castShadow = true; g.add(head);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), hairMat); hair.position.y = 1.64; g.add(hair);
    g.userData.legs = legs; return g;
  }
  const patchMats = [M('#2f3134', { roughness: 0.95 }), M('#6a6864', { roughness: 0.95 })], manholeMat = new THREE.MeshStandardMaterial({ color: 0x2f2f2f, roughness: 0.4, metalness: 0.7 });
  const gapMat = M('#221e1a', { roughness: 1 });

  const PROTO = {};
  const getProto = (k, f) => PROTO[k] || (PROTO[k] = f());

  // ---------------- dynamic object bookkeeping
  const live = new Map();      // sim object -> mesh
  let frameId = 0;
  function sync(obj, build) {
    let m = live.get(obj);
    if (!m) { m = build(); scene.add(m); live.set(obj, m); }
    m.userData.f = frameId; return m;
  }
  function sweep() { for (const [k, m] of live) if (m.userData.f !== frameId) { scene.remove(m); live.delete(k); } }

  // ---------------- player
  const scooter = makeScooter(); scene.add(scooter);
  scooter.traverse(o => { if (o.isMesh) o.castShadow = o.name !== 'blob'; });

  // ---------------- sun glare and dust in the light
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffd8a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity: 0.9 }));
  const sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffb070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity: 0.35 }));
  sunGlow.scale.set(70, 70, 1); sunHalo.scale.set(260, 260, 1); scene.add(sunHalo, sunGlow);
  const DUST_N = 260, dustPos = new Float32Array(DUST_N * 3), dustSeed = [];
  for (let i = 0; i < DUST_N; i++) dustSeed.push([(hash(i * 11) - 0.5) * 22, 0.4 + hash(i * 13) * 6, -hash(i * 17) * 40 + 4]);
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({ map: glowTex, color: 0xffd9a0, size: 0.09, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
  const dust = new THREE.Points(dustGeo, dustMat); dust.frustumCulled = false; scene.add(dust);

  // ---------------- rain (3D streaks around the camera)
  const RAIN_N = 1400, rainPos = new Float32Array(RAIN_N * 6);
  const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.LineBasicMaterial({ color: 0xc8d6e8, transparent: true, opacity: 0.0, fog: true, depthWrite: false });
  const rainMesh = new THREE.LineSegments(rainGeo, rainMat); rainMesh.frustumCulled = false; scene.add(rainMesh);
  const rainSeed = Array.from({ length: RAIN_N }, (_, i) => [(hash(i) - 0.5) * 40, hash(i * 3) * 18, -hash(i * 7) * 70 + 6]);

  // ---------------- post-processing
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera); composer.addPass(renderPass);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.55, 0.85); composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, speed: { value: 0 }, sat: { value: 1.12 }, contrast: { value: 1.07 }, vignette: { value: 0.42 }, desat: { value: 0 }, flash: { value: 0 }, tint: { value: new THREE.Vector3(1.03, 1.0, 0.95) }, time: { value: 0 }, dim: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform float sat, contrast, vignette, desat, flash, time, dim, speed; uniform vec3 tint; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + time)*43758.5453); }
      void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb;
        if (speed > 0.001){ vec2 dir = vUv - vec2(0.5, 0.55); float w = speed * 0.045 * smoothstep(0.12, 0.6, length(dir)); vec3 acc = c; for (int i = 1; i < 6; i++){ acc += texture2D(tDiffuse, vUv - dir * w * float(i) / 5.0).rgb; } c = acc / 6.0; }
        float l = dot(c, vec3(0.299,0.587,0.114));
        c = mix(vec3(l), c, sat*(1.0-desat));
        c = (c-0.5)*contrast+0.5;
        c += mix(vec3(-0.02,0.01,0.03), vec3(0.03,0.012,-0.02), smoothstep(0.2,0.8,l)) * (1.0-desat);   // teal shadows, warm highlights
        c *= tint;
        float d = distance(vUv, vec2(0.5)); c *= 1.0 - vignette*smoothstep(0.3, 0.9, d);
        c *= 1.0 - dim;
        c += flash;
        c += (h(vUv*1000.0)-0.5)*0.025;
        gl_FragColor = vec4(c, 1.0); }`
  });
  composer.addPass(grade);

  // ---------------- sizing + quality
  let W = 1, H = 1;
  function applyQuality() {
    const dpr = window.devicePixelRatio || 1;
    const pr = quality === 2 ? Math.min(dpr, 2) : quality === 1 ? Math.min(dpr, 1.5) : 1;
    renderer.setPixelRatio(pr); composer.setPixelRatio(pr);
    renderer.setSize(W, H, false); composer.setSize(W, H);
    bloom.enabled = quality > 0;
    renderer.shadowMap.enabled = quality > 0;
    sun.shadow.mapSize.set(quality === 2 ? 2048 : 1024, quality === 2 ? 2048 : 1024);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    scene.traverse(o => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach(m => m.needsUpdate = true); } });
  }
  function resize() {
    const r = stage.getBoundingClientRect(); W = Math.max(1, r.width); H = Math.max(1, r.height);
    camera.aspect = W / H; camera.fov = W / H < 0.7 ? 68 : 58; camera.updateProjectionMatrix();
    applyQuality();
  }
  resize();
  new ResizeObserver(resize).observe(stage);

  // ---------------- per-frame state
  const tmp = new THREE.Vector3();
  let camX = 0, camShake = 0, t = 0, lastWxKey = '', fpsAcc = 0, fpsN = 0, fpsTime = 0;
  const C = (h) => new THREE.Color(h);
  const SKY = {
    golden: { top: C('#2d5c98'), hor: C('#ffb27a'), sun: C('#ffcf96'), fog: C('#e8b48e'), hemiS: C('#c4d8ff'), hemiG: C('#8a6a50'), sunI: 2.8, hemiI: 1.15 },
    overcast: { top: C('#6c7681'), hor: C('#b0b5ba'), sun: C('#d8dde2'), fog: C('#a9afb5'), hemiS: C('#cfd6de'), hemiG: C('#5c5850'), sunI: 0.35, hemiI: 1.25 },
    night: { top: C('#03060f'), hor: C('#2a2a3c'), sun: C('#8fa8d8'), fog: C('#1d2232'), hemiS: C('#3a4c78'), hemiG: C('#1a1612'), sunI: 0.35, hemiI: 0.28 },
    nightO: { top: C('#090b10'), hor: C('#2b2b30'), sun: C('#7f8aa0'), fog: C('#202329'), hemiS: C('#353c4c'), hemiG: C('#15130f'), sunI: 0.12, hemiI: 0.32 }
  };
  const cA = new THREE.Color(), cB = new THREE.Color();

  function render(dt) {
    const G = PD.G, state = PD.state, road = PD.curRoad(), NIGHT = PD.NIGHT, sky = G.sky || { cloud: 0, rain: 0, dark: 0, fog: 0, wet: 0 };
    frameId++; t += dt;
    // auto quality: step down once if the frame rate stays low
    const nowT = performance.now(); const realDt = fpsTime ? (nowT - fpsTime) / 1000 : 0; fpsTime = nowT;
    if (state === 'run' && realDt < 0.5 && qPin == null) { fpsAcc += realDt; fpsN++; if (fpsAcc > 2.5) { const fps = fpsN / fpsAcc; if (fps < 42 && quality > 0) { quality--; applyQuality(); } else if (fps < 22 && quality === 0) api.tooSlow = true; fpsAcc = 0; fpsN = 0; } }

    // ---- lighting + sky from weather and theme
    const ov = clamp(sky.cloud * 0.9 + sky.rain * 0.3, 0, 1);
    const A = NIGHT ? SKY.night : SKY.golden, B = NIGHT ? SKY.nightO : SKY.overcast;
    skyU.top.value.copy(A.top).lerp(B.top, ov); skyU.horizon.value.copy(A.hor).lerp(B.hor, ov);
    skyU.sunColor.value.copy(A.sun).lerp(B.sun, ov); skyU.sunStrength.value = (1 - ov * 0.85) * (NIGHT ? 0.35 : 1); skyU.night.value = NIGHT ? 1 : 0;
    skyU.ground.value.copy(skyU.horizon.value).multiplyScalar(0.55);
    skyU.sunDir.value.set(NIGHT ? 0.45 : -0.42, NIGHT ? 0.35 : 0.13, -1).normalize();
    sun.color.copy(A.sun).lerp(B.sun, ov); sun.intensity = lerp(A.sunI, B.sunI, ov);
    hemi.color.copy(A.hemiS).lerp(B.hemiS, ov); hemi.groundColor.copy(A.hemiG).lerp(B.hemiG, ov); hemi.intensity = lerp(A.hemiI, B.hemiI, ov) + (G.flash || 0) * 3;
    cA.copy(A.fog).lerp(B.fog, ov); cB.set(NIGHT ? '#20242e' : '#c9ced2'); cA.lerp(cB, sky.fog * 0.8);
    scene.fog.color.copy(cA); scene.fog.density = 0.0045 + sky.fog * 0.019 + sky.rain * 0.006 + ov * 0.002;
    skylineMat.color.copy(cA).multiplyScalar(NIGHT ? 0.7 : 0.82); skylineMat.opacity = 1 - sky.fog * 0.8;
    renderer.toneMappingExposure = NIGHT ? 0.95 : 1.0 - sky.dark * 0.25;
    const wxKey = (NIGHT ? 'n' : 'd') + Math.round(ov * 4) + Math.round(sky.fog * 3);
    if (wxKey !== lastWxKey) { lastWxKey = wxKey; rebuildEnv(wxKey); }
    for (const c of clouds) { const u = c.userData; u.a += u.sp * dt * 0.2; c.position.set(Math.sin(u.a) * u.d, u.h, -Math.cos(u.a) * u.d); c.material.opacity = (0.35 + ov * 0.6) * (NIGHT ? 0.35 : 1) * (1 - sky.fog * 0.6); c.material.color.copy(cA).lerp(cB.set('#ffffff'), NIGHT ? 0 : 0.6 - ov * 0.4); }

    // wet road
    roadMat.roughness = lerp(0.88, 0.16, sky.wet); roadMat.envMapIntensity = lerp(0.35, 1.3, sky.wet); roadMat.color.setScalar(lerp(1.3, 0.75, sky.wet));
    pathMat.roughness = lerp(0.9, 0.35, sky.wet);

    // ---- scroll the ground
    const sc = G.scroll;
    asphaltTex.offset.y = (sc / TILE) % 1; bumpTex.offset.y = (sc * 12 / RL) % 1;
    kerbTex.offset.y = sc % 1; pathTex.offset.y = (sc / 0.84) % 1;

    // ---- camera
    const px = X(G.x);
    camX += (px * 0.62 - camX) * Math.min(1, dt * 5);
    const boost = Math.max(0, G.gear || 0), speedK = clamp((G.v - 3) / 6, 0, 1);
    const wasted = G.wasted && state === 'over';
    camShake = Math.max(camShake, G.shake || 0); camShake = Math.max(0, camShake - dt * 30);
    const sh = camShake * 0.012;
    let cy = 2.85 + speedK * 0.12, cz = 6.3 + speedK * 0.5, look = -22;
    if (wasted) { const w = clamp(G.wasted.t / 1.5, 0, 1); cy = lerp(cy, 1.4, w); cz = lerp(cz, 2.8, w); }
    camera.position.set(camX + (Math.random() - 0.5) * sh, cy + (Math.random() - 0.5) * sh, cz);
    camera.lookAt(camX * 0.9 + (px - camX) * 0.25, wasted ? 0.8 : 0.85, look);
    const lean = (G.lane + 0.5 - G.x);
    camera.rotation.z += lean * 0.035;
    const fov0 = W / H < 0.7 ? 68 : 58;
    camera.fov += ((fov0 + boost * 3 + speedK * 4) - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix();

    // sun + shadow box follow the camera target
    tmp.set(0, 0, -16);
    sun.target.position.copy(tmp); sun.position.copy(tmp).add(new THREE.Vector3(NIGHT ? 30 : -38, NIGHT ? 40 : 22, NIGHT ? -30 : -60));
    // sky follows the camera so it never clips
    skyline.position.x = camX * 0.3;

    // ---- player
    scooter.position.set(px, 0, 0);
    scooter.rotation.z = (reduceMotion ? 0 : lean * 0.42);
    scooter.rotation.y = lean * 0.12;
    const blink = G.inv > 0 && Math.floor(G.inv * 12) % 2 === 0;
    scooter.visible = !blink;
    for (const w of scooter.userData.wheels) w.rotation.x = -sc * L / 0.27;
    scooter.userData.tail.material.emissiveIntensity = (G.gear < 0 ? 4 : 1.2) * (NIGHT ? 1.6 : 1);
    headlight.intensity = NIGHT || sky.dark > 0.45 ? (NIGHT ? 90 : 40) : 0;
    headlight.position.set(px, 1.0, -0.7); headlight.target.position.set(px, 0, -18);
    riderFill.position.set(px + 0.6, 2.6, 2.6); riderFill.intensity = NIGHT ? 7 : sky.dark > 0.45 ? 3 : 0;

    // ---- buildings, lamps, piers: recycle by road position
    const zN = -3, zF = 34;
    const i0 = Math.floor((sc + zN) / BLEN), i1 = Math.floor((sc + zF) / BLEN);
    const want = new Set();
    for (let i = i0; i <= i1; i++) for (const side of [-1, 1]) {
      const k = i * 2 + (side > 0 ? 1 : 0); want.add(k);
      let b = buildings.get(k); if (!b) { b = makeBuilding(i, side); buildings.set(k, b); }
      b.position.z = Zm((i + 0.5) * BLEN - sc);
    }
    for (const [k, b] of buildings) if (!want.has(k)) { scene.remove(b); buildings.delete(k); }
    const lampOn = NIGHT || sky.dark > 0.5;
    lampHeadMat.emissiveIntensity = lampOn ? 3 : 0;
    const lw = new Set(), li0 = Math.floor((sc + zN) / 7), li1 = Math.floor((sc + zF) / 7);
    const nearLamps = [];
    for (let i = li0; i <= li1; i++) {
      lw.add(i); let l = lamps.get(i); if (!l) { l = makeLamp(); scene.add(l); lamps.set(i, l); }
      const side = i % 2 ? -1 : 1, z = i * 7 - sc;
      l.position.set(side < 0 ? X(-0.12) : X(3.12), KH, Zm(z)); l.rotation.y = side < 0 ? 0 : Math.PI;
      if (z > -1) nearLamps.push(l);
    }
    for (const [k, l] of lamps) if (!lw.has(k)) { scene.remove(l); lamps.delete(k); }
    const uw = new Set(), u0 = Math.floor((sc + zN) / POLE_GAP), u1 = Math.floor((sc + zF + 4) / POLE_GAP);
    for (let i = u0; i <= u1; i++) { uw.add(i); let u = cablePoles.get(i); if (!u) { u = makeUtilPole(i); scene.add(u); cablePoles.set(i, u); } u.position.set(0, KH, Zm(i * POLE_GAP - sc + 0.6)); }
    for (const [k, u] of cablePoles) if (!uw.has(k)) { scene.remove(u); cablePoles.delete(k); }
    lampLights.forEach((p, i) => { const l = nearLamps[i]; if (lampOn && l && quality > 0) { l.userData.head.getWorldPosition(p.position); p.position.y -= 0.3; p.intensity = NIGHT ? 60 : 25; } else p.intensity = 0; });
    viaduct.visible = !!road.metro;
    if (road.metro) {
      deck.position.z = Zm(RL * 0.8 - 4); stripe.position.z = parapet.position.z = deck.position.z;
      const pw = new Set(), p0 = Math.floor((sc + zN) / 4.5), p1 = Math.floor((sc + zF + 6) / 4.5);
      for (let i = p0; i <= p1; i++) { pw.add(i); let p = piers.get(i); if (!p) { p = makePier(); scene.add(p); piers.set(i, p); } p.position.z = Zm(i * 4.5 - sc); }
      for (const [k, p] of piers) if (!pw.has(k)) { scene.remove(p); piers.delete(k); }
      trainT -= dt; if (trainT < 0 && trainZ > 900) { trainZ = 60; trainT = 18 + hash(frameId) * 14; }
      if (trainZ < 900) { trainZ -= dt * 22; if (trainZ < -260) trainZ = 999; }
      train.position.z = trainZ; winMat.emissiveIntensity = NIGHT ? 1.2 : 0;
    } else for (const [k, p] of piers) { scene.remove(p); piers.delete(k); }

    // building windows/shops at night
    const winI = NIGHT ? 0.75 : sky.dark > 0.5 ? 0.3 : 0;
    for (const m of shopMats) m.emissiveIntensity = winI * 0.9;
    for (const m of signMats) m.emissiveIntensity = winI * 0.8;
    for (const m of hoardMats) m.emissiveIntensity = NIGHT ? 0.45 : 0;
    hoardLampMat.emissiveIntensity = NIGHT ? 2.5 : 0;
    for (const k in floorMats) floorMats[k].emissiveIntensity = winI;

    // ---- sim objects
    const PY = PD.PY;
    for (const o of G.obs) {
      if (o.done && (o.type === 'coffee' || o.type === 'repair')) continue;
      const z = PY - o.y; if (z < -3 || z > zF + 2) continue;
      let m;
      switch (o.type) {
        case 'pothole': m = sync(o, () => makePothole(o)); break;
        case 'puddle': m = sync(o, () => makePuddle(o)); break;
        case 'barricade': m = sync(o, () => getProto('barricade', makeBarricade).clone()); break;
        case 'cow': m = sync(o, () => getProto('cow', makeCow).clone()); m.rotation.y = o.flip ? Math.PI : 0; break;
        case 'auto': m = sync(o, () => { const a = makeAuto(); return a; }); { const brake = o.slow > 2 || (o.say && o.say.bad); m.userData.tailMat.emissiveIntensity = brake ? 6 : (NIGHT ? 2 : 1); } break;
        case 'bus': m = sync(o, () => getProto('bus', makeBus).clone()); break;
        case 'tanker': m = sync(o, () => getProto('tanker', makeTanker).clone()); break;
        case 'pillar': m = sync(o, () => makePillar(o.no)); break;
        case 'coffee': m = sync(o, () => getProto('coffee', makeCoffee).clone()); m.children[0].rotation.y = t * 2; m.position.y = 0; m.children[0].position.y = 0.55 + Math.sin(t * 4 + o.x) * 0.12; break;
        case 'repair': m = sync(o, () => getProto('repair', makeRepair).clone()); m.children[0].rotation.y = t * 2; m.children[0].position.y = 0.7 + Math.sin(t * 4 + o.x) * 0.12; break;
      }
      if (!m) continue;
      m.position.x = X(o.x); m.position.z = Zm(z);
      if (o.type === 'cow') m.position.z = Zm(z);
    }
    busGlass.emissiveIntensity = NIGHT ? 0.6 : 0;
    blinkMat.emissiveIntensity = (Math.floor(t * 3) % 2) ? 3 : 0.3;
    for (const p of G.peds) {
      const z = PY - p.y; if (z < -1 || z > zF) continue;
      const m = sync(p, () => makePed(p.col)); const x = PD.pedX(p);
      m.position.set(X(x), KH * (1 - p.off), Zm(z)); m.rotation.y = p.w < 0 ? Math.PI : 0;
      const sw = Math.sin(p.ph + t * 7) * 0.5; m.userData.legs[0].rotation.x = sw; m.userData.legs[1].rotation.x = -sw;
    }
    for (const tr of G.deco) { const z = PY - tr.y; if (z < -3 || z > zF) continue; const m = sync(tr, () => makeTree(Math.floor(tr.r * 1000))); m.position.set(tr.side < 0 ? X(-0.85) : X(3.85), KH, Zm(z)); }
    for (const sg of G.signs) { const z = PY - sg.y; if (z < -3 || z > zF) continue; const m = sync(sg, () => makeSign(sg.text)); m.position.set(sg.side < 0 ? X(-0.6) : X(3.6), KH, Zm(z)); }
    for (const d of G.decals) {
      const z = PY - d.y; if (z < -2 || z > zF || d.t === 'crack' || d.t === 'stain') continue;
      const m = sync(d, () => { if (d.t === 'manhole') { const c = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), manholeMat); c.rotation.x = -Math.PI / 2; return c; } const p = new THREE.Mesh(new THREE.PlaneGeometry(d.w * L, d.l * L), patchMats[d.r < 0.5 ? 0 : 1]); p.rotation.x = -Math.PI / 2; p.receiveShadow = true; return p; });
      m.position.set(X(d.x), 0.008, Zm(z));
    }
    for (const g of G.gaps) {
      const z = PY - g.y; if (z < -2 || z > zF) continue;
      const m = sync(g, () => { const pm = new THREE.Mesh(new THREE.PlaneGeometry(0.7 * L, g.h * L), gapMat); pm.rotation.x = -Math.PI / 2; return pm; });
      m.position.set(g.side < 0 ? X(-0.6) : X(3.6), KH + 0.006, Zm(z));
    }
    sweep();

    // ---- sun glare + dust motes in clear golden light
    const clear = NIGHT ? 0 : clamp(1 - ov * 1.3 - sky.fog, 0, 1);
    tmp.copy(skyU.sunDir.value).multiplyScalar(380).add(camera.position);
    sunGlow.position.copy(tmp); sunHalo.position.copy(tmp);
    sunGlow.material.opacity = 0.9 * clear; sunHalo.material.opacity = 0.35 * clear; sunGlow.visible = sunHalo.visible = clear > 0.02;
    dustMat.opacity = clear * 0.55 * (reduceMotion ? 0 : 1); dust.visible = dustMat.opacity > 0.01;
    if (dust.visible) {
      for (let i = 0; i < DUST_N; i++) { const d = dustSeed[i]; d[2] += G.v * L * dt * 0.9; d[1] += Math.sin(t * 0.7 + i) * dt * 0.08; d[0] += Math.cos(t * 0.5 + i) * dt * 0.06; if (d[2] > 5) { d[2] = -36 - hash(i + frameId) * 6; d[0] = camX + (hash(i * 3 + frameId) - 0.5) * 22; } dustPos[i * 3] = d[0]; dustPos[i * 3 + 1] = d[1]; dustPos[i * 3 + 2] = d[2]; }
      dustGeo.attributes.position.needsUpdate = true;
    }

    // ---- rain
    const rain = reduceMotion ? 0 : sky.rain;
    rainMat.opacity = rain * 0.55;
    rainMesh.visible = rain > 0.02;
    if (rainMesh.visible) {
      const fall = 26, wind = -3, slide = G.v * L;
      const n = Math.floor(RAIN_N * clamp(rain, 0.15, 1));
      for (let i = 0; i < RAIN_N; i++) {
        const s = rainSeed[i];
        if (i >= n) { rainPos.fill(0, i * 6, i * 6 + 6); continue; }
        s[1] -= fall * dt; s[2] += slide * dt; s[0] += wind * dt * 0.2;
        if (s[1] < 0 || s[2] > 6) { s[1] = 8 + hash(i + frameId) * 12; s[2] = -hash(i * 13 + frameId) * 70; s[0] = camX + (hash(i * 7 + frameId) - 0.5) * 40; }
        const o = i * 6; rainPos[o] = s[0]; rainPos[o + 1] = s[1]; rainPos[o + 2] = s[2]; rainPos[o + 3] = s[0] + wind * 0.02; rainPos[o + 4] = s[1] + 0.55; rainPos[o + 5] = s[2] - slide * 0.012;
      }
      rainGeo.attributes.position.needsUpdate = true;
    }

    // ---- post
    bloom.strength = NIGHT ? 0.55 : 0.4 + (sky.dark * 0.25);
    bloom.threshold = NIGHT ? 0.78 : 0.85;
    grade.uniforms.time.value = t;
    grade.uniforms.speed.value = (reduceMotion || quality === 0) ? 0 : clamp((Math.max(0, G.gear || 0) * 0.45 + speedK * 0.25) * (state === 'run' ? 1 : 0), 0, 1);
    grade.uniforms.flash.value = (G.flash || 0) * 0.35;
    grade.uniforms.sat.value = NIGHT ? 1.08 : lerp(1.16, 0.95, ov);
    grade.uniforms.tint.value.set(NIGHT ? 0.95 : lerp(1.04, 0.98, ov), NIGHT ? 0.98 : 1.0, NIGHT ? 1.06 : lerp(0.93, 1.01, ov));
    const wd = wasted ? clamp(G.wasted.t / 0.8, 0, 1) : 0;
    grade.uniforms.desat.value = wd * 0.92; grade.uniforms.dim.value = wd * 0.25;
    grade.uniforms.vignette.value = 0.42 + wd * 0.35;
    composer.render(dt);
  }
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // project a world point (lanes) to CSS pixels on the stage; s = pixels per lane there
  const pv = new THREE.Vector3(), pv2 = new THREE.Vector3();
  function project(x, z, h) {
    pv.set(X(x), (h || 0) * L, Zm(z)).project(camera);
    pv2.set(X(x + 1), (h || 0) * L, Zm(z)).project(camera);
    return { x: (pv.x + 1) / 2 * W, y: (1 - pv.y) / 2 * H, s: Math.abs(pv2.x - pv.x) / 2 * W, behind: pv.z > 1 };
  }
  function scooterScreen() { return project(PD.G.x, 0, 0.55); }
  const api = { ok: true, tooSlow: false, render, project, scooterScreen, get quality() { return quality; }, setQuality(q) { quality = q; applyQuality(); } };
  return api;
}

try {
  if (window.PD && !window.PD_NO3D) {
    const r = create(window.PD);
    if (r) { window.PD3 = r; document.getElementById('stage').classList.add('three'); }
  }
} catch (e) { console.warn('3D renderer unavailable, using 2D', e); window.PD3 = null; }
