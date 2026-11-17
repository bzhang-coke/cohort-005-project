import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  comments,
  courses,
  enrollments,
  lessons,
  modules,
  users,
  UserRole,
} from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";
import { action as lessonAction } from "./courses.$slug.lessons.$lessonId";
import { action as instructorAction } from "./instructor.questions";

// Replace only the connection boundary: actions, access checks, sessions, and
// Discussion services all use the real migrated database.
vi.mock("~/db", () => ({
  get db() {
    return db;
  },
}));

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lesson: typeof lessons.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  const module = db
    .insert(modules)
    .values({
      courseId: base.course.id,
      title: "Basics",
      position: 1,
    })
    .returning()
    .get();
  lesson = db
    .insert(lessons)
    .values({
      moduleId: module.id,
      title: "First lesson",
      position: 1,
    })
    .returning()
    .get();
  db.insert(enrollments)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
    })
    .run();
});

async function postAs(userId: number | null, fields: Record<string, string>) {
  const url = "http://localhost/discussion";
  const cookie =
    userId === null ? "" : await setCurrentUserId(new Request(url), userId);
  return new Request(url, {
    method: "POST",
    headers: { Cookie: cookie },
    body: new URLSearchParams(fields),
  });
}

function callLessonAction(request: Request, lessonId = lesson.id) {
  return lessonAction({
    request,
    params: { slug: base.course.slug, lessonId: String(lessonId) },
    context: new RouterContextProvider(),
    url: new URL(request.url),
    pattern: "/courses/:slug/lessons/:lessonId",
  });
}

function callInstructorAction(request: Request) {
  return instructorAction({
    request,
    params: {},
    context: new RouterContextProvider(),
    url: new URL(request.url),
    pattern: "/instructor/questions",
  });
}

describe("Instructor questions action", () => {
  it.each([false, true])(
    "requires the course's staff to post a Discussion Reply (signed in: %s)",
    async (signedIn) => {
      const question = db
        .insert(comments)
        .values({
          userId: base.user.id,
          lessonId: lesson.id,
          body: "How does this work?",
        })
        .returning()
        .get();
      const otherInstructor = db
        .insert(users)
        .values({
          name: "Other Instructor",
          email: "other@example.com",
          role: UserRole.Instructor,
        })
        .returning()
        .get();
      const request = await postAs(signedIn ? otherInstructor.id : null, {
        intent: "reply",
        commentId: String(question.id),
        body: "An answer.",
      });

      await expect(callInstructorAction(request)).rejects.toMatchObject({
        init: { status: signedIn ? 403 : 401 },
      });
      expect(db.select().from(comments).all()).toEqual([question]);
    }
  );

  it("keeps the service validation response for an empty Discussion Reply", async () => {
    const question = db
      .insert(comments)
      .values({
        userId: base.user.id,
        lessonId: lesson.id,
        body: "How does this work?",
      })
      .returning()
      .get();
    const request = await postAs(base.instructor.id, {
      intent: "reply",
      commentId: String(question.id),
      body: " \n ",
    });

    expect(await callInstructorAction(request)).toEqual({
      ok: false,
      error: "Comment cannot be empty",
    });
    expect(db.select().from(comments).all()).toEqual([question]);
  });

  it("saves an Instructor's Discussion Reply and returns the existing success response", async () => {
    const question = db
      .insert(comments)
      .values({
        userId: base.user.id,
        lessonId: lesson.id,
        body: "How does this work?",
      })
      .returning()
      .get();
    const request = await postAs(base.instructor.id, {
      intent: "reply",
      commentId: String(question.id),
      body: "  Here is how.  ",
    });

    expect(await callInstructorAction(request)).toEqual({ ok: true });
    expect(db.select().from(comments).all()).toEqual([
      question,
      expect.objectContaining({
        userId: base.instructor.id,
        lessonId: lesson.id,
        parentId: question.id,
        body: "Here is how.",
      }),
    ]);
  });
});

