"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { LoanTable } from "@/components/LoanTable";
import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/format";

export default function MyRequestsPage() {
  const rows = useQuery(api.loans.myRequests);
  const cancel = useMutation(api.loans.cancel);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <div className="section-head">
        <h1>My requests</h1>
        <span className="muted small">Things you&apos;ve asked to borrow.</span>
      </div>
      {error && <div className="error" style={{ marginBottom: "1rem" }}>{error}</div>}
      <LoanTable
        rows={rows}
        counterpartLabel="Lender"
        empty="You haven't requested anything yet. Head to Browse."
        actions={(r) =>
          r.status === "pending" ? (
            <button
              className="btn small"
              onClick={() => {
                setError(null);
                cancel({ loanId: r._id }).catch((e) => setError(errorMessage(e)));
              }}
            >
              Cancel request
            </button>
          ) : null
        }
      />
    </>
  );
}
