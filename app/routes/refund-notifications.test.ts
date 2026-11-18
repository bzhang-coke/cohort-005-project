import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createElement, type ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import {
  createMemoryRouter,
  RouterContextProvider,
  RouterProvider,
} from "react-router";
import { createTestDb, seedBaseData } from "~/test/setup";
import { purchases, users, UserRole, RefundStatus } from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";
import { createFakeNotificationTransport } from "~/lib/notifications/fake.server";
import { notificationTransportContext } from "~/lib/notifications/transport.server";
import { mailTransportContext } from "~/lib/mailer.server";
import { action } from "./courses.$slug.refund";
import AdminRefunds, {
  action as decideAction,
  loader as reviewLoader,
} from "./admin.refunds";
import Settings, { loader as settingsLoader } from "./settings";
import {
  raiseRefundRequest,
  submitRefundRequest,
  submitRefundDecision,
} from "~/lib/refunds.server";
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
  vi.stubEnv("POSTMARK_SERVER_TOKEN", "");
});
afterEach(() => {
  db.$client.close();
  vi.unstubAllEnvs();
});

it.each(["signed-out", "buyer", "instructor", "demoted"] as const)(
  "keeps review and decision authorization for a %s person following a notification link",
  async (person) => {
    const formerAdmin = db
      .insert(users)
      .values({
        name: "Former Admin",
        email: "former@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    db.update(users)
      .set({ role: UserRole.Student })
      .where(eq(users.id, formerAdmin.id))
      .run();
    const personId =
      person === "signed-out"
        ? null
        : person === "buyer"
          ? base.user.id
          : person === "instructor"
            ? base.instructor.id
            : formerAdmin.id;
    const url = new URL(
      "http://localhost/admin/refunds?refundRequestId=1#refund-request-1"
    );
    const cookie =
      personId === null
        ? ""
        : await setCurrentUserId(new Request(url), personId);
    const context = new RouterContextProvider();
    const notifications = createFakeNotificationTransport();
    context.set(notificationTransportContext, notifications);
    context.set(mailTransportContext, {
      async send() {
        throw new Error("Unexpected email");
      },
    });
    const args = { url, params: {}, context, pattern: "/admin/refunds" };
    const failure = { init: { status: personId === null ? 401 : 403 } };
    await expect(
      reviewLoader({
        ...args,
        request: new Request(url, { headers: { Cookie: cookie } }),
      })
    ).rejects.toMatchObject(failure);
    await expect(
      decideAction({
        ...args,
        request: new Request(url, {
          method: "POST",
          headers: { Cookie: cookie },
          body: new URLSearchParams({
            intent: "approve",
            refundRequestId: "1",
            note: "Approved.",
          }),
        }),
      })
    ).rejects.toMatchObject(failure);
    expect(notifications.triggers).toEqual([]);
  }
);

it.each([
  ["", 400],
  ["no", 400],
  ["-1", 400],
  ["1.5", 400],
  ["9007199254740992", 400],
  ["999", 404],
] as const)(
  "rejects an invalid or missing target %s with %s",
  async (target, status) => {
    const admin = db
      .insert(users)
      .values({
        name: "Admin",
        email: "admin@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    const url = new URL(
      `http://localhost/admin/refunds?refundRequestId=${target}`
    );
    const cookie = await setCurrentUserId(new Request(url), admin.id);
    await expect(
      reviewLoader({
        request: new Request(url, { headers: { Cookie: cookie } }),
        url,
        params: {},
        context: new RouterContextProvider(),
        pattern: "/admin/refunds",
      })
    ).rejects.toMatchObject({ init: { status } });
  }
);

it.each(["approve", "decline"] as const)(
  "resolves the retained opening destination after another Platform Admin chooses %s",
  async (intent) => {
    const admin = db
      .insert(users)
      .values({
        name: "Admin",
        email: "admin@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    const decider = db
      .insert(users)
      .values({
        name: "Decider",
        email: "decider@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    const now = new Date();
    const bought = db
      .insert(purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: now.toISOString(),
      })
      .returning()
      .get();
    const notifications = createFakeNotificationTransport();
    const dependencies = { notifications, mail: { async send() {} } };
    const opened = await submitRefundRequest(
      db,
      bought.id,
      base.user.id,
      "Not what I needed.",
      now,
      dependencies
    );
    if (!opened.ok) throw new Error("Expected successful Refund Request.");
    const destination = notifications.deliveries.find(
      (event) => event.kind === "refund-request-opened"
    )?.data.destination;
    if (!destination) throw new Error("Expected an opening destination.");
    await submitRefundDecision(
      db,
      opened.refundRequestId,
      decider.id,
      intent,
      "Our decision.",
      now,
      dependencies
    );
    const url = new URL(destination, "http://localhost");
    const cookie = await setCurrentUserId(new Request(url), admin.id);
    const result = await reviewLoader({
      request: new Request(url, { headers: { Cookie: cookie } }),
      url,
      params: {},
      context: new RouterContextProvider(),
      pattern: "/admin/refunds",
    });
    expect(result.status).toBe(
      intent === "approve" ? RefundStatus.Approved : RefundStatus.Declined
    );
    expect(result.refundRequests.map((request) => request.id)).toEqual([
      opened.refundRequestId,
    ]);
    const router = createMemoryRouter(
      [
        {
          path: "/admin/refunds",
          element: createElement(AdminRefunds, {
            loaderData: result,
          } as ComponentProps<typeof AdminRefunds>),
        },
      ],
      { initialEntries: [destination] }
    );
    const html = renderToString(createElement(RouterProvider, { router }));
    expect(html).toContain(`id="refund-request-${opened.refundRequestId}"`);
    expect(html).toContain("Our decision.");
    router.dispose();
  }
);

it("renders the buyer's exact decision history anchor and does not expose another buyer's history", async () => {
  const now = new Date();
  const bought = db
    .insert(purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
  const opened = raiseRefundRequest(
    db,
    bought.id,
    base.user.id,
    "Not what I needed.",
    now
  );
  if (!opened.ok) throw new Error("Expected successful Refund Request.");
  const url = new URL(
    `http://localhost/settings#refund-request-${opened.refundRequestId}`
  );
  const cookie = await setCurrentUserId(new Request(url), base.user.id);
  const result = await settingsLoader({
    request: new Request(url, { headers: { Cookie: cookie } }),
    url,
    params: {},
    context: new RouterContextProvider(),
    pattern: "/settings",
  });
  const router = createMemoryRouter(
    [
      {
        path: "/settings",
        element: createElement(Settings, {
          loaderData: result,
        } as ComponentProps<typeof Settings>),
      },
    ],
    { initialEntries: [url.pathname + url.hash] }
  );
  expect(renderToString(createElement(RouterProvider, { router }))).toContain(
    `id="refund-request-${opened.refundRequestId}"`
  );
  router.dispose();
  const otherCookie = await setCurrentUserId(
    new Request(url),
    base.instructor.id
  );
  const otherResult = await settingsLoader({
    request: new Request(url, { headers: { Cookie: otherCookie } }),
    url,
    params: {},
    context: new RouterContextProvider(),
    pattern: "/settings",
  });
  expect(otherResult.refundRequests).toEqual([]);
});

it.each(["approve", "decline"] as const)(
  "sends the buyer's %s update and existing email through the real Platform Admin action",
  async (intent) => {
    const admin = db
      .insert(users)
      .values({
        name: "Admin",
        email: "admin@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    const now = new Date();
    const bought = db
      .insert(purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: now.toISOString(),
      })
      .returning()
      .get();
    const opened = raiseRefundRequest(
      db,
      bought.id,
      base.user.id,
      "Not what I needed.",
      now
    );
    if (!opened.ok) throw new Error("Expected successful Refund Request.");
    const notifications = createFakeNotificationTransport();
    const emails: string[] = [];
    const context = new RouterContextProvider();
    context.set(notificationTransportContext, notifications);
    context.set(mailTransportContext, {
      async send(email) {
        emails.push(email.to);
      },
    });
    const url = new URL("http://localhost/admin/refunds");
    const cookie = await setCurrentUserId(new Request(url), admin.id);
    const response = await decideAction({
      request: new Request(url, {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          intent,
          refundRequestId: String(opened.refundRequestId),
          note: "  Our decision.  ",
        }),
      }),
      url,
      params: {},
      context,
      pattern: "/admin/refunds",
    });
    expect(response).toMatchObject({ success: true });
    expect(notifications.deliveries).toMatchObject([
      {
        kind:
          intent === "approve"
            ? "refund-request-approved"
            : "refund-request-declined",
        recipientIds: [base.user.id],
        actorId: admin.id,
        data: { snapshot: { decisionNote: "Our decision." } },
      },
    ]);
    expect(emails).toEqual([base.user.email]);
  }
);
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
