// inngest/workflows.ts
import { inngest } from "../lib/inngest/client";
import { sbAdmin } from "../lib/db/server";

type QuoteCreatedEvent = {
  name: "quote/created";
  data: {
    quoteId: string | number; // integer in your DB is fine
    files: Array<{ id?: string; gcsUri?: string; filename?: string; bytes?: number; mime?: string }>;
  };
};

export const quoteCreatedPrepareJobs = inngest.createFunction(
  { id: "quote-created-prepare-jobs" },
  { event: "quote/created" },
  async ({ event, step }) => {
    const { quoteId, files } = (event as QuoteCreatedEvent).data;
    const supabase = sbAdmin();

    // (A) Ensure quote_files exist if your API didn’t already insert them (safe no-op if they exist)
    await step.run("ensure-quote-files", async () => {
      if (!files?.length) return;
      const rows = files
        .filter((f) => f.gcsUri && f.filename)
        .map((f) => ({
          quote_id: quoteId,
          gcs_uri: f.gcsUri!,
          filename: f.filename!,
          bytes: f.bytes ?? null,
          mime: f.mime ?? null,
          status: "uploaded",
        }));
      if (!rows.length) return;
      const { error } = await supabase.from("quote_files").insert(rows);
      if (error && !String(error.message).includes("duplicate")) throw error;
    });

    // (B) Load files for this quote (works whether inserted above or earlier in your API)
    const { data: dbFiles, error: selErr } = await supabase
      .from("quote_files")
      .select("id, filename")
      .eq("quote_id", quoteId);
    if (selErr) throw selErr;

    // (C) Queue OCR jobs (idempotent on file_id)
    await step.run("queue-ocr-jobs", async () => {
      if (!dbFiles?.length) return;
      const rows = dbFiles.map((f) => ({
        quote_id: quoteId,
        file_id: f.id,
        status: "queued",
      }));
      const { error } = await supabase
        .from("ocr_jobs")
        .upsert(rows, { onConflict: "file_id", ignoreDuplicates: true });
      if (error) throw error;
    });

    // (D) Ensure one GLM job per quote
    await step.run("queue-glm-job", async () => {
      const { data: existing, error: checkErr } = await supabase
        .from("glm_jobs")
        .select("id")
        .eq("quote_id", quoteId)
        .limit(1)
        .maybeSingle();
      if (checkErr) throw checkErr;
      if (!existing) {
        const { error: insErr } = await supabase
          .from("glm_jobs")
          .insert({ quote_id: quoteId, status: "queued" });
        if (insErr) throw insErr;
      }
    });

    return { ok: true, quoteId, fileCount: dbFiles?.length ?? 0 };
  }
);

export const functions = [quoteCreatedPrepareJobs];
