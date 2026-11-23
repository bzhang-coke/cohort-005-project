import { eq, sql } from "drizzle-orm";
import { data } from "react-router";
import { courses, lessons, modules } from "~/db/schema";
import { parseParams } from "~/lib/validation";
import { outlinePathSchema } from "./input.server";
import { coursePermission, requestContext } from "./policy.server";
import type { LessonDependencies, OutlinePath } from "./types";

/** Public curriculum data is selected explicitly, never redacted from full Lesson rows. */
export async function readOutline(
  { database: db }: LessonDependencies,
  request: Request,
  path: OutlinePath
) {
  const { slug, moduleId } = parseParams(path, outlinePathSchema);
  const context = await requestContext(request);
  const course = db.select().from(courses).where(eq(courses.slug, slug)).get();
  if (!course) throw data("Course not found", { status: 404 });
  coursePermission(db, context, course);
  const sections = db
    .select({
      id: modules.id,
      courseId: modules.courseId,
      title: modules.title,
      position: modules.position,
    })
    .from(modules)
    .where(eq(modules.courseId, course.id))
    .orderBy(modules.position, modules.id)
    .all();
  if (
    moduleId !== undefined &&
    !sections.some((section) => section.id === moduleId)
  )
    throw data("Module not found in this course", { status: 404 });
  return {
    course: { id: course.id, title: course.title, slug: course.slug },
    modules: sections.map((section) => ({
      ...section,
      lessons: db
        .select({
          id: lessons.id,
          moduleId: lessons.moduleId,
          title: lessons.title,
          position: lessons.position,
          durationMinutes: lessons.durationMinutes,
          hasVideo:
            sql`${lessons.videoUrl} is not null and ${lessons.videoUrl} <> ''`.mapWith(
              Boolean
            ),
        })
        .from(lessons)
        .where(eq(lessons.moduleId, section.id))
        .orderBy(lessons.position, lessons.id)
        .all(),
    })),
  };
}
