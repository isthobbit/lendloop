import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { appendAudit } from "./lib/audit";
import { forbidden, notFound, requireUser } from "./lib/auth";
import { enqueueLoanEvent } from "./lib/outbox";
import { enforceRateLimit } from "./lib/rateLimit";
import { cleanText, invalid, rangesOverlap, todayUtc, validateRange } from "./lib/validate";

async function approvedLoansFor(ctx: QueryCtx | MutationCtx, toolId: Id<"tools">) {
  return ctx.db
    .query("loans")
    .withIndex("by_tool", (q) => q.eq("toolId", toolId))
    .filter((q) => q.eq(q.field("status"), "approved"))
    .collect();
}

async function recentActivity(ctx: QueryCtx, loanId: Id<"loans">) {
  const events = await ctx.db
    .query("automationEvents")
    .withIndex("by_loan", (q) => q.eq("loanId", loanId))
    .order("desc")
    .take(3);
  return events.map((e) => ({ kind: e.kind, channel: e.channel, at: e.at }));
}

function shapeLoan(l: Doc<"loans">, today: string) {
  return {
    _id: l._id,
    status: l.status,
    startDate: l.startDate,
    endDate: l.endDate,
    note: l.note,
    createdAt: l.createdAt,
    isOverdue: l.status === "approved" && l.endDate < today,
    isActive: l.status === "approved" && l.startDate <= today,
  };
}

/** Borrower creates a request. */
export const request = mutation({
  args: {
    toolId: v.id("tools"),
    startDate: v.string(),
    endDate: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireUser(ctx);
    await enforceRateLimit(ctx, "borrowRequest", me._id);

    const tool = await ctx.db.get(args.toolId);
    if (!tool || tool.status !== "active") notFound("Tool");
    if (tool.ownerId === me._id) forbidden("You can't borrow your own tool.");

    validateRange(args.startDate, args.endDate);
    const note = args.note ? cleanText(args.note, "Note", 0, 200) : undefined;

    for (const l of await approvedLoansFor(ctx, tool._id)) {
      if (rangesOverlap(args.startDate, args.endDate, l.startDate, l.endDate))
        invalid("Those dates overlap an existing booking.");
    }
    const mine = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", me._id))
      .filter((q) => q.and(q.eq(q.field("toolId"), tool._id), q.eq(q.field("status"), "pending")))
      .collect();
    if (mine.length > 0) invalid("You already have a pending request for this tool.");

    const loanId = await ctx.db.insert("loans", {
      toolId: tool._id,
      ownerId: tool.ownerId, // copied from the tool, never from the client
      borrowerId: me._id,
      startDate: args.startDate,
      endDate: args.endDate,
      note,
      status: "pending",
      createdAt: Date.now(),
    });
    await enqueueLoanEvent(ctx, { type: "loan.requested", loanId, recipientId: tool.ownerId });
    await appendAudit(ctx, { actor: me, action: "loan.requested", targetType: "loan", targetId: loanId });
    return loanId;
  },
});

/**
 * Lender approves or declines a request on THEIR OWN tool. Deliberately not
 * available to admins either (separation of duties: admins moderate, they do
 * not lend other people's property).
 */
