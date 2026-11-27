import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Authorization helpers. EVERY public query/mutation that touches private data
 * starts with one of these. Identity comes from the Clerk-signed JWT that
 * Convex verifies (ctx.auth); role comes from our own `users` table. Nothing
 * the browser sends (user ids, roles, owner ids) is ever trusted.
 */

export type Role = Doc<"users">["role"];

export function forbidden(message = "You are not allowed to do that."): never {
  throw new ConvexError({ code: "FORBIDDEN", message });
}

export function notFound(what = "Item"): never {
  // Same error for "doesn't exist" and "exists but not yours", so ids can't be probed.
  throw new ConvexError({ code: "NOT_FOUND", message: `${what} not found.` });
}

export async function getCurrentUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
}

export async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Please sign in." });
  const user = await getCurrentUser(ctx);
  if (!user) throw new ConvexError({ code: "NOT_REGISTERED", message: "Account is still being set up." });
  return user;
}

export async function requireAdmin(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (user.role !== "admin") forbidden("Admin only.");
  return user;
}
