import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { sbAdmin } from "@/lib/db/server";
import { inngest } from "@/lib/inngest/client";

const DEFAULT_BUCKET = "orders";
const SIGNED_URL_SECONDS = 60 * 60; // 1 hour

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const formData = await request.formData();

  const quoteIdRaw = formData.get("quote_id");
  const file = formData.get("file");

  if (!quoteIdRaw) {
    return NextResponse.json(
      { ok: false, error: "Missing quote_id" },
      { status: 400 }
    );
  }

  const quoteId = Number(quoteIdRaw);
  if (!Number.isFinite(quoteId)) {
    return NextResponse.json(
      { ok: false, error: "quote_id must be numeric" },
      { status: 400 }
    );
  }

  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "Missing file" },
      { status: 400 }
    );
  }

  const bucket = process.env.SUPABASE_BUCKET ?? DEFAULT_BUCKET;
  const fileId = randomUUID();
  const filename = file.name ?? "upload";
  const storagePath = `${quoteId}/${fileId}-${filename}`;

  const supabase = sbAdmin();

  const fileBuffer = Buffer.from(await file.arrayBuffer());

  const uploadResult = await supabase.storage
    .from(bucket)
    .upload(storagePath, fileBuffer, {
      contentType: file.type || undefined,
    });

  if (uploadResult.error) {
    return NextResponse.json(
      { ok: false, error: uploadResult.error.message },
      { status: 500 }
    );
  }

  const signedUrlResult = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, SIGNED_URL_SECONDS);

  if (signedUrlResult.error || !signedUrlResult.data?.signedUrl) {
    const errorMessage = signedUrlResult.error?.message ?? "Failed to sign URL";
    return NextResponse.json(
      { ok: false, error: errorMessage },
      { status: 500 }
    );
  }

  const signedUrl = signedUrlResult.data.signedUrl;

  await inngest.send({
    name: "files/uploaded",
    data: {
      quote_id: quoteId,
      file_id: fileId,
      gcs_uri: signedUrl,
      filename,
      bytes: file.size,
      mime: file.type,
    },
  });

  return NextResponse.json({
    ok: true,
    quote_id: quoteId,
    file_id: fileId,
    storage_path: `${bucket}/${storagePath}`,
  });
}
