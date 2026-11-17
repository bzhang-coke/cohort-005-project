import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { createTestDb, seedBaseData } from "~/test/setup";
import { purchases } from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";
import { createFakeNotificationTransport } from "~/lib/notifications/fake.server";
import { notificationTransportContext } from "~/lib/notifications/transport.server";
import { mailTransportContext } from "~/lib/mailer.server";
import { action } from "./courses.$slug.refund";
vi.mock("~/db", () => ({
  get db() {
    return db;
  },
}));
let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});
afterEach(() => db.$client.close());
it("uses the shared submission service through the real authenticated Refund Request action", async () => {
  const bought = db
    .insert(purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
  const notifications = createFakeNotificationTransport();
  const emails: string[] = [];
  const context = new RouterContextProvider();
  context.set(notificationTransportContext, notifications);
  context.set(mailTransportContext, {
    async send(email) {
      emails.push(email.to);
    },
  });
  const url = new URL(`http://localhost/courses/${base.course.slug}/refund`);
  const cookie = await setCurrentUserId(new Request(url), base.user.id);
  const response = await action({
    request: new Request(url, {
      method: "POST",
      headers: { Cookie: cookie },
      body: new URLSearchParams({
        purchaseId: String(bought.id),
        reason: "Not what I needed.",
      }),
    }),
    url,
    params: { slug: base.course.slug },
    context,
    pattern: "/courses/:slug/refund",
  });
  expect(response).toBeInstanceOf(Response);
  if (!(response instanceof Response)) throw new Error("Expected redirect.");
  expect(response.headers.get("Location")).toBe("/settings");
  expect(notifications.deliveries[0]?.recipientIds).toEqual([base.user.id]);
  expect(emails).toEqual([base.user.email]);
});
