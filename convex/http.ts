import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, type ActionCtx } from "./_generated/server";
import { sha256Hex } from "./lib/sha256";
import { MAX_CLOCK_SKEW_SECONDS, parseKeyRing, randomHex, verifyRequest } from "./lib/signing";

/**
 * Machine-to-machine endpoints used ONLY by n8n. Every route:
 *  1. caps the body size,
 *  2. verifies the HMAC signature (key id, timestamp window, method + route bound),
 *  3. burns the nonce (replay protection),
 *  4. validates the JSON shape before touching the database,
 *  5. returns a generic 401 on any auth failure (the reason is only logged).
 * No CORS headers are set: browsers have no business calling these.
 */

const MAX_BODY_BYTES = 16 * 1024;

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

type Handler = (ctx: ActionCtx, body: unknown) => Promise<Response>;

function signed(handler: Handler) {
  return httpAction(async (ctx, request) => {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });

    const ring = parseKeyRing(process.env.N8N_TO_CONVEX_KEYS);
    if (ring.size === 0) {
      console.error("[http] N8N_TO_CONVEX_KEYS is not configured");
      return json(503, { error: "not_configured" });
    }
    const route = new URL(request.url).pathname;
    const result = await verifyRequest({ ring, headers: request.headers, method: request.method, route, body: raw });
    if (!result.ok) {
      console.warn(`[http] rejected ${request.method} ${route}: ${result.reason}`);
      return json(401, { error: "unauthorized" });
    }
    const fresh = await ctx.runMutation(internal.automation.consumeNonce, {
      nonce: `${result.keyId}:${result.nonce}`,
      ttlMs: MAX_CLOCK_SKEW_SECONDS * 2 * 1000,
    });
    if (!fresh) {
      console.warn(`[http] replayed nonce on ${route}`);
      return json(401, { error: "unauthorized" });
    }

    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "invalid_json" });
      }
    }
    try {
      return await handler(ctx, body);
    } catch (err) {
      // Validator failures (e.g. malformed ids) land here; don't echo internals.
      console.error(`[http] ${route} failed`, err);
      return json(400, { error: "bad_request" });
    }
  });
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, max = 200): string | undefined =>
  typeof x === "string" && x.length > 0 && x.length <= max ? x : undefined;

const http = httpRouter();

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => json(200, { ok: true })),
});

/**
 * Daily reminders, step 1: issue one single-use ticket per overdue loan.
 * The response holds ids, a date and tickets only: no names, no emails.
 * Tickets are generated here (action runtime); only their hashes are stored.
 */
http.route({
  path: "/n8n/reminders/tickets",
  method: "POST",
  handler: signed(async (ctx) => {
    const { reminderDate, loanIds } = await ctx.runQuery(internal.automation.overdueCandidates, {});
    const issued = loanIds.map((loanId) => ({ loanId, ticket: randomHex(32) }));
    const stored = new Set<string>(
      await ctx.runMutation(internal.automation.storeReminderTickets, {
        reminderDate,
        items: issued.map((i) => ({ loanId: i.loanId, ticketHash: sha256Hex(i.ticket) })),
      }),
    );
    return json(200, { reminderDate, tickets: issued.filter((i) => stored.has(i.loanId)) });
  }),
});

/** Daily reminders, step 2: exchange tickets for what each reminder needs (audited per loan). */
http.route({
  path: "/n8n/reminders/redeem",
  method: "POST",
  handler: signed(async (ctx, body) => {
    const raw = isObj(body) && Array.isArray(body.tickets) ? body.tickets : null;
    if (!raw || raw.length > 100) return json(400, { error: "bad_request" });
    const tickets = raw.map((t) => str(t, 64)).filter((t): t is string => !!t);
    const reminders = await ctx.runMutation(internal.automation.redeemReminderTickets, { tickets });
    return json(200, { reminders });
  }),
});

http.route({
  path: "/n8n/notifications/redeem",
  method: "POST",
  handler: signed(async (ctx, body) => {
    const ticket = isObj(body) ? str(body.ticket, 64) : undefined;
    if (!ticket) return json(400, { error: "bad_request" });
    const data = await ctx.runMutation(internal.outbox.redeemTicket, { ticket });
    // Unknown, expired and consumed tickets are indistinguishable to the caller.
    if (!data) return json(410, { error: "ticket_unavailable" });
    return json(200, data);
  }),
});

/**
 * Batched, idempotent write-back: { events: [...] } (max 100). Each event is
 * its own mutation, so one bad event never blocks the others. Re-sending the
 * same batch is safe: already-recorded events come back as "duplicate".
 */
http.route({
  path: "/n8n/automation-events",
  method: "POST",
  handler: signed(async (ctx, body) => {
    const events = isObj(body) && Array.isArray(body.events) ? body.events : null;
    if (!events || events.length === 0 || events.length > 100) return json(400, { error: "bad_request" });

    const results = [];
    for (const e of events) {
      const kind = isObj(e) ? e.kind : undefined;
      const loanId = isObj(e) ? str(e.loanId, 64) : undefined;
      if (!isObj(e) || !loanId || (kind !== "notification_sent" && kind !== "reminder_sent" && kind !== "reminder_failed")) {
        results.push({ status: "rejected", reason: "bad_event" });
        continue;
      }
      try {
        results.push(
          await ctx.runMutation(internal.automation.recordEvent, {
            loanId: loanId as Id<"loans">, // checked by the mutation's v.id("loans") validator
            kind,
            channel: str(e.channel, 40) ?? "unknown",
            executionId: str(e.executionId, 64),
            ticket: str(e.ticket, 64),
          }),
        );
      } catch {
        results.push({ status: "rejected", reason: "invalid_loan_id" });
      }
    }
    return json(200, { results });
  }),
});

http.route({
  path: "/n8n/automation-errors",
  method: "POST",
  handler: signed(async (ctx, body) => {
    if (!isObj(body)) return json(400, { error: "bad_request" });
    const result = await ctx.runMutation(internal.automation.recordError, {
      workflow: str(body.workflow, 200) ?? "unknown",
      node: str(body.node, 200) ?? "unknown",
      message: str(body.message, 5000) ?? "unknown error",
      executionId: str(body.executionId, 64),
    });
    return json(200, result);
  }),
});

export default http;
