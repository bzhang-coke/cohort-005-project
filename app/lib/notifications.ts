export const notificationCategories = [
  "refundRequestUpdates",
  "seatClaims",
  "enrollments",
  "discussionQuestions",
  "openRefundRequests",
  "discussionReplies",
] as const;

export type NotificationCategory = (typeof notificationCategories)[number];

export const notificationKinds = [
  "refund-request-confirmed",
  "refund-request-approved",
  "refund-request-declined",
  "refund-request-opened",
  "seat-claimed",
  "enrollment-created",
  "discussion-question-created",
  "discussion-reply-created",
] as const;
export type NotificationKind = (typeof notificationKinds)[number];
export type NotificationContent = {
  category: NotificationCategory;
  title: string;
  context: string;
  destination: string | null;
  source: {
    refundRequestId?: number;
    purchaseId?: number;
    commentId?: number;
    enrollmentId?: number;
    seatId?: number;
    courseId?: number;
    lessonId?: number;
  };
  snapshot: Record<string, string | number | null>;
};
export type NotificationEvent = {
  kind: NotificationKind;
  recordId: number | string;
  recipientIds: number[];
  actorId: number | null;
  data: NotificationContent;
};
export type NotificationDelivery = NotificationEvent & {
  idempotencyKey: string;
};
export type NotificationPreferenceChange = {
  category: NotificationCategory;
  channel: "feed";
  enabled: boolean;
};

export type NotificationPreferences = Partial<
  Record<NotificationCategory, { channels: Record<string, boolean> }>
>;

export type NotificationSettings = {
  personId: number;
  categories: NotificationCategory[];
  preferences: NotificationPreferences | null;
  status: "ready" | "uninitialized" | "unavailable";
};

export const notificationLabels: Record<NotificationCategory, string> = {
  refundRequestUpdates: "Refund Request updates",
  seatClaims: "Seat claims",
  enrollments: "Enrollments",
  discussionQuestions: "Discussion Questions",
  openRefundRequests: "Open Refund Requests",
  discussionReplies: "Discussion Replies",
};

export function defaultNotificationFeedPreference(
  category: NotificationCategory
) {
  return category !== "enrollments";
}

export function defaultNotificationPreferences(): NotificationPreferences {
  return Object.fromEntries(
    notificationCategories.map((category) => [
      category,
      { channels: { feed: defaultNotificationFeedPreference(category) } },
    ])
  );
}
