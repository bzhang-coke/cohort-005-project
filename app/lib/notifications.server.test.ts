import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import { coupons, purchases, teams, users, UserRole } from "~/db/schema";
import { eq } from "drizzle-orm";
import { createFakeNotificationTransport } from "./notifications/fake.server";
import {
  backfillNotificationPeople,
  getNotificationSettings,
  syncNotificationPerson,
} from "./notifications.server";

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});
afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
});

describe("Notification identity lifecycle", () => {
  it("identifies a person and establishes six feed defaults without their role", async () => {
    const transport = createFakeNotificationTransport();
    const { instructor } = base;

    expect(await syncNotificationPerson(instructor, transport)).toBe("ready");
    expect(transport.people.get(instructor.id)).toEqual({
      id: instructor.id,
      name: "Test Instructor",
      email: "instructor@example.com",
      avatarUrl: null,
    });
    expect(await transport.getPreferences(instructor.id)).toEqual({
      refundRequestUpdates: { channels: { feed: true } },
      openRefundRequests: { channels: { feed: true } },
      seatClaims: { channels: { feed: true } },
      enrollments: { channels: { feed: false } },
      discussionQuestions: { channels: { feed: true } },
      discussionReplies: { channels: { feed: true } },
    });
  });

  it("repeats backfill without resetting opt-ins, opt-outs or future-channel choices", async () => {
    const transport = createFakeNotificationTransport();
    await backfillNotificationPeople(db, transport);
    await transport.setPreference(base.instructor.id, {
      category: "enrollments",
      channel: "feed",
      enabled: true,
    });
    await transport.setPreference(base.instructor.id, {
      category: "discussionQuestions",
      channel: "feed",
      enabled: false,
    });
    transport.preferences.set(base.instructor.id, {
      ...(await transport.getPreferences(base.instructor.id)),
      discussionReplies: { channels: { feed: true, email: false } },
    });
    db.update(users)
      .set({
        name: "Renamed Instructor",
        email: "renamed@example.com",
        avatarUrl: "https://example.com/avatar.png",
      })
      .where(eq(users.id, base.instructor.id))
      .run();

    expect(await backfillNotificationPeople(db, transport)).toEqual({
      ready: 2,
      failed: 0,
      disabled: 0,
    });
    expect(await transport.getPreferences(base.instructor.id)).toMatchObject({
      enrollments: { channels: { feed: true } },
      discussionQuestions: { channels: { feed: false } },
      discussionReplies: { channels: { feed: true, email: false } },
    });
    expect(transport.people.get(base.instructor.id)).toEqual({
      id: base.instructor.id,
      name: "Renamed Instructor",
      email: "renamed@example.com",
      avatarUrl: "https://example.com/avatar.png",
    });
  });

  it("keeps failed initialization distinguishable from confirmed defaults and retries on the next sync", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const transport = createFakeNotificationTransport();
    transport.failures.add("initializePreferences");
    expect(await syncNotificationPerson(base.instructor, transport)).toBe(
      "failed"
    );
    expect(
      await getNotificationSettings(db, base.instructor, transport)
    ).toMatchObject({ status: "uninitialized", preferences: null });
    transport.failures.clear();
    expect(await syncNotificationPerson(base.instructor, transport)).toBe(
      "ready"
    );
    expect(
      (await transport.getPreferences(base.instructor.id))?.enrollments
        ?.channels.feed
    ).toBe(false);
  });
});

describe("Notification preferences", () => {
  it("retains a hidden Enrollment preference through demotion and promotion", async () => {
    const transport = createFakeNotificationTransport();
    await syncNotificationPerson(base.user, transport);
    await transport.setPreference(base.user.id, {
      category: "enrollments",
      channel: "feed",
      enabled: true,
    });
    expect(
      (await getNotificationSettings(db, base.user, transport)).categories
    ).not.toContain("enrollments");
    const promoted = db
      .update(users)
      .set({ role: UserRole.Instructor })
      .where(eq(users.id, base.user.id))
      .returning()
      .get();
    if (!promoted) throw new Error("Person fixture is missing.");
    await syncNotificationPerson(promoted, transport);
    expect(
      await getNotificationSettings(db, promoted, transport)
    ).toMatchObject({
      categories: ["enrollments", "discussionQuestions", "discussionReplies"],
      preferences: { enrollments: { channels: { feed: true } } },
    });
  });

  it.each([
    [UserRole.Student, "none", ["discussionReplies"]],
    [
      UserRole.Student,
      "purchase",
      ["refundRequestUpdates", "discussionReplies"],
    ],
    [
      UserRole.Student,
      "licence",
      ["refundRequestUpdates", "seatClaims", "discussionReplies"],
    ],
    [
      UserRole.Instructor,
      "none",
      ["enrollments", "discussionQuestions", "discussionReplies"],
    ],
    [
      UserRole.Instructor,
      "licence",
      [
        "refundRequestUpdates",
        "seatClaims",
        "enrollments",
        "discussionQuestions",
        "discussionReplies",
      ],
    ],
    [UserRole.Admin, "none", ["openRefundRequests", "discussionReplies"]],
    [
      UserRole.Admin,
      "purchase",
      ["refundRequestUpdates", "openRefundRequests", "discussionReplies"],
    ],
    [
      UserRole.Admin,
      "licence",
      [
        "refundRequestUpdates",
        "seatClaims",
        "openRefundRequests",
        "discussionReplies",
      ],
    ],
  ] as const)(
    "shows categories for a %s with %s holdings",
    async (role, holding, expected) => {
      const person = db
        .update(users)
        .set({ role })
        .where(eq(users.id, base.user.id))
        .returning()
        .get();
      if (!person) throw new Error("Person fixture is missing.");
      if (holding !== "none") {
        const purchase = db
          .insert(purchases)
          .values({
            userId: person.id,
            courseId: base.course.id,
            amountPaid: 5000,
          })
          .returning()
          .get();
        if (holding === "licence") {
          const team = db.insert(teams).values({}).returning().get();
          db.insert(coupons)
            .values({
              purchaseId: purchase.id,
              teamId: team.id,
              courseId: base.course.id,
              code: "SEAT",
            })
            .run();
        }
      }
      const transport = createFakeNotificationTransport();
      await syncNotificationPerson(person, transport);
      const settings = await getNotificationSettings(db, person, transport);
      expect(settings.categories).toEqual(expected);
    }
  );
});
