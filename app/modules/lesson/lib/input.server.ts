import { data } from "react-router";
import { z } from "zod";

export const positiveId = z.coerce.number().int().positive();
export const lessonPathSchema = z.object({
  slug: z.string().min(1),
  lessonId: positiveId,
});
export const outlinePathSchema = z.object({
  slug: z.string().min(1),
  moduleId: positiveId.optional(),
});
export async function formBody(request: Request) {
  try {
    return await request.formData();
  } catch {
    throw data("Invalid form body", { status: 400 });
  }
}
const schema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("mark-complete") }),
  z.object({ intent: z.literal("toggle-bookmark") }),
  z.object({ intent: z.literal("save-note"), body: z.string().default("") }),
  z.object({
    intent: z.literal("create-comment"),
    body: z.string().default(""),
    parentId: positiveId.optional(),
  }),
  z.object({
    intent: z.literal("edit-comment"),
    body: z.string().default(""),
    commentId: positiveId,
  }),
  z.object({ intent: z.literal("delete-comment"), commentId: positiveId }),
  z.object({ intent: z.literal("submit-quiz"), quizId: positiveId }),
]);

export async function submission(request: Request) {
  const form = await formBody(request);
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) throw data("Invalid action", { status: 400 });
  const answers = new Map<number, number>();
  if (parsed.data.intent === "submit-quiz") {
    for (const [key, value] of form) {
      if (!key.startsWith("question-")) continue;
      const question = positiveId.safeParse(key.slice("question-".length));
      const option = positiveId.safeParse(value);
      if (!question.success || !option.success || answers.has(question.data))
        throw data("Invalid quiz answers", { status: 400 });
      answers.set(question.data, option.data);
    }
  }
  return { command: parsed.data, answers };
}
export type DiscussionCommand = Extract<
  z.infer<typeof schema>,
  { intent: "create-comment" | "edit-comment" | "delete-comment" }
>;
