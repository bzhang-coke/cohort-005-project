import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { createTestDb, seedBaseData } from "~/test/setup";
import { setCurrentUserId } from "~/lib/session";
import { loader } from "./api.notification-credentials";

vi.mock("~/db", () => ({
  get db() {
    return db;
  },
}));
let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signingKey = keys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  vi.stubEnv("KNOCK_SECRET_API_KEY", "test-secret");
  vi.stubEnv("KNOCK_PUBLIC_API_KEY", "test-public");
  vi.stubEnv("KNOCK_FEED_CHANNEL_ID", "test-feed");
  vi.stubEnv("KNOCK_SIGNING_KEY", Buffer.from(signingKey).toString("base64"));
});
afterEach(() => {
  db.$client.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function load(personId: number | null) {
  const url = new URL(
    `http://localhost/api/notification-credentials?personId=${base.instructor.id}`
  );
  const cookie =
    personId === null ? "" : await setCurrentUserId(new Request(url), personId);
  return loader({
    request: new Request(url, { headers: { Cookie: cookie } }),
    url,
    params: {},
    context: new RouterContextProvider(),
    pattern: "/api/notification-credentials",
  });
}
it("signs expiring RS256 credentials only for the validated session and keeps private keys server-side", async () => {
  const response = await load(base.user.id);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({
    mode: "live",
    personId: base.user.id,
    publicApiKey: "test-public",
    feedChannelId: "test-feed",
  });
  const [header, claims, signature] = body.userToken.split(".");
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
    alg: "RS256",
    typ: "JWT",
  });
  const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
  expect(payload.sub).toBe(String(base.user.id));
  expect(payload.exp - payload.iat).toBe(3600);
  expect(payload.exp * 1000).toBe(body.expiresAt);
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${claims}`),
      keys.publicKey,
      Buffer.from(signature, "base64url")
    )
  ).toBe(true);
  expect(JSON.stringify(body)).not.toContain("test-secret");
  expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
});

it.each([null, 999999])(
  "rejects an absent or nonexistent session (%s)",
  async (personId) => {
    await expect(load(personId)).rejects.toMatchObject({
      init: { status: personId === null ? 401 : 404 },
    });
  }
);

it("returns explicitly disabled credentials only in fully keyless development", async () => {
  for (const name of [
    "KNOCK_SECRET_API_KEY",
    "KNOCK_PUBLIC_API_KEY",
    "KNOCK_FEED_CHANNEL_ID",
    "KNOCK_SIGNING_KEY",
  ])
    vi.stubEnv(name, "");
  expect(await (await load(base.user.id)).json()).toEqual({
    mode: "disabled",
    personId: base.user.id,
  });
});

it("does not conceal incomplete credentials or an invalid signing key", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("KNOCK_SIGNING_KEY", "");
  await expect(load(base.user.id)).rejects.toMatchObject({
    init: { status: 503 },
  });
  vi.stubEnv("KNOCK_SIGNING_KEY", "not-a-key");
  await expect(load(base.user.id)).rejects.toMatchObject({
    init: { status: 503 },
  });
});
