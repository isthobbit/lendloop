"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { LoanTable } from "@/components/LoanTable";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/format";

export default function IncomingPage() {
  const rows = useQuery(api.loans.incoming);
  const decide = useMutation(api.loans.decide);
  const markReturned = useMutation(api.loans.markReturned);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Id<"loans"> | null>(null);

  function run(id: Id<"loans">, p: Promise<unknown>) {
    setError(null);
    setBusy(id);
    p.catch((e) => setError(errorMessage(e))).finally(() => setBusy(null));
  }

  return (
    <>
      <div className="section-head">
        <h1>Incoming requests</h1>
        <span className="muted small">Requests and loans on your tools.</span>
      </div>
      {error && <div className="error" style={{ marginBottom: "1rem" }}>{error}</div>}
      <LoanTable
        rows={rows}
        counterpartLabel="Borrower"
        empty="No requests yet. They'll show up here when a neighbour asks."
        actions={(r) => {
          const disabled = busy === r._id;
          if (r.status === "pending")
            return (
              <>
                <button className="btn primary small" disabled={disabled} onClick={() => run(r._id, decide({ loanId: r._id, decision: "approve" }))}>
                  Approve
                </button>
                <button className="btn small" disabled={disabled} onClick={() => run(r._id, decide({ loanId: r._id, decision: "decline" }))}>
                  Decline
                </button>
              </>
            );
          if (r.status === "approved" && r.isActive)
            return (
              <button className="btn small" disabled={disabled} onClick={() => run(r._id, markReturned({ loanId: r._id }))}>
                Mark returned
              </button>
            );
          return null;
        }}
      />
    </>
  );
}
