import { createPrivateKey, sign } from "node:crypto";
import {
  loadNotificationEnvironment,
  notificationConfiguration,
} from "./config.server";

// Call only after validating the session's person against Cadence's database.
export function notificationCredentials(personId: number) {
  loadNotificationEnvironment();
  const config = notificationConfiguration(process.env);
  if (config.mode === "disabled")
    return { mode: "disabled", personId } as const;
  const pem = config.signingKey.includes("-----BEGIN")
    ? config.signingKey.replace(/\\n/g, "\n")
    : Buffer.from(config.signingKey, "base64").toString("utf8");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa")
    throw new Error("Notification signing key must be RSA.");
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 3600;
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ sub: String(personId), iat: issuedAt, exp: expiresAt })}`;
  const userToken = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
  return {
    mode: "live",
    personId,
    publicApiKey: config.publicApiKey,
    feedChannelId: config.feedChannelId,
    userToken,
    expiresAt: expiresAt * 1000,
  } as const;
}
