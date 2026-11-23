import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { listNotes } from "~/lib/notes.server";
import { listBookmarks } from "~/lib/bookmarks.server";
import { createLessons } from "../index.server";
import { fixture, otherLesson, request, watchRequest, NOW } from "./fixtures";

let f: ReturnType<typeof fixture>;
afterEach(() => {
  f?.db.$client.close();
  vi.restoreAllMocks();
});

function commands(): Record<string, string>[] {
  return [
    { intent: "mark-complete" },
    { intent: "toggle-bookmark" },
    { intent: "save-note", body: "Denied note" },
    { intent: "create-comment", body: "Denied Discussion" },
    {
      intent: "edit-comment",
      commentId: String(f.question.id),
      body: "Denied edit",
    },
    { intent: "delete-comment", commentId: String(f.question.id) },
    { intent: "submit-quiz", quizId: String(f.quiz.id) },
  ] satisfies Record<string, string>[];
}

describe("all Lesson mutations cross the same permission seam", () => {
  it("rejects every mutation for a Lapsed Student without altering their saved work or sending Notifications", async () => {
    f = fixture();
    f.db
      .delete(schema.enrollments)
      .where(eq(schema.enrollments.userId, f.user.id))
      .run();
    for (const fields of commands()) {
      await expect(
        f.lessonModule.submit(await request(f.user.id, fields), f.path)
      ).rejects.toMatchObject({ init: { status: 403 } });
    }
    expect(listNotes(f.db, f.user.id)).toMatchObject([
      { body: "PRIVATE_NOTE" },
    ]);
    expect(listBookmarks(f.db, f.user.id)).toHaveLength(1);
    expect(f.notifications.sent).toEqual([]);
    f.db
      .insert(schema.enrollments)
      .values({ userId: f.user.id, courseId: f.course.id })
      .run();
    const page = await f.lessonModule.open(await request(f.user.id), f.path);
    expect(page).toMatchObject({
      bookmarked: true,
      learning: { lessonStatus: "in_progress", bestAttempt: null },
      comments: [{ body: "PRIVATE_DISCUSSION" }],
    });
  });

  it("requires a current identity for every write and rejects a mismatched Lesson before any effect", async () => {
    f = fixture();
    const other = otherLesson(f);
    for (const fields of commands()) {
      await expect(
        f.lessonModule.submit(await request(undefined, fields), f.path)
      ).rejects.toMatchObject({ init: { status: 401 } });
      await expect(
        f.lessonModule.submit(await request(999999, fields), f.path)
      ).rejects.toMatchObject({ init: { status: 401 } });
      await expect(
        f.lessonModule.submit(await request(f.user.id, fields), {
          ...f.path,
          lessonId: String(other.lesson.id),
        })
      ).rejects.toMatchObject({ init: { status: 404 } });
    }
    await expect(
      f.lessonModule.recordWatch(
        await watchRequest(undefined, {
          lessonId: f.lesson.id,
          positionSeconds: 10,
        })
      )
    ).rejects.toMatchObject({ init: { status: 401 } });
    expect(f.notifications.sent).toEqual([]);
  });

  it("rejects malformed parameters, unknown intents, malformed JSON, and duplicate quiz answers as 400", async () => {
    f = fixture();
    await expect(
      f.lessonModule.open(await request(), { ...f.path, lessonId: "NaN" })
    ).rejects.toMatchObject({ init: { status: 400 } });
    await expect(
      f.lessonModule.submit(
        await request(f.user.id, { intent: "unexpected" }),
        f.path
      )
    ).rejects.toMatchObject({ init: { status: 400 } });
    await expect(
      f.lessonModule.recordWatch(
        new Request("http://localhost/watch", {
          method: "POST",
          body: "{",
          headers: { "Content-Type": "application/json" },
        })
      )
    ).rejects.toMatchObject({ init: { status: 400 } });
    await expect(
      f.lessonModule.recordWatch(
        await watchRequest(f.user.id, {
          lessonId: f.lesson.id,
          positionSeconds: -1,
        })
      )
    ).rejects.toMatchObject({ init: { status: 400 } });
    const base = await request(f.user.id);
    const form = new URLSearchParams({
      intent: "submit-quiz",
      quizId: String(f.quiz.id),
    });
    form.append("question-" + f.quizQuestion.id, String(f.correct.id));
    form.append("question-" + f.quizQuestion.id, String(f.wrong.id));
    await expect(
      f.lessonModule.submit(
        new Request(base.url, {
          method: "POST",
          headers: base.headers,
          body: form,
        }),
        f.path
      )
    ).rejects.toMatchObject({ init: { status: 400 } });
  });

  it("returns correctable Note and Discussion text errors while preserving their contents", async () => {
    f = fixture();
    for (const intent of ["save-note", "create-comment", "edit-comment"]) {
      expect(
        await f.lessonModule.submit(
          await request(f.user.id, {
            intent,
            body: "  ",
            commentId: String(f.question.id),
          }),
          f.path
        )
      ).toMatchObject({ ok: false, error: expect.any(String) });
    }
    expect(
      await f.lessonModule.open(await request(f.user.id), f.path)
    ).toMatchObject({
      note: { body: "PRIVATE_NOTE" },
      comments: [{ body: "PRIVATE_DISCUSSION" }],
    });
    expect(f.notifications.sent).toEqual([]);
  });
});

