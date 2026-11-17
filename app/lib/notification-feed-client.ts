import { z } from "zod";
import type { NotificationCategory } from "./notifications";

const identitySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("disabled"),
    personId: z.number().int().positive(),
  }),
  z.object({
    mode: z.literal("live"),
    personId: z.number().int().positive(),
    publicApiKey: z.string().min(1),
    feedChannelId: z.string().min(1),
    userToken: z.string().min(1),
    expiresAt: z.number(),
  }),
]);
export type NotificationIdentity = z.infer<typeof identitySchema>;
export type LiveNotificationIdentity = Extract<
  NotificationIdentity,
  { mode: "live" }
>;
export type NotificationRow = {
  id: string;
  category: NotificationCategory;
  title: string;
  context: string;
  destination: string | null;
  actor: { name: string; avatarUrl: string | null } | null;
  createdAt: string;
  read: boolean;
  seen: boolean;
};
export type NotificationPage = {
  items: NotificationRow[];
  unseen: number;
  unread: number;
  total: number;
  nextCursor: string | null;
};
export type NotificationFeedEvent =
  { type: "changed" } | { type: "error"; message: string };
export interface NotificationFeedClient {
  list(after?: string): Promise<NotificationPage>;
  markRead(id: string): Promise<void>;
  markAllSeen(): Promise<void>;
  markAllRead(): Promise<void>;
  subscribe(listener: (event: NotificationFeedEvent) => void): () => void;
  dispose(): void;
}
export class NotificationStatusPending extends Error {
  constructor() {
    super(
      "Your status update is still processing. Reopen Notifications to check."
    );
  }
}
export type NotificationFeedConnector = (
  identity: LiveNotificationIdentity,
  renew: () => Promise<LiveNotificationIdentity>
) => NotificationFeedClient | Promise<NotificationFeedClient>;

