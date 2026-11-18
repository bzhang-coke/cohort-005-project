import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import {
  createMemoryRouter,
  RouterContextProvider,
  RouterProvider,
} from "react-router";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  comments,
  courses,
  enrollments,
  lessons,
  modules,
  purchases,
  users,
  UserRole,
} from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";
import { createFakeNotificationTransport } from "~/lib/notifications/fake.server";
import { notificationTransportContext } from "~/lib/notifications/transport.server";
import { CommentThread } from "~/components/comment-thread";
import {
  action as lessonAction,
  loader as lessonLoader,
} from "./courses.$slug.lessons.$lessonId";
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
let notifications: ReturnType<typeof createFakeNotificationTransport>;
let context: RouterContextProvider;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  notifications = createFakeNotificationTransport();
  context = new RouterContextProvider();
  context.set(notificationTransportContext, notifications);
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

afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
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
    context,
    url: new URL(request.url),
    pattern: "/courses/:slug/lessons/:lessonId",
  });
}

function callInstructorAction(request: Request) {
  return instructorAction({
    request,
    params: {},
    context,
    url: new URL(request.url),
    pattern: "/instructor/questions",
  });
}

async function loadDestination(userId: number | null, commentId: number) {
  const url = new URL(
    `http://localhost/courses/${base.course.slug}/lessons/${lesson.id}#comment-${commentId}`
  );
  const cookie =
    userId === null ? "" : await setCurrentUserId(new Request(url), userId);
  return lessonLoader({
    request: new Request(url, {
      headers: { Cookie: cookie, "CF-IPCountry": "US" },
    }),
    params: { slug: base.course.slug, lessonId: String(lesson.id) },
    context,
    url,
    pattern: "/courses/:slug/lessons/:lessonId",
  });
}

function renderDiscussion(result: Awaited<ReturnType<typeof loadDestination>>) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: createElement(CommentThread, {
        comments: result.comments,
        currentUserId: result.currentUserId,
        canModerate: result.canModerate,
        canPost: result.canViewContent,
        instructorName: result.instructorName,
      }),
    },
  ]);
  try {
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  } finally {
    router.dispose();
  }
}

describe("Discussion Notification destinations", () => {
  it("renders exact Question and Reply anchors, retaining the Reply anchor under a deleted parent", async () => {
    await callLessonAction(
      await postAs(base.user.id, {
        intent: "create-comment",
        body: "My question.",
      })
    );
    const question = db.select().from(comments).get();
    if (!question) throw new Error("Discussion Question was not saved");
    await callInstructorAction(
      await postAs(base.instructor.id, {
        intent: "reply",
        commentId: String(question.id),
        body: "The surviving answer.",
      })
    );
    const reply = db.select().from(comments).all()[1];
    if (!reply) throw new Error("Discussion Reply was not saved");

    const html = renderDiscussion(
      await loadDestination(base.user.id, reply.id)
    );
    expect(html).toContain(`id="comment-${question.id}"`);
    expect(html).toContain(`id="comment-${reply.id}"`);
    await callLessonAction(
      await postAs(base.user.id, {
        intent: "delete-comment",
        commentId: String(question.id),
      })
    );
    const afterDeletion = renderDiscussion(
      await loadDestination(base.user.id, reply.id)
    );
    expect(afterDeletion).toContain(`id="comment-${reply.id}"`);
    expect(afterDeletion).toContain("The surviving answer.");
    expect(afterDeletion).not.toContain("My question.");
    expect(
      notifications.activeDeliveries.map((event) => event.recordId)
    ).toEqual([reply.id]);
  });

  it.each(["signed out", "lapsed", "country blocked"])(
    "does not expose Discussion content from a Notification destination when %s",
    async (access) => {
      await callLessonAction(
        await postAs(base.user.id, {
          intent: "create-comment",
          body: "Confidential question.",
        })
      );
      const question = db.select().from(comments).get();
      if (!question) throw new Error("Discussion Question was not saved");
      if (access === "lapsed") {
        db.delete(enrollments)
          .where(eq(enrollments.userId, base.user.id))
          .run();
      } else if (access === "country blocked") {
        db.update(courses)
          .set({ price: 10000, pppEnabled: true })
          .where(eq(courses.id, base.course.id))
          .run();
        db.insert(purchases)
          .values({
            userId: base.user.id,
            courseId: base.course.id,
            amountPaid: 2500,
            country: "IN",
          })
          .run();
      }
      const destination = await loadDestination(
        access === "signed out" ? null : base.user.id,
        question.id
      );
      expect(destination.canViewContent).toBe(false);
      expect(destination.comments).toEqual([]);
      expect(renderDiscussion(destination)).not.toContain(
        "Confidential question."
      );
    }
  );
});

