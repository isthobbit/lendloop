import { internalMutation } from "./_generated/server";

const DAY = 24 * 60 * 60 * 1000;

export const purgeNonces = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db
      .query("nonces")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(1000);
    for (const n of expired) await ctx.db.delete(n._id);
  },
});

/** Reminder tickets are only useful for the day they were issued: drop them after 2 days. */
export const purgeReminderTickets = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("reminderTickets")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now() - 2 * DAY))
      .take(1000);
    for (const t of old) await ctx.db.delete(t._id);
  },
});

/**
 * Retention policy:
 *  - delivered outbox rows: dropped after 30 days (ticket hashes go with them)
 *  - acknowledged automation errors: dropped after 30 days
 *  - stale rate-limit windows: dropped after 2 days
 * The audit log is intentionally NOT pruned here (it is append-only and
 * holds no personal data, only ids and actions).
 */
export const retentionSweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const delivered = await ctx.db
      .query("outbox")
      .withIndex("by_status", (q) => q.eq("status", "delivered"))
      .take(1000);
    for (const r of delivered) if ((r.deliveredAt ?? 0) < now - 30 * DAY) await ctx.db.delete(r._id);

    const errors = await ctx.db.query("automationErrors").withIndex("by_at", (q) => q.lt("at", now - 30 * DAY)).take(1000);
    for (const e of errors) if (e.acknowledgedAt) await ctx.db.delete(e._id);

    const windows = await ctx.db.query("rateLimits").take(2000);
    for (const w of windows) if (w.windowStart < now - 2 * DAY) await ctx.db.delete(w._id);
  },
});
