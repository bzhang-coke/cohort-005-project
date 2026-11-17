import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "~/db/schema";
import { coupons, courses, enrollments, purchases, users } from "~/db/schema";
import { calculatePppPrice } from "~/lib/ppp";
import { getSeatAvailability } from "~/lib/refunds.server";
import type { NotificationEvent } from "~/lib/notifications";
import { deliverNotification } from "~/lib/notifications.server";
import type { NotificationTransport } from "~/lib/notifications/transport.server";

type Db = BetterSQLite3Database<typeof schema>;
type IndividualPurchaseResult =
  | {
      ok: true;
      purchase: typeof purchases.$inferSelect;
      enrollment: typeof enrollments.$inferSelect;
    }
  | { ok: false; error: string };

export function createIndividualPurchase(
  db: Db,
  userId: number,
  courseId: number,
  country: string | null,
  now: Date = new Date()
): IndividualPurchaseResult {
  return db.transaction((tx): IndividualPurchaseResult => {
    const existing = tx
      .select()
      .from(enrollments)
      .where(
        and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
      )
      .get();
    if (existing) {
      return { ok: false, error: "You are already enrolled in this course" };
    }

    const course = tx
      .select()
      .from(courses)
      .where(eq(courses.id, courseId))
      .get();
    if (!course) throw new Error("Course not found");

    const amountPaid = course.pppEnabled
      ? calculatePppPrice(course.price, country)
      : course.price;
    const purchase = tx
      .insert(purchases)
      .values({
        userId,
        courseId,
        amountPaid,
        country,
        createdAt: now.toISOString(),
      })
      .returning()
      .get();
    const enrollment = tx
      .insert(enrollments)
      .values({ userId, courseId, enrolledAt: now.toISOString() })
      .returning()
      .get();

    return { ok: true, purchase, enrollment };
  });
}

function enrollmentNotification(
  db: Db,
  enrollment: typeof enrollments.$inferSelect,
  origin: { purchaseId: number; seatId?: number }
): NotificationEvent | null {
  const course = db
    .select()
    .from(courses)
    .where(eq(courses.id, enrollment.courseId))
    .get();
  const student = db
    .select()
    .from(users)
    .where(eq(users.id, enrollment.userId))
    .get();
  if (!course || !student) return null;
  return {
    kind: "enrollment-created",
    recordId: enrollment.id,
    recipientIds: [course.instructorId],
    actorId: enrollment.userId,
    data: {
      category: "enrollments",
      title: `${student.name} enrolled in your course`,
      context: course.title,
      destination: `/instructor/${course.id}/students#student-${student.id}`,
      source: { enrollmentId: enrollment.id, courseId: course.id, ...origin },
      snapshot: { studentName: student.name, courseTitle: course.title },
    },
  };
}

export async function submitIndividualPurchase(
  db: Db,
  userId: number,
  courseId: number,
  country: string | null,
  now: Date = new Date(),
  dependencies: { notifications?: NotificationTransport } = {}
): Promise<IndividualPurchaseResult> {
  const result = createIndividualPurchase(db, userId, courseId, country, now);
  if (!result.ok) return result;
  try {
    const event = enrollmentNotification(db, result.enrollment, {
      purchaseId: result.purchase.id,
    });
    if (event) await deliverNotification(event, dependencies.notifications);
  } catch (error) {
    console.error(
      "Enrollment Notification failed after Purchase committed.",
      error
    );
  }
  return result;
}

type SeatClaimResult =
  | {
      ok: true;
      seat: typeof coupons.$inferSelect;
      enrollment: typeof enrollments.$inferSelect;
    }
  | { ok: false; error: string };

export const SEAT_ON_HOLD =
  "This seat can't be claimed right now. Ask the person who shared it with you.";
export const SEAT_REFUNDED =
  "This seat is no longer available. Ask the person who shared it with you.";

export function claimSeat(
  db: Db,
  code: string,
  userId: number,
  country: string | null,
  now: Date = new Date()
): SeatClaimResult {
  return db.transaction((tx): SeatClaimResult => {
    const seat = tx.select().from(coupons).where(eq(coupons.code, code)).get();
    if (!seat) return { ok: false, error: "Coupon not found" };
    if (seat.redeemedByUserId !== null) {
      return { ok: false, error: "Coupon has already been redeemed" };
    }

    const availability = getSeatAvailability(tx, seat);
    if (availability === "on_hold") {
      return { ok: false, error: SEAT_ON_HOLD };
    }
    if (availability === "refunded") {
      return { ok: false, error: SEAT_REFUNDED };
    }

    const existing = tx
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.userId, userId),
          eq(enrollments.courseId, seat.courseId)
        )
      )
      .get();
    if (existing) {
      return { ok: false, error: "You are already enrolled in this course" };
    }

    const purchase = tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, seat.purchaseId))
      .get();
    if (purchase?.country && purchase.country !== country) {
      return {
        ok: false,
        error:
          "This coupon can only be redeemed from the same country as the purchaser",
      };
    }

    const claimedSeat = tx
      .update(coupons)
      .set({ redeemedByUserId: userId, redeemedAt: now.toISOString() })
      .where(eq(coupons.id, seat.id))
      .returning()
      .get();
    const enrollment = tx
      .insert(enrollments)
      .values({
        userId,
        courseId: seat.courseId,
        enrolledAt: now.toISOString(),
      })
      .returning()
      .get();

    return { ok: true, seat: claimedSeat, enrollment };
  });
}
