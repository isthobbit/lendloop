// LendLoop signing helpers for n8n Code nodes.
// Source of truth for the snippet that scripts/build-n8n-workflows.mjs inlines
// into every Code node that signs or verifies. Mirrors convex/lib/signing.ts;
// tests/signing.test.ts proves the two are interoperable.
//
// Requires NODE_FUNCTION_ALLOW_BUILTIN=crypto on the n8n instance.
const crypto = require('crypto');
const LL_VERSION = 'LENDLOOP-HMAC-SHA256-V1';
const LL_MAX_SKEW = 300;

function llParseKeys(raw) {
  const ring = new Map();
  for (const part of String(raw || '').split(',')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const kid = part.slice(0, i).trim();
    const secret = part.slice(i + 1).trim();
    if (kid && secret.length >= 32) ring.set(kid, secret);
  }
  return ring;
}

function llCanonical(p) {
  const bodyHash = crypto.createHash('sha256').update(p.body, 'utf8').digest('hex');
  return [LL_VERSION, p.keyId, p.timestamp, p.nonce, p.method.toUpperCase(), p.route, bodyHash].join('\n');
}

function llSign(p) {
  const first = llParseKeys(p.keys).entries().next();
  if (first.done) throw new Error('LendLoop signing key is not configured');
  const [keyId, secret] = first.value;
  const timestamp = String(Math.floor((p.now || Date.now()) / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(llCanonical({ keyId, timestamp, nonce, method: p.method, route: p.route, body: p.body }), 'utf8')
    .digest('hex');
  return {
    'x-lendloop-key-id': keyId,
    'x-lendloop-timestamp': timestamp,
    'x-lendloop-nonce': nonce,
    'x-lendloop-signature': sig,
  };
}

function llVerify(p) {
  const h = {};
  for (const [k, v] of Object.entries(p.headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  const keyId = h['x-lendloop-key-id'] || '';
  const ts = h['x-lendloop-timestamp'] || '';
  const nonce = h['x-lendloop-nonce'] || '';
  const sig = h['x-lendloop-signature'] || '';
  if (!keyId || !ts || !nonce || !sig) return { ok: false, reason: 'missing_headers' };
  if (!/^[0-9a-f]{32}$/i.test(nonce)) return { ok: false, reason: 'bad_nonce' };
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, reason: 'bad_timestamp' };
  const secret = llParseKeys(p.keys).get(keyId);
  if (!secret) return { ok: false, reason: 'unknown_key' };
  const nowSec = Math.floor((p.now || Date.now()) / 1000);
  if (Math.abs(nowSec - Number(ts)) > LL_MAX_SKEW) return { ok: false, reason: 'stale' };
  if (!/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, reason: 'bad_signature_format' };
  const expected = crypto
    .createHmac('sha256', secret)
    .update(llCanonical({ keyId, timestamp: ts, nonce, method: p.method, route: p.route, body: p.body }), 'utf8')
    .digest();
  const given = Buffer.from(sig, 'hex');
  if (!crypto.timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, keyId, nonce, timestamp: Number(ts) };
}

function llMaskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  return local ? local.slice(0, 1) + '***@' + (domain || '') : '-';
}
