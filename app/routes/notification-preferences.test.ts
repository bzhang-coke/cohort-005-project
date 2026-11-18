import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { createTestDb, seedBaseData } from "~/test/setup";
import { setCurrentUserId } from "~/lib/session";
import { createFakeNotificationTransport } from "~/lib/notifications/fake.server";
import { notificationTransportContext } from "~/lib/notifications/transport.server";
import { syncNotificationPerson } from "~/lib/notifications.server";
import { action, loader } from "./api.notification-preferences";
import { loader as profileLoader } from "./settings";
import {
  coupons,
  courses,
  purchases,
  teams,
  users,
  UserRole,
} from "~/db/schema";
import { eq } from "drizzle-orm";

vi.mock("~/db", () => ({
  get db() {
    return db;
  },
}));
let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let transport: ReturnType<typeof createFakeNotificationTransport>;
beforeEach(async () => {
  db = createTestDb();
  base = seedBaseData(db);
  transport = createFakeNotificationTransport();
  await syncNotificationPerson(base.instructor, transport);
  await syncNotificationPerson(base.user, transport);
});
afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function args(personId: number | null, body?: unknown) {
  const url = new URL("http://localhost/api/notification-preferences");
  const cookie =
    personId === null ? "" : await setCurrentUserId(new Request(url), personId);
  const request = new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const context = new RouterContextProvider();
  context.set(notificationTransportContext, transport);
  return {
    request,
    url,
    context,
    params: {},
    pattern: "/api/notification-preferences",
  };
}

describe("Notification preference action", () => {
  it("loads keyless development settings with the real default route context", async () => {
    for (const name of [
      "KNOCK_SECRET_API_KEY",
      "KNOCK_PUBLIC_API_KEY",
      "KNOCK_SIGNING_KEY",
      "KNOCK_FEED_CHANNEL_ID",
    ])
      vi.stubEnv(name, "");
    vi.stubEnv("NODE_ENV", "test");
    const requestArgs = await args(base.user.id);
    requestArgs.context = new RouterContextProvider();
    expect(await loader(requestArgs)).toMatchObject({
      personId: base.user.id,
      categories: ["discussionReplies"],
      status: "unavailable",
      preferences: null,
    });
  });

  it("persists an authenticated flip without changing another person's choice", async () => {
    const result = await action(
      await args(base.instructor.id, {
        category: "enrollments",
        channel: "feed",
        enabled: true,
      })
    );
    expect(result).toMatchObject({
      personId: base.instructor.id,
      status: "ready",
      preferences: { enrollments: { channels: { feed: true } } },
    });
    expect(
      (await transport.getPreferences(base.instructor.id))?.enrollments
        ?.channels.feed
    ).toBe(true);
    expect(
      (await transport.getPreferences(base.user.id))?.enrollments?.channels.feed
    ).toBe(false);
    expect(await loader(await args(base.instructor.id))).toMatchObject({
      preferences: { enrollments: { channels: { feed: true } } },
    });
  });

  it.each([null, 99999])(
    "rejects missing or nonexistent session person %s",
    async (personId) => {
      const request = await args(personId, {
        category: "discussionReplies",
        channel: "feed",
        enabled: false,
      });
      await expect(action(request)).rejects.toMatchObject({
        init: { status: personId === null ? 401 : 404 },
      });
      expect(
        (await transport.getPreferences(base.instructor.id))?.discussionReplies
          ?.channels.feed
      ).toBe(true);
    }
  );

  it.each([
    { personId: "other-person" },
    { userId: "other-person" },
    { category: "unknown" },
    { channel: "email" },
    { enabled: "false" },
    { name: "Overwrite Profile" },
  ])("rejects invalid or cross-person input %j", async (extra) => {
    const before = await transport.getPreferences(base.instructor.id);
    await expect(
      action(
        await args(base.instructor.id, {
          category: "discussionReplies",
          channel: "feed",
          enabled: false,
          ...extra,
        })
      )
    ).rejects.toMatchObject({ init: { status: 400 } });
    expect(await transport.getPreferences(base.instructor.id)).toEqual(before);
  });

  it.each([
    "refundRequestUpdates",
    "seatClaims",
    "enrollments",
    "discussionQuestions",
    "openRefundRequests",
    "discussionReplies",
  ] as const)(
    "lets a person with all responsibilities change %s",
    async (category) => {
      db.update(users)
        .set({ role: UserRole.Admin })
        .where(eq(users.id, base.instructor.id))
        .run();
      const team = db.insert(teams).values({}).returning().get();
      const purchase = db
        .insert(purchases)
        .values({
          userId: base.instructor.id,
          courseId: base.course.id,
          amountPaid: 1000,
        })
        .returning()
        .get();
      db.insert(coupons)
        .values({
          teamId: team.id,
          purchaseId: purchase.id,
          courseId: base.course.id,
          code: "SEAT",
        })
        .run();
      const enabled = category === "enrollments";
      await action(
        await args(base.instructor.id, { category, channel: "feed", enabled })
      );
      expect(
        (await transport.getPreferences(base.instructor.id))?.[category]
          ?.channels.feed
      ).toBe(enabled);
    }
  );

  it("preserves the external saved result and Profile fields across overlapping flips", async () => {
    transport.preferences.set(base.instructor.id, {
      ...(await transport.getPreferences(base.instructor.id)),
      discussionReplies: { channels: { feed: true, email: false } },
    });
    const profileBefore = await profileLoader(await args(base.instructor.id));
    const first = await args(base.instructor.id, {
      category: "enrollments",
      channel: "feed",
      enabled: true,
    });
    const second = await args(base.instructor.id, {
      category: "discussionReplies",
      channel: "feed",
      enabled: false,
    });
    await Promise.all([action(first), action(second)]);
    expect(await transport.getPreferences(base.instructor.id)).toMatchObject({
      enrollments: { channels: { feed: true } },
      discussionReplies: { channels: { feed: false, email: false } },
      discussionQuestions: { channels: { feed: true } },
    });
    expect(await profileLoader(await args(base.instructor.id))).toEqual(
      profileBefore
    );
  });

  it("throws a recoverable response after a failed save without losing the previous preference", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    transport.failures.add("setPreference");
    await expect(
      action(
        await args(base.instructor.id, {
          category: "enrollments",
          channel: "feed",
          enabled: true,
        })
      )
    ).rejects.toMatchObject({ init: { status: 503 } });
    expect(
      (await loader(await args(base.instructor.id))).preferences?.enrollments
        ?.channels.feed
    ).toBe(false);
  });

  it("does not turn a missing preference set into a confirmed default or an Enrollment opt-in", async () => {
    transport.preferences.delete(base.instructor.id);
    expect(await loader(await args(base.instructor.id))).toMatchObject({
      status: "uninitialized",
      preferences: null,
    });
    await expect(
      action(
        await args(base.instructor.id, {
          category: "enrollments",
          channel: "feed",
          enabled: true,
        })
      )
    ).rejects.toMatchObject({ init: { status: 503 } });
    expect(await transport.getPreferences(base.instructor.id)).toBeNull();
  });
});
