export const notificationCategories = [
  "refundRequestUpdates",
  "seatClaims",
  "enrollments",
  "discussionQuestions",
  "openRefundRequests",
  "discussionReplies",
] as const;

export type NotificationCategory = (typeof notificationCategories)[number];
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
