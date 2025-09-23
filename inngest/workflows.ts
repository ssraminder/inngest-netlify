// @ts-nocheck
// inngest/workflows.ts

import { inngest } from "@/lib/inngest/client";
import { getGoogleCreds } from "@/lib/getGoogleCreds";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { GoogleAuth } from "google-auth-library";
import { sbAdmin } from "../lib/db/server";
import { loadPolicy } from "../lib/policy";
import type { CompletePricingPolicy } from "../lib/policy";
import {
  quarterPage,
  ceilTo5,
  pickTierMultiplier,
  rushMarkup,
} from "../lib/calc";

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

type AnalysisComplete = {
  name: "files/analysis-complete";
  data: {
    quote_id: number;
    doc_type: string | null;
    country_of_issue: string | null;
    complexity: "Easy" | "Medium" | "Hard";
    names: string[];
    billing: {
      billable_words: number | null;
      relevant_pages?: number[];
      exclusions?: { page: number; reason: "blank" | "duplicate" | "irrelevant" }[];
      per_page?: Array<{ index: number; words: number; complexity: "Easy" | "Medium" | "Hard" }>;
    };
  };
};

type QuoteSubmitted = {
  name: "quote/submitted";
  data: {
    quote_id: number;
    intended_use: "general" | "legal" | "immigration" | "academic" | "insurance";
    languages: string[];
    billing: {
      country: string;
      region?: string | null;
      currency: "CAD" | "USD";
    };
    options?: {
      rush?: "rush_1bd" | "same_day" | null;
      certification?: string | null;
      shipping?: "online" | "canadapost" | "pickup_calg" | "express_post" | null;
    };
  };
};

/**
 * ------------ Helpers ------------
 */
const DOC_AI_MAX_BYTES = 20 * 1024 * 1024; // 20 MB sync limit
const DOC_AI_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

const documentAiClients = new Map();

function getDocumentAiClient(location) {
  const key = location || "us";
  if (documentAiClients.has(key)) {
    return documentAiClients.get(key);
  }

  const options = { apiEndpoint: `${key}-documentai.googleapis.com` };

  const credentials = getGoogleCreds();

  options.auth = new GoogleAuth({
    credentials,
    scopes: DOC_AI_SCOPES,
  });

  const client = new DocumentProcessorServiceClient(options);
  documentAiClients.set(key, client);
  return client;
}

function ensureCompletePolicy(
  raw: Partial<CompletePricingPolicy> | any
): CompletePricingPolicy {
  return {
    currency: raw?.currency ?? "CAD",
    pageWordDivisor: raw?.pageWordDivisor ?? 250,
    roundingThreshold: raw?.roundingThreshold ?? 0.5,

    // ensure general base rate exists
    baseRates: { general: 25, ...(raw?.baseRates ?? {}) },

    tiers: raw?.tiers ?? {},
    languageTierMap: raw?.languageTierMap ?? {},
    extraLanguagePct: raw?.extraLanguagePct ?? 0,

    // CRITICAL: all three keys must exist
    complexity: {
      Easy: raw?.complexity?.Easy ?? 1,
      Medium: raw?.complexity?.Medium ?? 1.2,
      Hard: raw?.complexity?.Hard ?? 1.5,
    },

    certifications: raw?.certifications ?? {},
    shipping: { online: 0, ...(raw?.shipping ?? {}) },

    tax: {
      defaultGST: raw?.tax?.defaultGST ?? 0.05,
      gstOnly: { ...(raw?.tax?.gstOnly ?? {}) },
      hst: { ...(raw?.tax?.hst ?? {}) },
    },

    // include if used by rushMarkup
    rush: { ...(raw?.rush ?? {}) },
  };
}

/**
 * ------------ 0) OCR + follow-up stubs ------------
 */
