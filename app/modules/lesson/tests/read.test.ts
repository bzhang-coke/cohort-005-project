import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import * as renderer from "~/lib/markdown.server";
import { markdown } from "~/lib/text";
import { fixture, otherLesson, request, NOW } from "./fixtures";

let f: ReturnType<typeof fixture>;
afterEach(() => {
  f?.db.$client.close();
  vi.restoreAllMocks();
});

it("returns content, quiz choices and the current person's presentation data", async () => {
  f = fixture();
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({
    kind: "content",
    course: { id: f.course.id, title: f.course.title, slug: f.course.slug },
    module: { id: f.section.id, title: f.section.title },
    lesson: {
      id: f.lesson.id,
      title: f.lesson.title,
      durationMinutes: 10,
      videoUrl: f.lesson.videoUrl,
      githubRepoUrl: f.lesson.githubRepoUrl,
    },
    instructorName: f.instructor.name,
    currentUserId: f.user.id,
    canModerate: false,
    prevLesson: null,
    nextLesson: null,
    quiz: {
      id: f.quiz.id,
      title: f.quiz.title,
      passingScore: 70,
      questions: [
        {
          id: f.quizQuestion.id,
          questionText: "PRIVATE_QUESTION",
          questionType: schema.QuestionType.MultipleChoice,
          position: 1,
          options: [
            { id: f.correct.id, optionText: "PRIVATE_OPTION" },
            { id: f.wrong.id, optionText: "Wrong" },
          ],
        },
      ],
    },
    comments: [
      {
        id: f.question.id,
        body: "PRIVATE_DISCUSSION",
        bodyHtml: "<p>PRIVATE_DISCUSSION</p>\n",
        editedAt: null,
        deleted: false,
        author: {
          id: f.user.id,
          name: f.user.name,
          avatarUrl: f.user.avatarUrl,
          isInstructor: false,
          isPlatformAdmin: false,
        },
        replies: [],
      },
    ],
  });
});

it("orders the curriculum and navigation by position across sections", async () => {
  f = fixture();
  const lastSection = f.db
    .insert(schema.modules)
    .values({ courseId: f.course.id, title: "Last", position: 5 })
    .returning()
    .get();
  const last = f.db
    .insert(schema.lessons)
    .values({ moduleId: lastSection.id, title: "Last lesson", position: 1 })
    .returning()
    .get();
  const previous = f.db
    .insert(schema.lessons)
    .values({ moduleId: f.section.id, title: "Earlier lesson", position: 0 })
    .returning()
    .get();
  const next = f.db
    .insert(schema.lessons)
    .values({ moduleId: f.section.id, title: "Next lesson", position: 3 })
    .returning()
    .get();
  const page = await f.lessonModule.open(await request(f.user.id), f.path);
  expect(page).toMatchObject({
    prevLesson: { id: previous.id, title: previous.title },
    nextLesson: { id: next.id, title: next.title },
    curriculum: [
      {
        id: f.section.id,
        lessons: [{ id: previous.id }, { id: f.lesson.id }, { id: next.id }],
      },
      { id: lastSection.id, lessons: [{ id: last.id }] },
    ],
  });
  expect(
    await f.lessonModule.open(await request(f.user.id), {
      ...f.path,
      lessonId: String(last.id),
    })
  ).toMatchObject({
    prevLesson: { id: next.id },
    nextLesson: null,
    quiz: null,
    contentHtml: null,
  });
});

