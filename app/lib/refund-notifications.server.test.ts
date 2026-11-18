import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import { eq } from "drizzle-orm";
import {
  coupons,
  courses,
  enrollments,
  purchases,
  teams,
  teamMembers,
  users,
  UserRole,
  RefundStatus,
  TeamMemberRole,
} from "~/db/schema";
import { createFakeNotificationTransport } from "./notifications/fake.server";
import { syncNotificationPerson } from "./notifications.server";
import {
  listRefundRequestsForBuyer,
  raiseRefundRequest,
  submitRefundDecision,
  submitRefundRequest,
} from "./refunds.server";

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let notifications: ReturnType<typeof createFakeNotificationTransport>;
const now = new Date("2026-11-17T12:00:00Z");
beforeEach(async () => {
  db = createTestDb();
  base = seedBaseData(db);
  notifications = createFakeNotificationTransport();
  await syncNotificationPerson(base.user, notifications);
});
afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
});

function purchase() {
  return db
    .insert(purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
}

function platformAdmin(email = "admin@example.com") {
  return db
    .insert(users)
    .values({
      name: "Platform Admin",
      email,
      role: UserRole.Admin,
      avatarUrl: "/admin-avatar.png",
    })
    .returning()
    .get();
}

it("notifies current Platform Admins with the opening facts captured before delivery starts", async () => {
  const admin = platformAdmin();
  const otherAdmin = platformAdmin("other-admin@example.com");
  const bought = purchase();
  const trigger = notifications.trigger;
  notifications.trigger = async (event) => {
    expect(db.$client.inTransaction).toBe(false);
    expect(listRefundRequestsForBuyer(db, base.user.id)).toHaveLength(1);
    if (event.kind === "refund-request-confirmed") {
      db.update(users)
        .set({ role: UserRole.Student })
        .where(eq(users.id, admin.id))
        .run();
      db.update(users)
        .set({ role: UserRole.Admin })
        .where(eq(users.id, base.instructor.id))
        .run();
      db.update(courses)
        .set({ title: "A later title" })
        .where(eq(courses.id, base.course.id))
        .run();
    }
    await trigger(event);
  };

  const result = await submitRefundRequest(
    db,
    bought.id,
    base.user.id,
    "Not what I needed.",
    now,
    {
      notifications,
      mail: { async send() {} },
    }
  );
  if (!result.ok) throw new Error("Expected successful Refund Request.");
  expect(
    notifications.deliveries.find(
      (event) => event.kind === "refund-request-opened"
    )
  ).toEqual({
    kind: "refund-request-opened",
    recordId: result.refundRequestId,
    idempotencyKey: `cadence:refund-request-opened:${result.refundRequestId}`,
    recipientIds: [admin.id, otherAdmin.id],
    actorId: base.user.id,
    data: {
      category: "openRefundRequests",
      title: "New Open Refund Request",
      context: `Test User · Test Course · $79.00 · Not what I needed.`,
      destination: `/admin/refunds?refundRequestId=${result.refundRequestId}#refund-request-${result.refundRequestId}`,
      source: {
        refundRequestId: result.refundRequestId,
        purchaseId: bought.id,
        courseId: base.course.id,
      },
      snapshot: {
        buyerName: "Test User",
        courseTitle: "Test Course",
        amountPaid: 7900,
        reason: "Not what I needed.",
      },
    },
  });
});

it("notifies only the buyer after approval and entitlement changes commit, retaining the existing email", async () => {
  const admin = platformAdmin();
  const bought = purchase();
  db.insert(enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  const request = raiseRefundRequest(
    db,
    bought.id,
    base.user.id,
    "Not what I needed.",
    now
  );
  if (!request.ok) throw new Error("Expected successful Refund Request.");
  const emails: string[] = [];
  const trigger = notifications.trigger;
  notifications.trigger = async (event) => {
    expect(db.$client.inTransaction).toBe(false);
    expect(listRefundRequestsForBuyer(db, base.user.id)[0]?.status).toBe(
      RefundStatus.Approved
    );
    expect(db.select().from(enrollments).all()).toEqual([]);
    await trigger(event);
  };

  const result = await submitRefundDecision(
    db,
    request.refundRequestId,
    admin.id,
    "approve",
    "Agreed.",
    now,
    {
      notifications,
      mail: {
        async send(email) {
          emails.push(email.subject);
        },
      },
    }
  );
  expect(result.ok).toBe(true);
  expect(notifications.deliveries).toEqual([
    {
      kind: "refund-request-approved",
      recordId: request.refundRequestId,
      idempotencyKey: `cadence:refund-request-approved:${request.refundRequestId}`,
      recipientIds: [base.user.id],
      actorId: admin.id,
      data: {
        category: "refundRequestUpdates",
        title: "Refund Request approved",
        context: `Test Course · Purchase #${bought.id} · Agreed.`,
        destination: `/settings#refund-request-${request.refundRequestId}`,
        source: {
          refundRequestId: request.refundRequestId,
          purchaseId: bought.id,
          courseId: base.course.id,
        },
        snapshot: { courseTitle: "Test Course", decisionNote: "Agreed." },
      },
    },
  ]);
  expect(emails).toEqual(["Refund approved — Test Course"]);
});

it("explains a Team Licence decline to its buyer and keeps earlier openings unchanged when another request is raised", async () => {
  const admin = platformAdmin();
  const bought = purchase();
  const team = db.insert(teams).values({}).returning().get();
  db.insert(coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      purchaseId: bought.id,
      code: "TEAM-DECLINE",
    })
    .run();
  const dependencies = { notifications, mail: { async send() {} } };
  const opened = await submitRefundRequest(
    db,
    bought.id,
    base.user.id,
    "Not what we needed.",
    now,
    dependencies
  );
  if (!opened.ok) throw new Error("Expected successful Refund Request.");
  const originalEvents = structuredClone(notifications.deliveries);

  expect(
    await submitRefundDecision(
      db,
      opened.refundRequestId,
      admin.id,
      "decline",
      "  Please explain more.  ",
      now,
      dependencies
    )
  ).toMatchObject({ ok: true });
  expect(notifications.deliveries[2]).toEqual({
    kind: "refund-request-declined",
    recordId: opened.refundRequestId,
    idempotencyKey: `cadence:refund-request-declined:${opened.refundRequestId}`,
    recipientIds: [base.user.id],
    actorId: admin.id,
    data: {
      category: "refundRequestUpdates",
      title: "Refund Request declined",
      context: `Test Course · Purchase #${bought.id} · Please explain more. · You may raise another Refund Request.`,
      destination: `/settings#refund-request-${opened.refundRequestId}`,
      source: {
        refundRequestId: opened.refundRequestId,
        purchaseId: bought.id,
        courseId: base.course.id,
      },
      snapshot: {
        courseTitle: "Test Course",
        decisionNote: "Please explain more.",
      },
    },
  });
  const reopened = await submitRefundRequest(
    db,
    bought.id,
    base.user.id,
    "Here is more context.",
    now,
    dependencies
  );
  expect(reopened.ok).toBe(true);
  expect(notifications.deliveries.slice(0, 2)).toEqual(originalEvents);
  expect(
    new Set(notifications.deliveries.map((event) => event.idempotencyKey)).size
  ).toBe(5);
});

describe("Refund Request confirmation delivery", () => {
  it("confirms the buyer's committed request with course, amount and stable event identity", async () => {
    const bought = purchase();
    const trigger = notifications.trigger;
    notifications.trigger = async (event) => {
      expect(db.$client.inTransaction).toBe(false);
      expect(listRefundRequestsForBuyer(db, base.user.id)).toHaveLength(1);
      await trigger(event);
    };
    const result = await submitRefundRequest(
      db,
      bought.id,
      base.user.id,
      "Not what I needed.",
      now,
      { notifications, mail: { async send() {} } }
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected successful Refund Request.");
    expect(notifications.triggers).toEqual([
      {
        kind: "refund-request-confirmed",
        recordId: result.refundRequestId,
        idempotencyKey: `cadence:refund-request-confirmed:${result.refundRequestId}`,
        recipientIds: [base.user.id],
        actorId: null,
        data: {
          category: "refundRequestUpdates",
          title: "Refund Request received",
          context: `${base.course.title} · $79.00 · Your request is under review.`,
          destination: null,
          source: {
            refundRequestId: result.refundRequestId,
            purchaseId: bought.id,
            courseId: base.course.id,
          },
          snapshot: { courseTitle: base.course.title, amountPaid: 7900 },
        },
      },
    ]);
  });
});

it("confirms the Team Licence buyer, even when other people share the team", async () => {
  const bought = purchase();
  const team = db.insert(teams).values({}).returning().get();
  db.insert(coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      purchaseId: bought.id,
      code: "UNCLAIMED",
    })
    .run();
  const result = await submitRefundRequest(
    db,
    bought.id,
    base.user.id,
    "Not what we needed.",
    now,
    { notifications, mail: { async send() {} } }
  );
  expect(result).toMatchObject({ ok: true, kind: "team_licence" });
  expect(notifications.deliveries[0]?.recipientIds).toEqual([base.user.id]);
});

it("keeps the committed request and existing email when Notification delivery fails", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  notifications.failures.add("trigger");
  const emails: string[] = [];
  const result = await submitRefundRequest(
    db,
    purchase().id,
    base.user.id,
    "Not what I needed.",
    now,
    {
      notifications,
      mail: {
        async send(email) {
          emails.push(email.to);
        },
      },
    }
  );
  expect(result.ok).toBe(true);
  expect(listRefundRequestsForBuyer(db, base.user.id)).toHaveLength(1);
  expect(emails).toEqual([base.user.email]);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("Notification delivery failed"),
    expect.any(Error)
  );
});