export const decide = mutation({
  args: { loanId: v.id("loans"), decision: v.union(v.literal("approve"), v.literal("decline")) },
  handler: async (ctx, { loanId, decision }) => {
    const me = await requireUser(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan || loan.ownerId !== me._id) notFound("Request");
    if (loan.status !== "pending") invalid("This request has already been handled.");

    const tool = await ctx.db.get(loan.toolId);
    if (!tool || tool.status !== "active") invalid("This tool is no longer listed.");

    const now = Date.now();
    if (decision === "decline") {
      await ctx.db.patch(loanId, { status: "declined", decidedAt: now });
      await enqueueLoanEvent(ctx, { type: "loan.declined", loanId, recipientId: loan.borrowerId });
      await appendAudit(ctx, { actor: me, action: "loan.declined", targetType: "loan", targetId: loanId });
      return;
    }

    if (loan.endDate < todayUtc()) invalid("This request's dates have already passed.");
    for (const l of await approvedLoansFor(ctx, loan.toolId)) {
      if (rangesOverlap(loan.startDate, loan.endDate, l.startDate, l.endDate))
        invalid("Those dates now overlap another approved loan.");
    }
    await ctx.db.patch(loanId, { status: "approved", decidedAt: now });
    await enqueueLoanEvent(ctx, { type: "loan.approved", loanId, recipientId: loan.borrowerId });
    await appendAudit(ctx, { actor: me, action: "loan.approved", targetType: "loan", targetId: loanId });

    // Any other pending request for overlapping dates can no longer be honoured.
    const pending = await ctx.db
      .query("loans")
      .withIndex("by_tool", (q) => q.eq("toolId", loan.toolId))
      .filter((q) => q.eq(q.field("status"), "pending"))
      .collect();
    for (const p of pending) {
      if (p._id !== loanId && rangesOverlap(loan.startDate, loan.endDate, p.startDate, p.endDate)) {
        await ctx.db.patch(p._id, { status: "declined", decidedAt: now });
        await enqueueLoanEvent(ctx, { type: "loan.declined", loanId: p._id, recipientId: p.borrowerId });
        await appendAudit(ctx, {
          actor: me,
          action: "loan.auto_declined",
          targetType: "loan",
          targetId: p._id,
          detail: `overlaps:${loanId}`,
        });
      }
    }
  },
});

/** Borrower withdraws their own pending request. */
export const cancel = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan || loan.borrowerId !== me._id) notFound("Request");
    if (loan.status !== "pending") invalid("Only pending requests can be cancelled.");
    await ctx.db.patch(loanId, { status: "cancelled", decidedAt: Date.now() });
    await enqueueLoanEvent(ctx, { type: "loan.cancelled", loanId, recipientId: loan.ownerId });
    await appendAudit(ctx, { actor: me, action: "loan.cancelled", targetType: "loan", targetId: loanId });
  },
});

/** Lender confirms the tool came back (the lender, not the borrower, is the source of truth). */
export const markReturned = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan || loan.ownerId !== me._id) notFound("Loan");
    if (loan.status !== "approved") invalid("Only approved loans can be marked returned.");
    if (loan.startDate > todayUtc()) invalid("This loan hasn't started yet.");
    await ctx.db.patch(loanId, { status: "returned", returnedAt: Date.now() });
    await enqueueLoanEvent(ctx, { type: "loan.returned", loanId, recipientId: loan.borrowerId });
    await appendAudit(ctx, { actor: me, action: "loan.returned", targetType: "loan", targetId: loanId });
  },
});

/** "My requests": things I asked to borrow. */
export const myRequests = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireUser(ctx);
    const today = todayUtc();
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", me._id))
      .order("desc")
      .take(100);
    return Promise.all(
      loans.map(async (l) => {
        const tool = await ctx.db.get(l.toolId);
        const owner = await ctx.db.get(l.ownerId);
        return {
          ...shapeLoan(l, today),
          toolName: tool?.name ?? "Removed tool",
          counterpartFirstName: owner?.firstName ?? "Neighbour",
          counterpartTrusted: owner?.trustedLender ?? false,
          activity: await recentActivity(ctx, l._id),
        };
      }),
    );
  },
});

/** "Incoming requests": requests and loans on my tools. */
export const incoming = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireUser(ctx);
    const today = todayUtc();
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_owner", (q) => q.eq("ownerId", me._id))
      .order("desc")
      .take(100);
    return Promise.all(
      loans.map(async (l) => {
        const tool = await ctx.db.get(l.toolId);
        const borrower = await ctx.db.get(l.borrowerId);
        return {
          ...shapeLoan(l, today),
          toolName: tool?.name ?? "Removed tool",
          counterpartFirstName: borrower?.firstName ?? "Neighbour",
          counterpartTrusted: borrower?.trustedLender ?? false,
          activity: await recentActivity(ctx, l._id),
        };
      }),
    );
  },
});