describe("lesson discussion action", () => {
  it.each([UserRole.Student, UserRole.Instructor, UserRole.Admin])(
    "keeps deletion permission for a non-author %s",
    async (role) => {
      const actor =
        role === UserRole.Instructor
          ? base.instructor
          : db
              .insert(users)
              .values({
                name: "Discussion participant",
                email: "participant@example.com",
                role,
              })
              .returning()
              .get();
      if (role === UserRole.Student) {
        db.insert(enrollments)
          .values({ userId: actor.id, courseId: base.course.id })
          .run();
      }
      const question = db
        .insert(comments)
        .values({
          userId: base.user.id,
          lessonId: lesson.id,
          body: "My question.",
        })
        .returning()
        .get();
      const reply = db
        .insert(comments)
        .values({
          userId: base.instructor.id,
          lessonId: lesson.id,
          parentId: question.id,
          body: "An answer.",
        })
        .returning()
        .get();
      const request = await postAs(actor.id, {
        intent: "delete-comment",
        commentId: String(question.id),
      });
      const result = await callLessonAction(request);

      if (role === UserRole.Student) {
        expect(result).toEqual({
          ok: false,
          error: "You can only delete your own comments",
        });
        expect(db.select().from(comments).all()).toEqual([question, reply]);
      } else {
        expect(result).toEqual({ ok: true });
        expect(db.select().from(comments).all()).toEqual([
          { ...question, deletedAt: expect.any(String) },
          reply,
        ]);
      }
    }
  );

  it.each([false, true])(
    "requires content access to create comments (signed in: %s)",
    async (signedIn) => {
      const outsider = db
        .insert(users)
        .values({
          name: "Unenrolled Student",
          email: "outsider@example.com",
          role: UserRole.Student,
        })
        .returning()
        .get();
      const request = await postAs(signedIn ? outsider.id : null, {
        intent: "create-comment",
        body: "Should not be saved.",
      });

      await expect(callLessonAction(request)).rejects.toMatchObject({
        init: { status: signedIn ? 403 : 401 },
      });
      expect(db.select().from(comments).all()).toEqual([]);
    }
  );

  it.each(["edit-comment", "delete-comment"])(
    "scopes %s to the lesson in the URL",
    async (intent) => {
      const otherLesson = db
        .insert(lessons)
        .values({
          moduleId: lesson.moduleId,
          title: "Other lesson",
          position: 2,
        })
        .returning()
        .get();
      const otherComment = db
        .insert(comments)
        .values({
          userId: base.user.id,
          lessonId: otherLesson.id,
          body: "Another discussion.",
        })
        .returning()
        .get();
      const request = await postAs(base.user.id, {
        intent,
        commentId: String(otherComment.id),
        body: "Changed.",
      });

      await expect(callLessonAction(request)).rejects.toMatchObject({
        init: { status: 404 },
        data: "Comment not found",
      });
      expect(db.select().from(comments).all()).toEqual([otherComment]);
    }
  );

  it("preserves the missing-lesson creation response", async () => {
    const request = await postAs(base.user.id, {
      intent: "create-comment",
      body: "Where is this lesson?",
    });

    expect(await callLessonAction(request, 999)).toEqual({
      ok: false,
      error: "Lesson not found",
    });
    expect(db.select().from(comments).all()).toEqual([]);
  });

  it.each([
    [{ intent: "create-comment" }, "Enter a comment before posting."],
    [{ intent: "create-comment", body: " \n " }, "Comment cannot be empty"],
  ])(
    "preserves the comment validation response (%#)",
    async (fields, error) => {
      const request = await postAs(base.user.id, fields);

      expect(await callLessonAction(request)).toEqual({ ok: false, error });
      expect(db.select().from(comments).all()).toEqual([]);
    }
  );

  it("creates a Discussion Question and Discussion Reply with the existing success response", async () => {
    const questionRequest = await postAs(base.user.id, {
      intent: "create-comment",
      body: "  How does this work?  ",
    });

    expect(await callLessonAction(questionRequest)).toEqual({ ok: true });
    const question = db.select().from(comments).get();
    if (!question) throw new Error("Discussion Question was not saved");
    expect(question).toMatchObject({
      userId: base.user.id,
      lessonId: lesson.id,
      parentId: null,
      body: "How does this work?",
    });

    const replyRequest = await postAs(base.instructor.id, {
      intent: "create-comment",
      parentId: String(question.id),
      body: "  Here is how.  ",
    });
    expect(await callLessonAction(replyRequest)).toEqual({ ok: true });
    expect(db.select().from(comments).all()).toEqual([
      question,
      expect.objectContaining({
        userId: base.instructor.id,
        lessonId: lesson.id,
        parentId: question.id,
        body: "Here is how.",
      }),
    ]);
  });

  it("refuses a lesson belonging to another course even when the URL course is accessible", async () => {
    const otherCourse = db
      .insert(courses)
      .values({
        title: "Other course",
        slug: "other-course",
        description: "A separate course.",
        salesCopy: "Study something else.",
        status: base.course.status,
        instructorId: base.instructor.id,
        categoryId: base.category.id,
      })
      .returning()
      .get();
    const otherModule = db
      .insert(modules)
      .values({
        courseId: otherCourse.id,
        title: "Other module",
        position: 1,
      })
      .returning()
      .get();
    const otherLesson = db
      .insert(lessons)
      .values({
        moduleId: otherModule.id,
        title: "Private lesson",
        position: 1,
      })
      .returning()
      .get();
    const request = await postAs(base.user.id, {
      intent: "create-comment",
      body: "Should not be saved.",
    });

    await expect(
      callLessonAction(request, otherLesson.id)
    ).rejects.toMatchObject({
      init: { status: 404 },
      data: "Lesson not found in this course",
    });
    expect(db.select().from(comments).all()).toEqual([]);
  });
});