it("keeps replies on a deleted question, hides deleted replies, and labels staff authors", async () => {
  f = fixture();
  const admin = f.db
    .insert(schema.users)
    .values({
      name: "Admin",
      email: "read-admin@example.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();
  const replies = f.db
    .insert(schema.comments)
    .values([
      {
        userId: f.instructor.id,
        lessonId: f.lesson.id,
        parentId: f.question.id,
        body: markdown("Instructor reply"),
        createdAt: NOW.toISOString(),
      },
      {
        userId: admin.id,
        lessonId: f.lesson.id,
        parentId: f.question.id,
        body: markdown("Admin reply"),
        createdAt: NOW.toISOString(),
      },
      {
        userId: f.user.id,
        lessonId: f.lesson.id,
        parentId: f.question.id,
        body: markdown("Deleted reply"),
        deletedAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
      },
    ])
    .returning()
    .all();
  f.db
    .update(schema.comments)
    .set({ deletedAt: NOW.toISOString(), editedAt: NOW.toISOString() })
    .where(eq(schema.comments.id, f.question.id))
    .run();
  const page = await f.lessonModule.open(await request(f.user.id), f.path);
  expect(page).toMatchObject({
    comments: [
      {
        id: f.question.id,
        body: "",
        bodyHtml: "",
        editedAt: null,
        deleted: true,
        replies: [
          {
            id: replies[0].id,
            body: "Instructor reply",
            author: { isInstructor: true, isPlatformAdmin: false },
          },
          {
            id: replies[1].id,
            body: "Admin reply",
            author: { isInstructor: false, isPlatformAdmin: true },
          },
        ],
      },
    ],
  });
  expect(JSON.stringify(page)).not.toContain("Deleted reply");
});

it("rechecks enrollment after rendering before returning private content or starting progress", async () => {
  f = fixture();
  vi.spyOn(renderer, "renderMarkdown").mockImplementation(async () => {
    f.db
      .delete(schema.enrollments)
      .where(eq(schema.enrollments.userId, f.user.id))
      .run();
    return "<p>PRIVATE_LESSON_BODY</p>";
  });
  const page = await f.lessonModule.open(await request(f.user.id), f.path);
  expect(page).toMatchObject({
    kind: "preview",
    restriction: { kind: "enrollment-required" },
  });
  expect(JSON.stringify(page)).not.toContain("PRIVATE_");
  expect(f.db.select().from(schema.lessonProgress).all()).toEqual([]);
});

it("returns only the requested course's public outline and accepts a section in that course", async () => {
  f = fixture();
  otherLesson(f);
  const extraSection = f.db
    .insert(schema.modules)
    .values({ courseId: f.course.id, title: "Empty section", position: 2 })
    .returning()
    .get();
  f.db
    .insert(schema.lessons)
    .values([
      {
        moduleId: f.section.id,
        title: "No video",
        position: 3,
        videoUrl: null,
      },
      {
        moduleId: f.section.id,
        title: "Empty video",
        position: 2,
        videoUrl: "",
      },
    ])
    .run();
  const outline = await f.lessonModule.outline(await request(), {
    slug: f.course.slug,
    moduleId: String(f.section.id),
  });
  expect(outline).toMatchObject({
    course: { id: f.course.id, title: f.course.title, slug: f.course.slug },
    modules: [
      {
        id: f.section.id,
        courseId: f.course.id,
        title: f.section.title,
        position: 1,
        lessons: [
          {
            id: f.lesson.id,
            moduleId: f.section.id,
            title: f.lesson.title,
            position: 1,
            durationMinutes: 10,
            hasVideo: true,
          },
          { title: "Empty video", hasVideo: false },
          { title: "No video", hasVideo: false },
        ],
      },
      { id: extraSection.id, lessons: [] },
    ],
  });
  await expect(
    f.lessonModule.outline(await request(), { slug: "missing" })
  ).rejects.toMatchObject({ data: "Course not found", init: { status: 404 } });
  await expect(
    f.lessonModule.outline(await request(), {
      slug: f.course.slug,
      moduleId: "99999",
    })
  ).rejects.toMatchObject({
    data: "Module not found in this course",
    init: { status: 404 },
  });
  await expect(
    f.lessonModule.open(await request(), { ...f.path, lessonId: "99999" })
  ).rejects.toMatchObject({
    data: "Lesson not found in this course",
    init: { status: 404 },
  });
});

it("omits replies whose question is outside this lesson", async () => {
  f = fixture();
  const other = otherLesson(f);
  f.db
    .insert(schema.comments)
    .values({
      userId: f.user.id,
      lessonId: f.lesson.id,
      parentId: other.discussion.id,
      body: markdown("Misplaced reply"),
    })
    .run();
  const page = await f.lessonModule.open(await request(f.user.id), f.path);
  expect(page).toMatchObject({
    comments: [{ id: f.question.id, replies: [] }],
  });
  expect(JSON.stringify(page)).not.toContain("Misplaced reply");
});
