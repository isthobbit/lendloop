/**
 * Role-based access control, tested against the real Convex functions.
 * Each `describe` block is one row of the table in README §5, so the README's
 * claims are checked by CI rather than only stated.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { cast, expectCode, newBackend, NOW, signIn } from "./setup";

beforeEach(() => {
  // Fake timers also stop scheduled outbox deliveries from firing mid-test.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("anonymous visitors", () => {
  test("see available tools as name + category only (no ids, owner, description)", async () => {
    const { t } = await cast();
    const list = await t.query(api.tools.publicList, {});
    expect(list).toEqual([{ name: "Cordless drill", category: "power_tools" }]);
  });

  test("cannot browse details, list, borrow, or act on anything", async () => {
    const { t, drill, request } = await cast();
    await expectCode(t.query(api.tools.list, {}), "UNAUTHENTICATED");
    await expectCode(t.query(api.loans.myRequests, {}), "UNAUTHENTICATED");
    await expectCode(
      t.mutation(api.tools.create, { name: "Saw", category: "hand_tools", condition: "good", description: "" }),
      "UNAUTHENTICATED",
    );
    await expectCode(
      t.mutation(api.loans.request, { toolId: drill, startDate: "2026-12-10", endDate: "2026-12-11" }),
      "UNAUTHENTICATED",
    );
    await expectCode(t.mutation(api.loans.decide, { loanId: request, decision: "approve" }), "UNAUTHENTICATED");
  });
});

describe("listings: users can edit or delete only their own", () => {
  test("another user's edit or delete is NOT_FOUND (same error as a missing id)", async () => {
    const { eve, ada, drill } = await cast();
    const edit = { toolId: drill, name: "Mine now", category: "power_tools", condition: "worn", description: "" } as const;
    await expectCode(eve.mutation(api.tools.update, edit), "NOT_FOUND");
    await expectCode(eve.mutation(api.tools.remove, { toolId: drill }), "NOT_FOUND");
    // Admins moderate through admin.removeListing, not by editing as the owner.
    await expectCode(ada.mutation(api.tools.update, edit), "NOT_FOUND");
  });

  test("the owner can edit; the new owner is always the caller, never an argument", async () => {
    const { alice, bob, drill } = await cast();
    await alice.mutation(api.tools.update, {
      toolId: drill,
      name: "Cordless drill (new chuck)",
      category: "power_tools",
      condition: "good",
      description: "",
    });
    const browse = await bob.query(api.tools.list, {});
    expect(browse[0].name).toBe("Cordless drill (new chuck)");
    expect(browse[0].isMine).toBe(false);
  });
});

describe("borrowing", () => {
  test("nobody can borrow their own tool", async () => {
    const { alice, drill } = await cast();
    await expectCode(
      alice.mutation(api.loans.request, { toolId: drill, startDate: "2026-12-10", endDate: "2026-12-11" }),
      "FORBIDDEN",
    );
  });
});

describe("approve / decline: owner of the tool only", () => {
  test("the borrower, an unrelated user, and an admin all get NOT_FOUND", async () => {
    const { bob, eve, ada, request } = await cast();
    for (const caller of [bob, eve, ada]) {
      await expectCode(caller.mutation(api.loans.decide, { loanId: request, decision: "approve" }), "NOT_FOUND");
      await expectCode(caller.mutation(api.loans.decide, { loanId: request, decision: "decline" }), "NOT_FOUND");
    }
  });

  test("the owner can approve", async () => {
    const { alice, bob, request } = await cast();
    await alice.mutation(api.loans.decide, { loanId: request, decision: "approve" });
    const [mine] = await bob.query(api.loans.myRequests, {});
    expect(mine.status).toBe("approved");
  });
});

describe("mark returned: owner of the tool only", () => {
  test("the borrower, an unrelated user, and an admin all get NOT_FOUND; the owner succeeds", async () => {
    const { alice, bob, eve, ada, request } = await cast();
    await alice.mutation(api.loans.decide, { loanId: request, decision: "approve" });
    vi.setSystemTime(new Date("2026-12-03T12:00:00Z")); // loan has started
    for (const caller of [bob, eve, ada]) {
      await expectCode(caller.mutation(api.loans.markReturned, { loanId: request }), "NOT_FOUND");
    }
    await alice.mutation(api.loans.markReturned, { loanId: request });
    const [loan] = await alice.query(api.loans.incoming, {});
    expect(loan.status).toBe("returned");
  });
});

describe("cancel a request: the borrower only", () => {
  test("the lender, an unrelated user, and an admin get NOT_FOUND; the borrower succeeds", async () => {
    const { alice, bob, eve, ada, request } = await cast();
    for (const caller of [alice, eve, ada]) {
      await expectCode(caller.mutation(api.loans.cancel, { loanId: request }), "NOT_FOUND");
    }
    await bob.mutation(api.loans.cancel, { loanId: request });
    const [mine] = await bob.query(api.loans.myRequests, {});
    expect(mine.status).toBe("cancelled");
  });
});

describe("views are scoped to the caller", () => {
  test("users only see their own requests and incoming requests", async () => {
    const { alice, bob, eve } = await cast();
    expect(await eve.query(api.loans.myRequests, {})).toEqual([]);
    expect(await eve.query(api.loans.incoming, {})).toEqual([]);
    expect(await bob.query(api.loans.incoming, {})).toEqual([]);
    expect(await alice.query(api.loans.myRequests, {})).toEqual([]);
    expect(await alice.query(api.loans.incoming, {})).toHaveLength(1);
  });

  test("other members see a first name and badge, never an email or user id", async () => {
    const { bob } = await cast();
    const [tool] = await bob.query(api.tools.list, {});
    const json = JSON.stringify(tool);
    expect(tool.ownerFirstName).toBe("Alice");
    expect(json).not.toContain("@");
    expect(Object.keys(tool)).not.toContain("ownerId");
    expect(JSON.stringify(await bob.query(api.users.me, {}))).not.toContain("@");
  });
});

describe("admin-only functions", () => {
  const adminQueries = [
    api.admin.listUsers,
    api.admin.allTools,
    api.admin.allLoans,
    api.admin.automationHealth,
    api.admin.recentAudit,
    api.admin.verifyAuditChain,
  ];

  test("regular users get FORBIDDEN and anonymous callers get UNAUTHENTICATED", async () => {
    const { t, bob, alice, drill } = await cast();
    for (const q of adminQueries) {
      await expectCode(bob.query(q, {}), "FORBIDDEN");
      await expectCode(t.query(q, {}), "UNAUTHENTICATED");
    }
    const [aliceRow] = (await (await signIn(t, "ada")).query(api.admin.listUsers, {})).filter(
      (u) => u.firstName === "Alice",
    );
    await expectCode(bob.mutation(api.admin.setTrustedLender, { userId: aliceRow._id, trusted: true }), "FORBIDDEN");
    await expectCode(bob.mutation(api.admin.removeListing, { toolId: drill, reason: "spam spam" }), "FORBIDDEN");
    await expectCode(alice.mutation(api.admin.removeListing, { toolId: drill, reason: "my own tool" }), "FORBIDDEN");
  });

  test("an admin can remove any listing (reason required, audited) and see all loans", async () => {
    const { ada, drill, t } = await cast();
    await expectCode(ada.mutation(api.admin.removeListing, { toolId: drill, reason: "no" }), "INVALID");
    await ada.mutation(api.admin.removeListing, { toolId: drill, reason: "Listing breaks the rules" });
    expect(await t.query(api.tools.publicList, {})).toEqual([]);
    expect(await ada.query(api.admin.allLoans, {})).toHaveLength(1);
    const audit = await ada.query(api.admin.recentAudit, {});
    expect(audit.some((a) => a.action === "tool.removed_by_admin" && a.detail === "Listing breaks the rules")).toBe(true);
    expect((await ada.query(api.admin.verifyAuditChain, {})).ok).toBe(true);
  });

  test("admins see emails masked", async () => {
    const { ada } = await cast();
    const users = await ada.query(api.admin.listUsers, {});
    expect(users.find((u) => u.firstName === "Bob")?.emailMasked).toBe("b***@example.com");
    expect(JSON.stringify(users)).not.toContain("bob@example.com");
  });
});

describe("roles come from the database, never the client", () => {
  test("new accounts always start as role 'user', whatever the token says", async () => {
    const t = newBackend();
    const sneaky = t.withIdentity({ subject: "user_mallory", email: "m@example.com", emailVerified: true, role: "admin" } as never);
    await sneaky.mutation(api.users.ensureCurrent, {});
    expect((await sneaky.query(api.users.me, {}))?.role).toBe("user");
    await expectCode(sneaky.query(api.admin.listUsers, {}), "FORBIDDEN");
  });
});

/**
 * Guard rail for future changes: every function reachable from a browser is
 * listed here. Adding a public query/mutation/action fails this test until it
 * has been reviewed (does it authorize first?) and added to the list.
 */
