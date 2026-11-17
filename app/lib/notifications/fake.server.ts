import {
  defaultNotificationFeedPreference,
  type NotificationDelivery,
  type CommentNotificationArchive,
  type NotificationPreferences,
} from "../notifications";
import type {
  NotificationPerson,
  NotificationTransport,
} from "./transport.server";

export function createFakeNotificationTransport() {
  const people = new Map<number, NotificationPerson>();
  const preferences = new Map<number, NotificationPreferences>();
  const triggers: NotificationDelivery[] = [];
  const deliveries: NotificationDelivery[] = [];
  const archives: CommentNotificationArchive[] = [];
  const archived = new Set<string>();
  const failures = new Set<
    | "identify"
    | "getPreferences"
    | "initializePreferences"
    | "setPreference"
    | "trigger"
    | "archiveComment"
  >();
  function checkFailure(
    operation:
      | "identify"
      | "getPreferences"
      | "initializePreferences"
      | "setPreference"
      | "trigger"
      | "archiveComment"
  ) {
    if (failures.has(operation))
      throw new Error(`Simulated Notification ${operation} failure.`);
  }
  const transport: NotificationTransport = {
    available: true,
    async trigger(event) {
      triggers.push(structuredClone(event));
      checkFailure("trigger");
      const recipientIds = event.recipientIds.filter(
        (id) =>
          preferences.get(id)?.[event.data.category]?.channels.feed ??
          defaultNotificationFeedPreference(event.data.category)
      );
      if (recipientIds.length)
        deliveries.push(structuredClone({ ...event, recipientIds }));
    },
    async archiveComment(source) {
      archives.push(structuredClone(source));
      checkFailure("archiveComment");
      for (const event of deliveries) {
        if (
          event.data.source.commentId === source.commentId &&
          (event.kind === "discussion-question-created" ||
            event.kind === "discussion-reply-created")
        )
          archived.add(event.idempotencyKey);
      }
    },
    async identify(person) {
      checkFailure("identify");
      people.set(person.id, structuredClone(person));
    },
    async getPreferences(personId) {
      checkFailure("getPreferences");
      return structuredClone(preferences.get(personId) ?? null);
    },
    async initializePreferences(personId, defaults) {
      checkFailure("initializePreferences");
      const existing = preferences.get(personId);
      if (existing) return structuredClone(existing);
      preferences.set(personId, structuredClone(defaults));
      return structuredClone(defaults);
    },
    async setPreference(personId, change) {
      checkFailure("setPreference");
      const existing = preferences.get(personId);
      if (!existing)
        throw new Error("Notification preferences are not initialized.");
      const updated = {
        ...existing,
        [change.category]: {
          channels: {
            ...existing[change.category]?.channels,
            [change.channel]: change.enabled,
          },
        },
      };
      preferences.set(personId, updated);
      return structuredClone(updated);
    },
  };
  return {
    ...transport,
    people,
    preferences,
    failures,
    triggers,
    deliveries,
    archives,
    archived,
    get activeDeliveries() {
      return deliveries.filter((event) => !archived.has(event.idempotencyKey));
    },
  };
}
