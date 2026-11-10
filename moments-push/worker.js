/* Moments reminder worker (Cloudflare Workers + KV + Cron).
 *
 * Stores, per phone: the push endpoint, a reminder time (HH:MM) and a time zone.
 * Never receives photos, videos or captions. Every 15 minutes it sends an EMPTY
 * push to phones whose reminder time has arrived; the phone decides what to say.
 *
 * Bindings (wrangler.toml):  SUBS (KV)
 * Secrets:                   VAPID_PUBLIC (base64url, 65-byte raw key), VAPID_PRIVATE_JWK (JSON)
 * Vars:                      VAPID_SUBJECT, ALLOWED_ORIGIN
 */

const WINDOW_MIN = 30; // send if now is 0–29 min past the chosen time and not yet sent today

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const reply = (body, status = 200) => new Response(body, { status, headers: { ...cors, 'Content-Type': 'text/plain' } });

    if (req.method === 'GET' && url.pathname === '/vapid') return reply(env.VAPID_PUBLIC);

    if (req.method === 'POST' && (url.pathname === '/subscribe' || url.pathname === '/unsubscribe')) {
      const origin = req.headers.get('Origin');
      if (origin && origin !== env.ALLOWED_ORIGIN) return reply('forbidden', 403);
      const text = await req.text();
      if (text.length > 4096) return reply('too large', 413);
      let body;
      try { body = JSON.parse(text); } catch (_) { return reply('bad json', 400); }

      if (url.pathname === '/unsubscribe') {
        if (!validEndpoint(body.endpoint)) return reply('bad endpoint', 400);
        await env.SUBS.delete(await keyFor(body.endpoint));
        return reply('ok');
      }
      const sub = body.sub || {};
      if (!validEndpoint(sub.endpoint)) return reply('bad endpoint', 400);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time || '')) return reply('bad time', 400);
      if (!validTz(body.tz)) return reply('bad tz', 400);
      const key = await keyFor(sub.endpoint);
      const prev = JSON.parse((await env.SUBS.get(key)) || 'null');
      // Keep "sent today" if the time didn't change, so re-saving can't double-send.
      const last = prev && prev.time === body.time ? prev.last : '';
      await env.SUBS.put(key, JSON.stringify({ endpoint: sub.endpoint, time: body.time, tz: body.tz, last }));
      return reply('ok');
    }
    if (url.pathname.startsWith('/ai/')) {
      const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
      if (req.method === 'GET' && url.pathname === '/ai/health') return json({ ai: !!env.AI });
      if (req.method !== 'POST') return json({ error: 'method' }, 405);
      const origin = req.headers.get('Origin');
      if (origin && origin !== env.ALLOWED_ORIGIN) return json({ error: 'forbidden' }, 403);
      if (limited(req.headers.get('CF-Connecting-IP') || 'x')) return json({ error: 'slow down' }, 429);
      const text = await req.text();
      if (text.length > 24000) return json({ error: 'too large' }, 413);
      let body;
      try { body = JSON.parse(text); } catch (_) { return json({ error: 'bad json' }, 400); }
      try {
        const route = url.pathname.slice(4);
        if (route === 'tidy') return json(await aiTidy(env, body));
        if (route === 'title') return json(await aiTitle(env, body));
        if (route === 'year') return json(await aiYear(env, body));
        return json({ error: 'not found' }, 404);
      } catch (e) {
        return json({ error: String(e && e.message || e).slice(0, 120) }, 502);
      }
    }
    return reply('not found', 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};

export async function run(env, now = new Date(), send = sendPush) {
  let cursor, sent = 0, removed = 0;
  do {
    const page = await env.SUBS.list({ cursor });
    for (const k of page.keys) {
      const rec = JSON.parse((await env.SUBS.get(k.name)) || 'null');
      if (!rec) continue;
      const { date, minutes } = localNow(rec.tz, now);
      if (!isDue(rec, date, minutes)) continue;
      const status = await send(rec.endpoint, env);
      if (status === 404 || status === 410) { await env.SUBS.delete(k.name); removed++; continue; }
      if (status >= 200 && status < 300) { rec.last = date; await env.SUBS.put(k.name, JSON.stringify(rec)); sent++; }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { sent, removed };
}

export function isDue(rec, date, minutes) {
  if (rec.last === date) return false;
  const [h, m] = rec.time.split(':').map(Number);
  const diff = minutes - (h * 60 + m);
  return diff >= 0 && diff < WINDOW_MIN;
}

export function localNow(tz, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export async function sendPush(endpoint, env) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidAuth(endpoint, env), TTL: '3600', Urgency: 'normal', 'Content-Length': '0' },
    });
    return res.status;
  } catch (_) {
    return 0;
  }
}

