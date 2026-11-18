import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMemoryRouter,
  RouterContextProvider,
  RouterProvider,
} from "react-router";
import { createElement, type ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  coupons,
  courses,
  enrollments,
  purchases,
  teams,
  users,
  UserRole,
} from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";
import { createFakeNotificationTransport } from "~/lib/notifications/fake.server";
import { notificationTransportContext } from "~/lib/notifications/transport.server";
import { syncNotificationPerson } from "~/lib/notifications.server";
import { action as purchaseAction } from "./courses.$slug.purchase";
import { action as seatAction } from "./redeem.$code";
import { action as preferenceAction } from "./api.notification-preferences";
import InstructorStudentRoster, {
  loader as rosterLoader,
} from "./instructor.$courseId.students";
import { createNotificationFeedController } from "~/lib/notification-feed-client";
import { createFakeNotificationFeedClient } from "~/lib/notifications/fake.client";

vi.mock("~/db", () => ({
  get db() {
    return db;
  },
}));
let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let notifications: ReturnType<typeof createFakeNotificationTransport>;

beforeEach(async () => {
  db = createTestDb();
  base = seedBaseData(db);
  notifications = createFakeNotificationTransport();
  await syncNotificationPerson(base.instructor, notifications);
  await syncNotificationPerson(base.user, notifications);
});
afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
});

async function requestAs(
  personId: number | null,
  path: string,
  body?: URLSearchParams | string
) {
  const url = new URL(path, "http://localhost");
  const cookie =
    personId === null ? "" : await setCurrentUserId(new Request(url), personId);
  const context = new RouterContextProvider();
  context.set(notificationTransportContext, notifications);
  return {
    request: new Request(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookie,
        "CF-IPCountry": "PL",
        ...(typeof body === "string"
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body,
    }),
    url,
    context,
  };
}

async function setEnrollmentPreference(enabled: boolean) {
  return preferenceAction({
    ...(await requestAs(
      base.instructor.id,
      "/api/notification-preferences",
      JSON.stringify({ category: "enrollments", channel: "feed", enabled })
    )),
    params: {},
    pattern: "/api/notification-preferences",
  });
}

async function purchaseAs(personId: number, intent = "confirm-purchase") {
  return purchaseAction({
    ...(await requestAs(
      personId,
      `/courses/${base.course.slug}/purchase`,
      new URLSearchParams({ intent, quantity: "2" })
    )),
    params: { slug: base.course.slug },
    pattern: "/courses/:slug/purchase",
  });
}

async function expectRedirect(action: Promise<unknown>, destination: string) {
  await expect(action).rejects.toSatisfy(
    (response: unknown) =>
      response instanceof Response &&
      response.status === 302 &&
      response.headers.get("Location") === destination
  );
}

async function claimAs(personId: number, code: string) {
  return seatAction({
    ...(await requestAs(
      personId,
      `/redeem/${code}`,
      new URLSearchParams({ intent: "confirm-redeem" })
    )),
    params: { code },
    pattern: "/redeem/:code",
  });
}

