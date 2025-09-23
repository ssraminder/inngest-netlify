// inngest/workflows.ts
import { inngest } from "@/lib/inngest/client";
import { safeReturnAndPersistMaybe, type SafeReference } from "@/lib/inngest/safeOutput";
import { getGoogleCreds } from "@/lib/getGoogleCreds";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { GoogleAuth } from "google-auth-library";

/**
 * OCR Document workflow
 * - listens to files/uploaded events
 * - fetches file bytes (raw_base64 or signed gcs_uri)
 * - calls Document AI with raw bytes (Buffer / Uint8Array) to avoid encoding errors
 * - persists large DocumentAI `document` via safeReturnAndPersistMaybe
 * - returns a small summary + document_ref
 */
export const ocrDocument = inngest.createFunction(
  { id: "ocr-document" },
  { event: "files/uploaded" },
  async ({ event, step, logger }) => {
    const data = event?.data || {};
    const quote_id = data?.quote_id;
    const file_id = data?.file_id;
    const mime = data?.mime;
    const gcs_uri = data?.gcs_uri;

    // Helper to fetch signed URL into Buffer (Node's fetch returns ArrayBuffer)
    async function fetchUrlToBuffer(url: string): Promise<Buffer> {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch url: ${res.status} ${res.statusText}`);
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    }

    // Get file bytes (try raw_base64 first, then gcs_uri)
    let fileBuffer: Buffer | undefined;
    try {
      if (data?.raw_base64) {
        // event already includes the base64 content
        fileBuffer = Buffer.from(String(data.raw_base64), "base64");
      } else if (gcs_uri) {
        // signed URL present — fetch it
        fileBuffer = await fetchUrlToBuffer(gcs_uri);
      } else if (data?.download_url) {
        // fallback field name used by some workflows
        fileBuffer = await fetchUrlToBuffer(data.download_url);
      } else {
        // Nothing to work on — bubble up a helpful error
        throw new Error("No file bytes available: event missing raw_base64 or gcs_uri");
      }
    } catch (err) {
      logger?.error?.("ocr-document: failed to obtain file bytes", {
        err: err instanceof Error ? err.message : String(err),
        quote_id,
        file_id,
        gcs_uri,
      });
      throw err;
    }

    if (!fileBuffer || !Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
      const msg = "ocr-document: fileBuffer is missing or invalid after fetch/parse";
      logger?.error?.(msg, { quote_id, file_id });
      throw new Error(msg);
    }

    // Prepare Document AI client using service creds if available
    const creds = getGoogleCreds?.() ?? {};
    let client: DocumentProcessorServiceClient;
    try {
      if (creds?.client_email && creds?.private_key) {
        client = new DocumentProcessorServiceClient({
          credentials: {
            client_email: creds.client_email,
            private_key: creds.private_key,
          },
        });
      } else {
        // Fall back to ADC (Application Default Credentials) if present
        client = new DocumentProcessorServiceClient();
      }
    } catch (err) {
      logger?.error?.("ocr-document: failed to create DocumentProcessorServiceClient", {
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const projectId = process.env.GOOGLE_PROJECT_ID ?? "";
    const location = process.env.DOCAI_LOCATION ?? process.env.DOCAI_REGION ?? "us";
    const processorId = process.env.DOCAI_PROCESSOR_ID ?? "";
    const processorName = `projects/${projectId}/locations/${location}/processors/${processorId}`;

    // Run Document AI and compute summary in a step-run
    const processSummary = await step.run("documentai-process", async () => {
      logger?.info?.("documentai: starting processDocument", {
        quote_id,
        file_id,
        bytes: fileBuffer.length,
        mime,
        processorName,
      });

      let response;
      try {
        // Pass Buffer/Uint8Array directly to avoid base64 / serialization problems
        const [resp] = await client.processDocument({
          name: processorName,
          rawDocument: {
            content: fileBuffer, // Buffer is acceptable (Uint8Array)
            mimeType: mime || "application/octet-stream",
          },
        });
        response = resp;
      } catch (err) {
        logger?.error?.("documentai: processDocument failed", {
          err: err instanceof Error ? err.message : String(err),
          quote_id,
          file_id,
          bytes: fileBuffer.length,
        });
        throw err;
      }

      const document = response?.document ?? {};
      const pages = Array.isArray(document.pages) ? document.pages : [];

      // compute simple aggregations
      let words = 0;
      let totalConfidence = 0;
      let confidenceCount = 0;
      const languages: Record<string, number> = {};

      function recordLanguage(code?: string | null, confidence?: number | null) {
        if (!code) return;
        const score = confidence ?? 0;
        const current = languages[code] ?? 0;
        if (score > current) languages[code] = score;
      }

      if (Array.isArray(document.languages)) {
        for (const lang of document.languages) {
          recordLanguage(lang?.languageCode, lang?.confidence);
        }
      }

      for (const page of pages) {
        if (Array.isArray(page?.tokens)) {
          words += page.tokens.length;
        }
        const pageConfidence =
          typeof page?.layout?.confidence === "number"
            ? page.layout.confidence
            : typeof page?.confidence === "number"
            ? page.confidence
            : null;
        if (pageConfidence !== null) {
          totalConfidence += pageConfidence;
          confidenceCount += 1;
        }
        const detectedPageLanguages =
          Array.isArray(page?.detectedLanguages)
            ? page.detectedLanguages
            : Array.isArray(page?.layout?.detectedLanguages)
            ? page.layout.detectedLanguages
            : [];
        for (const lang of detectedPageLanguages) {
          recordLanguage(lang?.languageCode, lang?.confidence);
        }
      }

      const pageCount = pages.length;
      const avgConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : null;

      // Persist potentially large document object
      let documentReference: SafeReference;
      try {
        documentReference = await safeReturnAndPersistMaybe(document, {
          quote_id: typeof quote_id === "number" ? quote_id : undefined,
          file_id: typeof file_id === "string" ? file_id : undefined,
          label: "documentai-document",
        });
      } catch (err) {
        logger?.error?.("safeReturnAndPersistMaybe threw", {
          err: err instanceof Error ? err.message : String(err),
          quote_id,
          file_id,
        });
        // create a graceful fallback reference
        const serialized = (() => {
          try {
            return JSON.stringify(document);
          } catch {
            return String(document ?? "");
          }
        })();
        documentReference = {
          stored_at: null,
          bytes: Buffer.byteLength(serialized, "utf8"),
          preview: serialized.slice(0, 2000),
          truncated: true,
          upload_error: err instanceof Error ? err.message : String(err),
        };
      }

      logger?.info?.("documentai: persisted reference", {
        stored_at: documentReference.stored_at ?? null,
        bytes: documentReference.bytes,
        truncated: documentReference.truncated,
        upload_error: documentReference.upload_error ?? null,
      });

      return {
        pageCount,
        words,
        languages,
        avgConfidence,
        normalizedConfidence: avgConfidence ?? 0,
        documentReference,
      };
    });

    // destructure the result
    const {
      pageCount,
      words,
      languages,
      avgConfidence,
      normalizedConfidence,
      documentReference,
    } = processSummary;

    // derive primary language if any
    const primaryLanguage = Object.entries(languages || {})
      .sort((a, b) => b[1] - a[1])
      .map((x) => x[0])[0] ?? null;

    // At this point you may upsert the OCR stats into your DB (quote_files).
    // IMPORTANT: store the small documentReference, NOT the full document.
    // If you already have an upsert helper, call it here. Example (pseudo):
    // await upsertQuoteFile({ quote_id, file_id, page_count: pageCount, words, avg_confidence: normalizedConfidence, document_ref: documentReference });

    // Return a compact summary to avoid huge Inngest step outputs
    return {
      ok: true,
      page_count: pageCount,
      words,
      avg_confidence: normalizedConfidence,
      document_ref: documentReference,
      primary_language: primaryLanguage,
    };
  }
);

// expose all workflow functions for the Inngest HTTP route (imported as )
export const functions = [ocrDocument];
