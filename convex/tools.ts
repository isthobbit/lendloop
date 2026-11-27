import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { appendAudit } from "./lib/audit";
import { forbidden, notFound, requireUser } from "./lib/auth";
import { enqueueLoanEvent } from "./lib/outbox";
import { enforceRateLimit } from "./lib/rateLimit";
import { cleanText, todayUtc } from "./lib/validate";
import { categoryValidator, conditionValidator } from "./schema";

type Availability = "available" | "on_loan" | "overdue";

async function availabilityOf(ctx: QueryCtx, toolId: Id<"tools">, today: string) {
  const approved = await ctx.db
    .query("loans")
    .withIndex("by_tool", (q) => q.eq("toolId", toolId))
    .filter((q) => q.eq(q.field("status"), "approved"))
    .collect();

  let status: Availability = "available";
  for (const l of approved) {
    if (l.startDate <= today) status = l.endDate < today ? "overdue" : "on_loan";
  }
  // Only date ranges are exposed, never who booked them.
  const booked = approved
    .filter((l) => l.endDate >= today)
    .map((l) => ({ startDate: l.startDate, endDate: l.endDate }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  return { status, booked };
}

/**
 * PUBLIC (no auth). Data minimization: returns name + category only. No ids,
 * no owner, no description, no condition. Only tools that are currently
 * available are listed.
 */
export const publicList = query({
  args: {},
  handler: async (ctx) => {
    const today = todayUtc();
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .order("desc")
      .take(100);
    const out: { name: string; category: string }[] = [];
    for (const t of tools) {
      const { status } = await availabilityOf(ctx, t._id, today);
      if (status === "available") out.push({ name: t.name, category: t.category });
    }
    return out;
  },
});

/** Signed-in browse view: all active tools with availability, filterable by category. */
export const list = query({
  args: { category: v.optional(categoryValidator) },
  handler: async (ctx, { category }) => {
    const me = await requireUser(ctx);
    const today = todayUtc();
    const tools = category
      ? await ctx.db
          .query("tools")
          .withIndex("by_status_category", (q) => q.eq("status", "active").eq("category", category))
          .order("desc")
          .take(200)
      : await ctx.db
          .query("tools")
          .withIndex("by_status", (q) => q.eq("status", "active"))
          .order("desc")
          .take(200);

    return Promise.all(
      tools.map(async (t) => {
        const owner = await ctx.db.get(t.ownerId);
        const { status, booked } = await availabilityOf(ctx, t._id, today);
        return {
          _id: t._id,
          name: t.name,
          category: t.category,
          condition: t.condition,
          description: t.description,
          availability: status,
          booked,
          isMine: t.ownerId === me._id,
          // First name + trust badge only: enough to decide, nothing to stalk.
          ownerFirstName: owner?.firstName ?? "Neighbour",
          ownerTrusted: owner?.trustedLender ?? false,
        };
      }),
    );
  },
});

export const myListings = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireUser(ctx);
    const today = todayUtc();
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_owner", (q) => q.eq("ownerId", me._id))
      .filter((q) => q.eq(q.field("status"), "active"))
      .order("desc")
      .collect();
    return Promise.all(
      tools.map(async (t) => {
        const loans = await ctx.db
          .query("loans")
          .withIndex("by_tool", (q) => q.eq("toolId", t._id))
          .collect();
        const { status } = await availabilityOf(ctx, t._id, today);
        return {
          _id: t._id,
          name: t.name,
          category: t.category,
          condition: t.condition,
          description: t.description,
          availability: status,
          pendingRequests: loans.filter((l) => l.status === "pending").length,
        };
      }),
    );
  },
});

const toolFields = {
  name: v.string(),
  category: categoryValidator,
  condition: conditionValidator,
  description: v.string(),
};

function cleanToolInput(a: { name: string; description: string }) {
  return {
    name: cleanText(a.name, "Name", 2, 60),
    description: cleanText(a.description, "Description", 0, 280),
  };
}

export const create = mutation({
  args: toolFields,
  handler: async (ctx, args) => {
    const me = await requireUser(ctx);
    await enforceRateLimit(ctx, "createTool", me._id);
    const clean = cleanToolInput(args);
    const now = Date.now();
    const id = await ctx.db.insert("tools", {
      ownerId: me._id, // owner is ALWAYS the caller, never an argument
      ...clean,
      category: args.category,
      condition: args.condition,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, { actor: me, action: "tool.created", targetType: "tool", targetId: id });
    return id;
  },
});

export const update = mutation({
  args: { toolId: v.id("tools"), ...toolFields },
  handler: async (ctx, { toolId, ...args }) => {
    const me = await requireUser(ctx);
    const tool = await ctx.db.get(toolId);
    if (!tool || tool.status !== "active" || tool.ownerId !== me._id) notFound("Tool");
    await ctx.db.patch(toolId, {
      ...cleanToolInput(args),
      category: args.category,
      condition: args.condition,
      updatedAt: Date.now(),
    });
    await appendAudit(ctx, { actor: me, action: "tool.updated", targetType: "tool", targetId: toolId });
  },
});

/** Owner deletes their own listing (soft delete; loan history is kept). */
export const remove = mutation({
  args: { toolId: v.id("tools") },
  handler: async (ctx, { toolId }) => {
    const me = await requireUser(ctx);
    const tool = await ctx.db.get(toolId);
    if (!tool || tool.status !== "active" || tool.ownerId !== me._id) notFound("Tool");

    const loans = await ctx.db.query("loans").withIndex("by_tool", (q) => q.eq("toolId", toolId)).collect();
    if (loans.some((l) => l.status === "approved"))
      forbidden("This tool has an active or upcoming loan. Mark it returned (or wait) before deleting.");

    for (const l of loans.filter((l) => l.status === "pending")) {
      await ctx.db.patch(l._id, { status: "declined", decidedAt: Date.now() });
      await enqueueLoanEvent(ctx, { type: "loan.declined", loanId: l._id, recipientId: l.borrowerId });
    }
    await ctx.db.patch(toolId, { status: "removed", removedBy: "owner", updatedAt: Date.now() });
    await appendAudit(ctx, { actor: me, action: "tool.deleted", targetType: "tool", targetId: toolId });
  },
});
