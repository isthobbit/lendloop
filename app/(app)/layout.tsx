"use client";

import { UserButton } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/format";

const LINKS = [
  { href: "/browse", label: "Browse" },
  { href: "/listings", label: "My listings" },
  { href: "/requests", label: "My requests" },
  { href: "/incoming", label: "Incoming requests" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const ensure = useMutation(api.users.ensureCurrent);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = useQuery(api.users.me, ready ? {} : "skip");
  const pathname = usePathname();

  useEffect(() => {
    if (!isAuthenticated) return;
    ensure()
      .then(() => setReady(true))
      .catch((e) => setError(errorMessage(e)));
  }, [isAuthenticated, ensure]);

  const links = me?.role === "admin" ? [...LINKS, { href: "/admin", label: "Admin" }] : LINKS;

  return (
    <>
      <header className="topbar">
        <div className="container">
          <Link href="/" className="logo">
            Lend<span>Loop</span>
          </Link>
          <nav className="nav">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className={pathname?.startsWith(l.href) ? "active" : ""}>
                {l.label}
              </Link>
            ))}
          </nav>
          {me?.trustedLender && <span className="pill green">Trusted lender</span>}
          <UserButton />
        </div>
      </header>
      <main className="container">
        {error ? (
          <div className="error">{error}</div>
        ) : isLoading || !ready || !me ? (
          <p className="muted">Loading…</p>
        ) : (
          children
        )}
      </main>
    </>
  );
}
