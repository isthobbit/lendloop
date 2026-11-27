import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { auditHashInput, GENESIS_HASH } from "../convex/lib/audit";
import { sha256Hex } from "../convex/lib/sha256";
import { HEADER, parseKeyRing, signRequest, verifyRequest } from "../convex/lib/signing";
import { rangesOverlap } from "../convex/lib/validate";

// Load the exact snippet that is inlined into the n8n Code nodes.
const n8nSrc = readFileSync(new URL("../n8n/src/lendloop-crypto.js", import.meta.url), "utf8");
const sandbox: Record<string, unknown> = { require: createRequire(import.meta.url), Buffer };
vm.runInNewContext(`${n8nSrc}\nthis.llSign = llSign; this.llVerify = llVerify; this.llMaskEmail = llMaskEmail;`, sandbox);
const n8n = sandbox as unknown as {
  llSign: (p: { keys: string; method: string; route: string; body: string; now?: number }) => Record<string, string>;
  llVerify: (p: { keys: string; headers: Record<string, string>; method: string; route: string; body: string; now?: number }) => {
    ok: boolean;
    reason?: string;
  };
  llMaskEmail: (e: string) => string;
};

const K1 = "k1:" + "a".repeat(48);
const K2 = "k2:" + "b".repeat(48);
const headersOf = (h: Record<string, string>) => new Headers(h);