describe("permission changes and Notifications", () => {
  it("rechecks Enrollment after asynchronous Notification initialization", async () => {
    f = fixture();
    const module = createLessons({
      database: f.db,
      now: () => NOW,
      notifications: async () => {
        f.db
          .delete(schema.enrollments)
          .where(eq(schema.enrollments.userId, f.user.id))
          .run();
        return f.notifications;
      },
    });
    await expect(
      module.submit(
        await request(f.user.id, {
          intent: "create-comment",
          body: "Revoked while waiting",
        }),
        f.path
      )
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(f.notifications.sent).toEqual([]);
    f.db
      .insert(schema.enrollments)
      .values({ userId: f.user.id, courseId: f.course.id })
      .run();
    expect(await module.open(await request(f.user.id), f.path)).toMatchObject({
      comments: [{ body: "PRIVATE_DISCUSSION" }],
    });
  });

  it("commits a Discussion before delivery and preserves it when Notifications fail", async () => {
    f = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.notifications.failWith(new Error("Offline"));
    expect(
      await f.lessonModule.submit(
        await request(f.user.id, {
          intent: "create-comment",
          body: "Keep my Discussion",
        }),
        f.path
      )
    ).toEqual({ ok: true });
    expect(
      await f.lessonModule.open(await request(f.user.id), f.path)
    ).toMatchObject({
      comments: expect.arrayContaining([
        expect.objectContaining({ body: "Keep my Discussion" }),
      ]),
    });
  });

  it("allows course moderation without Enrollment, but rejects an unrelated Instructor", async () => {
    f = fixture();
    const outsider = f.db
      .insert(schema.users)
      .values({
        name: "Other Instructor",
        email: "other@example.com",
        role: schema.UserRole.Instructor,
      })
      .returning()
      .get();
    await expect(
      f.lessonModule.replyFromInstructorQueue(
        await request(outsider.id, {
          intent: "reply",
          commentId: String(f.question.id),
          body: "Not my course",
        })
      )
    ).rejects.toMatchObject({ init: { status: 403 } });
    await f.lessonModule.submit(
      await request(f.instructor.id, {
        intent: "delete-comment",
        commentId: String(f.question.id),
      }),
      f.path
    );
    expect(
      await f.lessonModule.open(await request(f.user.id), f.path)
    ).toMatchObject({ comments: [] });
  });
});

describe("publication and personal privacy", () => {
  it("allows a Platform Admin to read Draft content but not record Student activity without Enrollment", async () => {
    f = fixture();
    const admin = f.db
      .insert(schema.users)
      .values({
        name: "Platform Admin",
        email: "admin@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    f.db
      .update(schema.courses)
      .set({ status: schema.CourseStatus.Draft })
      .where(eq(schema.courses.id, f.course.id))
      .run();
    expect(
      await f.lessonModule.open(await request(admin.id), f.path)
    ).toMatchObject({
      kind: "content",
      learning: null,
      note: null,
      bookmarked: false,
      canModerate: true,
    });
    await expect(
      f.lessonModule.submit(
        await request(admin.id, { intent: "mark-complete" }),
        f.path
      )
    ).rejects.toMatchObject({ init: { status: 403 } });
    await expect(
      f.lessonModule.recordWatch(
        await watchRequest(admin.id, {
          lessonId: f.lesson.id,
          positionSeconds: 10,
        })
      )
    ).rejects.toMatchObject({ init: { status: 403 } });
    await expect(
      f.lessonModule.submit(
        await request(admin.id, {
          intent: "submit-quiz",
          quizId: String(f.quiz.id),
        }),
        f.path
      )
    ).rejects.toMatchObject({ init: { status: 403 } });
  });

  it("keeps Draft/Archived outlines private while a country-blocked Student can still read their own saved work", async () => {
    f = fixture();
    f.db
      .update(schema.courses)
      .set({ status: schema.CourseStatus.Draft })
      .where(eq(schema.courses.id, f.course.id))
      .run();
    await expect(
      f.lessonModule.outline(await request(f.user.id), { slug: f.course.slug })
    ).rejects.toMatchObject({ init: { status: 404 } });
    expect(
      await f.lessonModule.outline(await request(f.instructor.id), {
        slug: f.course.slug,
      })
    ).toMatchObject({ course: { id: f.course.id } });
    f.db
      .update(schema.courses)
      .set({
        status: schema.CourseStatus.Archived,
        price: 7900,
        pppEnabled: true,
      })
      .where(eq(schema.courses.id, f.course.id))
      .run();
    f.db
      .insert(schema.purchases)
      .values({
        userId: f.user.id,
        courseId: f.course.id,
        country: "IN",
        amountPaid: 3950,
      })
      .run();
    await expect(
      f.lessonModule.outline(await request(), { slug: f.course.slug })
    ).rejects.toMatchObject({ init: { status: 404 } });
    await expect(
      f.lessonModule.open(await request(f.user.id), f.path)
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(listNotes(f.db, f.user.id)).toMatchObject([
      { body: "PRIVATE_NOTE" },
    ]);
    expect(listBookmarks(f.db, f.user.id)).toHaveLength(1);
    expect(listNotes(f.db, f.instructor.id)).toEqual([]);
  });

  it("leaves no quiz attempt when its answer writes fail", async () => {
    f = fixture();
    const question = f.db
      .insert(schema.quizQuestions)
      .values({
        quizId: f.quiz.id,
        questionText: "Second",
        questionType: schema.QuestionType.MultipleChoice,
        position: 2,
      })
      .returning()
      .get();
    const option = f.db
      .insert(schema.quizOptions)
      .values({
        questionId: question.id,
        optionText: "Second answer",
        isCorrect: true,
      })
      .returning()
      .get();
    f.db.$client.exec(
      "CREATE TRIGGER fail_second_answer BEFORE INSERT ON quiz_answers WHEN EXISTS (SELECT 1 FROM quiz_answers WHERE attempt_id = NEW.attempt_id) BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END"
    );
    const fields = {
      intent: "submit-quiz",
      quizId: String(f.quiz.id),
      ["question-" + f.quizQuestion.id]: String(f.correct.id),
      ["question-" + question.id]: String(option.id),
    };
    await expect(
      f.lessonModule.submit(await request(f.user.id, fields), f.path)
    ).rejects.toThrow("simulated storage failure");
    expect(
      await f.lessonModule.open(await request(f.user.id), f.path)
    ).toMatchObject({ learning: { bestAttempt: null } });
  });
});
