import type {
  NotificationPreferenceChange,
  NotificationPreferences,
  NotificationDelivery,
  CommentNotificationArchive,
} from "../notifications";
import { createContext } from "react-router";

export type NotificationPerson = {
  id: number;
  name: string;
  email: string;
  avatarUrl: string | null;
};

export interface NotificationTransport {
  readonly available: boolean;
  trigger(event: NotificationDelivery): Promise<void>;
  archiveComment(source: CommentNotificationArchive): Promise<void>;
  identify(person: NotificationPerson): Promise<void>;
  // null means no person-owned preference set, never a confirmed default.
  getPreferences(personId: number): Promise<NotificationPreferences | null>;
  // Must preserve an existing set, including during overlapping syncs/saves.
  initializePreferences(
    personId: number,
    defaults: NotificationPreferences
  ): Promise<NotificationPreferences | null>;
  // Atomically merges just this category/channel; never replaces the set.
  setPreference(
    personId: number,
    change: NotificationPreferenceChange
  ): Promise<NotificationPreferences>;
}

export const notificationTransportContext =
  createContext<NotificationTransport | null>(null);
