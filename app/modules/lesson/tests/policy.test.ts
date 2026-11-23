import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import * as renderer from "~/lib/markdown.server";
import { fixture, request } from "./fixtures";

let f: ReturnType<typeof fixture>;
afterEach(() => {
  f?.db.$client.close();
  vi.restoreAllMocks();
});

it("serves a signed-out preview without rendering protected content", async () => {
  f = fixture();
  vi.spyOn(renderer, "renderMarkdown").mockRejectedValue(
    new Error("Protected renderer unavailable")
  );
  expect(await f.lessonModule.open(await request(), f.path)).toMatchObject({
    kind: "preview",
    restriction: { kind: "enrollment-required" },
  });
});

it("asks a lapsed student to enroll even when an old purchase was country-locked", async () => {
  f = fixture();
  f.db
    .update(schema.courses)
    .set({ price: 7900, pppEnabled: true })
    .where(eq(schema.courses.id, f.course.id))
    .run();
  f.db
    .insert(schema.purchases)
    .values({
      userId: f.user.id,
      courseId: f.course.id,
      country: "IN",
      amountPaid: 3950,
    })
    .run();
  f.db
    .delete(schema.enrollments)
    .where(eq(schema.enrollments.userId, f.user.id))
    .run();
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({
    kind: "preview",
    restriction: { kind: "enrollment-required" },
  });
  await expect(
    f.lessonModule.submit(
      await request(f.user.id, { intent: "mark-complete" }),
      f.path
    )
  ).rejects.toMatchObject({
    data: "You must have an Enrollment and permission to use this Lesson.",
    init: { status: 403 },
  });
});

it("explains publication and country denials without exposing lesson content", async () => {
  f = fixture();
  f.db
    .update(schema.courses)
    .set({ status: schema.CourseStatus.Draft })
    .where(eq(schema.courses.id, f.course.id))
    .run();
  await expect(
    f.lessonModule.open(await request(f.user.id), f.path)
  ).rejects.toMatchObject({ data: "Course not found", init: { status: 404 } });
  f.db
    .update(schema.courses)
    .set({
      status: schema.CourseStatus.Archived,
      price: 7900,
      pppEnabled: true,
    })
    .where(eq(schema.courses.id, f.course.id))
    .run();
  f.db
    .insert(schema.purchases)
    .values({
      userId: f.user.id,
      courseId: f.course.id,
      country: "IN",
      amountPaid: 3950,
    })
    .run();
  await expect(
    f.lessonModule.open(await request(f.user.id), f.path)
  ).rejects.toMatchObject({
    data: "You cannot view this Lesson from your current country.",
    init: { status: 403 },
  });
});
