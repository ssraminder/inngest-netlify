import type { JWTInput } from "google-auth-library";

function parseJson(source: string, label: string): JWTInput {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid ${label}`);
  }
}

export function getGoogleCreds(): JWTInput | undefined {
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (json && json.trim()) {
    return parseJson(json, "GOOGLE_APPLICATION_CREDENTIALS_JSON");
  }

  const b64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_B64;
  if (b64 && b64.trim()) {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    return parseJson(decoded, "GOOGLE_APPLICATION_CREDENTIALS_B64");
  }

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (clientEmail && privateKey) {
    return {
      client_email: clientEmail,
      private_key: privateKey.replace(/\\n/g, "\n"),
    };
  }

  return undefined;
}
