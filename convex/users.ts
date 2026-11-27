import { mutation, query } from "./_generated/server";
import { appendAudit } from "./lib/audit";
import { getCurrentUser } from "./lib/auth";
import { ConvexError } from "convex/values";

/**
 * Called by the client right after sign-in. Creates or refreshes the local
 * user record from the *verified* JWT claims (never from client arguments).
 * New users always start as role "user"; admins are promoted out-of-band
 * via `npx convex run admin:bootstrapAdmin` (an internal function).
 */
export const ensureCurrent = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Please sign in." });

    const firstName =
      (identity.givenName ?? identity.name?.split(" ")[0] ?? identity.nickname ?? "Neighbour").slice(0, 40);
    // Only a VERIFIED address is stored. Notifications go to this address, and
    // admin bootstrap looks users up by it, so an unverified (possibly someone
    // else's) address must never be trusted. Without a verified email the
    // account still works; it just receives no notifications.
    const email = identity.emailVerified === true && identity.email ? identity.email.toLowerCase() : undefined;

    const existing = await getCurrentUser(ctx);
    if (existing) {
      if (existing.firstName !== firstName || existing.email !== email) {
        await ctx.db.patch(existing._id, { firstName, email });
        if (existing.email !== email) {
          // Ids and an enum only; the address itself never enters the audit log.
          await appendAudit(ctx, {
            actor: existing,
            action: "user.email_changed",
            targetType: "user",
            targetId: existing._id,
            detail: email ? "verified" : "cleared",
          });
        }
      }
      return existing._id;
    }

    const id = await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      email,
      firstName,
      role: "user",
      trustedLender: false,
      createdAt: Date.now(),
    });
    const user = await ctx.db.get(id);
    await appendAudit(ctx, { actor: user, action: "user.registered", targetType: "user", targetId: id });
    return id;
  },
});

/** Minimal view of the current user for the UI. Email is not needed client-side. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return {
      _id: user._id,
      firstName: user.firstName,
      role: user.role,
      trustedLender: user.trustedLender,
    };
  },
});
