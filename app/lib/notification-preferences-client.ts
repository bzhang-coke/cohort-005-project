import { z } from "zod";
import {
  notificationCategories,
  type NotificationPreferenceChange,
  type NotificationSettings,
} from "./notifications";

export interface NotificationPreferencesClient {
  load(): Promise<NotificationSettings>;
  save(change: NotificationPreferenceChange): Promise<NotificationSettings>;
}

const settingsSchema = z.object({
  personId: z.number().int().positive(),
  categories: z.array(z.enum(notificationCategories)),
  preferences: z
    .record(
      z.enum(notificationCategories),
      z.object({ channels: z.record(z.boolean()) })
    )
    .nullable(),
  status: z.enum(["ready", "uninitialized", "unavailable"]),
});

export function createNotificationPreferencesClient(
  fetcher: typeof fetch = fetch
): NotificationPreferencesClient {
  async function request(change?: NotificationPreferenceChange) {
    const response = await fetcher("/api/notification-preferences", {
      method: change ? "POST" : "GET",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      ...(change ? { body: JSON.stringify(change) } : {}),
    });
    if (!response.ok)
      throw new Error("Notification preferences could not be saved or loaded.");
    return settingsSchema.parse(await response.json());
  }
  return { load: () => request(), save: (change) => request(change) };
}
