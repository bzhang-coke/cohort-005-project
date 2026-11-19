import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "~/db/schema";
import { bookmarks, courses, lessons, modules, notes } from "~/db/schema";

type Db = BetterSQLite3Database<typeof schema>;

export const saveNoteSchema = z.object({
  body: z.string().trim().max(2000, "Notes must be 2,000 characters or fewer."),
});

export function isLessonBookmarked(db: Db, userId: number, lessonId: number) {
  return !!db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.lessonId, lessonId)))
    .get();
}

export function toggleBookmark(
  db: Db,
  userId: number,
  lessonId: number,
  now: Date
) {
  return db.transaction((tx) => {
    if (isLessonBookmarked(tx, userId, lessonId)) {
      tx.delete(bookmarks)
        .where(
          and(eq(bookmarks.userId, userId), eq(bookmarks.lessonId, lessonId))
        )
        .run();
      return false;
    }

    tx.insert(bookmarks)
      .values({ userId, lessonId, createdAt: now.toISOString() })
      .run();
    return true;
  });
}

export function getLessonNote(db: Db, userId: number, lessonId: number) {
  return db
    .select({
      body: notes.body,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
    .get();
}

export function saveNote(
  db: Db,
  userId: number,
  lessonId: number,
  body: string,
  now: Date
) {
  const parsed = saveNoteSchema.safeParse({ body });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message } as const;
  }

  const timestamp = now.toISOString();
  db.insert(notes)
    .values({
      userId,
      lessonId,
      body: parsed.data.body,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: parsed.data.body, updatedAt: timestamp },
    })
    .run();
  return { ok: true } as const;
}

const savedLessonColumns = {
  lessonId: lessons.id,
  lessonTitle: lessons.title,
  moduleTitle: modules.title,
  courseTitle: courses.title,
  courseSlug: courses.slug,
};

export function getSavedBookmarks(db: Db, userId: number) {
  return db
    .select({
      id: bookmarks.id,
      createdAt: bookmarks.createdAt,
      ...savedLessonColumns,
    })
    .from(bookmarks)
    .innerJoin(lessons, eq(bookmarks.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .all();
}

export function getSavedNotes(db: Db, userId: number) {
  return db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      ...savedLessonColumns,
    })
    .from(notes)
    .innerJoin(lessons, eq(notes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();
}
