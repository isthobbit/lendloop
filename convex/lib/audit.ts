import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { sha256Hex } from "./sha256";

export const GENESIS_HASH = "0".repeat(64);

type AuditInput = {
  actor?: Doc<"users"> | null;
  actorRole?: "system" | "n8n";
  action: string;
  targetType: string;
  targetId: string;
  /** Keep this free of personal data: ids and enum values only. */
  detail?: string;
};

export function auditHashInput(e: {
  seq: number;
  at: number;
  actorId?: Id<"users">;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  detail?: string;
  prevHash: string;
}): string {
  // Stable field order -> stable hash.
  return JSON.stringify([
    e.seq,
    e.at,
    e.actorId ?? null,
    e.actorRole,
    e.action,
    e.targetType,
    e.targetId,
    e.detail ?? null,
    e.prevHash,
  ]);
}

/**
 * Appends a hash-chained audit entry. Runs inside the caller's mutation, so
 * the entry is committed atomically with the change it describes. Convex
 * mutations are serializable, so two concurrent appends cannot fork the chain:
 * one of them is retried and re-reads the new head.
 */
export async function appendAudit(ctx: MutationCtx, input: AuditInput): Promise<void> {
  const head = await ctx.db.query("auditLog").withIndex("by_seq").order("desc").first();
  const seq = (head?.seq ?? 0) + 1;
  const prevHash = head?.hash ?? GENESIS_HASH;
  const entry = {
    seq,
    at: Date.now(),
    actorId: input.actor?._id,
    actorRole: input.actor ? input.actor.role : (input.actorRole ?? "system"),
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    detail: input.detail,
    prevHash,
  } as const;
  await ctx.db.insert("auditLog", { ...entry, hash: sha256Hex(auditHashInput(entry)) });
}
