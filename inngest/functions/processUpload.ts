import { z } from "zod";
import { inngest } from "../client";

const FilesUploadedSchema = z.object({
  quote_id: z.string().min(1),
  file_id: z.string().min(1),
  gcs_uri: z.string().min(1),
  filename: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  mime: z.string().min(1),
});

export const processUpload = inngest.createFunction(
  { id: "process-upload" },
  { event: "files/uploaded" },
  async ({ event, step, logger }) => {
    const data = FilesUploadedSchema.parse(event.data);
    logger.info("files/uploaded received", { quote_id: data.quote_id, file_id: data.file_id });

    const fileInfo = await step.run("resolve-file", async () => ({
      downloadUrl: data.gcs_uri,
      sizeBytes: data.bytes,
      mime: data.mime,
    }));

    const ocr = await step.run("documentai-ocr", async () => {
      // TODO: call real OCR; placeholders for now
      return { pages: 1, tokens: 0, lang: "und" };
    });

    await step.run("persist-results", async () => {
      // TODO: persist to DB keyed by quote_id + file_id
      return true;
    });

    await step.sendEvent("emit-files-processed", {
      name: "files/processed",
      data: {
        quote_id: data.quote_id,
        file_id: data.file_id,
        ocr_pages: ocr.pages,
        words: ocr.tokens,
        language: ocr.lang,
      },
    });

    return { ok: true, fileInfo };
  }
);
