import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { fixture, otherLesson, request, NOW } from "./fixtures";

let f: ReturnType<typeof fixture>;
afterEach(() => f?.db.$client.close());

async function submit(answers: Record<string, string> = {}) {
  return f.lessonModule.submit(
    await request(f.user.id, {
      intent: "submit-quiz",
      quizId: String(f.quiz.id),
      ...answers,
    }),
    f.path
  );
}

it.each([
  [0, "F", false],
  [5, "F", false],
  [6, "D", false],
  [7, "C", false],
  [8, "B", true],
  [9, "A", true],
  [10, "A", true],
] as const)(
  "grades %i correct answers out of ten as %s",
  async (correctCount, grade, passed) => {
    f = fixture();
    const answers: Record<string, string> = {};
    for (let index = 0; index < 10; index++) {
      const question =
        index === 0
          ? f.quizQuestion
          : f.db
              .insert(schema.quizQuestions)
              .values({
                quizId: f.quiz.id,
                questionText: `Question ${index}`,
                questionType: schema.QuestionType.MultipleChoice,
                position: index + 1,
              })
              .returning()
              .get();
      const options =
        index === 0
          ? [f.correct, f.wrong]
          : f.db
              .insert(schema.quizOptions)
              .values([
                {
                  questionId: question.id,
                  optionText: "Correct",
                  isCorrect: true,
                },
                {
                  questionId: question.id,
                  optionText: "Wrong",
                  isCorrect: false,
                },
              ])
              .returning()
              .all();
      answers[`question-${question.id}`] = String(
        options[index < correctCount ? 0 : 1].id
      );
    }
    const result = await submit(answers);
    expect(result).toMatchObject({
      quizResult: {
        score: correctCount / 10,
        grade,
        passed,
        totalCorrect: correctCount,
        totalQuestions: 10,
      },
    });
    expect(f.db.select().from(schema.quizAnswers).all()).toHaveLength(10);
    expect(f.db.select().from(schema.quizAttempts).all()).toMatchObject([
      {
        userId: f.user.id,
        quizId: f.quiz.id,
        attemptedAt: NOW.toISOString(),
        passed,
      },
    ]);
  }
);

it("reports selected and correct options, persists answers, and keeps the best attempt", async () => {
  f = fixture();
  const success = await submit({
    [`question-${f.quizQuestion.id}`]: String(f.correct.id),
  });
  expect(success).toEqual({
    quizResult: {
      attemptId: expect.any(Number),
      score: 1,
      passed: true,
      grade: "A",
      totalCorrect: 1,
      totalQuestions: 1,
      questionResults: [
        {
          questionId: f.quizQuestion.id,
          selectedOptionId: f.correct.id,
          correctOptionId: f.correct.id,
          correct: true,
        },
      ],
    },
  });
  const failure = await submit({
    [`question-${f.quizQuestion.id}`]: String(f.wrong.id),
  });
  expect(failure).toMatchObject({
    quizResult: {
      score: 0,
      passed: false,
      grade: "F",
      totalCorrect: 0,
      questionResults: [
        {
          questionId: f.quizQuestion.id,
          selectedOptionId: f.wrong.id,
          correctOptionId: f.correct.id,
          correct: false,
        },
      ],
    },
  });
  expect(f.db.select().from(schema.quizAnswers).all()).toMatchObject([
    { questionId: f.quizQuestion.id, selectedOptionId: f.correct.id },
    { questionId: f.quizQuestion.id, selectedOptionId: f.wrong.id },
  ]);
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ learning: { bestAttempt: { score: 1, passed: true } } });
});

it("scores unanswered questions without revealing their answers or saving a selection", async () => {
  f = fixture();
  expect(await submit()).toEqual({
    quizResult: {
      attemptId: expect.any(Number),
      score: 0,
      passed: false,
      grade: "F",
      totalCorrect: 0,
      totalQuestions: 1,
      questionResults: [
        {
          questionId: f.quizQuestion.id,
          selectedOptionId: null,
          correctOptionId: null,
          correct: false,
        },
      ],
    },
  });
  expect(f.db.select().from(schema.quizAnswers).all()).toEqual([]);
});

it("scores a quiz with no questions as zero", async () => {
  f = fixture();
  f.db.delete(schema.quizOptions).run();
  f.db.delete(schema.quizQuestions).run();
  expect(await submit()).toEqual({
    quizResult: {
      attemptId: expect.any(Number),
      score: 0,
      passed: false,
      grade: "F",
      totalCorrect: 0,
      totalQuestions: 0,
      questionResults: [],
    },
  });
});

it("marks an answer wrong when the question has no correct option", async () => {
  f = fixture();
  f.db
    .update(schema.quizOptions)
    .set({ isCorrect: false })
    .where(eq(schema.quizOptions.id, f.correct.id))
    .run();
  expect(
    await submit({ [`question-${f.quizQuestion.id}`]: String(f.correct.id) })
  ).toMatchObject({
    quizResult: {
      score: 0,
      passed: false,
      questionResults: [
        {
          selectedOptionId: f.correct.id,
          correctOptionId: null,
          correct: false,
        },
      ],
    },
  });
});

it("rejects missing quizzes and answers belonging to another quiz before saving an attempt", async () => {
  f = fixture();
  const other = otherLesson(f);
  await expect(submit({ quizId: "999999" })).rejects.toMatchObject({
    data: "Quiz not found in this Lesson",
    init: { status: 404 },
  });
  await expect(
    submit({ [`question-${other.question.id}`]: String(other.option.id) })
  ).rejects.toMatchObject({
    data: "An answer does not belong to this quiz",
    init: { status: 400 },
  });
  await expect(
    submit({ [`question-${f.quizQuestion.id}`]: "999999" })
  ).rejects.toMatchObject({
    data: "An answer does not belong to this quiz",
    init: { status: 400 },
  });
  expect(f.db.select().from(schema.quizAttempts).all()).toEqual([]);
});
