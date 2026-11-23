import { db } from "~/db";
import { defaultNotifications } from "~/lib/notifications.server";
import type { LessonDependencies, LessonPath, OutlinePath } from "./lib/types";
import { openLesson } from "./lib/read.server";
import { readOutline } from "./lib/outline.server";
import {
  recordWatch,
  replyFromInstructorQueue,
  submitLesson,
} from "./lib/write.server";

/** Protected Lesson operations. Callers supply requests, never permission flags. */
export function createLessons(dependencies: LessonDependencies) {
  return {
    open: (request: Request, path: LessonPath) =>
      openLesson(dependencies, request, path),
    submit: (request: Request, path: LessonPath) =>
      submitLesson(dependencies, request, path),
    recordWatch: (request: Request) => recordWatch(dependencies, request),
    replyFromInstructorQueue: (request: Request) =>
      replyFromInstructorQueue(dependencies, request),
    outline: (request: Request, path: OutlinePath) =>
      readOutline(dependencies, request, path),
  };
}

export const lessons = createLessons({
  database: db,
  notifications: defaultNotifications,
  now: () => new Date(),
});
