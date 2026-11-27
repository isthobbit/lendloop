import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import { appendAudit } from "./lib/audit";
import { notFound, requireAdmin } from "./lib/auth";
import { sha256Hex } from "./lib/sha256";
import { parseKeyRing, randomHex, signRequest } from "./lib/signing";

export const MAX_ATTEMPTS = 6;
export const TICKET_TTL_MS = 15 * 60 * 1000;
export const N8N_EVENTS_ROUTE = "n8n:loan-events";

/** Exponential backoff with full jitter: ~30s, 1m, 2m, 4m, 8m (capped at 15m). */
function backoffMs(attempt: number): number {
  const base = Math.min(30_000 * 2 ** (attempt - 1), 15 * 60_000);
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

export const getForDelivery = internalQuery({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => ctx.db.get(outboxId),
});

export const attachTicket = internalMutation({
  args: { outboxId: v.id("outbox"), ticketHash: v.string(), expiresAt: v.number() },
  handler: async (ctx, { outboxId, ticketHash, expiresAt }) => {
    await ctx.db.patch(outboxId, { ticketHash, ticketExpiresAt: expiresAt, ticketConsumedAt: undefined });
  },
});

export const markDelivered = internalMutation({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.db.get(outboxId);
    if (!row || row.status !== "pending") return;
    await ctx.db.patch(outboxId, { status: "delivered", deliveredAt: Date.now(), attempts: row.attempts + 1 });
  },
});

export const markFailed = internalMutation({
  args: { outboxId: v.id("outbox"), error: v.string() },
  handler: async (ctx, { outboxId, error }) => {
    const row = await ctx.db.get(outboxId);
    if (!row || row.status !== "pending") return;
    const attempts = row.attempts + 1;
    const lastError = error.slice(0, 300);
    if (attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(outboxId, { status: "dead", attempts, lastError });
      await appendAudit(ctx, {
        actorRole: "system",
        action: "outbox.dead_letter",
        targetType: "outbox",
        targetId: outboxId,
        detail: row.type,
      });
      console.error(`[outbox] ${outboxId} dead-lettered after ${attempts} attempts: ${lastError}`);
      return;
    }
    await ctx.db.patch(outboxId, { attempts, lastError });
    await ctx.scheduler.runAfter(backoffMs(attempts), internal.outbox.deliver, { outboxId });
  },
});

/**
 * Delivers one event to n8n. The payload contains NO personal data: just an
 * opaque event id, the event type, the loan id and a short-lived claim-check
 * ticket. n8n redeems the ticket (signed call back to Convex) to get exactly
 * the fields it needs to notify the recipient. So the webhook body, n8n's
 * webhook execution log, and any proxy/WAF logs in between hold zero PII.
 */
export const deliver = internalAction({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.runQuery(internal.outbox.getForDelivery, { outboxId });
    if (!row || row.status !== "pending") return;

    const url = process.env.N8N_LOAN_EVENTS_WEBHOOK_URL;
    const ring = parseKeyRing(process.env.CONVEX_TO_N8N_KEYS);
    if (!url || ring.size === 0) {
      await ctx.runMutation(internal.outbox.markFailed, {
        outboxId,
        error: "Not configured: set N8N_LOAN_EVENTS_WEBHOOK_URL and CONVEX_TO_N8N_KEYS",
      });
      return;
    }

    // A fresh ticket per attempt; only its hash is stored.
    const ticket = randomHex(32);
    const expiresAt = Date.now() + TICKET_TTL_MS;
    await ctx.runMutation(internal.outbox.attachTicket, { outboxId, ticketHash: sha256Hex(ticket), expiresAt });

    const body = JSON.stringify({
      eventId: row._id,
      type: row.type,
      loanId: row.loanId,
      ticket,
      ticketExpiresAt: new Date(expiresAt).toISOString(),
      occurredAt: new Date(row.createdAt).toISOString(),
    });

    try {
      const headers = await signRequest({ ring, method: "POST", route: N8N_EVENTS_ROUTE, body });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        await ctx.runMutation(internal.outbox.markDelivered, { outboxId });
      } else {
        await ctx.runMutation(internal.outbox.markFailed, { outboxId, error: `HTTP ${res.status}` });
      }
    } catch (err) {
      await ctx.runMutation(internal.outbox.markFailed, {
        outboxId,
        error: err instanceof Error ? err.message : "network error",
      });
    }
  },
});

/**
 * Called (via the signed HTTP endpoint) by n8n. Returns only what a
 * notification needs. The ticket stays redeemable until it expires or is
 * consumed by the acknowledgement write-back, so an n8n retry can re-redeem.
 */
export const redeemTicket = internalMutation({
  args: { ticket: v.string() },
  handler: async (ctx, { ticket }) => {
    if (!/^[0-9a-f]{64}$/.test(ticket)) return null;
    const row = await ctx.db
      .query("outbox")
      .withIndex("by_ticket", (q) => q.eq("ticketHash", sha256Hex(ticket)))
      .unique();
    if (!row || row.ticketConsumedAt || !row.ticketExpiresAt || row.ticketExpiresAt < Date.now()) return null;

    const [loan, recipient] = await Promise.all([ctx.db.get(row.loanId), ctx.db.get(row.recipientId)]);
    if (!loan || !recipient?.email) {
      // Ids only: make "no verified email" visible in logs rather than silent.
      console.warn(`[outbox] ${row._id}: recipient ${row.recipientId} has no verified email; not notified`);
      return null;
    }
    const tool = await ctx.db.get(loan.toolId);

    await appendAudit(ctx, {
      actorRole: "n8n",
      action: "ticket.redeemed",
      targetType: "outbox",
      targetId: row._id,
    });
    return {
      eventId: row._id,
      type: row.type,
      loanId: loan._id,
      recipient: { email: recipient.email, firstName: recipient.firstName },
      toolName: tool?.name ?? "a tool",
      startDate: loan.startDate,
      endDate: loan.endDate,
      currentStatus: loan.status,
    };
  },
});

/** Admin: push a dead-lettered event back into the delivery queue. */
export const retryDead = mutation({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const admin = await requireAdmin(ctx);
    const row = await ctx.db.get(outboxId);
    if (!row || row.status !== "dead") notFound("Dead-letter event");
    await ctx.db.patch(outboxId, { status: "pending", attempts: 0, lastError: undefined });
    await ctx.scheduler.runAfter(0, internal.outbox.deliver, { outboxId });
    await appendAudit(ctx, { actor: admin, action: "outbox.retried", targetType: "outbox", targetId: outboxId });
  },
});