it("delivers both events through the real Seat action and keeps Seat claims enabled after Enrollment opt-out", async () => {
  await setEnrollmentPreference(true);
  const team = db.insert(teams).values({}).returning().get();
  const purchase = db
    .insert(purchases)
    .values({
      userId: base.instructor.id,
      courseId: base.course.id,
      amountPaid: 15800,
      country: "PL",
    })
    .returning()
    .get();
  db.insert(coupons)
    .values(
      ["FIRST-SEAT", "SECOND-SEAT"].map((code) => ({
        teamId: team.id,
        purchaseId: purchase.id,
        courseId: base.course.id,
        code,
      }))
    )
    .run();

  await expectRedirect(
    claimAs(base.user.id, "FIRST-SEAT"),
    "/courses/test-course/welcome"
  );

  expect(notifications.deliveries).toMatchObject([
    { kind: "seat-claimed", recipientIds: [base.instructor.id] },
    {
      kind: "enrollment-created",
      recipientIds: [base.instructor.id],
      data: {
        destination: `/instructor/${base.course.id}/students#student-${base.user.id}`,
      },
    },
  ]);
  expect(await claimAs(base.user.id, "FIRST-SEAT")).toMatchObject({
    init: { status: 400 },
  });
  expect(notifications.triggers).toHaveLength(2);

  await setEnrollmentPreference(false);
  const nextStudent = db
    .insert(users)
    .values({
      name: "Next Student",
      email: "next@example.com",
      role: UserRole.Student,
    })
    .returning()
    .get();
  await expectRedirect(
    claimAs(nextStudent.id, "SECOND-SEAT"),
    "/courses/test-course/welcome"
  );
  expect(notifications.deliveries.map((event) => event.kind)).toEqual([
    "seat-claimed",
    "enrollment-created",
    "seat-claimed",
  ]);
  expect(db.select().from(enrollments).all()).toHaveLength(2);
});

it("delivers an Individual Purchase Enrollment through the real action after the Instructor opts in through Settings", async () => {
  await setEnrollmentPreference(true);

  await expectRedirect(
    purchaseAs(base.user.id),
    "/courses/test-course/welcome"
  );

  expect(notifications.deliveries).toEqual([
    expect.objectContaining({
      kind: "enrollment-created",
      recipientIds: [base.instructor.id],
      actorId: base.user.id,
      data: expect.objectContaining({
        destination: `/instructor/${base.course.id}/students#student-${base.user.id}`,
      }),
    }),
  ]);
});

it("opens the exact Student row in the authenticated Instructor roster", async () => {
  await setEnrollmentPreference(true);
  await expectRedirect(
    purchaseAs(base.user.id),
    "/courses/test-course/welcome"
  );
  const destination = notifications.deliveries[0]?.data.destination;
  if (!destination) throw new Error("Missing Enrollment destination");
  const loaderData = await rosterLoader({
    ...(await requestAs(base.instructor.id, destination)),
    params: { courseId: String(base.course.id) },
    pattern: "/instructor/:courseId/students",
  });
  const router = createMemoryRouter(
    [
      {
        path: "/instructor/:courseId/students",
        element: createElement(InstructorStudentRoster, {
          loaderData,
        } as ComponentProps<typeof InstructorStudentRoster>),
      },
    ],
    { initialEntries: [destination] }
  );
  const html = renderToString(createElement(RouterProvider, { router }));
  expect(html).toContain(`<tr id="student-${base.user.id}"`);
  expect(html).toContain("Test User");
  router.dispose();
});

it("keeps Enrollment off by default and suppresses future enrollments after Settings opt-out", async () => {
  await expectRedirect(
    purchaseAs(base.user.id),
    "/courses/test-course/welcome"
  );
  expect(notifications.triggers).toEqual([]);

  await setEnrollmentPreference(true);
  const optedInStudent = db
    .insert(users)
    .values({
      name: "Opted-in Student",
      email: "opted-in@example.com",
      role: UserRole.Student,
    })
    .returning()
    .get();
  await expectRedirect(
    purchaseAs(optedInStudent.id),
    "/courses/test-course/welcome"
  );
  expect(notifications.deliveries).toHaveLength(1);

  await setEnrollmentPreference(false);
  const optedOutStudent = db
    .insert(users)
    .values({
      name: "Opted-out Student",
      email: "opted-out@example.com",
      role: UserRole.Student,
    })
    .returning()
    .get();
  await expectRedirect(
    purchaseAs(optedOutStudent.id),
    "/courses/test-course/welcome"
  );
  expect(notifications.deliveries).toHaveLength(1);
  expect(db.select().from(enrollments).all()).toHaveLength(3);
});

