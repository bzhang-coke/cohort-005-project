import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  getLessonNote,
  getSavedBookmarks,
  getSavedNotes,
  isLessonBookmarked,
  saveNote,
  toggleBookmark,
} from "./bookmarks-notes.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const LATER = new Date("2026-10-07T12:00:00.000Z");
const LATEST = new Date("2026-10-08T12:00:00.000Z");

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lesson: typeof schema.lessons.$inferSelect;
let otherStudent: typeof schema.users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  otherStudent = db
    .insert(schema.users)
    .values({
      name: "Another Student",
      email: "other@example.com",
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
  lesson = addLesson(base.course.id, "First lesson");
});

afterEach(() => db.$client.close());

function addLesson(courseId: number, title: string) {
  const module = db
    .insert(schema.modules)
    .values({ courseId, title: "Basics", position: 1 })
    .returning()
    .get();
  return db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title, position: 1 })
    .returning()
    .get();
}

describe("Bookmarks", () => {
  it("starts unbookmarked, toggles on and off, and can be bookmarked again", () => {
    expect(isLessonBookmarked(db, base.user.id, lesson.id)).toBe(false);
    expect(toggleBookmark(db, base.user.id, lesson.id, NOW)).toBe(true);
    expect(isLessonBookmarked(db, base.user.id, lesson.id)).toBe(true);
    expect(getSavedBookmarks(db, base.user.id)).toHaveLength(1);

    expect(toggleBookmark(db, base.user.id, lesson.id, LATER)).toBe(false);
    expect(isLessonBookmarked(db, base.user.id, lesson.id)).toBe(false);
    expect(getSavedBookmarks(db, base.user.id)).toEqual([]);

    expect(toggleBookmark(db, base.user.id, lesson.id, LATEST)).toBe(true);
    expect(getSavedBookmarks(db, base.user.id)).toMatchObject([
      { lessonTitle: "First lesson", createdAt: LATEST.toISOString() },
    ]);
  });

  it("toggling one Student's Bookmark leaves another Student's flag alone", () => {
    toggleBookmark(db, base.user.id, lesson.id, NOW);
    expect(isLessonBookmarked(db, otherStudent.id, lesson.id)).toBe(false);
    toggleBookmark(db, otherStudent.id, lesson.id, NOW);
    toggleBookmark(db, base.user.id, lesson.id, LATER);

    expect(isLessonBookmarked(db, base.user.id, lesson.id)).toBe(false);
    expect(isLessonBookmarked(db, otherStudent.id, lesson.id)).toBe(true);
  });

  it("the migrated database refuses a second Bookmark for the same Student and Lesson", () => {
    toggleBookmark(db, base.user.id, lesson.id, NOW);
    expect(() =>
      db
        .insert(schema.bookmarks)
        .values({ userId: base.user.id, lessonId: lesson.id })
        .run()
    ).toThrow();
    expect(getSavedBookmarks(db, base.user.id)).toHaveLength(1);
  });
});

