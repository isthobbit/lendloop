"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { categoryLabel } from "@/lib/format";

/** Public, read-only list: name + category only (that's all the query returns). */
export function PublicTools() {
  const tools = useQuery(api.tools.publicList);
  if (tools === undefined) return <p className="muted">Loading tools…</p>;
  if (tools.length === 0) return <div className="empty">No tools listed yet. Be the first to lend one.</div>;
  return (
    <ul className="public-list">
      {tools.map((t, i) => (
        <li key={`${t.name}-${i}`}>
          <strong>{t.name}</strong>
          <span className="pill">{categoryLabel(t.category)}</span>
        </li>
      ))}
    </ul>
  );
}
