/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";

export const modules = import.meta.glob("../../convex/**/*.*s");

/** A fixed "now": Monday 1 December 2026, midday UTC. */
export const NOW = new Date("2026-12-01T12:00:00Z");

export function newBackend() {
  return convexTest(schema, modules);
}
export type Backend = ReturnType<typeof newBackend>;

/** Signs a user in (Clerk-style verified JWT claims) and registers them. */
export async function signIn(t: Backend, name: string, opts: { emailVerified?: boolean } = {}) {
  const user = t.withIdentity({
    subject: `user_${name}`,
    issuer: "https://clerk.test",
    email: `${name}@example.com`,
    emailVerified: opts.emailVerified ?? true,
    givenName: name[0].toUpperCase() + name.slice(1),
  });
  await user.mutation(api.users.ensureCurrent, {});
  return user;
}

/**
 * The standard cast:
 *  - alice: lends a drill
 *  - bob:   borrows it
 *  - eve:   an unrelated signed-in user (the "other tenant")
 *  - ada:   admin
 */
export async function cast() {
  const t = newBackend();
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const eve = await signIn(t, "eve");
  const ada = await signIn(t, "ada");
  await t.mutation(internal.admin.bootstrapAdmin, { email: "ada@example.com" });

  const drill = await alice.mutation(api.tools.create, {
    name: "Cordless drill",
    category: "power_tools",
    condition: "good",
    description: "18V, two batteries",
  });
  const request = await bob.mutation(api.loans.request, {
    toolId: drill,
    startDate: "2026-12-02",
    endDate: "2026-12-04",
  });
  return { t, alice, bob, eve, ada, drill, request };
}

/** Asserts that a call is rejected with a ConvexError carrying this code. */
export async function expectCode(call: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await call;
  } catch (e) {
    error = e;
  }
  expect(error, `expected ${code}, but the call succeeded`).toBeDefined();
  const data = (error as { data?: unknown }).data;
  const actual =
    typeof data === "object" && data !== null && "code" in data
      ? (data as { code: string }).code
      : /"code":"(\w+)"/.exec(String((error as Error).message))?.[1];
  expect(actual, String((error as Error).message)).toBe(code);
}
