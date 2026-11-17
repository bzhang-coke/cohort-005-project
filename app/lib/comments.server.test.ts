import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import { comments, lessons, modules } from "~/db/schema";
import { createComment, deleteComment, updateComment } from "./comments.server";

const NOW = new Date("2026-11-17T12:00:00.000Z");

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lesson: typeof lessons.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  const module = db
    .insert(modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  lesson = db
    .insert(lessons)
    .values({ moduleId: module.id, title: "First lesson", position: 1 })
    .returning()
    .get();
});

describe("deleting discussion comments", () => {
  it("lets course staff delete a comment and keeps repeated deletion unchanged", () => {
    const question = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "My question.",
      NOW
    );
    const deleted = deleteComment(
      db,
      question.id,
      base.instructor.id,
      true,
      NOW
    );

    expect(deleted).toEqual({
      ...question,
      deletedAt: "2026-11-17T12:00:00.000Z",
    });
    expect(
      deleteComment(
        db,
        question.id,
        base.instructor.id,
        true,
        new Date("2026-11-18T12:00:00.000Z")
      )
    ).toEqual(deleted);
    expect(db.select().from(comments).all()).toEqual([deleted]);
  });

  it("refuses a non-author without course staff permission", () => {
    const question = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "My question.",
      NOW
    );

    expect(() =>
      deleteComment(db, question.id, base.instructor.id, false, NOW)
    ).toThrow("You can only delete your own comments");
    expect(db.select().from(comments).all()).toEqual([question]);
  });

  it("soft deletes the author's Discussion Question and preserves its replies and unrelated content", () => {
    const question = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "My question.",
      NOW
    );
    const reply = createComment(
      db,
      base.instructor.id,
      lesson.id,
      question.id,
      "An answer.",
      NOW
    );
    const unrelated = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "Another question.",
      NOW
    );

    const deleted = deleteComment(db, question.id, base.user.id, false, NOW);

    expect(deleted).toEqual({
      ...question,
      deletedAt: "2026-11-17T12:00:00.000Z",
    });
    expect(db.select().from(comments).all()).toEqual([
      deleted,
      reply,
      unrelated,
    ]);
  });
});

describe("editing discussion comments", () => {
  it("refuses to edit a deleted comment", () => {
    const deleted = db
      .insert(comments)
      .values({
        userId: base.user.id,
        lessonId: lesson.id,
        body: "Deleted question.",
        deletedAt: NOW.toISOString(),
      })
      .returning()
      .get();

    expect(() =>
      updateComment(db, deleted.id, base.user.id, "Restored?", NOW)
    ).toThrow("Comment has been deleted");
    expect(db.select().from(comments).all()).toEqual([deleted]);
  });

  it.each([
    [" \n ", "Comment cannot be empty"],
    ["a".repeat(5001), "Comment must be 5000 characters or fewer"],
  ])(
    "rejects an invalid edit without changing the original (%#)",
    (body, error) => {
      const question = createComment(
        db,
        base.user.id,
        lesson.id,
        null,
        "My question.",
        NOW
      );

      expect(() =>
        updateComment(db, question.id, base.user.id, body, NOW)
      ).toThrow(error);
      expect(db.select().from(comments).all()).toEqual([question]);
    }
  );

  it("refuses edits by someone other than the author, including the Instructor", () => {
    const question = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "My question.",
      NOW
    );

    expect(() =>
      updateComment(db, question.id, base.instructor.id, "Overwritten.", NOW)
    ).toThrow("You can only edit your own comments");
    expect(db.select().from(comments).all()).toEqual([question]);
  });

  it("edits the author's comment without changing its replies or creation time", () => {
    const question = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "How does this work?",
      NOW
    );
    const reply = createComment(
      db,
      base.instructor.id,
      lesson.id,
      question.id,
      "Here is how.",
      NOW
    );

    const updated = updateComment(
      db,
      question.id,
      base.user.id,
      "  A clearer question.  ",
      new Date("2026-11-17T13:00:00.000Z")
    );

    expect(updated).toEqual({
      ...question,
      body: "A clearer question.",
      editedAt: "2026-11-17T13:00:00.000Z",
    });
    expect(db.select().from(comments).all()).toEqual([updated, reply]);
  });
});

describe("creating discussion comments", () => {
  it("creates a Discussion Reply but refuses another level of replies", () => {
    const question = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "How does this work?",
      NOW
    );
    const reply = createComment(
      db,
      base.instructor.id,
      lesson.id,
      question.id,
      "  Here is how.  ",
      NOW
    );

    expect(reply).toMatchObject({
      userId: base.instructor.id,
      lessonId: lesson.id,
      parentId: question.id,
      body: "Here is how.",
      createdAt: "2026-11-17T12:00:00.000Z",
    });
    expect(() =>
      createComment(
        db,
        base.user.id,
        lesson.id,
        reply.id,
        "A nested reply.",
        NOW
      )
    ).toThrow("Replies can only be one level deep");
    expect(db.select().from(comments).all()).toEqual([question, reply]);
  });

  it("keeps Discussion Replies on their Discussion Question's lesson", () => {
    const otherLesson = db
      .insert(lessons)
      .values({ moduleId: lesson.moduleId, title: "Other lesson", position: 2 })
      .returning()
      .get();
    const question = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "How does this work?",
      NOW
    );

    expect(() =>
      createComment(
        db,
        base.instructor.id,
        otherLesson.id,
        question.id,
        "An answer.",
        NOW
      )
    ).toThrow("Parent comment belongs to a different lesson");
    expect(db.select().from(comments).all()).toEqual([question]);
  });

  it("rejects a missing parent without saving a Discussion Reply", () => {
    expect(() =>
      createComment(db, base.instructor.id, lesson.id, 999, "An answer.", NOW)
    ).toThrow("Parent comment not found");
    expect(db.select().from(comments).all()).toEqual([]);
  });

  it("rejects a missing lesson without saving a Discussion Question", () => {
    expect(() =>
      createComment(db, base.user.id, 999, null, "Where is this lesson?", NOW)
    ).toThrow("Lesson not found");
    expect(db.select().from(comments).all()).toEqual([]);
  });

  it("accepts 5000 trimmed characters and rejects longer bodies without saving", () => {
    const question = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      ` ${"a".repeat(5000)} `,
      NOW
    );

    expect(question.body).toHaveLength(5000);
    expect(() =>
      createComment(db, base.user.id, lesson.id, null, "a".repeat(5001), NOW)
    ).toThrow("Comment must be 5000 characters or fewer");
    expect(db.select().from(comments).all()).toEqual([question]);
  });

  it("rejects a Discussion Question with a whitespace-only body", () => {
    expect(() =>
      createComment(db, base.user.id, lesson.id, null, " \n\t ", NOW)
    ).toThrow("Comment cannot be empty");
    expect(db.select().from(comments).all()).toEqual([]);
  });

  it("creates a trimmed Discussion Question at the supplied time", () => {
    const question = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "  How does this work? \n",
      NOW
    );

    expect(question).toEqual({
      id: expect.any(Number),
      userId: base.user.id,
      lessonId: lesson.id,
      parentId: null,
      body: "How does this work?",
      createdAt: "2026-11-17T12:00:00.000Z",
      editedAt: null,
      deletedAt: null,
    });
    expect(db.select().from(comments).all()).toEqual([question]);
  });
});
