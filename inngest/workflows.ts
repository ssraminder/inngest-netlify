// inngest/workflows.ts
import { inngest } from "../lib/inngest/client";
import { sbAdmin } from "../lib/db/server";
import { loadPolicy } from "../lib/policy";
import { quarterPage, ceilTo5, pickTierMultiplier, rushMarkup } from "../lib/calc";

// ---------- types (aligned to your tables) ----------
type FilesUploaded = {
  name: "files/uploaded";
  data: { quote_id:number; file_id:string; gcs_uri:string; filename:string; bytes:number; mime:string; };
};
type OcrComplete = {
  name: "files/ocr-complete";
  data: { quote_id:number; file_id:string; page_count:number; avg_confidence:number; languages:Record<string,number>; };
};
type AnalysisComplete = {
  name: "files/analysis-complete";
  data: {
    quote_id:number;
    doc_type:string|null;
    country_of_issue:string|null;
    complexity:"Easy"|"Medium"|"Hard";
    names:string[];
    billing:{ billable_words:number|null; relevant_pages?:number[]; exclusions?:{page:number;reason:string}[]; per_page?:Array<{index:number;words:number;complexity:"Easy"|"Medium"|"Hard"}>; };
  };
};
type QuoteSubmitted = {
  name: "quote/submitted";
  data: {
    quote_id:number;
    intended_use:"general"|"legal"|"immigration"|"academic"|"insurance";
    languages:string[];
    billing:{ country:string; region?:string; currency:"CAD"|"USD" };
    options?:{ rush?: "rush_1bd"|"same_day"|null; certification?: string; shipping?: "online"|"canadapost"|"pickup_calg"|"express_post" };
  };
};

// ---------- helpers ----------
async function callDocAI({ gcsUri }: { gcsUri: string }) {
  // TODO: integrate @google-cloud/documentai here using:
  //   process.env.GCP_PROJECT_ID, process.env.DOC_AI_LOCATION, process.env.DOC_AI_PROCESSOR_ID, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  // Return shape:
  return { pages: [] as Array<{ index:number; wordCount:number; confidence:number }> };
}

