import type { NotificationTransport } from "./transport.server";

export function noopNotificationTransport(): NotificationTransport {
  return {
    available: false,
    async trigger(event) {
      console.info(`Notifications disabled: skipped ${event.idempotencyKey}.`);
    },
    async identify(person) {
      console.info(
        `Notifications disabled: skipped identity sync for person ${person.id}.`
      );
    },
    async getPreferences() {
      return null;
    },
    async initializePreferences(personId) {
      console.info(
        `Notifications disabled: skipped preference initialization for person ${personId}.`
      );
      return null;
    },
    async setPreference() {
      throw new Error(
        "Notification preferences are unavailable in this environment."
      );
    },
  };
}
