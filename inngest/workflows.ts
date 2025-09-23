// inngest/workflows.ts
import { inngest } from "@/lib/inngest/client";
import { safeReturnAndPersistMaybe, type SafeReference } from "@/lib/inngest/safeOutput";
import { getGoogleCreds } from "@/lib/getGoogleCreds";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { GoogleAuth } from "google-auth-library";
// Optional DB/policy/calc imports from original file (keep if present in your repo)
import { sbAdmin } from "@/lib/db/server";
import { loadPolicy } from "@/lib/policy";
import type { CompletePricingPolicy } from "@/lib/policy";
import {
  quarterPage,
  ceilTo5,
  pickTierMultiplier,
  rushMarkup,
} from "@/lib/calc";

/**
 * ------------ Event data types ------------
 */
type FilesUploaded = {
  name: "files/uploaded";
  data: {
    quote_id: number;
    file_id: string;
    gcs_uri: string;
    filename: string;
    bytes: number;
    mime: string;
  };
};

type OcrComplete = {
  name: "files/ocr-complete";
  data: {
    quote_id: number;
    file_id: string;
    page_count: number;
    avg_confidence: number;
    languages: Record<string, number>;
  };
};

/**
 * ------------ Helpers ------------
 */
const DOC_AI_MAX_BYTES = 20 * 1024 * 1024; // 20 MB sync limit
const DOC_AI_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

const documentAiClients = new Map<string, DocumentProcessorServiceClient>();

function getDocumentAiClient(location: string) {
  const key = location || "us";
  if (documentAiClients.has(key)) {
    return documentAiClients.get(key)!;
  }

  const options: any = { apiEndpoint: `${key}-documentai.googleapis.com` };

  const credentials = getGoogleCreds?.();

  options.auth = new GoogleAuth({
    credentials,
    scopes: DOC_AI_SCOPES,
  });

  const client = new DocumentProcessorServiceClient(options);
  documentAiClients.set(key, client);
  return client;
}

/**
 * ------------ OCR Document workflow ------------
 *
 * - Read file bytes from event (raw_base64 or gcs signed URL)
 * - Log diagnostics about the file header and structure
 * - Call Document AI with raw Buffer (avoids base64 encoding issues)
 * - On specific decoder errors try pdf-lib resave and retry
 * - If needed, fallback to GCS batch processing (code included; requires env and storage lib)
 * - Persist large Document AI results via safeReturnAndPersistMaybe and return a compact reference
 */
