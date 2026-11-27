import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";

export const LIMITS = {
  createTool: { max: 20, windowMs: 24 * 60 * 60 * 1000 },
  borrowRequest: { max: 10, windowMs: 60 * 60 * 1000 },
} as const;

/**
 * Fixed-window rate limiter stored in Convex. Because it runs in the same
 * serializable transaction as the write it protects, it cannot be bypassed by
 * firing parallel requests.
 */
export async function enforceRateLimit(
  ctx: MutationCtx,
  name: keyof typeof LIMITS,
  subject: string,
): Promise<void> {
  const { max, windowMs } = LIMITS[name];
  const key = `${name}:${subject}`;
  const now = Date.now();
  const row = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

  if (!row || now - row.windowStart >= windowMs) {
    if (row) await ctx.db.patch(row._id, { windowStart: now, count: 1 });
    else await ctx.db.insert("rateLimits", { key, windowStart: now, count: 1 });
    return;
  }
  if (row.count >= max) {
    const retryMin = Math.ceil((row.windowStart + windowMs - now) / 60000);
    throw new ConvexError({
      code: "RATE_LIMITED",
      message: `Too many requests. Try again in about ${retryMin} minute(s).`,
    });
  }
  await ctx.db.patch(row._id, { count: row.count + 1 });
}
