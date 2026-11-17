import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  comments,
  coupons,
  courseRatings,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  teams,
  users,
  UserRole,
  videoWatchEvents,
} from "~/db/schema";
import { claimSeat, createIndividualPurchase } from "./enrollments.server";
import {
  approveRefundRequest,
  declineRefundRequest,
  raiseRefundRequest,
} from "./refunds.server";

const NOW = new Date("2026-11-17T12:00:00.000Z");
let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let platformAdmin: typeof users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  platformAdmin = db
    .insert(users)
    .values({
      name: "Platform Admin",
      email: "admin@example.com",
      role: UserRole.Admin,
    })
    .returning()
    .get();
  db.update(courses)
    .set({ price: 7999, pppEnabled: true })
    .where(eq(courses.id, base.course.id))
    .run();
});

afterEach(() => {
  db.$client.close();
});

function unclaimedSeat(country: string | null = "PL") {
  const team = db.insert(teams).values({}).returning().get();
  const purchase = db
    .insert(purchases)
    .values({
      userId: base.instructor.id,
      courseId: base.course.id,
      amountPaid: 5599,
      country,
      createdAt: "2026-11-16T12:00:00.000Z",
    })
    .returning()
    .get();
  return db
    .insert(coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      purchaseId: purchase.id,
      code: `SEAT-${purchase.id}`,
    })
    .returning()
    .get();
}

describe("returning after an Enrollment lapses", () => {
  it.each(["Individual Purchase", "Seat claim"])(
    "grants a genuinely new Enrollment through %s and preserves existing progress",
    (path) => {
      const original = createIndividualPurchase(
        db,
        base.user.id,
        base.course.id,
        "PL",
        new Date("2026-11-16T12:00:00.000Z")
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
      const quiz = db
        .insert(quizzes)
        .values({
          lessonId: lesson.id,
          title: "Check understanding",
          passingScore: 80,
        })
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
      const watch = db
        .insert(videoWatchEvents)
        .values({
          userId: base.user.id,
          lessonId: lesson.id,
          eventType: "progress",
          positionSeconds: 45,
        })
        .returning()
        .get();
      const attempt = db
        .insert(quizAttempts)
        .values({
          userId: base.user.id,
          quizId: quiz.id,
          score: 100,
          passed: true,
        })
        .returning()
        .get();
      const comment = db
        .insert(comments)
        .values({
          userId: base.user.id,
          lessonId: lesson.id,
          body: "Useful example.",
        })
        .returning()
        .get();
      const rating = db
        .insert(courseRatings)
        .values({ userId: base.user.id, courseId: base.course.id, rating: 4 })
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
        approveRefundRequest(
          db,
          request.refundRequestId,
          platformAdmin.id,
          null,
          NOW
        ).ok
      ).toBe(true);
      expect(db.select().from(enrollments).all()).toEqual([]);

      const result =
        path === "Individual Purchase"
          ? createIndividualPurchase(
              db,
              base.user.id,
              base.course.id,
              "PL",
              NOW
            )
          : claimSeat(db, unclaimedSeat().code, base.user.id, "PL", NOW);

      if (!result.ok) throw new Error(result.error);
      expect(result.enrollment.id).not.toBe(original.enrollment.id);
      expect(result.enrollment.enrolledAt).toBe("2026-11-17T12:00:00.000Z");
      expect(db.select().from(enrollments).all()).toEqual([result.enrollment]);
      expect(db.select().from(lessonProgress).all()).toEqual([progress]);
      expect(db.select().from(videoWatchEvents).all()).toEqual([watch]);
      expect(db.select().from(quizAttempts).all()).toEqual([attempt]);
      expect(db.select().from(comments).all()).toEqual([comment]);
      expect(db.select().from(courseRatings).all()).toEqual([rating]);
    }
  );
});

