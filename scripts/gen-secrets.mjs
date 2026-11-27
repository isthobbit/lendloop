#!/usr/bin/env node
/**
 * Generates the two HMAC key pairs (one per direction) and prints exactly
 * where each value goes. Nothing is written to disk.
 *
 *   node scripts/gen-secrets.mjs
 */
import { randomBytes } from "node:crypto";

const stamp = new Date().toISOString().slice(0, 7); // e.g. 2026-11 -> key id hints at age
const c2n = `c2n-${stamp}:${randomBytes(32).toString("base64url")}`;
const n2c = `n2c-${stamp}:${randomBytes(32).toString("base64url")}`;
const enc = randomBytes(32).toString("base64url");

console.log(`
# 1) Convex deployment env (never in the repo):
npx convex env set CONVEX_TO_N8N_KEYS '${c2n}'
npx convex env set N8N_TO_CONVEX_KEYS '${n2c}'

# 2) .env.n8n (git-ignored; read by docker compose):
N8N_ENCRYPTION_KEY=${enc}
LENDLOOP_C2N_KEYS=${c2n}
LENDLOOP_N2C_KEYS=${n2c}

# Rotation: prepend a new key ("new:...,old:...") on the VERIFYING side first,
# then switch the SIGNING side to the new key, then drop the old one.
`);
