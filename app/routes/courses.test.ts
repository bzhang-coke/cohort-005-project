import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { eq } from "drizzle-orm";
import { categories, courses, CourseStatus } from "~/db/schema";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import { loader } from "./courses";

let testDb: TestDb;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  testDb
    .update(courses)
    .set({ title: "O'Reilly SQL", description: "Learn parameterized queries" })
    .where(eq(courses.id, base.course.id))
    .run();

  const otherCategory = testDb
    .insert(categories)
    .values({ name: "Design", slug: "design" })
    .returning()
    .get();
  testDb
    .insert(courses)
    .values([
      {
        ...base.course,
        id: undefined,
        slug: "draft-course",
        title: "Private SQL draft",
        status: CourseStatus.Draft,
      },
      {
        ...base.course,
        id: undefined,
        slug: "design-course",
        title: "SQL for designers",
        categoryId: otherCategory.id,
      },
    ])
    .run();
});

afterEach(() => {
  testDb.$client.close();
});

async function searchCourses(search: string, category?: string) {
  const url = new URL("http://localhost/courses");
  url.searchParams.set("q", search);
  if (category) url.searchParams.set("category", category);
  return loader({
    request: new Request(url),
    url,
    params: {},
    pattern: "/courses",
    context: new RouterContextProvider(),
  });
}

describe("course catalog search", () => {
  it.each(["O'Reilly", "parameterized"])(
    "finds titles and descriptions containing %s",
    async (search) => {
      const result = await searchCourses(search);
      expect(result.courses.map((course) => course.id)).toEqual([
        base.course.id,
      ]);
    }
  );

  it("keeps publication and category filters when searching", async () => {
    const result = await searchCourses("SQL", "programming");
    expect(result.courses.map((course) => course.id)).toEqual([base.course.id]);
  });

  it.each(["') OR 1=1 OR (title LIKE '", "%' OR 1=1 OR title LIKE '%"])(
    "treats SQL injection payload %s as search text",
    async (search) => {
      const result = await searchCourses(search);
      expect(result.courses).toEqual([]);
    }
  );
});
