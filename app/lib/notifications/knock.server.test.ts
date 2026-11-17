import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { syncNotificationPerson } from "../notifications.server";
import { knockNotificationTransport } from "./knock.server";

const object = z.record(z.unknown());
function merge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>
) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__persistence_strategy__") continue;
    const child = object.safeParse(value);
    if (child.success) {
      const current = object.safeParse(target[key]);
      const result = current.success ? current.data : {};
      merge(result, child.data);
      target[key] = result;
    } else target[key] = value;
  }
}

// Simulates Knock's HTTP persistence boundary, including replace-by-default.
function vendor() {
  let identity: Record<string, unknown> = {};
  let preferenceSet: Record<string, unknown> | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "PUT") {
      const body = object.parse(await request.json());
      if (path.endsWith("/preferences/default")) {
        const result =
          body.__persistence_strategy__ === "merge"
            ? (preferenceSet ?? {})
            : {};
        merge(result, body);
        preferenceSet = { ...result, id: "default" };
      } else identity = body;
    }
    return Response.json(
      path.endsWith("/preferences")
        ? preferenceSet
          ? [preferenceSet]
          : []
        : path.includes("/preferences/")
          ? preferenceSet
          : identity
    );
  };
  return {
    fetcher,
    get identity() {
      return identity;
    },
    get preferences() {
      return preferenceSet;
    },
    set preferences(value) {
      preferenceSet = value;
    },
  };
}

const person = {
  id: 42,
  name: "Nina",
  email: "nina@example.com",
  avatarUrl: "https://example.com/nina.png",
};
afterEach(() => vi.restoreAllMocks());

