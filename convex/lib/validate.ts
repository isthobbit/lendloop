import { ConvexError } from "convex/values";

export function invalid(message: string): never {
  throw new ConvexError({ code: "INVALID", message });
}

/** Trims, collapses control characters, and enforces length bounds. */
export function cleanText(value: string, field: string, min: number, max: number): string {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (v.length < min) invalid(`${field} must be at least ${min} characters.`);
  if (v.length > max) invalid(`${field} must be at most ${max} characters.`);
  return v;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function todayUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export const MAX_LOAN_DAYS = 30;
export const MAX_ADVANCE_DAYS = 90;

export function validateRange(start: string, end: string, now = Date.now()): void {
  if (!isIsoDate(start) || !isIsoDate(end)) invalid("Dates must be in YYYY-MM-DD format.");
  const today = todayUtc(now);
  if (start < today) invalid("Start date cannot be in the past.");
  if (end < start) invalid("End date must be on or after the start date.");
  if (daysBetween(start, end) + 1 > MAX_LOAN_DAYS) invalid(`Loans are limited to ${MAX_LOAN_DAYS} days.`);
  if (daysBetween(today, start) > MAX_ADVANCE_DAYS)
    invalid(`Requests can be made at most ${MAX_ADVANCE_DAYS} days ahead.`);
}

export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}
