"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { StatusPill, TrustedBadge } from "@/components/Badges";
import { api } from "@/convex/_generated/api";
import { activityLabel, categoryLabel, errorMessage, fmtDate, timeAgo } from "@/lib/format";

export default function AdminPage() {
  const me = useQuery(api.users.me);
  const [error, setError] = useState<string | null>(null);
  const guard = (p: Promise<unknown>) => {
    setError(null);
    p.catch((e) => setError(errorMessage(e)));
  };

  // The server enforces admin-only on every query below; this is just UX.
  if (me && me.role !== "admin") return <div className="error">Admins only.</div>;

  return (
    <div className="stack" style={{ gap: "2rem" }}>
      <h1>Admin</h1>
      {error && <div className="error">{error}</div>}
      <AutomationHealth guard={guard} />
      <AuditChain />
      <Users guard={guard} />
      <Listings guard={guard} />
      <Loans />
    </div>
  );
}

type Guard = (p: Promise<unknown>) => void;

function AutomationHealth({ guard }: { guard: Guard }) {
  const h = useQuery(api.admin.automationHealth);
  const retry = useMutation(api.outbox.retryDead);
  const ack = useMutation(api.admin.acknowledgeError);
  if (!h) return null;
  const openErrors = h.errors.filter((e) => !e.acknowledged);
  return (
    <section>
      <div className="section-head">
        <h2>Automation health</h2>
        <div className="row">
          <span className={`pill ${h.deadLetters.length ? "red" : "green"}`}>{h.deadLetters.length} dead letters</span>
          <span className={`pill ${openErrors.length ? "orange" : "green"}`}>{openErrors.length} open workflow errors</span>
          <span className="pill">{h.pendingCount} queued</span>
        </div>
      </div>
      {h.deadLetters.length === 0 && h.errors.length === 0 ? (
        <div className="empty">All automation is healthy. Failures from n8n or the outbox would appear here.</div>
      ) : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>What</th>
                <th>Detail</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {h.deadLetters.map((d) => (
                <tr key={d._id}>
                  <td><span className="pill red">Outbox</span></td>
                  <td>{d.type}</td>
                  <td className="small">{d.lastError} (after {d.attempts} attempts)</td>
                  <td className="small">{timeAgo(d.createdAt)}</td>
                  <td><button className="btn small" onClick={() => guard(retry({ outboxId: d._id }))}>Retry</button></td>
                </tr>
              ))}
              {h.errors.map((e) => (
                <tr key={e._id} style={{ opacity: e.acknowledged ? 0.5 : 1 }}>
                  <td><span className="pill orange">n8n</span></td>
                  <td>{e.workflow} → {e.node}</td>
                  <td className="small">{e.message}{e.executionId && <div className="muted">execution {e.executionId}</div>}</td>
                  <td className="small">{timeAgo(e.at)}</td>
                  <td>{!e.acknowledged && <button className="btn small" onClick={() => guard(ack({ errorId: e._id }))}>Acknowledge</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AuditChain() {
  const [check, setCheck] = useState(false);
  const result = useQuery(api.admin.verifyAuditChain, check ? {} : "skip");
  const recent = useQuery(api.admin.recentAudit);
  return (
    <section>
      <div className="section-head">
        <h2>Tamper-evident audit log</h2>
        <div className="row">
          {check && result && (
            <span className={`pill ${result.ok ? "green" : "red"}`}>
              {result.ok ? `Chain intact · ${result.checked} entries` : `Chain BROKEN at entry #${result.brokenAtSeq}`}
            </span>
          )}
          <button className="btn small" onClick={() => setCheck(true)}>
            {check && !result ? "Verifying…" : "Verify chain"}
          </button>
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Each entry stores the SHA-256 of the one before it. Editing or deleting any past entry breaks the chain.
        Entries contain ids and actions only, never personal data.
      </p>
      {recent && (
        <div className="card table-wrap" style={{ padding: 0, maxHeight: 320, overflowY: "auto" }}>
          <table>
            <thead>
              <tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Hash</th></tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.seq}>
                  <td>{r.seq}</td>
                  <td className="small">{timeAgo(r.at)}</td>
                  <td><span className="pill">{r.actorRole}</span></td>
                  <td>{r.action}{r.detail && <div className="small muted">{r.detail}</div>}</td>
                  <td className="small muted">{r.targetType}</td>
                  <td className="small"><code>{r.hash}…</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Users({ guard }: { guard: Guard }) {
  const users = useQuery(api.admin.listUsers);
  const setTrusted = useMutation(api.admin.setTrustedLender);
  if (!users) return null;
  return (
    <section>
      <h2>Members</h2>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Trust</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u._id}>
                <td>{u.firstName}</td>
                <td className="small muted">{u.emailMasked}</td>
                <td><span className={`pill ${u.role === "admin" ? "blue" : ""}`}>{u.role}</span></td>
                <td>{u.trustedLender ? <TrustedBadge /> : <span className="muted small">-</span>}</td>
                <td>
                  <button className="btn small" onClick={() => guard(setTrusted({ userId: u._id, trusted: !u.trustedLender }))}>
                    {u.trustedLender ? "Revoke trust" : "Mark trusted lender"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Listings({ guard }: { guard: Guard }) {
  const tools = useQuery(api.admin.allTools);
  const remove = useMutation(api.admin.removeListing);
  if (!tools) return null;
  return (
    <section>
      <h2>Listings</h2>
      {tools.length === 0 ? (
        <div className="empty">No active listings.</div>
      ) : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Tool</th><th>Category</th><th>Owner</th><th /></tr></thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t._id}>
                  <td>{t.name}</td>
                  <td className="small">{categoryLabel(t.category)}</td>
                  <td>{t.ownerFirstName}</td>
                  <td>
                    <button
                      className="btn small danger"
                      onClick={() => {
                        const reason = prompt(`Why are you removing "${t.name}"? (recorded in the audit log)`);
                        if (reason) guard(remove({ toolId: t._id, reason }));
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Loans() {
  const loans = useQuery(api.admin.allLoans);
  if (!loans) return null;
  return (
    <section>
      <h2>All loans</h2>
      {loans.length === 0 ? (
        <div className="empty">No loans yet.</div>
      ) : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Tool</th><th>Lender → Borrower</th><th>Dates</th><th>Status</th><th>Last automation</th></tr></thead>
            <tbody>
              {loans.map((l) => (
                <tr key={l._id}>
                  <td>{l.toolName}</td>
                  <td>{l.ownerFirstName} → {l.borrowerFirstName}</td>
                  <td className="small">{fmtDate(l.startDate)} – {fmtDate(l.endDate)}</td>
                  <td><StatusPill status={l.status} overdue={l.isOverdue} /></td>
                  <td className="small muted">{l.lastAutomation ? activityLabel(l.lastAutomation.kind, l.lastAutomation.at) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
