import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  coupons,
  courses,
  enrollments,
  purchases,
  teamMembers,
  TeamMemberRole,
  teams,
  users,
  UserRole,
} from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";
import { notificationTransportContext } from "~/lib/notifications/transport.server";
import { createFakeNotificationTransport } from "~/lib/notifications/fake.server";
import { action as purchaseAction } from "./courses.$slug.purchase";
import { action as seatAction } from "./redeem.$code";

// Replace only the connection boundary. The actions use real sessions,
// country resolution and Enrollment services against migrated SQLite.
vi.mock("~/db", () => ({
  get db() {
    return db;
  },
}));

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let notifications: ReturnType<typeof createFakeNotificationTransport>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  notifications = createFakeNotificationTransport();
  db.update(courses)
    .set({ price: 7999, pppEnabled: true })
    .where(eq(courses.id, base.course.id))
    .run();
});

afterEach(() => {
  db.$client.close();
});

async function postAs(
  userId: number | null,
  fields: Record<string, string>,
  country = "PL"
) {
  const url = "http://localhost/enrollment";
  const cookie =
    userId === null ? "" : await setCurrentUserId(new Request(url), userId);
  return new Request(url, {
    method: "POST",
    headers: { Cookie: cookie, "CF-IPCountry": country },
    body: new URLSearchParams(fields),
  });
}

function callPurchaseAction(request: Request, slug = base.course.slug) {
  return purchaseAction({
    request,
    params: { slug },
    context: new RouterContextProvider(),
    url: new URL(request.url),
    pattern: "/courses/:slug/purchase",
  });
}

function callSeatAction(request: Request, code: string) {
  const context = new RouterContextProvider();
  context.set(notificationTransportContext, notifications);
  return seatAction({
    request,
    params: { code },
    context,
    url: new URL(request.url),
    pattern: "/redeem/:code",
  });
}

async function expectRedirect(action: Promise<unknown>, location: string) {
  await expect(action).rejects.toSatisfy(
    (response: unknown) =>
      response instanceof Response &&
      response.status === 302 &&
      response.headers.get("Location") === location
  );
}

function unclaimedSeat() {
  const team = db.insert(teams).values({}).returning().get();
  const purchase = db
    .insert(purchases)
    .values({
      userId: base.instructor.id,
      courseId: base.course.id,
      amountPaid: 5599,
      country: "PL",
    })
    .returning()
    .get();
  return db
    .insert(coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      purchaseId: purchase.id,
      code: "SEAT-FOR-STUDENT",
    })
    .returning()
    .get();
}

describe("Enrollment action authorization", () => {
  it.each(["Individual Purchase", "Seat claim"])(
    "rejects an invalid intent for %s before writing",
    async (path) => {
      const seat = unclaimedSeat();
      const originalPurchases = db.select().from(purchases).all();
      const request = await postAs(base.user.id, { intent: "invalid" });

      await expect(
        path === "Individual Purchase"
          ? callPurchaseAction(request)
          : callSeatAction(request, seat.code)
      ).rejects.toMatchObject({
        data: "Invalid action.",
        init: { status: 400 },
      });
      expect(db.select().from(purchases).all()).toEqual(originalPurchases);
      expect(db.select().from(coupons).all()).toEqual([seat]);
      expect(db.select().from(enrollments).all()).toEqual([]);
      expect(notifications.triggers).toEqual([]);
    }
  );

  it.each(["Individual Purchase", "Seat claim"])(
    "requires a signed-in person for %s",
    async (path) => {
      const seat = unclaimedSeat();
      const originalPurchases = db.select().from(purchases).all();
      const request = await postAs(null, {
        intent:
          path === "Individual Purchase"
            ? "confirm-purchase"
            : "confirm-redeem",
      });

      await expect(
        path === "Individual Purchase"
          ? callPurchaseAction(request)
          : callSeatAction(request, seat.code)
      ).rejects.toMatchObject({
        data: "You must be logged in.",
        init: { status: 401 },
      });
      expect(db.select().from(purchases).all()).toEqual(originalPurchases);
      expect(db.select().from(coupons).all()).toEqual([seat]);
      expect(db.select().from(enrollments).all()).toEqual([]);
      expect(notifications.triggers).toEqual([]);
    }
  );
});

