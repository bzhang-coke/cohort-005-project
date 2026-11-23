import { afterEach, expect, it } from "vitest";
import { fixture, request } from "./fixtures";

let f: ReturnType<typeof fixture>;
afterEach(() => f?.db.$client.close());

it.each(["", "0", "-1", "1.5", "garbage"])(
  "rejects invalid lesson and section ids (%s)",
  async (id) => {
    f = fixture();
    await expect(
      f.lessonModule.open(await request(), { ...f.path, lessonId: id })
    ).rejects.toMatchObject({
      data: "Invalid parameters",
      init: { status: 400 },
    });
    await expect(
      f.lessonModule.outline(await request(), {
        slug: f.path.slug,
        moduleId: id,
      })
    ).rejects.toMatchObject({
      data: "Invalid parameters",
      init: { status: 400 },
    });
  }
);

it("rejects empty slugs before looking up lessons or outlines", async () => {
  f = fixture();
  await expect(
    f.lessonModule.open(await request(), { ...f.path, slug: "" })
  ).rejects.toMatchObject({
    data: "Invalid parameters",
    init: { status: 400 },
  });
  await expect(
    f.lessonModule.outline(await request(), { slug: "" })
  ).rejects.toMatchObject({
    data: "Invalid parameters",
    init: { status: 400 },
  });
});

it("rejects bodies that are not forms and unknown actions", async () => {
  f = fixture();
  await expect(
    f.lessonModule.submit(
      new Request("http://localhost", { method: "POST", body: "not a form" }),
      f.path
    )
  ).rejects.toMatchObject({ data: "Invalid form body", init: { status: 400 } });
  await expect(
    f.lessonModule.submit(
      await request(f.user.id, { intent: "unknown" }),
      f.path
    )
  ).rejects.toMatchObject({ data: "Invalid action", init: { status: 400 } });
  await expect(
    f.lessonModule.replyFromInstructorQueue(
      await request(f.instructor.id, { intent: "unknown" })
    )
  ).rejects.toMatchObject({ data: "Invalid reply", init: { status: 400 } });
});

it.each([
  ["save-note", "Write something before saving your note"],
  ["create-comment", "Comment cannot be empty"],
  ["edit-comment", "Comment cannot be empty"],
])("treats a missing body as empty text for %s", async (intent, error) => {
  f = fixture();
  expect(
    await f.lessonModule.submit(
      await request(f.user.id, { intent, commentId: String(f.question.id) }),
      f.path
    )
  ).toMatchObject({ ok: false, error });
});

it("treats a missing queue reply body as empty text and rejects missing questions", async () => {
  f = fixture();
  expect(
    await f.lessonModule.replyFromInstructorQueue(
      await request(f.instructor.id, {
        intent: "reply",
        commentId: String(f.question.id),
      })
    )
  ).toEqual({ ok: false, error: "Comment cannot be empty" });
  await expect(
    f.lessonModule.replyFromInstructorQueue(
      await request(f.instructor.id, {
        intent: "reply",
        commentId: "999999",
        body: "Reply",
      })
    )
  ).rejects.toMatchObject({
    data: "Discussion Question not found",
    init: { status: 404 },
  });
});

it.each([
  ["question-nope", "1"],
  ["question-1", "nope"],
  ["question-0", "1"],
])("rejects malformed quiz answer %s=%s", async (key, value) => {
  f = fixture();
  await expect(
    f.lessonModule.submit(
      await request(f.user.id, {
        intent: "submit-quiz",
        quizId: String(f.quiz.id),
        [key]: value,
      }),
      f.path
    )
  ).rejects.toMatchObject({
    data: "Invalid quiz answers",
    init: { status: 400 },
  });
});

it.each([
  { eventType: "", positionSeconds: 0 },
  { eventType: "progress", positionSeconds: -1 },
])("rejects an invalid watch event %j", async (event) => {
  f = fixture();
  const base = await request(f.user.id);
  await expect(
    f.lessonModule.recordWatch(
      new Request(base.url, {
        method: "POST",
        headers: base.headers,
        body: JSON.stringify({ lessonId: f.lesson.id, ...event }),
      })
    )
  ).rejects.toMatchObject({
    data: "Invalid watch event",
    init: { status: 400 },
  });
});

it("accepts the first watch position at zero and rejects malformed JSON", async () => {
  f = fixture();
  const base = await request(f.user.id);
  expect(
    await f.lessonModule.recordWatch(
      new Request(base.url, {
        method: "POST",
        headers: base.headers,
        body: JSON.stringify({
          lessonId: f.lesson.id,
          positionSeconds: 0,
          eventType: "play",
        }),
      })
    )
  ).toEqual({ success: true });
  await expect(
    f.lessonModule.recordWatch(
      new Request(base.url, { method: "POST", body: "{" })
    )
  ).rejects.toMatchObject({ data: "Invalid JSON body", init: { status: 400 } });
});

it("ignores quiz answer fields on a note submission", async () => {
  f = fixture();
  expect(
    await f.lessonModule.submit(
      await request(f.user.id, {
        intent: "save-note",
        body: "A note",
        "question-invalid": "invalid",
      }),
      f.path
    )
  ).toEqual({ ok: true });
});