export const ocrDocument = inngest.createFunction(
  { id: "ocr-document" },
  { event: "files/uploaded" },
  async ({ event, step, logger }) => {
    const data = (event as any).data || {};
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
        fileBuffer = Buffer.from(String(data.raw_base64), "base64");
      } else if (gcs_uri) {
        fileBuffer = await fetchUrlToBuffer(gcs_uri);
      } else if (data?.download_url) {
        fileBuffer = await fetchUrlToBuffer(data.download_url);
      } else {
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

    // Diagnostic block: minimal metadata to help triage decoder errors
    try {
      const bytes = fileBuffer.length;
      const headerUtf8 = (() => {
        try {
          return fileBuffer.slice(0, 16).toString("utf8", 0, 16);
        } catch {
          return "";
        }
      })();
      const sampleHex = fileBuffer.slice(0, 32).toString("hex");
      const firstChunkText = fileBuffer.slice(0, Math.min(2000, bytes)).toString("utf8", 0, Math.min(2000, bytes));
      const isPdf = headerUtf8.startsWith("%PDF");
      const maybeEncrypted = firstChunkText.includes("/Encrypt") || firstChunkText.includes("/Encrypt ");
      const hasXref = firstChunkText.includes("xref");
      const containsObjStream = firstChunkText.includes("/ObjStm");

      logger?.info?.("ocr: file diagnostics", {
        bytes,
        headerUtf8,
        sampleHex,
        isPdf,
        maybeEncrypted,
        hasXref,
        containsObjStream,
      });
    } catch (diagErr) {
      logger?.warn?.("ocr: diagnostic block failed", { err: diagErr instanceof Error ? diagErr.message : String(diagErr) });
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

    // Helper: try processDocument and support pdf-lib retry + GCS batch fallback
    async function attemptProcess(buffer: Buffer) {
      try {
        const [resp] = await client.processDocument({
          name: processorName,
          rawDocument: {
            content: buffer,
            mimeType: mime || "application/octet-stream",
          },
        });
        return resp;
      } catch (err) {
        const msg = String(err?.message ?? err);
        // If it's a decoder error, try pdf-lib resave
        if (
          msg.includes("DECODER routines::unsupported") ||
          msg.includes("Getting metadata from plugin failed") ||
          msg.includes("invalid encoding")
        ) {
          logger?.warn?.("documentai: decoder/metadata failure detected; attempting pdf-lib resave", { err: msg });
          try {
            // dynamic import pdf-lib to avoid forcing dependency at build time in environments
            const { PDFDocument } = await import("pdf-lib");
            const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
            const fixed = await pdfDoc.save();
            const fixedBuf = Buffer.from(fixed);
            logger?.info?.("documentai: pdf-lib resave success, retrying processDocument", { originalBytes: buffer.length, fixedBytes: fixedBuf.length });
            const [retryResp] = await client.processDocument({
              name: processorName,
              rawDocument: {
                content: fixedBuf,
                mimeType: mime || "application/pdf",
              },
            });
            return retryResp;
          } catch (resaveErr) {
            logger?.warn?.("documentai: pdf-lib resave failed; attempting GCS batch fallback", { err: resaveErr instanceof Error ? resaveErr.message : String(resaveErr) });
            // GCS batch fallback
            const bucketName = process.env.DOCAI_GCS_TEMP_BUCKET;
            if (!bucketName) {
              // cannot proceed: return original error to caller with context
              logger?.error?.("documentai: DOCAI_GCS_TEMP_BUCKET not set; cannot perform batch fallback");
              throw err;
            }
            try {
              // dynamic import of Storage to avoid forcing dependency
              const { Storage } = await import("@google-cloud/storage");
              const storage = new Storage();
              const destPath = `inngest-fallback/${Date.now()}-${file_id || "file"}.pdf`;
              const file = storage.bucket(bucketName).file(destPath);
              await file.save(buffer, { resumable: false, contentType: "application/pdf" });
              const gsUri = `gs://${bucketName}/${destPath}`;

              // Attempt batchProcessDocuments; request shape may vary by client version
              const batchReq: any = {
                name: processorName,
                inputDocuments: {
                  gcsDocuments: {
                    documents: [{ gcsUri: gsUri }],
                  },
                },
                documentOutputConfig: {
                  gcsOutputConfig: { gcsUri: `gs://${bucketName}/inngest-output/${Date.now()}/` },
                },
              };

              const [operation] = await (client as any).batchProcessDocuments
                ? await (client as any).batchProcessDocuments(batchReq)
                : await (client as any).batchProcess(batchReq);

              logger?.info?.("documentai: batchProcess started", { opName: operation?.name });
              await operation.promise();
              // Note: reading/parsing the output JSON from the GCS output prefix is left to follow-up logic.
              // For now, return an object indicating remote processing happened — caller will treat this as an error case unless you implement output retrieval.
              return { document: { _gcs_output_prefix: `gs://${bucketName}/inngest-output/` } };
            } catch (gcsErr) {
              logger?.error?.("documentai: GCS batch fallback failed", { err: gcsErr instanceof Error ? gcsErr.message : String(gcsErr) });
              throw err;
            }
          }
        }
        // Non-decoder error: rethrow
        throw err;
      }
    }

    // Run Document AI and compute summary in a step.run so Inngest step outputs can be controlled
    const processSummary = await step.run("documentai-process", async () => {
      logger?.info?.("documentai: starting processDocument", {
        quote_id,
        file_id,
        bytes: fileBuffer.length,
        mime,
        processorName,
      });

      const response: any = await attemptProcess(fileBuffer);

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

/**
 * ------------ 0b) Gemini analyze (stub) ------------
 */
export const geminiAnalyze = inngest.createFunction(
  { id: "gemini-analyze" },
  { event: "files/ocr-complete" },
  async ({ event, step, logger }) => {
    // stub implementation — implement analysis logic here
    logger?.info?.("geminiAnalyze invoked", { event: event?.data });
    return { ok: true };
  }
);

/**
 * ------------ 1) Compute Pricing ------------
 *
 * NOTE: placeholder implementation included here to preserve function export and compile cleanly.
 * Replace the body with your original computePricing business logic if available.
 */
export const computePricing = inngest.createFunction(
  { id: "compute-pricing" },
  { event: "quote/submitted" },
  async ({ event, step, logger }) => {
    const data = event?.data || {};
    const quote_id = data?.quote_id;
    logger?.info?.("computePricing stub invoked", { quote_id, data });
    // TODO: replace with original computePricing implementation
    return { ok: true, computed: false };
  }
);

/**
 * ------------ 2) Quote created: prepare downstream jobs ------------
 */
export const quoteCreatedPrepareJobs = inngest.createFunction(
  { id: "quote-created-prepare-jobs" },
  { event: "quote/created" },
  async () => {
    return { ok: true };
  }
);

/**
 * ------------ Composite shim ------------
 */
export const cethosCompositePricingShim = inngest.createFunction(
  { id: "cethos-quote-platform-compute-pricing" },
  { event: "internal/compute-pricing-shim" },
  async ({ step, event }) => step.invoke("compute-pricing", (event as any).data)
);

/**
 * ------------ Export for Netlify Inngest plugin ------------
 */
export const functions = [
  ocrDocument,
  geminiAnalyze,
  computePricing,
  quoteCreatedPrepareJobs,
  cethosCompositePricingShim,
];
