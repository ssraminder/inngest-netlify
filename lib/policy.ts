// lib/policy.ts
import { sbAdmin } from "./db/server";

export type RushBasis = "calculated" | "preset";
export type RushApplyTo = "labor" | "subtotal";

export type PricingPolicy = {
  currency: "CAD" | "USD";
  pageWordDivisor: number;        // default 225
  roundingThreshold: number;      // default 0.20  (<= 0.20 → nearest 0.25, else ceil to 0.25)
  baseRates: Record<string, number>; // intended_use → rate per page
  tiers: Record<string, number>;  // A/B/C/D/default → multiplier
  languageTierMap: Record<string, "A"|"B"|"C"|"D"|"default">; // languagename → tier
  extraLanguagePct: number;       // 0.05 (i.e., +5% per extra)
  complexity: { Easy:number; Medium:number; Hard:number }; // 1.00/1.15/1.30
  certifications: Record<string, number>; // Standard/PPTC/Notarization/custom...
  shipping: { online:number; canadapost:number; pickup_calg:number; express_post:number };
  tax: {
    hst: Record<"NB"|"NL"|"NS"|"ON"|"PE", number>;
    gstOnly: Record<"AB"|"NT"|"NU"|"YT", number>;
    defaultGST: number;
  };
  rush: {
    rush_1bd: { enabled:boolean; percent:number; basis:RushBasis; apply_to:RushApplyTo };
    same_day: {
      enabled:boolean; percent:number; basis:RushBasis; apply_to:RushApplyTo;
      cutoff_local_time:string; timezone:string; max_pages:number;
      eligibility: Array<{ doc_type:string; country_of_issue:string; preset_base?:number }>;
    };
  };
};

const DEFAULTS: PricingPolicy = {
  currency: "CAD",
  pageWordDivisor: Number(process.env.PAGE_WORD_DIVISOR || 225),
  roundingThreshold: Number(process.env.ROUNDING_THRESHOLD || 0.20),
  baseRates: {
    general: Number(process.env.BASE_RATE_CAD || 65),
    legal: 80, immigration: 75, academic: 70, insurance: 70
  },
  tiers: { A: 1.20, B: 1.35, C: 1.10, D: 1.05, default: 1.00 },
  languageTierMap: {
    Punjabi:"A", Hindi:"A", Marathi:"A",
    Arabic:"B", Chinese:"B", Thai:"B",
    French:"C", German:"C", Italian:"C", Greek:"C",
    Norwegian:"D", Swedish:"D", Finnish:"D", Dutch:"D",
    English:"default"
  },
  extraLanguagePct: 0.05,
  complexity: { Easy:1.00, Medium:1.15, Hard:1.30 },
  certifications: { Standard:0, "PPTC Document":35, Notarization:50 },
  shipping: { online:0, canadapost:5, pickup_calg:0, express_post:25 },
  tax: {
    hst: { NB:0.15, NL:0.15, NS:0.14, ON:0.13, PE:0.15 },
    gstOnly: { AB:0.05, NT:0.05, NU:0.05, YT:0.05 },
    defaultGST: 0.05
  },
  rush: {
    rush_1bd: { enabled:true, percent:0.30, basis:"calculated", apply_to:"subtotal" },
    same_day: {
      enabled:true, percent:0.50, basis:"preset", apply_to:"subtotal",
      cutoff_local_time:"13:00", timezone:"America/Edmonton", max_pages:1,
      eligibility: [
        { doc_type:"Driver License", country_of_issue:"IN", preset_base:65 },
        { doc_type:"Driver License", country_of_issue:"CL", preset_base:65 },
        { doc_type:"Driver License", country_of_issue:"FR", preset_base:65 }
      ]
    }
  }
};

export async function loadPolicy(): Promise<PricingPolicy> {
  // Preferred: AppSettings with key 'pricing_policy_v1'
  const supabase = sbAdmin();
  const { data, error } = await supabase
    .from("AppSettings")
    .select("settings")
    .eq("key", "pricing_policy_v1")
    .maybeSingle();

  if (!error && data?.settings) {
    // By merging DEFAULTS with the database settings and asserting the type,
    // we are guaranteeing to the TypeScript compiler that the resulting object
    // will match the PricingPolicy type, resolving the error.
    return { ...DEFAULTS, ...(data.settings as Partial<PricingPolicy>) } as PricingPolicy;
  }

  return DEFAULTS;
}
