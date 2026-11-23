import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { markdown, plainText } from "~/lib/text";
import { setCurrentUserId } from "~/lib/session";
import { fakeNotifications } from "~/lib/notifications.fake.server";
import { createLessons } from "../index.server";

export const NOW = new Date("2026-11-19T12:00:00Z");

function seedLesson(db: TestDb, courseId: number) {
  const section = db
    .insert(schema.modules)
    .values({ courseId, title: "Basics", position: 1 })
    .returning()
    .get();
  const lesson = db
    .insert(schema.lessons)
    .values({
      moduleId: section.id,
      title: "First lesson",
      position: 1,
      durationMinutes: 10,
      content: markdown("PRIVATE_LESSON_BODY"),
      videoUrl: "https://youtube.com/watch?v=PRIVATE_VID",
      githubRepoUrl: "https://github.com/private/PRIVATE_CODE",
    })
    .returning()
    .get();
  return { section, lesson };
}

function seedActivity(db: TestDb, userId: number, lessonId: number) {
  db.insert(schema.notes)
    .values({
      userId,
      lessonId,
      body: plainText("PRIVATE_NOTE"),
    })
    .run();
  db.insert(schema.bookmarks).values({ userId, lessonId }).run();
  return db
    .insert(schema.comments)
    .values({
      userId,
      lessonId,
      body: markdown("PRIVATE_DISCUSSION"),
    })
    .returning()
    .get();
}

function seedQuiz(db: TestDb, lessonId: number) {
  const quiz = db
    .insert(schema.quizzes)
    .values({ lessonId, title: "PRIVATE_QUIZ", passingScore: 70 })
    .returning()
    .get();
  const quizQuestion = db
    .insert(schema.quizQuestions)
    .values({
      quizId: quiz.id,
      questionText: "PRIVATE_QUESTION",
      questionType: schema.QuestionType.MultipleChoice,
      position: 1,
    })
    .returning()
    .get();
  const correct = db
    .insert(schema.quizOptions)
    .values({
      questionId: quizQuestion.id,
      optionText: "PRIVATE_OPTION",
      isCorrect: true,
    })
    .returning()
    .get();
  const wrong = db
    .insert(schema.quizOptions)
    .values({
      questionId: quizQuestion.id,
      optionText: "Wrong",
      isCorrect: false,
    })
    .returning()
    .get();
  return { quiz, quizQuestion, correct, wrong };
}

export function fixture() {
  const db = createTestDb();
  const base = seedBaseData(db);
  const { section, lesson } = seedLesson(db, base.course.id);
  db.insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  const question = seedActivity(db, base.user.id, lesson.id);
  const quiz = seedQuiz(db, lesson.id);
  const notifications = fakeNotifications();
  const lessonModule = createLessons({
    database: db,
    notifications: async () => notifications,
    now: () => NOW,
  });
  const path = { slug: base.course.slug, lessonId: String(lesson.id) };
  return {
    db,
    ...base,
    section,
    lesson,
    question,
    ...quiz,
    notifications,
    lessonModule,
    path,
  };
}

export async function request(
  personId?: number,
  fields?: Record<string, string>,
  country = "US"
) {
  const headers = new Headers({ "CF-IPCountry": country });
  if (personId !== undefined) {
    headers.set(
      "Cookie",
      await setCurrentUserId(new Request("http://localhost"), personId)
    );
  }
  return new Request("http://localhost/lesson", {
    headers,
    ...(fields ? { method: "POST", body: new URLSearchParams(fields) } : {}),
  });
}

export async function watchRequest(
  personId: number | undefined,
  { lessonId, positionSeconds }: { lessonId: number; positionSeconds: number },
  country = "US"
) {
  const base = await request(personId, undefined, country);
  const headers = new Headers(base.headers);
  headers.set("Content-Type", "application/json");
  return new Request(base.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ lessonId, positionSeconds, eventType: "progress" }),
  });
}

function seedOtherQuiz(db: TestDb, lessonId: number) {
  const quiz = db
    .insert(schema.quizzes)
    .values({ lessonId, title: "Other quiz", passingScore: 70 })
    .returning()
    .get();
  const question = db
    .insert(schema.quizQuestions)
    .values({
      quizId: quiz.id,
      questionText: "Other question",
      questionType: schema.QuestionType.MultipleChoice,
      position: 1,
    })
    .returning()
    .get();
  const option = db
    .insert(schema.quizOptions)
    .values({
      questionId: question.id,
      optionText: "Other option",
      isCorrect: true,
    })
    .returning()
    .get();
  return { quiz, question, option };
}

export function otherLesson(f: ReturnType<typeof fixture>) {
  const course = f.db
    .insert(schema.courses)
    .values({
      ...f.course,
      id: undefined,
      slug: "other-course",
      title: "Other Course",
    })
    .returning()
    .get();
  const section = f.db
    .insert(schema.modules)
    .values({ courseId: course.id, title: "Other section", position: 1 })
    .returning()
    .get();
  const lesson = f.db
    .insert(schema.lessons)
    .values({ moduleId: section.id, title: "Other lesson", position: 1 })
    .returning()
    .get();
  const quiz = seedOtherQuiz(f.db, lesson.id);
  const discussion = f.db
    .insert(schema.comments)
    .values({
      userId: f.instructor.id,
      lessonId: lesson.id,
      body: markdown("Other course discussion"),
    })
    .returning()
    .get();
  return { course, section, lesson, ...quiz, discussion };
}
