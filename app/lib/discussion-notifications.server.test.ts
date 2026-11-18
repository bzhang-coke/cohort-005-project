import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  comments,
  courses,
  lessons,
  modules,
  users,
  UserRole,
  CourseStatus,
} from "~/db/schema";
import {
  createComment,
  submitComment,
  submitCommentDeletion,
  updateComment,
} from "./comments.server";
import { createFakeNotificationTransport } from "./notifications/fake.server";
import { syncNotificationPerson } from "./notifications.server";

const NOW = new Date("2026-11-17T12:00:00.000Z");
let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lesson: typeof lessons.$inferSelect;
let notifications: ReturnType<typeof createFakeNotificationTransport>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  notifications = createFakeNotificationTransport();
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
});

afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
});

describe("Discussion Notification archival", () => {
  it("archives only the deleted Discussion Question after commit, retaining its surviving Discussion Reply", async () => {
    const question = await submitComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "My question.",
      NOW,
      { notifications }
    );
    const reply = await submitComment(
      db,
      base.instructor.id,
      lesson.id,
      question.id,
      "A surviving answer.",
      NOW,
      { notifications }
    );
    const archive = notifications.archiveComment;
    notifications.archiveComment = async (source) => {
      expect(db.$client.inTransaction).toBe(false);
      expect(
        db.select().from(comments).where(eq(comments.id, question.id)).get()
      ).toMatchObject({ deletedAt: NOW.toISOString() });
      await archive(source);
    };

    const deleted = await submitCommentDeletion(
      db,
      question.id,
      base.user.id,
      false,
      NOW,
      { notifications }
    );

    expect(deleted.deletedAt).toBe(NOW.toISOString());
    expect(
      notifications.activeDeliveries.map((event) => event.recordId)
    ).toEqual([reply.id]);
    expect(notifications.deliveries).toHaveLength(2);
    expect(notifications.triggers).toHaveLength(2);
    expect(
      db.select().from(comments).where(eq(comments.id, reply.id)).get()
    ).toEqual(reply);
  });

  it("repeatedly deleting a Discussion Reply archives only that reply and preserves its original snapshot", async () => {
    const question = await submitComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "My question.",
      NOW,
      { notifications }
    );
    const reply = await submitComment(
      db,
      base.instructor.id,
      lesson.id,
      question.id,
      "Original answer.",
      NOW,
      { notifications }
    );
    const history = structuredClone(notifications.deliveries);
    updateComment(db, reply.id, base.instructor.id, "Edited answer.", NOW);

    const deleted = await submitCommentDeletion(
      db,
      reply.id,
      base.instructor.id,
      true,
      NOW,
      { notifications }
    );
    const repeated = await submitCommentDeletion(
      db,
      reply.id,
      base.instructor.id,
      true,
      new Date("2026-11-18T12:00:00.000Z"),
      { notifications }
    );

    expect(repeated).toEqual(deleted);
    expect(
      notifications.activeDeliveries.map((event) => event.recordId)
    ).toEqual([question.id]);
    expect(notifications.deliveries).toEqual(history);
    expect(notifications.triggers).toHaveLength(2);
    expect(
      db.select().from(comments).where(eq(comments.id, question.id)).get()
    ).toEqual(question);
  });

  it("supplies every persisted person for retained discovery after course ownership and the old Instructor's role change", async () => {
    const question = await submitComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "An older question.",
      NOW,
      { notifications }
    );
    const replacement = db
      .insert(users)
      .values({
        name: "New Instructor",
        email: "new@example.com",
        role: UserRole.Instructor,
      })
      .returning()
      .get();
    db.update(courses)
      .set({ instructorId: replacement.id })
      .where(eq(courses.id, base.course.id))
      .run();
    db.update(users)
      .set({ role: UserRole.Student })
      .where(eq(users.id, base.instructor.id))
      .run();

    await submitCommentDeletion(db, question.id, base.user.id, false, NOW, {
      notifications,
    });

    expect(notifications.archives).toEqual([
      {
        commentId: question.id,
        personIds: expect.arrayContaining([
          base.user.id,
          base.instructor.id,
          replacement.id,
        ]),
      },
    ]);
    expect(notifications.activeDeliveries).toEqual([]);
  });

  it("keeps the deletion committed and returns success when archival fails", async () => {
    const question = await submitComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "My question.",
      NOW,
      { notifications }
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    notifications.failures.add("archiveComment");

    const deleted = await submitCommentDeletion(
      db,
      question.id,
      base.user.id,
      false,
      NOW,
      { notifications }
    );

    expect(deleted.deletedAt).toBe(NOW.toISOString());
    expect(
      db.select().from(comments).where(eq(comments.id, question.id)).get()
    ).toEqual(deleted);
    expect(notifications.activeDeliveries).toHaveLength(1);
    expect(notifications.triggers).toHaveLength(1);
    expect(log).toHaveBeenCalled();
  });

  it("does not archive for denied deletion, a missing comment, or a rejected database write", async () => {
    const question = await submitComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "My question.",
      NOW,
      { notifications }
    );
    await expect(
      submitCommentDeletion(db, question.id, base.instructor.id, false, NOW, {
        notifications,
      })
    ).rejects.toThrow("You can only delete your own comments");
    await expect(
      submitCommentDeletion(db, 999, base.user.id, false, NOW, {
        notifications,
      })
    ).rejects.toThrow("Comment not found");
    db.$client.exec(
      "CREATE TRIGGER reject_deletion BEFORE UPDATE ON comments BEGIN SELECT RAISE(ABORT, 'cannot delete comment'); END"
    );
    await expect(
      submitCommentDeletion(db, question.id, base.user.id, false, NOW, {
        notifications,
      })
    ).rejects.toThrow();
    expect(notifications.archives).toEqual([]);
    expect(notifications.activeDeliveries).toHaveLength(1);
    expect(
      db.select().from(comments).where(eq(comments.id, question.id)).get()
    ).toEqual(question);
  });
});

