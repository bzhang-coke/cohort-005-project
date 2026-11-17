import { describe, expect, it } from "vitest";
import {
  createNotificationFeedController,
  notificationBadge,
  NotificationStatusPending,
  type NotificationFeedClient,
  type NotificationPage,
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

function feedFor(client: NotificationFeedClient) {
  return createNotificationFeedController({
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
}

it("reconciles an archived Discussion Question on explicit refresh, preserving the surviving read Discussion Reply and its destination", async () => {
  const question = {
    ...row,
    id: "question",
    category: "discussionQuestions" as const,
    destination: "/courses/course/lessons/1#comment-45",
  };
  const reply = {
    ...row,
    id: "reply",
    category: "discussionReplies" as const,
    title: "An original answer",
    context: "Lesson · Original snapshot",
    destination: "/courses/course/lessons/1#comment-46",
    createdAt: "2020-01-01T12:00:00Z",
    read: true,
    seen: true,
  };
  const client = createFakeNotificationFeedClient([question, reply]);
  const feed = feedFor(client);
  await feed.setPerson(7);
  expect(feed.getSnapshot()).toMatchObject({ total: 2, unread: 1, unseen: 1 });
  // The server archived a source while no live event was delivered. Focus,
  // deletion completion, or opening the feed uses this same refresh boundary.
  client.list = async () => ({
    items: [reply],
    nextCursor: null,
    total: 1,
    unread: 0,
    unseen: 0,
  });

  await feed.refresh();

  expect(feed.getSnapshot()).toMatchObject({
    items: [reply],
    total: 1,
    unread: 0,
    unseen: 0,
  });
  expect(await feed.activate("reply")).toBe(
    "/courses/course/lessons/1#comment-46"
  );
  feed.dispose();
});

it("stops pagination with recoverable feedback if the history cursor does not advance", async () => {
  const client = createFakeNotificationFeedClient(
    [
      { ...row, id: "newest" },
      { ...row, id: "older" },
    ],
    undefined,
    1
  );
  const feed = feedFor(client);
  await feed.setPerson(7);
  const stuckPage = await client.list();
  client.list = async () => stuckPage;
  await feed.loadMore();
  expect(feed.getSnapshot()).toMatchObject({
    status: "ready",
    nextCursor: "newest",
    pageLoading: false,
  });
  expect(feed.getSnapshot().items).toHaveLength(1);
  expect(feed.getSnapshot().pageError).toContain("could not load");
  feed.dispose();
});

it("browses retained read and unread history by cursor until every page is exhausted", async () => {
  const client = createFakeNotificationFeedClient(
    [
      { ...row, id: "newest", createdAt: "2026-11-17T12:00:00Z" },
      { ...row, id: "second", createdAt: "2026-11-16T12:00:00Z" },
      { ...row, id: "third", createdAt: "2026-10-01T12:00:00Z" },
      { ...row, id: "fourth", createdAt: "2025-11-17T12:00:00Z" },
      { ...row, id: "oldest", createdAt: "2020-01-01T12:00:00Z", read: true },
    ],
    undefined,
    2
  );
  const feed = feedFor(client);
  await feed.setPerson(7);
  expect(feed.getSnapshot()).toMatchObject({
    nextCursor: "second",
    total: 5,
    unread: 4,
  });
  await feed.loadMore();
  expect(feed.getSnapshot().items.map((item) => item.id)).toEqual([
    "newest",
    "second",
    "third",
    "fourth",
  ]);
  expect(feed.getSnapshot().nextCursor).toBe("fourth");
  await feed.loadMore();
  expect(feed.getSnapshot().items.at(-1)).toMatchObject({
    id: "oldest",
    read: true,
  });
  expect(feed.getSnapshot().nextCursor).toBeNull();
  await feed.loadMore();
  expect(feed.getSnapshot().items).toHaveLength(5);
  feed.dispose();
});

it("marks the whole channel read including unloaded history without losing loaded pages", async () => {
  const client = createFakeNotificationFeedClient(
    [
      { ...row, id: "newest", createdAt: "2026-11-17T12:00:00Z" },
      { ...row, id: "second", createdAt: "2026-11-16T12:00:00Z" },
      { ...row, id: "third", createdAt: "2026-10-01T12:00:00Z" },
      { ...row, id: "fourth", createdAt: "2025-11-17T12:00:00Z" },
      { ...row, id: "oldest", createdAt: "2020-01-01T12:00:00Z" },
    ],
    undefined,
    2
  );
  const feed = feedFor(client);
  await feed.setPerson(7);
  await feed.loadMore();
  await feed.setOpen(true);
  expect(feed.getSnapshot()).toMatchObject({
    unseen: 0,
    unread: 5,
    nextCursor: "fourth",
  });
  expect(feed.getSnapshot().items).toHaveLength(4);
  expect(await feed.markAllRead()).toBe(true);
  expect(feed.getSnapshot()).toMatchObject({
    unseen: 0,
    unread: 0,
    total: 5,
    nextCursor: "fourth",
    open: true,
  });
  expect(feed.getSnapshot().items).toHaveLength(4);
  expect(feed.getSnapshot().items.every((item) => item.read && item.seen)).toBe(
    true
  );
  await feed.loadMore();
  expect(feed.getSnapshot().items.at(-1)).toMatchObject({
    id: "oldest",
    read: true,
    seen: true,
  });
  feed.dispose();
});

it("keeps one ordered history and its cursor when a live arrival overlaps a pending older page", async () => {
  const history = [
    { ...row, id: "newest", createdAt: "2026-11-17T12:00:00Z" },
    { ...row, id: "second", createdAt: "2026-11-16T12:00:00Z" },
    { ...row, id: "third", createdAt: "2026-10-01T12:00:00Z" },
    { ...row, id: "fourth", createdAt: "2025-11-17T12:00:00Z" },
    { ...row, id: "oldest", createdAt: "2020-01-01T12:00:00Z" },
  ];
  const client = createFakeNotificationFeedClient(history, undefined, 2);
  const feed = feedFor(client);
  await feed.setPerson(7);
  const originalList = client.list;
  const olderPage = await client.list("second");
  let release: ((page: NotificationPage) => void) | undefined;
  client.list = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const paging = feed.loadMore();
  const overlapping = feed.loadMore();
  expect(feed.getSnapshot()).toMatchObject({
    pageLoading: true,
    nextCursor: "second",
  });
  client.receive({
    items: [
      { ...row, id: "arrived", createdAt: "2026-11-18T12:00:00Z" },
      ...history,
    ],
    unseen: 6,
    unread: 6,
    total: 6,
    nextCursor: null,
  });
  client.list = originalList;
  release?.({
    ...olderPage,
    items: [
      { ...row, id: "second", createdAt: "2026-11-16T12:00:00Z" },
      ...olderPage.items,
    ],
  });
  await Promise.all([paging, overlapping]);
  expect(feed.getSnapshot().items.map((item) => item.id)).toEqual([
    "arrived",
    "newest",
    "second",
    "third",
    "fourth",
  ]);
  expect(feed.getSnapshot()).toMatchObject({
    pageLoading: false,
    unseen: 6,
    unread: 6,
    total: 6,
    nextCursor: "fourth",
  });
  await feed.loadMore();
  expect(feed.getSnapshot().items.map((item) => item.id)).toEqual([
    "arrived",
    "newest",
    "second",
    "third",
    "fourth",
    "oldest",
  ]);
  feed.dispose();
});

it("waits for authoritative read state when a bulk change completes during pagination", async () => {
  const client = createFakeNotificationFeedClient(
    [
      { ...row, id: "newest", createdAt: "2026-11-17T12:00:00Z" },
      { ...row, id: "second", createdAt: "2026-11-16T12:00:00Z" },
      { ...row, id: "third", createdAt: "2026-10-01T12:00:00Z" },
      { ...row, id: "fourth", createdAt: "2025-11-17T12:00:00Z" },
      { ...row, id: "oldest", createdAt: "2020-01-01T12:00:00Z" },
    ],
    undefined,
    2
  );
  const feed = feedFor(client);
  await feed.setPerson(7);
  const originalList = client.list;
  const oldPage = await client.list("second");
  let release: ((page: NotificationPage) => void) | undefined;
  client.list = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const paging = feed.loadMore();
  const marking = feed.markAllRead();
  let marked = false;
  void marking.then(() => {
    marked = true;
  });
  await Promise.resolve();
  let refreshRelease: ((page: NotificationPage) => void) | undefined;
  client.list = (after) =>
    after
      ? originalList(after)
      : new Promise((resolve) => {
          refreshRelease = resolve;
        });
  release?.(oldPage);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(marked).toBe(false);
  expect(feed.getSnapshot().busy).toBe(true);
  refreshRelease?.(await originalList());
  expect(await marking).toBe(true);
  expect(feed.getSnapshot()).toMatchObject({
    unread: 0,
    total: 5,
    nextCursor: "fourth",
    busy: false,
  });
  expect(feed.getSnapshot().items).toHaveLength(4);
  expect(feed.getSnapshot().items.every((item) => item.read)).toBe(true);
  await paging;
  feed.dispose();
});

it("reconciles a partially applied bulk change and reports that completion is still pending", async () => {
  const client = createFakeNotificationFeedClient(
    [
      { ...row, id: "newest", createdAt: "2026-11-17T12:00:00Z" },
      { ...row, id: "second", createdAt: "2026-11-16T12:00:00Z" },
      { ...row, id: "third", createdAt: "2026-10-01T12:00:00Z" },
    ],
    undefined,
    1
  );
  const feed = feedFor(client);
  await feed.setPerson(7);
  await feed.loadMore();
  client.markAllRead = async () => {
    await client.markRead("second");
    throw new NotificationStatusPending();
  };
  expect(await feed.markAllRead()).toBe(false);
  expect(feed.getSnapshot()).toMatchObject({
    unread: 2,
    nextCursor: "second",
    busy: false,
  });
  expect(feed.getSnapshot().items[1]?.read).toBe(true);
  expect(feed.getSnapshot().statusError).toContain("still processing");
  feed.dispose();
});

it("recovers failed pages and status changes without discarding usable history", async () => {
  const client = createFakeNotificationFeedClient(
    [
      { ...row, id: "newest", createdAt: "2026-11-17T12:00:00Z" },
      { ...row, id: "second", createdAt: "2026-11-16T12:00:00Z" },
      { ...row, id: "third", createdAt: "2026-10-01T12:00:00Z" },
      { ...row, id: "fourth", createdAt: "2025-11-17T12:00:00Z" },
      { ...row, id: "oldest", createdAt: "2020-01-01T12:00:00Z" },
    ],
    undefined,
    2
  );
  const feed = feedFor(client);
  await feed.setPerson(7);
  client.failures.add("list");
  await feed.loadMore();
  expect(feed.getSnapshot()).toMatchObject({
    status: "ready",
    nextCursor: "second",
    pageLoading: false,
    unread: 5,
  });
  expect(feed.getSnapshot().items).toHaveLength(2);
  expect(feed.getSnapshot().pageError).toContain(
    "Older Notifications could not load"
  );
  client.failures.delete("list");
  await feed.loadMore();
  expect(feed.getSnapshot()).toMatchObject({
    nextCursor: "fourth",
    pageError: null,
  });
  client.failures.add("readAll");
  expect(await feed.markAllRead()).toBe(false);
  expect(feed.getSnapshot().statusError).toContain(
    "could not all be marked read"
  );
  expect(feed.getSnapshot()).toMatchObject({
    nextCursor: "fourth",
    unread: 5,
    busy: false,
  });
  expect(feed.getSnapshot().items).toHaveLength(4);
  client.failures.delete("readAll");
  await feed.markRead("third");
  expect(feed.getSnapshot()).toMatchObject({
    unread: 4,
    statusError: null,
    nextCursor: "fourth",
  });
  expect(feed.getSnapshot().items[2]).toMatchObject({
    id: "third",
    read: true,
  });
  client.failures.add("list");
  await feed.refresh();
  expect(feed.getSnapshot()).toMatchObject({
    status: "error",
    nextCursor: "fourth",
  });
  expect(feed.getSnapshot().items).toHaveLength(4);
  client.failures.delete("list");
  await feed.refresh();
  expect(feed.getSnapshot()).toMatchObject({
    status: "ready",
    error: null,
    nextCursor: "fourth",
  });
  expect(feed.getSnapshot().items).toHaveLength(4);
  feed.dispose();
});

it("discards a pending history page and bulk completion when the selected person changes", async () => {
  const first = createFakeNotificationFeedClient(
    [
      { ...row, id: "first-person-new" },
      { ...row, id: "first-person-old" },
    ],
    undefined,
    1
  );
  const second = createFakeNotificationFeedClient([
    { ...row, id: "second-person" },
  ]);
  let personId = 1;
  const feed = createNotificationFeedController({
    credentials: async () => ({
      mode: "live",
      personId,
      publicApiKey: "public",
      feedChannelId: "feed",
      userToken: "signed",
      expiresAt: 9999999999999,
    }),
    connect: (identity) => (identity.personId === 1 ? first : second),
  });
  await feed.setPerson(1);
  const oldPage = await first.list("first-person-new");
  let releasePage: ((page: NotificationPage) => void) | undefined;
  let releaseStatus: (() => void) | undefined;
  first.list = () =>
    new Promise((resolve) => {
      releasePage = resolve;
    });
  first.markAllRead = () =>
    new Promise((resolve) => {
      releaseStatus = resolve;
    });
  const paging = feed.loadMore();
  const marking = feed.markAllRead();
  personId = 2;
  await feed.setPerson(2);
  releasePage?.(oldPage);
  releaseStatus?.();
  await paging;
  expect(await marking).toBe(false);
  expect(first.disposed).toBe(true);
  expect(feed.getSnapshot()).toMatchObject({
    personId: 2,
    unread: 1,
    unseen: 1,
    nextCursor: null,
    pageLoading: false,
    busy: false,
    pageError: null,
    statusError: null,
  });
  expect(feed.getSnapshot().items.map((item) => item.id)).toEqual([
    "second-person",
  ]);
  feed.dispose();
});

it("reconciles removal of an older loaded row without breaking the next history cursor", async () => {
  const history = [
    { ...row, id: "newest", createdAt: "2026-11-17T12:00:00Z" },
    { ...row, id: "second", createdAt: "2026-11-16T12:00:00Z" },
    { ...row, id: "third", createdAt: "2026-10-01T12:00:00Z" },
    { ...row, id: "fourth", createdAt: "2025-11-17T12:00:00Z" },
    { ...row, id: "fifth", createdAt: "2021-01-01T12:00:00Z" },
    { ...row, id: "oldest", createdAt: "2020-01-01T12:00:00Z" },
  ];
  const client = createFakeNotificationFeedClient(history, undefined, 2);
  const feed = feedFor(client);
  await feed.setPerson(7);
  await feed.loadMore();
  client.receive({
    items: history.filter((item) => item.id !== "fourth"),
    unseen: 5,
    unread: 5,
    total: 5,
    nextCursor: null,
  });
  await feed.refresh();
  expect(feed.getSnapshot().items.map((item) => item.id)).toEqual([
    "newest",
    "second",
    "third",
    "fifth",
  ]);
  expect(feed.getSnapshot()).toMatchObject({ nextCursor: "fifth", total: 5 });
  await feed.loadMore();
  expect(feed.getSnapshot().items.map((item) => item.id)).toEqual([
    "newest",
    "second",
    "third",
    "fifth",
    "oldest",
  ]);
  expect(feed.getSnapshot().nextCursor).toBeNull();
  feed.dispose();
});

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
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(feed.getSnapshot()).toMatchObject({
    unseen: 0,
    unread: 2,
    open: true,
  });
  feed.dispose();
});

it.each([false, true])(
  "marks live arrivals seen after a pending read finishes while preserving its feedback (read fails: %s)",
  async (readFails) => {
    const client = createFakeNotificationFeedClient([row]);
    const feed = feedFor(client);
    await feed.setPerson(7);
    await feed.setOpen(true);
    const markRead = client.markRead;
    if (readFails) client.failures.add("read");
    let release: (() => void) | undefined;
    client.markRead = async (id) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await markRead(id);
    };
    const reading = feed.markRead(row.id);
    client.receive({
      items: [
        { ...row, id: "arrival" },
        { ...row, seen: true },
      ],
      unseen: 1,
      unread: 2,
      total: 2,
      nextCursor: null,
    });
    await feed.refresh();
    expect(feed.getSnapshot()).toMatchObject({
      open: true,
      busy: true,
      unseen: 1,
    });

    release?.();
    expect(await reading).toBe(!readFails);

    expect(feed.getSnapshot()).toMatchObject({
      open: true,
      busy: false,
      unseen: 0,
      unread: readFails ? 2 : 1,
      statusError: readFails
        ? "Notification could not be marked read. Please try again."
        : null,
    });
    expect(feed.getSnapshot().items).toEqual([
      expect.objectContaining({ id: "arrival", seen: true, read: false }),
      expect.objectContaining({ id: row.id, seen: true, read: !readFails }),
    ]);
    feed.dispose();
  }
);