describe("Knock Notification adapter", () => {
  it("stores the standard avatar and six category-by-feed defaults only once", async () => {
    const remote = vendor();
    const transport = knockNotificationTransport(
      { secretApiKey: "secret", feedChannelId: "feed-id" },
      remote.fetcher
    );
    await syncNotificationPerson(person, transport);

    expect(remote.identity).toEqual({
      name: "Nina",
      email: "nina@example.com",
      avatar: "https://example.com/nina.png",
    });
    expect(remote.preferences).toEqual({
      id: "default",
      categories: {
        "refund-request-updates": { channel_types: { in_app_feed: true } },
        "seat-claims": { channel_types: { in_app_feed: true } },
        enrollments: { channel_types: { in_app_feed: false } },
        "discussion-questions": { channel_types: { in_app_feed: true } },
        "open-refund-requests": { channel_types: { in_app_feed: true } },
        "discussion-replies": { channel_types: { in_app_feed: true } },
      },
    });
    remote.preferences = {
      id: "default",
      categories: {
        enrollments: { channel_types: { in_app_feed: true, email: false } },
      },
    };
    await syncNotificationPerson(
      { ...person, name: "Updated Nina" },
      transport
    );
    expect(remote.preferences).toEqual({
      id: "default",
      categories: {
        enrollments: { channel_types: { in_app_feed: true, email: false } },
      },
    });
  });

  it("merges overlapping saves into the external set without losing unrelated or future-channel data", async () => {
    const remote = vendor();
    remote.preferences = {
      id: "default",
      categories: {
        enrollments: { channel_types: { in_app_feed: false, email: false } },
        "discussion-replies": {
          channel_types: { in_app_feed: true, sms: true },
          channels: { "later-email-id": false },
        },
        "future-category": { channel_types: { email: false } },
      },
      workflows: { digest: false },
    };
    const transport = knockNotificationTransport(
      { secretApiKey: "secret", feedChannelId: "feed-id" },
      remote.fetcher
    );
    await Promise.all([
      transport.setPreference(42, {
        category: "enrollments",
        channel: "feed",
        enabled: true,
      }),
      transport.setPreference(42, {
        category: "discussionReplies",
        channel: "feed",
        enabled: false,
      }),
      syncNotificationPerson(person, transport),
    ]);
    expect(remote.preferences).toEqual({
      id: "default",
      categories: {
        enrollments: { channel_types: { in_app_feed: true, email: false } },
        "discussion-replies": {
          channel_types: { in_app_feed: false, sms: true },
          channels: { "later-email-id": false },
        },
        "future-category": { channel_types: { email: false } },
      },
      workflows: { digest: false },
    });
  });

  it("does not report initialized defaults when the vendor has not confirmed them", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher: typeof fetch = async (input) =>
      Response.json(
        String(input).endsWith("/preferences")
          ? []
          : { id: "default", categories: {} }
      );
    const transport = knockNotificationTransport(
      { secretApiKey: "secret", feedChannelId: "feed-id" },
      fetcher
    );
    expect(await syncNotificationPerson(person, transport)).toBe("failed");
    expect(await transport.getPreferences(person.id)).toBeNull();
  });

  it("preserves an explicit empty preference set rather than replacing it with defaults", async () => {
    const remote = vendor();
    remote.preferences = { id: "default", categories: {} };
    const transport = knockNotificationTransport(
      { secretApiKey: "secret", feedChannelId: "feed-id" },
      remote.fetcher
    );
    await syncNotificationPerson(person, transport);
    expect(remote.preferences).toEqual({ id: "default", categories: {} });
  });

  it("fails closed on an ambiguous preference-list response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher: typeof fetch = async () =>
      Response.json({ id: "default", categories: {} });
    const transport = knockNotificationTransport(
      { secretApiKey: "secret", feedChannelId: "feed-id" },
      fetcher
    );
    expect(await syncNotificationPerson(person, transport)).toBe("failed");
    await expect(transport.getPreferences(person.id)).rejects.toThrow();
  });

  it("updates an existing feed-channel override without resetting a future channel", async () => {
    const remote = vendor();
    remote.preferences = {
      id: "default",
      categories: {
        "discussion-replies": {
          channel_types: { in_app_feed: true },
          channels: { "feed-id": true, "future-email-id": false },
        },
      },
    };
    const transport = knockNotificationTransport(
      { secretApiKey: "secret", feedChannelId: "feed-id" },
      remote.fetcher
    );
    await transport.setPreference(42, {
      category: "discussionReplies",
      channel: "feed",
      enabled: false,
    });
    expect(remote.preferences).toEqual({
      id: "default",
      categories: {
        "discussion-replies": {
          channel_types: { in_app_feed: false },
          channels: { "feed-id": false, "future-email-id": false },
        },
      },
    });
  });

  it("makes a legacy muted category mutable while retaining its other supported channel choices", async () => {
    const remote = vendor();
    remote.preferences = {
      id: "default",
      categories: { enrollments: false, "discussion-replies": true },
    };
    const transport = knockNotificationTransport(
      { secretApiKey: "secret", feedChannelId: "feed-id" },
      remote.fetcher
    );
    await transport.setPreference(42, {
      category: "enrollments",
      channel: "feed",
      enabled: true,
    });
    expect(remote.preferences).toEqual({
      id: "default",
      categories: {
        enrollments: {
          channel_types: {
            in_app_feed: true,
            email: false,
            sms: false,
            push: false,
            chat: false,
            http: false,
          },
        },
        "discussion-replies": true,
      },
    });
  });

  it("preserves future-channel conditions and unknown keys while changing feed", async () => {
    const remote = vendor();
    const email = {
      conditions: [
        { variable: "tier", operator: "equal_to", argument: "paid" },
      ],
    };
    remote.preferences = {
      id: "default",
      categories: {
        "discussion-replies": {
          channel_types: { in_app_feed: true, email },
          channels: { "future-channel": { enabled: false } },
          custom: { value: 123 },
        },
      },
    };
    const transport = knockNotificationTransport(
      { secretApiKey: "secret", feedChannelId: "feed-id" },
      remote.fetcher
    );
    await transport.setPreference(42, {
      category: "discussionReplies",
      channel: "feed",
      enabled: false,
    });
    expect(remote.preferences).toEqual({
      id: "default",
      categories: {
        "discussion-replies": {
          channel_types: { in_app_feed: false, email },
          channels: { "future-channel": { enabled: false } },
          custom: { value: 123 },
        },
      },
    });
  });
});
