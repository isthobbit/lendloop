/**
 * LendLoop request signing (both directions: Convex -> n8n and n8n -> Convex).
 *
 * Canonical string (newline separated):
 *   LENDLOOP-HMAC-SHA256-V1
 *   <keyId>
 *   <unix timestamp, seconds>
 *   <nonce>
 *   <HTTP METHOD>
 *   <route>                 e.g. "/n8n/loans/overdue" or "n8n:loan-events"
 *   <hex sha256 of raw body> ("" body for GET)
 *
 * Why more than "HMAC of the body":
 *  - timestamp + nonce   -> captured requests cannot be replayed
 *  - method + route      -> a valid signature for one endpoint cannot be
 *                           replayed against another (cross-endpoint replay)
 *  - keyId               -> zero-downtime secret rotation (two keys valid at once)
 *  - separate secrets per direction -> leaking n8n's outbound key does not let
 *                           anyone forge events *to* n8n, and vice versa
 *
 * The same algorithm is implemented inside the n8n Code nodes
 * (n8n/workflows/*.json); tests/signing.test.ts checks both stay compatible.
 */

export const SIGNING_VERSION = "LENDLOOP-HMAC-SHA256-V1";
export const MAX_CLOCK_SKEW_SECONDS = 300;

export const HEADER = {
  keyId: "x-lendloop-key-id",
  timestamp: "x-lendloop-timestamp",
  nonce: "x-lendloop-nonce",
  signature: "x-lendloop-signature",
} as const;

export type KeyRing = Map<string, string>;

/** Parses "kid1:secret1,kid2:secret2". The first key is the active signing key. */
export function parseKeyRing(raw: string | undefined): KeyRing {
  const ring: KeyRing = new Map();
  if (!raw) return ring;
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const kid = part.slice(0, idx).trim();
    const secret = part.slice(idx + 1).trim();
    if (kid && secret.length >= 32) ring.set(kid, secret);
  }
  return ring;
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256HexAsync(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

export async function canonicalString(p: {
  keyId: string;
  timestamp: string;
  nonce: string;
  method: string;
  route: string;
  body: string;
}): Promise<string> {
  return [
    SIGNING_VERSION,
    p.keyId,
    p.timestamp,
    p.nonce,
    p.method.toUpperCase(),
    p.route,
    await sha256HexAsync(p.body),
  ].join("\n");
}

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Produces the headers for an outbound signed request. */
export async function signRequest(p: {
  ring: KeyRing;
  method: string;
  route: string;
  body: string;
  now?: number;
}): Promise<Record<string, string>> {
  const first = p.ring.entries().next();
  if (first.done) throw new Error("No signing key configured");
  const [keyId, secret] = first.value;
  const timestamp = String(Math.floor((p.now ?? Date.now()) / 1000));
  const nonce = randomHex(16);
  const canonical = await canonicalString({ keyId, timestamp, nonce, method: p.method, route: p.route, body: p.body });
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(canonical));
  return {
    [HEADER.keyId]: keyId,
    [HEADER.timestamp]: timestamp,
    [HEADER.nonce]: nonce,
    [HEADER.signature]: toHex(sig),
  };
}

export type VerifyResult =
  | { ok: true; keyId: string; nonce: string; timestamp: number }
  | { ok: false; reason: string };

/**
 * Verifies a signed request. Uses crypto.subtle.verify, which compares MACs in
 * constant time (no early-exit string comparison -> no timing oracle).
 * Nonce uniqueness is checked separately by the caller (needs the database).
 */
export async function verifyRequest(p: {
  ring: KeyRing;
  headers: { get(name: string): string | null };
  method: string;
  route: string;
  body: string;
  now?: number;
}): Promise<VerifyResult> {
  const keyId = p.headers.get(HEADER.keyId) ?? "";
  const ts = p.headers.get(HEADER.timestamp) ?? "";
  const nonce = p.headers.get(HEADER.nonce) ?? "";
  const sigHex = p.headers.get(HEADER.signature) ?? "";

  if (!keyId || !ts || !nonce || !sigHex) return { ok: false, reason: "missing_headers" };
  if (!/^[0-9a-f]{32}$/i.test(nonce)) return { ok: false, reason: "bad_nonce" };
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, reason: "bad_timestamp" };

  const secret = p.ring.get(keyId);
  if (!secret) return { ok: false, reason: "unknown_key" };

  const timestamp = Number(ts);
  const nowSec = Math.floor((p.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - timestamp) > MAX_CLOCK_SKEW_SECONDS) return { ok: false, reason: "stale" };

  const sig = fromHex(sigHex);
  if (!sig || sig.length !== 32) return { ok: false, reason: "bad_signature_format" };

  const canonical = await canonicalString({ keyId, timestamp: ts, nonce, method: p.method, route: p.route, body: p.body });
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sig, enc.encode(canonical));
  if (!valid) return { ok: false, reason: "bad_signature" };
  return { ok: true, keyId, nonce, timestamp };
}
