import * as sandcastle from "@ai-hero/sandcastle";
import * as fs from "node:fs";
import * as path from "node:path";

export const outputDir = (): string => process.env.OUTPUT_DIR ?? "/tmp";

export const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
};

export const writeJson = (filename: string, value: unknown): void => {
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(
    path.join(outputDir(), filename),
    JSON.stringify(value, null, 2)
  );
};

// The shared agent uses Codex with the workflow's OpenAI API key.
// Keep the existing factory name for the workflow entry points.
export const claudeAgent = () =>
  sandcastle.codex("gpt-6", {
    env: {
      CODEX_API_KEY: required("OPENAI_API_KEY"),
    },
  });
