import { afterEach, describe, expect, it } from "vitest";
import { fixture, otherLesson, request, watchRequest } from "./fixtures";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";

let f: ReturnType<typeof fixture>;
afterEach(() => f?.db.$client.close());

describe("Lesson previews", () => {
  it("returns only titles, curriculum and an enrollment explanation to a signed-out visitor", async () => {
    f = fixture();
    const page = await f.lessonModule.open(await request(), f.path);
    expect(page).toEqual({
      kind: "preview",
      course: { id: f.course.id, title: "Test Course", slug: "test-course" },
      module: { id: f.section.id, title: "Basics" },
      lesson: { id: f.lesson.id, title: "First lesson" },
      curriculum: [
        {
          id: f.section.id,
          title: "Basics",
          lessons: [{ id: f.lesson.id, title: "First lesson" }],
        },
      ],
      restriction: { kind: "enrollment-required" },
    });
    expect(JSON.stringify(page)).not.toContain("PRIVATE_");
  });
});

it("hides Draft Lessons from enrolled Students and keeps Archived Lessons for existing Enrollments", async () => {
  f = fixture();
  f.db
    .update(schema.courses)
    .set({ status: schema.CourseStatus.Draft })
    .where(eq(schema.courses.id, f.course.id))
    .run();
  await expect(
    f.lessonModule.open(await request(f.user.id), f.path)
  ).rejects.toMatchObject({ init: { status: 404 } });
  expect(
    await f.lessonModule.open(await request(f.instructor.id), f.path)
  ).toMatchObject({ kind: "content", learning: null });
  f.db
    .update(schema.courses)
    .set({ status: schema.CourseStatus.Archived })
    .where(eq(schema.courses.id, f.course.id))
    .run();
  await expect(
    f.lessonModule.open(await request(), f.path)
  ).rejects.toMatchObject({ init: { status: 404 } });
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ kind: "content" });
});

it("opens an enrolled Student's Lesson with their own work and no quiz answer keys", async () => {
  f = fixture();
  const page = await f.lessonModule.open(await request(f.user.id), f.path);
  expect(page.kind).toBe("content");
  expect(page).toMatchObject({
    contentHtml: "<p>PRIVATE_LESSON_BODY</p>\n",
    note: { body: "PRIVATE_NOTE" },
    bookmarked: true,
    learning: {
      lessonStatus: "in_progress",
      bestAttempt: null,
      lastWatchPosition: 0,
      watchProgress: 0,
    },
    quiz: { title: "PRIVATE_QUIZ" },
  });
  expect(JSON.stringify(page)).not.toContain("isCorrect");
});

it("saves only the current person's Note and rejects a later write after Enrollment ends", async () => {
  f = fixture();
  expect(
    await f.lessonModule.submit(
      await request(f.user.id, {
        intent: "save-note",
        body: "My revised note",
        userId: String(f.instructor.id),
      }),
      f.path
    )
  ).toEqual({ ok: true });
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ note: { body: "My revised note" } });
  expect(
    await f.lessonModule.open(await request(f.instructor.id), f.path)
  ).toMatchObject({ note: null });
  f.db
    .delete(schema.enrollments)
    .where(eq(schema.enrollments.userId, f.user.id))
    .run();
  await expect(
    f.lessonModule.submit(
      await request(f.user.id, { intent: "save-note", body: "Denied edit" }),
      f.path
    )
  ).rejects.toMatchObject({ init: { status: 403 } });
  f.db
    .insert(schema.enrollments)
    .values({ userId: f.user.id, courseId: f.course.id })
    .run();
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ note: { body: "My revised note" } });
});

it("requires Enrollment for completion even when the Instructor can read the Lesson", async () => {
  f = fixture();
  await expect(
    f.lessonModule.submit(
      await request(f.instructor.id, { intent: "mark-complete" }),
      f.path
    )
  ).rejects.toMatchObject({ init: { status: 403 } });
  await f.lessonModule.submit(
    await request(f.user.id, { intent: "mark-complete" }),
    f.path
  );
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ learning: { lessonStatus: "completed" } });
});

it("records watch events only when the Student may currently read the Lesson", async () => {
  f = fixture();
  f.db
    .update(schema.courses)
    .set({ price: 7900, pppEnabled: true })
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
    f.lessonModule.recordWatch(
      await watchRequest(f.user.id, {
        lessonId: f.lesson.id,
        positionSeconds: 500,
      })
    )
  ).rejects.toMatchObject({ init: { status: 403 } });
  const preview = await f.lessonModule.open(await request(f.user.id), f.path);
  expect(preview).toMatchObject({
    kind: "preview",
    restriction: {
      kind: "country-restricted",
      currentCountry: "US",
      purchaseCountry: "IN",
    },
  });
  expect(JSON.stringify(preview)).not.toContain("PRIVATE_");
  expect(
    await f.lessonModule.open(await request(f.user.id, undefined, "IN"), f.path)
  ).toMatchObject({ learning: { lastWatchPosition: 0, watchProgress: 0 } });
  await f.lessonModule.recordWatch(
    await watchRequest(
      f.user.id,
      { lessonId: f.lesson.id, positionSeconds: 300 },
      "IN"
    )
  );
  expect(
    await f.lessonModule.open(await request(f.user.id, undefined, "IN"), f.path)
  ).toMatchObject({ learning: { lastWatchPosition: 300, watchProgress: 50 } });
});

