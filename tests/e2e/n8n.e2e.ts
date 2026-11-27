/**
 * End-to-end test of the REAL exported n8n workflows against a mock Convex
 * HTTP layer that uses the REAL Convex verification code (convex/lib/signing.ts).
 *
 * Proves: Convex-signed webhook accepted; tampered / replayed webhook rejected
 * with 401; ticket redeemed; idempotent write-back; daily reminder run writes
 * back; failures retry with fresh signatures and land in the error workflow.
 *
 * Usage (needs a local n8n install; Docker not required):
 *   N8N_BIN=/path/to/node_modules/n8n/bin/n8n npx tsx tests/e2e/n8n.e2e.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKeyRing, signRequest, verifyRequest } from "../../convex/lib/signing";

const N8N_BIN = process.env.N8N_BIN;
if (!N8N_BIN) throw new Error("Set N8N_BIN to the n8n executable");

const C2N = `c2n-test:${randomBytes(32).toString("base64url")}`;
const N2C = `n2c-test:${randomBytes(32).toString("base64url")}`;
const CONVEX_PORT = 3911;
const N8N_PORT = 5699;

// ---------------- mock Convex ----------------
const state = {
  seenNonces: new Set<string>(),
  rejectedAuth: 0,
  redeems: [] as string[],
  events: new Map<string, unknown>(),
  errors: [] as Record<string, unknown>[],
  overdueCalls: 0,
  reminderRedeems: 0,
  failRedeem: new Set<string>(),
};
const tickets = new Map<string, { loanId: string; type: string }>();
const reminderTickets = new Map<string, { loanId: string; reminderDate: string }>();

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const route = new URL(req.url!, "http://x").pathname;
  const send = (s: number, d: unknown) => {
    res.writeHead(s, { "content-type": "application/json" });
    res.end(JSON.stringify(d));
  };
  const headers = { get: (n: string) => (req.headers[n.toLowerCase()] as string | undefined) ?? null };
  const v = await verifyRequest({ ring: parseKeyRing(N2C), headers, method: req.method!, route, body: raw });
  if (!v.ok || state.seenNonces.has(v.nonce)) {
    state.rejectedAuth++;
    return send(401, { error: "unauthorized" });
  }
  state.seenNonces.add(v.nonce);
  const body = raw ? JSON.parse(raw) : null;

  if (route === "/n8n/notifications/redeem") {
    state.redeems.push(body.ticket);
    if (state.failRedeem.has(body.ticket)) return send(503, { error: "unavailable" });
    const t = tickets.get(body.ticket);
    if (!t) return send(410, { error: "ticket_unavailable" });
    return send(200, {
      eventId: "evt1",
      type: t.type,
      loanId: t.loanId,
      recipient: { email: "jane.doe@example.com", firstName: "Jane" },
      toolName: "Cordless drill",
      startDate: "2026-12-01",
      endDate: "2026-12-03",
      currentStatus: "pending",
    });
  }
  if (route === "/n8n/automation-events") {
    const results = body.events.map((e: Record<string, string>) => {
      let key: string;
      if (e.kind === "notification_sent") key = `notify:${e.ticket}`;
      else {
        // Like Convex: the reminder date comes from the ticket, not the caller.
        const rt = reminderTickets.get(e.ticket);
        if (!rt || rt.loanId !== e.loanId) return { status: "rejected", reason: "bad_ticket" };
        key = `${e.kind}:${rt.loanId}:${rt.reminderDate}`;
      }
      if (state.events.has(key)) return { status: "duplicate", key };
      state.events.set(key, e);
      return { status: "recorded", key };
    });
    return send(200, { results });
  }
  if (route === "/n8n/reminders/tickets") {
    state.overdueCalls++;
    // Like Convex: a fresh ticket per run, and the list holds no personal data.
    const ticket = randomBytes(32).toString("hex");
    reminderTickets.set(ticket, { loanId: "loanOverdue1", reminderDate: "2026-11-24" });
    return send(200, { reminderDate: "2026-11-24", tickets: [{ loanId: "loanOverdue1", ticket }] });
  }
  if (route === "/n8n/reminders/redeem") {
    state.reminderRedeems += body.tickets.length;
    const reminders = body.tickets
      .filter((t: string) => reminderTickets.has(t))
      .map((t: string) => ({
        ticket: t,
        loanId: reminderTickets.get(t)!.loanId,
        borrower: { email: "sam.borrower@example.com", firstName: "Sam" },
        toolName: "Ladder",
        dueDate: "2026-11-20",
        daysOverdue: 4,
      }));
    return send(200, { reminders });
  }
  if (route === "/n8n/automation-errors") {
    state.errors.push(body);
    return send(200, { status: "recorded" });
  }
  send(404, { error: "not_found" });
});

// ---------------- n8n ----------------
const home = mkdtempSync(join(tmpdir(), "lendloop-n8n-"));
const env = {
  ...process.env,
  N8N_USER_FOLDER: home,
  N8N_ENCRYPTION_KEY: randomBytes(24).toString("hex"),
  N8N_PORT: String(N8N_PORT),
  N8N_LISTEN_ADDRESS: "127.0.0.1",
  N8N_DIAGNOSTICS_ENABLED: "false",
  N8N_EXPRESSION_ENGINE: process.env.N8N_EXPRESSION_ENGINE ?? "vm",
  NODE_FUNCTION_ALLOW_BUILTIN: "crypto",
  CODE_ENABLE_STDOUT: "true",
  N8N_BLOCK_ENV_ACCESS_IN_NODE: "false",
  EXECUTIONS_DATA_SAVE_ON_SUCCESS: "none",
  LENDLOOP_CONVEX_SITE_URL: `http://127.0.0.1:${CONVEX_PORT}`,
  LENDLOOP_C2N_KEYS: C2N,
  LENDLOOP_N2C_KEYS: N2C,
};
const cli = (...args: string[]) => {
  // CLI runs alongside the server, so give its task broker its own port.
  const r = spawnSync(process.execPath, [N8N_BIN, ...args], {
    env: { ...env, N8N_RUNNERS_BROKER_PORT: "5798" },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`n8n ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

// Async variant: spawnSync would block this process and starve the mock Convex server.
const cliAsync = (...args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, [N8N_BIN, ...args], { env: { ...env, N8N_RUNNERS_BROKER_PORT: "5798" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`n8n ${args.join(" ")} failed:\n${out.slice(-3000)}`))));
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

async function sendEvent(ticket: string, opts: { tamper?: boolean; reuse?: Record<string, string>; body?: string } = {}) {
  const body = opts.body ?? JSON.stringify({ eventId: "evt1", type: "loan.requested", loanId: "loan1", ticket });
  const headers = opts.reuse ?? (await signRequest({ ring: parseKeyRing(C2N), method: "POST", route: "n8n:loan-events", body }));
  const res = await fetch(`http://127.0.0.1:${N8N_PORT}/webhook/lendloop-loan-events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: opts.tamper ? body.replace("loan1", "loan2") : body,
  });
  return { status: res.status, headers, body };
}

let n8n: ChildProcess | undefined;
let logs = "";
async function main() {
  await new Promise<void>((r) => server.listen(CONVEX_PORT, "127.0.0.1", r));
  cli("import:workflow", "--separate", `--input=${join(import.meta.dirname, "../../n8n/workflows")}`);
  for (const id of ["LLerrorHandler01", "LLloanEvents0001", "LLoverdueRemind1"]) cli("publish:workflow", `--id=${id}`);

  n8n = spawn(process.execPath, [N8N_BIN, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  n8n.stdout!.on("data", (d) => (logs += d));
  n8n.stderr!.on("data", (d) => (logs += d));
  await waitFor(() => /Editor is now accessible/.test(logs), 120_000, "n8n startup");
  await sleep(1500);

  // 1. Valid signed event -> 202, redeemed, notification recorded.
  const t1 = randomBytes(32).toString("hex");
  tickets.set(t1, { loanId: "loan1", type: "loan.requested" });
  const ok = await sendEvent(t1);
  assert.equal(ok.status, 202, "valid webhook should be accepted");
  await waitFor(() => state.events.has(`notify:${t1}`), 20_000, "notification write-back");
  assert.ok(/j\*\*\*@example\.com/.test(logs), "email must be masked in n8n logs");
  assert.ok(!/jane\.doe@example\.com/.test(logs), "raw email must never hit n8n logs");
  console.log("✓ valid event: accepted, redeemed, notification recorded, email masked in logs");

  // 2. Tampered body -> 401, nothing redeemed.
  const before = state.redeems.length;
  const bad = await sendEvent(randomBytes(32).toString("hex"), { tamper: true });
  assert.equal(bad.status, 401);
  // 3. Exact replay of the valid request -> 401.
  const replay = await sendEvent(t1, { reuse: ok.headers, body: ok.body });
  assert.equal(replay.status, 401);
  await sleep(1000);
  assert.equal(state.redeems.length, before, "rejected webhooks must not reach Convex");
  console.log("✓ tampered and replayed webhooks rejected with 401");

  // 4. Daily reminders (manual run of the scheduled workflow).
  await cliAsync("execute", "--id=LLoverdueRemind1");
  assert.ok(state.events.has("reminder_sent:loanOverdue1:2026-11-24"), "reminder write-back");
  await cliAsync("execute", "--id=LLoverdueRemind1");
  assert.equal(
    [...state.events.keys()].filter((k) => k.startsWith("reminder_sent:loanOverdue1")).length,
    1,
    "second run must not duplicate the reminder",
  );
  assert.ok(state.reminderRedeems >= 2, "reminder contact details must come from ticket redemption");
  assert.ok(/s\*\*\*@example\.com/.test(logs), "borrower email must be masked in n8n logs");
  assert.ok(!/sam\.borrower@example\.com/.test(logs), "raw borrower email must never hit n8n logs");
  console.log("✓ overdue reminders: tickets issued and redeemed, written back, re-run is idempotent");

  // 5. Convex keeps failing -> retries with fresh signatures -> error workflow -> Convex error sink.
  const t2 = randomBytes(32).toString("hex");
  state.failRedeem.add(t2);
  const rejectedBefore = state.rejectedAuth;
  assert.equal((await sendEvent(t2)).status, 202);
  await waitFor(() => state.errors.length > 0, 60_000, "error workflow report");
  assert.equal(state.redeems.filter((r) => r === t2).length, 4, "4 attempts expected");
  assert.equal(state.rejectedAuth, rejectedBefore, "every retry must carry a fresh, valid signature");
  assert.match(String(state.errors[0].message), /failed after 4 attempts/);
  assert.ok(!/x-lendloop|signature|[0-9a-f]{64}/i.test(JSON.stringify(state.errors[0])), "error reports must not leak signatures/tickets");
  console.log(`✓ failure path: 4 re-signed attempts, then error workflow reported "${state.errors[0].node}"`);

  console.log("\nAll n8n end-to-end checks passed.");
}

main()
  .catch((e) => {
    console.error(e);
    if (process.env.E2E_DEBUG) console.error("---- n8n log tail ----\n" + logs.slice(-4000));
    process.exitCode = 1;
  })
  .finally(() => {
    n8n?.kill("SIGTERM");
    server.close();
  });
