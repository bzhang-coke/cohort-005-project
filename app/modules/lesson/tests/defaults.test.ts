import { afterAll, afterEach, expect, it, vi } from "vitest";
import { db } from "~/db";
import * as schema from "~/db/schema";
import { seedBaseData } from "~/test/setup";
import { setCurrentUserId } from "~/lib/session";
import { lessons } from "../index.server";

vi.mock("~/db", async () => {
  const { createTestDb } = await import("~/test/setup");
  return { db: createTestDb() };
});

afterEach(() => vi.useRealTimers());
afterAll(() => db.$client.close());

it("binds the default lesson service to the application database and current clock", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
  const base = seedBaseData(db);
  const section = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Section", position: 1 })
    .returning()
    .get();
  const lesson = db
    .insert(schema.lessons)
    .values({ moduleId: section.id, title: "Lesson", position: 1 })
    .returning()
    .get();
  db.insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  const cookie = await setCurrentUserId(
    new Request("http://localhost"),
    base.user.id
  );
  expect(
    await lessons.submit(
      new Request("http://localhost/lesson", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ intent: "mark-complete" }),
      }),
      { slug: base.course.slug, lessonId: String(lesson.id) }
    )
  ).toEqual({ success: true });
  expect(db.select().from(schema.lessonProgress).all()).toMatchObject([
    {
      userId: base.user.id,
      lessonId: lesson.id,
      status: "completed",
      completedAt: "2026-11-23T12:00:00.000Z",
    },
  ]);
});
