import { Show, SignInButton } from "@clerk/nextjs";
import Link from "next/link";
import { PublicTools } from "./PublicTools";

export default function Home() {
  return (
    <>
      <header className="topbar">
        <div className="container">
          <div className="logo">
            Lend<span>Loop</span>
          </div>
          <div style={{ flex: 1 }} />
          <Show when="signed-in">
            <Link className="btn primary" href="/browse">
              Open LendLoop
            </Link>
          </Show>
        </div>
      </header>
      <main className="container">
        <section className="hero">
          <h1>Borrow what you need. Lend what you don&apos;t.</h1>
          <p>
            The drill you use twice a year is the drill your neighbour needs today. LendLoop is a lending board for
            your street.
          </p>
          <Show when="signed-out">
            <SignInButton mode="modal" forceRedirectUrl="/browse">
              <button className="btn primary lg">Sign in to lend or borrow</button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link className="btn primary lg" href="/browse">
              Go to the board
            </Link>
          </Show>
        </section>

        <section>
          <div className="section-head">
            <h2>Available right now</h2>
            <span className="muted small">Sign in to see details and request a tool.</span>
          </div>
          <PublicTools />
        </section>
      </main>
    </>
  );
}