export async function vapidAuth(endpoint, env) {
  const enc = new TextEncoder();
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT,
  })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(new Uint8Array(sig))}, k=${env.VAPID_PUBLIC}`;
}

function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function keyFor(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return b64u(new Uint8Array(h));
}
function validEndpoint(e) {
  try { const u = new URL(e); return u.protocol === 'https:' && e.length < 1024; } catch (_) { return false; }
}
function validTz(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return typeof tz === 'string' && tz.length < 64; } catch (_) { return false; }
}


/* ---------- AI help (caption text only; never photos; nothing stored) ----------
   Needs a Workers AI binding named AI. On the Workers Free plan usage above the
   daily free allowance simply fails, so this can't run up a bill. */
const AI_MODELS = ['@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3.2-3b-instruct'];
const hits = new Map();
export function limited(ip, now = Date.now()) {
  const h = (hits.get(ip) || []).filter((t) => now - t < 600000);
  h.push(now); hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.length > 40; // 40 requests per 10 minutes per IP (best effort, per isolate)
}
async function runAI(env, messages, maxTokens) {
  if (!env.AI) throw new Error('AI binding missing');
  const models = env.AI_MODEL ? [env.AI_MODEL, ...AI_MODELS] : AI_MODELS;
  let last;
  for (const model of models) {
    try {
      const r = await env.AI.run(model, { messages, max_tokens: maxTokens, temperature: 0.2 });
      const t = r && (r.response ?? (r.result && r.result.response));
      if (t && String(t).trim()) return String(t).trim();
    } catch (e) { last = e; }
  }
  throw last || new Error('empty AI response');
}
const words = (t) => (t.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
const clip = (s, n) => String(s || '').slice(0, n);
export function stripWrap(t) {
  return t.replace(/^\s*(here('| i)s|sure|okay)[^:\n]*:\s*/i, '').replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
}

// Tidy dictation: punctuation, capitals, obvious recognition slips. Same words, same language mix.
export async function aiTidy(env, body) {
  const input = clip(body.text, 400).trim();
  if (!input) return { text: '', changed: false };
  const out = stripWrap(await runAI(env, [
    { role: 'system', content: 'You fix dictated captions. Add punctuation and capital letters, and fix obvious speech-recognition spelling mistakes. Keep every word the speaker chose, keep their language mix (English, Hindi or Hinglish in Roman script) and keep the meaning. Never add, remove, translate or rephrase. Reply with the corrected caption only.' },
    { role: 'user', content: input },
  ], 200));
  // Guard: reject anything that isn't the same caption, lightly corrected.
  const a = words(input), b = words(out);
  const setA = new Set(a);
  const kept = b.filter((w) => setA.has(w)).length / Math.max(b.length, 1);
  const ratio = b.length / Math.max(a.length, 1);
  if (!out || kept < 0.75 || ratio < 0.7 || ratio > 1.3) return { text: input, changed: false, rejected: true };
  return { text: out.slice(0, 280), changed: out !== input };
}

// Recap title from the person's own captions.
export async function aiTitle(env, body) {
  const caps = (Array.isArray(body.captions) ? body.captions : []).map((c) => clip(c, 120).trim()).filter(Boolean).slice(0, 40);
  if (caps.length < 2) return { title: '' };
  let t = stripWrap(await runAI(env, [
    { role: 'system', content: 'Write a short title (2 to 5 words) for a collection of someone’s personal moments, using only what these captions say. Warm and plain. No quotes, emojis, hashtags or ending punctuation. Do not invent people, places or events. Reply with the title only.' },
    { role: 'user', content: caps.map((c) => '- ' + c).join('\n') },
  ], 24));
  t = t.split('\n')[0].replace(/[#*_]/g, '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '');
  for (let i = 0; i < 2; i++) t = stripWrap(t.trim()).replace(/[.!?,;:]+$/, '').trim();
  const n = words(t).length;
  if (n < 1 || n > 7 || t.length > 48) return { title: '' };
  return { title: t };
}

// Year in review: a short look back, built only from captions and counts.
export async function aiYear(env, body) {
  const months = (Array.isArray(body.months) ? body.months : []).slice(0, 12).map((m) => ({
    month: clip(m.month, 12), captions: (Array.isArray(m.captions) ? m.captions : []).map((c) => clip(c, 100)).filter(Boolean).slice(0, 10),
  })).filter((m) => m.captions.length);
  if (!months.length) return { text: '' };
  const s = body.stats || {};
  const facts = `Year: ${clip(body.year, 4)}. Moments saved: ${Number(s.moments) || 0}, on ${Number(s.days) || 0} days. Most used moods: ${clip((s.moods || []).join(' '), 40) || 'none'}. Most used tags: ${clip((s.tags || []).join(', '), 120) || 'none'}.`;
  const notes = months.map((m) => `${m.month}:\n` + m.captions.map((c) => '- ' + c).join('\n')).join('\n');
  let t = stripWrap(await runAI(env, [
    { role: 'system', content: 'Write a warm, plain look back at someone’s year, 110 to 170 words, in the second person ("you"). Use only facts in the notes and captions: never invent people, places, events or feelings that are not there. No headings, lists, emojis or hashtags. End with one gentle line about the year ahead.' },
    { role: 'user', content: facts + '\n\nCaptions by month:\n' + notes },
  ], 400));
  t = t.replace(/^#+\s.*$/gm, '').replace(/[*_]{1,2}/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const w = t.split(/\s+/);
  if (w.length > 220) { t = w.slice(0, 220).join(' '); const end = t.lastIndexOf('.'); if (end > 200) t = t.slice(0, end + 1); }
  return { text: t };
}
