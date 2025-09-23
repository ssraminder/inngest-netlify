// src/lib/getGoogleCreds.ts
import type { JWTInput } from "google-auth-library";

/**
 * Parse JSON and throw a clear error that identifies the env variable label.
 */
function parseJson(source: string, label: string): JWTInput {
  try {
    return JSON.parse(source) as JWTInput;
  } catch (error) {
    throw new Error(`Invalid ${label}`);
  }
}

/**
 * Read Google service account credentials from environment variables.
 *
 * Priority (preferred first):
 * 1. GOOGLE_APPLICATION_CREDENTIALS_JSON  (raw JSON string)
 * 2. GOOGLE_APPLICATION_CREDENTIALS_B64   (base64-encoded JSON)
 * 3. GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY (explicit key pair)
 *
 * Returns JWTInput when credentials are found, otherwise returns undefined.
 * Callers should fall back to Application Default Credentials if undefined.
 */
export function getGoogleCreds(): JWTInput | undefined {
  // 1) raw JSON env (preferred)
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (json && json.trim()) {
    return parseJson(json, "GOOGLE_APPLICATION_CREDENTIALS_JSON");
  }

  // 2) base64-encoded JSON
  const b64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_B64;
  if (b64 && b64.trim()) {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    return parseJson(decoded, "GOOGLE_APPLICATION_CREDENTIALS_B64");
  }

  // 3) explicit client email + private key pair
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (clientEmail && clientEmail.trim() && privateKey && privateKey.trim()) {
    // Some environments store newlines as literal `\n` sequences — normalize them.
    const normalizedKey = privateKey.replace(/\\n/g, "\n");
    return {
      client_email: clientEmail,
      private_key: normalizedKey,
    } as JWTInput;
  }

  // No credentials found — callers can fall back to ADC (Application Default Credentials).
  return undefined;
}
