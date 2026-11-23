import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { createLessons } from "../index.server";
import { fixture, otherLesson, request, watchRequest, NOW } from "./fixtures";

let f: ReturnType<typeof fixture>;
afterEach(() => f?.db.$client.close());

it("starts a lesson once and preserves its completion date when reopened", async () => {
  f = fixture();
  await f.lessonModule.open(await request(f.user.id), f.path);
  expect(f.db.select().from(schema.lessonProgress).all()).toMatchObject([
    {
      userId: f.user.id,
      lessonId: f.lesson.id,
      status: "in_progress",
      completedAt: null,
    },
  ]);
  expect(
    await f.lessonModule.submit(
      await request(f.user.id, { intent: "mark-complete" }),
      f.path
    )
  ).toEqual({ success: true });
  const page = await f.lessonModule.open(await request(f.user.id), f.path);
  expect(page).toMatchObject({
    learning: {
      lessonStatus: "completed",
      lessonProgressMap: { [f.lesson.id]: "completed" },
    },
  });
  expect(f.db.select().from(schema.lessonProgress).all()).toMatchObject([
    {
      userId: f.user.id,
      lessonId: f.lesson.id,
      status: "completed",
      completedAt: NOW.toISOString(),
    },
  ]);
});

it("advances existing not-started progress and restricts the progress map to this student and course", async () => {
  f = fixture();
  const other = otherLesson(f);
  f.db
    .insert(schema.lessonProgress)
    .values([
      {
        userId: f.user.id,
        lessonId: f.lesson.id,
        status: schema.LessonProgressStatus.NotStarted,
      },
      {
        userId: f.user.id,
        lessonId: other.lesson.id,
        status: schema.LessonProgressStatus.Completed,
      },
      {
        userId: f.instructor.id,
        lessonId: f.lesson.id,
        status: schema.LessonProgressStatus.Completed,
      },
    ])
    .run();
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({
    learning: {
      lessonStatus: "in_progress",
      lessonProgressMap: { [f.lesson.id]: "in_progress" },
    },
  });
  const page = await f.lessonModule.open(await request(f.user.id), f.path);
  if (page.kind !== "content") throw new Error("Expected lesson content");
  expect(page.learning?.lessonProgressMap).toEqual({
    [f.lesson.id]: "in_progress",
  });
});

it("resumes at the latest position while rounding and capping the furthest progress", async () => {
  f = fixture();
  const record = async (position: number) =>
    f.lessonModule.recordWatch(
      await watchRequest(f.user.id, {
        lessonId: f.lesson.id,
        positionSeconds: position,
      })
    );
  expect(await record(199)).toEqual({ success: true });
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ learning: { lastWatchPosition: 199, watchProgress: 33 } });
  await record(800);
  await record(12);
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ learning: { lastWatchPosition: 12, watchProgress: 100 } });
  expect(f.db.select().from(schema.videoWatchEvents).all()).toMatchObject([
    {
      userId: f.user.id,
      lessonId: f.lesson.id,
      positionSeconds: 199,
      eventType: "progress",
      createdAt: NOW.toISOString(),
    },
    { positionSeconds: 800 },
    { positionSeconds: 12 },
  ]);
});

it.each([null, 0])(
  "shows zero watch percentage when duration is %s",
  async (durationMinutes) => {
    f = fixture();
    f.db
      .update(schema.lessons)
      .set({ durationMinutes })
      .where(eq(schema.lessons.id, f.lesson.id))
      .run();
    await f.lessonModule.recordWatch(
      await watchRequest(f.user.id, {
        lessonId: f.lesson.id,
        positionSeconds: 12,
      })
    );
    expect(
      await f.lessonModule.open(await request(f.user.id), f.path)
    ).toMatchObject({ learning: { lastWatchPosition: 12, watchProgress: 0 } });
  }
);

it("ignores old watch events on a lesson whose video was removed", async () => {
  f = fixture();
  await f.lessonModule.recordWatch(
    await watchRequest(f.user.id, {
      lessonId: f.lesson.id,
      positionSeconds: 300,
    })
  );
  f.db
    .update(schema.lessons)
    .set({ videoUrl: null })
    .where(eq(schema.lessons.id, f.lesson.id))
    .run();
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ learning: { lastWatchPosition: 0, watchProgress: 0 } });
});

it("records a new completion time when explicitly marked complete again", async () => {
  f = fixture();
  await f.lessonModule.submit(
    await request(f.user.id, { intent: "mark-complete" }),
    f.path
  );
  const later = new Date("2026-11-20T12:00:00Z");
  const module = createLessons({
    database: f.db,
    now: () => later,
    notifications: async () => f.notifications,
  });
  await module.submit(
    await request(f.user.id, { intent: "mark-complete" }),
    f.path
  );
  await module.open(await request(f.user.id), f.path);
  expect(f.db.select().from(schema.lessonProgress).all()).toMatchObject([
    {
      userId: f.user.id,
      lessonId: f.lesson.id,
      status: "completed",
      completedAt: later.toISOString(),
    },
  ]);
});
