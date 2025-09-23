import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  const googleProjectId = process.env.GOOGLE_PROJECT_ID ?? "";
  const docaiLocation = process.env.DOCAI_LOCATION ?? "";
  const docaiProcessorId = process.env.DOCAI_PROCESSOR_ID ?? "";
  const hasClientKey = Boolean(
    (process.env.GOOGLE_CLIENT_EMAIL || "").trim() &&
      (process.env.GOOGLE_PRIVATE_KEY || "").trim()
  );
  const hasServiceAccountJson = Boolean(
    (process.env.GOOGLE_APPLICATION_CREDENTIALS_B64 || "").trim() ||
      (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "").trim()
  );

  return NextResponse.json({
    google_project_id: Boolean(googleProjectId.trim()),
    docai_location: Boolean(docaiLocation.trim()),
    docai_processor_id: Boolean(docaiProcessorId.trim()),
    has_service_account_json: hasServiceAccountJson,
    has_client_key: hasClientKey,
  });
}
