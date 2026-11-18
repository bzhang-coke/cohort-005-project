import { eq } from "drizzle-orm";
import type { db as database } from "../db";
import { coupons, courses, purchases, users, UserRole } from "../db/schema";
import {
  defaultNotificationPreferences,
  notificationCategories,
  type NotificationCategory,
  type NotificationSettings,
  type NotificationEvent,
  type CommentNotificationArchive,
} from "./notifications";
import type {
  NotificationPerson,
  NotificationTransport,
} from "./notifications/transport.server";
import { getNotificationTransport } from "./notifications/config.server";

export async function archiveCommentNotifications(
  source: CommentNotificationArchive,
  injectedTransport?: NotificationTransport
) {
  try {
    await (injectedTransport ?? getNotificationTransport()).archiveComment(
      source
    );
  } catch (error) {
    console.error(
      `Notification archival failed for comment ${source.commentId}.`,
      error
    );
  }
}

// Called only after the entire domain write commits. Each catalogue event is
// independent; a failed attempt must not stop another event or existing email.
export async function deliverNotification(
  event: NotificationEvent,
  injectedTransport?: NotificationTransport
) {
  try {
    const transport = injectedTransport ?? getNotificationTransport();
    let recipientIds = [...new Set(event.recipientIds)].filter(
      (id) => event.kind === "refund-request-confirmed" || id !== event.actorId
    );
    if (event.data.category === "enrollments") {
      const optedIn: number[] = [];
      for (const id of recipientIds) {
        const preferences = await transport.getPreferences(id);
        if (preferences?.enrollments?.channels.feed === true) optedIn.push(id);
      }
      recipientIds = optedIn;
    }
    if (!recipientIds.length) return;
    await transport.trigger({
      ...event,
      recipientIds,
      idempotencyKey: `cadence:${event.kind}:${event.recordId}`,
    });
  } catch (error) {
    console.error(
      `Notification delivery failed for ${event.kind}:${event.recordId}.`,
      error
    );
  }
}

export async function getNotificationSettings(
  db: typeof database,
  person: typeof users.$inferSelect,
  transport: NotificationTransport
): Promise<NotificationSettings> {
  const hasPurchase = Boolean(
    db
      .select({ id: purchases.id })
      .from(purchases)
      .where(eq(purchases.userId, person.id))
      .get()
  );
  const hasTeamLicence = Boolean(
    db
      .select({ id: coupons.id })
      .from(coupons)
      .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
      .where(eq(purchases.userId, person.id))
      .get()
  );
  const isInstructor =
    person.role === UserRole.Instructor ||
    Boolean(
      db
        .select({ id: courses.id })
        .from(courses)
        .where(eq(courses.instructorId, person.id))
        .get()
    );
  const applicable: Record<NotificationCategory, boolean> = {
    refundRequestUpdates: hasPurchase,
    seatClaims: hasTeamLicence,
    enrollments: isInstructor,
    discussionQuestions: isInstructor,
    openRefundRequests: person.role === UserRole.Admin,
    discussionReplies: true,
  };
  const categories = notificationCategories.filter(
    (category) => applicable[category]
  );
  const preferences = await transport.getPreferences(person.id);
  return {
    personId: person.id,
    categories,
    preferences,
    status: !transport.available
      ? "unavailable"
      : preferences
        ? "ready"
        : "uninitialized",
  };
}

export async function syncNotificationPerson(
  person: NotificationPerson,
  injectedTransport?: NotificationTransport | null
): Promise<"ready" | "failed" | "disabled"> {
  try {
    const transport = injectedTransport ?? getNotificationTransport();
    await transport.identify({
      id: person.id,
      name: person.name,
      email: person.email,
      avatarUrl: person.avatarUrl,
    });
    const preferences = await transport.initializePreferences(
      person.id,
      defaultNotificationPreferences()
    );
    return preferences ? "ready" : "disabled";
  } catch (error) {
    console.error(
      `Notification identity sync failed for person ${person.id}.`,
      error
    );
    return "failed";
  }
}

export async function backfillNotificationPeople(
  db: typeof database,
  transport?: NotificationTransport
) {
  const result = { ready: 0, failed: 0, disabled: 0 };
  for (const person of db.select().from(users).all()) {
    result[await syncNotificationPerson(person, transport)] += 1;
  }
  return result;
}