test("pure-TS sha256 matches node:crypto", () => {
  const samples = ["", "abc", "LendLoop ✓ ünïcode 🔐", "x".repeat(55), "x".repeat(56), "y".repeat(64), "z".repeat(1000)];
  for (const s of samples) assert.equal(sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"));
});

test("Convex -> n8n: Convex-signed webhook verifies in the n8n Code node", async () => {
  const body = JSON.stringify({ eventId: "e1", type: "loan.requested", loanId: "l1", ticket: "f".repeat(64) });
  const h = await signRequest({ ring: parseKeyRing(K1), method: "POST", route: "n8n:loan-events", body });
  assert.equal(n8n.llVerify({ keys: K1, headers: h, method: "POST", route: "n8n:loan-events", body }).ok, true);
});

test("n8n -> Convex: n8n-signed request verifies in the Convex HTTP action", async () => {
  const body = JSON.stringify({ events: [{ kind: "reminder_sent", loanId: "x" }] });
  const h = n8n.llSign({ keys: K1, method: "POST", route: "/n8n/automation-events", body });
  const r = await verifyRequest({ ring: parseKeyRing(K1), headers: headersOf(h), method: "POST", route: "/n8n/automation-events", body });
  assert.equal(r.ok, true);
});

test("GET with empty body (overdue endpoint) round-trips", async () => {
  const h = n8n.llSign({ keys: K1, method: "GET", route: "/n8n/loans/overdue", body: "" });
  const r = await verifyRequest({ ring: parseKeyRing(K1), headers: headersOf(h), method: "GET", route: "/n8n/loans/overdue", body: "" });
  assert.equal(r.ok, true);
});

test("tampered body is rejected", async () => {
  const h = n8n.llSign({ keys: K1, method: "POST", route: "/n8n/automation-events", body: '{"a":1}' });
  const r = await verifyRequest({ ring: parseKeyRing(K1), headers: headersOf(h), method: "POST", route: "/n8n/automation-events", body: '{"a":2}' });
  assert.deepEqual(r, { ok: false, reason: "bad_signature" });
});

test("signature for one route cannot be replayed on another route or method", async () => {
  const body = '{"ticket":"x"}';
  const h = n8n.llSign({ keys: K1, method: "POST", route: "/n8n/notifications/redeem", body });
  const otherRoute = await verifyRequest({ ring: parseKeyRing(K1), headers: headersOf(h), method: "POST", route: "/n8n/automation-errors", body });
  const otherMethod = await verifyRequest({ ring: parseKeyRing(K1), headers: headersOf(h), method: "GET", route: "/n8n/notifications/redeem", body });
  assert.equal(otherRoute.ok, false);
  assert.equal(otherMethod.ok, false);
});

test("stale timestamps are rejected (both implementations)", async () => {
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const h = n8n.llSign({ keys: K1, method: "POST", route: "/r", body: "", now: tenMinAgo });
  assert.deepEqual(await verifyRequest({ ring: parseKeyRing(K1), headers: headersOf(h), method: "POST", route: "/r", body: "" }), {
    ok: false,
    reason: "stale",
  });
  const c = await signRequest({ ring: parseKeyRing(K1), method: "POST", route: "n8n:loan-events", body: "", now: tenMinAgo });
  assert.equal(n8n.llVerify({ keys: K1, headers: c, method: "POST", route: "n8n:loan-events", body: "" }).reason, "stale");
});

test("key rotation: verifier holding [new, old] accepts both; unknown key rejected", async () => {
  const ring = parseKeyRing(`${K2},${K1}`);
  const oldSigned = n8n.llSign({ keys: K1, method: "POST", route: "/r", body: "{}" });
  const newSigned = n8n.llSign({ keys: K2, method: "POST", route: "/r", body: "{}" });
  assert.equal((await verifyRequest({ ring, headers: headersOf(oldSigned), method: "POST", route: "/r", body: "{}" })).ok, true);
  assert.equal((await verifyRequest({ ring, headers: headersOf(newSigned), method: "POST", route: "/r", body: "{}" })).ok, true);
  const onlyNew = parseKeyRing(K2);
  assert.deepEqual(await verifyRequest({ ring: onlyNew, headers: headersOf(oldSigned), method: "POST", route: "/r", body: "{}" }), {
    ok: false,
    reason: "unknown_key",
  });
});

test("short secrets are refused by the key ring parser", () => {
  assert.equal(parseKeyRing("k1:tooshort").size, 0);
});

test("missing or malformed headers are rejected without throwing", async () => {
  const r = await verifyRequest({ ring: parseKeyRing(K1), headers: headersOf({ [HEADER.keyId]: "k1" }), method: "POST", route: "/r", body: "" });
  assert.equal(r.ok, false);
  assert.equal(n8n.llVerify({ keys: K1, headers: {}, method: "POST", route: "/r", body: "" }).reason, "missing_headers");
});

test("email masking used in n8n logs", () => {
  assert.equal(n8n.llMaskEmail("jane.doe@example.com"), "j***@example.com");
});

test("audit hash chain detects tampering", () => {
  type E = Parameters<typeof auditHashInput>[0] & { hash: string };
  const chain: E[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= 5; seq++) {
    const e = { seq, at: 1_700_000_000_000 + seq, actorRole: "user", action: "loan.requested", targetType: "loan", targetId: `l${seq}`, prevHash: prev };
    const hash = sha256Hex(auditHashInput(e));
    chain.push({ ...e, hash });
    prev = hash;
  }
  const verify = (c: E[]) => {
    let p = GENESIS_HASH;
    for (const e of c) {
      const { hash, ...rest } = e;
      if (e.prevHash !== p || sha256Hex(auditHashInput(rest)) !== hash) return e.seq;
      p = hash;
    }
    return null;
  };
  assert.equal(verify(chain), null);
  const edited = chain.map((e) => (e.seq === 3 ? { ...e, action: "loan.approved" } : e));
  assert.equal(verify(edited), 3);
  const deleted = chain.filter((e) => e.seq !== 2);
  assert.equal(verify(deleted), 3);
});

test("date range overlap (inclusive)", () => {
  assert.equal(rangesOverlap("2026-01-01", "2026-01-05", "2026-01-05", "2026-01-07"), true);
  assert.equal(rangesOverlap("2026-01-01", "2026-01-04", "2026-01-05", "2026-01-07"), false);
});
