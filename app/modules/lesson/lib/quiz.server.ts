import { eq } from "drizzle-orm";
import { data } from "react-router";
import {
  quizzes,
  quizQuestions,
  quizOptions,
  quizAttempts,
  quizAnswers,
} from "~/db/schema";
import type { Db } from "./types";

function validateAnswers(
  db: Db,
  questions: (typeof quizQuestions.$inferSelect)[],
  answers: Map<number, number>
) {
  const questionIds = new Set(questions.map((question) => question.id));
  for (const [questionId, optionId] of answers) {
    const option = db
      .select({ questionId: quizOptions.questionId })
      .from(quizOptions)
      .where(eq(quizOptions.id, optionId))
      .get();
    if (!questionIds.has(questionId) || option?.questionId !== questionId)
      throw data("An answer does not belong to this quiz", { status: 400 });
  }
}

function gradeAnswers(
  db: Db,
  questions: (typeof quizQuestions.$inferSelect)[],
  answers: Map<number, number>
) {
  return questions.map((question) => {
    const selectedOptionId = answers.get(question.id) ?? null;
    const options = db
      .select()
      .from(quizOptions)
      .where(eq(quizOptions.questionId, question.id))
      .all();
    const correctOptionId =
      selectedOptionId === null
        ? null
        : (options.find((option) => option.isCorrect)?.id ?? null);
    return {
      questionId: question.id,
      selectedOptionId,
      correctOptionId,
      correct:
        selectedOptionId !== null && selectedOptionId === correctOptionId,
    };
  });
}

function grade(score: number) {
  return score >= 0.9
    ? "A"
    : score >= 0.8
      ? "B"
      : score >= 0.7
        ? "C"
        : score >= 0.6
          ? "D"
          : "F";
}

type QuizSubmission = {
  userId: number;
  lessonId: number;
  quizId: number;
  answers: Map<number, number>;
};

export function submitQuiz(
  db: Db,
  { userId, lessonId, quizId, answers }: QuizSubmission,
  now: Date
) {
  const quiz = db.select().from(quizzes).where(eq(quizzes.id, quizId)).get();
  if (!quiz || quiz.lessonId !== lessonId)
    throw data("Quiz not found in this Lesson", { status: 404 });
  const questions = db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId))
    .orderBy(quizQuestions.position)
    .all();
  validateAnswers(db, questions, answers);
  const questionResults = gradeAnswers(db, questions, answers);
  const totalCorrect = questionResults.filter(
    (result) => result.correct
  ).length;
  const score = questions.length ? totalCorrect / questions.length : 0;
  // Preserve the existing grading rule while changing authorization and target validation.
  const passed = score > 0.7;
  const attempt = db
    .insert(quizAttempts)
    .values({ userId, quizId, score, passed, attemptedAt: now.toISOString() })
    .returning()
    .get();
  for (const result of questionResults) {
    if (result.selectedOptionId !== null)
      db.insert(quizAnswers)
        .values({
          attemptId: attempt.id,
          questionId: result.questionId,
          selectedOptionId: result.selectedOptionId,
        })
        .run();
  }
  return {
    attemptId: attempt.id,
    score,
    passed,
    grade: grade(score),
    totalCorrect,
    totalQuestions: questions.length,
    questionResults,
  };
}