it("keeps later status changes pending until earlier requested changes finish", async () => {
  const client = createFakeNotificationFeedClient([
    { ...row, id: "first" },
    { ...row, id: "second" },
    { ...row, id: "third" },
  ]);
  const feed = feedFor(client);
  await feed.setPerson(7);
  const markRead = client.markRead;
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  client.markRead = async (id) => {
    await new Promise<void>((resolve) => {
      if (id === "first") releaseFirst = resolve;
      else releaseSecond = resolve;
    });
    if (id === "second") throw new Error("Read unavailable.");
    await markRead(id);
  };
  const first = feed.markRead("first");
  const second = feed.markRead("second");
  const all = feed.markAllRead();

  releaseFirst?.();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(feed.getSnapshot()).toMatchObject({ unread: 2, busy: true });
  releaseSecond?.();
  expect(await second).toBe(false);
  expect(await all).toBe(true);
  expect(feed.getSnapshot()).toMatchObject({
    unread: 0,
    busy: false,
    statusError: null,
  });
  feed.dispose();
});

it.each(["close", "dispose", "switch"])(
  "discards queued seen reconciliation after %s",
  async (change) => {
    const first = createFakeNotificationFeedClient([row]);
    const second = createFakeNotificationFeedClient([
      { ...row, id: "other-person" },
    ]);
    let personId = 7;
    const feed = createNotificationFeedController({
      credentials: async () => ({
        mode: "live",
        personId,
        publicApiKey: "public",
        feedChannelId: "feed",
        userToken: "signed",
        expiresAt: 9999999999999,
      }),
      connect: () => (personId === 7 ? first : second),
    });
    await feed.setPerson(7);
    await feed.setOpen(true);
    let release: (() => void) | undefined;
    first.markRead = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const reading = feed.markRead(row.id);
    first.receive({
      items: [
        { ...row, id: "arrival" },
        { ...row, seen: true },
      ],
      unseen: 1,
      unread: 2,
      total: 2,
      nextCursor: null,
    });
    await feed.refresh();
    if (change === "close") await feed.setOpen(false);
    else if (change === "dispose") feed.dispose();
    else {
      personId = 8;
      await feed.setPerson(8);
    }
    const expected = feed.getSnapshot();
    release?.();
    await reading;

    expect(await first.list()).toMatchObject({ unseen: 1 });
    expect(feed.getSnapshot()).toEqual({ ...expected, busy: false });
    feed.dispose();
  }
);

