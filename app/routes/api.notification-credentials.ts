import { data } from "react-router";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/api.notification-credentials";
import { db } from "~/db";
import { users } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { notificationCredentials } from "~/lib/notifications/credentials.server";

export async function loader({ request }: Route.LoaderArgs) {
  const personId = await getCurrentUserId(request);
  if (!personId)
    throw data("You must be logged in.", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  const person = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, personId))
    .get();
  if (!person)
    throw data("Person not found.", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  try {
    return Response.json(notificationCredentials(person.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(
      `Notification credential issuance failed for person ${person.id}.`,
      error
    );
    throw data("Notifications could not connect. Please try again.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