it("binds a quiz and every answer to the Lesson before recording an attempt", async () => {
  f = fixture();
  const other = otherLesson(f);
  await expect(
    f.lessonModule.submit(
      await request(f.user.id, {
        intent: "submit-quiz",
        quizId: String(other.quiz.id),
      }),
      f.path
    )
  ).rejects.toMatchObject({ init: { status: 404 } });
  await expect(
    f.lessonModule.submit(
      await request(f.user.id, {
        intent: "submit-quiz",
        quizId: String(f.quiz.id),
        [`question-${f.quizQuestion.id}`]: String(other.option.id),
      }),
      f.path
    )
  ).rejects.toMatchObject({ init: { status: 400 } });
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ learning: { bestAttempt: null } });
  expect(
    await f.lessonModule.submit(
      await request(f.user.id, {
        intent: "submit-quiz",
        quizId: String(f.quiz.id),
        [`question-${f.quizQuestion.id}`]: String(f.correct.id),
      }),
      f.path
    )
  ).toMatchObject({
    quizResult: {
      score: 1,
      passed: true,
      grade: "A",
      totalCorrect: 1,
      totalQuestions: 1,
    },
  });
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ learning: { bestAttempt: { score: 1, passed: true } } });
});

it("binds Discussions to the actual course and preserves author-only edits", async () => {
  f = fixture();
  const other = otherLesson(f);
  await expect(
    f.lessonModule.submit(
      await request(f.user.id, {
        intent: "create-comment",
        body: "Cross-course post",
      }),
      { ...f.path, lessonId: String(other.lesson.id) }
    )
  ).rejects.toMatchObject({ init: { status: 404 } });
  await expect(
    f.lessonModule.submit(
      await request(f.instructor.id, {
        intent: "delete-comment",
        commentId: String(other.discussion.id),
      }),
      f.path
    )
  ).rejects.toMatchObject({ init: { status: 404 } });
  await expect(
    f.lessonModule.submit(
      await request(f.instructor.id, {
        intent: "edit-comment",
        commentId: String(f.question.id),
        body: "Rewrite someone else",
      }),
      f.path
    )
  ).rejects.toMatchObject({ init: { status: 403 } });
  expect(f.notifications.sent).toEqual([]);
  expect(
    await f.lessonModule.submit(
      await request(f.user.id, {
        intent: "create-comment",
        body: "A new Discussion Question",
      }),
      f.path
    )
  ).toEqual({ ok: true });
  expect(f.notifications.sent).toMatchObject([
    { kind: "discussion-question", recipient: { id: f.instructor.id } },
  ]);
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({
    comments: expect.arrayContaining([
      expect.objectContaining({ body: "A new Discussion Question" }),
    ]),
  });
});

it("resolves the Instructor queue's actual Lesson before posting a Discussion Reply", async () => {
  f = fixture();
  const fields = {
    intent: "reply",
    commentId: String(f.question.id),
    body: "Instructor explanation",
  };
  await expect(
    f.lessonModule.replyFromInstructorQueue(await request(f.user.id, fields))
  ).rejects.toMatchObject({ init: { status: 403 } });
  expect(
    await f.lessonModule.replyFromInstructorQueue(
      await request(f.instructor.id, fields)
    )
  ).toEqual({ ok: true });
  expect(f.notifications.sent).toMatchObject([
    { kind: "discussion-reply", recipient: { id: f.user.id } },
  ]);
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({
    comments: [
      {
        replies: [
          { body: "Instructor explanation", author: { id: f.instructor.id } },
        ],
      },
    ],
  });
});

it("lets a content-authorized Instructor keep a private Bookmark without Enrollment", async () => {
  f = fixture();
  expect(
    await f.lessonModule.submit(
      await request(f.instructor.id, { intent: "toggle-bookmark" }),
      f.path
    )
  ).toEqual({ ok: true, bookmarked: true });
  expect(
    await f.lessonModule.open(await request(f.instructor.id), f.path)
  ).toMatchObject({ bookmarked: true, learning: null });
  expect(
    await f.lessonModule.submit(
      await request(f.instructor.id, { intent: "toggle-bookmark" }),
      f.path
    )
  ).toEqual({ ok: true, bookmarked: false });
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ bookmarked: true });
});

it("shares a safe course outline and rejects a section from another Course", async () => {
  f = fixture();
  const other = otherLesson(f);
  const outline = await f.lessonModule.outline(await request(), {
    slug: f.course.slug,
  });
  expect(outline).toMatchObject({
    modules: [
      {
        title: "Basics",
        lessons: [
          { title: "First lesson", durationMinutes: 10, hasVideo: true },
        ],
      },
    ],
  });
  expect(JSON.stringify(outline)).not.toContain("PRIVATE_");
  expect(outline.modules[0].lessons[0]).not.toHaveProperty("content");
  expect(outline.modules[0].lessons[0]).not.toHaveProperty("videoUrl");
  await expect(
    f.lessonModule.outline(await request(), {
      slug: f.course.slug,
      moduleId: String(other.section.id),
    })
  ).rejects.toMatchObject({ init: { status: 404 } });
});
