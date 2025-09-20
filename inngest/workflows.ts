// inngest/workflows.ts
import { inngest } from "../lib/inngest/client";
import { sbAdmin } from "../lib/db/server";
import { loadPolicy, PricingPolicy } from "../lib/policy";
import { quarterPage, ceilTo5, pickTierMultiplier, rushMarkup } from "../lib/calc";

// ... (rest of the file remains the same until the computePricing function)
// ... (I've omitted the unchanged parts for brevity)

// ---------- 2.4 Pricing: quote/submitted → compute only after analysis OK (and not HITL) ----------
export const computePricing = inngest.createFunction(
  { id: "compute-pricing" },
  { event: "quote/submitted" },
  async ({ event, step }) => {
    const { quote_id, intended_use, languages, options } = (event as any).data as QuoteSubmitted["data"];
    const supabase = sbAdmin();

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
      .select("status")
      .eq("quote_id", quote_id)
      .maybeSingle();
    if (!gj || gj.status !== "succeeded") return { skipped: "analysis-not-ready" };

    // Policy (from AppSettings or ENV-backed defaults)
    const policy = await step.run("load-policy", () => loadPolicy());

    // **THIS IS THE FIX**: Ensure currency has a default value.
    policy.currency = policy.currency || "CAD";

    // Billable words: if Gemini provided a number, use it; else fallback to sum of quote_pages.word_count
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

    // ... (the rest of the function continues as before)

    const baseRate = policy.baseRates[intended_use] ?? policy.baseRates.general;
    const detected: string[] = [];
    const langMult = pickTierMultiplier(policy as PricingPolicy, languages ?? [], detected); // Added assertion here for safety

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
      policy: policy as PricingPolicy, // Added assertion here for safety
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
// ... (rest of the file)
