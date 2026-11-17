import { expect, it } from "vitest";
import { deliverNotification } from "./notifications.server";
import { createFakeNotificationTransport } from "./notifications/fake.server";
import type { NotificationEvent } from "./notifications";
const event: NotificationEvent = {
  kind: "refund-request-opened",
  recordId: 42,
  recipientIds: [1, 2, 2],
  actorId: 1,
  data: {
    category: "openRefundRequests",
    title: "Open Refund Request",
    context: "A request",
    destination: "/admin/refunds#refund-request-42",
    source: { refundRequestId: 42 },
    snapshot: {},
  },
};
it("excludes the actor and duplicates, with a distinct stable identity for each catalogue event", async () => {
  const transport = createFakeNotificationTransport();
  await deliverNotification(event, transport);
  await deliverNotification(
    {
      ...event,
      kind: "refund-request-confirmed",
      recipientIds: [1],
      data: {
        ...event.data,
        category: "refundRequestUpdates",
        destination: null,
      },
    },
    transport
  );
  expect(
    transport.triggers.map(({ recipientIds, idempotencyKey }) => ({
      recipientIds,
      idempotencyKey,
    }))
  ).toEqual([
    { recipientIds: [2], idempotencyKey: "cadence:refund-request-opened:42" },
    {
      recipientIds: [1],
      idempotencyKey: "cadence:refund-request-confirmed:42",
    },
  ]);
});
it("requires explicit confirmed Enrollment opt-in before triggering", async () => {
  const transport = createFakeNotificationTransport();
  const enrollment: NotificationEvent = {
    ...event,
    kind: "enrollment-created",
    recipientIds: [2],
    data: { ...event.data, category: "enrollments" },
  };
  await deliverNotification(enrollment, transport);
  expect(transport.triggers).toEqual([]);
  transport.preferences.set(2, { enrollments: { channels: { feed: true } } });
  await deliverNotification(enrollment, transport);
  expect(transport.deliveries).toHaveLength(1);
});