export const ocrDocument = inngest.createFunction(
  { id: "ocr-document" },
  { event: "files/uploaded" },
  async ({ event, step, logger }) => {
    const { quote_id, file_id, gcs_uri, filename, bytes, mime } =
      (event as any).data as FilesUploaded["data"];

    logger?.info("ocr-document received", { quote_id, file_id });

    const limit = DOC_AI_MAX_BYTES;
    if (bytes > limit) {
      const reason = `File exceeds ${limit} byte sync processing limit`;
      logger?.error("ocr-document file too large", { quote_id, file_id, reason });
      throw Object.assign(new Error(reason), { result: { ok: false, reason } });
    }

    const projectId = process.env.GOOGLE_PROJECT_ID ?? "";
    const processorId = process.env.DOCAI_PROCESSOR_ID ?? "";
    const location = process.env.DOCAI_LOCATION ?? "";

    const projectValid = /^[a-z][a-z0-9-]{4,29}$/i.test(projectId);
    const locationValid = /^[a-z0-9-]+$/i.test(location);
    const processorValid = /^[a-z0-9-]+$/i.test(processorId);

    if (!projectValid || !locationValid || !processorValid) {
      const reason =
        "Missing or invalid DOCAI env: GOOGLE_PROJECT_ID/DOCAI_LOCATION/DOCAI_PROCESSOR_ID";
      logger?.error("ocr-document missing DocAI env", {
        quote_id,
        file_id,
        reason,
        envStatus: {
          projectValid,
          locationValid,
          processorValid,
        },
      });
      throw Object.assign(new Error(reason), { result: { ok: false, reason } });
    }

    const fileBuffer: Buffer = await step.run(
      "download-uploaded-file",
      async () => {
        const response = await fetch(gcs_uri);
        if (!response.ok) {
          throw new Error(
            `Failed to download file: ${response.status} ${response.statusText}`
          );
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
    );

    if (fileBuffer.byteLength > limit) {
      // TODO: Switch to GCS document processing for larger files.
      const reason = `Downloaded file exceeds ${limit} byte sync processing limit`;
      logger?.error("ocr-document file exceeds limit after download", {
        quote_id,
        file_id,
        reason,
      });
      throw Object.assign(new Error(reason), { result: { ok: false, reason } });
    }

    let client;
    try {
      client = getDocumentAiClient(location);
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "Failed to configure Document AI client";
      logger?.error("ocr-document failed to initialize Document AI client", {
        quote_id,
        file_id,
        reason,
      });
      throw Object.assign(new Error(reason), { result: { ok: false, reason } });
    }

    const processorName = `projects/${projectId}/locations/${location}/processors/${processorId}`;

    const [processResponse] = await step.run("documentai-process", async () =>
      client.processDocument({
        name: processorName,
        rawDocument: {
          content: fileBuffer.toString("base64"),
          mimeType: mime || "application/octet-stream",
        },
      })
    );

    const document = processResponse?.document ?? {};
    const pages = Array.isArray(document.pages) ? document.pages : [];

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
    const avgConfidence =
      confidenceCount > 0 ? totalConfidence / confidenceCount : null;
    const normalizedConfidence = avgConfidence ?? 0;

    const primaryLanguage = Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .map(([code]) => code)[0] ?? null;

    const supabase = sbAdmin();
    await step.run("quote-files-upsert", async () => {
      const { error } = await supabase
        .from("quote_files")
        .upsert(
          {
            quote_id,
            file_id,
            ocr_pages: pageCount,
            words,
            language: primaryLanguage,
            bytes,
            mime,
            filename,
            storage_path: gcs_uri,
            status: "ocr_complete",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "quote_id,file_id" }
        );
      if (error) throw new Error(error.message);
    });

    await step.sendEvent("emit-ocr-complete", {
      name: "files/ocr-complete",
      data: {
        quote_id,
        file_id,
        page_count: pageCount,
        avg_confidence: normalizedConfidence,
        languages,
      },
    });

    logger?.info("ocr-document complete", {
      quote_id,
      file_id,
      page_count: pageCount,
    });

    return {
      ok: true,
      page_count: pageCount,
      words,
      avg_confidence: normalizedConfidence,
    };
  }
);

export const echoFilesUploaded = inngest.createFunction(
  { id: "echo-files-uploaded" },
  { event: "files/uploaded" },
  async ({ event }) => ({ echoed: event.data })
);

export const processUpload = inngest.createFunction(
  { id: "process-upload" },
  { event: "files/uploaded" },
  async () => ({ ok: true })
);

export const geminiAnalyze = inngest.createFunction(
  { id: "gemini-analyze" },
  { event: "files/ocr-complete" },
  async () => ({ ok: true })
);

/**
 * ------------ 1) Compute Pricing ------------
 * Trigger: quote/submitted
 */
export const computePricing = inngest.createFunction(
  { id: "compute-pricing" },
  { event: "quote/submitted" },
  async ({ event, step, logger }) => {
    const { quote_id, intended_use, languages, billing, options } =
      (event as any).data as QuoteSubmitted["data"];

    const supabase = sbAdmin();

    // If HITL, skip automated pricing
    const { data: qrec, error: qErr } = await supabase
      .from("quotes")
      .select("status")
      .eq("quoteid", quote_id)
      .maybeSingle();
    if (qErr) logger?.error("quotes.status query error", qErr);
    if (qrec?.status === "hitl") return { skipped: "hitl" as const };

    // Ensure analysis is ready (if you require it pre-pricing)
    const { data: gj, error: gjErr } = await supabase
      .from("glm_jobs")
      .select("status")
      .eq("quote_id", quote_id)
      .maybeSingle();
    if (gjErr) logger?.error("glm_jobs.status query error", gjErr);
    if (!gj || gj.status !== "succeeded") {
      return { skipped: "analysis-not-ready" as const };
    }

    // Load and normalize pricing policy
    const policy: CompletePricingPolicy = await step.run(
      "load-policy",
      async () => ensureCompletePolicy(await loadPolicy())
    );

    // Words from per-page table
    let words = 0;
    {
      const { data: qp, error: qpErr } = await supabase
        .from("quote_pages")
        .select("word_count")
        .eq("quote_id", quote_id);
      if (qpErr) logger?.error("quote_pages.word_count query error", qpErr);
      words = (qp ?? []).reduce((acc, r: any) => acc + (r?.word_count ?? 0), 0);
    }

    // Convert to pages using your rounding rules
    const pagesRaw = words / policy.pageWordDivisor;
    const pages = quarterPage(pagesRaw, policy.roundingThreshold);

    // Base rate by intended use (fallback to general)
    const baseRate =
      (policy.baseRates as any)[intended_use] ?? policy.baseRates.general;

    // Language multiplier
    const detected: string[] = []; // fill if you store detection elsewhere
    const langMult = pickTierMultiplier(policy, languages ?? [], detected);

    // Complexity multiplier: max across pages
    const { data: cxRows, error: cxErr } = await supabase
      .from("glm_pages")
      .select("complexity")
      .eq("quote_id", quote_id);
    if (cxErr) logger?.error("glm_pages.complexity query error", cxErr);

    const cxMax: "Easy" | "Medium" | "Hard" =
      (cxRows ?? []).some((r) => r?.complexity === "Hard")
        ? "Hard"
        : (cxRows ?? []).some((r) => r?.complexity === "Medium")
        ? "Medium"
        : "Easy";

    const cxMult = policy.complexity[cxMax];

    // Labor & rounding
    const labor = pages * baseRate * langMult * cxMult;
    const laborRounded = ceilTo5(labor);

    // Certification & shipping
    const certType = options?.certification ?? "Standard";
    const certFee = policy.certifications[certType] ?? 0;

    const shipKey = options?.shipping ?? "online";
    const shipFee = policy.shipping[shipKey] ?? 0;

    // Pull a doc_type sample for rush rules (if used)
    const { data: oneDoc, error: oneDocErr } = await supabase
      .from("glm_pages")
      .select("doc_type")
      .eq("quote_id", quote_id)
      .limit(1)
      .maybeSingle();
    if (oneDocErr) logger?.error("glm_pages.doc_type query error", oneDocErr);

    // Rush markup rules
    const { subtotal, applied } = rushMarkup({
      policy,
      tier: options?.rush ?? null,
      laborRounded,
      certFee,
      shipFee,
      docType: oneDoc?.doc_type ?? null,
      countryOfIssue: null,
    });

    // Tax calc
    const region = billing?.region ?? "AB";
    const taxRate =
      (policy.tax.hst as any)[region] ??
      (policy.tax.gstOnly as any)[region] ??
      policy.tax.defaultGST;
    const tax = Math.round(subtotal * taxRate * 100) / 100;

    // Total
    const total = Math.round((subtotal + tax) * 100) / 100;

    // Persist to quotes
    const { error: upErr } = await supabase
      .from("quotes")
      .update({
        totalbillablepages: pages,
        perpagerate: baseRate,
        certtype: certType,
        certprice: certFee,
        quotetotal: total,
        status: "ready",
      })
      .eq("quoteid", quote_id);
    if (upErr) logger?.error("quotes update error", upErr);

    // Notify
    await step.run("notify-quote-ready", async () => {
      await inngest.send({ name: "quote/ready", data: { quote_id } });
    });

    return {
      ok: true,
      quote_id,
      pages,
      baseRate,
      appliedRush: applied ?? null,
      total,
    };
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

export const cethosCompositePricingShim = inngest.createFunction(
  { id: "cethos-quote-platform-compute-pricing" },
  { event: "internal/compute-pricing-shim" },
  async ({ step, event }) => step.invoke("compute-pricing", event.data)
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
  echoFilesUploaded, // stub if present
  processUpload, // stub if present
];
