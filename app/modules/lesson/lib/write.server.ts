import { eq } from "drizzle-orm";
import { data } from "react-router";
import { z } from "zod";
import { parseParams } from "~/lib/validation";
import { saveNote } from "~/lib/notes.server";
import { toggleBookmark } from "~/lib/bookmarks.server";
import {
  createComment,
  deleteComment,
  editComment,
} from "~/lib/comments.server";
import {
  loggingNotifications,
  tolerateNotificationFailure,
} from "~/lib/notifications.server";
import { comments, LessonProgressStatus, videoWatchEvents } from "~/db/schema";
import { markProgress } from "./learning.server";
import { submitQuiz } from "./quiz.server";
import {
  currentPerson,
  requestContext,
  resolveLesson,
  type RequestContext,
} from "./policy.server";
import {
  formBody,
  positiveId,
  lessonPathSchema,
  submission,
  type DiscussionCommand,
} from "./input.server";
import type { Db, LessonDependencies, LessonPath } from "./types";

type WriteTarget = { lessonId: number; slug?: string; learning?: boolean };
type DiscussionChange = {
  lessonId: number;
  slug?: string;
  command: DiscussionCommand;
  instructorOnly?: boolean;
};

function writableLesson(
  db: Db,
  context: RequestContext,
  { lessonId, slug, learning = false }: WriteTarget
) {
  const person = currentPerson(db, context, true);
  const target = resolveLesson(db, context, { lessonId, slug });
  if (!target.permission.canRead || (learning && !target.permission.enrolled)) {
    throw data(
      "You must have an Enrollment and permission to use this Lesson.",
      { status: 403 }
    );
  }
  return { ...target, person };
}

function discussionTarget(
  db: Db,
  context: RequestContext,
  { lessonId, slug, command, instructorOnly = false }: DiscussionChange
) {
  const target = writableLesson(db, context, { lessonId, slug });
  if (instructorOnly && !target.permission.privileged)
    throw data("Only this course's Instructor can reply here.", {
      status: 403,
    });
  const commentId =
    command.intent === "create-comment" ? command.parentId : command.commentId;
  if (commentId !== undefined) {
    const comment = db
      .select()
      .from(comments)
      .where(eq(comments.id, commentId))
      .get();
    if (!comment || comment.lessonId !== lessonId)
      throw data("Discussion not found in this Lesson", { status: 404 });
    if (
      command.intent === "edit-comment" &&
      comment.userId !== target.person.id
    ) {
      throw data("You can only edit your own Discussion.", { status: 403 });
    }
    if (
      command.intent === "delete-comment" &&
      comment.userId !== target.person.id &&
      !target.permission.privileged
    ) {
      throw data("You cannot delete this Discussion.", { status: 403 });
    }
  }
  return target;
}

async function changeDiscussion(
  deps: LessonDependencies,
  context: RequestContext,
  change: DiscussionChange
) {
  const { lessonId, command } = change;
  discussionTarget(deps.database, context, change);
  if (command.intent === "edit-comment") {
    return deps.database.transaction((db) => {
      const target = discussionTarget(db, context, change);
      const result = editComment(
        db,
        command.commentId,
        target.person.id,
        command.body,
        deps.now()
      );
      return result.ok ? { ok: true as const } : result;
    });
  }
  const notifications = await tolerateNotificationFailure(
    "Could not initialize Discussion Notifications",
    loggingNotifications(),
    deps.notifications
  );
  // Adapter initialization may yield. Recheck before the existing helper's synchronous, single-row write.
  // Both helpers commit their write before awaiting any Notification delivery.
  const target = discussionTarget(deps.database, context, change);
  const result =
    command.intent === "create-comment"
      ? await createComment(
          deps.database,
          target.person.id,
          lessonId,
          command.parentId ?? null,
          command.body,
          deps.now(),
          notifications
        )
      : await deleteComment(
          deps.database,
          command.commentId,
          target.person.id,
          target.permission.privileged,
          deps.now(),
          notifications
        );
  return result.ok ? { ok: true as const } : result;
}

export async function submitLesson(
  deps: LessonDependencies,
  request: Request,
  path: LessonPath
) {
  const { slug, lessonId } = parseParams(path, lessonPathSchema);
  const { command, answers } = await submission(request);
  const context = await requestContext(request);
  if (
    command.intent === "create-comment" ||
    command.intent === "edit-comment" ||
    command.intent === "delete-comment"
  ) {
    return changeDiscussion(deps, context, { lessonId, slug, command });
  }
  return deps.database.transaction((db) => {
    const target = writableLesson(db, context, {
      lessonId,
      slug,
      learning:
        command.intent === "mark-complete" || command.intent === "submit-quiz",
    });
    return applySubmission(db, target, { command, answers, now: deps.now() });
  });
}

type LearningSubmission = {
  command: Exclude<
    Awaited<ReturnType<typeof submission>>["command"],
    DiscussionCommand
  >;
  answers: Map<number, number>;
  now: Date;
};

function applySubmission(
  db: Db,
  target: ReturnType<typeof writableLesson>,
  { command, answers, now }: LearningSubmission
) {
  const lessonId = target.lesson.id;
  if (command.intent === "mark-complete") {
    markProgress(
      db,
      {
        userId: target.person.id,
        lessonId,
        status: LessonProgressStatus.Completed,
      },
      now
    );
    return { success: true as const };
  }
  if (command.intent === "submit-quiz")
    return {
      quizResult: submitQuiz(
        db,
        {
          userId: target.person.id,
          lessonId,
          quizId: command.quizId,
          answers,
        },
        now
      ),
    };
  if (command.intent === "toggle-bookmark")
    return {
      ok: true as const,
      bookmarked: toggleBookmark(db, target.person.id, lessonId, now),
    };
  const saved = saveNote(db, target.person.id, lessonId, command.body, now);
  return saved.ok ? { ok: true as const } : saved;
}

export async function recordWatch(deps: LessonDependencies, request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw data("Invalid JSON body", { status: 400 });
  }
  const parsed = z
    .object({
      lessonId: z.number().int().positive(),
      eventType: z.string().min(1),
      positionSeconds: z.number().finite().nonnegative(),
    })
    .safeParse(body);
  if (!parsed.success) throw data("Invalid watch event", { status: 400 });
  const context = await requestContext(request);
  return deps.database.transaction((db) => {
    const target = writableLesson(db, context, {
      lessonId: parsed.data.lessonId,
      learning: true,
    });
    db.insert(videoWatchEvents)
      .values({
        ...parsed.data,
        userId: target.person.id,
        createdAt: deps.now().toISOString(),
      })
      .run();
    return { success: true as const };
  });
}

export async function replyFromInstructorQueue(
  deps: LessonDependencies,
  request: Request
) {
  const form = await formBody(request);
  const parsed = z
    .object({
      intent: z.literal("reply"),
      commentId: positiveId,
      body: z.string().default(""),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) throw data("Invalid reply", { status: 400 });
  const context = await requestContext(request);
  currentPerson(deps.database, context, true);
  const question = deps.database
    .select()
    .from(comments)
    .where(eq(comments.id, parsed.data.commentId))
    .get();
  if (!question) throw data("Discussion Question not found", { status: 404 });
  return changeDiscussion(deps, context, {
    lessonId: question.lessonId,
    command: {
      intent: "create-comment",
      parentId: question.id,
      body: parsed.data.body,
    },
    instructorOnly: true,
  });
}
