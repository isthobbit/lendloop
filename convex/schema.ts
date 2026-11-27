import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { CATEGORIES, CONDITIONS } from "./constants";

export const categoryValidator = v.union(...CATEGORIES.map((c) => v.literal(c)));
export const conditionValidator = v.union(...CONDITIONS.map((c) => v.literal(c)));

export const roleValidator = v.union(v.literal("admin"), v.literal("user"));

export const loanStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("declined"),
  v.literal("cancelled"),
  v.literal("returned"),
);

export default defineSchema({
  /**
   * Local mirror of a Clerk user. The role lives HERE (server-side), never in a
   * client-editable place. Email is kept only because the notification channel
   * needs it, and it is never returned to other users.
   */
  users: defineTable({
    tokenIdentifier: v.string(),
    email: v.optional(v.string()),
    firstName: v.string(),
    role: roleValidator,
    trustedLender: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_email", ["email"]),

  tools: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    category: categoryValidator,
    condition: conditionValidator,
    description: v.string(),
    status: v.union(v.literal("active"), v.literal("removed")),
    removedBy: v.optional(v.union(v.literal("owner"), v.literal("admin"))),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_status", ["status"])
    .index("by_status_category", ["status", "category"]),

  /** A borrow request and, once approved, the loan itself. */
  loans: defineTable({
    toolId: v.id("tools"),
    ownerId: v.id("users"),
    borrowerId: v.id("users"),
    startDate: v.string(), // YYYY-MM-DD
    endDate: v.string(), // YYYY-MM-DD (inclusive due date)
    status: loanStatusValidator,
    note: v.optional(v.string()),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
    returnedAt: v.optional(v.number()),
  })
    .index("by_tool", ["toolId"])
    .index("by_borrower", ["borrowerId"])
    .index("by_owner", ["ownerId"])
    .index("by_status_end", ["status", "endDate"]),

  /**
   * Transactional outbox. A row is written in the SAME transaction as the
   * state change, so an event can never be lost or emitted for a rolled-back
   * change. Delivery happens asynchronously with backoff; exhausted rows go to
   * "dead" and surface in the admin panel.
   */
  outbox: defineTable({
    // The row _id doubles as the event id.
    type: v.string(),
    loanId: v.id("loans"),
    recipientId: v.id("users"),
    status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("dead")),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    deliveredAt: v.optional(v.number()),
    // Claim-check ticket: only its SHA-256 hash is stored.
    ticketHash: v.optional(v.string()),
    ticketExpiresAt: v.optional(v.number()),
    ticketConsumedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_ticket", ["ticketHash"]),

  /**
   * Claim-check tickets for the daily overdue reminders. One row per
   * (loan, reminder date). The list n8n fetches holds only ids and tickets; the
   * borrower's contact details are released per ticket, and each release is
   * audited. A reminder write-back must present the ticket, and the loan and
   * date are taken from this row, never from the caller.
   */
  reminderTickets: defineTable({
    loanId: v.id("loans"),
    reminderDate: v.string(), // YYYY-MM-DD (UTC)
    ticketHash: v.string(), // only the SHA-256 of the ticket is stored
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    .index("by_ticket", ["ticketHash"])
    .index("by_loan_date", ["loanId", "reminderDate"])
    .index("by_expires", ["expiresAt"]),

  /** Write-backs from n8n. idempotencyKey is unique: retries are no-ops. */
  automationEvents: defineTable({
    idempotencyKey: v.string(),
    loanId: v.id("loans"),
    kind: v.union(
      v.literal("notification_sent"),
      v.literal("reminder_sent"),
      v.literal("reminder_failed"),
    ),
    channel: v.string(),
    executionId: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_key", ["idempotencyKey"])
    .index("by_loan", ["loanId"]),

  /** Failures reported by the n8n error workflow, so nothing fails silently. */
  automationErrors: defineTable({
    fingerprint: v.string(),
    workflow: v.string(),
    node: v.string(),
    message: v.string(),
    executionId: v.optional(v.string()),
    at: v.number(),
    acknowledgedAt: v.optional(v.number()),
  })
    .index("by_fingerprint", ["fingerprint"])
    .index("by_at", ["at"]),

  /** Seen request nonces (replay protection for inbound n8n calls). */
  nonces: defineTable({
    nonce: v.string(),
    expiresAt: v.number(),
  })
    .index("by_nonce", ["nonce"])
    .index("by_expires", ["expiresAt"]),

  /** Fixed-window rate limit counters. */
  rateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),

  /**
   * Tamper-evident audit log. Each entry stores the SHA-256 of the previous
   * entry, so editing or deleting a past row breaks the chain and is detected
   * by admin.verifyAuditChain.
   */
  auditLog: defineTable({
    seq: v.number(),
    at: v.number(),
    actorId: v.optional(v.id("users")),
    actorRole: v.union(roleValidator, v.literal("system"), v.literal("n8n")),
    action: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    detail: v.optional(v.string()),
    prevHash: v.string(),
    hash: v.string(),
  }).index("by_seq", ["seq"]),
});
