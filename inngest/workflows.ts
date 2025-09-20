import { loadPolicy, ensurePolicy, PricingPolicy } from "../lib/policy";
// inngest/workflows.ts
// Phase-2: OCR → Gemini (analysis+billing) → Pricing
// - Document AI wired with GCS download and Processor call
// - Gemini wired (text-only) to return complexity, names, doc_type, country_of_issue, billing.billable_words
// - No retries on Gemini; on failure, set quotes.status='hitl' and emit manual-review event

import { inngest } from "../lib/inngest/client";
import { sbAdmin } from "../lib/db/server";
import { quarterPage, ceilTo5, pickTierMultiplier, rushMarkup } from "../lib/calc";
// External SDKs (install once: npm i @google-cloud/storage @google-cloud/documentai @google/generative-ai)
import { Storage } from "@google-cloud/storage";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { GoogleGenerativeAI } from "@google/generative-ai";
// ---------- Event data types (aligned to your tables) ----------
type FilesUploaded = {
  name: "files/uploaded";
  data: {
    quote_id: number;            // quotes.quoteid
    file_id: string;             // quote_files.id (uuid)
    gcs_uri: string;             // gs://BUCKET/path/file.pdf
    filename: string;
    bytes: number;
    mime: string;
  };
};
type OcrComplete = {
  name: "files/ocr-complete";
    quote_id: number;
    file_id: string;             // uuid
    page_count: number;
    avg_confidence: number;
    languages: Record<string, number>;
type AnalysisComplete = {
  name: "files/analysis-complete";
    doc_type: string | null;
    country_of_issue: string | null;   // ISO-3166 alpha-2 if confident, else null
    complexity: "Easy" | "Medium" | "Hard";
    names: string[];
    billing: {
      billable_words: number | null;   // preferred unit (words across relevant content)
      relevant_pages?: number[];
      exclusions?: { page: number; reason: "blank" | "duplicate" | "irrelevant" }[];
      per_page?: Array<{ index: number; words: number; complexity: "Easy" | "Medium" | "Hard" }>;
    };
type QuoteSubmitted = {
  name: "quote/submitted";
    intended_use: "general" | "legal" | "immigration" | "academic" | "insurance";
    languages: string[]; // declared
    billing: { country: string; region?: string; currency: "CAD" | "USD" };
    options?: {
      rush?: "rush_1bd" | "same_day" | null;
      certification?: string;
      shipping?: "online" | "canadapost" | "pickup_calg" | "express_post";
// ---------- Helpers (Doc AI + Gemini) ----------
/**
 * Download the original file from GCS and run Document AI Processor.
 * Returns page array with wordCount, confidence, and a short text snippet per page.
 */
async function callDocAI({ gcsUri }: { gcsUri: string }) {
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credsJson) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON missing");
  const credentials = JSON.parse(credsJson);
  const projectId = process.env.GCP_PROJECT_ID!;
  const location = process.env.DOC_AI_LOCATION!;
  const processorId = process.env.DOC_AI_PROCESSOR_ID!;
  if (!projectId || !location || !processorId) {
    throw new Error("GCP_PROJECT_ID / DOC_AI_LOCATION / DOC_AI_PROCESSOR_ID missing");
  }
  // Parse gs://bucket/path/to/object
  const parts = gcsUri.replace("gs://", "").split("/");
  const bucket = parts.shift()!;
  const objectKey = parts.join("/");
  const storage = new Storage({ credentials, projectId });
  const [fileBuffer] = await storage.bucket(bucket).file(objectKey).download();
  const client = new DocumentProcessorServiceClient({ credentials, projectId });
  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  const [result] = await client.processDocument({
    name,
    rawDocument: { content: fileBuffer.toString("base64"), mimeType: "application/pdf" },
  });
  const doc = result.document!;
  const fullText = doc.text || "";
  const pages =
    (doc.pages || []).map((p, idx) => {
      // token count ~ word proxy (good enough for pricing divisor)
      const tokens = (p.tokens || []).length;
      const confidence = p.layout?.confidence ?? 0;
      // build a small page excerpt (<=1500 chars)
      let snippet = "";
      if (p.paragraphs?.length) {
        for (const para of p.paragraphs) {
          const segs = para.layout?.textAnchor?.textSegments || [];
          for (const seg of segs) {
            const s = Number(seg.startIndex || 0);
            const e = Number(seg.endIndex || 0);
            snippet += fullText.slice(s, e);
            if (snippet.length > 1500) break;
          }
          if (snippet.length > 1500) break;
        }
      }
      return {
        index: p.pageNumber ?? idx + 1,
        wordCount: tokens,
        confidence,
        snippet,
      };
    }) || [];
  return { pages };
}
 * Build a compact page prompt block from OCR result.
 * We use a short excerpt (from quote_pages.text_chars) and the page word_count.
function pagePackToPrompt(p: { page_number: number; word_count: number; text_chars?: string | null }) {
  const excerpt = (p.text_chars || "").replace(/\s+/g, " ").slice(0, 900);
  return `Page ${p.page_number} — words: ${p.word_count}\nExcerpt: """${excerpt}"""`;
 * Call Gemini (text-only) to classify complexity, extract names, doc_type, country_of_issue,
 * and return billing.billable_words (sum of relevant pages).
async function callGeminiAnalyze({
  pages,
}: {
  pages: Array<{ file_token: string; page_number: number; word_count: number; ocr_confidence: number; text_chars?: string | null }>;
}) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY missing for Gemini");
  const genAI = new GoogleGenerativeAI(apiKey);
  // You can swap to "gemini-1.5-flash" if you want lower cost/latency
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  const instructions = `
You are analyzing OCR'd documents for a translation quoting system.
Return STRICT JSON with this exact shape:
{
  "complexity": "Easy" | "Medium" | "Hard",
  "names": string[],
  "doc_type": string | null,
  "country_of_issue": string | null,   // ISO-3166 alpha-2 if confident, else null
  "billing": {
    "billable_words": number,          // words counted only on relevant pages
    "relevant_pages": number[],
    "exclusions": [{"page": number, "reason": "blank"|"duplicate"|"irrelevant"}]
  },
  "perPage": [{"index": number, "words": number, "complexity": "Easy"|"Medium"|"Hard"}]
Rules:
- Consider a page "blank" if very few words or boilerplate only.
- Consider "duplicate" if the excerpt is substantially the same as an earlier page.
- "Irrelevant" if unrelated to the document's main purpose (ads, filler).
- If doc type or country are not obvious, set them to null (do not guess).
- Complexity reflects human translation effort (handwriting, tables/forms, mixed languages make it harder).
- Sum billable_words only from pages you mark relevant.
Return JSON only, no markdown or commentary.
  `.trim();
  const pageBlocks = pages.map(pagePackToPrompt).join("\n\n");
  const prompt = `${instructions}\n\nPages:\n${pageBlocks}\n\nReturn JSON only.`;
  const resp = await model.generateContent(prompt);
  const raw = resp.response.text().trim();
  const jsonText = raw.replace(/^```json\s*|\s*```$/g, "");
  const parsed = JSON.parse(jsonText);
  // Minimal shape normalization
  return {
    complexity: parsed.complexity ?? "Easy",
    names: Array.isArray(parsed.names) ? parsed.names : [],
    doc_type: parsed.doc_type ?? null,
    country_of_issue: parsed.country_of_issue ?? null,
      billable_words: Number(parsed.billing?.billable_words ?? 0),
      relevant_pages: parsed.billing?.relevant_pages ?? [],
      exclusions: parsed.billing?.exclusions ?? [],
    },
    perPage: Array.isArray(parsed.perPage) ? parsed.perPage : [],
// ---------- 2.1 OCR: files/uploaded → quote_pages (+ocr_jobs) → files/ocr-complete ----------
export const ocrDocument = inngest.createFunction(
  { id: "ocr-document", retries: 2 },
  { event: "files/uploaded" },
  async ({ event, step }) => {
    const { quote_id, file_id, gcs_uri } = (event as any).data as FilesUploaded["data"];
    const supabase = sbAdmin();
    // Record OCR job start
    await supabase.from("ocr_jobs").insert({
      id: crypto.randomUUID(),
      quote_id,
      file_id,
      operation_name: "docai_process",
      status: "started",
      retries: 0,
    });
    // Call Document AI
    const { pages } = await step.run("docai", () => callDocAI({ gcsUri: gcs_uri }));
    // Persist per-page stats/snippets into quote_pages
    for (const p of pages) {
      await supabase.from("quote_pages").insert({
        id: crypto.randomUUID(),
        quote_id,
        file_token: file_id,
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
        text_chars: p.snippet || null,
        status: "ocr_complete",
        processed_at: new Date().toISOString(),
      });
    }
    // Mark file OCR complete
    await supabase.from("quote_files").update({ status: "ocr_complete" }).eq("id", file_id);
    const avg =
      pages.length > 0 ? pages.reduce((a, b) => a + b.confidence, 0) / pages.length : 0;
    // Emit downstream
    await inngest.send<OcrComplete>({
      name: "files/ocr-complete",
      data: {
        file_id,
        avg_confidence: avg,
        languages: {}, // optional: derive a language mix here if you want
      },
    return { ok: true, file_id, pages: pages.length };
);
// ---------- 2.3 Analysis: files/ocr-complete → glm_jobs + glm_pages → files/analysis-complete ----------
// IMPORTANT: retries: 0 (if it fails, we go to HITL; no auto-retries)
export const geminiAnalyze = inngest.createFunction(
  { id: "gemini-analyze", retries: 0 },
  { event: "files/ocr-complete" },
    const { quote_id } = (event as any).data as OcrComplete["data"];
    try {
      // Ensure glm_jobs row
      await supabase
        .from("glm_jobs")
        .upsert({ quote_id, status: "started", retries: 0 }, { onConflict: "quote_id" });
      // Load OCR page snippets (text_chars) + stats
      const { data: qp, error } = await supabase
        .from("quote_pages")
        .select("file_token, page_number, word_count, ocr_confidence, text_chars")
        .eq("quote_id", quote_id)
        .order("file_token", { ascending: true })
        .order("page_number", { ascending: true });
      if (error) throw error;
      const result = await step.run("gemini", () =>
        callGeminiAnalyze({ pages: qp ?? [] })
      );
      // Persist per-page LLM outputs into glm_pages (optional but useful)
      const per = result.perPage || [];
      for (const r of per) {
        await supabase.from("glm_pages").upsert(
          {
            id: crypto.randomUUID(),
            quote_id,
            file_id: qp?.[0]?.file_token ?? null, // if you want to keep track per-file; else null
            page_index: r.index,
doc_type: (r as any)?.docType ?? result.doc_type ?? null,

            complexity: r.complexity,
            language_primary: null,
            language_primary_pct: null,
            language_secondary: null,
            language_secondary_pct: null,
            page_confidence: null,
          },
          { onConflict: "quote_id,page_index" as any }
        );
      await supabase.from("glm_jobs").update({ status: "succeeded" }).eq("quote_id", quote_id);
      // Emit analysis-complete with billing summary
      await inngest.send<AnalysisComplete>({
        name: "files/analysis-complete",
        data: {
          quote_id,
          doc_type: result.doc_type ?? null,
          country_of_issue: result.country_of_issue ?? null,
          complexity: result.complexity,
          names: result.names ?? [],
          billing: {
            billable_words: result.billing.billable_words ?? 0,
            relevant_pages: result.billing.relevant_pages ?? [],
            exclusions: result.billing.exclusions ?? [],
            per_page: per.map((p) => ({
              index: p.index,
              words: p.words,
              complexity: p.complexity,
            })),
        },
      return { ok: true, quote_id };
    } catch (err: any) {
      // Mark failure & route to HITL
        .update({ status: "failed", last_error: String(err?.message || err) })
        .eq("quote_id", quote_id);
      await supabase.from("quotes").update({ status: "hitl" }).eq("quoteid", quote_id);
      await inngest.send({ name: "quote/manual-review-required", data: { quote_id, reason: "analysis_failed" } });
      return { ok: false, hitl: true };
// ---------- 2.4 Pricing: quote/submitted → compute only after analysis OK (and not HITL) ----------
export const computePricing = inngest.createFunction(
  { id: "compute-pricing" },
  { event: "quote/submitted" },
    const { quote_id, intended_use, languages, options } = (event as any).data as QuoteSubmitted["data"];
    // If in HITL, do not price yet
    const { data: qrec } = await supabase
      .from("quotes")
      .select("status")
      .eq("quoteid", quote_id)
      .maybeSingle();
    if (qrec?.status === "hitl") return { skipped: "hitl" };
    // Require analysis success
    const { data: gj } = await supabase
      .from("glm_jobs")
      .eq("quote_id", quote_id)
    if (!gj || gj.status !== "succeeded") return { skipped: "analysis-not-ready" };
    // Policy (from AppSettings or ENV-backed defaults)
    const policy = await step.run("load-policy", () => loadPolicy()) as PricingPolicy;
  const fullPolicy: PricingPolicy = ensurePolicy(policy);
    // Billable words: if Gemini provided a number, use it; else fallback to sum of quote_pages.word_count
    let words = 0;
    {
      // If you decide to persist Gemini's billable_words to a table, read that here.
      const { data: qp } = await supabase
        .select("word_count")
      words = (qp ?? []).reduce((a, b) => a + (b.word_count || 0), 0);
    const pagesRaw = words / fullPolicy.pageWordDivisor;
    const pages = quarterPage(pagesRaw, fullPolicy.roundingThreshold);
    // Base rate & multipliers
    const baseRate = fullPolicy.baseRates[intended_use] ?? fullPolicy.baseRates.general;
    // Language tier: declared ∪ detected (detected via glm_pages.langs if you add them later)
    const detected: string[] = []; // extend later if you store detected languages
    // Before calling pickTierMultiplier, ensure policy is fully initialized
    const policy = await loadPolicy();
    if (!policy) {
      throw new Error("Failed to load pricing policy");
    const langMult = pickTierMultiplier(ensurePolicy(policy), languages ?? [], detected);
    // Complexity roll-up: pick the max severity seen in glm_pages (Hard > Medium > Easy)
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
    const cxMult = fullPolicy.complexity[cxMax as "Easy" | "Medium" | "Hard"];
    let labor = pages * baseRate * langMult * cxMult;
    // GLM overrides slot (e.g., fixed labor for specific doc_type+country). Skip for now or implement here.
    const laborRounded = ceilTo5(labor);
    // Certification (flat) and Shipping
    const certType = options?.certification ?? "Standard";
    const certFee = fullPolicy.certifications[certType] ?? 0;
    const shipKey = options?.shipping ?? "online";
    const shipFee = fullPolicy.shipping[shipKey];
    // Rush engine (percent over basis: "labor" or "subtotal"; "calculated" or "preset")
    const { data: oneDoc } = await supabase
      .select("doc_type")
      .limit(1)
    const { subtotal, applied } = rushMarkup({
      policy,
      tier: options?.rush ?? null,
      laborRounded,
      certFee,
      shipFee,
      docType: oneDoc?.doc_type ?? null,
      countryOfIssue: null, // supply when you persist it from analysis
    // Tax (simplified; replace with billing.region/country from Step-3)
    const region = "AB";
    const inHST = (fullPolicy.tax.hst as any)[region];
    const inGSTOnly = (fullPolicy.tax.gstOnly as any)[region];
    const taxRate = inHST ?? inGSTOnly ?? fullPolicy.tax.defaultGST;
    const tax = Math.round(subtotal * taxRate * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;
    // Persist to quotes
    await supabase
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
// (Optional placeholder you already had; kept intact)
export const quoteCreatedPrepareJobs = inngest.createFunction(
  { id: "quote-created-prepare-jobs" },
  { event: "quote/created" },
  async () => {
    return { ok: true };
export const functions = [ocrDocument, geminiAnalyze, computePricing, quoteCreatedPrepareJobs];
