"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { AvailabilityPill } from "@/components/Badges";
import { ToolForm } from "@/components/ToolForm";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { categoryLabel, errorMessage } from "@/lib/format";

export default function ListingsPage() {
  const tools = useQuery(api.tools.myListings);
  const create = useMutation(api.tools.create);
  const update = useMutation(api.tools.update);
  const remove = useMutation(api.tools.remove);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Id<"tools"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onDelete(toolId: Id<"tools">, name: string) {
    if (!confirm(`Delete "${name}"? Pending requests will be declined.`)) return;
    setError(null);
    try {
      await remove({ toolId });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      <div className="section-head">
        <h1>My listings</h1>
        {!adding && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            + List a tool
          </button>
        )}
      </div>

      {adding && (
        <div className="card" style={{ marginBottom: "1.25rem" }}>
          <h3>List a tool</h3>
          <ToolForm
            submitLabel="Publish listing"
            onSubmit={async (v) => {
              await create(v);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
      {error && <div className="error" style={{ marginBottom: "1rem" }}>{error}</div>}

      {tools === undefined ? (
        <p className="muted">Loading…</p>
      ) : tools.length === 0 ? (
        <div className="empty">You haven&apos;t listed anything yet.</div>
      ) : (
        <div className="grid">
          {tools.map((t) =>
            editing === t._id ? (
              <div key={t._id} className="card">
                <ToolForm
                  initial={{ name: t.name, category: t.category, condition: t.condition, description: t.description }}
                  submitLabel="Save"
                  onSubmit={async (v) => {
                    await update({ toolId: t._id, ...v });
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              </div>
            ) : (
              <article key={t._id} className="card stack" style={{ gap: "0.5rem" }}>
                <div className="spread">
                  <h3 style={{ margin: 0 }}>{t.name}</h3>
                  <AvailabilityPill value={t.availability} />
                </div>
                <div className="small muted">
                  {categoryLabel(t.category)} · Condition: {t.condition}
                </div>
                {t.description && <p style={{ margin: 0 }}>{t.description}</p>}
                {t.pendingRequests > 0 && (
                  <Link href="/incoming" className="small">
                    {t.pendingRequests} pending request{t.pendingRequests === 1 ? "" : "s"} →
                  </Link>
                )}
                <div className="row">
                  <button className="btn small" onClick={() => setEditing(t._id)}>
                    Edit
                  </button>
                  <button className="btn small danger" onClick={() => onDelete(t._id, t.name)}>
                    Delete
                  </button>
                </div>
              </article>
            ),
          )}
        </div>
      )}
    </>
  );
}
