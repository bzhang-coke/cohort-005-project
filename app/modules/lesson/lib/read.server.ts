import { asc, eq } from "drizzle-orm";
import { data } from "react-router";
import {
  comments,
  lessons,
  modules,
  quizzes,
  quizQuestions,
  quizOptions,
  users,
  UserRole,
  CourseStatus,
} from "~/db/schema";
import { parseParams } from "~/lib/validation";
import { isBookmarked } from "~/lib/bookmarks.server";
import { getNote } from "~/lib/notes.server";
import { renderMarkdown } from "~/lib/markdown.server";
import { renderComment } from "~/lib/comment-markdown.server";
import type { RenderedComment } from "~/components/comment-thread";
import {
  requestContext,
  resolveLesson,
  type LessonTarget,
} from "./policy.server";
import { learningState } from "./learning.server";
import type { Db, LessonDependencies, LessonPath } from "./types";
import { lessonPathSchema } from "./input.server";

function curriculum(db: Db, courseId: number) {
  const sections = db
    .select({ id: modules.id, title: modules.title })
    .from(modules)
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position, modules.id)
    .all();
  return sections.map((section) => ({
    ...section,
    lessons: db
      .select({ id: lessons.id, title: lessons.title })
      .from(lessons)
      .where(eq(lessons.moduleId, section.id))
      .orderBy(lessons.position, lessons.id)
      .all(),
  }));
}

function preview(db: Db, target: LessonTarget) {
  const { course, lesson, section, permission } = target;
  if (course.status !== CourseStatus.Published)
    throw data("You cannot view this Lesson from your current country.", {
      status: 403,
    });
  return {
    kind: "preview" as const,
    course: { id: course.id, title: course.title, slug: course.slug },
    module: { id: section.id, title: section.title },
    lesson: { id: lesson.id, title: lesson.title },
    curriculum: curriculum(db, course.id),
    restriction: permission.restriction.blocked
      ? {
          kind: "country-restricted" as const,
          currentCountry: permission.restriction.blockedCountry,
          purchaseCountry: permission.restriction.purchaseCountry,
        }
      : { kind: "enrollment-required" as const },
  };
}

function quizForLesson(db: Db, lessonId: number) {
  const quiz = db
    .select()
    .from(quizzes)
    .where(eq(quizzes.lessonId, lessonId))
    .get();
  if (!quiz) return null;
  return {
    id: quiz.id,
    title: quiz.title,
    passingScore: quiz.passingScore,
    questions: db
      .select()
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, quiz.id))
      .orderBy(quizQuestions.position, quizQuestions.id)
      .all()
      .map((question) => ({
        id: question.id,
        questionText: question.questionText,
        questionType: question.questionType,
        position: question.position,
        options: db
          .select({ id: quizOptions.id, optionText: quizOptions.optionText })
          .from(quizOptions)
          .where(eq(quizOptions.questionId, question.id))
          .all(),
      })),
  };
}

function discussionRows(db: Db, lessonId: number) {
  return db
    .select({
      id: comments.id,
      parentId: comments.parentId,
      body: comments.body,
      createdAt: comments.createdAt,
      editedAt: comments.editedAt,
      deletedAt: comments.deletedAt,
      authorId: users.id,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
      authorRole: users.role,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.lessonId, lessonId))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all();
}

async function discussion(
  db: Db,
  target: LessonTarget
): Promise<RenderedComment[]> {
  const rows = discussionRows(db, target.lesson.id);
  const rendered = await Promise.all(
    rows.map(async (row) => ({
      parentId: row.parentId,
      node: {
        id: row.id,
        body: row.deletedAt ? "" : row.body,
        bodyHtml: row.deletedAt ? "" : await renderComment(row.body),
        createdAt: row.createdAt,
        editedAt: row.deletedAt ? null : row.editedAt,
        deleted: row.deletedAt !== null,
        author: {
          id: row.authorId,
          name: row.authorName,
          avatarUrl: row.authorAvatarUrl,
          isInstructor: row.authorId === target.course.instructorId,
          isPlatformAdmin: row.authorRole === UserRole.Admin,
        },
        replies: [] as RenderedComment[],
      } satisfies RenderedComment,
    }))
  );
  const topLevel: RenderedComment[] = [];
  const byId = new Map<number | null, RenderedComment>();
  for (const row of rendered) {
    if (row.parentId !== null) continue;
    topLevel.push(row.node);
    byId.set(row.node.id, row.node);
  }
  for (const row of rendered) {
    // A null or missing parent has no entry in the map.
    if (!row.node.deleted) byId.get(row.parentId)?.replies.push(row.node);
  }
  return topLevel.filter((node) => !node.deleted || node.replies.length > 0);
}

export async function openLesson(
  deps: LessonDependencies,
  request: Request,
  path: LessonPath
) {
  const { slug, lessonId } = parseParams(path, lessonPathSchema);
  const context = await requestContext(request);
  const initial = resolveLesson(deps.database, context, { lessonId, slug });
  if (!initial.permission.canRead) return preview(deps.database, initial);
  const [contentHtml, thread] = await Promise.all([
    initial.lesson.content
      ? renderMarkdown(initial.lesson.content)
      : Promise.resolve(null),
    discussion(deps.database, initial),
  ]);
  // Rendering can yield. Check live permission again before returning material or recording progress.
  return deps.database.transaction((db) => {
    const target = resolveLesson(db, context, { lessonId, slug });
    return lessonContent(db, target, { contentHtml, thread, now: deps.now() });
  });
}

type RenderedLesson = {
  contentHtml: string | null;
  thread: RenderedComment[];
  now: Date;
};

function instructorName(db: Db, instructorId: number) {
  // The course's required foreign key guarantees an instructor row.
  const [instructor] = db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, instructorId))
    .all();
  return instructor.name;
}

function lessonContent(
  db: Db,
  target: LessonTarget,
  { contentHtml, thread, now }: RenderedLesson
) {
  if (!target.permission.canRead) return preview(db, target);
  const { course, section, lesson, permission } = target;
  const lessonId = lesson.id;
  const currentUserId = permission.person.id;
  const outline = curriculum(db, course.id);
  const flat = outline.flatMap((section) => section.lessons);
  const index = flat.findIndex((item) => item.id === lessonId);
  const quiz = quizForLesson(db, lessonId);
  const note = getNote(db, currentUserId, lessonId);
  return {
    kind: "content" as const,
    course: { id: course.id, title: course.title, slug: course.slug },
    module: { id: section.id, title: section.title },
    lesson: {
      id: lesson.id,
      title: lesson.title,
      durationMinutes: lesson.durationMinutes,
      videoUrl: lesson.videoUrl,
      githubRepoUrl: lesson.githubRepoUrl,
    },
    curriculum: outline,
    contentHtml,
    comments: thread,
    currentUserId,
    canModerate: permission.privileged,
    instructorName: instructorName(db, course.instructorId),
    bookmarked: isBookmarked(db, currentUserId, lessonId),
    note: note ? { body: note.body, updatedAt: note.updatedAt } : null,
    quiz,
    learning: learningState(db, target, { quizId: quiz?.id, now }),
    prevLesson: flat[index - 1] ?? null,
    nextLesson: flat[index + 1] ?? null,
  };
}
