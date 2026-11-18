import { data } from "react-router";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Route } from "./+types/api.notification-preferences";
import { db } from "~/db";
import { users } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { notificationCategories } from "~/lib/notifications";
import { getNotificationSettings } from "~/lib/notifications.server";
import { notificationTransportContext } from "~/lib/notifications/transport.server";
import { getNotificationTransport } from "~/lib/notifications/config.server";

const changeSchema = z
  .object({
    category: z.enum(notificationCategories),
    channel: z.literal("feed"),
    enabled: z.boolean(),
  })
  .strict();

async function currentPerson(request: Request) {
  const personId = await getCurrentUserId(request);
  if (!personId) throw data("You must be logged in.", { status: 401 });
  const person = db.select().from(users).where(eq(users.id, personId)).get();
  if (!person) throw data("Person not found.", { status: 404 });
  return person;
}

async function readSettings(
  person: typeof users.$inferSelect,
  context: Route.LoaderArgs["context"]
) {
  try {
    const transport =
      context.get(notificationTransportContext) ?? getNotificationTransport();
    const settings = await getNotificationSettings(db, person, transport);
    return { transport, settings };
  } catch (error) {
    console.error(
      `Notification preference read failed for person ${person.id}.`,
      error
    );
    throw data(
      "Notification preferences could not be loaded. Please try again.",
      { status: 503 }
    );
  }
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const person = await currentPerson(request);
  const { settings } = await readSettings(person, context);
  return settings;
}

export async function action({ request, context }: Route.ActionArgs) {
  const person = await currentPerson(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw data("Invalid Notification preference.", { status: 400 });
  }
  const parsed = changeSchema.safeParse(body);
  if (!parsed.success)
    throw data("Invalid Notification preference.", { status: 400 });
  const { transport, settings } = await readSettings(person, context);
  if (!settings.categories.includes(parsed.data.category))
    throw data(
      "This Notification category is not available for your account.",
      { status: 403 }
    );
  if (settings.status !== "ready")
    throw data(
      "Notification preferences are unavailable. Please try again later.",
      { status: 503 }
    );
  try {
    const preferences = await transport.setPreference(person.id, parsed.data);
    return { ...settings, preferences };
  } catch (error) {
    console.error(
      `Notification preference save failed for person ${person.id}.`,
      error
    );
    throw data(
      "Notification preference could not be saved. Please try again.",
      { status: 503 }
    );
  }
}