describe("Seat claim Enrollment", () => {
  it.each(["US", null])(
    "allows a Seat from a Purchase with no recorded country (claimant country: %s)",
    (country) => {
      const seat = unclaimedSeat(null);

      const result = claimSeat(db, seat.code, base.user.id, country, NOW);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(db.select().from(enrollments).all()).toEqual([result.enrollment]);
    }
  );

  it("rejects an unknown Seat without creating an Enrollment", () => {
    expect(claimSeat(db, "UNKNOWN-SEAT", base.user.id, "PL", NOW)).toEqual({
      ok: false,
      error: "Coupon not found",
    });
    expect(db.select().from(coupons).all()).toEqual([]);
    expect(db.select().from(enrollments).all()).toEqual([]);
  });

  it("permanently rejects a Seat whose Team Licence was refunded, including repeat attempts", () => {
    const seat = unclaimedSeat();
    const request = raiseRefundRequest(
      db,
      seat.purchaseId,
      base.instructor.id,
      "No longer needed.",
      NOW
    );
    if (!request.ok) throw new Error(request.error);
    expect(
      approveRefundRequest(
        db,
        request.refundRequestId,
        platformAdmin.id,
        null,
        NOW
      ).ok
    ).toBe(true);

    for (const claimantId of [base.user.id, base.user.id, base.instructor.id]) {
      expect(claimSeat(db, seat.code, claimantId, "PL", NOW)).toEqual({
        ok: false,
        error:
          "This seat is no longer available. Ask the person who shared it with you.",
      });
    }
    expect(db.select().from(coupons).all()).toEqual([
      { ...seat, refundedAt: "2026-11-17T12:00:00.000Z" },
    ]);
    expect(db.select().from(enrollments).all()).toEqual([]);
  });

  it("freezes a Seat while its Refund Request is Open and allows a claim after decline", () => {
    const seat = unclaimedSeat();
    const request = raiseRefundRequest(
      db,
      seat.purchaseId,
      base.instructor.id,
      "No longer needed.",
      NOW
    );
    if (!request.ok) throw new Error(request.error);

    expect(claimSeat(db, seat.code, base.user.id, "PL", NOW)).toEqual({
      ok: false,
      error:
        "This seat can't be claimed right now. Ask the person who shared it with you.",
    });
    expect(db.select().from(coupons).all()).toEqual([seat]);
    expect(db.select().from(enrollments).all()).toEqual([]);

    expect(
      declineRefundRequest(
        db,
        request.refundRequestId,
        platformAdmin.id,
        "Please use the Seats.",
        NOW
      ).ok
    ).toBe(true);
    expect(claimSeat(db, seat.code, base.user.id, "PL", NOW).ok).toBe(true);
    expect(db.select().from(enrollments).all()).toHaveLength(1);
  });

  it.each(["US", null])(
    "rejects a country mismatch (%s) without claiming the Seat",
    (country) => {
      const seat = unclaimedSeat();

      expect(claimSeat(db, seat.code, base.user.id, country, NOW)).toEqual({
        ok: false,
        error:
          "This coupon can only be redeemed from the same country as the purchaser",
      });
      expect(db.select().from(coupons).all()).toEqual([seat]);
      expect(db.select().from(enrollments).all()).toEqual([]);
    }
  );

  it("leaves an Unclaimed Seat untouched when its Student already has an Enrollment", () => {
    const seat = unclaimedSeat();
    const existing = createIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      "PL",
      NOW
    );
    if (!existing.ok) throw new Error(existing.error);

    expect(claimSeat(db, seat.code, base.user.id, "PL", NOW)).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
    expect(db.select().from(coupons).all()).toEqual([seat]);
    expect(db.select().from(enrollments).all()).toEqual([existing.enrollment]);
  });

  it("keeps the first claimant when they retry or another Student claims the same Seat", () => {
    const seat = unclaimedSeat();
    const first = claimSeat(db, seat.code, base.user.id, "PL", NOW);
    if (!first.ok) throw new Error(first.error);

    for (const claimantId of [base.user.id, base.instructor.id]) {
      expect(claimSeat(db, seat.code, claimantId, "PL", NOW)).toEqual({
        ok: false,
        error: "Coupon has already been redeemed",
      });
    }
    expect(db.select().from(coupons).all()).toEqual([first.seat]);
    expect(db.select().from(enrollments).all()).toEqual([first.enrollment]);
  });

  it("rolls back the claim when SQLite rejects the Enrollment, allowing a later claim", () => {
    const seat = unclaimedSeat();
    db.run(sql`
      CREATE TEMP TRIGGER reject_enrollment BEFORE INSERT ON enrollments
      BEGIN SELECT RAISE(ABORT, 'Enrollment storage unavailable'); END
    `);

    expect(() => claimSeat(db, seat.code, base.user.id, "PL", NOW)).toThrow();

    expect(db.select().from(coupons).all()).toEqual([seat]);
    expect(db.select().from(enrollments).all()).toEqual([]);

    db.run(sql`DROP TRIGGER reject_enrollment`);
    expect(claimSeat(db, seat.code, base.user.id, "PL", NOW).ok).toBe(true);
    expect(db.select().from(enrollments).all()).toHaveLength(1);
  });

  it("returns the complete Claimed Seat and new Enrollment at the supplied time", () => {
    const seat = unclaimedSeat();

    const result = claimSeat(db, seat.code, base.user.id, "PL", NOW);

    expect(result).toMatchObject({
      ok: true,
      seat: {
        id: seat.id,
        redeemedByUserId: base.user.id,
        redeemedAt: "2026-11-17T12:00:00.000Z",
      },
      enrollment: {
        userId: base.user.id,
        courseId: base.course.id,
        enrolledAt: "2026-11-17T12:00:00.000Z",
        completedAt: null,
      },
    });
    if (!result.ok) throw new Error(result.error);
    expect(db.select().from(coupons).all()).toEqual([result.seat]);
    expect(db.select().from(enrollments).all()).toEqual([result.enrollment]);
  });
});

