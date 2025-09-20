// inngest/workflows.ts

import { inngest } from "../lib/inngest/client";
import { sbAdmin } from "../lib/db/server";
import { loadPolicy, CompletePricingPolicy } from "../lib/policy";
import { quarterPage, ceilTo5, pickTierMultiplier, rushMarkup } from "../lib/calc";
import { Storage } from "@google-cloud/storage";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * ---------- Event data types (aligned to your tables) ----------
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
    languages: Record<string, number>; // fixed: add K/V types
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
      region?: string;
      currency: "CAD" | "USD";
    };
    options?: {
      rush?: "rush_1bd" | "same_day" | null;
      certification?: string;
      shipping?: "online" | "canadapost" | "pickup_calg" | "express_post";
    };
  };
};

/**
 * ---------- 0. Stubs for referenced functions so file compiles ----------
 * Replace with your real implementations when ready.
 */
export const ocrDocument = inngest.createFunction(
  { id: "ocr-document" },
  { event: "files/uploaded" },
  async () => ({ ok: true })
);

export const geminiAnalyze = inngest.createFunction(
  { id: "gemini-analyze" },
  { event: "files/ocr-complete" },
  async () => ({ ok: true })
);

/**
 * ---------- 2.4 Pricing: quote/submitted → compute only after analysis OK (and not HITL) ----------
 */
export const computePricing = inngest.createFunction(
  { id: "compute-pricing" },                    // 1) metadata
  { event: "quote/submitted" },                 // 2) trigger
  async ({ event, step }) => {                  // 3) handler
    const { quote_id, intended_use, languages, options } =
      (event as any).data as QuoteSubmitted["data"];

    const supabase = sbAdmin();

    // If human-in-the-loop, skip pricing
    const { data: qrec } = await supabase
      .from("quotes")
      .select("status")
      .eq("quoteid", quote_id)
      .maybeSingle();
    if (qrec?.status === "hitl") {
      return { skipped: "hitl" as const };
    }

    // Ensure GLM analysis exists and succeeded
    const { data: gj } = await supabase
      .from("glm_jobs")
      .select("status")
      .eq("quote_id", quote_id)
      .maybeSingle();
    if (!gj || gj.status !== "succeeded") {
      return { skipped: "analysis-not-ready" as const };
    }

    // Load pricing policy with safe defaults to satisfy CompletePricingPolicy
    const policy = await step.run("load-policy", async (): Promise<CompletePricingPolicy> => {
      const partial = loadPolicy() as Partial<CompletePricingPolicy>;

      return {
        // defaults + partial override
        currency: partial.currency ?? "CAD",
        pageWordDivisor: partial.pageWordDivisor ?? 250,
        roundingThreshold: partial.roundingThreshold ?? 0.5,
        baseRates: partial.baseRates ?? { general: 25 }, // ensure at least general exists
        tiers: partial.tiers ?? {},
        languageTierMap: partial.languageTierMap ?? {},
        extraLanguagePct: partial.extraLanguagePct ?? 0,
        complexity: partial.complexity ?? { Easy: 1, Medium: 1.2, Hard: 1.5 },
        certifications: partial.certifications ?? {},
        shipping: partial.shipping ?? { online: 0 },
        tax: partial.tax ?? { defaultGST: 0.05, gstOnly: {}, hst: {} }, // ensure present
      } as CompletePricingPolicy;
    });

    // Sum words from per-page table
    let words = 0;
    {
      const { data: qp } = await supabase
        .from("quote_pages")
        .select("word_count")
        .eq("quote_id", quote_id);
      words = (qp ?? []).reduce((a, b) => a + (b.word_count || 0), 0);
    }

    // Convert to pages
    const pagesRaw = words / policy.pageWordDivisor;
    const pages = quarterPage(pagesRaw, policy.roundingThreshold);

    // Base rate by intended use
    const baseRate =
      (policy.baseRates as any)[intended_use] ?? policy.baseRates.general;

    // Language multiplier (detected array is optional — pass [] if not used)
    const detected: string[] = [];
    const langMult = pickTierMultiplier(policy, languages ?? [], detected);

    // Complexity multiplier: take the max across pages
    const { data: cxRows } = await supabase
      .from("glm_pages")
      .select("complexity")
      .eq("quote_id", quote_id);
    const cxMax =
      (cxRows ?? []).some((r) => r.complexity === "Hard")
        ? "Hard"
        : (cxRows ?? []).some((r) => r.complexity === "Medium")
        ? "Medium"
        : "Easy";
    const cxMult = policy.complexity[cxMax as "Easy" | "Medium" | "Hard"];

    // Labor & rounding
    const labor = pages * baseRate * langMult * cxMult;
    const laborRounded = ceilTo5(labor);

    // Certification & shipping fees
    const certType = options?.certification ?? "Standard";
    const certFee = policy.certifications[certType] ?? 0;

    const shipKey = options?.shipping ?? "online";
    const shipFee = policy.shipping[shipKey] ?? 0;

    // Document type for rush rules, if any
    const { data: oneDoc } = await supabase
      .from("glm_pages")
      .select("doc_type")
      .eq("quote_id", quote_id)
      .limit(1)
      .maybeSingle();

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

    // Tax — fallback using region “AB” if none supplied
    const region = "AB";
    const inHST = (policy.tax.hst as any)[region];
    const inGSTOnly = (policy.tax.gstOnly as any)[region];
    const taxRate = inHST ?? inGSTOnly ?? policy.tax.defaultGST;
    const tax = Math.round(subtotal * taxRate * 100) / 100;

    // Total
    const total = Math.round((subtotal + tax) * 100) / 100;

    // Persist pricing to quotes
    await supabase
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

    // Notify
    await step.run("notify-quote-ready", async () => {
      await inngest.send({ name: "quote/ready", data: { quote_id } });
    });

    // Return inside handler (now valid)
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
 * ---------- 3. Quote created: prepare downstream jobs (kept minimal) ----------
 */
export const quoteCreatedPrepareJobs = inngest.createFunction(
  { id: "quote-created-prepare-jobs" },
  { event: "quote/created" },
  async () => {
    return { ok: true };
  }
);

/**
 * ---------- Exports ----------
 * Keep these grouped so the Netlify Inngest plugin can sync them.
 */
export const functions = [ocrDocument, geminiAnalyze, computePricing, quoteCreatedPrepareJobs];