import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { appendAudit, auditHashInput, GENESIS_HASH } from "./lib/audit";
import { notFound, requireAdmin } from "./lib/auth";
import { enqueueLoanEvent } from "./lib/outbox";
import { sha256Hex } from "./lib/sha256";
import { cleanText, todayUtc } from "./lib/validate";

/** j***@example.com: enough for an admin to tell accounts apart. */
function maskEmail(email?: string): string {
  if (!email) return "(no verified email)";
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain ?? ""}`;
}

/**
 * Promote the first admin. INTERNAL: cannot be called from a browser, only
 * from the Convex dashboard/CLI by someone with deploy access:
 *   npx convex run admin:bootstrapAdmin '{"email":"you@example.com"}'
 */
export const bootstrapAdmin = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    // Only verified addresses are stored (users.ensureCurrent), so this can't
    // promote an account that merely typed in someone else's email.
    const matches = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .take(2);
    if (matches.length === 0) throw new ConvexError("No user with that verified email has signed in yet.");
    if (matches.length > 1) throw new ConvexError("More than one account has that email; refusing to guess.");
    const user = matches[0];
    if (user.role === "admin") return user._id;
    await ctx.db.patch(user._id, { role: "admin" });
    await appendAudit(ctx, { actorRole: "system", action: "user.promoted_admin", targetType: "user", targetId: user._id });
    return user._id;
  },
});

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const users = await ctx.db.query("users").order("desc").take(500);
    return users.map((u) => ({
      _id: u._id,
      firstName: u.firstName,
      emailMasked: maskEmail(u.email),
      role: u.role,
      trustedLender: u.trustedLender,
      createdAt: u.createdAt,
    }));
  },
});

export const setTrustedLender = mutation({
  args: { userId: v.id("users"), trusted: v.boolean() },
  handler: async (ctx, { userId, trusted }) => {
    const admin = await requireAdmin(ctx);
    const user = await ctx.db.get(userId);
    if (!user) notFound("User");
    await ctx.db.patch(userId, { trustedLender: trusted });
    await appendAudit(ctx, {
      actor: admin,
      action: trusted ? "user.trusted_granted" : "user.trusted_revoked",
      targetType: "user",
      targetId: userId,
    });
  },
});

/** Moderation removal. A reason is mandatory and goes into the audit chain. */
export const removeListing = mutation({
  args: { toolId: v.id("tools"), reason: v.string() },
  handler: async (ctx, { toolId, reason }) => {
    const admin = await requireAdmin(ctx);
    const why = cleanText(reason, "Reason", 5, 200);
    const tool = await ctx.db.get(toolId);
    if (!tool || tool.status !== "active") notFound("Tool");

    const pending = await ctx.db
      .query("loans")
      .withIndex("by_tool", (q) => q.eq("toolId", toolId))
      .filter((q) => q.eq(q.field("status"), "pending"))
      .collect();
    for (const l of pending) {
      await ctx.db.patch(l._id, { status: "declined", decidedAt: Date.now() });
      await enqueueLoanEvent(ctx, { type: "loan.declined", loanId: l._id, recipientId: l.borrowerId });
    }
    await ctx.db.patch(toolId, { status: "removed", removedBy: "admin", updatedAt: Date.now() });
    await appendAudit(ctx, {
      actor: admin,
      action: "tool.removed_by_admin",
      targetType: "tool",
      targetId: toolId,
      detail: why,
    });
  },
});

export const allTools = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .order("desc")
      .take(500);
    return Promise.all(
      tools.map(async (t) => {
        const owner = await ctx.db.get(t.ownerId);
        return { _id: t._id, name: t.name, category: t.category, ownerFirstName: owner?.firstName ?? "?" };
      }),
    );
  },
});

export const allLoans = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const today = todayUtc();
    const loans = await ctx.db.query("loans").order("desc").take(300);
    return Promise.all(
      loans.map(async (l) => {
        const [tool, owner, borrower] = await Promise.all([
          ctx.db.get(l.toolId),
          ctx.db.get(l.ownerId),
          ctx.db.get(l.borrowerId),
        ]);
        const events = await ctx.db
          .query("automationEvents")
          .withIndex("by_loan", (q) => q.eq("loanId", l._id))
          .order("desc")
          .take(1);
        return {
          _id: l._id,
          toolName: tool?.name ?? "?",
          ownerFirstName: owner?.firstName ?? "?",
          borrowerFirstName: borrower?.firstName ?? "?",
          status: l.status,
          startDate: l.startDate,
          endDate: l.endDate,
          isOverdue: l.status === "approved" && l.endDate < today,
          lastAutomation: events[0] ? { kind: events[0].kind, at: events[0].at } : null,
        };
      }),
    );
  },
});

/** Everything an operator needs to see that automation is healthy. */
export const automationHealth = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const dead = await ctx.db.query("outbox").withIndex("by_status", (q) => q.eq("status", "dead")).take(50);
    const pending = await ctx.db.query("outbox").withIndex("by_status", (q) => q.eq("status", "pending")).take(200);
    const errors = await ctx.db.query("automationErrors").withIndex("by_at").order("desc").take(25);
    return {
      pendingCount: pending.length,
      oldestPendingAt: pending.reduce<number | null>((m, r) => (m === null || r.createdAt < m ? r.createdAt : m), null),
      deadLetters: dead.map((d) => ({
        _id: d._id,
        type: d.type,
        attempts: d.attempts,
        lastError: d.lastError,
        createdAt: d.createdAt,
      })),
      errors: errors.map((e) => ({
        _id: e._id,
        workflow: e.workflow,
        node: e.node,
        message: e.message,
        executionId: e.executionId,
        at: e.at,
        acknowledged: !!e.acknowledgedAt,
      })),
    };
  },
});

export const acknowledgeError = mutation({
  args: { errorId: v.id("automationErrors") },
  handler: async (ctx, { errorId }) => {
    const admin = await requireAdmin(ctx);
    const e = await ctx.db.get(errorId);
    if (!e) notFound("Error");
    await ctx.db.patch(errorId, { acknowledgedAt: Date.now() });
    await appendAudit(ctx, { actor: admin, action: "automation.error_acknowledged", targetType: "automationError", targetId: errorId });
  },
});

export const recentAudit = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("auditLog").withIndex("by_seq").order("desc").take(50);
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      actorRole: r.actorRole,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      detail: r.detail,
      hash: r.hash.slice(0, 12),
    }));
  },
});

/**
 * Recomputes the whole hash chain. Any edited, deleted or re-ordered entry
 * breaks it, and the first broken sequence number is reported.
 */
export const verifyAuditChain = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    let checked = 0;
    for await (const e of ctx.db.query("auditLog").withIndex("by_seq")) {
      const recomputed = sha256Hex(
        auditHashInput({
          seq: e.seq,
          at: e.at,
          actorId: e.actorId,
          actorRole: e.actorRole,
          action: e.action,
          targetType: e.targetType,
          targetId: e.targetId,
          detail: e.detail,
          prevHash: e.prevHash,
        }),
      );
      if (e.seq !== expectedSeq || e.prevHash !== prev || e.hash !== recomputed) {
        return { ok: false as const, checked, brokenAtSeq: e.seq, headHash: prev };
      }
      prev = e.hash;
      expectedSeq++;
      checked++;
    }
    return { ok: true as const, checked, headHash: prev };
  },
});
