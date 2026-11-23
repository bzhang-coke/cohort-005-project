import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "~/db/schema";
import type { Notifications } from "~/lib/notifications.server";

export type Db = BetterSQLite3Database<typeof schema>;
export type LessonDependencies = {
  database: Db;
  notifications: () => Promise<Notifications>;
  now: () => Date;
};
export type LessonPath = { slug?: string; lessonId?: string };
export type OutlinePath = { slug?: string; moduleId?: string };
