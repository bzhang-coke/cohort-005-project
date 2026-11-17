import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { createTestDb, seedBaseData } from "~/test/setup";
import { setCurrentUserId } from "~/lib/session";
import { createFakeNotificationTransport } from "~/lib/notifications/fake.server";
import { notificationTransportContext } from "~/lib/notifications/transport.server";
import { syncNotificationPerson } from "~/lib/notifications.server";
import { action as profileAction, loader as profileLoader } from "./settings";
import { action as signupAction } from "./signup";
import { getCurrentUserId } from "~/lib/session";
import { action as adminAction } from "./admin.users";
import { users, UserRole } from "~/db/schema";

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
});
afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
});

async function args(
  personId: number | null,
  fields: Record<string, string>,
  path = "/settings"
) {
  const url = new URL(`http://localhost${path}`);
  const cookie =
    personId === null ? "" : await setCurrentUserId(new Request(url), personId);
  const request = new Request(url, {
    method: "POST",
    headers: { Cookie: cookie },
    body: new URLSearchParams(fields),
  });
  const context = new RouterContextProvider();
  context.set(notificationTransportContext, transport);
  return { request, url, context, params: {}, pattern: path };
}

describe("Notification identity route lifecycle", () => {
  it("syncs a Profile name change without resetting existing Notification choices", async () => {
    await transport.setPreference(base.instructor.id, {
      category: "enrollments",
      channel: "feed",
      enabled: true,
    });
    expect(
      await profileAction(
        await args(base.instructor.id, { name: "New Name", bio: "New bio" })
      )
    ).toEqual({ success: true });
    expect(
      (await profileLoader(await args(base.instructor.id, {}))).user.name
    ).toBe("New Name");
    expect(transport.people.get(base.instructor.id)).toEqual({
      id: base.instructor.id,
      name: "New Name",
      email: "instructor@example.com",
      avatarUrl: null,
    });
    expect(
      (await transport.getPreferences(base.instructor.id))?.enrollments
        ?.channels.feed
    ).toBe(true);
  });

  it("establishes a new person's defaults at signup before completing their session", async () => {
    let response: unknown;
    try {
      await signupAction(
        await args(
          null,
          { name: "New Student", email: "new@example.com" },
          "/signup"
        )
      );
    } catch (error) {
      response = error;
    }
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response))
      throw new Error("Expected signup redirect.");
    const personId = await getCurrentUserId(
      new Request("http://localhost", {
        headers: { Cookie: response.headers.get("Set-Cookie") ?? "" },
      })
    );
    if (!personId) throw new Error("Expected signup session.");
    expect(transport.people.get(personId)).toEqual({
      id: personId,
      name: "New Student",
      email: "new@example.com",
      avatarUrl: null,
    });
    expect(
      (await transport.getPreferences(personId))?.enrollments?.channels.feed
    ).toBe(false);
  });

  it("syncs Platform Admin identity edits and preserves hidden choices through responsibility changes", async () => {
    const admin = db
      .insert(users)
      .values({
        name: "Platform Admin",
        email: "admin@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    await transport.setPreference(base.instructor.id, {
      category: "enrollments",
      channel: "feed",
      enabled: true,
    });
    expect(
      await adminAction(
        await args(
          admin.id,
          {
            intent: "update-user",
            userId: String(base.instructor.id),
            name: "Updated Name",
            email: "updated@example.com",
          },
          "/admin/users"
        )
      )
    ).toEqual({ success: true });
    expect(transport.people.get(base.instructor.id)).toEqual({
      id: base.instructor.id,
      name: "Updated Name",
      email: "updated@example.com",
      avatarUrl: null,
    });
    await adminAction(
      await args(
        admin.id,
        {
          intent: "update-role",
          userId: String(base.instructor.id),
          role: "student",
        },
        "/admin/users"
      )
    );
    await adminAction(
      await args(
        admin.id,
        {
          intent: "update-role",
          userId: String(base.instructor.id),
          role: "instructor",
        },
        "/admin/users"
      )
    );
    expect(
      (await transport.getPreferences(base.instructor.id))?.enrollments
        ?.channels.feed
    ).toBe(true);
    expect(transport.people.get(base.instructor.id)).not.toHaveProperty("role");
  });

  it("keeps completed Profile and Platform Admin edits when Notification sync fails", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => undefined);
    transport.failures.add("identify");
    expect(
      await profileAction(
        await args(base.instructor.id, {
          name: "Saved Despite Failure",
          bio: "Saved bio",
        })
      )
    ).toEqual({ success: true });
    expect(
      (await profileLoader(await args(base.instructor.id, {}))).user
    ).toMatchObject({ name: "Saved Despite Failure", bio: "Saved bio" });
    const admin = db
      .insert(users)
      .values({
        name: "Platform Admin",
        email: "admin@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    expect(
      await adminAction(
        await args(
          admin.id,
          {
            intent: "update-user",
            userId: String(base.instructor.id),
            name: "Admin Edit Saved",
            email: "saved@example.com",
          },
          "/admin/users"
        )
      )
    ).toEqual({ success: true });
    expect(
      (await profileLoader(await args(base.instructor.id, {}))).user
    ).toMatchObject({ name: "Admin Edit Saved", email: "saved@example.com" });
    expect(logs).toHaveBeenCalledWith(
      expect.stringContaining("Notification identity sync failed"),
      expect.any(Error)
    );
  });

  it("completes signup when preference initialization fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    transport.failures.add("initializePreferences");
    let response: unknown;
    try {
      await signupAction(
        await args(
          null,
          { name: "New Student", email: "new@example.com" },
          "/signup"
        )
      );
    } catch (error) {
      response = error;
    }
    if (!(response instanceof Response))
      throw new Error("Expected signup redirect.");
    expect(response.status).toBe(302);
    const personId = await getCurrentUserId(
      new Request("http://localhost", {
        headers: { Cookie: response.headers.get("Set-Cookie") ?? "" },
      })
    );
    if (!personId) throw new Error("Expected signup session.");
    expect((await profileLoader(await args(personId, {}))).user.name).toBe(
      "New Student"
    );
    expect(await transport.getPreferences(personId)).toBeNull();
  });
});
