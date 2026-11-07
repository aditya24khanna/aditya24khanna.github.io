# Moments reminder worker

A free Cloudflare Worker that sends Moments one daily reminder at each person's chosen time.

**What it stores, per phone:** the browser's push address, the reminder time and the time zone.
**What it never sees:** photos, videos, captions or names. The push is empty; the phone reads its own moments and decides what to say ("A year ago today", "What's today's moment?").

## Deploy (one time, about 10 minutes)

You need Node 18+ and a free Cloudflare account. Run these from this folder on your laptop.

1. **Log in**
   ```
   npx wrangler login
   ```
2. **Create the storage**
   ```
   npx wrangler kv namespace create SUBS
   ```
   Copy the `id` it prints into `wrangler.toml`, replacing `PASTE_KV_ID_HERE`.
3. **Make the keys**
   ```
   node keys.mjs
   ```
   It prints two values. Then:
   ```
   npx wrangler secret put VAPID_PUBLIC
   npx wrangler secret put VAPID_PRIVATE_JWK
   ```
   Paste the matching value at each prompt.
4. **Deploy**
   ```
   npx wrangler deploy
   ```
   It prints a URL like `https://moments-push.<your-subdomain>.workers.dev`.
5. **Send Claude that URL.** It goes into `CONFIG.pushURL` in `moments/app.js`, and the "Daily reminder" switch appears in Settings.

Don't commit the edited `wrangler.toml` (KV id) or anything from step 3.

## Check it works
- `https://<your-worker-url>/vapid` should show a long string (the public key).
- In Moments (installed on the home screen on iPhone): Settings → Daily reminder → on, pick a time a few minutes ahead. The notification arrives within 15 minutes of that time.
- Cloudflare dashboard → Workers → moments-push → Logs shows each cron run.

## Costs
Free tier is plenty: one list per cron run (96 a day), one read per phone per run, one write per phone per day.
