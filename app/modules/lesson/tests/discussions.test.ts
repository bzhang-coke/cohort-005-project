import { afterEach, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { createLessons } from "../index.server";
import { fixture, otherLesson, request, NOW } from "./fixtures";

let f: ReturnType<typeof fixture>;
afterEach(() => {
  f?.db.$client.close();
  vi.restoreAllMocks();
});

it("lets an author edit and delete their own discussion without moderation rights", async () => {
  f = fixture();
  expect(
    await f.lessonModule.submit(
      await request(f.user.id, {
        intent: "edit-comment",
        commentId: String(f.question.id),
        body: " Revised **answer** ",
      }),
      f.path
    )
  ).toEqual({ ok: true });
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({
    comments: [
      {
        body: "Revised **answer**",
        bodyHtml: "<p>Revised <strong>answer</strong></p>\n",
        editedAt: NOW.toISOString(),
      },
    ],
  });
  expect(
    await f.lessonModule.submit(
      await request(f.user.id, {
        intent: "delete-comment",
        commentId: String(f.question.id),
      }),
      f.path
    )
  ).toEqual({ ok: true });
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({ comments: [] });
});

it("refuses another student's edits and deletions with actionable errors", async () => {
  f = fixture();
  const stranger = f.db
    .insert(schema.users)
    .values({
      name: "Peer",
      email: "peer@example.com",
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
  f.db
    .insert(schema.enrollments)
    .values({ userId: stranger.id, courseId: f.course.id })
    .run();
  await expect(
    f.lessonModule.submit(
      await request(stranger.id, {
        intent: "edit-comment",
        commentId: String(f.question.id),
        body: "Overwrite",
      }),
      f.path
    )
  ).rejects.toMatchObject({
    data: "You can only edit your own Discussion.",
    init: { status: 403 },
  });
  await expect(
    f.lessonModule.submit(
      await request(stranger.id, {
        intent: "delete-comment",
        commentId: String(f.question.id),
      }),
      f.path
    )
  ).rejects.toMatchObject({
    data: "You cannot delete this Discussion.",
    init: { status: 403 },
  });
  await expect(
    f.lessonModule.replyFromInstructorQueue(
      await request(stranger.id, {
        intent: "reply",
        commentId: String(f.question.id),
        body: "Staff reply",
      })
    )
  ).rejects.toMatchObject({
    data: "Only this course's Instructor can reply here.",
    init: { status: 403 },
  });
});

it("attaches student replies to their question and rejects cross-lesson and missing targets", async () => {
  f = fixture();
  const other = otherLesson(f);
  expect(
    await f.lessonModule.submit(
      await request(f.user.id, {
        intent: "create-comment",
        parentId: String(f.question.id),
        body: "Follow-up",
      }),
      f.path
    )
  ).toEqual({ ok: true });
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({
    comments: [{ id: f.question.id, replies: [{ body: "Follow-up" }] }],
  });
  for (const parentId of [other.discussion.id, 99999]) {
    await expect(
      f.lessonModule.submit(
        await request(f.user.id, {
          intent: "create-comment",
          parentId: String(parentId),
          body: "Wrong lesson",
        }),
        f.path
      )
    ).rejects.toMatchObject({
      data: "Discussion not found in this Lesson",
      init: { status: 404 },
    });
  }
});

it("rejects unauthorized discussions before initializing notifications", async () => {
  f = fixture();
  const notifications = vi.fn(async () => f.notifications);
  const module = createLessons({
    database: f.db,
    now: () => NOW,
    notifications,
  });
  await expect(
    module.submit(
      await request(f.user.id, {
        intent: "delete-comment",
        commentId: "99999",
      }),
      f.path
    )
  ).rejects.toMatchObject({ init: { status: 404 } });
  expect(notifications).not.toHaveBeenCalled();
});

it("saves discussions when notification initialization fails and logs the cause", async () => {
  f = fixture();
  const failure = new Error("Notification configuration unavailable");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const module = createLessons({
    database: f.db,
    now: () => NOW,
    notifications: async () => {
      throw failure;
    },
  });
  expect(
    await module.submit(
      await request(f.user.id, {
        intent: "create-comment",
        body: "Still saved",
      }),
      f.path
    )
  ).toEqual({ ok: true });
  expect(await module.open(await request(f.user.id), f.path)).toMatchObject({
    comments: expect.arrayContaining([
      expect.objectContaining({ body: "Still saved" }),
    ]),
  });
  expect(log).toHaveBeenCalledWith(
    "[notifications] Could not initialize Discussion Notifications:",
    failure.message
  );
});

it("requires a signed-in user before revealing whether a queue question exists", async () => {
  f = fixture();
  await expect(
    f.lessonModule.replyFromInstructorQueue(
      await request(undefined, {
        intent: "reply",
        commentId: "99999",
        body: "Reply",
      })
    )
  ).rejects.toMatchObject({
    data: "Select a user from the DevUI panel.",
    init: { status: 401 },
  });
});

it("lets a student reply to another student's question", async () => {
  f = fixture();
  const peer = f.db
    .insert(schema.users)
    .values({
      name: "Peer",
      email: "reply-peer@example.com",
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
  f.db
    .insert(schema.enrollments)
    .values({ userId: peer.id, courseId: f.course.id })
    .run();
  expect(
    await f.lessonModule.submit(
      await request(peer.id, {
        intent: "create-comment",
        parentId: String(f.question.id),
        body: "Here is how I solved it",
      }),
      f.path
    )
  ).toEqual({ ok: true });
  expect(
    await f.lessonModule.open(await request(f.user.id), f.path)
  ).toMatchObject({
    comments: [
      {
        id: f.question.id,
        replies: [{ body: "Here is how I solved it", author: { id: peer.id } }],
      },
    ],
  });
  expect(f.notifications.sent).toMatchObject([
    { kind: "discussion-reply", recipient: { id: f.user.id } },
  ]);
});