async function getPageSnippets(supabase: ReturnType<typeof sbAdmin>, quote_id:number) {
  // You may add a materialized view later; for now this just reads quote_pages text-lite stats.
  const { data, error } = await supabase
    .from("quote_pages")
    .select("file_token, page_number, word_count, ocr_confidence")
    .eq("quote_id", quote_id)
    .order("file_token", { ascending: true })
    .order("page_number", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function callGeminiAnalyze(_: {
  // we keep signature minimal to avoid vendor code here; implement with your SDK of choice
  pages: Array<{ file_token:string; page_number:number; word_count:number; ocr_confidence:number }>
}) {
  // TODO: call your LLM here with OCR text + stats, not binary files.
  // MUST return:
  return {
    doc_type: null as string|null,
    country_of_issue: null as string|null,
    complexity: "Easy" as "Easy"|"Medium"|"Hard",
    names: [] as string[],
    billing: { billable_words: null as number|null, relevant_pages: [] as number[], exclusions: [] as Array<{page:number;reason:string}> },
    perPage: [] as Array<{ fileId:string; index:number; words:number; complexity:"Easy"|"Medium"|"Hard"; lang1?:string; lang1Pct?:number; lang2?:string; lang2Pct?:number; pageConfidence?:number }>,
  };
}

// ---------- 2.1 OCR: files/uploaded → ocr_jobs + quote_pages → files/ocr-complete ----------
export const ocrDocument = inngest.createFunction(
  { id: "ocr-document", retries: 2 },
  { event: "files/uploaded" },
  async ({ event, step }) => {
    const { quote_id, file_id, gcs_uri } = (event as any).data as FilesUploaded["data"];
    const supabase = sbAdmin();

    // record job
    await supabase.from("ocr_jobs").insert({
      id: crypto.randomUUID(),
      quote_id, file_id,
      operation_name: "docai_process",
      status: "started", retries: 0
    });

    // call Doc AI
    const { pages } = await step.run("docai", () => callDocAI({ gcsUri: gcs_uri }));

    // persist per-page (word_count, confidence) into quote_pages
    for (const p of pages) {
      await supabase.from("quote_pages").insert({
        id: crypto.randomUUID(),
        quote_id,
        file_token: file_id,       // matches your schema name
        file_name: null,
        storage_url: gcs_uri,
        file_ext: null,
        file_bytes: null,
        route: "docai",
        page_number: p.index,
        page_count: pages.length,
        method: "ocr",
        word_count: p.wordCount,
        language: null,
        ocr_confidence: p.confidence,
        text_chars: null,
        status: "ocr_complete",
        processed_at: new Date().toISOString()
      });
    }

    // mark file as OCR complete
    await supabase.from("quote_files").update({ status: "ocr_complete" }).eq("id", file_id);

    const avg = pages.length ? pages.reduce((a, b) => a + b.confidence, 0) / pages.length : 0;

    // emit downstream
    await inngest.send< OcrComplete >({
      name: "files/ocr-complete",
      data: { quote_id, file_id, page_count: pages.length, avg_confidence: avg, languages: {} }
    });

    return { ok: true, file_id, pages: pages.length };
  }
);

// ---------- 2.3 Analysis: files/ocr-complete → glm_jobs + glm_pages → files/analysis-complete ----------
export const geminiAnalyze = inngest.createFunction(
  { id: "gemini-analyze", retries: 0 },  // IMPORTANT: no retries; failure => HITL
  { event: "files/ocr-complete" },
  async ({ event, step }) => {
    const { quote_id } = (event as any).data as OcrComplete["data"];
    const supabase = sbAdmin();

    try {
      await supabase.from("glm_jobs").upsert({ quote_id, status: "started", retries: 0 });

      const pages = await step.run("load-ocr-pages", () => getPageSnippets(supabase, quote_id));
      const result = await step.run("gemini", () => callGeminiAnalyze({ pages }));

      // write glm_pages (per-page)
      for (const r of result.perPage || []) {
        await supabase.from("glm_pages").upsert({
          id: crypto.randomUUID(),
          quote_id,
          file_id: r.fileId,
          page_index: r.index,
          doc_type: r.docType ?? result.doc_type ?? null,
          complexity: r.complexity,
          language_primary: r.lang1 ?? null,
          language_primary_pct: r.lang1Pct ?? null,
          language_secondary: r.lang2 ?? null,
          language_secondary_pct: r.lang2Pct ?? null,
          page_confidence: r.pageConfidence ?? null
        });
      }

      await supabase.from("glm_jobs").update({ status: "succeeded" }).eq("quote_id", quote_id);

      // emit analysis-complete with billing summary
      await inngest.send< AnalysisComplete >({
        name: "files/analysis-complete",
        data: {
          quote_id,
          doc_type: result.doc_type ?? null,
          country_of_issue: result.country_of_issue ?? null,
          complexity: result.complexity,
          names: result.names ?? [],
          billing: {
            billable_words: result.billing.billable_words ?? null,
            relevant_pages: result.billing.relevant_pages ?? [],
            exclusions: result.billing.exclusions ?? []
          }
        }
      });

      return { ok: true, quote_id };
    } catch (err: any) {
      await supabase.from("glm_jobs").update({ status: "failed", last_error: String(err?.message || err) }).eq("quote_id", quote_id);
      await supabase.from("quotes").update({ status: "hitl" }).eq("quoteid", quote_id);

      await inngest.send({ name: "quote/manual-review-required", data: { quote_id, reason: "analysis_failed" } });
      return { ok: false, hitl: true };
    }
  }
);

// ---------- 2.4 Pricing: quote/submitted → compute only after analysis ok (and not HITL) ----------
export const computePricing = inngest.createFunction(
  { id: "compute-pricing" },
  { event: "quote/submitted" },
  async ({ event, step }) => {
    const { quote_id, intended_use, languages, options } = (event as any).data as QuoteSubmitted["data"];
    const supabase = sbAdmin();

    // block if HITL
    const { data: qrec } = await supabase.from("quotes").select("status").eq("quoteid", quote_id).maybeSingle();
    if (qrec?.status === "hitl") return { skipped: "hitl" };

    // ensure analysis succeeded
    const { data: gj } = await supabase.from("glm_jobs").select("status").eq("quote_id", quote_id).maybeSingle();
    if (!gj || gj.status !== "succeeded") return { skipped: "analysis-not-ready" };

    const policy = await step.run("load-policy", () => loadPolicy());

    // billable words: sum quote_pages.word_count for relevant pages if you have them,
    // otherwise sum all glm_pages-joined pages and let LLM exclude via result.billing in future iterations.
    const { data: qp } = await supabase
      .from("quote_pages")
      .select("word_count")
      .eq("quote_id", quote_id);
    const words = (qp ?? []).reduce((a, b) => a + (b.word_count || 0), 0);
    const pagesRaw = words / policy.pageWordDivisor;
    const pages = quarterPage(pagesRaw, policy.roundingThreshold);

    // labor stack
    const baseRate = policy.baseRates[intended_use] ?? policy.baseRates.general;
    // detect languages from glm_pages primary/secondary for tier mixing
    const { data: gl } = await supabase.from("glm_pages").select("language_primary, language_secondary").eq("quote_id", quote_id);
    const detected = Array.from(new Set((gl ?? []).flatMap(r => [r.language_primary, r.language_secondary].filter(Boolean) as string[])));
    const langMult = pickTierMultiplier(policy, languages ?? [], detected);
    // complexity roll-up: take max severity across glm_pages
    const { data: cxRows } = await supabase.from("glm_pages").select("complexity").eq("quote_id", quote_id);
    const cxMax = (cxRows ?? []).some(r => r.complexity === "Hard") ? "Hard" :
                  (cxRows ?? []).some(r => r.complexity === "Medium") ? "Medium" : "Easy";
    const cxMult = policy.complexity[cxMax as "Easy"|"Medium"|"Hard"];

    let labor = pages * baseRate * langMult * cxMult;

    // GLM overrides: if you want to introduce preset flat labor by doc_type+country, do it here
    // labor = overrideOr(labor);

    const laborRounded = ceilTo5(labor);

    // fees
    const certType = options?.certification ?? "Standard";
    const certFee = policy.certifications[certType] ?? 0;
    const shipKey = options?.shipping ?? "online";
    const shipFee = policy.shipping[shipKey];

    // rush markup
    const docInfo = await supabase.from("glm_pages").select("doc_type").eq("quote_id", quote_id).limit(1).maybeSingle();
    const countryInfo = await supabase.from("glm_pages").select("language_primary").eq("quote_id", quote_id).limit(1).maybeSingle();
    const { subtotal, applied } = rushMarkup({
      policy,
      tier: options?.rush ?? null,
      laborRounded,
      certFee,
      shipFee,
      docType: docInfo.data?.doc_type ?? null,
      countryOfIssue: null // supply if you map it from analysis
    });

    // tax (very simplified mapping; enrich from billing address on Step-3)
    const region = "AB"; // TODO: get from billing.address.region
    const inHST = (policy.tax.hst as any)[region];
    const inGSTOnly = (policy.tax.gstOnly as any)[region];
    const taxRate = inHST ?? inGSTOnly ?? policy.tax.defaultGST;

    const tax = Math.round(subtotal * taxRate * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;

    await supabase.from("quotes").update({
      totalbillablepages: pages,
      perpagerate: baseRate,
      certtype: certType,
      certprice: certFee,
      quotetotal: total,
      status: "ready"
    }).eq("quoteid", quote_id);

    await inngest.send({ name: "quote/ready", data: { quote_id } });

    return { ok: true, quote_id, pages, baseRate, appliedRush: applied ?? null, total };
  }
);

// Keep your existing function if you like
export const quoteCreatedPrepareJobs = inngest.createFunction(
  { id: "quote-created-prepare-jobs" },
  { event: "quote/created" },
  async ({ event }) => {
    // if you’re using it in other flows, leave it intact
    return { ok: true };
  }
);

export const functions = [ocrDocument, geminiAnalyze, computePricing, quoteCreatedPrepareJobs];
