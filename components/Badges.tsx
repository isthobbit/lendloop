import { activityLabel } from "@/lib/format";

const AVAILABILITY: Record<string, { label: string; tone: string }> = {
  available: { label: "Available", tone: "green" },
  on_loan: { label: "On loan", tone: "blue" },
  overdue: { label: "On loan (overdue)", tone: "orange" },
};

export function AvailabilityPill({ value }: { value: string }) {
  const a = AVAILABILITY[value] ?? { label: value, tone: "" };
  return <span className={`pill ${a.tone}`}>{a.label}</span>;
}

const STATUS: Record<string, string> = {
  pending: "orange",
  approved: "green",
  declined: "red",
  cancelled: "",
  returned: "blue",
};

export function StatusPill({ status, overdue }: { status: string; overdue?: boolean }) {
  if (overdue) return <span className="pill red">Overdue</span>;
  return <span className={`pill ${STATUS[status] ?? ""}`}>{status[0].toUpperCase() + status.slice(1)}</span>;
}

export function TrustedBadge() {
  return (
    <span className="pill green" title="Verified by a LendLoop admin">
      ✓ Trusted lender
    </span>
  );
}

export function Activity({ items }: { items: { kind: string; at: number }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="stack" style={{ gap: "0.15rem" }}>
      {items.map((a, i) => (
        <span key={i} className="activity">
          {activityLabel(a.kind, a.at)}
        </span>
      ))}
    </div>
  );
}
