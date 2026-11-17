import { describe, expect, it } from "vitest";
import {
  createNotificationFeedController,
  notificationBadge,
} from "./notification-feed-client";
import { createFakeNotificationFeedClient } from "./notifications/fake.client";

const row = {
  id: "confirmation",
  category: "refundRequestUpdates" as const,
  title: "Refund Request received",
  context: "TypeScript · $79.00 · Your request is under review.",
  destination: null,
  actor: null,
  createdAt: "2026-11-17T12:00:00Z",
  read: false,
  seen: false,
};

describe("Cadence Notification Feed", () => {
  it("counts unseen history, marks the whole channel seen on open, and keeps confirmations unread until activated", async () => {
    const client = createFakeNotificationFeedClient([row], {
      unseen: 12,
      unread: 12,
      total: 12,
    });
    const feed = createNotificationFeedController({
      credentials: async () => ({
        mode: "live",
        personId: 7,
        publicApiKey: "public",
        feedChannelId: "feed",
        userToken: "signed",
        expiresAt: Date.now() + 3600000,
      }),
      connect: () => client,
    });
    await feed.setPerson(7);
    expect(notificationBadge(feed.getSnapshot().unseen)).toBe("9+");
    await feed.setOpen(true);
    expect(client.seenScope).toBe("channel");
    expect(feed.getSnapshot()).toMatchObject({
      unseen: 0,
      unread: 12,
      open: true,
    });
    expect(feed.getSnapshot().items[0]?.read).toBe(false);
    expect(await feed.activate("confirmation")).toBeNull();
    expect(feed.getSnapshot()).toMatchObject({ open: true, unread: 11 });
    expect(feed.getSnapshot().items[0]?.read).toBe(true);
    feed.dispose();
  });
});

it("disposes old subscriptions and ignores old-person list responses and live events after switching", async () => {
  let resolveOld:
    ((value: Awaited<ReturnType<typeof first.list>>) => void) | undefined;
  const first = createFakeNotificationFeedClient([row]);
  let lateEvent:
    | ((
        event: import("./notification-feed-client").NotificationFeedEvent
      ) => void)
    | undefined;
  const subscribe = first.subscribe;
  first.subscribe = (listener) => {
    lateEvent = listener;
    return subscribe(listener);
  };
  const oldPage = await first.list();
  first.list = () =>
    new Promise((resolve) => {
      resolveOld = resolve;
    });
  const second = createFakeNotificationFeedClient([]);
  let personId = 1;
  const feed = createNotificationFeedController({
    credentials: async () => ({
      mode: "live",
      personId,
      publicApiKey: "public",
      feedChannelId: "feed",
      userToken: "signed",
      expiresAt: Date.now() + 3600000,
    }),
    connect: (identity) => (identity.personId === 1 ? first : second),
  });
  const loading = feed.setPerson(1);
  await Promise.resolve();
  await Promise.resolve();
  personId = 2;
  await feed.setPerson(2);
  expect(first.disposed).toBe(true);
  resolveOld?.(oldPage);
  await loading;
  first.receive(oldPage);
  lateEvent?.({ type: "error", message: "Old identity socket failed." });
  expect(feed.getSnapshot()).toMatchObject({
    personId: 2,
    items: [],
    unseen: 0,
    status: "ready",
  });
  feed.dispose();
});

it("updates live while closed and open, and keeps read state distinct from seen", async () => {
  const client = createFakeNotificationFeedClient();
  const feed = createNotificationFeedController({
    credentials: async () => ({
      mode: "live",
      personId: 7,
      publicApiKey: "public",
      feedChannelId: "feed",
      userToken: "signed",
      expiresAt: 9999999999999,
    }),
    connect: () => client,
  });
  await feed.setPerson(7);
  client.receive({
    items: [row],
    unseen: 1,
    unread: 1,
    total: 1,
    nextCursor: null,
  });
  await feed.refresh();
  expect(feed.getSnapshot()).toMatchObject({
    unseen: 1,
    open: false,
    items: [row],
  });
  await feed.setOpen(true);
  client.receive({
    items: [
      { ...row, id: "newer" },
      { ...row, seen: true },
    ],
    unseen: 1,
    unread: 2,
    total: 2,
    nextCursor: null,
  });
  await feed.refresh();
  await feed.setOpen(true);
  expect(feed.getSnapshot()).toMatchObject({
    unseen: 0,
    unread: 2,
    open: true,
  });
  feed.dispose();
});

it("reports list and status errors without claiming an empty feed or losing confirmed unread state", async () => {
  const client = createFakeNotificationFeedClient([row]);
  client.failures.add("list");
  const feed = createNotificationFeedController({
    credentials: async () => ({
      mode: "live",
      personId: 7,
      publicApiKey: "public",
      feedChannelId: "feed",
      userToken: "signed",
      expiresAt: 9999999999999,
    }),
    connect: () => client,
  });
  await feed.setPerson(7);
  expect(feed.getSnapshot().status).toBe("error");
  client.failures.delete("list");
  await feed.refresh();
  client.failures.add("read");
  client.failures.add("seen");
  await feed.setOpen(true);
  expect(feed.getSnapshot()).toMatchObject({ unseen: 1, unread: 1 });
  expect(feed.getSnapshot().statusError).toContain("seen");
  await feed.activate(row.id);
  expect(feed.getSnapshot().statusError).toContain("read");
  expect(feed.getSnapshot().items[0]?.read).toBe(false);
  feed.dispose();
});