describe("public API surface", () => {
  test("only reviewed functions are public; admin promotion is internal-only", async () => {
    const mods = import.meta.glob("../../convex/*.ts", { eager: true }) as Record<string, Record<string, unknown>>;
    const publicFns: string[] = [];
    for (const [path, mod] of Object.entries(mods)) {
      const file = path.split("/").pop()!.replace(/\.ts$/, "");
      for (const [name, fn] of Object.entries(mod)) {
        const f = fn as { isPublic?: boolean; isQuery?: boolean; isMutation?: boolean; isAction?: boolean };
        if (f && f.isPublic && (f.isQuery || f.isMutation || f.isAction)) publicFns.push(`${file}.${name}`);
      }
    }
    expect(publicFns.sort()).toEqual(
      [
        "admin.acknowledgeError",
        "admin.allLoans",
        "admin.allTools",
        "admin.automationHealth",
        "admin.listUsers",
        "admin.recentAudit",
        "admin.removeListing",
        "admin.setTrustedLender",
        "admin.verifyAuditChain",
        "loans.cancel",
        "loans.decide",
        "loans.incoming",
        "loans.markReturned",
        "loans.myRequests",
        "loans.request",
        "outbox.retryDead",
        "tools.create",
        "tools.list",
        "tools.myListings",
        "tools.publicList",
        "tools.remove",
        "tools.update",
        "users.ensureCurrent",
        "users.me",
      ].sort(),
    );
    expect(publicFns).not.toContain("admin.bootstrapAdmin");
    // Sanity: the internal reference exists and works for deploy-key holders (the test harness).
    expect(internal.admin.bootstrapAdmin).toBeDefined();
  });
});