describe("Discussion action Notification failures and snapshots", () => {
  it.each(["lesson question", "lesson reply", "instructor reply"])(
    "keeps %s successful when Notification delivery fails",
    async (surface) => {
      const question =
        surface !== "lesson question"
          ? db
              .insert(comments)
              .values({
                userId: base.user.id,
                lessonId: lesson.id,
                body: "My question.",
              })
              .returning()
              .get()
          : null;
      notifications.failures.add("trigger");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fields: Record<string, string> =
        surface === "instructor reply"
          ? {
              intent: "reply",
              commentId: String(question?.id),
              body: "Saved despite provider failure.",
            }
          : {
              intent: "create-comment",
              ...(question ? { parentId: String(question.id) } : {}),
              body: "Saved despite provider failure.",
            };
      const request = await postAs(
        question ? base.instructor.id : base.user.id,
        fields
      );
      expect(
        await (surface === "instructor reply"
          ? callInstructorAction(request)
          : callLessonAction(request))
      ).toEqual({ ok: true });
      expect(db.select().from(comments).all().at(-1)?.body).toBe(
        "Saved despite provider failure."
      );
      expect(notifications.triggers).toHaveLength(1);
      expect(notifications.deliveries).toEqual([]);
    }
  );

  it("edits a saved comment without creating another Notification or changing the original snapshot", async () => {
    await callLessonAction(
      await postAs(base.user.id, {
        intent: "create-comment",
        body: "The original question.",
      })
    );
    const original = structuredClone(notifications.deliveries);
    const question = db.select().from(comments).get();
    if (!question) throw new Error("Discussion Question was not saved");
    expect(
      await callLessonAction(
        await postAs(base.user.id, {
          intent: "edit-comment",
          commentId: String(question.id),
          body: "A clearer question.",
        })
      )
    ).toEqual({ ok: true });
    expect(db.select().from(comments).get()?.body).toBe("A clearer question.");
    expect(notifications.deliveries).toEqual(original);
    expect(notifications.triggers).toHaveLength(1);
  });
});

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
      expect(notifications.triggers).toEqual([]);
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
    expect(notifications.triggers).toEqual([]);
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
    const reply = db.select().from(comments).all()[1];
    expect(notifications.deliveries).toEqual([
      expect.objectContaining({
        kind: "discussion-reply-created",
        recordId: reply?.id,
        actorId: base.instructor.id,
        recipientIds: [base.user.id],
        data: expect.objectContaining({
          destination: `/courses/test-course/lessons/${lesson.id}#comment-${reply?.id}`,
          snapshot: expect.objectContaining({ body: "Here is how." }),
        }),
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
        expect(notifications.archives).toEqual([]);
      } else {
        expect(result).toEqual({ ok: true });
        expect(db.select().from(comments).all()).toEqual([
          { ...question, deletedAt: expect.any(String) },
          reply,
        ]);
        expect(notifications.archives).toEqual([
          expect.objectContaining({ commentId: question.id }),
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
      expect(notifications.triggers).toEqual([]);
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
      expect(notifications.triggers).toEqual([]);
      expect(notifications.archives).toEqual([]);
    }
  );

  it.each(["signed out", "lapsed", "country blocked"])(
    "rejects deletion and does not archive when the author is %s",
    async (access) => {
      await callLessonAction(
        await postAs(base.user.id, {
          intent: "create-comment",
          body: "My question.",
        })
      );
      const question = db.select().from(comments).get();
      if (!question) throw new Error("Discussion Question was not saved");
      if (access === "lapsed") {
        db.delete(enrollments)
          .where(eq(enrollments.userId, base.user.id))
          .run();
      } else if (access === "country blocked") {
        db.update(courses)
          .set({ price: 10000, pppEnabled: true })
          .where(eq(courses.id, base.course.id))
          .run();
        db.insert(purchases)
          .values({
            userId: base.user.id,
            courseId: base.course.id,
            amountPaid: 2500,
            country: "IN",
          })
          .run();
      }
      const request = await postAs(
        access === "signed out" ? null : base.user.id,
        {
          intent: "delete-comment",
          commentId: String(question.id),
        }
      );
      request.headers.set("CF-IPCountry", "US");

      await expect(callLessonAction(request)).rejects.toMatchObject({
        init: { status: access === "signed out" ? 401 : 403 },
      });
      expect(notifications.archives).toEqual([]);
      expect(db.select().from(comments).get()).toEqual(question);
    }
  );

  it("keeps the deletion action successful after an archive failure and safely repeats it", async () => {
    await callLessonAction(
      await postAs(base.user.id, {
        intent: "create-comment",
        body: "My question.",
      })
    );
    const question = db.select().from(comments).get();
    if (!question) throw new Error("Discussion Question was not saved");
    await callInstructorAction(
      await postAs(base.instructor.id, {
        intent: "reply",
        commentId: String(question.id),
        body: "My answer.",
      })
    );
    const reply = db.select().from(comments).all()[1];
    if (!reply) throw new Error("Discussion Reply was not saved");
    notifications.failures.add("archiveComment");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await callLessonAction(
        await postAs(base.instructor.id, {
          intent: "delete-comment",
          commentId: String(reply.id),
        })
      )
    ).toEqual({ ok: true });
    const deleted = db
      .select()
      .from(comments)
      .where(eq(comments.id, reply.id))
      .get();
    expect(deleted?.deletedAt).toEqual(expect.any(String));
    notifications.failures.clear();
    expect(
      await callLessonAction(
        await postAs(base.instructor.id, {
          intent: "delete-comment",
          commentId: String(reply.id),
        })
      )
    ).toEqual({ ok: true });
    expect(
      db.select().from(comments).where(eq(comments.id, reply.id)).get()
    ).toEqual(deleted);
    expect(
      notifications.activeDeliveries.map((event) => event.recordId)
    ).toEqual([question.id]);
    expect(notifications.triggers).toHaveLength(2);
  });

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
    expect(notifications.triggers).toEqual([]);
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
      expect(notifications.triggers).toEqual([]);
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
    expect(notifications.deliveries).toEqual([
      expect.objectContaining({
        kind: "discussion-question-created",
        actorId: base.user.id,
        recipientIds: [base.instructor.id],
        recordId: question.id,
      }),
      expect.objectContaining({
        kind: "discussion-reply-created",
        actorId: base.instructor.id,
        recipientIds: [base.user.id],
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
    expect(notifications.triggers).toEqual([]);
  });
});