describe("Discussion Notification delivery", () => {
  it("notifies the owning Instructor of a committed Discussion Question with its original text and exact destination", async () => {
    const trigger = notifications.trigger;
    notifications.trigger = async (event) => {
      expect(db.$client.inTransaction).toBe(false);
      expect(
        db
          .select()
          .from(comments)
          .where(eq(comments.id, Number(event.recordId)))
          .get()
      ).toMatchObject({ body: "How does this work?" });
      await trigger(event);
    };

    const question = await submitComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "  How does this work?  ",
      NOW,
      { notifications }
    );

    expect(notifications.deliveries).toEqual([
      {
        kind: "discussion-question-created",
        recordId: question.id,
        recipientIds: [base.instructor.id],
        actorId: base.user.id,
        idempotencyKey: `cadence:discussion-question-created:${question.id}`,
        data: {
          category: "discussionQuestions",
          title: "Test User asked a Discussion Question",
          context: "Test Course · First lesson: How does this work?",
          destination: `/courses/test-course/lessons/${lesson.id}#comment-${question.id}`,
          source: {
            commentId: question.id,
            lessonId: lesson.id,
            courseId: base.course.id,
          },
          snapshot: {
            courseTitle: "Test Course",
            lessonTitle: "First lesson",
            body: "How does this work?",
            snippet: "How does this work?",
          },
        },
      },
    ]);
  });

  it("sends a Discussion Reply only to the Discussion Question author, with the new comment as its origin", async () => {
    const question = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "How does this work?",
      NOW
    );
    createComment(
      db,
      base.instructor.id,
      lesson.id,
      question.id,
      "An earlier answer.",
      NOW
    );
    const participant = db
      .insert(users)
      .values({
        name: "Another Student",
        email: "participant@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();

    const reply = await submitComment(
      db,
      participant.id,
      lesson.id,
      question.id,
      "  Here is another way.  ",
      NOW,
      { notifications }
    );

    expect(notifications.deliveries).toEqual([
      {
        kind: "discussion-reply-created",
        recordId: reply.id,
        recipientIds: [base.user.id],
        actorId: participant.id,
        idempotencyKey: `cadence:discussion-reply-created:${reply.id}`,
        data: {
          category: "discussionReplies",
          title: "Another Student replied to your Discussion Question",
          context: "Test Course · First lesson: Here is another way.",
          destination: `/courses/test-course/lessons/${lesson.id}#comment-${reply.id}`,
          source: {
            commentId: reply.id,
            lessonId: lesson.id,
            courseId: base.course.id,
          },
          snapshot: {
            courseTitle: "Test Course",
            lessonTitle: "First lesson",
            body: "Here is another way.",
            snippet: "Here is another way.",
          },
        },
      },
    ]);
  });

  it.each([UserRole.Instructor, UserRole.Admin])(
    "keeps an owning Instructor's top-level post and responses valid without Notifications, even with role %s",
    async (role) => {
      db.update(users)
        .set({ role })
        .where(eq(users.id, base.instructor.id))
        .run();
      const post = await submitComment(
        db,
        base.instructor.id,
        lesson.id,
        null,
        "Some advice from your Instructor.",
        NOW,
        { notifications }
      );
      const response = await submitComment(
        db,
        base.user.id,
        lesson.id,
        post.id,
        "Thanks for the advice.",
        NOW,
        { notifications }
      );

      expect(db.select().from(comments).all()).toEqual([post, response]);
      expect(notifications.triggers).toEqual([]);
    }
  );

  it("snapshots a short single-line snippet before external delivery, preserving the full original text after edits", async () => {
    const original = `First line.\n\n${"long discussion ".repeat(25)}`.trim();
    const trigger = notifications.trigger;
    notifications.trigger = async (event) => {
      updateComment(
        db,
        Number(event.recordId),
        base.user.id,
        "Clarified question.",
        NOW
      );
      await trigger(event);
    };

    const question = await submitComment(
      db,
      base.user.id,
      lesson.id,
      null,
      original,
      NOW,
      { notifications }
    );
    const delivery = notifications.deliveries[0];
    expect(delivery?.data.snapshot.body).toBe(original);
    expect(delivery?.data.snapshot.snippet).toMatch(
      /^First line\. long discussion /
    );
    expect(delivery?.data.snapshot.snippet).toHaveLength(160);
    expect(delivery?.data.snapshot.snippet).not.toContain("\n");
    expect(delivery?.data.context).not.toContain("Clarified question.");
    expect(
      db.select().from(comments).where(eq(comments.id, question.id)).get()?.body
    ).toBe("Clarified question.");
    expect(notifications.deliveries).toHaveLength(1);
  });

  it.each([UserRole.Student, UserRole.Instructor, UserRole.Admin])(
    "notifies the owning Instructor for another %s's Discussion Question",
    async (role) => {
      const actor = db
        .insert(users)
        .values({ name: "Question author", email: "author@example.com", role })
        .returning()
        .get();
      await submitComment(db, actor.id, lesson.id, null, "My question.", NOW, {
        notifications,
      });
      expect(notifications.deliveries).toEqual([
        expect.objectContaining({
          actorId: actor.id,
          recipientIds: [base.instructor.id],
          kind: "discussion-question-created",
        }),
      ]);
    }
  );

  it.each([
    [UserRole.Student, UserRole.Student],
    [UserRole.Student, UserRole.Instructor],
    [UserRole.Student, UserRole.Admin],
    [UserRole.Instructor, UserRole.Student],
    [UserRole.Instructor, UserRole.Instructor],
    [UserRole.Instructor, UserRole.Admin],
    [UserRole.Admin, UserRole.Student],
    [UserRole.Admin, UserRole.Instructor],
    [UserRole.Admin, UserRole.Admin],
  ])(
    "sends a %s's Discussion Reply only to the %s who authored the Discussion Question",
    async (actorRole, authorRole) => {
      const author = db
        .insert(users)
        .values({
          name: "Question author",
          email: "author@example.com",
          role: authorRole,
        })
        .returning()
        .get();
      const actor =
        actorRole === UserRole.Instructor
          ? base.instructor
          : db
              .insert(users)
              .values({
                name: "Reply author",
                email: "reply@example.com",
                role: actorRole,
              })
              .returning()
              .get();
      const question = createComment(
        db,
        author.id,
        lesson.id,
        null,
        "My question.",
        NOW
      );
      createComment(
        db,
        base.user.id,
        lesson.id,
        question.id,
        "An earlier reply.",
        NOW
      );
      await submitComment(
        db,
        actor.id,
        lesson.id,
        question.id,
        "Another answer.",
        NOW,
        { notifications }
      );
      expect(notifications.deliveries).toEqual([
        expect.objectContaining({
          actorId: actor.id,
          recipientIds: [author.id],
          kind: "discussion-reply-created",
        }),
      ]);
    }
  );

  it("excludes the Discussion Question author's self-reply", async () => {
    const question = createComment(
      db,
      base.user.id,
      lesson.id,
      null,
      "My question.",
      NOW
    );
    const reply = await submitComment(
      db,
      base.user.id,
      lesson.id,
      question.id,
      "An extra detail.",
      NOW,
      { notifications }
    );
    expect(reply.body).toBe("An extra detail.");
    expect(notifications.triggers).toEqual([]);
  });

  it.each(["discussionQuestions", "discussionReplies"] as const)(
    "muting %s preserves the other Discussion category",
    async (category) => {
      await syncNotificationPerson(base.user, notifications);
      await syncNotificationPerson(base.instructor, notifications);
      await notifications.setPreference(
        category === "discussionQuestions" ? base.instructor.id : base.user.id,
        { category, channel: "feed", enabled: false }
      );
      const question = await submitComment(
        db,
        base.user.id,
        lesson.id,
        null,
        "My question.",
        NOW,
        { notifications }
      );
      await submitComment(
        db,
        base.instructor.id,
        lesson.id,
        question.id,
        "My answer.",
        NOW,
        { notifications }
      );
      expect(
        notifications.deliveries.map((event) => event.data.category)
      ).toEqual([
        category === "discussionQuestions"
          ? "discussionReplies"
          : "discussionQuestions",
      ]);
    }
  );

  it.each([null, "reply"])(
    "keeps the committed comment and success result when delivery fails (%s)",
    async (kind) => {
      const question =
        kind === "reply"
          ? createComment(
              db,
              base.user.id,
              lesson.id,
              null,
              "My question.",
              NOW
            )
          : null;
      notifications.failures.add("trigger");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const saved = await submitComment(
        db,
        question ? base.instructor.id : base.user.id,
        lesson.id,
        question?.id ?? null,
        "Saved despite provider failure.",
        NOW,
        { notifications }
      );
      expect(
        db.select().from(comments).where(eq(comments.id, saved.id)).get()
      ).toEqual(saved);
      expect(notifications.deliveries).toEqual([]);
      expect(log).toHaveBeenCalled();
    }
  );

  it.each([
    [" \n ", "Comment cannot be empty"],
    ["x".repeat(5001), "Comment must be 5000 characters or fewer"],
  ])("rejects an invalid body without delivery (%#)", async (body, error) => {
    await expect(
      submitComment(db, base.user.id, lesson.id, null, body, NOW, {
        notifications,
      })
    ).rejects.toThrow(error);
    expect(db.select().from(comments).all()).toEqual([]);
    expect(notifications.triggers).toEqual([]);
  });

  it("preserves parent and lesson validation without sending Notifications for rejected writes", async () => {
    const otherCourse = db
      .insert(courses)
      .values({
        title: "Other course",
        slug: "other-course",
        description: "Other lessons",
        salesCopy: "More lessons",
        instructorId: base.user.id,
        categoryId: base.category.id,
        status: CourseStatus.Published,
      })
      .returning()
      .get();
    const otherModule = db
      .insert(modules)
      .values({ courseId: otherCourse.id, title: "Other", position: 1 })
      .returning()
      .get();
    const otherLesson = db
      .insert(lessons)
      .values({ moduleId: otherModule.id, title: "Other lesson", position: 1 })
      .returning()
      .get();
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
    for (const [targetLesson, parentId, error] of [
      [999, null, "Lesson not found"],
      [lesson.id, 999, "Parent comment not found"],
      [
        otherLesson.id,
        question.id,
        "Parent comment belongs to a different lesson",
      ],
      [lesson.id, reply.id, "Replies can only be one level deep"],
    ] as const) {
      await expect(
        submitComment(
          db,
          base.user.id,
          targetLesson,
          parentId,
          "Rejected comment.",
          NOW,
          { notifications }
        )
      ).rejects.toThrow(error);
    }
    expect(db.select().from(comments).all()).toEqual([question, reply]);
    expect(notifications.triggers).toEqual([]);
  });

  it("does not notify when SQLite rejects the comment write", async () => {
    db.$client.exec(
      "CREATE TRIGGER reject_comment BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT, 'cannot save comment'); END"
    );
    await expect(
      submitComment(
        db,
        base.user.id,
        lesson.id,
        null,
        "Unsaved question.",
        NOW,
        { notifications }
      )
    ).rejects.toThrow();
    expect(db.select().from(comments).all()).toEqual([]);
    expect(notifications.triggers).toEqual([]);
  });
});
