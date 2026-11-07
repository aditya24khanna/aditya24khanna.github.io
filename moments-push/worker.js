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