describe("Individual Purchase Enrollment", () => {
  it("does not charge a Student whose existing Enrollment came from a Claimed Seat", () => {
    const seat = unclaimedSeat();
    const existing = claimSeat(db, seat.code, base.user.id, "PL", NOW);
    if (!existing.ok) throw new Error(existing.error);
    const originalPurchases = db.select().from(purchases).all();

    expect(
      createIndividualPurchase(db, base.user.id, base.course.id, "PL", NOW)
    ).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
    expect(db.select().from(purchases).all()).toEqual(originalPurchases);
    expect(db.select().from(enrollments).all()).toEqual([existing.enrollment]);
  });

  it("rejects a missing course without creating a Purchase or Enrollment", () => {
    expect(() =>
      createIndividualPurchase(db, base.user.id, 999, "PL", NOW)
    ).toThrow("Course not found");
    expect(db.select().from(purchases).all()).toEqual([]);
    expect(db.select().from(enrollments).all()).toEqual([]);
  });

  it.each([
    { country: null, pppEnabled: true },
    { country: "US", pppEnabled: true },
    { country: "PL", pppEnabled: false },
  ])(
    "charges full price when the sale has no PPP discount ($country, PPP: $pppEnabled)",
    ({ country, pppEnabled }) => {
      db.update(courses)
        .set({ pppEnabled })
        .where(eq(courses.id, base.course.id))
        .run();

      const result = createIndividualPurchase(
        db,
        base.user.id,
        base.course.id,
        country,
        NOW
      );

      expect(result).toMatchObject({
        ok: true,
        purchase: { amountPaid: 7999, country },
      });
    }
  );

  it("rejects a repeat purchase without a second Purchase or Enrollment", () => {
    const first = createIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      "PL",
      NOW
    );
    if (!first.ok) throw new Error(first.error);

    expect(
      createIndividualPurchase(db, base.user.id, base.course.id, "US", NOW)
    ).toEqual({ ok: false, error: "You are already enrolled in this course" });
    expect(db.select().from(purchases).all()).toEqual([first.purchase]);
    expect(db.select().from(enrollments).all()).toEqual([first.enrollment]);
  });

  it("rolls back the Purchase when SQLite rejects the Enrollment", () => {
    db.run(sql`
      CREATE TEMP TRIGGER reject_enrollment BEFORE INSERT ON enrollments
      BEGIN SELECT RAISE(ABORT, 'Enrollment storage unavailable'); END
    `);

    expect(() =>
      createIndividualPurchase(db, base.user.id, base.course.id, "PL", NOW)
    ).toThrow();

    expect(db.select().from(purchases).all()).toEqual([]);
    expect(db.select().from(enrollments).all()).toEqual([]);
  });

  it("returns the complete Purchase and Enrollment with the sale's price, country and time", () => {
    const result = createIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      "PL",
      NOW
    );

    expect(result).toMatchObject({
      ok: true,
      purchase: {
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 5599,
        country: "PL",
        createdAt: "2026-11-17T12:00:00.000Z",
      },
      enrollment: {
        userId: base.user.id,
        courseId: base.course.id,
        enrolledAt: "2026-11-17T12:00:00.000Z",
        completedAt: null,
      },
    });
    if (!result.ok) throw new Error(result.error);
    expect(db.select().from(purchases).all()).toEqual([result.purchase]);
    expect(db.select().from(enrollments).all()).toEqual([result.enrollment]);
  });
});