it("creates no Enrollment Notification for a Team Licence-only purchase even with opt-in", async () => {
  await setEnrollmentPreference(true);
  await expectRedirect(
    purchaseAs(base.user.id, "confirm-team-purchase"),
    "/team"
  );
  expect(db.select().from(enrollments).all()).toEqual([]);
  expect(notifications.triggers).toEqual([]);
});

it.each(["signed-out", "student", "other instructor", "former instructor"])(
  "preserves roster authorization for a %s following an Enrollment destination",
  async (viewer) => {
    await setEnrollmentPreference(true);
    await expectRedirect(
      purchaseAs(base.user.id),
      "/courses/test-course/welcome"
    );
    const otherInstructor = db
      .insert(users)
      .values({
        name: "Other Instructor",
        email: "other@example.com",
        role: UserRole.Instructor,
      })
      .returning()
      .get();
    if (viewer === "former instructor")
      db.update(courses)
        .set({ instructorId: otherInstructor.id })
        .where(eq(courses.id, base.course.id))
        .run();
    const personId =
      viewer === "signed-out"
        ? null
        : viewer === "student"
          ? base.user.id
          : viewer === "other instructor"
            ? otherInstructor.id
            : base.instructor.id;
    const destination = notifications.deliveries[0]?.data.destination;
    if (!destination) throw new Error("Missing Enrollment destination");
    await expect(
      rosterLoader({
        ...(await requestAs(personId, destination)),
        params: { courseId: String(base.course.id) },
        pattern: "/instructor/:courseId/students",
      })
    ).rejects.toMatchObject({
      init: { status: viewer === "signed-out" ? 401 : 403 },
    });
  }
);

it.each(["row", "checkmark"])(
  "shows synced Student context and honors the %s action at the shared feed seam",
  async (control) => {
    await setEnrollmentPreference(true);
    await syncNotificationPerson(
      { ...base.user, avatarUrl: "https://example.com/student.png" },
      notifications
    );
    await expectRedirect(
      purchaseAs(base.user.id),
      "/courses/test-course/welcome"
    );
    const event = notifications.deliveries[0];
    const actor = notifications.people.get(base.user.id);
    if (!event || !actor)
      throw new Error("Missing Enrollment event or synced actor");
    const client = createFakeNotificationFeedClient([
      {
        id: event.idempotencyKey,
        category: event.data.category,
        title: event.data.title,
        context: event.data.context,
        destination: event.data.destination,
        actor,
        createdAt: "2026-11-17T12:00:00.000Z",
        read: false,
        seen: false,
      },
    ]);
    const feed = createNotificationFeedController({
      credentials: async () => ({
        mode: "live",
        personId: base.instructor.id,
        publicApiKey: "public",
        feedChannelId: "feed",
        userToken: "signed",
        expiresAt: 9999999999999,
      }),
      connect: () => client,
    });
    await feed.setPerson(base.instructor.id);
    await feed.setOpen(true);
    expect(feed.getSnapshot().items[0]).toMatchObject({
      category: "enrollments",
      title: "Test User enrolled in your course",
      context: "Test Course",
      actor: {
        name: "Test User",
        avatarUrl: "https://example.com/student.png",
      },
    });
    if (control === "checkmark") {
      // The checkmark operation returns a status only and keeps the feed open.
      expect(await feed.markRead(event.idempotencyKey)).toBe(true);
      expect(feed.getSnapshot()).toMatchObject({ open: true, unread: 0 });
    } else {
      client.failures.add("read");
      expect(await feed.activate(event.idempotencyKey)).toBeNull();
      expect(feed.getSnapshot()).toMatchObject({ open: true, unread: 1 });
      client.failures.delete("read");
      expect(await feed.activate(event.idempotencyKey)).toBe(
        `/instructor/${base.course.id}/students#student-${base.user.id}`
      );
    }
    expect(feed.getSnapshot().items[0]?.read).toBe(true);
    feed.dispose();
  }
);