describe("Seat claim action", () => {
  it("redirects to welcome with the complete claim saved when Notification delivery fails", async () => {
    const seat = unclaimedSeat();
    notifications.failures.add("trigger");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expectRedirect(
        callSeatAction(
          await postAs(base.user.id, { intent: "confirm-redeem" }),
          seat.code
        ),
        "/courses/test-course/welcome"
      );
      expect(
        db.select().from(coupons).where(eq(coupons.id, seat.id)).get()
      ).toMatchObject({ redeemedByUserId: base.user.id });
      expect(db.select().from(enrollments).all()).toEqual([
        expect.objectContaining({ userId: base.user.id }),
      ]);
      expect(notifications.triggers).toHaveLength(1);
      expect(notifications.deliveries).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("returns the existing unavailable-Seat response after a refund", async () => {
    const seat = unclaimedSeat();
    const refundedAt = "2026-11-17T12:00:00.000Z";
    db.update(coupons).set({ refundedAt }).where(eq(coupons.id, seat.id)).run();

    expect(
      await callSeatAction(
        await postAs(base.user.id, { intent: "confirm-redeem" }),
        seat.code
      )
    ).toMatchObject({
      data: {
        error:
          "This seat is no longer available. Ask the person who shared it with you.",
      },
      init: { status: 400 },
    });
    expect(db.select().from(coupons).all()).toEqual([{ ...seat, refundedAt }]);
    expect(db.select().from(enrollments).all()).toEqual([]);
    expect(notifications.triggers).toEqual([]);
  });

  it("preserves the country restriction error and leaves the Seat Unclaimed", async () => {
    const seat = unclaimedSeat();
    const request = await postAs(
      base.user.id,
      { intent: "confirm-redeem" },
      "US"
    );

    expect(await callSeatAction(request, seat.code)).toMatchObject({
      data: {
        error:
          "This coupon can only be redeemed from the same country as the purchaser",
      },
      init: { status: 400 },
    });
    expect(db.select().from(coupons).all()).toEqual([seat]);
    expect(db.select().from(enrollments).all()).toEqual([]);
    expect(notifications.triggers).toEqual([]);
  });

  it("allows only one successful claim when two signed-in people submit the same Seat together", async () => {
    const seat = unclaimedSeat();
    const competitor = db
      .insert(users)
      .values({
        name: "Second Student",
        email: "second@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();
    const requests = await Promise.all([
      postAs(base.user.id, { intent: "confirm-redeem" }),
      postAs(competitor.id, { intent: "confirm-redeem" }),
    ]);

    const results = await Promise.allSettled(
      requests.map((request) => callSeatAction(request, seat.code))
    );

    const redirects = results.filter((result) => result.status === "rejected");
    const failures = results.filter((result) => result.status === "fulfilled");
    expect(redirects).toHaveLength(1);
    expect(redirects[0].reason).toSatisfy(
      (response: unknown) =>
        response instanceof Response &&
        response.headers.get("Location") === "/courses/test-course/welcome"
    );
    expect(failures).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          data: { error: "Coupon has already been redeemed" },
          init: { status: 400 },
        }),
      }),
    ]);
    const enrollment = db.select().from(enrollments).get();
    if (!enrollment) throw new Error("Claimant was not enrolled");
    expect(db.select().from(enrollments).all()).toHaveLength(1);
    expect(db.select().from(coupons).all()).toEqual([
      expect.objectContaining({ redeemedByUserId: enrollment.userId }),
    ]);
    expect(notifications.triggers).toEqual([
      expect.objectContaining({
        kind: "seat-claimed",
        recipientIds: [base.instructor.id],
        actorId: enrollment.userId,
      }),
    ]);
  });

  it("redirects a successful claimant to welcome and preserves the existing error response on a repeated claim", async () => {
    const seat = unclaimedSeat();

    await expectRedirect(
      callSeatAction(
        await postAs(base.user.id, { intent: "confirm-redeem" }),
        seat.code
      ),
      "/courses/test-course/welcome"
    );
    expect(db.select().from(coupons).all()).toEqual([
      expect.objectContaining({
        id: seat.id,
        redeemedByUserId: base.user.id,
        redeemedAt: expect.any(String),
      }),
    ]);
    const savedEnrollments = db.select().from(enrollments).all();
    expect(savedEnrollments).toEqual([
      expect.objectContaining({
        userId: base.user.id,
        courseId: base.course.id,
      }),
    ]);
    expect(notifications.deliveries).toEqual([
      expect.objectContaining({
        kind: "seat-claimed",
        recipientIds: [base.instructor.id],
        actorId: base.user.id,
        data: expect.objectContaining({ destination: `/team#seat-${seat.id}` }),
      }),
    ]);

    expect(
      await callSeatAction(
        await postAs(base.user.id, { intent: "confirm-redeem" }),
        seat.code
      )
    ).toMatchObject({
      data: { error: "Coupon has already been redeemed" },
      init: { status: 400 },
    });
    expect(db.select().from(enrollments).all()).toEqual(savedEnrollments);
    expect(notifications.triggers).toHaveLength(1);
  });

  it("leaves the Seat Unclaimed when the Enrollment cannot be saved", async () => {
    const seat = unclaimedSeat();
    db.run(sql`
      CREATE TEMP TRIGGER reject_enrollment BEFORE INSERT ON enrollments
      BEGIN SELECT RAISE(ABORT, 'Enrollment storage unavailable'); END
    `);
    const request = await postAs(base.user.id, { intent: "confirm-redeem" });

    await expect(callSeatAction(request, seat.code)).rejects.toBeInstanceOf(
      Error
    );
    expect(db.select().from(coupons).all()).toEqual([seat]);
    expect(db.select().from(enrollments).all()).toEqual([]);
    expect(notifications.triggers).toEqual([]);
  });
});