export async function fetchNotificationIdentity(): Promise<NotificationIdentity> {
  const response = await fetch("/api/notification-credentials", {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error("Notifications could not connect. Please try again.");
  return identitySchema.parse(await response.json());
}
export function notificationBadge(unseen: number) {
  return unseen > 9 ? "9+" : unseen > 0 ? String(unseen) : null;
}

export type NotificationFeedState = NotificationPage & {
  personId: number | null;
  status: "idle" | "loading" | "ready" | "error";
  open: boolean;
  error: string | null;
  statusError: string | null;
  busy: boolean;
  pageLoading: boolean;
  pageError: string | null;
};
const emptyPage: NotificationPage = {
  items: [],
  unseen: 0,
  unread: 0,
  total: 0,
  nextCursor: null,
};

// The controller is the public Cadence client seam used by the popover. It owns
// only ephemeral view state; the remote service owns history and statuses.
export function createNotificationFeedController(dependencies: {
  credentials: () => Promise<NotificationIdentity>;
  connect: NotificationFeedConnector;
}) {
  let state: NotificationFeedState = {
    ...emptyPage,
    personId: null,
    status: "idle",
    open: false,
    error: null,
    statusError: null,
    busy: false,
    pageLoading: false,
    pageError: null,
  };
  const listeners = new Set<() => void>();
  type Session = {
    personId: number;
    client?: NotificationFeedClient;
    unsubscribe?: () => void;
    pending?: Promise<void>;
    queued: boolean;
    renewal?: Promise<LiveNotificationIdentity>;
    mutation?: Promise<boolean>;
  };
  let session: Session | undefined;
  function update(patch: Partial<NotificationFeedState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function teardown() {
    const previous = session;
    session = undefined;
    previous?.unsubscribe?.();
    previous?.client?.dispose();
  }
  async function refreshHistory(
    current: Session,
    client: NotificationFeedClient
  ) {
    do {
      current.queued = false;
      try {
        // Reconcile the visible range, including older rows whose statuses
        // changed. New arrivals may move page boundaries, so stop at the
        // previous oldest row (or past its time if it was archived), not at
        // a fixed page count. Keep the previous view until all reads succeed.
        const oldest = state.items.at(-1);
        const previousCursor = state.nextCursor;
        const exhausted = previousCursor === null;
        const items = new Map<string, NotificationRow>();
        const cursors = new Set<string>();
        let page = await client.list();
        while (current === session) {
          for (const item of page.items) items.set(item.id, item);
          const last = page.items.at(-1);
          if (
            !oldest ||
            !page.nextCursor ||
            (!exhausted &&
              (items.has(oldest.id) ||
                (last &&
                  Date.parse(last.createdAt) < Date.parse(oldest.createdAt))))
          )
            break;
          if (cursors.has(page.nextCursor))
            throw new Error("Notification history cursor did not advance.");
          cursors.add(page.nextCursor);
          page = await client.list(page.nextCursor);
        }
        if (current === session) {
          const ordered = [...items.values()].sort(
            (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
          );
          const boundary = ordered.findIndex((item) => item.id === oldest?.id);
          const keepBoundary = !exhausted && boundary >= 0;
          update({
            ...page,
            items: keepBoundary ? ordered.slice(0, boundary + 1) : ordered,
            nextCursor: keepBoundary ? previousCursor : page.nextCursor,
            status: "ready",
            error: null,
          });
        }
      } catch {
        if (current === session)
          update({
            status: "error",
            error: "Notifications could not load. Please try again.",
          });
      }
    } while (current === session && current.queued);
  }
  async function refresh(current = session): Promise<void> {
    if (!current?.client || current !== session) return;
    if (current.pending) {
      current.queued = true;
      return current.pending;
    }
    current.pending = refreshHistory(current, current.client);
    try {
      await current.pending;
    } finally {
      current.pending = undefined;
    }
  }
  async function mutate(
    operation: (client: NotificationFeedClient) => Promise<void>,
    message: string,
    current = session
  ): Promise<boolean> {
    if (!current?.client || current !== session) return false;
    if (current.mutation) await current.mutation;
    if (current !== session || !current.client) return false;
    const client = current.client;
    update({ busy: true, statusError: null });
    const pending = (async () => {
      try {
        await operation(client);
        if (current !== session) return false;
        await refresh(current);
        return current === session;
      } catch (error) {
        // A rejected or still-processing write may have changed some remote
        // rows. Preserve the failure feedback and reconcile confirmed state.
        if (current === session) await refresh(current);
        if (current === session)
          update({
            statusError:
              error instanceof NotificationStatusPending
                ? error.message
                : message,
          });
        return false;
      } finally {
        if (current === session) update({ busy: false });
      }
    })();
    current.mutation = pending;
    try {
      return await pending;
    } finally {
      if (current.mutation === pending) current.mutation = undefined;
    }
  }
  async function loadMore() {
    const current = session;
    if (!current?.client || !state.nextCursor) return;
    if (current.pending) return current.pending;
    const cursor = state.nextCursor;
    const client = current.client;
    update({ pageLoading: true, pageError: null });
    current.pending = (async () => {
      try {
        const page = await client.list(cursor);
        if (page.nextCursor === cursor)
          throw new Error("Notification history cursor did not advance.");
        if (current === session) {
          const items = new Map(state.items.map((item) => [item.id, item]));
          for (const item of page.items) items.set(item.id, item);
          update({
            ...page,
            items: [...items.values()].sort(
              (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
            ),
          });
        }
      } catch {
        if (current === session)
          update({
            pageError: "Older Notifications could not load. Please try again.",
          });
      } finally {
        if (current === session && current.queued)
          await refreshHistory(current, client);
        if (current === session) update({ pageLoading: false });
      }
    })();
    try {
      await current.pending;
    } finally {
      current.pending = undefined;
    }
  }
  async function markRead(id: string) {
    return mutate(
      (client) => client.markRead(id),
      "Notification could not be marked read. Please try again."
    );
  }
  async function setOpen(open: boolean) {
    update({ open });
    if (!open) return;
    await mutate(
      (client) => client.markAllSeen(),
      "Notifications could not be marked seen. Close and reopen the feed to try again."
    );
  }
  async function renew(current: Session): Promise<LiveNotificationIdentity> {
    if (current !== session) throw new Error("Notification session changed.");
    if (current.renewal) return current.renewal;
    current.renewal = (async () => {
      try {
        const identity = await dependencies.credentials();
        if (current !== session)
          throw new Error("Notification session changed.");
        if (identity.mode !== "live" || identity.personId !== current.personId)
          throw new Error("Notification session changed.");
        return identity;
      } catch (error) {
        if (current === session) {
          teardown();
          update({
            ...emptyPage,
            status: "error",
            open: false,
            busy: false,
            pageLoading: false,
            pageError: null,
            error: "Notifications could not reconnect. Please try again.",
          });
        }
        throw error;
      }
    })();
    try {
      return await current.renewal;
    } finally {
      current.renewal = undefined;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async setPerson(personId: number | null) {
      teardown();
      update({
        ...emptyPage,
        personId,
        status: personId === null ? "idle" : "loading",
        open: false,
        error: null,
        statusError: null,
        busy: false,
        pageLoading: false,
        pageError: null,
      });
      if (personId === null) return;
      const current: Session = { personId, queued: false };
      session = current;
      try {
        const identity = await dependencies.credentials();
        if (current !== session) return;
        if (identity.personId !== personId)
          throw new Error("Notification session changed.");
        if (identity.mode === "disabled") {
          update({ status: "ready" });
          return;
        }
        const client = await dependencies.connect(identity, () =>
          renew(current)
        );
        if (current !== session) {
          client.dispose();
          return;
        }
        current.client = client;
        current.unsubscribe = client.subscribe((event) => {
          if (current !== session) return;
          if (event.type === "error") {
            update({ status: "error", error: event.message });
            return;
          }
          void refresh(current).then(async () => {
            if (
              current === session &&
              state.open &&
              state.unseen > 0 &&
              !current.mutation
            )
              await setOpen(true);
          });
        });
        await refresh(current);
        if (current === session && state.open) await setOpen(true);
      } catch {
        if (current === session) {
          teardown();
          update({
            status: "error",
            error: "Notifications could not connect. Please try again.",
          });
        }
      }
    },
    refresh: () => refresh(),
    loadMore,
    setOpen,
    markRead,
    markAllRead: () =>
      mutate(
        (client) => client.markAllRead(),
        "Notifications could not all be marked read. Please try again."
      ),
    async activate(id: string) {
      const current = session;
      const row = state.items.find((item) => item.id === id);
      if (!row) return null;
      if (!row.read && !(await markRead(id))) return null;
      if (current !== session) return null;
      if (row.destination) update({ open: false });
      return row.destination;
    },
    dispose() {
      teardown();
      update({
        ...emptyPage,
        personId: null,
        status: "idle",
        open: false,
        error: null,
        statusError: null,
        busy: false,
        pageLoading: false,
        pageError: null,
      });
    },
  };
}
