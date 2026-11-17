import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import { coupons, purchases, teams } from "~/db/schema";
import { createFakeNotificationTransport } from "./notifications/fake.server";
import { syncNotificationPerson } from "./notifications.server";
import {
  listRefundRequestsForBuyer,
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

it("attempts confirmation even when the independent existing email throws", async () => {
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
  expect(notifications.deliveries).toHaveLength(1);
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
