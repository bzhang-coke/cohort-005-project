import { afterEach, beforeEach, expect, vi } from "vitest";

// Tests configure their own environment; never read a developer's credentials.
vi.mock("node:process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:process")>()),
  loadEnvFile: vi.fn(),
}));

// Adapter tests replace this boundary with controlled responses. A forgotten
// injection must fail even when the application catches delivery errors.
const unexpectedFetch = vi.fn<typeof fetch>(async () => {
  throw new Error("Unexpected HTTP request. Inject a fake transport in tests.");
});
globalThis.fetch = unexpectedFetch;

beforeEach(() => {
  unexpectedFetch.mockClear();
  for (const name of [
    "KNOCK_SECRET_API_KEY",
    "KNOCK_PUBLIC_API_KEY",
    "KNOCK_SIGNING_KEY",
    "KNOCK_FEED_CHANNEL_ID",
  ])
    vi.stubEnv(name, "test-only-not-a-credential");
});

afterEach(() => {
  vi.unstubAllEnvs();
  expect(unexpectedFetch.mock.calls.length).toBe(0);
});
