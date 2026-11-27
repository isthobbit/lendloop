"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage, todayIso } from "@/lib/format";

export function RequestForm({ toolId, onDone }: { toolId: Id<"tools">; onDone: (sent: boolean) => void }) {
  const request = useMutation(api.loans.request);
  const today = todayIso();
  const [startDate, setStart] = useState(today);
  const [endDate, setEnd] = useState(today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await request({ toolId, startDate, endDate, note: note.trim() || undefined });
      onDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack" style={{ marginTop: "0.75rem" }}>
      <div className="form-grid">
        <div>
          <label htmlFor={`s-${toolId}`}>From</label>
          <input id={`s-${toolId}`} type="date" min={today} value={startDate} onChange={(e) => setStart(e.target.value)} required />
        </div>
        <div>
          <label htmlFor={`e-${toolId}`}>Until</label>
          <input id={`e-${toolId}`} type="date" min={startDate} value={endDate} onChange={(e) => setEnd(e.target.value)} required />
        </div>
        <div className="full">
          <label htmlFor={`n-${toolId}`}>Note for the lender (optional)</label>
          <input id={`n-${toolId}`} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's it for?" />
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn primary small" disabled={busy}>
          {busy ? "Sending…" : "Send request"}
        </button>
        <button type="button" className="btn small" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
