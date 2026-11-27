/**
 * The n8n-facing endpoints and the data they release, tested through the real
 * signed HTTP routes in convex/http.ts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { parseKeyRing, signRequest } from "../../convex/lib/signing";
import { cast, expectCode, newBackend, NOW, signIn, type Backend } from "./setup";

const N2C = `n2c-test:${"k".repeat(48)}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("N8N_TO_CONVEX_KEYS", N2C);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Calls a Convex HTTP route the way n8n does: HMAC-signed, fresh nonce. */
async function n8nCall(t: Backend, route: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const headers = await signRequest({ ring: parseKeyRing(N2C), method: "POST", route, body });
  const res = await t.fetch(route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** Bob borrows Alice's drill 2-4 Dec; we then jump to 6 Dec, so it's 2 days overdue. */
async function overdueLoan() {
  const c = await cast();
  await c.alice.mutation(api.loans.decide, { loanId: c.request, decision: "approve" });
  vi.setSystemTime(new Date("2026-12-06T08:00:00Z"));
  return c;
}

describe("overdue reminders use claim-check tickets", () => {
  test("the ticket list holds no personal data; redemption releases only what a reminder needs", async () => {
    const { t, request } = await overdueLoan();

    const issued = await n8nCall(t, "/n8n/reminders/tickets", {});
    expect(issued.status).toBe(200);
    expect(issued.json.reminderDate).toBe("2026-12-06");
    expect(issued.json.tickets).toHaveLength(1);
    expect(Object.keys(issued.json.tickets[0]).sort()).toEqual(["loanId", "ticket"]);
    expect(JSON.stringify(issued.json)).not.toMatch(/@|Bob|drill/i);

    const ticket = issued.json.tickets[0].ticket;
    const redeemed = await n8nCall(t, "/n8n/reminders/redeem", { tickets: [ticket] });
    expect(redeemed.json.reminders).toEqual([
      {
        ticket,
        loanId: request,
        borrower: { email: "bob@example.com", firstName: "Bob" },
        toolName: "Cordless drill",
        dueDate: "2026-12-04",
        daysOverdue: 2,
      },
    ]);
  });

  test("every release of an email is audited (ids only), and the chain stays valid", async () => {
    const { t, ada, request } = await overdueLoan();
    const { json } = await n8nCall(t, "/n8n/reminders/tickets", {});
    await n8nCall(t, "/n8n/reminders/redeem", { tickets: [json.tickets[0].ticket] });
    const audit = await ada.query(api.admin.recentAudit, {});
    const entry = audit.find((a) => a.action === "reminder_ticket.redeemed");
    expect(entry).toMatchObject({ actorRole: "n8n", targetType: "loan", targetId: request });
    expect(JSON.stringify(audit)).not.toContain("bob@example.com");
    expect((await ada.query(api.admin.verifyAuditChain, {})).ok).toBe(true);
  });

  test("write-back needs the ticket, records once, and later runs skip the loan", async () => {
    const { t, request } = await overdueLoan();
    const { json } = await n8nCall(t, "/n8n/reminders/tickets", {});
    const ticket = json.tickets[0].ticket;
    const event = { kind: "reminder_sent", loanId: request, channel: "mock" };

    const noTicket = await n8nCall(t, "/n8n/automation-events", { events: [event] });
    expect(noTicket.json.results[0]).toEqual({ status: "rejected", reason: "ticket_required" });

    const first = await n8nCall(t, "/n8n/automation-events", { events: [{ ...event, ticket }] });
    expect(first.json.results[0]).toEqual({ status: "recorded", key: `reminder_sent:${request}:2026-12-06` });
    const retry = await n8nCall(t, "/n8n/automation-events", { events: [{ ...event, ticket }] });
    expect(retry.json.results[0].status).toBe("duplicate");

    // A used ticket releases nothing, and today's run no longer lists the loan.
    expect((await n8nCall(t, "/n8n/reminders/redeem", { tickets: [ticket] })).json.reminders).toEqual([]);
    expect((await n8nCall(t, "/n8n/reminders/tickets", {})).json.tickets).toEqual([]);
  });

  test("a ticket can't be used for a different loan or after it expires", async () => {
    const { t, request, alice, bob } = await overdueLoan();
    const { json } = await n8nCall(t, "/n8n/reminders/tickets", {});
    const ticket = json.tickets[0].ticket;

    // A second, unrelated loan id: the ticket is bound to the first one.
    const saw = await alice.mutation(api.tools.create, { name: "Saw", category: "hand_tools", condition: "good", description: "" });
    const other = await bob.mutation(api.loans.request, { toolId: saw, startDate: "2026-12-07", endDate: "2026-12-08" });
    const wrong = await n8nCall(t, "/n8n/automation-events", {
      events: [{ kind: "reminder_sent", loanId: other, ticket, channel: "mock" }],
    });
    expect(wrong.json.results[0]).toEqual({ status: "rejected", reason: "bad_ticket" });

    vi.setSystemTime(new Date("2026-12-06T08:16:00Z")); // past the 15-minute ticket life
    expect((await n8nCall(t, "/n8n/reminders/redeem", { tickets: [ticket] })).json.reminders).toEqual([]);
    // ...and an expired, never-used ticket can't record a reminder either (past the grace period).
    vi.setSystemTime(new Date("2026-12-06T08:31:00Z"));
    const late = await n8nCall(t, "/n8n/automation-events", {
      events: [{ kind: "reminder_sent", loanId: request, ticket, channel: "mock" }],
    });
    expect(late.json.results[0]).toEqual({ status: "rejected", reason: "ticket_expired" });
  });

  test("a loan returned after tickets were issued discloses nothing", async () => {
    const { t, alice, request } = await overdueLoan();
    const { json } = await n8nCall(t, "/n8n/reminders/tickets", {});
    await alice.mutation(api.loans.markReturned, { loanId: request });
    expect((await n8nCall(t, "/n8n/reminders/redeem", { tickets: [json.tickets[0].ticket] })).json.reminders).toEqual([]);
  });

  test("unsigned, tampered and replayed requests get a generic 401", async () => {
    const { t } = await overdueLoan();
    const unsigned = await t.fetch("/n8n/reminders/tickets", { method: "POST", body: "{}" });
    expect(unsigned.status).toBe(401);

    const body = JSON.stringify({ tickets: [] });
    const headers = await signRequest({ ring: parseKeyRing(N2C), method: "POST", route: "/n8n/reminders/redeem", body });
    const tampered = await t.fetch("/n8n/reminders/redeem", { method: "POST", headers, body: JSON.stringify({ tickets: ["x"] }) });
    expect(tampered.status).toBe(401);
    // Signed for one route, replayed against another.
    const crossRoute = await t.fetch("/n8n/reminders/tickets", { method: "POST", headers, body });
    expect(crossRoute.status).toBe(401);
    expect((await t.fetch("/n8n/reminders/redeem", { method: "POST", headers, body })).status).toBe(200);
    expect((await t.fetch("/n8n/reminders/redeem", { method: "POST", headers, body })).status).toBe(401); // replay
  });
});

describe("only verified email addresses are stored and used", () => {
  test("an unverified email is not stored, so the user gets no notifications or reminders", async () => {
    const t = newBackend();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob", { emailVerified: false });
    const ada = await signIn(t, "ada");
    await t.mutation(internal.admin.bootstrapAdmin, { email: "ada@example.com" });

    const users = await ada.query(api.admin.listUsers, {});
    expect(users.find((u) => u.firstName === "Bob")?.emailMasked).toBe("(no verified email)");

    // Bob's loan goes overdue, but there is no verified address to remind.
    const drill = await alice.mutation(api.tools.create, { name: "Drill", category: "power_tools", condition: "good", description: "" });
    const loan = await bob.mutation(api.loans.request, { toolId: drill, startDate: "2026-12-02", endDate: "2026-12-04" });
    await alice.mutation(api.loans.decide, { loanId: loan, decision: "approve" });
    vi.setSystemTime(new Date("2026-12-06T08:00:00Z"));
    expect((await n8nCall(t, "/n8n/reminders/tickets", {})).json.tickets).toEqual([]);
  });

  test("admin bootstrap can't be pointed at an unverified address", async () => {
    const t = newBackend();
    const mallory = await signIn(t, "mallory", { emailVerified: false });
    await expect(t.mutation(internal.admin.bootstrapAdmin, { email: "mallory@example.com" })).rejects.toThrow(
      /No user with that verified email/,
    );
    expect((await mallory.query(api.users.me, {}))?.role).toBe("user");
  });

  test("losing verification clears the stored email, and the change is audited without the address", async () => {
    const t = newBackend();
    const ada = await signIn(t, "ada");
    await t.mutation(internal.admin.bootstrapAdmin, { email: "ada@example.com" });
    await signIn(t, "bob");
    await signIn(t, "bob", { emailVerified: false }); // same account, now unverified
    const users = await ada.query(api.admin.listUsers, {});
    expect(users.find((u) => u.firstName === "Bob")?.emailMasked).toBe("(no verified email)");
    const audit = await ada.query(api.admin.recentAudit, {});
    expect(audit.find((a) => a.action === "user.email_changed")?.detail).toBe("cleared");
    expect(JSON.stringify(audit)).not.toContain("@");
  });
});

test("cast sanity: the standard fixture can't be borrowed twice by the same user", async () => {
  const { bob, drill } = await cast();
  await expectCode(
    bob.mutation(api.loans.request, { toolId: drill, startDate: "2026-12-10", endDate: "2026-12-11" }),
    "INVALID",
  );
});