describe("Notes", () => {
  it("has no Note before the Student saves, then keeps trimmed plain text and line breaks", () => {
    expect(getLessonNote(db, base.user.id, lesson.id)).toBeUndefined();
    expect(
      saveNote(
        db,
        base.user.id,
        lesson.id,
        "  # Heading\n*literal* <b>text</b>  ",
        NOW
      )
    ).toEqual({ ok: true });
    expect(getLessonNote(db, base.user.id, lesson.id)).toEqual({
      body: "# Heading\n*literal* <b>text</b>",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it("replaces the body and last-edited time while preserving the creation time", () => {
    saveNote(db, base.user.id, lesson.id, "First thought", NOW);
    saveNote(db, base.user.id, lesson.id, "  A clearer thought  ", LATER);

    expect(getLessonNote(db, base.user.id, lesson.id)).toEqual({
      body: "A clearer thought",
      createdAt: NOW.toISOString(),
      updatedAt: LATER.toISOString(),
    });
    expect(getSavedNotes(db, base.user.id)).toHaveLength(1);
  });

  it("saving a blank body preserves the Note and its creation time", () => {
    saveNote(db, base.user.id, lesson.id, "First thought", NOW);
    saveNote(db, base.user.id, lesson.id, " \n ", LATER);

    expect(getLessonNote(db, base.user.id, lesson.id)).toEqual({
      body: "",
      createdAt: NOW.toISOString(),
      updatedAt: LATER.toISOString(),
    });
    expect(getSavedNotes(db, base.user.id)).toHaveLength(1);
  });

  it("accepts exactly 2,000 characters after trimming", () => {
    const body = "a".repeat(2000);
    expect(saveNote(db, base.user.id, lesson.id, `  ${body}  `, NOW)).toEqual({
      ok: true,
    });
    expect(getLessonNote(db, base.user.id, lesson.id)?.body).toBe(body);
  });

  it("refuses 2,001 characters without creating or truncating a Note", () => {
    expect(
      saveNote(db, base.user.id, lesson.id, "a".repeat(2001), NOW)
    ).toEqual({
      ok: false,
      error: "Notes must be 2,000 characters or fewer.",
    });
    expect(getLessonNote(db, base.user.id, lesson.id)).toBeUndefined();
  });

  it("a refused save leaves the existing body and last-edited time intact", () => {
    saveNote(db, base.user.id, lesson.id, "Keep this", NOW);
    expect(
      saveNote(db, base.user.id, lesson.id, "a".repeat(2001), LATER).ok
    ).toBe(false);
    expect(getLessonNote(db, base.user.id, lesson.id)).toEqual({
      body: "Keep this",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it("another Student sees only their own Note on the same Lesson", () => {
    saveNote(db, base.user.id, lesson.id, "Private thought", NOW);
    expect(getLessonNote(db, otherStudent.id, lesson.id)).toBeUndefined();
    saveNote(db, otherStudent.id, lesson.id, "Different thought", LATER);

    expect(getLessonNote(db, base.user.id, lesson.id)?.body).toBe(
      "Private thought"
    );
    expect(getLessonNote(db, otherStudent.id, lesson.id)?.body).toBe(
      "Different thought"
    );
  });

  it("the migrated database refuses a second Note for the same Student and Lesson", () => {
    saveNote(db, base.user.id, lesson.id, "Keep this", NOW);
    expect(() =>
      db
        .insert(schema.notes)
        .values({
          userId: base.user.id,
          lessonId: lesson.id,
          body: "Duplicate",
        })
        .run()
    ).toThrow();
    expect(getSavedNotes(db, base.user.id)).toMatchObject([
      { body: "Keep this" },
    ]);
  });
});

describe("Saved lists", () => {
  it("starts empty for a Student who has not saved anything", () => {
    expect(getSavedBookmarks(db, base.user.id)).toEqual([]);
    expect(getSavedNotes(db, base.user.id)).toEqual([]);
  });

  it("lists only the current Student's items, newest first, with their Lesson and Course", () => {
    const otherCourse = db
      .insert(schema.courses)
      .values({
        title: "Another course",
        slug: "another-course",
        description: "Another course",
        salesCopy: "Another course",
        status: schema.CourseStatus.Published,
        instructorId: base.instructor.id,
        categoryId: base.category.id,
      })
      .returning()
      .get();
    const otherLesson = addLesson(otherCourse.id, "Another lesson");
    toggleBookmark(db, base.user.id, lesson.id, NOW);
    toggleBookmark(db, base.user.id, otherLesson.id, LATER);
    toggleBookmark(db, otherStudent.id, lesson.id, LATEST);
    saveNote(db, base.user.id, lesson.id, "Original", NOW);
    saveNote(db, base.user.id, otherLesson.id, "Second course", LATER);
    saveNote(db, otherStudent.id, lesson.id, "Someone else's Note", LATEST);

    expect(getSavedBookmarks(db, base.user.id)).toMatchObject([
      {
        lessonId: otherLesson.id,
        lessonTitle: "Another lesson",
        moduleTitle: "Basics",
        courseTitle: "Another course",
        courseSlug: "another-course",
      },
      {
        lessonId: lesson.id,
        lessonTitle: "First lesson",
        moduleTitle: "Basics",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      },
    ]);
    expect(getSavedNotes(db, base.user.id)).toMatchObject([
      {
        body: "Second course",
        lessonId: otherLesson.id,
        lessonTitle: "Another lesson",
        courseTitle: "Another course",
        courseSlug: "another-course",
      },
      {
        body: "Original",
        lessonId: lesson.id,
        lessonTitle: "First lesson",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      },
    ]);

    saveNote(db, base.user.id, lesson.id, "Edited most recently", LATEST);
    expect(getSavedNotes(db, base.user.id).map((note) => note.body)).toEqual([
      "Edited most recently",
      "Second course",
    ]);
  });

  it("does not grant the Instructor or a Platform Admin access to Student Notes", () => {
    const admin = db
      .insert(schema.users)
      .values({
        name: "Platform Admin",
        email: "admin@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    saveNote(db, base.user.id, lesson.id, "Private thought", NOW);
    toggleBookmark(db, base.user.id, lesson.id, NOW);

    for (const person of [base.instructor, admin]) {
      expect(getSavedNotes(db, person.id)).toEqual([]);
      expect(getLessonNote(db, person.id, lesson.id)).toBeUndefined();
      expect(getSavedBookmarks(db, person.id)).toEqual([]);
    }
  });

  it("approving a Refund keeps Bookmarks and Notes so the Student can resume after re-enrolling", async () => {
    const notifications = fakeNotifications();
    const admin = db
      .insert(schema.users)
      .values({
        name: "Platform Admin",
        email: "admin@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: NOW.toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    toggleBookmark(db, base.user.id, lesson.id, NOW);
    saveNote(db, base.user.id, lesson.id, "Pick up here", NOW);
    const request = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "Not what I expected",
      LATER,
      notifications
    );
    if (!request.ok) throw new Error(request.error);

    const result = await approveRefundRequest(
      db,
      request.refundRequestId,
      admin.id,
      null,
      LATER,
      notifications
    );
    expect(result.ok).toBe(true);
    expect(isLessonBookmarked(db, base.user.id, lesson.id)).toBe(true);
    expect(getLessonNote(db, base.user.id, lesson.id)).toEqual({
      body: "Pick up here",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(getSavedBookmarks(db, base.user.id)).toHaveLength(1);
    expect(getSavedNotes(db, base.user.id)).toHaveLength(1);

    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    expect(getLessonNote(db, base.user.id, lesson.id)?.body).toBe(
      "Pick up here"
    );
  });
});
