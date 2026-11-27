import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { appendAudit } from "./lib/audit";
import { sha256Hex } from "./lib/sha256";
import { daysBetween, todayUtc } from "./lib/validate";
import { TICKET_TTL_MS } from "./outbox";

/** Replay protection: a nonce can be used once inside its validity window. */
export const consumeNonce = internalMutation({
  args: { nonce: v.string(), ttlMs: v.number() },
  handler: async (ctx, { nonce, ttlMs }) => {
    const seen = await ctx.db
      .query("nonces")
      .withIndex("by_nonce", (q) => q.eq("nonce", nonce))
      .unique();
    if (seen) return false;
    await ctx.db.insert("nonces", { nonce, expiresAt: Date.now() + ttlMs });
    return true;
  },
});

/** At most this many reminders per run (matches the write-back batch limit). */
export const MAX_REMINDERS_PER_RUN = 100;

/**
 * Is this loan due a reminder today? Overdue, still approved, not yet
 * reminded today (server-side idempotency, independent of what n8n
 * remembers), and the borrower has a verified email to send to.
 */
async function dueForReminder(ctx: QueryCtx, loan: Doc<"loans">, today: string): Promise<boolean> {
  if (loan.status !== "approved" || loan.endDate >= today) return false;
  const already = await ctx.db
    .query("automationEvents")
    .withIndex("by_key", (q) => q.eq("idempotencyKey", `reminder_sent:${loan._id}:${today}`))
    .unique();
  if (already) return false;
  const borrower = await ctx.db.get(loan.borrowerId);
  if (!borrower?.email) {
    console.warn(`[reminders] loan ${loan._id}: borrower has no verified email; skipped`);
    return false;
  }
  return true;
}

/** Step 1 of the reminder run: ids of loans due a reminder. No personal data. */
export const overdueCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const today = todayUtc();
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_status_end", (q) => q.eq("status", "approved").lt("endDate", today))
      .take(500);
    const out: Id<"loans">[] = [];
    for (const l of loans) {
      if (out.length >= MAX_REMINDERS_PER_RUN) break;
      if (await dueForReminder(ctx, l, today)) out.push(l._id);
    }
    return { reminderDate: today, loanIds: out };
  },
});

/**
 * Step 2: store the hashes of tickets the HTTP action generated (tickets are
 * made in the action runtime, like the outbox's, and only hashes reach the
 * database). Eligibility is checked again inside this transaction. Re-running
 * the workflow on the same day replaces the ticket, so a run that failed
 * part-way can be retried.
 */
export const storeReminderTickets = internalMutation({
  args: {
    reminderDate: v.string(),
    items: v.array(v.object({ loanId: v.id("loans"), ticketHash: v.string() })),
  },
  handler: async (ctx, { reminderDate, items }) => {
    const today = todayUtc();
    if (reminderDate !== today) return [];
    const expiresAt = Date.now() + TICKET_TTL_MS;
    const stored: Id<"loans">[] = [];
    for (const { loanId, ticketHash } of items.slice(0, MAX_REMINDERS_PER_RUN)) {
      const loan = await ctx.db.get(loanId);
      if (!loan || !(await dueForReminder(ctx, loan, today))) continue;
      const existing = await ctx.db
        .query("reminderTickets")
        .withIndex("by_loan_date", (q) => q.eq("loanId", loanId).eq("reminderDate", today))
        .unique();
      if (existing) await ctx.db.patch(existing._id, { ticketHash, expiresAt, consumedAt: undefined });
      else await ctx.db.insert("reminderTickets", { loanId, reminderDate: today, ticketHash, expiresAt });
      stored.push(loanId);
    }
    return stored;
  },
});

/**
 * Step 3: exchange tickets for exactly what one reminder needs. Unknown,
 * expired, used and no-longer-overdue tickets are left out of the response,
 * and the caller can't tell those cases apart. Every release of an email
 * address to n8n is recorded in the audit chain, with ids only.
 */
export const redeemReminderTickets = internalMutation({
  args: { tickets: v.array(v.string()) },
  handler: async (ctx, { tickets }) => {
    const today = todayUtc();
    const now = Date.now();
    const out = [];
    for (const ticket of new Set(tickets.slice(0, MAX_REMINDERS_PER_RUN))) {
      if (!/^[0-9a-f]{64}$/.test(ticket)) continue;
      const row = await ctx.db
        .query("reminderTickets")
        .withIndex("by_ticket", (q) => q.eq("ticketHash", sha256Hex(ticket)))
        .unique();
      if (!row || row.consumedAt || row.expiresAt < now || row.reminderDate !== today) continue;
      const loan = await ctx.db.get(row.loanId);
      // Re-checked at release time: a loan returned since step 2 discloses nothing.
      if (!loan || !(await dueForReminder(ctx, loan, today))) continue;
      const [borrower, tool] = await Promise.all([ctx.db.get(loan.borrowerId), ctx.db.get(loan.toolId)]);
      if (!borrower?.email) continue;
      await appendAudit(ctx, {
        actorRole: "n8n",
        action: "reminder_ticket.redeemed",
        targetType: "loan",
        targetId: loan._id,
      });
      out.push({
        ticket,
        loanId: loan._id,
        borrower: { email: borrower.email, firstName: borrower.firstName },
        toolName: tool?.name ?? "the tool",
        dueDate: loan.endDate,
        daysOverdue: daysBetween(loan.endDate, today),
      });
    }
    return out;
  },
});

