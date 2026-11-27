import { ConvexError } from "convex/values";
import { CATEGORY_LABELS, type Category } from "@/convex/constants";

export function categoryLabel(c: string): string {
  return CATEGORY_LABELS[c as Category] ?? c;
}

/** Pulls the friendly message out of a ConvexError; hides anything else. */
export function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    if (typeof data === "string") return data;
    if (data?.message) return data.message;
  }
  return "Something went wrong. Please try again.";
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const ACTIVITY_LABEL: Record<string, string> = {
  notification_sent: "Notification sent",
  reminder_sent: "Reminder sent",
  reminder_failed: "Reminder failed",
};

export function activityLabel(kind: string, at: number): string {
  return `${ACTIVITY_LABEL[kind] ?? kind} ${timeAgo(at)}`;
}
