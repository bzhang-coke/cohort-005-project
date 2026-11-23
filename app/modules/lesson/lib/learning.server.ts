import { and, desc, eq, inArray, max } from "drizzle-orm";
import {
  LessonProgressStatus,
  lessonProgress,
  lessons,
  modules,
  quizAttempts,
  videoWatchEvents,
} from "~/db/schema";
import type { Db } from "./types";
import type { LessonTarget } from "./policy.server";

export function markProgress(
  db: Db,
  {
    userId,
    lessonId,
    status,
  }: {
    userId: number;
    lessonId: number;
    status: LessonProgressStatus;
  },
  now: Date
) {
  const existing = db
    .select()
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.lessonId, lessonId)
      )
    )
    .get();
  if (
    existing?.status === LessonProgressStatus.Completed &&
    status === LessonProgressStatus.InProgress
  )
    return;
  const completedAt =
    status === LessonProgressStatus.Completed ? now.toISOString() : null;
  if (existing) {
    db.update(lessonProgress)
      .set({ status, completedAt })
      .where(eq(lessonProgress.id, existing.id))
      .run();
  } else {
    db.insert(lessonProgress)
      .values({ userId, lessonId, status, completedAt })
      .run();
  }
}

function courseProgress(db: Db, userId: number, courseId: number) {
  const ids = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
  const progress = db
    .select({
      lessonId: lessonProgress.lessonId,
      status: lessonProgress.status,
    })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        inArray(lessonProgress.lessonId, ids)
      )
    )
    .all();
  const lessonProgressMap: Record<number, string> = Object.fromEntries(
    progress.map((row) => [row.lessonId, row.status])
  );
  return lessonProgressMap;
}

function watchProgress(db: Db, userId: number, lesson: LessonTarget["lesson"]) {
  const watchScope = and(
    eq(videoWatchEvents.userId, userId),
    eq(videoWatchEvents.lessonId, lesson.id)
  );
  const lastWatch = db
    .select({ position: videoWatchEvents.positionSeconds })
    .from(videoWatchEvents)
    .where(watchScope)
    .orderBy(desc(videoWatchEvents.createdAt), desc(videoWatchEvents.id))
    .get();
  // An aggregate without GROUP BY always returns one row, even with no events.
  const [maxWatch] = db
    .select({ position: max(videoWatchEvents.positionSeconds) })
    .from(videoWatchEvents)
    .where(watchScope)
    .all();
  const duration = (lesson.durationMinutes ?? 0) * 60;
  return {
    lastWatchPosition: lesson.videoUrl ? (lastWatch?.position ?? 0) : 0,
    watchProgress:
      lesson.videoUrl && duration > 0
        ? Math.min(Math.round(((maxWatch.position ?? 0) / duration) * 100), 100)
        : 0,
  };
}

export function learningState(
  db: Db,
  target: LessonTarget,
  { quizId, now }: { quizId: number | undefined; now: Date }
) {
  const { permission, lesson, course } = target;
  if (!permission.enrolled || !permission.canRead || !permission.person)
    return null;
  const userId = permission.person.id;
  markProgress(
    db,
    { userId, lessonId: lesson.id, status: LessonProgressStatus.InProgress },
    now
  );
  const lessonProgressMap = courseProgress(db, userId, course.id);
  const bestAttempt = quizId
    ? db
        .select({ score: quizAttempts.score, passed: quizAttempts.passed })
        .from(quizAttempts)
        .where(
          and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId))
        )
        .orderBy(desc(quizAttempts.score))
        .get()
    : undefined;
  return {
    lessonStatus: lessonProgressMap[lesson.id] ?? null,
    lessonProgressMap,
    ...watchProgress(db, userId, lesson),
    bestAttempt: bestAttempt ?? null,
  };
}
