import { describe, expect, it } from "vitest";
import { createNotificationTransport } from "./config.server";

describe("Notification configuration", () => {
  it("reports keyless development preferences as unavailable and refuses to claim a save", async () => {
    const transport = createNotificationTransport({ NODE_ENV: "development" });
    expect(transport.available).toBe(false);
    expect(await transport.getPreferences(1)).toBeNull();
    await expect(
      transport.setPreference(1, {
        category: "discussionReplies",
        channel: "feed",
        enabled: false,
      })
    ).rejects.toThrow("unavailable");
  });

  it.each([
    { NODE_ENV: "production" },
    { NODE_ENV: "development", KNOCK_SECRET_API_KEY: "secret" },
    { NODE_ENV: "development", KNOCK_PUBLIC_API_KEY: "public" },
    { NODE_ENV: "development", KNOCK_FEED_CHANNEL_ID: "feed" },
    { NODE_ENV: "development", KNOCK_SIGNING_KEY: "signing" },
  ])(
    "rejects incomplete live configuration instead of silently disabling Notifications",
    (env) => {
      expect(() => createNotificationTransport(env)).toThrow(
        "Incomplete Notification configuration"
      );
    }
  );
});