it("leaves failed queued seen reconciliation for another action or live event", async () => {
  const client = createFakeNotificationFeedClient([row]);
  const feed = feedFor(client);
  await feed.setPerson(7);
  await feed.setOpen(true);
  let release: (() => void) | undefined;
  client.markRead = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const reading = feed.markRead(row.id);
  client.receive({
    items: [
      { ...row, id: "arrival" },
      { ...row, seen: true },
    ],
    unseen: 1,
    unread: 2,
    total: 2,
    nextCursor: null,
  });
  await feed.refresh();
  let attempts = 0;
  client.markAllSeen = async () => {
    attempts++;
    if (attempts === 1) client.receive(await client.list());
    throw new Error("Seen unavailable.");
  };
  release?.();
  await reading;

  expect(attempts).toBe(1);
  expect(feed.getSnapshot()).toMatchObject({
    open: true,
    busy: false,
    unseen: 1,
  });
  expect(feed.getSnapshot().statusError).toContain("could not be marked seen");
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

it("renews once for overlapping requests and clears the feed and stale feedback when the renewed session is another person", async () => {
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
  const client = createFakeNotificationFeedClient(
    [row, { ...row, id: "older" }],
    undefined,
    1
  );
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
  client.failures.add("read");
  await feed.markRead(row.id);
  client.failures.add("list");
  await feed.loadMore();
  await feed.refresh();
  expect(feed.getSnapshot()).toMatchObject({
    statusError: expect.stringContaining("could not be marked read"),
    pageError: expect.stringContaining("could not load"),
    error: expect.stringContaining("could not load"),
  });
  const changed = renew();
  release?.({ ...identity, personId: 8 });
  await expect(changed).rejects.toThrow("session changed");
  expect(client.disposed).toBe(true);
  expect(feed.getSnapshot()).toMatchObject({
    items: [],
    unseen: 0,
    status: "error",
    statusError: null,
    pageError: null,
    error: "Notifications could not reconnect. Please try again.",
    busy: false,
    pageLoading: false,
    open: false,
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

it.each([
  {
    category: "discussionQuestions" as const,
    destination: "/courses/typescript/lessons/4#comment-12",
  },
  { category: "seatClaims" as const, destination: "/team#seat-12" },
])(
  "activates $category destinations and marks rows read without navigating when only their checkmark is used",
  async ({ category, destination }) => {
    const client = createFakeNotificationFeedClient([
      {
        ...row,
        category,
        destination,
        actor: {
          name: "Test Student",
          avatarUrl: "/student-avatar.png",
        },
      },
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
    expect(feed.getSnapshot().items[0]).toMatchObject({
      read: true,
      category,
      actor: { avatarUrl: "/student-avatar.png" },
    });
    expect(await feed.activate(row.id)).toBe(destination);
    expect(feed.getSnapshot().open).toBe(false);
    feed.dispose();
  }
);