describe("Individual Purchase action", () => {
  it("still grants the requested Seats for a Team Licence without enrolling its buyer", async () => {
    await expectRedirect(
      callPurchaseAction(
        await postAs(base.user.id, {
          intent: "confirm-team-purchase",
          quantity: "3",
        })
      ),
      "/team"
    );

    const purchase = db.select().from(purchases).get();
    expect(purchase).toMatchObject({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 16797,
      country: "PL",
    });
    if (!purchase) throw new Error("Team Licence was not saved");
    const seats = db.select().from(coupons).all();
    expect(seats).toHaveLength(3);
    for (const seat of seats) {
      expect(seat).toMatchObject({
        purchaseId: purchase.id,
        courseId: base.course.id,
        redeemedByUserId: null,
        redeemedAt: null,
      });
    }
    expect(db.select().from(teamMembers).all()).toEqual([
      expect.objectContaining({
        userId: base.user.id,
        role: TeamMemberRole.Admin,
      }),
    ]);
    expect(db.select().from(enrollments).all()).toEqual([]);
  });

  it("redirects to welcome only after saving the priced Purchase and Enrollment, and keeps repeat purchases on the course", async () => {
    await expectRedirect(
      callPurchaseAction(
        await postAs(base.user.id, { intent: "confirm-purchase" })
      ),
      "/courses/test-course/welcome"
    );
    const savedPurchases = db.select().from(purchases).all();
    const savedEnrollments = db.select().from(enrollments).all();
    expect(savedPurchases).toEqual([
      expect.objectContaining({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 5599,
        country: "PL",
      }),
    ]);
    expect(savedEnrollments).toEqual([
      expect.objectContaining({
        userId: base.user.id,
        courseId: base.course.id,
      }),
    ]);

    await expectRedirect(
      callPurchaseAction(
        await postAs(base.user.id, { intent: "confirm-purchase" })
      ),
      "/courses/test-course"
    );
    expect(db.select().from(purchases).all()).toEqual(savedPurchases);
    expect(db.select().from(enrollments).all()).toEqual(savedEnrollments);
  });

  it("leaves no Purchase when the Enrollment cannot be saved", async () => {
    db.run(sql`
      CREATE TEMP TRIGGER reject_enrollment BEFORE INSERT ON enrollments
      BEGIN SELECT RAISE(ABORT, 'Enrollment storage unavailable'); END
    `);
    const request = await postAs(base.user.id, { intent: "confirm-purchase" });

    await expect(callPurchaseAction(request)).rejects.toBeInstanceOf(Error);
    expect(db.select().from(purchases).all()).toEqual([]);
    expect(db.select().from(enrollments).all()).toEqual([]);
  });
});
