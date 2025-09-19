// inngest/workflows.ts
import type { InngestFunction } from "inngest";
import { inngest } from "../lib/inngest/client";
import { sbAdmin } from "../lib/db/server";

type QuoteCreatedEvent = {
  name: "quote/created";
  data: {
    quoteId: string | number; // matches your quotes PK type
    files: Array<{ id: string; gcsUri: string; filename: string; bytes?: number; mime?: string }>;
  };
};

export const quoteCreatedPrepareJobs = inngest.createFunction(
  { id: "quote-created-prepare-jobs" },
  { event: "quote/created" },
  async ({ event, step }) => {
    const { quoteId, files } = (event as QuoteCreatedEvent).data;
    const supabase = sbAdmin();

    // 1) Insert quote_files if your API didn't already (NO-OP if you already insert them)
    //    If your API already fills quote_files, skip this block.
    await step.run("ensure-quote-files", async () => {
      if (!files?.length) return;
      const rows = files.map((f) => ({
        quote_id: quoteId,
        gcs_uri: f.gcsUri,
        filename: f.filename,
        bytes: f.bytes ?? null,
        mime: f.mime ?? null,
        status: "uploaded",
      }));
      // Try insert; ignore duplicates (you may already have them)
      const { error } = await supabase.from("quote_files").insert(rows).select().maybeSingle();
      if (error && !String(error.message).includes("duplicate")) {
        // Not fatal if they already exist; otherwise throw
        throw error;
      }
    });

    // 2) Queue OCR jobs (one per file) — idempotent on file_id
    await step.run("queue-ocr-jobs", async () => {
      if (!files?.length) return;
      // fetch file ids from DB to ensure we have the server-created UUIDs if needed
      const { data: dbFiles, error: selErr } = await supabase
        .from("quote_files")
        .select("id, filename")
        .eq("quote_id", quoteId);
      if (selErr) throw selErr;

      const rows =
        dbFiles?.map((f) => ({
          quote_id: quoteId,
          file_id: f.id,
          status: "queued",
        })) ?? [];

      if (rows.length) {
        const { error } = await supabase
          .from("ocr_jobs")
          .upsert(rows, { onConflict: "file_id", ignoreDuplicates: true });
        if (error) throw error;
      }
    });

    // 3) Ensure a single GLM job per quote
    await step.run("queue-glm-job", async () => {
      const { data: existing, error: checkErr } = await supabase
        .from("glm_jobs")
        .select("id")
        .eq("quote_id", quoteId)
        .limit(1)
        .maybeSingle();
      if (checkErr) throw checkErr;
      if (!existing) {
        const { error: insErr } = await supabase.from("glm_jobs").insert({ quote_id: quoteId, status: "queued" });
        if (insErr) throw insErr;
      }
    });

    return { ok: true, quoteId, files: files?.length ?? 0 };
  }
);

export const functions: InngestFunction[] = [quoteCreatedPrepareJobs];