it("attempts both confirmation and opening even when the independent existing email throws", async () => {
  platformAdmin();
  await expect(
    submitRefundRequest(
      db,
      purchase().id,
      base.user.id,
      "Not what I needed.",
      now,
      {
        notifications,
        mail: {
          async send() {
            throw new Error("Email failed");
          },
        },
      }
    )
  ).rejects.toThrow("Email failed");
  expect(listRefundRequestsForBuyer(db, base.user.id)).toHaveLength(1);
  expect(notifications.deliveries.map((event) => event.kind)).toEqual([
    "refund-request-confirmed",
    "refund-request-opened",
  ]);
});

it("selects subsequent Platform Admin audiences from current roles without replay or role sync, excluding the buyer's own opening", async () => {
  const admin = platformAdmin();
  db.update(users)
    .set({ role: UserRole.Admin })
    .where(eq(users.id, base.user.id))
    .run();
  const dependencies = { notifications, mail: { async send() {} } };
  await submitRefundRequest(
    db,
    purchase().id,
    base.user.id,
    "Not what I needed.",
    now,
    dependencies
  );
  db.update(users)
    .set({ role: UserRole.Student })
    .where(eq(users.id, admin.id))
    .run();
  db.update(users)
    .set({ role: UserRole.Admin })
    .where(eq(users.id, base.instructor.id))
    .run();
  expect(notifications.triggers).toHaveLength(2);
  await submitRefundRequest(
    db,
    purchase().id,
    base.user.id,
    "Not what I needed.",
    now,
    dependencies
  );
  expect(
    notifications.deliveries.map((event) => [event.kind, event.recipientIds])
  ).toEqual([
    ["refund-request-confirmed", [base.user.id]],
    ["refund-request-opened", [admin.id]],
    ["refund-request-confirmed", [base.user.id]],
    ["refund-request-opened", [base.instructor.id]],
  ]);
});

