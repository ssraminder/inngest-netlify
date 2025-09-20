// inngest/workflows.ts
import { inngest } from "../lib/inngest/client";
import { sbAdmin } from "../lib/db/server";
import { loadPolicy, CompletePricingPolicy } from "../lib/policy";
import { quarterPage, ceilTo5, pickTierMultiplier, rushMarkup } from "../lib/calc";

import { Storage } from "@google-cloud/storage";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { GoogleGenerativeAI } from "@google/generative-ai";


// ---------- Event data types (aligned to your tables) ----------
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
    billing: { country: string; region?: string; currency: "CAD" | "USD" };
    options?: {
      rush?: "rush_1bd" | "same_day" | null;
      certification?: string;
      shipping?: "online" | "canadapost" | "pickup_calg" | "express_post";
    };
  };
};

// ... (rest of the file is unchanged, but included here for completeness)
// ...

// ---------- 2.4 Pricing: quote/submitted → compute only after analysis OK (and not HITL) ----------
export const computePricing = inngest.createFunction(
  { id: "compute-pricing" },
  { event: "quote/submitted" },
  async ({ event, step }) => {
    const { quote_id, intended_use, languages, options } = (event as any).data as QuoteSubmitted["data"];
    const supabase = sbAdmin();

    const { data: qrec } = await supabase
      .from("quotes")
      .select("status")
      .eq("quoteid", quote_id)
      .maybeSingle();
    if (qrec?.status === "hitl") return { skipped: "hitl" };

    const { data: gj } = await supabase
      .from("glm_jobs")
      .select("status")
      .eq("quote_id", quote_id)
      .maybeSingle();
    if (!gj || gj.status !== "succeeded") return { skipped: "analysis-not-ready" };



const policy = await step.run("load-policy", () => {
  const partialPolicy = loadPolicy();
  return {
    currency: partialPolicy.currency || "CAD",
    pageWordDivisor: partialPolicy.pageWordDivisor || 250,
    roundingThreshold: partialPolicy.roundingThreshold || 0.5,
    baseRates: partialPolicy.baseRates || {},
    tiers: partialPolicy.tiers || {},
    languageTierMap: partialPolicy.languageTierMap || {},
    extraLanguagePct: partialPolicy.extraLanguagePct || 0,
    complexity: partialPolicy.complexity || {},
    certifications: partialPolicy.certifications || {},
    shipping: partialPolicy.shipping || {},
    ...partialPolicy,
  } as any;
});

// You may need to add 2 more properties based on your CompletePricingPolicy interface
// Look for other required properties in your type definition and add them here

});

});
    let words = 0;
    {
      const { data: qp } = await supabase
        .from("quote_pages")
        .select("word_count")
        .eq("quote_id", quote_id);
      words = (qp ?? []).reduce((a, b) => a + (b.word_count || 0), 0);
    }
    const pagesRaw = words / policy.pageWordDivisor;
    const pages = quarterPage(pagesRaw, policy.roundingThreshold);

    const baseRate = policy.baseRates[intended_use] ?? policy.baseRates.general;
    const detected: string[] = [];
    const langMult = pickTierMultiplier(policy, languages ?? [], detected);

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

    let labor = pages * baseRate * langMult * cxMult;
    const laborRounded = ceilTo5(labor);

    const certType = options?.certification ?? "Standard";
    const certFee = policy.certifications[certType] ?? 0;
    const shipKey = options?.shipping ?? "online";
    const shipFee = policy.shipping[shipKey];

    const { data: oneDoc } = await supabase
      .from("glm_pages")
      .select("doc_type")
      .eq("quote_id", quote_id)
      .limit(1)
      .maybeSingle();
      
    const { subtotal, applied } = rushMarkup({
      policy,
      tier: options?.rush ?? null,
      laborRounded,
      certFee,
      shipFee,
      docType: oneDoc?.doc_type ?? null,
      countryOfIssue: null,
    });

    const region = "AB";
    const inHST = (policy.tax.hst as any)[region];
    const inGSTOnly = (policy.tax.gstOnly as any)[region];
    const taxRate = inHST ?? inGSTOnly ?? policy.tax.defaultGST;

    const tax = Math.round(subtotal * taxRate * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;

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

    await inngest.send({ name: "quote/ready", data: { quote_id } });

    return { ok: true, quote_id, pages, baseRate, appliedRush: applied ?? null, total };
  }
);

export const quoteCreatedPrepareJobs = inngest.createFunction(
    { id: "quote-created-prepare-jobs" },
    { event: "quote/created" },
    async () => {
      return { ok: true };
    }
);

export const functions = [ocrDocument, geminiAnalyze, computePricing, quoteCreatedPrepareJobs];
