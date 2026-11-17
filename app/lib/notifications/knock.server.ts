import { z } from "zod";
import {
  notificationCategories,
  type NotificationCategory,
  type NotificationPreferences,
} from "../notifications";
import type { NotificationTransport } from "./transport.server";

// All vendor vocabulary stays in this adapter.
const categoryKeys: Record<NotificationCategory, string> = {
  refundRequestUpdates: "refund-request-updates",
  seatClaims: "seat-claims",
  enrollments: "enrollments",
  discussionQuestions: "discussion-questions",
  openRefundRequests: "open-refund-requests",
  discussionReplies: "discussion-replies",
};

const categorySchema = z.union([
  z.boolean(),
  z
    .object({
      channel_types: z.record(z.unknown()).nullish(),
      channels: z.record(z.unknown()).nullish(),
    })
    .passthrough(),
]);
const preferenceSetSchema = z
  .object({
    id: z.string(),
    categories: z.record(z.unknown()).nullish(),
  })
  .passthrough();
type PreferenceSet = z.infer<typeof preferenceSetSchema>;

// Cadence is one process (ADR 0006). Share this across adapter instances so
// identity writes, initialization, and preference saves stay ordered per person.
const pending = new Map<string, Promise<unknown>>();
async function serialized<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pending.set(key, current);
  try {
    return await current;
  } finally {
    if (pending.get(key) === current) pending.delete(key);
  }
}

export function knockNotificationTransport(
  config: { secretApiKey: string; feedChannelId: string },
  fetcher: typeof fetch = fetch
): NotificationTransport {
  async function request(personId: number, suffix: string, body?: unknown) {
    const response = await fetcher(
      `https://api.knock.app/v1/users/${personId}${suffix}`,
      {
        method: body === undefined ? "GET" : "PUT",
        headers: {
          Authorization: `Bearer ${config.secretApiKey}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok)
      throw new Error(
        `Knock Notification request failed (${response.status}).`
      );
    const result: unknown = await response.json();
    return result;
  }

  async function storedSet(personId: number) {
    // GET /preferences/default can synthesize environment defaults. The list
    // endpoint describes the person's stored sets; an empty stored set counts.
    const sets = z
      .array(preferenceSetSchema)
      .parse(await request(personId, "/preferences"));
    return sets.find((set) => set.id === "default") ?? null;
  }

  function preferences(set: PreferenceSet): NotificationPreferences {
    const result: NotificationPreferences = {};
    for (const category of notificationCategories) {
      const value = set.categories?.[categoryKeys[category]];
      if (value === undefined) continue;
      const parsed = categorySchema.parse(value);
      const feed =
        typeof parsed === "boolean"
          ? parsed
          : (parsed.channels?.[config.feedChannelId] ??
            parsed.channel_types?.in_app_feed);
      const email =
        typeof parsed === "boolean" ? undefined : parsed.channel_types?.email;
      result[category] = {
        channels: {
          ...(typeof email === "boolean" ? { email } : {}),
          ...(feed === undefined ? {} : { feed: z.boolean().parse(feed) }),
        },
      };
    }
    return result;
  }

  return {
    available: true,
    async identify(person) {
      return serialized(`${config.secretApiKey}:${person.id}`, async () => {
        await request(person.id, "", {
          name: person.name,
          email: person.email,
          avatar: person.avatarUrl,
        });
      });
    },
    async getPreferences(personId) {
      const set = await storedSet(personId);
      return set ? preferences(set) : null;
    },
    async initializePreferences(personId, defaults) {
      return serialized(`${config.secretApiKey}:${personId}`, async () => {
        const existing = await storedSet(personId);
        if (existing) return preferences(existing);
        const categories = Object.fromEntries(
          notificationCategories.map((category) => [
            categoryKeys[category],
            {
              channel_types: {
                in_app_feed: defaults[category]?.channels.feed ?? false,
              },
            },
          ])
        );
        const saved = preferenceSetSchema.parse(
          await request(personId, "/preferences/default", {
            __persistence_strategy__: "merge",
            categories,
          })
        );
        const initialized = preferences(saved);
        if (
          notificationCategories.some(
            (category) =>
              initialized[category]?.channels.feed !==
              defaults[category]?.channels.feed
          )
        ) {
          throw new Error(
            "Knock did not confirm Notification preference initialization."
          );
        }
        return initialized;
      });
    },
    async setPreference(personId, change) {
      return serialized(`${config.secretApiKey}:${personId}`, async () => {
        const existing = await storedSet(personId);
        if (!existing)
          throw new Error("Notification preferences are not initialized.");
        const current = existing.categories?.[categoryKeys[change.category]];
        const parsed =
          current === undefined ? undefined : categorySchema.parse(current);
        const existingChannels =
          typeof parsed === "object" ? parsed.channels : undefined;
        const saved = preferenceSetSchema.parse(
          await request(personId, "/preferences/default", {
            __persistence_strategy__: "merge",
            categories: {
              [categoryKeys[change.category]]: {
                // A scalar mute covers every currently supported channel type.
                // Expand it before enabling feed so email/SMS/etc. remain muted.
                channel_types: {
                  ...(current === false
                    ? {
                        email: false,
                        sms: false,
                        push: false,
                        chat: false,
                        http: false,
                      }
                    : {}),
                  in_app_feed: change.enabled,
                },
                ...(existingChannels?.[config.feedChannelId] === undefined
                  ? {}
                  : {
                      channels: { [config.feedChannelId]: change.enabled },
                    }),
              },
            },
          })
        );
        return preferences(saved);
      });
    },
  };
}
