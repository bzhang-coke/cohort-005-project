import Knock from "@knocklabs/client";
import { z } from "zod";
import { notificationCategories } from "../notifications";
import type {
  LiveNotificationIdentity,
  NotificationFeedClient,
  NotificationFeedEvent,
  NotificationPage,
} from "../notification-feed-client";
import { NotificationStatusPending } from "../notification-feed-client";

const destinationSchema = z
  .string()
  .refine(
    (path) =>
      path.startsWith("/") &&
      !path.startsWith("//") &&
      !path.includes("\\") &&
      !/[\u0000-\u001f\u007f]/.test(path),
    "Notification destination must stay within Cadence."
  )
  .nullable();
const rowSchema = z.object({
  id: z.string(),
  inserted_at: z.string().datetime({ offset: true }),
  read_at: z.string().nullable(),
  seen_at: z.string().nullable(),
  actors: z.array(
    z
      .object({ name: z.string().nullish(), avatar: z.string().nullish() })
      .passthrough()
  ),
  data: z.object({
    category: z.enum(notificationCategories),
    title: z.string(),
    context: z.string(),
    destination: destinationSchema,
  }),
});
const pageSchema = z.object({
  entries: z.array(rowSchema),
  meta: z.object({
    total_count: z.number().int().nonnegative(),
    unread_count: z.number().int().nonnegative(),
    unseen_count: z.number().int().nonnegative(),
  }),
  page_info: z.object({ after: z.string().nullish() }),
});

// SDK details and vendor request shapes stay here. In particular, use signed
// makeRequest for status changes: SDK high-level methods mutate optimistically
// and can return HTTP errors as values without rolling back their store.
export async function knockNotificationFeedClient(
  identity: LiveNotificationIdentity,
  renew: () => Promise<LiveNotificationIdentity>
): Promise<NotificationFeedClient> {
  const knock = new Knock(identity.publicApiKey);
  const listeners = new Set<(event: NotificationFeedEvent) => void>();
  const cancellation = new AbortController();
  let disposed = false;
  function publish(event: NotificationFeedEvent) {
    if (!disposed) for (const listener of listeners) listener(event);
  }
  await knock.authenticate(
    { id: String(identity.personId) },
    identity.userToken,
    {
      identificationStrategy: "skip",
      onUserTokenExpiring: async () => {
        try {
          const fresh = await renew();
          if (disposed) return;
          if (
            fresh.personId !== identity.personId ||
            fresh.publicApiKey !== identity.publicApiKey ||
            fresh.feedChannelId !== identity.feedChannelId
          )
            throw new Error("Notification session changed.");
          return fresh.userToken;
        } catch {
          publish({
            type: "error",
            message: "Notifications could not reconnect. Please try again.",
          });
          client.dispose();
        }
      },
    }
  );
  const feed = knock.feeds.initialize(identity.feedChannelId, {
    status: "all",
    archived: "exclude",
    mode: "rich",
    page_size: 20,
  });
  let metadata = feed.getState().metadata;
  const unsubscribeStore = feed.store.subscribe(() => {
    const next = feed.getState();
    if (next.metadata !== metadata) {
      metadata = next.metadata;
      publish({ type: "changed" });
    }
  });
  let detachSocket = () => {};
  function watchSocket() {
    detachSocket();
    if (disposed || !knock.isAuthenticated()) return;
    const socket = knock.client().socket;
    const refs = [
      socket?.onError(() =>
        publish({
          type: "error",
          message: "Live Notifications disconnected. Please try again.",
        })
      ),
      socket?.onOpen(() => publish({ type: "changed" })),
    ].filter((ref): ref is string => typeof ref === "string");
    detachSocket = () => {
      if (refs.length) socket?.off(refs);
    };
  }
  watchSocket();
  const unsubscribeAuth = knock.authStore.subscribe(watchSocket);
  feed.listenForUpdates();

  async function request(
    method: string,
    url: string,
    data?: unknown,
    params?: unknown
  ): Promise<unknown> {
    if (disposed) throw new Error("Notification connection closed.");
    const response = await knock.client().makeRequest({
      method,
      url,
      data,
      params,
      signal: AbortSignal.any([
        cancellation.signal,
        AbortSignal.timeout(10000),
      ]),
      maxRetries: 0,
    });
    if (disposed) throw new Error("Notification connection closed.");
    if (
      response.statusCode !== "ok" ||
      response.status < 200 ||
      response.status >= 300
    )
      throw new Error("Notification request failed.");
    return response.body;
  }
  let feedRead: Promise<unknown> = Promise.resolve();
  let nextFeedReadAt = 0;
  async function list(after?: string): Promise<NotificationPage> {
    // Knock allows five feed reads per second per person, across API keys.
    // Page reconciliation and bulk-status confirmation share this queue. Four
    // starts per second leaves room for a server-side archival lookup.
    // This schedules requested reads only; it never polls or retries a write.
    const queued = feedRead
      .catch(() => undefined)
      .then(async () => {
        if (disposed) throw new Error("Notification connection closed.");
        const delay = Math.max(0, nextFeedReadAt - Date.now());
        if (delay)
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        nextFeedReadAt = Date.now() + 250;
        return request(
          "GET",
          `/v1/users/${identity.personId}/feeds/${encodeURIComponent(identity.feedChannelId)}`,
          undefined,
          {
            status: "all",
            archived: "exclude",
            mode: "rich",
            page_size: 20,
            ...(after ? { after } : {}),
          }
        );
      });
    feedRead = queued;
    const page = pageSchema.parse(await queued);
    return {
      items: page.entries.map((entry) => {
        const actor = entry.actors[0];
        return {
          id: entry.id,
          ...entry.data,
          actor: actor
            ? { name: actor.name ?? "Cadence", avatarUrl: actor.avatar ?? null }
            : null,
          createdAt: entry.inserted_at,
          read: entry.read_at !== null,
          seen: entry.seen_at !== null,
        };
      }),
      unseen: page.meta.unseen_count,
      unread: page.meta.unread_count,
      total: page.meta.total_count,
      nextCursor: page.page_info.after ?? null,
    };
  }
  async function bulk(status: "seen" | "read") {
    const operation = z
      .object({
        status: z.enum(["queued", "processing", "completed", "failed"]),
        error_count: z.number().optional(),
      })
      .parse(
        await request(
          "POST",
          `/v1/channels/${encodeURIComponent(identity.feedChannelId)}/messages/bulk/${status}`,
          { recipient_ids: [String(identity.personId)], archived: "exclude" }
        )
      );
    if (operation.status === "failed" || (operation.error_count ?? 0) > 0)
      throw new Error("Notification status update failed.");
    if (operation.status === "completed") return;
    // The generic bulk-progress endpoint isn't documented for public keys.
    // Confirm through this person's signed feed instead. These bounded reads
    // occur only for an explicit status operation; there is no feed poller or
    // repeated write. Never follow provider-supplied progress URLs.
    for (const delay of [0, 250, 500, 1000, 2000]) {
      if (delay)
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (disposed) throw new Error("Notification connection closed.");
      const page = await list();
      if ((status === "seen" ? page.unseen : page.unread) === 0) return;
    }
    throw new NotificationStatusPending();
  }
  const client: NotificationFeedClient = {
    list,
    async markRead(id) {
      await request("PUT", `/v1/messages/${encodeURIComponent(id)}/read`);
    },
    markAllSeen: () => bulk("seen"),
    markAllRead: () => bulk("read"),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancellation.abort();
      unsubscribeStore();
      listeners.clear();
      unsubscribeAuth();
      detachSocket();
      feed.dispose();
      knock.logout();
    },
  };
  return client;
}
