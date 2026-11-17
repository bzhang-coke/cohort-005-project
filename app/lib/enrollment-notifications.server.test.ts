import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  courses,
  coupons,
  enrollments,
  purchases,
  users,
  UserRole,
  modules,
  lessons,
  lessonProgress,
  LessonProgressStatus,
  teams,
} from "~/db/schema";
import {
  claimSeat,
  createIndividualPurchase,
  submitIndividualPurchase,
  submitSeatClaim,
} from "./enrollments.server";
import { createFakeNotificationTransport } from "./notifications/fake.server";
import { syncNotificationPerson } from "./notifications.server";
import { raiseRefundRequest, approveRefundRequest } from "./refunds.server";

const NOW = new Date("2026-11-17T12:00:00.000Z");
let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let notifications: ReturnType<typeof createFakeNotificationTransport>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  notifications = createFakeNotificationTransport();
});

describe("independent Seat claim and Enrollment Notifications", () => {
  it.each([
    {
      enrollmentsEnabled: true,
      seatClaimsEnabled: true,
      kinds: ["seat-claimed", "enrollment-created"],
    },
    {
      enrollmentsEnabled: true,
      seatClaimsEnabled: false,
      kinds: ["enrollment-created"],
    },
    {
      enrollmentsEnabled: false,
      seatClaimsEnabled: true,
      kinds: ["seat-claimed"],
    },
    { enrollmentsEnabled: false, seatClaimsEnabled: false, kinds: [] },
  ])(
    "honors independent choices for the same Instructor and licence owner (Enrollments: $enrollmentsEnabled, Seat claims: $seatClaimsEnabled)",
    async ({ enrollmentsEnabled, seatClaimsEnabled, kinds }) => {
      await optIn();
      await notifications.setPreference(base.instructor.id, {
        category: "enrollments",
        channel: "feed",
        enabled: enrollmentsEnabled,
      });
      await notifications.setPreference(base.instructor.id, {
        category: "seatClaims",
        channel: "feed",
        enabled: seatClaimsEnabled,
      });
      const seat = unclaimedSeat();

      const result = await submitSeatClaim(
        db,
        seat.code,
        base.user.id,
        "PL",
        NOW,
        { notifications }
      );

      if (!result.ok) throw new Error(result.error);
      expect(notifications.deliveries.map((event) => event.kind)).toEqual(
        kinds
      );
      for (const event of notifications.deliveries)
        expect(event.recipientIds).toEqual([base.instructor.id]);
      expect(
        new Set(notifications.deliveries.map((event) => event.idempotencyKey))
          .size
      ).toBe(kinds.length);
    }
  );

  it.each(["seat-claimed", "enrollment-created"] as const)(
    "still attempts and delivers the other catalogue entry when %s delivery fails",
    async (failingKind) => {
      await optIn();
      const seat = unclaimedSeat();
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const trigger = notifications.trigger;
      notifications.trigger = async (event) => {
        if (event.kind === failingKind) {
          notifications.triggers.push(structuredClone(event));
          throw new Error("External notification delivery failed");
        }
        await trigger(event);
      };

      const result = await submitSeatClaim(
        db,
        seat.code,
        base.user.id,
        "PL",
        NOW,
        { notifications }
      );

      if (!result.ok) throw new Error(result.error);
      expect(notifications.triggers.map((event) => event.kind)).toEqual([
        "seat-claimed",
        "enrollment-created",
      ]);
      expect(notifications.deliveries.map((event) => event.kind)).toEqual([
        failingKind === "seat-claimed" ? "enrollment-created" : "seat-claimed",
      ]);
      expect(db.select().from(coupons).all()).toEqual([result.seat]);
      expect(db.select().from(enrollments).all()).toEqual([result.enrollment]);
      expect(log).toHaveBeenCalled();
    }
  );

  it("preserves both original event snapshots and Instructor selection while the first external delivery changes their context", async () => {
    await optIn();
    const replacementInstructor = db
      .insert(users)
      .values({
        name: "Next Instructor",
        email: "next@example.com",
        role: UserRole.Instructor,
      })
      .returning()
      .get();
    await syncNotificationPerson(replacementInstructor, notifications);
    await notifications.setPreference(replacementInstructor.id, {
      category: "enrollments",
      channel: "feed",
      enabled: true,
    });
    const seat = unclaimedSeat();
    const trigger = notifications.trigger;
    notifications.trigger = async (event) => {
      if (event.kind === "seat-claimed") {
        db.update(courses)
          .set({
            title: "New course title",
            instructorId: replacementInstructor.id,
          })
          .where(eq(courses.id, base.course.id))
          .run();
        db.update(users)
          .set({ name: "New Student name" })
          .where(eq(users.id, base.user.id))
          .run();
      }
      await trigger(event);
    };

    await submitSeatClaim(db, seat.code, base.user.id, "PL", NOW, {
      notifications,
    });

    expect(notifications.deliveries).toMatchObject([
      {
        kind: "seat-claimed",
        recipientIds: [base.instructor.id],
        data: {
          snapshot: {
            claimantName: "Test User",
            courseTitle: "Test Course",
            remainingSeats: 0,
          },
        },
      },
      {
        kind: "enrollment-created",
        recipientIds: [base.instructor.id],
        actorId: base.user.id,
        data: {
          title: "Test User enrolled in your course",
          context: "Test Course",
          snapshot: { studentName: "Test User", courseTitle: "Test Course" },
        },
      },
    ]);
  });
});

afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
});

async function optIn() {
  await syncNotificationPerson(base.instructor, notifications);
  await notifications.setPreference(base.instructor.id, {
    category: "enrollments",
    channel: "feed",
    enabled: true,
  });
}

function unclaimedSeat(ownerId = base.instructor.id) {
  const team = db.insert(teams).values({}).returning().get();
  const purchase = db
    .insert(purchases)
    .values({
      userId: ownerId,
      courseId: base.course.id,
      amountPaid: 7900,
      country: "PL",
    })
    .returning()
    .get();
  return db
    .insert(coupons)
    .values({
      teamId: team.id,
      purchaseId: purchase.id,
      courseId: base.course.id,
      code: `SEAT-${purchase.id}`,
    })
    .returning()
    .get();
}

const enrollmentPaths = ["Individual Purchase", "Seat claim"] as const;
function submitEnrollment(
  path: (typeof enrollmentPaths)[number],
  userId = base.user.id
) {
  return path === "Individual Purchase"
    ? submitIndividualPurchase(db, userId, base.course.id, "PL", NOW, {
        notifications,
      })
    : submitSeatClaim(db, unclaimedSeat().code, userId, "PL", NOW, {
        notifications,
      });
}

describe("Enrollment Notification delivery", () => {
  it.each([
    "unknown",
    "redeemed",
    "country mismatch",
    "already enrolled",
    "on hold",
    "refunded",
    "failed Enrollment",
  ])(
    "creates no catalogue event for a rejected Seat claim (%s), even when the Instructor opted in",
    async (rejection) => {
      await optIn();
      const seat = unclaimedSeat();
      if (rejection === "redeemed")
        expect(claimSeat(db, seat.code, base.user.id, "PL", NOW).ok).toBe(true);
      if (rejection === "already enrolled")
        expect(
          createIndividualPurchase(db, base.user.id, base.course.id, "PL", NOW)
            .ok
        ).toBe(true);
      if (rejection === "refunded")
        db.update(coupons)
          .set({ refundedAt: NOW.toISOString() })
          .where(eq(coupons.id, seat.id))
          .run();
      if (rejection === "on hold")
        expect(
          raiseRefundRequest(
            db,
            seat.purchaseId,
            base.instructor.id,
            "No longer needed.",
            NOW
          ).ok
        ).toBe(true);
      if (rejection === "failed Enrollment")
        db.run(sql`CREATE TEMP TRIGGER reject_enrollment BEFORE INSERT ON enrollments
        BEGIN SELECT RAISE(ABORT, 'Enrollment storage unavailable'); END`);
      const savedSeats = db.select().from(coupons).all();
      const savedEnrollments = db.select().from(enrollments).all();

      const submitted = submitSeatClaim(
        db,
        rejection === "unknown" ? "UNKNOWN" : seat.code,
        base.user.id,
        rejection === "country mismatch" ? "US" : "PL",
        NOW,
        { notifications }
      );
      if (rejection === "failed Enrollment")
        await expect(submitted).rejects.toThrow();
      else expect((await submitted).ok).toBe(false);

      expect(notifications.triggers).toEqual([]);
      expect(db.select().from(coupons).all()).toEqual(savedSeats);
      expect(db.select().from(enrollments).all()).toEqual(savedEnrollments);
    }
  );

  it("notifies the opted-in Instructor and the separate Team Licence owner after the complete claim commits", async () => {
    await optIn();
    const owner = db
      .insert(users)
      .values({
        name: "Licence owner",
        email: "owner@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();
    const seat = unclaimedSeat(owner.id);
    const trigger = notifications.trigger;
    notifications.trigger = async (event) => {
      expect(db.$client.inTransaction).toBe(false);
      expect(
        db.select().from(coupons).where(eq(coupons.id, seat.id)).get()
      ).toMatchObject({ redeemedByUserId: base.user.id });
      expect(db.select().from(enrollments).get()).toMatchObject({
        userId: base.user.id,
        courseId: base.course.id,
      });
      await trigger(event);
    };

    const result = await submitSeatClaim(
      db,
      seat.code,
      base.user.id,
      "PL",
      NOW,
      { notifications }
    );

    if (!result.ok) throw new Error(result.error);
    expect(notifications.deliveries).toMatchObject([
      { kind: "seat-claimed", recordId: seat.id, recipientIds: [owner.id] },
      {
        kind: "enrollment-created",
        recordId: result.enrollment.id,
        recipientIds: [base.instructor.id],
        actorId: base.user.id,
        idempotencyKey: `cadence:enrollment-created:${result.enrollment.id}`,
        data: {
          category: "enrollments",
          title: "Test User enrolled in your course",
          context: "Test Course",
          destination: `/instructor/${base.course.id}/students#student-${base.user.id}`,
          source: {
            enrollmentId: result.enrollment.id,
            courseId: base.course.id,
            purchaseId: seat.purchaseId,
            seatId: seat.id,
          },
          snapshot: { studentName: "Test User", courseTitle: "Test Course" },
        },
      },
    ]);
  });

  it("notifies the opted-in owning Instructor only after the Individual Purchase and Enrollment commit", async () => {
    await optIn();
    const trigger = notifications.trigger;
    notifications.trigger = async (event) => {
      expect(db.$client.inTransaction).toBe(false);
      expect(db.select().from(purchases).all()).toHaveLength(1);
      expect(db.select().from(enrollments).all()).toEqual([
        expect.objectContaining({ id: event.recordId, userId: base.user.id }),
      ]);
      await trigger(event);
    };

    const result = await submitIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      "PL",
      NOW,
      { notifications }
    );

    if (!result.ok) throw new Error(result.error);
    expect(notifications.deliveries).toEqual([
      {
        kind: "enrollment-created",
        recordId: result.enrollment.id,
        recipientIds: [base.instructor.id],
        actorId: base.user.id,
        idempotencyKey: `cadence:enrollment-created:${result.enrollment.id}`,
        data: {
          category: "enrollments",
          title: "Test User enrolled in your course",
          context: "Test Course",
          destination: `/instructor/${base.course.id}/students#student-${base.user.id}`,
          source: {
            enrollmentId: result.enrollment.id,
            courseId: base.course.id,
            purchaseId: result.purchase.id,
          },
          snapshot: { studentName: "Test User", courseTitle: "Test Course" },
        },
      },
    ]);
  });

  describe.each(enrollmentPaths)("%s preferences", (path) => {
    it.each([
      "default-off",
      "missing set",
      "missing category",
      "failed initialization",
      "failed read",
      "opted-out",
    ])("does not treat %s as an Enrollment opt-in", async (preference) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      if (preference === "failed initialization")
        notifications.failures.add("initializePreferences");
      if (preference !== "missing set")
        await syncNotificationPerson(base.instructor, notifications);
      if (preference === "missing category")
        notifications.preferences.set(base.instructor.id, {
          seatClaims: { channels: { feed: true } },
        });
      if (preference === "failed read" || preference === "opted-out")
        await optIn();
      if (preference === "failed read")
        notifications.failures.add("getPreferences");
      if (preference === "opted-out")
        await notifications.setPreference(base.instructor.id, {
          category: "enrollments",
          channel: "feed",
          enabled: false,
        });

      const result = await submitEnrollment(path);

      expect(result.ok).toBe(true);
      expect(
        notifications.triggers.filter(
          (event) => event.kind === "enrollment-created"
        )
      ).toEqual([]);
      expect(db.select().from(enrollments).all()).toHaveLength(1);
    });
  });

  it.each(enrollmentPaths)(
    "keeps the Instructor's own %s Enrollment valid without notifying them",
    async (path) => {
      await optIn();
      const result = await submitEnrollment(path, base.instructor.id);
      expect(result.ok).toBe(true);
      expect(notifications.triggers).toEqual([]);
    }
  );

  it("does not emit another event for a duplicate Individual Purchase", async () => {
    await optIn();
    const first = await submitIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      "PL",
      NOW,
      { notifications }
    );
    const duplicate = await submitIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      "PL",
      NOW,
      { notifications }
    );
    expect(first.ok).toBe(true);
    expect(duplicate).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
    expect(notifications.triggers).toHaveLength(1);
    expect(db.select().from(purchases).all()).toHaveLength(1);
  });

  it("does not emit or retain a Purchase when the Enrollment cannot commit", async () => {
    await optIn();
    db.run(sql`CREATE TEMP TRIGGER reject_enrollment BEFORE INSERT ON enrollments
      BEGIN SELECT RAISE(ABORT, 'Enrollment storage unavailable'); END`);

    await expect(
      submitIndividualPurchase(db, base.user.id, base.course.id, "PL", NOW, {
        notifications,
      })
    ).rejects.toThrow();

    expect(notifications.triggers).toEqual([]);
    expect(db.select().from(purchases).all()).toEqual([]);
    expect(db.select().from(enrollments).all()).toEqual([]);
  });

  it("keeps the complete Purchase successful when notification delivery fails", async () => {
    await optIn();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    notifications.failures.add("trigger");

    const result = await submitIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      "PL",
      NOW,
      { notifications }
    );

    if (!result.ok) throw new Error(result.error);
    expect(error).toHaveBeenCalled();
    expect(db.select().from(purchases).all()).toEqual([result.purchase]);
    expect(db.select().from(enrollments).all()).toEqual([result.enrollment]);
  });

  it("snapshots the original Student and course before any external preference read", async () => {
    await optIn();
    const getPreferences = notifications.getPreferences;
    notifications.getPreferences = async (personId) => {
      db.update(users)
        .set({ name: "Renamed Student" })
        .where(eq(users.id, base.user.id))
        .run();
      db.update(courses)
        .set({ title: "Renamed course" })
        .where(eq(courses.id, base.course.id))
        .run();
      return getPreferences(personId);
    };

    await submitIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      "PL",
      NOW,
      { notifications }
    );

    expect(notifications.deliveries[0]?.data).toMatchObject({
      title: "Test User enrolled in your course",
      context: "Test Course",
      snapshot: { studentName: "Test User", courseTitle: "Test Course" },
    });
  });

  it.each(enrollmentPaths)(
    "notifies for a genuinely new %s Enrollment after lapse without losing progress",
    async (path) => {
      await optIn();
      const original = await submitIndividualPurchase(
        db,
        base.user.id,
        base.course.id,
        "PL",
        NOW,
        { notifications }
      );
      if (!original.ok) throw new Error(original.error);
      const module = db
        .insert(modules)
        .values({ courseId: base.course.id, title: "Basics", position: 1 })
        .returning()
        .get();
      const lesson = db
        .insert(lessons)
        .values({ moduleId: module.id, title: "First lesson", position: 1 })
        .returning()
        .get();
      const progress = db
        .insert(lessonProgress)
        .values({
          userId: base.user.id,
          lessonId: lesson.id,
          status: LessonProgressStatus.InProgress,
        })
        .returning()
        .get();
      const admin = db
        .insert(users)
        .values({
          name: "Platform Admin",
          email: "admin@example.com",
          role: UserRole.Admin,
        })
        .returning()
        .get();
      const request = raiseRefundRequest(
        db,
        original.purchase.id,
        base.user.id,
        "Need to leave for now.",
        NOW
      );
      if (!request.ok) throw new Error(request.error);
      expect(
        approveRefundRequest(db, request.refundRequestId, admin.id, null, NOW)
          .ok
      ).toBe(true);
      expect(db.select().from(enrollments).all()).toEqual([]);

      const returned = await submitEnrollment(path);

      if (!returned.ok) throw new Error(returned.error);
      expect(returned.enrollment.id).not.toBe(original.enrollment.id);
      const enrollmentEvents = notifications.deliveries.filter(
        (event) => event.kind === "enrollment-created"
      );
      expect(enrollmentEvents.map((event) => event.idempotencyKey)).toEqual([
        `cadence:enrollment-created:${original.enrollment.id}`,
        `cadence:enrollment-created:${returned.enrollment.id}`,
      ]);
      expect(enrollmentEvents.map((event) => event.data.destination)).toEqual([
        `/instructor/${base.course.id}/students#student-${base.user.id}`,
        `/instructor/${base.course.id}/students#student-${base.user.id}`,
      ]);
      expect(db.select().from(lessonProgress).all()).toEqual([progress]);
    }
  );
});
