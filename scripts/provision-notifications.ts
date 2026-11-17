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
          template: z.object({ markdown_body: z.string() }),
        })
      )
      .length(1),
  }),
});
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
  const path = `/v1/workflows/${key}?environment=development&commit=true`;
  if (dryRun) {
    console.info(`PUT ${path}\n${JSON.stringify(body, null, 2)}`);
    continue;
  }
  const response = await fetch(`https://control.knock.app${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.KNOCK_MANAGEMENT_SERVICE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `Workflow ${key} provisioning failed (${response.status}). Inspect Knock Development; no automatic retry was attempted.`
    );
  console.info(
    `Committed ${key} in Development. Inspect its published category, active state and feed step before live acceptance.`
  );
}