it("uses an empty keyless feed without creating a vendor client", async () => {
  const feed = createNotificationFeedController({
    credentials: async () => ({ mode: "disabled", personId: 7 }),
    connect: () => {
      throw new Error("Must not connect.");
    },
  });
  await feed.setPerson(7);
  await feed.setOpen(true);
  expect(feed.getSnapshot()).toMatchObject({
    status: "ready",
    items: [],
    unseen: 0,
  });
  feed.dispose();
});

it("renews once for overlapping requests and clears the feed when the renewed session is another person", async () => {
  let renew:
    | (() => Promise<
        import("./notification-feed-client").LiveNotificationIdentity
      >)
    | undefined;
  let release:
    | ((
        value: import("./notification-feed-client").NotificationIdentity
      ) => void)
    | undefined;
  const identity = {
    mode: "live" as const,
    personId: 7,
    publicApiKey: "public",
    feedChannelId: "feed",
    userToken: "initial",
    expiresAt: 9999999999999,
  };
  let reads = 0;
  const client = createFakeNotificationFeedClient([row]);
  const feed = createNotificationFeedController({
    credentials: async () => {
      reads++;
      return reads === 1
        ? identity
        : new Promise((resolve) => {
            release = resolve;
          });
    },
    connect: (_identity, callback) => {
      renew = callback;
      return client;
    },
  });
  await feed.setPerson(7);
  if (!renew) throw new Error("Missing renewal callback.");
  const first = renew();
  const second = renew();
  expect(reads).toBe(2);
  release?.({ ...identity, userToken: "renewed" });
  expect((await first).userToken).toBe("renewed");
  expect((await second).userToken).toBe("renewed");
  const changed = renew();
  release?.({ ...identity, personId: 8 });
  await expect(changed).rejects.toThrow("session changed");
  expect(client.disposed).toBe(true);
  expect(feed.getSnapshot()).toMatchObject({
    items: [],
    unseen: 0,
    status: "error",
  });
  feed.dispose();
});

it("cannot resurrect a logged-out feed from an outstanding credential response", async () => {
  let release:
    | ((
        value: import("./notification-feed-client").NotificationIdentity
      ) => void)
    | undefined;
  const feed = createNotificationFeedController({
    credentials: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    connect: () => {
      throw new Error("Stale credentials must not connect.");
    },
  });
  const loading = feed.setPerson(7);
  await feed.setPerson(null);
  release?.({
    mode: "live",
    personId: 7,
    publicApiKey: "public",
    feedChannelId: "feed",
    userToken: "signed",
    expiresAt: 9999999999999,
  });
  await loading;
  expect(feed.getSnapshot()).toMatchObject({
    status: "idle",
    items: [],
    unseen: 0,
    personId: null,
  });
});

it("keeps an in-flight refresh queued when another live event arrives", async () => {
  const client = createFakeNotificationFeedClient([row]);
  const feed = createNotificationFeedController({
    credentials: async () => ({
      mode: "live",
      personId: 7,
      publicApiKey: "public",
      feedChannelId: "feed",
      userToken: "signed",
      expiresAt: 9999999999999,
    }),
    connect: () => client,
  });
  await feed.setPerson(7);
  let release:
    ((value: Awaited<ReturnType<typeof client.list>>) => void) | undefined;
  const oldPage = await client.list();
  const normalList = client.list;
  client.list = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const refreshing = feed.refresh();
  const latest = {
    ...oldPage,
    unseen: 2,
    unread: 2,
    total: 2,
    items: [{ ...row, id: "latest" }, row],
  };
  client.receive(latest);
  client.list = normalList;
  release?.(oldPage);
  await refreshing;
  expect(feed.getSnapshot().items.map((item) => item.id)).toEqual([
    "latest",
    "confirmation",
  ]);
  feed.dispose();
});

it("activates exact destinations and marks rows read without navigating when only their checkmark is used", async () => {
  const client = createFakeNotificationFeedClient([
    { ...row, destination: "/courses/typescript/lessons/4#comment-12" },
  ]);
  const feed = createNotificationFeedController({
    credentials: async () => ({
      mode: "live",
      personId: 7,
      publicApiKey: "public",
      feedChannelId: "feed",
      userToken: "signed",
      expiresAt: 9999999999999,
    }),
    connect: () => client,
  });
  await feed.setPerson(7);
  await feed.setOpen(true);
  await feed.markRead(row.id);
  expect(feed.getSnapshot().open).toBe(true);
  expect(await feed.activate(row.id)).toBe(
    "/courses/typescript/lessons/4#comment-12"
  );
  expect(feed.getSnapshot().open).toBe(false);
  feed.dispose();
});
