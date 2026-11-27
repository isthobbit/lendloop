import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";

export type LoanEventType =
  | "loan.requested"
  | "loan.approved"
  | "loan.declined"
  | "loan.cancelled"
  | "loan.returned";

/**
 * Transactional outbox: called from inside the mutation that changes the loan.
 * If the mutation rolls back, the event never existed. If it commits, delivery
 * is guaranteed to be attempted (Convex's scheduler is durable).
 */
export async function enqueueLoanEvent(
  ctx: MutationCtx,
  e: { type: LoanEventType; loanId: Id<"loans">; recipientId: Id<"users"> },
): Promise<void> {
  const outboxId = await ctx.db.insert("outbox", {
    type: e.type,
    loanId: e.loanId,
    recipientId: e.recipientId,
    status: "pending",
    attempts: 0,
    createdAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.outbox.deliver, { outboxId });
}
