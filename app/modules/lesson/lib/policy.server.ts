import { and, eq } from "drizzle-orm";
import { data } from "react-router";
import {
  courses,
  enrollments,
  lessons,
  modules,
  purchases,
  users,
  UserRole,
  CourseStatus,
} from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { resolveCountry } from "~/lib/country.server";
import { checkCountryLock } from "~/lib/ppp";
import type { Db } from "./types";

export async function requestContext(request: Request) {
  const [userId, country] = await Promise.all([
    getCurrentUserId(request),
    resolveCountry(request),
  ]);
  return { userId, country };
}
export type RequestContext = Awaited<ReturnType<typeof requestContext>>;

export function currentPerson(
  db: Db,
  context: RequestContext,
  required: true
): typeof users.$inferSelect;
export function currentPerson(
  db: Db,
  context: RequestContext,
  required?: false
): typeof users.$inferSelect | undefined;
export function currentPerson(
  db: Db,
  context: RequestContext,
  required = false
) {
  const person = context.userId
    ? db.select().from(users).where(eq(users.id, context.userId)).get()
    : undefined;
  if (!person && required)
    throw data("Select a user from the DevUI panel.", { status: 401 });
  return person;
}

function isEnrolled(db: Db, userId: number, courseId: number) {
  return !!db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

export function coursePermission(
  db: Db,
  context: RequestContext,
  course: typeof courses.$inferSelect
) {
  const person = currentPerson(db, context);
  const privileged =
    !!person &&
    (person.role === UserRole.Admin || course.instructorId === person.id);
  const enrolled = !!person && isEnrolled(db, person.id, course.id);
  if (
    course.status !== CourseStatus.Published &&
    !privileged &&
    (course.status !== CourseStatus.Archived || !enrolled)
  ) {
    throw data("Course not found", { status: 404 });
  }
  let purchase: { country: string | null } | undefined;
  if (person && enrolled && !privileged) {
    // Preserve the existing Purchase-selection policy; Enrollment is not tied to a Purchase.
    purchase = db
      .select({ country: purchases.country })
      .from(purchases)
      .where(
        and(eq(purchases.userId, person.id), eq(purchases.courseId, course.id))
      )
      .get();
  }
  const restriction = checkCountryLock(
    course.price,
    course.pppEnabled,
    purchase?.country ?? null,
    context.country
  );
  const access =
    person && (privileged || (enrolled && !restriction.blocked))
      ? { person, canRead: true as const }
      : { person, canRead: false as const };
  return {
    ...access,
    privileged,
    enrolled,
    restriction,
  };
}

export function resolveLesson(
  db: Db,
  context: RequestContext,
  { lessonId, slug }: { lessonId: number; slug?: string }
) {
  const target = db
    .select({ lesson: lessons, section: modules, course: courses })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(lessons.id, lessonId))
    .get();
  if (!target || (slug !== undefined && target.course.slug !== slug)) {
    throw data("Lesson not found in this course", { status: 404 });
  }
  return {
    ...target,
    permission: coursePermission(db, context, target.course),
  };
}
export type LessonTarget = ReturnType<typeof resolveLesson>;
