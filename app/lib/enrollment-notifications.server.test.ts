import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  courses,
  enrollments,
  purchases,
  users,
  UserRole,
  modules,
  lessons,
  lessonProgress,
  LessonProgressStatus,
} from "~/db/schema";
import { submitIndividualPurchase } from "./enrollments.server";
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

describe("Enrollment Notification delivery", () => {
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

    const result = await submitIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      "PL",
      NOW,
      { notifications }
    );

    expect(result.ok).toBe(true);
    expect(notifications.triggers).toEqual([]);
    expect(db.select().from(enrollments).all()).toHaveLength(1);
  });

  it("keeps the Instructor's own Enrollment valid without notifying them", async () => {
    await optIn();
    const result = await submitIndividualPurchase(
      db,
      base.instructor.id,
      base.course.id,
      "PL",
      NOW,
      { notifications }
    );
    expect(result.ok).toBe(true);
    expect(notifications.triggers).toEqual([]);
  });

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

  it("notifies for a genuinely new Individual Purchase Enrollment after lapse without losing progress", async () => {
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
      approveRefundRequest(db, request.refundRequestId, admin.id, null, NOW).ok
    ).toBe(true);
    expect(db.select().from(enrollments).all()).toEqual([]);

    const returned = await submitIndividualPurchase(
      db,
      base.user.id,
      base.course.id,
      "PL",
      NOW,
      { notifications }
    );

    if (!returned.ok) throw new Error(returned.error);
    expect(returned.enrollment.id).not.toBe(original.enrollment.id);
    expect(
      notifications.deliveries.map((event) => event.idempotencyKey)
    ).toEqual([
      `cadence:enrollment-created:${original.enrollment.id}`,
      `cadence:enrollment-created:${returned.enrollment.id}`,
    ]);
    expect(
      notifications.deliveries.map((event) => event.data.destination)
    ).toEqual([
      `/instructor/${base.course.id}/students#student-${base.user.id}`,
      `/instructor/${base.course.id}/students#student-${base.user.id}`,
    ]);
    expect(db.select().from(lessonProgress).all()).toEqual([progress]);
  });
});
