import { gzipSync } from "zlib";
import { supabase } from "@/lib/supabaseClient";

const MAX_STEP_BYTES = 60_000; // 60 KB
const PREVIEW_LENGTH = 2000;
const DEFAULT_BUCKET = "orders";

type SafeMeta = {
  quote_id?: number;
  file_id?: string;
  label?: string;
};

export type SafeReference = {
  stored_at: string | null;
  bytes: number;
  preview: string;
  truncated: boolean;
  upload_error?: string;
};

function serializePayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch (e) {
    return String(payload);
  }
}

export async function safeReturnAndPersistMaybe(
  payload: unknown,
  meta: SafeMeta = {}
): Promise<SafeReference> {
  const serialized = serializePayload(payload);
  const bytes = Buffer.byteLength(serialized, "utf8");
  const preview = serialized.slice(0, PREVIEW_LENGTH);
  const bucket = process.env.SUPABASE_BUCKET || DEFAULT_BUCKET;

  if (bytes <= MAX_STEP_BYTES) {
    return {
      stored_at: null,
      bytes,
      preview,
      truncated: bytes > PREVIEW_LENGTH,
    };
  }

  const parts: string[] = ["inngest-artifacts"];
  if (typeof meta.quote_id === "number") parts.push(`quote-${meta.quote_id}`);
  if (meta.file_id) parts.push(`file-${meta.file_id}`);
  if (meta.label) parts.push(meta.label);
  parts.push(`${Date.now()}.json.gz`);
  const storagePath = parts.join("/");

  try {
    const client = supabase();
    const gzipped = gzipSync(Buffer.from(serialized, "utf8"));
    const { error } = await client.storage.from(bucket).upload(storagePath, gzipped, {
      contentType: "application/gzip",
      upsert: true,
    });
    if (error) {
      return {
        stored_at: null,
        bytes,
        preview,
        truncated: true,
        upload_error: error.message,
      };
    }
    return {
      stored_at: `${bucket}/${storagePath}`,
      bytes,
      preview,
      truncated: true,
    };
  } catch (err) {
    return {
      stored_at: null,
      bytes,
      preview,
      truncated: true,
      upload_error: err instanceof Error ? err.message : "Unknown upload error",
    };
  }
}
