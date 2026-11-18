import { readdir, readFile } from "node:fs/promises";
import { z } from "zod";
import { loadNotificationEnvironment } from "../app/lib/notifications/config.server";

// Management credentials belong to this operator-run provisioning command,
// never the application runtime or browser. Committing JSON to Git alone does
// not publish a workflow in Knock.
loadNotificationEnvironment();
const args = z
  .array(z.literal("--dry-run"))
  .max(1)
  .parse(process.argv.slice(2));
const dryRun = args.includes("--dry-run");
const env = z
  .object({
    KNOCK_FEED_CHANNEL_KEY: z.string().min(1),
    KNOCK_MANAGEMENT_SERVICE_TOKEN: z.string().min(1).optional(),
  })
  .parse(process.env);
if (!dryRun && !env.KNOCK_MANAGEMENT_SERVICE_TOKEN)
  throw new Error("Set KNOCK_MANAGEMENT_SERVICE_TOKEN before provisioning.");
const directory = new URL("../notifications/workflows/", import.meta.url);
const definitionSchema = z.object({
  workflow: z.object({
    name: z.string(),
    description: z.string().optional(),
    categories: z.array(z.string()).length(1),
    settings: z.object({ override_preferences: z.literal(false) }),
    trigger_frequency: z.literal("every_trigger"),
    steps: z
      .array(
        z.object({
          ref: z.string(),
          type: z.literal("channel"),
          channel_type: z.literal("in_app_feed"),
          channel_key: z.literal("SET_KNOCK_FEED_CHANNEL_KEY"),
          template: z.object({
            markdown_body: z.string(),
            action_url: z.literal("{{ data.destination }}"),
          }),
        })
      )
      .length(1),
  }),
});
const definitions = [];
for (const file of (await readdir(directory))
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  const key = file.slice(0, -5);
  if (!/^cadence-[a-z-]+$/.test(key)) throw new Error("Invalid workflow key.");
  const definition = definitionSchema.parse(
    JSON.parse(await readFile(new URL(file, directory), "utf8"))
  );
  const body = {
    workflow: {
      ...definition.workflow,
      steps: definition.workflow.steps.map((step) => ({
        ...step,
        channel_key: env.KNOCK_FEED_CHANNEL_KEY,
      })),
    },
  };
  definitions.push({ key, body });
}

async function put(path: string, body?: unknown) {
  if (dryRun) {
    console.info(
      `PUT ${path}${body ? `\n${JSON.stringify(body, null, 2)}` : ""}`
    );
    return;
  }
  const response = await fetch(`https://control.knock.app${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.KNOCK_MANAGEMENT_SERVICE_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const failure = z
      .object({
        errors: z
          .array(z.object({ field: z.string(), message: z.string() }))
          .optional(),
      })
      .safeParse(await response.json().catch(() => undefined));
    const details = failure.success
      ? failure.data.errors
          ?.map((error) => `${error.field}: ${error.message}`)
          .join("; ")
      : undefined;
    throw new Error(
      `Notification provisioning failed for ${path} (${response.status}). ${details ? `${details}. ` : ""}Inspect Knock Development; no automatic retry was attempted.`
    );
  }
}

// Knock requires categories in the project-wide catalog before committing a
// workflow. Upsert preserves an existing active category with the same name.
const categories = new Set(
  definitions.flatMap(({ body }) => body.workflow.categories)
);
for (const category of categories) {
  await put(`/v1/preference_categories/${encodeURIComponent(category)}`);
  if (!dryRun) console.info(`Ensured preference category ${category}.`);
}

for (const { key, body } of definitions) {
  await put(`/v1/workflows/${key}?environment=development&commit=true`, body);
  if (dryRun) continue;
  console.info(
    `Committed ${key} in Development. Inspect its published category, active state and feed step before live acceptance.`
  );
}
