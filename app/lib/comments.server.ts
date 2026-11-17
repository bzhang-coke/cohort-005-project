import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "~/db/schema";
import { comments, courses, lessons, modules, users } from "~/db/schema";
import { MIN_COMMENT_LENGTH, MAX_COMMENT_LENGTH } from "~/lib/comments";
import { deliverNotification } from "~/lib/notifications.server";
import type { NotificationTransport } from "~/lib/notifications/transport.server";

type Db = BetterSQLite3Database<typeof schema>;

function requireComment(db: Db, commentId: number) {
  const existing = db
    .select()
    .from(comments)
    .where(eq(comments.id, commentId))
    .get();
  if (!existing) {
    throw new Error("Comment not found");
  }
  return existing;
}

export function deleteComment(
  db: Db,
  commentId: number,
  userId: number,
  isStaff: boolean,
  now: Date = new Date()
) {
  const existing = requireComment(db, commentId);
  if (existing.userId !== userId && !isStaff) {
    throw new Error("You can only delete your own comments");
  }
  if (existing.deletedAt !== null) {
    return existing;
  }

  return db
    .update(comments)
    .set({ deletedAt: now.toISOString() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();
}

function assertValidBody(body: string) {
  const trimmed = body.trim();
  if (trimmed.length < MIN_COMMENT_LENGTH) {
    throw new Error("Comment cannot be empty");
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new Error(
      `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`
    );
  }
  return trimmed;
}

export function updateComment(
  db: Db,
  commentId: number,
  userId: number,
  body: string,
  now: Date = new Date()
) {
  const trimmed = assertValidBody(body);
  const existing = requireComment(db, commentId);
  if (existing.deletedAt !== null) {
    throw new Error("Comment has been deleted");
  }
  if (existing.userId !== userId) {
    throw new Error("You can only edit your own comments");
  }

  return db
    .update(comments)
    .set({ body: trimmed, editedAt: now.toISOString() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();
}

export function createComment(
  db: Db,
  userId: number,
  lessonId: number,
  parentId: number | null,
  body: string,
  now: Date = new Date()
) {
  const trimmed = assertValidBody(body);

  const course = db
    .select({ id: courses.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();
  if (!course) {
    throw new Error("Lesson not found");
  }

  if (parentId !== null) {
    const parent = db
      .select()
      .from(comments)
      .where(eq(comments.id, parentId))
      .get();
    if (!parent) {
      throw new Error("Parent comment not found");
    }
    if (parent.lessonId !== lessonId) {
      throw new Error("Parent comment belongs to a different lesson");
    }
    if (parent.parentId !== null) {
      throw new Error("Replies can only be one level deep");
    }
  }

  return db
    .insert(comments)
    .values({
      userId,
      lessonId,
      parentId,
      body: trimmed,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
}

// Both writing surfaces submit through this service. All validation and the
// synchronous insert finish before any external Notification work begins.
export async function submitComment(
  db: Db,
  userId: number,
  lessonId: number,
  parentId: number | null,
  body: string,
  now: Date = new Date(),
  dependencies: { notifications?: NotificationTransport } = {}
) {
  const comment = createComment(db, userId, lessonId, parentId, body, now);

  try {
    const details = db
      .select({
        courseId: courses.id,
        courseTitle: courses.title,
        courseSlug: courses.slug,
        instructorId: courses.instructorId,
        lessonTitle: lessons.title,
        actorName: users.name,
      })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .innerJoin(courses, eq(modules.courseId, courses.id))
      .innerJoin(users, eq(users.id, comment.userId))
      .where(eq(lessons.id, comment.lessonId))
      .get();
    if (!details) throw new Error("Discussion Notification context not found");
    const parent =
      comment.parentId === null ? null : requireComment(db, comment.parentId);
    // An owning Instructor's top-level post is not a Discussion Question.
    if ((parent ?? comment).userId === details.instructorId) return comment;
    const singleLine = comment.body.replace(/\s+/g, " ");
    const snippet =
      singleLine.length > 160 ? `${singleLine.slice(0, 159)}…` : singleLine;

    await deliverNotification(
      {
        kind: parent
          ? "discussion-reply-created"
          : "discussion-question-created",
        recordId: comment.id,
        recipientIds: [parent?.userId ?? details.instructorId],
        actorId: comment.userId,
        data: {
          category: parent ? "discussionReplies" : "discussionQuestions",
          title: parent
            ? `${details.actorName} replied to your Discussion Question`
            : `${details.actorName} asked a Discussion Question`,
          context: `${details.courseTitle} · ${details.lessonTitle}: ${snippet}`,
          destination: `/courses/${details.courseSlug}/lessons/${comment.lessonId}#comment-${comment.id}`,
          source: {
            commentId: comment.id,
            lessonId: comment.lessonId,
            courseId: details.courseId,
          },
          snapshot: {
            courseTitle: details.courseTitle,
            lessonTitle: details.lessonTitle,
            body: comment.body,
            snippet,
          },
        },
      },
      dependencies.notifications
    );
  } catch (error) {
    console.error(
      `Discussion Notification failed for comment ${comment.id}.`,
      error
    );
  }

  return comment;
}