it.each(["refund-request-confirmed", "refund-request-opened"] as const)(
  "keeps the independent delivery and email when %s fails",
  async (failedKind) => {
    platformAdmin();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const trigger = notifications.trigger;
    notifications.trigger = async (event) => {
      if (event.kind === failedKind) notifications.failures.add("trigger");
      else notifications.failures.delete("trigger");
      await trigger(event);
    };
    const emails: string[] = [];
    const result = await submitRefundRequest(
      db,
      purchase().id,
      base.user.id,
      "Not what I needed.",
      now,
      {
        notifications,
        mail: {
          async send(email) {
            emails.push(email.to);
          },
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(notifications.triggers.map((event) => event.kind)).toEqual([
      "refund-request-confirmed",
      "refund-request-opened",
    ]);
    expect(notifications.deliveries.map((event) => event.kind)).toEqual([
      failedKind === "refund-request-confirmed"
        ? "refund-request-opened"
        : "refund-request-confirmed",
    ]);
    expect(emails).toEqual([base.user.email]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`Notification delivery failed for ${failedKind}`),
      expect.any(Error)
    );
  }
);

it("suppresses only a muted Platform Admin's openings, independently of buyer updates", async () => {
  const mutedAdmin = platformAdmin();
  const subscribedAdmin = platformAdmin("subscribed@example.com");
  await syncNotificationPerson(mutedAdmin, notifications);
  await notifications.setPreference(mutedAdmin.id, {
    category: "openRefundRequests",
    channel: "feed",
    enabled: false,
  });
  await submitRefundRequest(
    db,
    purchase().id,
    base.user.id,
    "Not what I needed.",
    now,
    { notifications, mail: { async send() {} } }
  );
  expect(
    notifications.deliveries.map((event) => [event.kind, event.recipientIds])
  ).toEqual([
    ["refund-request-confirmed", [base.user.id]],
    ["refund-request-opened", [subscribedAdmin.id]],
  ]);
});

it.each(["approve", "decline"] as const)(
  "honors muted buyer updates for %s while keeping the email",
  async (intent) => {
    const admin = platformAdmin();
    const opened = raiseRefundRequest(
      db,
      purchase().id,
      base.user.id,
      "Not what I needed.",
      now
    );
    if (!opened.ok) throw new Error("Expected successful Refund Request.");
    await notifications.setPreference(base.user.id, {
      category: "refundRequestUpdates",
      channel: "feed",
      enabled: false,
    });
    const emails: string[] = [];
    const result = await submitRefundDecision(
      db,
      opened.refundRequestId,
      admin.id,
      intent,
      "Our decision.",
      now,
      {
        notifications,
        mail: {
          async send(email) {
            emails.push(email.to);
          },
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(notifications.triggers).toHaveLength(1);
    expect(notifications.deliveries).toEqual([]);
    expect(emails).toEqual([base.user.email]);
  }
);

it.each(["approve", "decline"] as const)(
  "excludes the actor's own %s update while retaining the decision email",
  async (intent) => {
    db.update(users)
      .set({ role: UserRole.Admin })
      .where(eq(users.id, base.user.id))
      .run();
    const opened = raiseRefundRequest(
      db,
      purchase().id,
      base.user.id,
      "Not what I needed.",
      now
    );
    if (!opened.ok) throw new Error("Expected successful Refund Request.");
    const emails: string[] = [];
    const result = await submitRefundDecision(
      db,
      opened.refundRequestId,
      base.user.id,
      intent,
      "Our decision.",
      now,
      {
        notifications,
        mail: {
          async send(email) {
            emails.push(email.to);
          },
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(notifications.triggers).toEqual([]);
    expect(emails).toEqual([base.user.email]);
  }
);

it.each(["approve", "decline"] as const)(
  "keeps %s committed if delivery fails and creates no further event or email for a repeated decision",
  async (intent) => {
    const admin = platformAdmin();
    const opened = raiseRefundRequest(
      db,
      purchase().id,
      base.user.id,
      "Not what I needed.",
      now
    );
    if (!opened.ok) throw new Error("Expected successful Refund Request.");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    notifications.failures.add("trigger");
    const emails: string[] = [];
    const dependencies = {
      notifications,
      mail: {
        async send(email: { to: string }) {
          emails.push(email.to);
        },
      },
    };
    expect(
      await submitRefundDecision(
        db,
        opened.refundRequestId,
        admin.id,
        intent,
        "Our decision.",
        now,
        dependencies
      )
    ).toMatchObject({ ok: true });
    expect(listRefundRequestsForBuyer(db, base.user.id)[0]?.status).toBe(
      intent === "approve" ? RefundStatus.Approved : RefundStatus.Declined
    );
    for (const repeatedIntent of ["approve", "decline"] as const) {
      expect(
        await submitRefundDecision(
          db,
          opened.refundRequestId,
          admin.id,
          repeatedIntent,
          "A repeated decision.",
          now,
          dependencies
        )
      ).toMatchObject({ ok: false, status: 409 });
    }
    expect(notifications.triggers).toHaveLength(1);
    expect(emails).toEqual([base.user.email]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Notification delivery failed"),
      expect.any(Error)
    );
  }
);

it.each(["approve", "decline"] as const)(
  "attempts the %s update before an email exception escapes",
  async (intent) => {
    const admin = platformAdmin();
    const opened = raiseRefundRequest(
      db,
      purchase().id,
      base.user.id,
      "Not what I needed.",
      now
    );
    if (!opened.ok) throw new Error("Expected successful Refund Request.");
    await expect(
      submitRefundDecision(
        db,
        opened.refundRequestId,
        admin.id,
        intent,
        "Our decision.",
        now,
        {
          notifications,
          mail: {
            async send() {
              throw new Error("Email failed");
            },
          },
        }
      )
    ).rejects.toThrow("Email failed");
    expect(notifications.deliveries).toHaveLength(1);
    expect(listRefundRequestsForBuyer(db, base.user.id)[0]?.status).toBe(
      intent === "approve" ? RefundStatus.Approved : RefundStatus.Declined
    );
  }
);

it("notifies the Team Licence buyer alone after all Seats are invalidated", async () => {
  const admin = platformAdmin();
  const bought = purchase();
  const team = db.insert(teams).values({}).returning().get();
  db.insert(teamMembers)
    .values([
      { teamId: team.id, userId: base.user.id, role: TeamMemberRole.Admin },
      {
        teamId: team.id,
        userId: base.instructor.id,
        role: TeamMemberRole.Admin,
      },
    ])
    .run();
  db.insert(coupons)
    .values(
      ["ONE", "TWO"].map((code) => ({
        teamId: team.id,
        courseId: base.course.id,
        purchaseId: bought.id,
        code,
      }))
    )
    .run();
  const opened = raiseRefundRequest(
    db,
    bought.id,
    base.user.id,
    "Not what we needed.",
    now
  );
  if (!opened.ok) throw new Error("Expected successful Refund Request.");
  const trigger = notifications.trigger;
  notifications.trigger = async (event) => {
    expect(db.$client.inTransaction).toBe(false);
    expect(
      db
        .select()
        .from(coupons)
        .all()
        .map((seat) => seat.refundedAt)
    ).toEqual([now.toISOString(), now.toISOString()]);
    await trigger(event);
  };
  await submitRefundDecision(
    db,
    opened.refundRequestId,
    admin.id,
    "approve",
    null,
    now,
    { notifications, mail: { async send() {} } }
  );
  expect(notifications.deliveries).toMatchObject([
    {
      recipientIds: [base.user.id],
      data: {
        context: `Test Course · Purchase #${bought.id}`,
        snapshot: { decisionNote: null },
      },
    },
  ]);
});

it("does not deliver or email when a decision transaction rolls back", async () => {
  const admin = platformAdmin();
  db.insert(enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  const opened = raiseRefundRequest(
    db,
    purchase().id,
    base.user.id,
    "Not what I needed.",
    now
  );
  if (!opened.ok) throw new Error("Expected successful Refund Request.");
  db.$client.exec(
    "CREATE TRIGGER fail_decision BEFORE UPDATE ON refunds BEGIN SELECT RAISE(ABORT, 'decision rejected'); END"
  );
  const emails: string[] = [];
  await expect(
    submitRefundDecision(
      db,
      opened.refundRequestId,
      admin.id,
      "approve",
      null,
      now,
      {
        notifications,
        mail: {
          async send(email) {
            emails.push(email.to);
          },
        },
      }
    )
  ).rejects.toThrow();
  expect(listRefundRequestsForBuyer(db, base.user.id)[0]?.status).toBe(
    RefundStatus.Open
  );
  expect(db.select().from(enrollments).all()).toHaveLength(1);
  expect(notifications.triggers).toEqual([]);
  expect(emails).toEqual([]);
});

it("produces no decision update or email for a missing request, missing decline note, or Team Licence with a Claimed Seat", async () => {
  const admin = platformAdmin();
  const bought = purchase();
  const team = db.insert(teams).values({}).returning().get();
  const seat = db
    .insert(coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      purchaseId: bought.id,
      code: "CLAIMED",
    })
    .returning()
    .get();
  const opened = raiseRefundRequest(
    db,
    bought.id,
    base.user.id,
    "Not what we needed.",
    now
  );
  if (!opened.ok) throw new Error("Expected successful Refund Request.");
  db.update(coupons)
    .set({
      redeemedByUserId: base.instructor.id,
      redeemedAt: now.toISOString(),
    })
    .where(eq(coupons.id, seat.id))
    .run();
  const emails: string[] = [];
  const dependencies = {
    notifications,
    mail: {
      async send(email: { to: string }) {
        emails.push(email.to);
      },
    },
  };
  expect(
    await submitRefundDecision(
      db,
      999,
      admin.id,
      "approve",
      null,
      now,
      dependencies
    )
  ).toMatchObject({ ok: false, status: 404 });
  expect(
    await submitRefundDecision(
      db,
      opened.refundRequestId,
      admin.id,
      "decline",
      " ",
      now,
      dependencies
    )
  ).toMatchObject({ ok: false, status: 400 });
  expect(
    await submitRefundDecision(
      db,
      opened.refundRequestId,
      admin.id,
      "approve",
      null,
      now,
      dependencies
    )
  ).toMatchObject({ ok: false, status: 409 });
  expect(listRefundRequestsForBuyer(db, base.user.id)[0]?.status).toBe(
    RefundStatus.Open
  );
  expect(notifications.triggers).toEqual([]);
  expect(emails).toEqual([]);
});

it("honors a muted feed category while still sending its existing email", async () => {
  await notifications.setPreference(base.user.id, {
    category: "refundRequestUpdates",
    channel: "feed",
    enabled: false,
  });
  const emails: string[] = [];
  await submitRefundRequest(
    db,
    purchase().id,
    base.user.id,
    "Not what I needed.",
    now,
    {
      notifications,
      mail: {
        async send(email) {
          emails.push(email.to);
        },
      },
    }
  );
  expect(notifications.triggers).toHaveLength(1);
  expect(notifications.deliveries).toEqual([]);
  expect(emails).toEqual([base.user.email]);
});

it("never attempts a Notification for an unauthorized or duplicate request", async () => {
  const bought = purchase();
  const dependencies = { notifications, mail: { async send() {} } };
  expect(
    await submitRefundRequest(
      db,
      bought.id,
      base.instructor.id,
      "Not my Purchase.",
      now,
      dependencies
    )
  ).toMatchObject({ ok: false });
  expect(notifications.triggers).toEqual([]);
  await submitRefundRequest(
    db,
    bought.id,
    base.user.id,
    "Not what I needed.",
    now,
    dependencies
  );
  expect(
    await submitRefundRequest(
      db,
      bought.id,
      base.user.id,
      "Not what I needed.",
      now,
      dependencies
    )
  ).toMatchObject({ ok: false, status: 409 });
  expect(notifications.triggers).toHaveLength(1);
});
