"use client";

import type { ReactNode } from "react";
import { Activity, StatusPill, TrustedBadge } from "@/components/Badges";
import type { Id } from "@/convex/_generated/dataModel";
import { fmtDate } from "@/lib/format";

export type LoanRow = {
  _id: Id<"loans">;
  status: string;
  startDate: string;
  endDate: string;
  note?: string;
  isOverdue: boolean;
  isActive: boolean;
  toolName: string;
  counterpartFirstName: string;
  counterpartTrusted: boolean;
  activity: { kind: string; at: number }[];
};

export function LoanTable({
  rows,
  counterpartLabel,
  actions,
  empty,
}: {
  rows: LoanRow[] | undefined;
  counterpartLabel: string;
  actions: (row: LoanRow) => ReactNode;
  empty: string;
}) {
  if (rows === undefined) return <p className="muted">Loading…</p>;
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  return (
    <div className="card table-wrap" style={{ padding: 0 }}>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>{counterpartLabel}</th>
            <th>Dates</th>
            <th>Status</th>
            <th>Automation</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r._id}>
              <td>
                <strong>{r.toolName}</strong>
                {r.note && <div className="small muted">“{r.note}”</div>}
              </td>
              <td>
                <div className="row" style={{ gap: "0.35rem" }}>
                  {r.counterpartFirstName}
                  {r.counterpartTrusted && <TrustedBadge />}
                </div>
              </td>
              <td className="small">
                {fmtDate(r.startDate)} – {fmtDate(r.endDate)}
              </td>
              <td>
                <StatusPill status={r.status} overdue={r.isOverdue} />
              </td>
              <td>
                <Activity items={r.activity} />
              </td>
              <td>
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  {actions(r)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
