import type {
  NotificationFeedClient,
  NotificationFeedEvent,
  NotificationPage,
  NotificationRow,
} from "../notification-feed-client";

export function createFakeNotificationFeedClient(
  items: NotificationRow[] = [],
  counts?: { unseen: number; unread: number; total: number }
) {
  let page: NotificationPage = {
    items: structuredClone(items),
    nextCursor: null,
    unseen: items.filter((item) => !item.seen).length,
    unread: items.filter((item) => !item.read).length,
    total: items.length,
    ...counts,
  };
  const listeners = new Set<(event: NotificationFeedEvent) => void>();
  const failures = new Set<"list" | "read" | "seen" | "readAll">();
  const client: NotificationFeedClient & {
    disposed: boolean;
    seenScope: string | null;
  } = {
    disposed: false,
    seenScope: null,
    async list() {
      if (failures.has("list")) throw new Error("Feed unavailable.");
      return structuredClone(page);
    },
    async markRead(id) {
      if (failures.has("read")) throw new Error("Read unavailable.");
      const row = page.items.find((item) => item.id === id);
      if (row && !row.read) {
        row.read = true;
        page.unread--;
      }
    },
    async markAllSeen() {
      if (failures.has("seen")) throw new Error("Seen unavailable.");
      client.seenScope = "channel";
      page.unseen = 0;
      page.items.forEach((item) => {
        item.seen = true;
      });
    },
    async markAllRead() {
      if (failures.has("readAll")) throw new Error("Read unavailable.");
      page.unread = 0;
      page.items.forEach((item) => {
        item.read = true;
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      client.disposed = true;
      listeners.clear();
    },
  };
  return Object.assign(client, {
    failures,
    receive(next: NotificationPage) {
      page = structuredClone(next);
      for (const listener of listeners) listener({ type: "changed" });
    },
    fail(message: string) {
      for (const listener of listeners) listener({ type: "error", message });
    },
  });
}