/**
 * Idempotent write-back from n8n. The idempotency key is DERIVED HERE from
 * validated facts, not accepted from the caller, so n8n cannot (by bug or
 * compromise) mint unlimited distinct records.
 *  - notification_sent: must present the claim-check ticket for that event;
 *    the ticket is consumed. Key = notify:<eventId>
 *  - reminder_sent / reminder_failed: must present the reminder ticket for
 *    that loan; the date comes from the ticket, and the loan must still be
 *    overdue on it. Key = <kind>:<loanId>:<date>
 */
export const recordEvent = internalMutation({
  args: {
    loanId: v.id("loans"),
    kind: v.union(v.literal("notification_sent"), v.literal("reminder_sent"), v.literal("reminder_failed")),
    channel: v.string(),
    executionId: v.optional(v.string()),
    ticket: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const loan = await ctx.db.get(a.loanId);
    if (!loan) return { status: "rejected" as const, reason: "unknown_loan" };
    const channel = a.channel.replace(/[^a-z0-9_-]/gi, "").slice(0, 20) || "unknown";
    const executionId = a.executionId?.slice(0, 64);

    let key: string;
    let outboxId: string | undefined;
    if (!a.ticket || !/^[0-9a-f]{64}$/.test(a.ticket)) return { status: "rejected" as const, reason: "ticket_required" };
    if (a.kind === "notification_sent") {
      const row = await ctx.db
        .query("outbox")
        .withIndex("by_ticket", (q) => q.eq("ticketHash", sha256Hex(a.ticket!)))
        .unique();
      if (!row || row.loanId !== a.loanId) return { status: "rejected" as const, reason: "bad_ticket" };
      key = `notify:${row._id}`;
      outboxId = row._id;
      // Allow a grace period past expiry so a slow-but-successful send can still be recorded once.
      if (!row.ticketConsumedAt && (row.ticketExpiresAt ?? 0) + TICKET_TTL_MS < Date.now())
        return { status: "rejected" as const, reason: "ticket_expired" };
      if (!row.ticketConsumedAt) await ctx.db.patch(row._id, { ticketConsumedAt: Date.now() });
    } else {
      const row = await ctx.db
        .query("reminderTickets")
        .withIndex("by_ticket", (q) => q.eq("ticketHash", sha256Hex(a.ticket!)))
        .unique();
      if (!row || row.loanId !== a.loanId) return { status: "rejected" as const, reason: "bad_ticket" };
      const date = row.reminderDate;
      if (!row.consumedAt && row.expiresAt + TICKET_TTL_MS < Date.now())
        return { status: "rejected" as const, reason: "ticket_expired" };
      if (loan.status !== "approved" || loan.endDate >= date)
        return { status: "rejected" as const, reason: "not_overdue" };
      key = `${a.kind}:${a.loanId}:${date}`;
      if (!row.consumedAt) await ctx.db.patch(row._id, { consumedAt: Date.now() });
    }

    const existing = await ctx.db
      .query("automationEvents")
      .withIndex("by_key", (q) => q.eq("idempotencyKey", key))
      .unique();
    if (existing) return { status: "duplicate" as const, key };

    await ctx.db.insert("automationEvents", {
      idempotencyKey: key,
      loanId: a.loanId,
      kind: a.kind,
      channel,
      executionId,
      at: Date.now(),
    });
    await appendAudit(ctx, {
      actorRole: "n8n",
      action: `automation.${a.kind}`,
      targetType: outboxId ? "outbox" : "loan",
      targetId: outboxId ?? a.loanId,
    });
    return { status: "recorded" as const, key };
  },
});

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SECRETISH_RE = /\b[0-9a-f]{32,}\b/gi;

/** Error workflow sink. Scrubs emails and token-like strings before storing. */
export const recordError = internalMutation({
  args: {
    workflow: v.string(),
    node: v.string(),
    message: v.string(),
    executionId: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const workflow = a.workflow.slice(0, 80);
    const node = a.node.slice(0, 80);
    const executionId = a.executionId?.slice(0, 64);
    const message = a.message.replace(EMAIL_RE, "[email]").replace(SECRETISH_RE, "[redacted]").slice(0, 500);
    const fingerprint = sha256Hex(JSON.stringify([executionId ?? message, workflow, node]));

    const dup = await ctx.db
      .query("automationErrors")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
      .unique();
    if (dup) return { status: "duplicate" as const };

    const id = await ctx.db.insert("automationErrors", {
      fingerprint,
      workflow,
      node,
      message,
      executionId,
      at: Date.now(),
    });
    await appendAudit(ctx, { actorRole: "n8n", action: "automation.error", targetType: "automationError", targetId: id });
    return { status: "recorded" as const };
  },
});
