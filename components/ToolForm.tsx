"use client";

import { useState } from "react";
import { CATEGORIES, CONDITIONS, type Category, type Condition } from "@/convex/constants";
import { categoryLabel, errorMessage } from "@/lib/format";

export type ToolInput = { name: string; category: Category; condition: Condition; description: string };

export function ToolForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: ToolInput;
  submitLabel: string;
  onSubmit: (v: ToolInput) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [v, setV] = useState<ToolInput>(
    initial ?? { name: "", category: "power_tools", condition: "good", description: "" },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(v);
      if (!initial) setV({ name: "", category: v.category, condition: "good", description: "" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <div className="form-grid">
        <div className="full">
          <label htmlFor="tool-name">Name</label>
          <input id="tool-name" required minLength={2} maxLength={60} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="e.g. Cordless drill" />
        </div>
        <div>
          <label htmlFor="tool-cat">Category</label>
          <select id="tool-cat" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value as Category })}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="tool-cond">Condition</label>
          <select id="tool-cond" value={v.condition} onChange={(e) => setV({ ...v, condition: e.target.value as Condition })}>
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {c[0].toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div className="full">
          <label htmlFor="tool-desc">Short description</label>
          <textarea id="tool-desc" maxLength={280} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} placeholder="Batteries included? Any quirks?" />
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
