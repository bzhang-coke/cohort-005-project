import { loadEnvFile } from "node:process";
import { knockNotificationTransport } from "./knock.server";
import { noopNotificationTransport } from "./noop.server";
import type { NotificationTransport } from "./transport.server";

export function createNotificationTransport(
  env: NodeJS.ProcessEnv
): NotificationTransport {
  const names = [
    "KNOCK_SECRET_API_KEY",
    "KNOCK_PUBLIC_API_KEY",
    "KNOCK_SIGNING_KEY",
    "KNOCK_FEED_CHANNEL_ID",
  ] as const;
  const configured = names.some((name) => Boolean(env[name]?.trim()));
  if (!configured && env.NODE_ENV !== "production")
    return noopNotificationTransport();
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length)
    throw new Error(
      `Incomplete Notification configuration: ${missing.join(", ")}.`
    );
  const secretApiKey = env.KNOCK_SECRET_API_KEY;
  const feedChannelId = env.KNOCK_FEED_CHANNEL_ID;
  if (!secretApiKey || !feedChannelId)
    throw new Error("Incomplete Notification configuration.");
  return knockNotificationTransport({ secretApiKey, feedChannelId });
}

let transport: NotificationTransport | undefined;
export function getNotificationTransport(): NotificationTransport {
  if (transport) return transport;
  // Vite's browser env does not load private variables into process.env.
  // Node preserves deployment-provided variables while loading local .env.
  try {
    loadEnvFile();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  transport = createNotificationTransport(process.env);
  return transport;
}
