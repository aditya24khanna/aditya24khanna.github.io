// Generates the VAPID key pair for the Moments reminder worker.
// Run once:  node keys.mjs   (Node 18 or newer)
// Then paste each value when wrangler asks (see README.md). Never commit the private key.
const { subtle } = globalThis.crypto;
const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
const jwk = await subtle.exportKey('jwk', pair.privateKey);
const b64u = (b) => Buffer.from(b).toString('base64url');

console.log('\nVAPID_PUBLIC (paste for: npx wrangler secret put VAPID_PUBLIC)\n');
console.log(b64u(raw));
console.log('\nVAPID_PRIVATE_JWK (paste for: npx wrangler secret put VAPID_PRIVATE_JWK)\n');
console.log(JSON.stringify(jwk));
console.log('\nKeep the private key out of git and chat. If it leaks, run this again and re-enter both.\n');
