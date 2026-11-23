import { afterAll, expect, it, vi } from "vitest";
import { db } from "~/db";
import { purchases } from "~/db/schema";
import { seedBaseData } from "~/test/setup";
import { instructorAnalytics } from "../index.server";

vi.mock("~/db", async () => {
  const { createTestDb } = await import("~/test/setup");
  return { db: createTestDb() };
});

afterAll(() => db.$client.close());

it("binds the default analytics service to the application's database", () => {
  const base = seedBaseData(db);
  db.insert(purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 2500,
      createdAt: "2026-10-04T12:00:00.000Z",
    })
    .run();

  const result = instructorAnalytics.get(
    { userId: base.instructor.id, isAdmin: false },
    new URLSearchParams(),
    new Date("2026-10-06T12:00:00.000Z")
  );

  expect(result.summary).toEqual({
    grossCents: 2500,
    feeCents: 500,
    netCents: 2000,
    purchaseCount: 1,
  });
});
