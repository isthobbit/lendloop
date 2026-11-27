"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import { AvailabilityPill, TrustedBadge } from "@/components/Badges";
import { RequestForm } from "@/components/RequestForm";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CATEGORIES, type Category } from "@/convex/constants";
import { categoryLabel, fmtDate } from "@/lib/format";

export default function BrowsePage() {
  const [category, setCategory] = useState<Category | undefined>(undefined);
  const [requesting, setRequesting] = useState<Id<"tools"> | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const tools = useQuery(api.tools.list, { category });

  return (
    <>
      <div className="section-head">
        <h1>Browse tools</h1>
      </div>
      <div className="chips" role="group" aria-label="Filter by category">
        <button className={`chip ${!category ? "on" : ""}`} onClick={() => setCategory(undefined)}>
          All
        </button>
        {CATEGORIES.map((c) => (
          <button key={c} className={`chip ${category === c ? "on" : ""}`} onClick={() => setCategory(c)}>
            {categoryLabel(c)}
          </button>
        ))}
      </div>
      {sent && <div className="notice" style={{ marginBottom: "1rem" }}>{sent}</div>}

      {tools === undefined ? (
        <p className="muted">Loading…</p>
      ) : tools.length === 0 ? (
        <div className="empty">Nothing in this category yet.</div>
      ) : (
        <div className="grid">
          {tools.map((t) => (
            <article key={t._id} className="card stack" style={{ gap: "0.5rem" }}>
              <div className="spread">
                <h3 style={{ margin: 0 }}>{t.name}</h3>
                <AvailabilityPill value={t.availability} />
              </div>
              <div className="row small muted">
                <span>{categoryLabel(t.category)}</span>·<span>Condition: {t.condition}</span>
              </div>
              {t.description && <p style={{ margin: 0 }}>{t.description}</p>}
              <div className="row small">
                <span className="muted">Lent by {t.isMine ? "you" : t.ownerFirstName}</span>
                {t.ownerTrusted && <TrustedBadge />}
              </div>
              {t.booked.length > 0 && (
                <div className="small muted">
                  Booked: {t.booked.map((b) => `${fmtDate(b.startDate)}–${fmtDate(b.endDate)}`).join(", ")}
                </div>
              )}
              {!t.isMine &&
                (requesting === t._id ? (
                  <RequestForm
                    toolId={t._id}
                    onDone={(ok) => {
                      setRequesting(null);
                      if (ok) setSent(`Request for "${t.name}" sent. ${t.ownerFirstName} will be notified.`);
                    }}
                  />
                ) : (
                  <div>
                    <button
                      className="btn primary small"
                      onClick={() => {
                        setSent(null);
                        setRequesting(t._id);
                      }}
                    >
                      Request to borrow
                    </button>
                  </div>
                ))}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
